import { applyCommand } from './commands';
import type { Command } from './commands';
import { displayTitle, MAX_TITLE_LENGTH } from './model';
import type { DatabaseDef, DocNode, PageId, PageMeta, PropDef, PropValue, WorkspaceState } from './model';
import { childrenOf, isEffectivelyTrashed } from './tree';
import { fail, ok } from './result';
import type { Result } from './result';
import { isComputedProperty, isNumericPropertyType, propertyValueError } from './typedValues';
import { relationIds } from './relations';
import { reservedPropertyName } from './vault/pageFile';
import { MAX_TABLE_ACTION_AFFECTED_ROWS } from './tableActions';
import type { ActionRecordChange, TableActionPlan } from './tableActions';
import {
  createRowClipboardPayload,
  MAX_ROW_CLIPBOARD_ROWS,
  validateRowClipboardPayload,
} from './rowClipboard';
import type { RowClipboardEntry, RowClipboardPayload } from './rowClipboard';

export const PRESERVE_ROW_PROPERTY = '__preserve_as_frontmatter__';
export const ROW_OPERATION_PROPERTY_ID = '__row_operations__';

export type RowPropertyMapping = Record<string, PageId | typeof PRESERVE_ROW_PROPERTY | ''>;
export type RowPlacement = 'before' | 'after';
export type RowOperationKind = 'insert' | 'copy' | 'move' | 'trash' | 'reorder';

export interface RowOperationPlan {
  kind: RowOperationKind;
  databaseId: PageId;
  rowIds: PageId[];
  baseState: WorkspaceState;
  commands: Command[];
  records: ActionRecordChange[];
}

export interface RowMappingPreviewItem {
  source: PropDef;
  destination: PropDef | null;
  choice: string;
  valueCount: number;
  conversion: 'same' | 'numeric' | 'select-to-multiple' | 'multiple-to-select' | 'preserve' | 'derived';
  error: string | null;
}

interface MappedRowValues {
  properties: Record<string, PropValue>;
  extra: Record<string, unknown>;
}

interface OperationBuildOptions {
  kind: RowOperationKind;
  databaseId: PageId;
  rowIds: PageId[];
}

const EMPTY_ARRAY = (value: PropValue | undefined): boolean => Array.isArray(value) && value.length === 0;

function hasStoredValue(value: PropValue | undefined): boolean {
  return value !== undefined && value !== null && value !== '' && !EMPTY_ARRAY(value);
}

function isDerived(prop: PropDef): boolean {
  return isComputedProperty(prop) || prop.type === 'button' || (prop.type === 'relation' && prop.relation?.isInverse === true);
}

function databaseFor(state: WorkspaceState, databaseId: PageId): DatabaseDef | null {
  const page = state.pages[databaseId];
  if (page?.kind !== 'database' || !page.database || page.trashedAt !== null) return null;
  return page.database;
}

function validateEditableDatabase(database: DatabaseDef | null): Result<DatabaseDef> {
  if (!database) return fail('The target is no longer a table.');
  if (database.unsupportedProperties?.length)
    return fail('This table contains column types from a newer version and is read only.');
  return ok(database);
}

function makePlan(
  state: WorkspaceState,
  options: OperationBuildOptions,
  commands: Command[],
): Result<RowOperationPlan> {
  if (commands.length === 0) return fail('This row operation would not change anything.');
  let next = state;
  const changed = new Set<PageId>();
  for (const command of commands) {
    const applied = applyCommand(next, command);
    if (!applied.ok) return fail(applied.error, applied.reason);
    next = applied.value.state;
    for (const id of applied.value.changes.pages) changed.add(id);
    for (const id of applied.value.changes.docs) changed.add(id);
    for (const id of applied.value.changes.removed) changed.add(id);
  }
  const records: ActionRecordChange[] = [...changed]
    .sort((a, b) => a.localeCompare(b))
    .map((id) => {
      const beforeDoc = state.docs[id] ?? null;
      const afterDoc = next.docs[id] ?? null;
      return {
        id,
        before: state.pages[id] ?? null,
        after: next.pages[id] ?? null,
        ...(beforeDoc === afterDoc
          ? {}
          : {
              docBefore: beforeDoc ? structuredClone(beforeDoc) : null,
              docAfter: afterDoc ? structuredClone(afterDoc) : null,
            }),
      };
    });
  if (records.length === 0) return fail('This row operation would not change anything.');
  if (records.length > MAX_TABLE_ACTION_AFFECTED_ROWS)
    return fail(`A row operation can affect at most ${MAX_TABLE_ACTION_AFFECTED_ROWS} records.`);
  return ok({ ...options, baseState: state, commands, records });
}

export function asTableActionPlan(plan: RowOperationPlan, label: string): TableActionPlan {
  const primary = plan.rowIds[0];
  if (!primary) throw new Error('A row operation must have at least one row.');
  return {
    databaseId: plan.databaseId,
    rowId: primary,
    propertyId: ROW_OPERATION_PROPERTY_ID,
    label,
    baseState: plan.baseState,
    commands: plan.commands,
    records: plan.records,
    steps: [],
    writes: plan.records.length,
  };
}

export function planInsertRow(
  state: WorkspaceState,
  databaseId: PageId,
  anchorRowId: PageId | null,
  placement: RowPlacement,
  id: PageId,
  now: number,
): Result<RowOperationPlan> {
  const database = validateEditableDatabase(databaseFor(state, databaseId));
  if (!database.ok) return database;
  const siblings = childrenOf(state.pages, databaseId);
  let index = siblings.length;
  if (anchorRowId !== null) {
    const anchorIndex = siblings.findIndex((row) => row.id === anchorRowId);
    if (anchorIndex < 0) return fail('The row used for insertion is no longer in this table.');
    index = anchorIndex + (placement === 'after' ? 1 : 0);
  }
  if (state.pages[id]) return fail('The new row id is already in use.');
  return makePlan(
    state,
    { kind: 'insert', databaseId, rowIds: [id] },
    [{ type: 'page.create', id, parentId: databaseId, title: '', now, index }],
  );
}

export function planTrashRows(
  state: WorkspaceState,
  databaseId: PageId,
  rowIds: readonly PageId[],
  now: number,
): Result<RowOperationPlan> {
  const database = validateEditableDatabase(databaseFor(state, databaseId));
  if (!database.ok) return database;
  const rows = validateRows(state, databaseId, rowIds);
  if (!rows.ok) return rows;
  return makePlan(
    state,
    { kind: 'trash', databaseId, rowIds: [...rowIds] },
    rowIds.map((id) => ({ type: 'page.trash', id, now })),
  );
}

export function planReorderRows(
  state: WorkspaceState,
  databaseId: PageId,
  rowIds: readonly PageId[],
  anchorRowId: PageId,
  placement: RowPlacement,
): Result<RowOperationPlan> {
  const database = validateEditableDatabase(databaseFor(state, databaseId));
  if (!database.ok) return database;
  const rows = validateRows(state, databaseId, rowIds);
  if (!rows.ok) return rows;
  const siblings = childrenOf(state.pages, databaseId);
  if (!siblings.some((row) => row.id === anchorRowId)) return fail('The row used for reordering is no longer visible.');
  const selected = new Set(rowIds);
  if (selected.has(anchorRowId)) return fail('Drop the selected rows before or after a different row.');
  const orderedSelection = siblings.filter((row) => selected.has(row.id)).map((row) => row.id);
  const desired = siblings.filter((row) => !selected.has(row.id)).map((row) => row.id);
  const anchorIndex = desired.indexOf(anchorRowId);
  const insertionIndex = anchorIndex + (placement === 'after' ? 1 : 0);
  desired.splice(insertionIndex, 0, ...orderedSelection);
  const moveOrders = [orderedSelection, [...orderedSelection].reverse()];
  for (const moveOrder of moveOrders) {
    const commands: Command[] = moveOrder.map((id) => ({
      type: 'page.move',
      id,
      parentId: databaseId,
      index: desired.indexOf(id),
    }));
    const simulated = applyCommandsForCheck(state, commands);
    const actual = childrenOf(simulated.pages, databaseId).map((row) => row.id);
    if (actual.join('\n') !== desired.join('\n')) continue;
    const result = makePlan(state, { kind: 'reorder', databaseId, rowIds: orderedSelection }, commands);
    if (result.ok) return result;
  }
  return fail('The selected rows could not be placed in that order safely.');
}

function applyCommandsForCheck(state: WorkspaceState, commands: Command[]): WorkspaceState {
  let next = state;
  for (const command of commands) {
    const result = applyCommand(next, command);
    if (!result.ok) return state;
    next = result.value.state;
  }
  return next;
}

export function suggestRowPropertyMappings(
  sourceProperties: readonly PropDef[],
  destination: DatabaseDef,
  rows: readonly Pick<RowClipboardEntry, 'page'>[],
  sameDatabase = false,
): RowPropertyMapping {
  const mappings: RowPropertyMapping = {};
  const used = new Set<PageId>();
  for (const source of sourceProperties) {
    if (isDerived(source)) continue;
    if (sameDatabase) {
      const sameId = destination.properties.find((prop) => prop.id === source.id && !isDerived(prop));
      if (sameId && compatibleTypes(source, sameId)) {
        mappings[source.id] = sameId.id;
        used.add(sameId.id);
        continue;
      }
    }
    const candidates = destination.properties.filter(
      (prop) =>
        !used.has(prop.id) &&
        !isDerived(prop) &&
        prop.name.trim().toLocaleLowerCase() === source.name.trim().toLocaleLowerCase() &&
        compatibleTypes(source, prop),
    );
    if (candidates.length === 1) {
      mappings[source.id] = candidates[0]!.id;
      used.add(candidates[0]!.id);
    } else {
      const hasRelationData =
        source.type === 'relation' && rows.some((row) => hasStoredValue(row.page.properties[source.id]));
      mappings[source.id] = hasRelationData ? '' : PRESERVE_ROW_PROPERTY;
    }
  }
  return mappings;
}

export function previewRowMappings(
  sourceProperties: readonly PropDef[],
  destination: DatabaseDef,
  rows: readonly Pick<RowClipboardEntry, 'page'>[],
  mappings: RowPropertyMapping,
): RowMappingPreviewItem[] {
  return sourceProperties.map((source) => {
    if (isDerived(source)) {
      return {
        source,
        destination: null,
        choice: 'derived',
        valueCount: 0,
        conversion: 'derived',
        error: null,
      };
    }
    const choice = mappings[source.id] ?? '';
    const valueCount = rows.filter((row) => hasStoredValue(row.page.properties[source.id])).length;
    if (choice === PRESERVE_ROW_PROPERTY)
      return { source, destination: null, choice, valueCount, conversion: 'preserve', error: null };
    const target = destination.properties.find((prop) => prop.id === choice) ?? null;
    if (!target)
      return {
        source,
        destination: null,
        choice,
        valueCount,
        conversion: 'same',
        error: valueCount ? `Choose a destination for ${source.name}.` : null,
      };
    const conversion = conversionKind(source, target);
    const incompatible = conversion === null;
    const error = incompatible
      ? `${source.name} (${source.type}) cannot be mapped to ${target.name} (${target.type}).`
      : source.type === 'relation' &&
          target.type === 'relation' &&
          source.relation?.targetDatabaseId !== target.relation?.targetDatabaseId
        ? `${source.name} points to a different table and cannot be mapped safely.`
        : null;
    return {
      source,
      destination: target,
      choice,
      valueCount,
      conversion: conversion ?? 'same',
      error,
    };
  });
}

export function planDuplicateRows(
  state: WorkspaceState,
  databaseId: PageId,
  rowIds: readonly PageId[],
  newId: () => PageId,
  now: number,
  copySuffix: string,
  afterRowId: PageId | null = rowIds.at(-1) ?? null,
): Result<RowOperationPlan> {
  const payload = createRowClipboardPayload(state, databaseId, rowIds);
  if (!payload.ok) return payload;
  const database = validateEditableDatabase(databaseFor(state, databaseId));
  if (!database.ok) return database;
  const mappings = suggestRowPropertyMappings(payload.value.sourceProperties, database.value, payload.value.rows, true);
  return planPasteRows(state, databaseId, payload.value, mappings, newId, now, copySuffix, afterRowId, 'copy');
}

export function planPasteRows(
  state: WorkspaceState,
  destinationDatabaseId: PageId,
  rawPayload: RowClipboardPayload | unknown,
  mappings: RowPropertyMapping,
  newId: () => PageId,
  now: number,
  copySuffix: string,
  afterRowId: PageId | null = null,
  kind: 'copy' = 'copy',
): Result<RowOperationPlan> {
  const payload = validateRowClipboardPayload(rawPayload);
  if (!payload.ok) return payload;
  const destination = validateEditableDatabase(databaseFor(state, destinationDatabaseId));
  if (!destination.ok) return destination;
  const mappedRows: Array<{ entry: RowClipboardEntry; values: MappedRowValues }> = [];
  for (const entry of payload.value.rows) {
    const mapped = mapRowValues(
      entry.page,
      payload.value.sourceProperties,
      destination.value,
      mappings,
    );
    if (!mapped.ok) return mapped;
    mappedRows.push({ entry, values: mapped.value });
  }
  const insertion = insertionIndex(state, destinationDatabaseId, afterRowId);
  if (!insertion.ok) return insertion;

  const commands: Command[] = [];
  const copyIds: PageId[] = [];
  const occupied = new Set(Object.keys(state.pages));
  for (const entry of payload.value.rows) occupied.add(entry.page.id);
  for (let index = 0; index < mappedRows.length; index++) {
    const { entry, values } = mappedRows[index]!;
    const id = allocateId(newId, occupied);
    if (!id) return fail('A unique row id could not be created. Try the operation again.');
    occupied.add(id);
    const duplicate = duplicateSnapshot(state, entry, id, now);
    if (!duplicate.ok) return duplicate;
    const copy = duplicate.value.page;
    commands.push({
      type: 'page.create',
      id,
      parentId: destinationDatabaseId,
      title: `${entry.page.title}${copySuffix ? ` ${copySuffix}` : ''}`.slice(0, MAX_TITLE_LENGTH),
      now,
      index: insertion.value + index,
      icon: copy.icon,
      tags: copy.tags,
      ...(copy.noteStyle ? { noteStyle: copy.noteStyle } : {}),
      controls: copy.controls,
      properties: values.properties,
      extra: values.extra,
      cover: copy.cover,
      coverPosition: copy.coverPosition,
      doc: duplicate.value.doc,
    });
    copyIds.push(id);
  }
  return makePlan(
    state,
    { kind, databaseId: destinationDatabaseId, rowIds: copyIds },
    commands,
  );
}

export function planMoveRows(
  state: WorkspaceState,
  sourceDatabaseId: PageId,
  destinationDatabaseId: PageId,
  rowIds: readonly PageId[],
  mappings: RowPropertyMapping,
  now: number,
): Result<RowOperationPlan> {
  if (sourceDatabaseId === destinationDatabaseId)
    return fail('Choose a different table to move these rows.');
  const source = validateEditableDatabase(databaseFor(state, sourceDatabaseId));
  if (!source.ok) return source;
  const destination = validateEditableDatabase(databaseFor(state, destinationDatabaseId));
  if (!destination.ok) return destination;
  const rows = validateRows(state, sourceDatabaseId, rowIds);
  if (!rows.ok) return rows;

  const payload = createRowClipboardPayload(state, sourceDatabaseId, rowIds);
  if (!payload.ok) return payload;
  const mappedByRow = new Map<PageId, MappedRowValues>();
  for (const entry of payload.value.rows) {
    const mapped = mapRowValues(entry.page, source.value.properties, destination.value, mappings);
    if (!mapped.ok) return mapped;
    mappedByRow.set(entry.page.id, mapped.value);
  }
  const relationSafety = validateMovedRelations(
    state,
    new Set(rowIds),
    destinationDatabaseId,
    destination.value,
    mappedByRow,
  );
  if (!relationSafety.ok) return relationSafety;

  const currentOrder = childrenOf(state.pages, sourceDatabaseId).filter((row) => rowIds.includes(row.id));
  const targetIndex = childrenOf(state.pages, destinationDatabaseId).length;
  const commands: Command[] = currentOrder.map((row, index) => ({
    type: 'page.move',
    id: row.id,
    parentId: destinationDatabaseId,
    index: targetIndex + index,
  }));
  for (const row of currentOrder) {
    const mapped = mappedByRow.get(row.id)!;
    const destinationInverseIds = new Set(
      destination.value.properties
        .filter((prop) => prop.type === 'relation' && prop.relation?.isInverse)
        .map((prop) => prop.id),
    );
    for (const id of destinationInverseIds) {
      if (hasStoredValue(row.properties[id]))
        return fail(`The existing value in ${id} conflicts with a calculated relation in the destination table.`);
    }
    commands.push({ type: 'page.setFields', id: row.id, properties: mapped.properties, extra: mapped.extra, now });
  }
  return makePlan(
    state,
    { kind: 'move', databaseId: destinationDatabaseId, rowIds: currentOrder.map((row) => row.id) },
    commands,
  );
}

function validateRows(
  state: WorkspaceState,
  databaseId: PageId,
  rowIds: readonly PageId[],
): Result<PageMeta[]> {
  if (rowIds.length === 0) return fail('Select at least one row.');
  if (rowIds.length > MAX_ROW_CLIPBOARD_ROWS)
    return fail(`A row operation can include at most ${MAX_ROW_CLIPBOARD_ROWS} rows.`);
  if (new Set(rowIds).size !== rowIds.length) return fail('A row was selected more than once.');
  const rows: PageMeta[] = [];
  for (const id of rowIds) {
    const row = state.pages[id];
    if (!row || row.parentId !== databaseId || isEffectivelyTrashed(state.pages, id))
      return fail('A selected row is no longer in this table. Refresh the selection and try again.');
    if (row.encrypted) return fail('Encrypted rows cannot be moved into an unencrypted table.');
    if (row.kind === 'database' || row.database) return fail('A nested table cannot be operated on as a row.');
    rows.push(row);
  }
  return ok(rows);
}

function insertionIndex(
  state: WorkspaceState,
  destinationDatabaseId: PageId,
  afterRowId: PageId | null,
): Result<number> {
  const siblings = childrenOf(state.pages, destinationDatabaseId);
  if (afterRowId === null) return ok(siblings.length);
  const index = siblings.findIndex((row) => row.id === afterRowId);
  return index < 0 ? fail('The row selected as the paste position is no longer in this table.') : ok(index + 1);
}

function allocateId(nextId: () => PageId, occupied: ReadonlySet<PageId>): PageId | null {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = nextId();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id) && !occupied.has(id)) return id;
  }
  return null;
}

function duplicateSnapshot(
  state: WorkspaceState,
  entry: RowClipboardEntry,
  id: PageId,
  now: number,
): Result<{ page: PageMeta; doc: DocNode }> {
  const temporary: WorkspaceState = {
    pages: { ...state.pages, [entry.page.id]: structuredClone(entry.page) },
    docs: { ...state.docs, [entry.page.id]: structuredClone(entry.doc) },
  };
  const result = applyCommand(temporary, { type: 'page.duplicate', id: entry.page.id, newId: id, now });
  if (!result.ok) return fail(result.error, result.reason);
  const page = result.value.state.pages[id];
  const doc = result.value.state.docs[id];
  if (!page || !doc) return fail(`The content of “${displayTitle(entry.page)}” could not be copied safely.`);
  return ok({ page, doc });
}

function mapRowValues(
  page: PageMeta,
  sourceProperties: readonly PropDef[],
  destination: DatabaseDef,
  mappings: RowPropertyMapping,
): Result<MappedRowValues> {
  const properties: Record<string, PropValue> = {};
  const extra = structuredClone(page.extra);
  const usedDestinationIds = new Set<PageId>();
  const sourceIds = new Set(sourceProperties.map((prop) => prop.id));
  const targetNameByKey = new Map(destination.properties.map((prop) => [prop.name.trim().toLocaleLowerCase(), prop.name]));
  const destinationInverseIds = new Set(
    destination.properties.filter((prop) => prop.type === 'relation' && prop.relation?.isInverse).map((prop) => prop.id),
  );

  for (const source of sourceProperties) {
    if (isDerived(source)) continue;
    const value = page.properties[source.id];
    const choice = mappings[source.id] ?? '';
    if (choice === PRESERVE_ROW_PROPERTY) {
      if (source.type === 'relation' && hasStoredValue(value))
        return fail(`Relation “${source.name}” must be mapped to a compatible relation in the destination table.`);
      if (value === undefined || value === null || EMPTY_ARRAY(value)) continue;
      const key = source.name.trim();
      if (!key || reservedPropertyName(key))
        return fail(`The value in “${source.name}” cannot be preserved as frontmatter safely.`);
      if (targetNameByKey.has(key.toLocaleLowerCase()))
        return fail(`“${source.name}” conflicts with a property in the destination table. Map it to that property or resolve the name conflict.`);
      if (Object.hasOwn(extra, key))
        return fail(`The existing frontmatter key “${key}” conflicts with the value being preserved.`);
      extra[key] = structuredClone(value);
      continue;
    }
    const target = destination.properties.find((prop) => prop.id === choice);
    if (!target) {
      if (hasStoredValue(value)) return fail(`Choose a destination for “${source.name}” before continuing.`);
      continue;
    }
    if (isDerived(target))
      return fail(`“${target.name}” is calculated and cannot receive copied row values.`);
    if (usedDestinationIds.has(target.id))
      return fail(`More than one source property is mapped to “${target.name}”.`);
    const converted = convertValue(source, target, value);
    if (!converted.ok) return converted;
    usedDestinationIds.add(target.id);
    if (value !== undefined && target.type !== 'relation' && !destinationInverseIds.has(target.id))
      properties[target.id] = converted.value;
    else if (value !== undefined && target.type === 'relation')
      properties[target.id] = converted.value;
  }

  for (const [unknownId, value] of Object.entries(page.properties)) {
    if (sourceIds.has(unknownId) || !hasStoredValue(value)) continue;
    const key = `Morrow field ${unknownId}`;
    if (reservedPropertyName(key) || targetNameByKey.has(key.toLocaleLowerCase()) || Object.hasOwn(extra, key))
      return fail(`An unknown property id (“${unknownId}”) conflicts with destination frontmatter.`);
    extra[key] = structuredClone(value);
  }

  for (const key of Object.keys(extra)) {
    if (targetNameByKey.has(key.trim().toLocaleLowerCase()))
      return fail(`Unknown frontmatter “${key}” conflicts with a destination property. Resolve the name conflict before moving or copying.`);
  }

  return ok({ properties, extra });
}

function convertValue(source: PropDef, target: PropDef, value: PropValue | undefined): Result<PropValue> {
  if (value === undefined || value === null || value === '') return ok(value ?? null);
  if (source.type === 'relation' && target.type === 'relation') {
    if (source.relation?.isInverse || target.relation?.isInverse)
      return fail(`Calculated relation “${source.name}” cannot be mapped as a stored relation.`);
    if (source.relation?.targetDatabaseId !== target.relation?.targetDatabaseId)
      return fail(`Relation “${source.name}” points to a different table than “${target.name}”.`);
    const ids = relationIds(value);
    if (!target.relation?.multiple && ids.length > 1)
      return fail(`“${target.name}” accepts one related row, but “${source.name}” contains ${ids.length}.`);
    return ok(target.relation?.multiple ? ids : ids[0] ?? null);
  }

  let converted: PropValue = structuredClone(value);
  if (source.type !== target.type) {
    if (isNumericPropertyType(source.type) && isNumericPropertyType(target.type) && typeof value === 'number') {
      converted = value;
    } else if (source.type === 'select' && target.type === 'multiSelect' && typeof value === 'string') {
      converted = [value];
    } else if (source.type === 'multiSelect' && target.type === 'select' && Array.isArray(value)) {
      if (value.length > 1) return fail(`“${target.name}” accepts one option, but “${source.name}” has ${value.length}.`);
      converted = value[0] ?? null;
    } else {
      return fail(`“${source.name}” (${source.type}) cannot be converted safely to “${target.name}” (${target.type}).`);
    }
  }
  const error = propertyValueError(target, converted);
  if (error) return fail(`“${source.name}” → “${target.name}”: ${error}`);
  return ok(converted);
}

function compatibleTypes(source: PropDef, target: PropDef): boolean {
  if (source.type === 'relation' && target.type === 'relation') {
    return (
      !source.relation?.isInverse &&
      !target.relation?.isInverse &&
      source.relation?.targetDatabaseId === target.relation?.targetDatabaseId
    );
  }
  if (source.type === target.type) return true;
  if (isNumericPropertyType(source.type) && isNumericPropertyType(target.type)) return true;
  return (
    (source.type === 'select' && target.type === 'multiSelect') ||
    (source.type === 'multiSelect' && target.type === 'select')
  );
}

function conversionKind(
  source: PropDef,
  target: PropDef,
): RowMappingPreviewItem['conversion'] | null {
  if (!compatibleTypes(source, target)) return null;
  if (source.type === target.type) return 'same';
  if (isNumericPropertyType(source.type) && isNumericPropertyType(target.type)) return 'numeric';
  if (source.type === 'select' && target.type === 'multiSelect') return 'select-to-multiple';
  return 'multiple-to-select';
}

function validateMovedRelations(
  state: WorkspaceState,
  movingIds: ReadonlySet<PageId>,
  destinationDatabaseId: PageId,
  destination: DatabaseDef,
  mappedByRow: ReadonlyMap<PageId, MappedRowValues>,
): Result<null> {
  for (const page of Object.values(state.pages)) {
    const schema = movingIds.has(page.id) ? destination : page.parentId ? state.pages[page.parentId]?.database : null;
    const values = movingIds.has(page.id) ? mappedByRow.get(page.id)?.properties ?? {} : page.properties;
    for (const prop of schema?.properties ?? []) {
      if (prop.type !== 'relation' || prop.relation?.isInverse) continue;
      const targets = relationIds(values[prop.id] ?? null);
      if (!targets.some((id) => movingIds.has(id))) continue;
      const targetDatabaseId = prop.relation?.targetDatabaseId;
      if (!targetDatabaseId)
        return fail(`Relation “${prop.name}” has no destination table and cannot be kept valid.`);
      for (const targetId of targets) {
        if (!movingIds.has(targetId)) continue;
        const target = state.pages[targetId];
        if (!target || isEffectivelyTrashed(state.pages, targetId))
          return fail(`Relation “${prop.name}” points to a row that is no longer available.`);
        const targetParentId = movingIds.has(targetId) ? destinationDatabaseId : target.parentId;
        if (targetParentId !== targetDatabaseId)
          return fail(
            `Moving these rows would invalidate “${prop.name}” on “${displayTitle(page)}”. Move its related row to the expected table or keep the relation unchanged.`,
          );
      }
    }
    for (const control of page.controls) {
      const targetDatabaseId = control.relation?.targetDatabaseId;
      const targets = relationIds(control.value);
      if (!targetDatabaseId || !targets.some((id) => movingIds.has(id))) continue;
      for (const targetId of targets) {
        if (!movingIds.has(targetId)) continue;
        const target = state.pages[targetId];
        if (!target || isEffectivelyTrashed(state.pages, targetId))
          return fail(`Control “${control.name}” points to a row that is no longer available.`);
        const targetParentId = movingIds.has(targetId) ? destinationDatabaseId : target.parentId;
        if (targetParentId !== targetDatabaseId)
          return fail(`Moving these rows would invalidate the relation in control “${control.name}”.`);
      }
    }
  }
  return ok(null);
}
