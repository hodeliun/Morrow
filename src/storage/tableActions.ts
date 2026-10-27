import { childrenOf } from '../core/tree';
import type { Command } from '../core/commands';
import type { ActionRecordChange, TableActionPlan } from '../core/tableActions';
import type { PageId, PageMeta, PropValue, WorkspaceState } from '../core/model';
import { normalizePage } from '../core/migrations';
import { relationIds } from '../core/relations';
import { errorMessage } from '../core/result';
import type { WorkspaceSession } from './session';

export const TABLE_ACTION_JOURNAL_META = 'table-action-journal.json';
const JOURNAL_FORMAT = 'morrow-table-action-journal';
const MAX_JOURNAL_TEXT = 2_000_000;

export type TableActionJournalStatus =
  'prepared' | 'complete' | 'undoing' | 'undone' | 'aborted' | 'conflict';

export interface TableActionJournal {
  format: typeof JOURNAL_FORMAT;
  version: 1;
  id: string;
  status: TableActionJournalStatus;
  databaseId: PageId;
  rowId: PageId;
  propertyId: string;
  label: string;
  createdAt: number;
  records: ActionRecordChange[];
  commands: Command[];
  undoCommands?: Command[];
  conflicts: PageId[];
  error?: string;
}

export type TableActionRunResult =
  | { status: 'saved'; message: string; journal: TableActionJournal }
  | { status: 'pending'; message: string; journal: TableActionJournal }
  | { status: 'stale' | 'busy' | 'failed'; message: string; journal?: TableActionJournal };

export type TableActionRecoveryResult =
  | { status: 'none' }
  | { status: 'complete' | 'aborted' | 'undone'; journal: TableActionJournal; message: string }
  | { status: 'pending' | 'conflict' | 'failed'; journal: TableActionJournal; message: string };

const activeJournalLocks = new Set<string | WorkspaceSession>();

export async function readTableActionJournal(session: WorkspaceSession): Promise<TableActionJournal | null> {
  const text = await session.readMeta(TABLE_ACTION_JOURNAL_META);
  return text ? parseJournalText(text) : null;
}

export async function executeTableAction(
  session: WorkspaceSession,
  plan: TableActionPlan,
  now = Date.now(),
): Promise<TableActionRunResult> {
  const lock = journalLockKey(session);
  if (activeJournalLocks.has(lock)) return { status: 'busy', message: 'A table action is already running.' };
  activeJournalLocks.add(lock);
  try {
    if (!(await session.flush()))
      return {
        status: 'failed',
        message: 'Earlier changes are still unsaved. Try the action again after saving.',
      };
    const previousText = await session.readMeta(TABLE_ACTION_JOURNAL_META);
    if (previousText) {
      const previous = parseJournalText(previousText);
      if (!previous)
        return {
          status: 'failed',
          message: 'The existing action recovery journal is unreadable and was preserved.',
        };
      if (previous.status === 'prepared' || previous.status === 'undoing' || previous.status === 'conflict') {
        const recovered = await recoverTableActionUnlocked(session);
        if (!['complete', 'aborted', 'undone'].includes(recovered.status))
          return {
            status: 'failed',
            message: 'Resolve the previous action recovery before running another action.',
            journal: 'journal' in recovered ? recovered.journal : previous,
          };
      }
    }
    if (session.getState() !== plan.baseState)
      return { status: 'stale', message: 'The table changed after the preview. Review the updated preview.' };
    const journal: TableActionJournal = {
      format: JOURNAL_FORMAT,
      version: 1,
      id: crypto.randomUUID(),
      status: 'prepared',
      databaseId: plan.databaseId,
      rowId: plan.rowId,
      propertyId: plan.propertyId,
      label: plan.label,
      createdAt: now,
      records: plan.records,
      commands: plan.commands,
      conflicts: [],
    };
    try {
      await saveJournal(session, journal);
    } catch (error) {
      return { status: 'failed', message: `The recovery journal could not be saved: ${errorMessage(error)}` };
    }
    if (session.getState() !== plan.baseState) {
      journal.status = 'aborted';
      journal.error = 'The workspace changed before the action started.';
      await trySaveJournal(session, journal);
      return {
        status: 'stale',
        message: 'The workspace changed after the preview. Review the updated preview.',
        journal,
      };
    }
    const applied = session.executeAll(plan.commands);
    if (!applied.ok) {
      journal.status = 'aborted';
      journal.error = applied.error;
      await trySaveJournal(session, journal);
      return { status: 'failed', message: applied.error, journal };
    }
    if (!(await session.flush()))
      return {
        status: 'pending',
        message: 'Some changes were not saved. The action is recorded for recovery.',
        journal,
      };
    journal.status = 'complete';
    try {
      await saveJournal(session, journal);
      return { status: 'saved', message: 'Action saved.', journal };
    } catch (error) {
      return {
        status: 'pending',
        message: `The rows were saved, but the journal could not be updated: ${errorMessage(error)}`,
        journal,
      };
    }
  } finally {
    activeJournalLocks.delete(lock);
  }
}

export async function recoverTableAction(session: WorkspaceSession): Promise<TableActionRecoveryResult> {
  const lock = journalLockKey(session);
  if (activeJournalLocks.has(lock)) {
    const journal = await readTableActionJournal(session);
    return journal
      ? { status: 'pending', journal, message: 'Another table action is still saving.' }
      : { status: 'none' };
  }
  activeJournalLocks.add(lock);
  try {
    return await recoverTableActionUnlocked(session);
  } finally {
    activeJournalLocks.delete(lock);
  }
}

async function recoverTableActionUnlocked(session: WorkspaceSession): Promise<TableActionRecoveryResult> {
  const journal = await readTableActionJournal(session);
  if (!journal) return { status: 'none' };
  if (journal.status === 'complete')
    return { status: 'complete', journal, message: 'Action saved and ready to undo.' };
  if (journal.status === 'undone')
    return { status: 'undone', journal, message: conflictMessage(journal.conflicts) };
  if (journal.status === 'aborted')
    return { status: 'aborted', journal, message: journal.error ?? 'No action changes were written.' };
  if (journal.status === 'undoing') return resumeUndo(session, journal);

  const current = session.getState();
  const classification = classifyRecords(current, journal.records);
  if (classification.conflicts.length) {
    journal.status = 'conflict';
    journal.conflicts = classification.conflicts;
    journal.error = 'Some records changed after the partial save. They were preserved.';
    await trySaveJournal(session, journal);
    return { status: 'conflict', journal, message: conflictMessage(journal.conflicts) };
  }
  if (classification.after === journal.records.length) {
    if (!(await session.flush()))
      return {
        status: 'pending',
        journal,
        message: 'The action is complete in memory, but some files are still unsaved.',
      };
    journal.status = 'complete';
    await saveJournal(session, journal);
    return { status: 'complete', journal, message: 'The action was already saved.' };
  }
  if (classification.before === journal.records.length) {
    journal.status = 'aborted';
    journal.error = 'The action journal was written, but no action records reached disk.';
    await saveJournal(session, journal);
    return { status: 'aborted', journal, message: 'No action changes were written.' };
  }
  const beforeIds = new Set(classification.beforeIds);
  const commands = journal.commands.filter((command) => beforeIds.has(commandPageId(command)));
  const applied = session.executeAll(commands);
  if (!applied.ok) {
    journal.error = applied.error;
    await trySaveJournal(session, journal);
    return { status: 'failed', journal, message: applied.error };
  }
  if (!(await session.flush()))
    return { status: 'pending', journal, message: 'Recovery is waiting for the remaining files to save.' };
  journal.status = 'complete';
  journal.error = undefined;
  await saveJournal(session, journal);
  return { status: 'complete', journal, message: 'The action was recovered and saved.' };
}

export async function undoTableAction(session: WorkspaceSession): Promise<TableActionRecoveryResult> {
  const lock = journalLockKey(session);
  if (activeJournalLocks.has(lock)) {
    const journal = await readTableActionJournal(session);
    return journal
      ? { status: 'pending', journal, message: 'Another table action is still saving.' }
      : { status: 'none' };
  }
  activeJournalLocks.add(lock);
  try {
    return await undoTableActionUnlocked(session);
  } finally {
    activeJournalLocks.delete(lock);
  }
}

async function undoTableActionUnlocked(session: WorkspaceSession): Promise<TableActionRecoveryResult> {
  const journal = await readTableActionJournal(session);
  if (!journal || journal.status !== 'complete')
    return {
      status: 'failed',
      journal: journal ?? emptyJournal(),
      message: 'There is no saved action to undo.',
    };
  if (!(await session.flush()))
    return { status: 'failed', journal, message: 'Save the current changes before undoing this action.' };

  const current = session.getState();
  const classification = classifyRecords(current, journal.records);
  const conflicts = [...classification.conflicts];
  const safeIds = new Set(classification.afterIds);
  const undoCommands = buildUndoCommands(current, journal.records, safeIds, conflicts, Date.now());
  journal.status = 'undoing';
  journal.undoCommands = undoCommands;
  journal.conflicts = [...new Set(conflicts)];
  journal.error = undefined;
  try {
    await saveJournal(session, journal);
  } catch (error) {
    return {
      status: 'failed',
      journal,
      message: `The undo journal could not be saved: ${errorMessage(error)}`,
    };
  }
  return resumeUndo(session, journal);
}

function journalLockKey(session: WorkspaceSession): string | WorkspaceSession {
  return session.location ? `vault:${session.location.toLocaleLowerCase()}` : session;
}

async function resumeUndo(
  session: WorkspaceSession,
  journal: TableActionJournal,
): Promise<TableActionRecoveryResult> {
  const current = session.getState();
  const classification = classifyUndoRecords(current, journal.records);
  const conflicts = new Set([...journal.conflicts, ...classification.conflicts]);
  const afterIds = new Set(classification.afterIds);
  const commands = (journal.undoCommands ?? []).filter((command) => afterIds.has(commandPageId(command)));
  const relatedRows = relationConflictTargets(current, journal.records, conflicts);
  for (const id of relatedRows) conflicts.add(id);
  const safeCommands = commands.filter((command) => {
    if (command.type !== 'relation.set') return true;
    const valueIds =
      typeof command.value === 'string' ? [command.value] : Array.isArray(command.value) ? command.value : [];
    return !conflicts.has(command.id) && !valueIds.some((id) => conflicts.has(id));
  });
  const applied = session.executeAll(safeCommands);
  if (!applied.ok) {
    journal.error = applied.error;
    journal.conflicts = [...conflicts];
    await trySaveJournal(session, journal);
    return { status: 'failed', journal, message: applied.error };
  }
  if (!(await session.flush())) {
    journal.conflicts = [...conflicts];
    await trySaveJournal(session, journal);
    return { status: 'pending', journal, message: 'Undo is waiting for the remaining files to save.' };
  }
  const finalCheck = classifyUndoRecords(session.getState(), journal.records);
  journal.conflicts = [...new Set([...conflicts, ...finalCheck.conflicts])];
  journal.status = 'undone';
  journal.error = journal.conflicts.length ? 'Undo preserved records edited after the action.' : undefined;
  await saveJournal(session, journal);
  return { status: 'undone', journal, message: conflictMessage(journal.conflicts, 'Action undone.') };
}

function buildUndoCommands(
  state: WorkspaceState,
  records: ActionRecordChange[],
  safeIds: ReadonlySet<PageId>,
  conflicts: PageId[],
  now: number,
): Command[] {
  const commands: Command[] = [];
  const deleteCommands: Command[] = [];
  const conflictSet = new Set(conflicts);
  const blockedRelationProperties = new Map<PageId, Set<string>>();
  const sourceRelations = new Map<PageId, Array<{ propId: string; before: unknown; after: unknown }>>();
  for (const record of records) {
    if (!safeIds.has(record.id) || !record.before || !record.after) continue;
    const parent = record.before.parentId ? state.pages[record.before.parentId] : undefined;
    const relations =
      parent?.database?.properties.filter((prop) => prop.type === 'relation' && !prop.relation?.isInverse) ??
      [];
    for (const prop of relations) {
      const before = record.before.properties[prop.id] ?? null;
      const after = record.after.properties[prop.id] ?? null;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        const targets = relationIds(after);
        if (targets.some((id) => conflictSet.has(id))) {
          conflicts.push(record.id);
          const blocked = blockedRelationProperties.get(record.id) ?? new Set<string>();
          blocked.add(prop.id);
          blockedRelationProperties.set(record.id, blocked);
          continue;
        }
        sourceRelations.set(record.id, [
          ...(sourceRelations.get(record.id) ?? []),
          { propId: prop.id, before, after },
        ]);
      }
    }
  }
  for (const record of records) {
    if (!safeIds.has(record.id)) continue;
    if (!record.before) {
      if (
        record.after &&
        childrenOf(state.pages, record.id).length === 0 &&
        !hasExternalRelation(state, record.id, safeIds)
      ) {
        deleteCommands.push({ type: 'page.trash', id: record.id, now });
        deleteCommands.push({ type: 'page.deleteForever', id: record.id });
      } else conflicts.push(record.id);
      continue;
    }
    if (!record.after) continue;
    const page = record.after;
    const parent = page.parentId ? state.pages[page.parentId] : undefined;
    const props = parent?.database?.properties ?? [];
    const relations = new Map((sourceRelations.get(record.id) ?? []).map((item) => [item.propId, item]));
    const values: Record<string, PropValue> = {};
    const propertyIds = new Set([...Object.keys(record.before.properties), ...Object.keys(page.properties)]);
    for (const propertyId of propertyIds) {
      const before = record.before.properties[propertyId] ?? null;
      const after = page.properties[propertyId] ?? null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const prop = props.find((candidate) => candidate.id === propertyId);
      if (prop?.type === 'relation' && prop.relation?.isInverse) continue;
      if (blockedRelationProperties.get(record.id)?.has(propertyId)) continue;
      if (relations.has(propertyId)) {
        const relation = relations.get(propertyId)!;
        commands.push({
          type: 'relation.set',
          id: record.id,
          propertyId,
          value: relation.before as PageMeta['properties'][string],
          now,
        });
      } else values[propertyId] = before;
    }
    if (Object.keys(values).length) commands.push({ type: 'page.setProperties', id: record.id, values, now });
    const oldControls = new Map(record.before.controls.map((control) => [control.id, control]));
    for (const control of page.controls) {
      const old = oldControls.get(control.id);
      if (old && JSON.stringify(old.value) !== JSON.stringify(control.value))
        commands.push({
          type: 'page.control.setValue',
          id: record.id,
          controlId: control.id,
          value: old.value,
          now,
        });
    }
  }
  commands.push(...deleteCommands);
  return commands;
}

function hasExternalRelation(
  state: WorkspaceState,
  pageId: PageId,
  actionPageIds: ReadonlySet<PageId>,
): boolean {
  const targetDatabaseId = state.pages[pageId]?.parentId;
  if (!targetDatabaseId) return false;
  for (const page of Object.values(state.pages)) {
    if (actionPageIds.has(page.id) || !page.parentId) continue;
    const database = state.pages[page.parentId]?.database;
    if (!database) continue;
    for (const prop of database.properties) {
      if (prop.type !== 'relation' || prop.relation?.isInverse) continue;
      if (
        prop.relation?.targetDatabaseId === targetDatabaseId &&
        relationIds(page.properties[prop.id] ?? null).includes(pageId)
      )
        return true;
    }
  }
  return false;
}

function relationConflictTargets(
  state: WorkspaceState,
  records: ActionRecordChange[],
  conflicts: ReadonlySet<PageId>,
): Set<PageId> {
  const related = new Set<PageId>();
  for (const record of records) {
    if (!record.before || !record.after) continue;
    const page = state.pages[record.id] ?? record.after;
    const database = page.parentId ? state.pages[page.parentId]?.database : null;
    for (const prop of database?.properties ?? []) {
      if (prop.type !== 'relation' || prop.relation?.isInverse) continue;
      const before = record.before.properties[prop.id] ?? null;
      const after = record.after.properties[prop.id] ?? null;
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      const targets = relationIds(after);
      if (targets.some((id) => conflicts.has(id))) related.add(record.id);
    }
  }
  return related;
}

interface RecordClassification {
  before: number;
  after: number;
  beforeIds: PageId[];
  afterIds: PageId[];
  conflicts: PageId[];
}

function classifyRecords(state: WorkspaceState, records: ActionRecordChange[]): RecordClassification {
  const result: RecordClassification = { before: 0, after: 0, beforeIds: [], afterIds: [], conflicts: [] };
  for (const record of records) {
    const current = state.pages[record.id] ?? null;
    if (same(current, record.after)) {
      result.after++;
      result.afterIds.push(record.id);
    } else if (same(current, record.before)) {
      result.before++;
      result.beforeIds.push(record.id);
    } else result.conflicts.push(record.id);
  }
  return result;
}

function classifyUndoRecords(state: WorkspaceState, records: ActionRecordChange[]): RecordClassification {
  const result: RecordClassification = { before: 0, after: 0, beforeIds: [], afterIds: [], conflicts: [] };
  for (const record of records) {
    const current = state.pages[record.id] ?? null;
    if (same(current, record.before)) {
      result.before++;
      result.beforeIds.push(record.id);
    } else if (same(current, record.after)) {
      result.after++;
      result.afterIds.push(record.id);
    } else result.conflicts.push(record.id);
  }
  return result;
}

function same(left: unknown, right: unknown): boolean {
  return canonical(withoutUpdatedAt(left)) === canonical(withoutUpdatedAt(right));
}

function withoutUpdatedAt(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { updatedAt: _updatedAt, ...stable } = value as Record<string, unknown>;
  return stable;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function commandPageId(command: Command): PageId {
  return 'id' in command
    ? command.id
    : 'pageId' in command
      ? command.pageId
      : 'databaseId' in command
        ? command.databaseId
        : '';
}

async function saveJournal(session: WorkspaceSession, journal: TableActionJournal): Promise<void> {
  const text = JSON.stringify(journal);
  if (text.length > MAX_JOURNAL_TEXT)
    throw new Error('The table action recovery journal exceeds the safe size limit.');
  await session.writeMeta(TABLE_ACTION_JOURNAL_META, text);
}

async function trySaveJournal(session: WorkspaceSession, journal: TableActionJournal): Promise<void> {
  try {
    await saveJournal(session, journal);
  } catch {
    // the prior durable version still contains the intended recovery information
  }
}

function normalizeJournal(raw: unknown): TableActionJournal | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (
    item.format !== JOURNAL_FORMAT ||
    item.version !== 1 ||
    typeof item.id !== 'string' ||
    typeof item.databaseId !== 'string' ||
    typeof item.rowId !== 'string' ||
    typeof item.propertyId !== 'string' ||
    typeof item.label !== 'string' ||
    typeof item.createdAt !== 'number' ||
    !['prepared', 'complete', 'undoing', 'undone', 'aborted', 'conflict'].includes(String(item.status)) ||
    !Array.isArray(item.records) ||
    item.records.length === 0 ||
    item.records.length > 520 ||
    !Array.isArray(item.commands) ||
    item.commands.length > 3000 ||
    (item.status === 'undoing' && !Array.isArray(item.undoCommands))
  )
    return null;
  const records: ActionRecordChange[] = [];
  const recordIds = new Set<string>();
  for (const rawRecord of item.records) {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) return null;
    const record = rawRecord as Record<string, unknown>;
    if (typeof record.id !== 'string' || recordIds.has(record.id)) return null;
    recordIds.add(record.id);
    const before = record.before === null ? null : normalizePage(record.before);
    const after = record.after === null ? null : normalizePage(record.after);
    if ((record.before !== null && !before) || (record.after !== null && !after)) return null;
    if (before && before.id !== record.id) return null;
    if (after && after.id !== record.id) return null;
    records.push({ id: record.id, before, after });
  }
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const commands = item.commands.map((command) =>
    normalizeActionCommand(command, recordsById, item.databaseId as string),
  );
  if (commands.some((command) => !command)) return null;
  const undoCommands = Array.isArray(item.undoCommands)
    ? item.undoCommands.map((command) =>
        normalizeActionCommand(command, recordsById, item.databaseId as string),
      )
    : undefined;
  if (undoCommands?.some((command) => !command)) return null;
  const conflicts = Array.isArray(item.conflicts)
    ? item.conflicts.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    format: JOURNAL_FORMAT,
    version: 1,
    id: item.id,
    status: item.status as TableActionJournalStatus,
    databaseId: item.databaseId,
    rowId: item.rowId,
    propertyId: item.propertyId,
    label: item.label.slice(0, 100),
    createdAt: item.createdAt,
    records,
    commands: commands as Command[],
    ...(undoCommands ? { undoCommands: undoCommands as Command[] } : {}),
    conflicts,
    ...(typeof item.error === 'string' ? { error: item.error.slice(0, 2000) } : {}),
  };
}

function parseJournalText(text: string): TableActionJournal | null {
  if (text.length > MAX_JOURNAL_TEXT) return null;
  try {
    return normalizeJournal(JSON.parse(text));
  } catch {
    return null;
  }
}

function normalizeActionCommand(
  raw: unknown,
  records: ReadonlyMap<PageId, ActionRecordChange>,
  databaseId: PageId,
): Command | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const command = raw as Record<string, unknown>;
  const id = typeof command.id === 'string' ? command.id : '';
  const record = records.get(id);
  const now = Number.isFinite(command.now) ? (command.now as number) : null;
  if (command.type === 'page.create') {
    if (
      !record ||
      record.before !== null ||
      record.after === null ||
      command.parentId !== databaseId ||
      now === null
    )
      return null;
    if (typeof command.title !== 'string') return null;
    const properties =
      command.properties === undefined ? undefined : normalizeJournalValues(command.properties);
    if (command.properties !== undefined && !properties) return null;
    return {
      type: 'page.create',
      id,
      parentId: databaseId,
      now,
      title: command.title,
      ...(properties ? { properties } : {}),
    };
  }
  if (command.type === 'page.setProperties') {
    if (!record?.after || now === null) return null;
    const values = normalizeJournalValues(command.values);
    return values ? { type: 'page.setProperties', id, now, values } : null;
  }
  if (command.type === 'relation.set') {
    if (
      !record?.after ||
      now === null ||
      typeof command.propertyId !== 'string' ||
      !isJournalValue(command.value)
    )
      return null;
    return { type: 'relation.set', id, propertyId: command.propertyId, value: command.value, now };
  }
  if (command.type === 'page.control.reset') {
    if (id !== databaseId || !record?.after || now === null || typeof command.controlId !== 'string')
      return null;
    return { type: 'page.control.reset', id, controlId: command.controlId, now };
  }
  if (command.type === 'page.control.setValue') {
    if (
      !record?.after ||
      now === null ||
      typeof command.controlId !== 'string' ||
      !isJournalValue(command.value)
    )
      return null;
    return { type: 'page.control.setValue', id, controlId: command.controlId, value: command.value, now };
  }
  if (command.type === 'page.trash') {
    return record?.before === null && Boolean(record.after) && now !== null
      ? { type: 'page.trash', id, now }
      : null;
  }
  if (command.type === 'page.deleteForever')
    return record?.before === null && Boolean(record.after) ? { type: 'page.deleteForever', id } : null;
  return null;
}

function normalizeJournalValues(raw: unknown): Record<string, PropValue> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const values: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!key || key.length > 64 || !isJournalValue(value)) return null;
    values[key] = value;
  }
  return values;
}

function isJournalValue(value: unknown): value is PropValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (Array.isArray(value) &&
      value.length <= 200 &&
      value.every((item) => typeof item === 'string' && item.length <= 64))
  );
}

function emptyJournal(): TableActionJournal {
  return {
    format: JOURNAL_FORMAT,
    version: 1,
    id: '',
    status: 'aborted',
    databaseId: '',
    rowId: '',
    propertyId: '',
    label: '',
    createdAt: 0,
    records: [],
    commands: [],
    conflicts: [],
  };
}

function conflictMessage(ids: PageId[], fallback = 'Action recovery is available.'): string {
  return ids.length
    ? `Conflicts were preserved on ${ids.length} record${ids.length === 1 ? '' : 's'}; review them before retrying.`
    : fallback;
}
