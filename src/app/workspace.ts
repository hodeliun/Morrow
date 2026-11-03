import { useSyncExternalStore } from 'react';
import type { Command } from '../core/commands';
import { displayTitle } from '../core/model';
import type { PageId, PageMeta, WorkspaceState } from '../core/model';
import type { Result } from '../core/result';
import type { FileCatalogSnapshot } from '../core/vault/fileCatalog';
import type { SaveStatus } from '../storage/saveQueue';
import type { WorkspaceSession } from '../storage/session';
import type { ContextualHistorySnapshot } from '../storage/session';
import type { DataHistorySnapshot } from '../storage/dataHistory';
import { primaryViewConfigChanges } from '../storage/viewHistoryCapture';
import type { ViewHistoryIdentity } from '../storage/viewHistoryCapture';
import { rebaseDatabaseHistory } from './propertyHistoryReplay';
import { commandErrorMessage } from './commandMessages';
import { getLocale, t } from './i18n';
import { toast } from './ui';
import { getPreferences, legacyNoteStyle } from './platform/preferences';
import { setReadingVaultScope } from './readingPlace';

let session: WorkspaceSession | null = null;
const dataHistoryEditGuards = new WeakMap<HTMLElement, () => boolean>();

export function registerDataHistoryEditGuard(
  element: HTMLElement,
  canEditNow: () => boolean,
): () => void {
  dataHistoryEditGuards.set(element, canEditNow);
  return () => {
    if (dataHistoryEditGuards.get(element) === canEditNow) dataHistoryEditGuards.delete(element);
  };
}

export function dataHistoryEditGuard(element: HTMLElement): (() => boolean) | null {
  return dataHistoryEditGuards.get(element) ?? null;
}

export function setSession(next: WorkspaceSession): void {
  if (session !== next) clearPropertyHistory();
  setReadingVaultScope(next.location ?? '');
  session = next;
}

export function getSession(): WorkspaceSession {
  if (!session) throw new Error('Workspace is not open yet.');
  return session;
}

export function getState(): WorkspaceState {
  return getSession().getState();
}

// runs a command and tells the user when it is refused
export function run(command: Command): Result<WorkspaceState> {
  return runAll([command]);
}

export function runAll(commands: Command[]): Result<WorkspaceState> {
  const prepared = commands.map(withNoteDefaults);
  const beforeState = session?.getState();
  const before = propertySnapshots(prepared);
  const result =
    prepared.length === 1 ? getSession().execute(prepared[0]!) : getSession().executeAll(prepared);
  if (!result.ok) toast(commandErrorMessage(result, pageTitle, getLocale()), { tone: 'error' });
  else if (before && (!beforeState || !onlyPrimaryViewConfigChanged(prepared, beforeState, getState())))
    recordProperties(before);
  return result;
}

function onlyPrimaryViewConfigChanged(
  commands: Command[],
  before: WorkspaceState,
  after: WorkspaceState,
): boolean {
  if (commands.length !== 1 || commands[0]?.type !== 'database.set') return false;
  const databaseId = commands[0].id;
  const beforeDatabase = before.pages[databaseId]?.database;
  const afterDatabase = after.pages[databaseId]?.database;
  return Boolean(
    beforeDatabase &&
      afterDatabase &&
      primaryViewConfigChanges(databaseId, beforeDatabase, afterDatabase).length > 0,
  );
}

// property values and types live outside a page's text, so the editor's undo never sees them. ctrl+z away
// from the text steps back through them here, a type change and the values it converted as one step
const PROPERTY_COMMANDS = new Set<Command['type']>(['database.set', 'page.setProperties', 'page.setFields']);
const MAX_PROPERTY_STEPS = 100;
type Snapshot = Array<{
  id: PageId;
  database: PageMeta['database'];
  properties: PageMeta['properties'];
  extra: PageMeta['extra'];
}>;
let undoStack: Array<{ before: Snapshot; after: Snapshot }> = [];
let redoStack: Array<{ before: Snapshot; after: Snapshot }> = [];
let replaying = false;
let recorded = 0;

function snapshot(ids: PageId[]): Snapshot {
  const pages = getState().pages;
  return ids.flatMap((id) => {
    const page = pages[id];
    return page ? [{ id, database: page.database, properties: page.properties, extra: page.extra }] : [];
  });
}

function propertySnapshots(commands: Command[]): Snapshot | null {
  if (replaying || !session) return null;
  const includesSchemaChange = commands.some((command) => command.type === 'database.set' || command.type === 'page.setKind');
  const ids = commands
    .filter((command) => PROPERTY_COMMANDS.has(command.type))
    .map((command) => ('id' in command ? command.id : null));
  const uniqueIds = [...new Set(ids.filter((id): id is PageId => id !== null))];
  const legacyIds = includesSchemaChange ? uniqueIds : uniqueIds.filter((id) => !isDatabaseRow(id));
  return legacyIds.length > 0 ? snapshot(legacyIds) : null;
}

function isDatabaseRow(id: PageId): boolean {
  const page = getState().pages[id];
  const parent = page?.parentId ? getState().pages[page.parentId] : undefined;
  return parent?.kind === 'database' && Boolean(parent.database);
}

function recordProperties(before: Snapshot): void {
  const after = snapshot(before.map((page) => page.id));
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  undoStack = [...undoStack, { before, after }].slice(-MAX_PROPERTY_STEPS);
  redoStack = [];
  recorded += 1;
}

// how many property changes have been recorded, so a field can tell whether its own change was one
export function propertyChangeCount(): number {
  return recorded;
}

export function clearPropertyHistory(): void {
  undoStack = [];
  redoStack = [];
}

// puts the properties back as they were before the last change, false when there is nothing to undo
export function stepProperties(direction: 'undo' | 'redo'): boolean {
  const [from, to] = direction === 'undo' ? [undoStack, redoStack] : [redoStack, undoStack];
  const step = from.pop();
  if (!step) return false;
  const expected = direction === 'undo' ? step.after : step.before;
  const target = direction === 'undo' ? step.before : step.after;
  const pages = getState().pages;
  let replayConflict = false;
  const commands: Command[] = target.flatMap(({ id, database, properties, extra }): Command[] => {
    const page = pages[id];
    if (!page) return [];
    const now = Date.now();
    let replayDatabase = database;
    if (page.kind === 'database' && database) {
      const expectedDatabase = expected.find((snapshot) => snapshot.id === id)?.database;
      const rebased = page.database && expectedDatabase
        ? rebaseDatabaseHistory(page.database, expectedDatabase, database)
        : null;
      if (!rebased) {
        replayConflict = true;
        return [];
      }
      replayDatabase = rebased;
    }
    return [
      ...(page.kind === 'database' && replayDatabase
        ? [{ type: 'database.set' as const, id, database: replayDatabase, now }]
        : []),
      { type: 'page.setFields' as const, id, properties, extra, now },
    ];
  });
  if (replayConflict) {
    from.push(step);
    toast(t('database.propertyHistoryConflict'), { tone: 'error' });
    return true;
  }
  replaying = true;
  try {
    const result = getSession().executeHistoryReplay(commands);
    if (!result.ok) {
      const message = result.error.includes(' is still used by ') && result.error.includes('view configuration')
        ? t('database.propertyHistoryConflict')
        : commandErrorMessage(result, pageTitle, getLocale());
      toast(message, { tone: 'error' });
      from.push(step);
      return true;
    }
  } finally {
    replaying = false;
  }
  to.push(step);
  return true;
}

function pageTitle(id: string): string | undefined {
  const page = getState().pages[id];
  return page ? displayTitle(page) : undefined;
}

function withNoteDefaults(command: Command): Command {
  if (command.type !== 'page.create' || command.kind === 'canvas') return command;
  const preferences = getPreferences();
  command =
    command.calculatedResultBackground === undefined
      ? { ...command, calculatedResultBackground: preferences.defaultCalculatedResultBackground }
      : command;
  if (command.noteStyle !== undefined) return command;
  const style = preferences.defaultNoteStyle;
  if (command.kind === 'database') return { ...command, noteStyle: { ...style, width: 'full' } };
  // the legacy appearance is now fixed for existing pages, so its matching default needs no frontmatter
  if (JSON.stringify(style) === JSON.stringify(legacyNoteStyle(preferences.font, preferences.width)))
    return command;
  return { ...command, noteStyle: style };
}

export function useWorkspace(): WorkspaceState {
  const current = getSession();
  return useSyncExternalStore(current.subscribe, current.getState, current.getState);
}

export function useFileCatalog(): FileCatalogSnapshot {
  const current = getSession();
  return useSyncExternalStore(current.subscribeFileCatalog, current.getFileCatalog, current.getFileCatalog);
}

export function useSaveStatus(): SaveStatus {
  const queue = getSession().queue;
  return useSyncExternalStore(
    (listener) => queue.subscribe(listener),
    () => queue.status,
  );
}

export function useDataHistory(databaseId: PageId): DataHistorySnapshot {
  const current = getSession();
  return useSyncExternalStore(
    (listener) => current.subscribeDataHistory(databaseId, listener),
    () => current.getDataHistory(databaseId),
    () => current.getDataHistory(databaseId),
  );
}

export function useContextualHistory(
  databaseId: PageId,
  identity: ViewHistoryIdentity,
): ContextualHistorySnapshot {
  const current = getSession();
  return useSyncExternalStore(
    (listener) => current.subscribeContextualHistory(databaseId, identity, listener),
    () => current.getContextualHistory(databaseId, identity),
    () => current.getContextualHistory(databaseId, identity),
  );
}
