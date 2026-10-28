// every workspace change goes through here, pure and never throwing
import { isRecord, validateDoc } from './doc';
import { findKey, normalizeExtra, normalizeTag } from './vault/frontmatter';
import { writeProperty } from './vault/pageFile';
import { validPageIcon } from './icons';
import { normalizeDatabase } from './migrations';
import {
  DEFAULT_COVER_POSITION,
  displayTitle,
  emptyDoc,
  MAX_ICON_LENGTH,
  MAX_TITLE_LENGTH,
  newPageMeta,
  normalizeCoverPosition,
  normalizeNoteStyle,
  PAGE_KINDS,
  validCover,
  validCoverPosition,
  validNoteStyle,
} from './model';
import type {
  DatabaseDef,
  DocNode,
  NoteStyle,
  PageId,
  PageKind,
  PageMeta,
  NamedControlDef,
  PropDef,
  PropValue,
  RelationConfig,
  WorkspaceState,
} from './model';
import { errorMessage, fail, ok } from './result';
import type { Result } from './result';
import { previewRelationPairUnion, relationIds } from './relations';
import { bindFormulaReferences, formulaResult } from './database';
import { isNumericPropertyType, propertyValueError, scalarValueError } from './typedValues';
import { MAX_ATTACHMENT_VALUE_LENGTH, MAX_RICH_CANVAS_BYTES } from './propertyMedia';
import type { FormulaRuntimeValue, FormulaValue } from './formula';
import { foldText } from './search';
import { setTaskChecked } from './tasks';
import { controlValueErrorInState, normalizeNamedControls } from './controls';
import {
  linkedViewReferences,
  linkedViewSourceError,
  linkedViewsBlockingTrash,
  linkedViewsInDoc,
  viewUsesProperty,
} from './linkedViews';
import { childrenOf, descendantsOf, isDescendantOf, isEffectivelyTrashed, livePages } from './tree';

export type Command =
  | {
      type: 'page.create';
      id: PageId;
      parentId: PageId | null;
      now: number;
      title?: string;
      icon?: string | null;
      kind?: PageKind;
      dailyDate?: string | null;
      noteStyle?: NoteStyle;
      doc?: DocNode;
      index?: number;
      tags?: string[];
      controls?: NamedControlDef[];
      properties?: Record<string, PropValue>;
      extra?: Record<string, unknown>;
      cover?: string | null;
      coverPosition?: number;
      database?: DatabaseDef | null;
    }
  | { type: 'page.rename'; id: PageId; title: string; now: number }
  | { type: 'page.setIcon'; id: PageId; icon: string | null; now: number }
  | { type: 'page.move'; id: PageId; parentId: PageId | null; index?: number }
  | { type: 'page.duplicate'; id: PageId; newId: PageId; now: number }
  | { type: 'page.setDoc'; id: PageId; doc: DocNode; now: number }
  | { type: 'page.setFavorite'; id: PageId; favorite: boolean }
  | { type: 'page.markOpened'; id: PageId; now: number }
  | { type: 'page.trash'; id: PageId; now: number }
  | { type: 'page.restore'; id: PageId }
  | { type: 'page.deleteForever'; id: PageId }
  | { type: 'trash.empty' }
  | { type: 'task.setChecked'; pageId: PageId; index: number; checked: boolean; now: number }
  | { type: 'page.setTags'; id: PageId; tags: string[]; now: number }
  | { type: 'page.setCover'; id: PageId; cover: string | null; coverPosition?: number; now: number }
  | { type: 'page.setNoteStyle'; id: PageId; style: NoteStyle | null; now: number }
  | { type: 'page.setEncrypted'; id: PageId; encrypted: boolean; now: number }
  | { type: 'page.setKind'; id: PageId; kind: PageKind; now: number }
  // merges values into a database row, null clears a value
  | { type: 'page.setProperties'; id: PageId; values: Record<string, PropValue>; now: number }
  | { type: 'relation.set'; id: PageId; propertyId: string; value: PropValue; now: number }
  | {
      type: 'relation.configure';
      databaseId: PageId;
      propertyId: string;
      relation: RelationConfig;
      createInverseProperty?: { id?: string; name: string; multiple?: boolean };
      now: number;
    }
  // replaces a page's database values, its other frontmatter, or both
  | {
      type: 'page.setFields';
      id: PageId;
      properties?: Record<string, PropValue>;
      extra?: Record<string, unknown>;
      now: number;
    }
  | { type: 'page.control.configure'; id: PageId; control: NamedControlDef; now: number }
  | { type: 'page.control.setValue'; id: PageId; controlId: string; value: PropValue; now: number }
  | { type: 'page.control.reset'; id: PageId; controlId: string; now: number }
  | { type: 'page.control.delete'; id: PageId; controlId: string; now: number }
  | { type: 'database.set'; id: PageId; database: DatabaseDef; now: number }
  | { type: 'pages.insert'; pages: PageMeta[]; docs: Record<PageId, DocNode> };

// records touched by a command, storage writes exactly these
export interface Changes {
  pages: Set<PageId>;
  docs: Set<PageId>;
  removed: Set<PageId>;
}

export interface Applied {
  state: WorkspaceState;
  changes: Changes;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function emptyChanges(): Changes {
  return { pages: new Set(), docs: new Set(), removed: new Set() };
}

export function applyCommand(state: WorkspaceState, command: Command): Result<Applied> {
  try {
    return dispatch(state, command);
  } catch (error) {
    return fail(`Unexpected error in ${describe(command)}: ${errorMessage(error)}`);
  }
}

function describe(command: unknown): string {
  return typeof command === 'object' && command !== null && 'type' in command
    ? String((command as { type: unknown }).type)
    : 'command';
}

function dispatch(state: WorkspaceState, command: Command): Result<Applied> {
  switch (command.type) {
    case 'page.create':
      return createPage(state, command);
    case 'page.rename': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      const title = normalizeTitle(command.title);
      if (title === page.value.title) return unchanged(state);
      return updatePage(state, { ...page.value, title, updatedAt: command.now });
    }
    case 'page.setIcon': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      const icon = normalizeIcon(command.icon);
      if (!icon.ok) return icon;
      return updatePage(state, { ...page.value, icon: icon.value, updatedAt: command.now });
    }
    case 'page.move':
      return movePage(state, command.id, command.parentId, command.index);
    case 'page.duplicate':
      return duplicatePage(state, command);
    case 'page.setDoc': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      const doc = validateDoc(command.doc);
      if (!doc.ok) return doc;
      const priorDocument = state.docs[command.id];
      for (const reference of linkedViewsInDoc(doc.value, command.id)) {
        const issue = linkedViewSourceError(state, command.id, reference.databaseId, reference.blockId);
        if (!issue) continue;
        const preservedBrokenReference =
          priorDocument &&
          linkedViewsInDoc(priorDocument, command.id).some(
            (prior) =>
              prior.databaseId === reference.databaseId &&
              prior.blockId === reference.blockId &&
              linkedViewSourceError(state, command.id, prior.databaseId, prior.blockId) !== null,
          );
        if (!preservedBrokenReference) return fail(issue);
      }
      const next = withChanges(state, { pages: [{ ...page.value, updatedAt: command.now }] });
      return setDocs(next, { [command.id]: doc.value });
    }
    case 'page.setFavorite': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      if (page.value.favorite === command.favorite) return unchanged(state);
      return updatePage(state, { ...page.value, favorite: command.favorite === true });
    }
    case 'page.markOpened': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      return updatePage(state, { ...page.value, lastOpenedAt: command.now });
    }
    case 'page.trash': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      if (page.value.trashedAt !== null) return unchanged(state);
      const references = linkedViewsBlockingTrash(state, page.value.id);
      if (references.length) {
        return fail('This page is used by linked database views.', {
          kind: 'linkedViewsBlockingTrash',
          hostPageIds: [...new Set(references.map((reference) => reference.hostPageId))],
          referenceCount: references.length,
        });
      }
      return updatePage(state, { ...page.value, trashedAt: command.now });
    }
    case 'page.restore':
      return restorePage(state, command.id);
    case 'page.deleteForever': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      if (!isEffectivelyTrashed(state.pages, command.id)) {
        return fail('Only pages in the trash can be deleted permanently.');
      }
      return removePages(state, [command.id, ...descendantsOf(state.pages, command.id).map((p) => p.id)]);
    }
    case 'trash.empty': {
      const live = new Set(livePages(state.pages).map((page) => page.id));
      return removePages(
        state,
        Object.keys(state.pages).filter((id) => !live.has(id)),
      );
    }
    case 'task.setChecked': {
      const page = requirePage(state, command.pageId);
      if (!page.ok) return page;
      const doc = state.docs[command.pageId];
      const next = doc ? setTaskChecked(doc, command.index, command.checked === true) : null;
      if (!next) return fail('That checklist item no longer exists.');
      const withPage = withChanges(state, { pages: [{ ...page.value, updatedAt: command.now }] });
      return setDocs(withPage, { [command.pageId]: next });
    }
    case 'pages.insert':
      return insertPages(state, command.pages, command.docs);
    case 'page.setTags': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      const tags = normalizeTags(command.tags);
      if (tags.join('\n') === page.value.tags.join('\n')) return unchanged(state);
      return updatePage(state, { ...page.value, tags, updatedAt: command.now });
    }
    case 'page.setCover': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      const cover = command.cover === null ? null : validCover(command.cover);
      if (command.cover !== null && cover === null) return fail('Invalid cover.');
      if (command.coverPosition !== undefined && !validCoverPosition(command.coverPosition))
        return fail('Invalid cover position.');
      const coverPosition =
        cover === null
          ? DEFAULT_COVER_POSITION
          : command.coverPosition === undefined
            ? cover === page.value.cover
              ? page.value.coverPosition
              : DEFAULT_COVER_POSITION
            : normalizeCoverPosition(command.coverPosition);
      if (cover === page.value.cover && coverPosition === page.value.coverPosition) return unchanged(state);
      return updatePage(state, { ...page.value, cover, coverPosition, updatedAt: command.now });
    }
    case 'page.setNoteStyle': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      if (command.style !== null && !validNoteStyle(command.style)) return fail('Invalid note style.');
      const style = command.style === null ? null : normalizeNoteStyle(command.style);
      if (JSON.stringify(style) === JSON.stringify(page.value.noteStyle)) return unchanged(state);
      return updatePage(state, { ...page.value, noteStyle: style, updatedAt: command.now });
    }
    case 'page.setEncrypted': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      if (page.value.kind !== 'page') return fail('Only ordinary pages can be encrypted.');
      if (page.value.encrypted === command.encrypted) return unchanged(state);
      return updatePage(state, {
        ...page.value,
        encrypted: command.encrypted === true,
        updatedAt: command.now,
      });
    }
    case 'page.setKind': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      if (!PAGE_KINDS.includes(command.kind)) return fail('Unknown page kind.');
      if (page.value.kind === command.kind) return unchanged(state);
      const database =
        command.kind === 'database' ? (page.value.database ?? { properties: [], views: [] }) : null;
      return updatePage(state, { ...page.value, kind: command.kind, database, updatedAt: command.now });
    }
    case 'page.setProperties': {
      return setPageProperties(state, command.id, command.values ?? {}, command.now);
    }
    case 'relation.set':
      return applyRelationValue(state, command.id, command.propertyId, command.value, command.now);
    case 'relation.configure':
      return configureRelation(state, command, command.now);
    case 'page.setFields': {
      return setPageFields(state, command.id, command.properties, command.extra, command.now);
    }
    case 'page.control.configure':
      return configurePageControl(state, command.id, command.control, command.now);
    case 'page.control.setValue':
      return setPageControlValue(state, command.id, command.controlId, command.value, command.now);
    case 'page.control.reset':
      return resetPageControl(state, command.id, command.controlId, command.now);
    case 'page.control.delete':
      return deletePageControl(state, command.id, command.controlId, command.now);
    case 'database.set': {
      const page = requirePage(state, command.id);
      if (!page.ok) return page;
      if (page.value.kind !== 'database') return fail('That page is not a database.');
      if (page.value.database?.unsupportedProperties?.length)
        return fail('This database contains column types from a newer version and is read only.');
      if (hasInvalidSequenceDefinition(command.database)) return fail('Invalid numeric sequence configuration.');
      const database = normalizeDatabase(command.database);
      if (!database) return fail('Invalid database.');
      const removed = (page.value.database?.properties ?? []).filter(
        (property) => !database.properties.some((candidate) => candidate.id === property.id),
      );
      for (const property of removed) {
        const dependentViews = database.views.filter((view) => viewUsesProperty(view, property.id));
        const linkedDependents = linkedViewReferences(state, command.id).filter(
          (reference) => reference.view && viewUsesProperty(reference.view, property.id),
        );
        if (dependentViews.length || linkedDependents.length) {
          const count = dependentViews.length + linkedDependents.length;
          return fail(
            `Column “${property.name}” is still used by ${count} view configuration${count === 1 ? '' : 's'}. Remove those references before deleting the column; the original values are unchanged.`,
          );
        }
        const dependentFormula = Object.values(state.pages)
          .flatMap((owner) => owner.database?.properties.map((candidate) => ({ owner, candidate })) ?? [])
          .find(
            ({ owner, candidate }) =>
              (owner.id !== command.id || candidate.id !== property.id) &&
              [...(candidate.formulaBindings ?? []), ...(candidate.defaultFormulaBindings ?? [])].some(
                (binding) => binding.kind === 'property' && binding.databaseId === command.id && binding.propertyId === property.id,
              ),
          )?.candidate;
        if (dependentFormula) {
          return fail(
            `Column “${property.name}” is referenced by formula “${dependentFormula.name}”. Update that formula first; the column and row values are unchanged.`,
          );
        }
      }
      const result = updatePage(state, { ...page.value, database, updatedAt: command.now });
      if (!result.ok) return result;
      let applied = result.value;
      for (const property of removed) {
        for (const row of childrenOf(applied.state.pages, command.id)) {
          if (!Object.prototype.hasOwnProperty.call(row.properties, property.id)) continue;
          const value = writeProperty(property, row.properties[property.id] ?? null, applied.state);
          const extra = { ...row.extra };
          if (value !== undefined) {
            let key = findKey(extra, property.name) ?? property.name;
            if (findKey(extra, property.name) !== undefined)
              key = `${property.name} (removed ${property.id})`;
            let suffix = 2;
            while (findKey(extra, key) !== undefined)
              key = `${property.name} (removed ${property.id} ${suffix++})`;
            extra[key] = value;
          }
          const properties = { ...row.properties };
          delete properties[property.id];
          const changed = updatePage(applied.state, { ...row, properties, extra, updatedAt: command.now });
          if (!changed.ok) return changed;
          mergeChanges(applied.changes, changed.value.changes);
          applied = { state: changed.value.state, changes: applied.changes };
        }
      }
      return ok(applied);
    }
    default: {
      const unknown: never = command;
      return fail(`Unknown command: ${describe(unknown)}`);
    }
  }
}

function setPageProperties(
  state: WorkspaceState,
  id: PageId,
  values: Record<string, PropValue>,
  now: number,
): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  const sourceDatabase = page.value.parentId ? state.pages[page.value.parentId] : undefined;
  if (sourceDatabase?.kind === 'database' && sourceDatabase.database?.unsupportedProperties?.length)
    return fail('This database contains column types from a newer version and is read only.');
  const changes = emptyChanges();
  let draft = state;
  for (const [propertyId, value] of Object.entries(values)) {
    if (!ID_PATTERN.test(propertyId)) return fail('Invalid property.');
    const property =
      sourceDatabase?.kind === 'database'
        ? sourceDatabase.database?.properties.find((candidate) => candidate.id === propertyId)
        : undefined;
    if (value !== null && !validValue(value, maxPropertyValueLength(property)))
      return fail('Invalid property value.');
    if (property) {
      const error = propertyValueError(property, value);
      if (error) return fail(error);
    }
    const updated =
      property?.type === 'relation' && property.relation?.targetDatabaseId
        ? applyRelationValue(draft, id, propertyId, value, now)
        : setRawProperty(draft, id, propertyId, value, now);
    if (!updated.ok) return updated;
    draft = updated.value.state;
    mergeChanges(changes, updated.value.changes);
  }
  return ok({ state: draft, changes });
}

function setPageFields(
  state: WorkspaceState,
  id: PageId,
  values: Record<string, PropValue> | undefined,
  extra: Record<string, unknown> | undefined,
  now: number,
): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  const normalizedExtra = extra === undefined ? page.value.extra : normalizeExtra(extra);
  if (!normalizedExtra)
    return fail('Some frontmatter values are not supported or exceed safe editing limits.');
  const sourceDatabase = page.value.parentId ? state.pages[page.value.parentId] : undefined;
  if (
    values !== undefined &&
    sourceDatabase?.kind === 'database' &&
    sourceDatabase.database?.unsupportedProperties?.length
  )
    return fail('This database contains column types from a newer version and is read only.');
  const inverseProperties =
    sourceDatabase?.kind === 'database'
      ? (sourceDatabase.database?.properties.filter(
          (prop) => prop.type === 'relation' && prop.relation?.isInverse,
        ) ?? [])
      : [];
  const inversePropertyIds = new Set(inverseProperties.map((prop) => prop.id));
  const nextProperties: Record<string, PropValue> | undefined = values === undefined ? undefined : {};
  if (nextProperties) {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!ID_PATTERN.test(key)) return fail('Invalid property.');
      const property =
        sourceDatabase?.kind === 'database'
          ? sourceDatabase.database?.properties.find((candidate) => candidate.id === key)
          : undefined;
      if (value !== null && !validValue(value, maxPropertyValueLength(property)))
        return fail('Invalid property value.');
      const previous = page.value.properties[key] ?? null;
      if (property && !samePropValue(previous, value)) {
        const error = propertyValueError(property, value);
        if (error) return fail(error);
      }
      if (value === null || (Array.isArray(value) && value.length === 0)) continue;
      if (inversePropertyIds.has(key) && !samePropValue(page.value.properties[key] ?? null, value))
        return fail('Inverse relation values are computed from their source field.');
      nextProperties[key] = value;
    }
  }

  const relationProps =
    values !== undefined && sourceDatabase?.kind === 'database'
      ? (sourceDatabase.database?.properties.filter(
          (prop) => prop.type === 'relation' && prop.relation?.targetDatabaseId && !prop.relation.isInverse,
        ) ?? [])
      : [];
  let draft = state;
  const changes = emptyChanges();
  for (const prop of relationProps) {
    const proposed = nextProperties?.[prop.id] ?? null;
    if (samePropValue(page.value.properties[prop.id] ?? null, proposed)) continue;
    const updated = applyRelationValue(draft, id, prop.id, proposed, now);
    if (!updated.ok) return updated;
    draft = updated.value.state;
    mergeChanges(changes, updated.value.changes);
  }

  const current = draft.pages[id];
  if (!current) return fail('That page no longer exists.');
  if (nextProperties) {
    const finalProperties = { ...nextProperties };
    for (const prop of relationProps) {
      const value = current.properties[prop.id];
      if (value !== undefined) finalProperties[prop.id] = value;
    }
    for (const prop of inverseProperties) {
      const value = current.properties[prop.id];
      if (value !== undefined) finalProperties[prop.id] = value;
    }
    const updated = updatePage(draft, {
      ...current,
      properties: finalProperties,
      extra: normalizedExtra,
      updatedAt: now,
    });
    if (!updated.ok) return updated;
    draft = updated.value.state;
    mergeChanges(changes, updated.value.changes);
  } else if (extra !== undefined) {
    const updated = updatePage(draft, { ...current, extra: normalizedExtra, updatedAt: now });
    if (!updated.ok) return updated;
    draft = updated.value.state;
    mergeChanges(changes, updated.value.changes);
  }
  return ok({ state: draft, changes });
}

function setRawProperty(
  state: WorkspaceState,
  id: PageId,
  propertyId: string,
  value: PropValue,
  now: number,
): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  const properties = { ...page.value.properties };
  const next = value === null || (Array.isArray(value) && value.length === 0) ? null : value;
  if (samePropValue(page.value.properties[propertyId] ?? null, next)) return unchanged(state);
  if (next === null) delete properties[propertyId];
  else properties[propertyId] = next;
  return updatePage(state, { ...page.value, properties, updatedAt: now });
}

function applyRelationValue(
  state: WorkspaceState,
  rowId: PageId,
  propertyId: string,
  value: PropValue,
  now: number,
): Result<Applied> {
  const row = requirePage(state, rowId);
  if (!row.ok) return row;
  const sourceDatabase = row.value.parentId ? state.pages[row.value.parentId] : undefined;
  if (sourceDatabase?.kind !== 'database' || !sourceDatabase.database)
    return fail('That row is not in a database.');
  if (sourceDatabase.database.unsupportedProperties?.length)
    return fail('This database contains column types from a newer version and is read only.');
  const property = sourceDatabase.database.properties.find((candidate) => candidate.id === propertyId);
  if (property?.type !== 'relation' || !property.relation?.targetDatabaseId)
    return fail('Choose a target database for this relation first.');
  const targetDatabase = state.pages[property.relation.targetDatabaseId];
  if (targetDatabase?.kind !== 'database' || !targetDatabase.database)
    return fail('The target database for this relation no longer exists.');
  if (property.relation.isInverse) {
    return applyInverseRelationValue(
      state,
      row.value,
      sourceDatabase.id,
      property,
      targetDatabase,
      value,
      now,
    );
  }
  return applyOwningRelationValue(state, row.value, sourceDatabase, property, targetDatabase, value, now);
}

function applyOwningRelationValue(
  state: WorkspaceState,
  row: PageMeta,
  sourceDatabase: PageMeta,
  property: NonNullable<PageMeta['database']>['properties'][number],
  targetDatabase: PageMeta,
  value: PropValue,
  now: number,
): Result<Applied> {
  const relation = property.relation;
  if (property.type !== 'relation' || !relation || relation.isInverse)
    return fail('Invalid owning relation field.');
  if (Object.keys(row.extra).some((key) => key.toLocaleLowerCase() === property.name.toLocaleLowerCase()))
    return fail(
      'This relation has frontmatter content that cannot be converted safely. Repair it before editing.',
    );
  const requested = requestedRelationIds(value);
  if (!requested.ok) return requested;
  if (requested.value.length > 200) return fail('A relation can contain at most 200 rows.');
  if (!relation.multiple && requested.value.length > 1) return fail('This relation accepts only one row.');
  const targetRows = new Set(childrenOf(state.pages, targetDatabase.id).map((candidate) => candidate.id));
  if (requested.value.some((targetId) => !targetRows.has(targetId)))
    return fail('Choose rows from the selected database.');

  if (relation.inversePropertyId) {
    const inverse = targetDatabase.database?.properties.find(
      (candidate) => candidate.id === relation.inversePropertyId,
    );
    if (inverse?.type !== 'relation' || !inverse.relation?.isInverse)
      return fail('The inverse relation field no longer exists.');
    if (
      inverse.relation.targetDatabaseId !== sourceDatabase.id ||
      inverse.relation.inversePropertyId !== property.id
    )
      return fail('The inverse relation is no longer linked to this field.');
    if (!inverse.relation.multiple) {
      const conflicting = childrenOf(state.pages, sourceDatabase.id).find(
        (candidate) =>
          candidate.id !== row.id &&
          requested.value.some((targetId) =>
            relationIds(candidate.properties[property.id] ?? null).includes(targetId),
          ),
      );
      if (conflicting)
        return fail(
          `The inverse field accepts one row, and “${displayTitle(targetDatabase)}” is already linked to “${displayTitle(conflicting)}”.`,
        );
    }
  }
  const next: PropValue =
    requested.value.length === 0 ? null : relation.multiple ? requested.value : requested.value[0]!;
  return setRawProperty(state, row.id, property.id, next, now);
}

function applyInverseRelationValue(
  state: WorkspaceState,
  row: PageMeta,
  inverseDatabaseId: PageId,
  inverseProperty: NonNullable<PageMeta['database']>['properties'][number],
  ownerDatabase: PageMeta,
  value: PropValue,
  now: number,
): Result<Applied> {
  const relation = inverseProperty.relation;
  if (inverseProperty.type !== 'relation' || !relation?.isInverse || !relation.inversePropertyId)
    return fail('Invalid inverse relation field.');
  const owner = ownerDatabase.database?.properties.find(
    (candidate) => candidate.id === relation.inversePropertyId,
  );
  if (owner?.type !== 'relation' || !owner.relation || owner.relation.isInverse)
    return fail('The source relation field no longer exists.');
  if (
    owner.relation.targetDatabaseId !== inverseDatabaseId ||
    owner.relation.inversePropertyId !== inverseProperty.id
  )
    return fail('The source relation is no longer linked to this field.');

  const requested = requestedRelationIds(value);
  if (!requested.ok) return requested;
  if (requested.value.length > 200) return fail('A relation can contain at most 200 rows.');
  if (!relation.multiple && requested.value.length > 1)
    return fail('This inverse field accepts only one row.');
  const sourceRows = childrenOf(state.pages, ownerDatabase.id);
  const sourceIds = new Set(sourceRows.map((candidate) => candidate.id));
  if (requested.value.some((sourceId) => !sourceIds.has(sourceId)))
    return fail('Choose rows from the selected database.');
  const currentIds = sourceRows
    .filter((sourceRow) => relationIds(sourceRow.properties[owner.id] ?? null).includes(row.id))
    .map((sourceRow) => sourceRow.id);
  const desired = new Set(requested.value);
  const affected = [...new Set([...currentIds, ...requested.value])].sort(
    (a, b) => Number(desired.has(a)) - Number(desired.has(b)),
  );
  let draft = state;
  const changes = emptyChanges();
  for (const sourceId of affected) {
    const sourceRow = draft.pages[sourceId];
    if (!sourceRow) continue;
    const current = sourceRow.properties[owner.id] ?? null;
    const currentValues = relationIds(current);
    const shouldRelate = desired.has(sourceId);
    let next: PropValue | null;
    if (shouldRelate) {
      next = owner.relation.multiple ? [...new Set([...currentValues, row.id])] : row.id;
    } else if (owner.relation.multiple) {
      const remaining = currentValues.filter((id) => id !== row.id);
      next = remaining.length > 0 ? remaining : null;
    } else {
      next = current === row.id ? null : current;
    }
    const inverseDatabase = draft.pages[inverseDatabaseId];
    if (!inverseDatabase) return fail('The inverse relation database no longer exists.');
    const updated = applyOwningRelationValue(
      draft,
      sourceRow,
      ownerDatabase,
      owner,
      inverseDatabase,
      next,
      now,
    );
    if (!updated.ok) return updated;
    draft = updated.value.state;
    mergeChanges(changes, updated.value.changes);
  }
  return changes.pages.size > 0 ? ok({ state: draft, changes }) : unchanged(state);
}

function requestedRelationIds(value: PropValue): Result<string[]> {
  if (value === null || value === '') return ok([]);
  if (typeof value === 'string') return value.length <= 64 ? ok([value]) : fail('Invalid row id.');
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length > 64))
    return fail('Relation values must be row ids.');
  return ok([...new Set(value.filter(Boolean))]);
}

function configureRelation(
  state: WorkspaceState,
  command: Extract<Command, { type: 'relation.configure' }>,
  now: number,
): Result<Applied> {
  const { databaseId, propertyId, relation: requested, createInverseProperty } = command;
  const source = requirePage(state, databaseId);
  if (!source.ok) return source;
  if (source.value.kind !== 'database' || !source.value.database) return fail('That page is not a database.');
  if (source.value.database.unsupportedProperties?.length)
    return fail('This database contains column types from a newer version and is read only.');
  const sourceProp = source.value.database.properties.find((candidate) => candidate.id === propertyId);
  if (sourceProp?.type !== 'relation') return fail('That property is not a relation.');
  if (sourceProp.relation?.isInverse)
    return fail('Configure the source relation field that this inverse property projects.');

  const targetId = typeof requested.targetDatabaseId === 'string' ? requested.targetDatabaseId : null;
  const target = targetId ? state.pages[targetId] : undefined;
  if (targetId && (target?.kind !== 'database' || !target.database))
    return fail('Choose an existing database as the relation target.');
  if (targetId && target?.database?.unsupportedProperties?.length)
    return fail('The target database contains column types from a newer version and is read only.');
  if (targetId && !ID_PATTERN.test(targetId)) return fail('Invalid target database id.');
  const displayPropertyId =
    typeof requested.displayPropertyId === 'string' ? requested.displayPropertyId : null;
  if (
    displayPropertyId &&
    !target?.database?.properties.some((candidate) => candidate.id === displayPropertyId)
  )
    return fail('The display property is not in the target database.');

  let inversePropertyId =
    typeof requested.inversePropertyId === 'string' ? requested.inversePropertyId : null;

  const schemas = new Map<PageId, DatabaseDef>();
  const schemaFor = (id: PageId): DatabaseDef => {
    const cached = schemas.get(id);
    if (cached) return cached;
    const database = state.pages[id]?.database;
    if (!database) throw new Error('The database no longer exists.');
    schemas.set(id, database);
    return database;
  };
  const updateProp = (
    id: PageId,
    propId: string,
    change: (prop: NonNullable<DatabaseDef['properties'][number]>) => DatabaseDef['properties'][number],
  ) => {
    const database = schemaFor(id);
    schemas.set(id, {
      ...database,
      properties: database.properties.map((prop) => (prop.id === propId ? change(prop) : prop)),
    });
  };

  // If requested to create a new inverse property in the target database
  if (createInverseProperty && targetId && target?.database) {
    const newPropId = createInverseProperty.id || `prop-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const newPropName = createInverseProperty.name.trim() || displayTitle(source.value);
    const newInverseProp: PropDef = {
      id: newPropId,
      name: newPropName,
      type: 'relation',
      options: [],
      relation: {
        targetDatabaseId: databaseId,
        multiple: createInverseProperty.multiple ?? true,
        isInverse: true,
        displayPropertyId: null,
        inversePropertyId: propertyId,
        filters: [],
      },
    };
    schemas.set(target.id, {
      ...schemaFor(target.id),
      properties: [...schemaFor(target.id).properties, newInverseProp],
    });
    inversePropertyId = newPropId;
  }

  if (inversePropertyId && !targetId) return fail('Choose a target database before an inverse field.');
  if (inversePropertyId && source.value.id === targetId && inversePropertyId === propertyId)
    return fail('A relation field cannot be its own inverse.');
  if (!Array.isArray(requested.filters) || requested.filters.length > 100)
    return fail('A relation can have at most 100 option filters.');
  if (
    targetId &&
    requested.filters.some(
      (filter) => !target!.database!.properties.some((candidate) => candidate.id === filter.prop),
    )
  )
    return fail('Every option filter must use a property in the target database.');

  const oldConfig = sourceProp.relation;
  const isUnlinkingOldInverse =
    oldConfig?.targetDatabaseId &&
    oldConfig.inversePropertyId &&
    (oldConfig.targetDatabaseId !== targetId || oldConfig.inversePropertyId !== inversePropertyId);

  const pagesToMutate: PageMeta[] = [];

  // When unlinking an old inverse relationship, materialize the projected links into the old inverse column
  if (isUnlinkingOldInverse) {
    const oldTarget = state.pages[oldConfig!.targetDatabaseId!];
    const oldInverse = oldTarget?.database?.properties.find(
      (candidate) => candidate.id === oldConfig!.inversePropertyId,
    );
    if (
      oldTarget?.kind === 'database' &&
      oldInverse?.type === 'relation' &&
      oldInverse.relation?.targetDatabaseId === databaseId &&
      oldInverse.relation.inversePropertyId === propertyId
    ) {
      updateProp(oldTarget.id, oldInverse.id, (prop) => ({
        ...prop,
        relation: {
          targetDatabaseId: null,
          multiple: oldInverse.relation?.multiple ?? false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      }));

      // Materialize projected values in rows of oldTarget
      const oldTargetRows = Object.values(state.pages).filter((page) => page.parentId === oldTarget.id);
      const sourceRows = Object.values(state.pages).filter((page) => page.parentId === databaseId);
      for (const tRow of oldTargetRows) {
        const connectedSourceIds = sourceRows
          .filter((sRow) => relationIds(sRow.properties[propertyId] ?? null).includes(tRow.id))
          .map((sRow) => sRow.id);
        if (connectedSourceIds.length > 0) {
          const materializedVal: PropValue = oldInverse.relation?.multiple
            ? connectedSourceIds
            : (connectedSourceIds[0] ?? null);
          pagesToMutate.push({
            ...tRow,
            properties: { ...tRow.properties, [oldInverse.id]: materializedVal },
            updatedAt: now,
          });
        }
      }
    }
  }

  // When linking to an inverse property in target
  let unionPreview: ReturnType<typeof previewRelationPairUnion> | null = null;
  if (inversePropertyId && target) {
    const inverse = schemaFor(target.id).properties.find((candidate) => candidate.id === inversePropertyId);
    if (inverse?.type !== 'relation') return fail('Choose a relation property as the inverse field.');
    const current = inverse.relation;
    if (current?.targetDatabaseId && current.targetDatabaseId !== databaseId)
      return fail('That inverse field already targets another database.');
    if (current?.inversePropertyId && current.inversePropertyId !== propertyId)
      return fail('That inverse field is already linked to another relation.');

    // Calculate union preview and check conflicts
    unionPreview = previewRelationPairUnion(
      state,
      databaseId,
      propertyId,
      requested.multiple === true,
      target.id,
      inversePropertyId,
      current?.multiple,
    );
    if (!unionPreview.canLink) {
      return fail(unionPreview.conflicts[0] ?? 'Cardinality conflict when linking inverse relations.');
    }

    updateProp(target.id, inverse.id, (prop) => ({
      ...prop,
      relation: {
        targetDatabaseId: databaseId,
        multiple: current?.multiple ?? true,
        isInverse: true,
        displayPropertyId: current?.displayPropertyId ?? null,
        inversePropertyId: propertyId,
        filters: current?.filters ?? [],
      },
    }));
  }

  const nextConfig: RelationConfig = {
    targetDatabaseId: targetId,
    multiple: requested.multiple === true,
    isInverse: false,
    displayPropertyId,
    inversePropertyId,
    filters: requested.filters.map((filter) => ({ ...filter })),
  };
  updateProp(databaseId, propertyId, (prop) => ({ ...prop, relation: nextConfig }));

  const schemaPages: PageMeta[] = [];
  for (const [id, schema] of schemas) {
    const normalized = normalizeDatabase(schema);
    const page = state.pages[id];
    if (!normalized || !page) return fail('The relation settings could not be saved.');
    schemaPages.push({ ...page, database: normalized, updatedAt: now });
  }
  let applied = withChanges(state, { pages: [...schemaPages, ...pagesToMutate] });

  if (targetId) {
    const targetRows = Object.values(applied.state.pages).filter((page) => page.parentId === targetId);
    const sourceRows = Object.values(applied.state.pages).filter((page) => page.parentId === databaseId);

    if (unionPreview && inversePropertyId) {
      // Clear values on the inverse projection side
      const targetInverseProperty = schemaFor(targetId).properties.find((p) => p.id === inversePropertyId);
      for (const tRow of targetRows) {
        const hasProp = tRow.properties[inversePropertyId] !== undefined && tRow.properties[inversePropertyId] !== null;
        const extraKey = targetInverseProperty
          ? Object.keys(tRow.extra).find((k) => k.toLocaleLowerCase() === targetInverseProperty.name.toLocaleLowerCase())
          : null;
        if (hasProp || extraKey) {
          const nextProps = { ...tRow.properties };
          delete nextProps[inversePropertyId];
          const nextExtra = { ...tRow.extra };
          if (extraKey) delete nextExtra[extraKey];
          const updatedRow: PageMeta = {
            ...tRow,
            properties: nextProps,
            extra: nextExtra,
            updatedAt: now,
          };
          const step = withChanges(applied.state, { pages: [updatedRow] });
          mergeChanges(applied.changes, step.changes);
          applied = { state: step.state, changes: applied.changes };
        }
      }

      // Reconcile and apply unified pairs onto the owner side
      for (const sRow of sourceRows) {
        const currentVal = sRow.properties[propertyId];
        const currentTokens = relationIds(currentVal ?? null);
        let hasAmbiguous = false;
        for (const token of currentTokens) {
          if (!targetRows.some((r) => r.id === token)) {
            const clean = token.trim().replace(/^\[\[(.*)\]\]$/, '$1').trim();
            const folded = foldText(clean);
            const matches = targetRows.filter((r) => foldText(displayTitle(r)) === folded);
            if (matches.length > 1) {
              hasAmbiguous = true;
              break;
            }
          }
        }
        if (hasAmbiguous) continue;

        const unifiedTargets = unionPreview.ownerPairs.get(sRow.id) ?? [];
        const nextValue: PropValue = nextConfig.multiple
          ? (unifiedTargets.length > 0 ? unifiedTargets : null)
          : (unifiedTargets[0] ?? null);
        const migrated = applyRelationValue(applied.state, sRow.id, propertyId, nextValue, now);
        if (migrated.ok) {
          mergeChanges(applied.changes, migrated.value.changes);
          applied = { state: migrated.value.state, changes: applied.changes };
        }
      }
    } else {
      // Legacy resolution of titles into ids if not uniting
      for (const row of sourceRows) {
        const tokens = relationIds(row.properties[propertyId] ?? null);
        if (tokens.length === 0) continue;
        const converted: string[] = [];
        let resolvable = true;
        for (const token of tokens) {
          if (applied.state.pages[token]?.parentId === targetId) {
            converted.push(token);
            continue;
          }
          const wanted = foldText(token.trim());
          const candidates = targetRows.filter((candidate) => foldText(displayTitle(candidate)) === wanted);
          if (candidates.length !== 1) {
            resolvable = false;
            break;
          }
          converted.push(candidates[0]!.id);
        }
        if (!resolvable || (!nextConfig.multiple && converted.length > 1)) continue;
        const nextValue: PropValue = nextConfig.multiple ? [...new Set(converted)] : (converted[0] ?? null);
        const migrated = applyRelationValue(applied.state, row.id, propertyId, nextValue, now);
        if (migrated.ok) {
          mergeChanges(applied.changes, migrated.value.changes);
          applied = { state: migrated.value.state, changes: applied.changes };
        }
      }
    }
  }

  return ok(applied);
}

function samePropValue(a: PropValue | null, b: PropValue | null): boolean {
  if (a === b) return true;
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((item, index) => item === b[index])
  );
}

function mergeChanges(target: Changes, source: Changes): void {
  for (const id of source.pages) target.pages.add(id);
  for (const id of source.docs) target.docs.add(id);
  for (const id of source.removed) target.removed.add(id);
}

function configurePageControl(
  state: WorkspaceState,
  id: PageId,
  control: NamedControlDef,
  now: number,
): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  if (page.value.kind === 'canvas') return fail('Canvas pages cannot contain named controls.');
  const nextControl = normalizeNamedControls([control])?.[0];
  if (!nextControl) return fail('Invalid named control.');
  const controls = [...page.value.controls];
  const index = controls.findIndex((item) => item.id === nextControl.id);
  const previous = index < 0 ? null : controls[index]!;
  if (previous) {
    // Editing a name or default must not replace a live value. When its type or choices change,
    // keep the value only if it remains valid; otherwise adopt the new default.
    nextControl.value = controlValueErrorInState(nextControl, previous.value, state)
      ? nextControl.defaultValue
      : previous.value;
  }
  const valueError = controlValueErrorInState(nextControl, nextControl.value, state);
  const defaultError = controlValueErrorInState(nextControl, nextControl.defaultValue, state);
  if (valueError) return fail(valueError);
  if (defaultError) return fail(`Invalid default value: ${defaultError}`);
  if (index < 0) controls.push(nextControl);
  else controls[index] = nextControl;
  const updated = updatePage(state, { ...page.value, controls, updatedAt: now });
  if (!updated.ok || !previous || previous.name === nextControl.name) return updated;
  const doc = state.docs[id];
  if (!doc) return updated;
  const renameOccurrences = (node: DocNode): DocNode => ({
    ...node,
    ...(node.type === 'namedControl' && node.attrs?.controlId === nextControl.id
      ? { attrs: { ...node.attrs, label: nextControl.name } }
      : {}),
    ...(node.content ? { content: node.content.map(renameOccurrences) } : {}),
  });
  return setDocs(updated.value, { [id]: renameOccurrences(doc) });
}

function setPageControlValue(
  state: WorkspaceState,
  id: PageId,
  controlId: string,
  value: PropValue,
  now: number,
): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  const index = page.value.controls.findIndex((item) => item.id === controlId);
  if (index < 0) return fail('That named control was deleted or is unavailable.');
  const control = page.value.controls[index]!;
  const error = controlValueErrorInState(control, value, state);
  if (error) return fail(error);
  if (JSON.stringify(control.value) === JSON.stringify(value)) return unchanged(state);
  const controls = [...page.value.controls];
  controls[index] = { ...control, value };
  return updatePage(state, { ...page.value, controls, updatedAt: now });
}

function resetPageControl(
  state: WorkspaceState,
  id: PageId,
  controlId: string,
  now: number,
): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  const control = page.value.controls.find((item) => item.id === controlId);
  if (!control) return fail('That named control was deleted or is unavailable.');
  return setPageControlValue(state, id, controlId, control.defaultValue, now);
}

function deletePageControl(state: WorkspaceState, id: PageId, controlId: string, now: number): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  if (!page.value.controls.some((item) => item.id === controlId)) return unchanged(state);
  // Stored formulas keep their bindings so the editor can report a missing-control diagnostic.
  return updatePage(state, {
    ...page.value,
    controls: page.value.controls.filter((item) => item.id !== controlId),
    updatedAt: now,
  });
}

function nextAvailableSequenceValue(
  prop: PropDef,
  start: number,
  increment: number,
  rows: PageMeta[],
): number | null {
  let candidate = start;
  for (let attempt = 0; attempt <= rows.length; attempt++) {
    if (!Number.isFinite(candidate)) return null;
    if (!rows.some((row) => row.properties[prop.id] === candidate)) return candidate;
    const next = candidate + increment;
    if (!Number.isFinite(next) || next <= candidate) return null;
    candidate = next;
  }
  return null;
}

function hasInvalidSequenceDefinition(database: unknown): boolean {
  if (!isRecord(database) || !Array.isArray(database.properties)) return false;
  return database.properties.some((property) => {
    if (!isRecord(property)) return false;
    if (
      property.sequenceNext !== undefined &&
      (typeof property.sequenceNext !== 'number' || !Number.isFinite(property.sequenceNext))
    )
      return true;
    if (property.defaultSequence === undefined) return false;
    const sequence = property.defaultSequence;
    return (
      !isRecord(sequence) ||
      typeof sequence.start !== 'number' ||
      !Number.isFinite(sequence.start) ||
      typeof sequence.increment !== 'number' ||
      !Number.isFinite(sequence.increment) ||
      sequence.increment <= 0 ||
      !Number.isFinite(sequence.start + sequence.increment) ||
      sequence.start + sequence.increment <= sequence.start ||
      (typeof property.sequenceNext === 'number' &&
        (!Number.isFinite(property.sequenceNext + sequence.increment) ||
          property.sequenceNext + sequence.increment <= property.sequenceNext)) ||
      !isNumericPropertyType(property.type as PropDef['type']) ||
      property.defaultFormula !== undefined
    );
  });
}

function createPage(
  state: WorkspaceState,
  command: Extract<Command, { type: 'page.create' }>,
): Result<Applied> {
  if (!ID_PATTERN.test(command.id)) return fail('Invalid page id.');
  if (state.pages[command.id]) return fail('A page with this id already exists.');
  const parent = checkParent(state, command.parentId);
  if (!parent.ok) return parent;
  const icon = normalizeIcon(command.icon ?? null);
  if (!icon.ok) return icon;
  if (command.dailyDate != null && !DATE_PATTERN.test(command.dailyDate)) return fail('Invalid daily date.');
  if (command.noteStyle !== undefined && !validNoteStyle(command.noteStyle))
    return fail('Invalid note style.');
  const noteStyle = command.noteStyle === undefined ? null : normalizeNoteStyle(command.noteStyle);
  const doc = validateDoc(command.doc ?? emptyDoc());
  if (!doc.ok) return doc;
  const controls = normalizeNamedControls(command.controls);
  if (!controls) return fail('Invalid page controls.');
  for (const control of controls) {
    const controlError =
      controlValueErrorInState(control, control.value, state) ??
      controlValueErrorInState(control, control.defaultValue, state);
    if (controlError) return fail(`Control ${control.name}: ${controlError}`);
  }
  const extra = normalizeExtra(command.extra);
  if (!extra) return fail('Some frontmatter values are not supported or exceed safe editing limits.');
  const cover = command.cover === undefined || command.cover === null ? null : validCover(command.cover);
  if (command.cover !== undefined && command.cover !== null && cover === null) return fail('Invalid cover.');
  if (command.coverPosition !== undefined && !validCoverPosition(command.coverPosition))
    return fail('Invalid cover position.');
  const kind = command.kind && PAGE_KINDS.includes(command.kind) ? command.kind : 'page';
  if (kind === 'database' && hasInvalidSequenceDefinition(command.database))
    return fail('Invalid numeric sequence configuration.');
  const properties = { ...(command.properties ?? {}) };
  const parentPage = command.parentId ? state.pages[command.parentId] : undefined;
  const rowDatabase = parentPage?.kind === 'database' ? parentPage.database : null;
  const sequenceNext = new Map<string, number>();
  for (const [propertyId, value] of Object.entries(properties)) {
    const prop = rowDatabase?.properties.find((candidate) => candidate.id === propertyId);
    if (!ID_PATTERN.test(propertyId) || (value !== null && !validValue(value, maxPropertyValueLength(prop))))
      return fail('Invalid property value.');
  }
  if (rowDatabase) {
    if (rowDatabase.unsupportedProperties?.length)
      return fail('This database contains column types from a newer version and is read only.');
    for (const prop of rowDatabase.properties) {
      if (!Object.prototype.hasOwnProperty.call(properties, prop.id)) continue;
      const error = propertyValueError(prop, properties[prop.id]!);
      if (error) return fail(error);
    }
  }
  const page = newPageMeta({
    id: command.id,
    parentId: command.parentId,
    title: normalizeTitle(command.title ?? ''),
    icon: icon.value,
    kind,
    createdAt: command.now,
    dailyDate: command.dailyDate ?? null,
    noteStyle,
    tags: normalizeTags(command.tags ?? []),
    controls,
    properties,
    extra,
    cover,
    coverPosition: command.coverPosition === undefined
      ? DEFAULT_COVER_POSITION
      : normalizeCoverPosition(command.coverPosition),
    database:
      kind === 'database' ? (normalizeDatabase(command.database) ?? { properties: [], views: [] }) : null,
  });
  if (rowDatabase) {
    const occupiedRows = childrenOf(state.pages, command.parentId!, true);
    for (const prop of rowDatabase.properties) {
      const sequence = prop.defaultSequence;
      if (prop.fillMode !== 'default' || !sequence || !isNumericPropertyType(prop.type)) continue;
      const explicit = Object.prototype.hasOwnProperty.call(properties, prop.id);
      const start = Math.max(prop.sequenceNext ?? sequence.start, sequence.start);
      const candidate = nextAvailableSequenceValue(prop, start, sequence.increment, occupiedRows);
      if (candidate === null) return fail(`The sequence for ${prop.name} has exceeded the supported numeric range.`);
      if (!explicit) {
        const error = propertyValueError(prop, candidate);
        if (error) return fail(`Default for ${prop.name}: ${error}`);
        properties[prop.id] = candidate;
      }
      const consumesCandidate = !explicit || properties[prop.id] === candidate;
      const next = consumesCandidate ? candidate + sequence.increment : candidate;
      if (!Number.isFinite(next) || (consumesCandidate && next <= candidate))
        return fail(`The sequence for ${prop.name} has exceeded the supported numeric range.`);
      sequenceNext.set(prop.id, next);
    }
    for (const prop of rowDatabase.properties) {
      if (Object.prototype.hasOwnProperty.call(properties, prop.id) || prop.fillMode !== 'default') continue;
      if (prop.defaultSequence) continue;
      if (prop.defaultFormula || !Object.prototype.hasOwnProperty.call(prop, 'defaultValue')) continue;
      const error = propertyValueError(prop, prop.defaultValue ?? null);
      if (error) return fail(`Default for ${prop.name}: ${error}`);
      properties[prop.id] = prop.defaultValue ?? null;
    }
    const formulaDefaults = new Map(
      rowDatabase.properties
        .filter(
          (prop) =>
            !Object.prototype.hasOwnProperty.call(properties, prop.id) &&
            prop.fillMode === 'default' &&
            !prop.defaultSequence &&
            Boolean(prop.defaultFormula),
        )
        .map((prop) => [prop.id, prop]),
    );
    const complete = new Set<string>();
    const active = new Set<string>();
    const evaluateDefault = (prop: PropDef): Result<null> => {
      if (complete.has(prop.id)) return ok(null);
      if (active.has(prop.id)) return fail(`Default formulas contain a dependency cycle at ${prop.name}.`);
      active.add(prop.id);
      const bindings = bindFormulaReferences(
        prop.defaultFormula ?? '',
        command.parentId!,
        state,
        prop.defaultFormulaBindings ?? [],
      );
      for (const binding of bindings) {
        if (binding.kind !== 'property' || binding.databaseId !== command.parentId) continue;
        const dependency = formulaDefaults.get(binding.propertyId!);
        if (dependency) {
          const nested = evaluateDefault(dependency);
          if (!nested.ok) return nested;
        }
      }
      page.properties = properties;
      const calculated = formulaResult(
        page,
        { ...prop, formula: prop.defaultFormula, formulaBindings: bindings },
        rowDatabase,
        0,
        state,
      );
      if (calculated.error) return fail(`Default for ${prop.name}: ${calculated.error}`);
      if (calculated.value !== null) {
        const persistable = persistentFormulaDefault(calculated.value);
        const value =
          prop.type === 'formula'
            ? persistable
            : persistable === undefined
              ? undefined
              : coerceDefault(prop, persistable);
        if (value === undefined)
          return fail(
            `The default formula for ${prop.name} returned the wrong value type or an unknown option.`,
          );
        properties[prop.id] = value;
      }
      active.delete(prop.id);
      complete.add(prop.id);
      page.properties = properties;
      return ok(null);
    };
    for (const prop of rowDatabase.properties) {
      if (!formulaDefaults.has(prop.id)) continue;
      const result = evaluateDefault(prop);
      if (!result.ok) return result;
    }
    page.properties = properties;
  }
  const siblings = childrenOf(state.pages, command.parentId);
  const placed = placeAmong(siblings, page, command.index);
  const nextDatabase = rowDatabase
    ? {
        ...rowDatabase,
        properties: rowDatabase.properties.map((prop) => {
          const next = sequenceNext.get(prop.id);
          return next === undefined || next === prop.sequenceNext ? prop : { ...prop, sequenceNext: next };
        }),
      }
    : null;
  const databaseChanged = Boolean(
    nextDatabase && nextDatabase.properties.some((prop, index) => prop !== rowDatabase!.properties[index]),
  );
  const pagesToWrite = databaseChanged && parentPage && nextDatabase
    ? [...placed, { ...parentPage, database: nextDatabase, updatedAt: command.now }]
    : placed;
  let applied = withChanges(state, { pages: pagesToWrite });
  if (rowDatabase) {
    for (const prop of rowDatabase.properties) {
      if (prop.type !== 'relation' || !prop.relation?.targetDatabaseId) continue;
      if (!Object.prototype.hasOwnProperty.call(properties, prop.id)) continue;
      const related = applyRelationValue(applied.state, page.id, prop.id, properties[prop.id]!, command.now);
      if (!related.ok) return related;
      mergeChanges(applied.changes, related.value.changes);
      applied = { state: related.value.state, changes: applied.changes };
    }
  }
  return setDocs(applied, { [page.id]: doc.value });
}

function movePage(
  state: WorkspaceState,
  id: PageId,
  parentId: PageId | null,
  index: number | undefined,
): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  if (parentId === id) return fail('A page cannot be moved inside itself.');
  const parent = checkParent(state, parentId);
  if (!parent.ok) return parent;
  if (parentId !== null && isDescendantOf(state.pages, parentId, id)) {
    return fail('A page cannot be moved inside one of its own subpages.');
  }
  const siblings = childrenOf(state.pages, parentId).filter((sibling) => sibling.id !== id);
  return ok(withChanges(state, { pages: placeAmong(siblings, { ...page.value, parentId }, index) }));
}

function duplicatePage(
  state: WorkspaceState,
  command: Extract<Command, { type: 'page.duplicate' }>,
): Result<Applied> {
  const page = requirePage(state, command.id);
  if (!page.ok) return page;
  if (!ID_PATTERN.test(command.newId) || state.pages[command.newId]) return fail('Invalid id for the copy.');
  const source = page.value;
  const siblings = childrenOf(state.pages, source.parentId);
  const uniqueId = (kind: string, ordinal: number) => {
    const suffix = `_${kind}${ordinal.toString(36)}`;
    return `${command.newId.slice(0, 64 - suffix.length)}${suffix}`;
  };
  const controlIds = new Map(source.controls.map((control, index) => [control.id, uniqueId('c', index + 1)]));
  const resultIds = new Map<string, string>();
  let resultOrdinal = 0;
  const collectResults = (node: DocNode) => {
    if (node.type === 'calculatedResult' && typeof node.attrs?.resultId === 'string')
      resultIds.set(node.attrs.resultId, uniqueId('r', ++resultOrdinal));
    for (const child of node.content ?? []) collectResults(child);
  };
  collectResults(state.docs[source.id] ?? emptyDoc());
  const copy: PageMeta = {
    ...source,
    id: command.newId,
    controls: source.controls.map((control) => ({ ...control, id: controlIds.get(control.id)! })),
    title: normalizeTitle(source.title ? `${source.title} (copy)` : ''),
    kind: 'page',
    dailyDate: null,
    favorite: false,
    createdAt: command.now,
    updatedAt: command.now,
    lastOpenedAt: null,
    trashedAt: null,
  };
  const index = siblings.findIndex((sibling) => sibling.id === source.id) + 1;
  const doc = cloneLinkedViewBlocks(state.docs[source.id] ?? emptyDoc(), source.id, copy.id, controlIds, resultIds);
  return setDocs(withChanges(state, { pages: placeAmong(siblings, copy, index) }), {
    [copy.id]: doc,
  });
}

function cloneLinkedViewBlocks(
  doc: DocNode,
  sourcePageId: PageId,
  hostPageId: PageId,
  controlIds = new Map<string, string>(),
  resultIds = new Map<string, string>(),
): DocNode {
  let index = 0;
  const uniqueId = (kind: string, ordinal: number) => {
    const suffix = `_${kind}${ordinal.toString(36)}`;
    return `${hostPageId.slice(0, 64 - suffix.length)}${suffix}`;
  };
  const visit = (node: DocNode): DocNode => {
    let attrs = node.attrs;
    if (node.type === 'linkedDatabaseView') {
      index++;
      const view =
        attrs?.view && typeof attrs.view === 'object'
          ? { ...structuredClone(attrs.view as Record<string, unknown>), id: uniqueId('v', index) }
          : attrs?.view;
      attrs = {
        ...attrs,
        hostPageId,
        blockId: uniqueId('b', index),
        view,
      };
      if (view && typeof view === 'object') {
        const copyView = { ...(view as Record<string, unknown>) };
        const remapRule = (rule: unknown): unknown => {
          if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return rule;
          const item = { ...(rule as Record<string, unknown>) };
          const ref = item.controlRef;
          if (ref && typeof ref === 'object' && !Array.isArray(ref)) {
            const controlRef = { ...(ref as Record<string, unknown>) };
            if (controlRef.pageId === sourcePageId && typeof controlRef.controlId === 'string') {
              controlRef.controlId = controlIds.get(controlRef.controlId) ?? controlRef.controlId;
              controlRef.pageId = hostPageId;
            }
            item.controlRef = controlRef;
          }
          if (Array.isArray(item.formulaBindings))
            item.formulaBindings = remapFormulaBindings(item.formulaBindings, sourcePageId, hostPageId, controlIds, resultIds);
          return item;
        };
        if (Array.isArray(copyView.filters)) copyView.filters = copyView.filters.map(remapRule);
        if (Array.isArray(copyView.filterGroups))
          copyView.filterGroups = copyView.filterGroups.map((group) => {
            if (!group || typeof group !== 'object' || Array.isArray(group)) return group;
            const nextGroup = { ...(group as Record<string, unknown>) };
            if (Array.isArray(nextGroup.filters)) nextGroup.filters = nextGroup.filters.map(remapRule);
            return nextGroup;
          });
        if (Array.isArray(copyView.conditionalFormats))
          copyView.conditionalFormats = copyView.conditionalFormats.map(remapRule);
        attrs.view = copyView;
      }
    }
    if (node.type === 'namedControl' && typeof attrs?.controlId === 'string')
      attrs = { ...attrs, controlId: controlIds.get(attrs.controlId) ?? attrs.controlId, pageId: hostPageId };
    if (node.type === 'calculatedResult') {
      const bindings = Array.isArray(attrs?.bindings)
        ? remapFormulaBindings(attrs.bindings, sourcePageId, hostPageId, controlIds, resultIds)
        : attrs?.bindings;
      attrs = {
        ...attrs,
        resultId: typeof attrs?.resultId === 'string' ? resultIds.get(attrs.resultId) ?? attrs.resultId : attrs?.resultId,
        bindings,
        pageId: hostPageId,
      };
    }
    return {
      ...node,
      ...(attrs ? { attrs } : {}),
      ...(node.content ? { content: node.content.map(visit) } : {}),
    };
  };
  return visit(doc);
}

function remapFormulaBindings(
  raw: unknown[],
  sourcePageId: PageId,
  targetPageId: PageId,
  controlIds: Map<string, string>,
  resultIds: Map<string, string>,
): unknown[] {
  return raw.map((binding) => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return binding;
    const item = { ...(binding as Record<string, unknown>) };
    if (item.pageId !== sourcePageId) return item;
    if (item.kind === 'control' && typeof item.controlId === 'string')
      item.controlId = controlIds.get(item.controlId) ?? item.controlId;
    if (item.kind === 'result' && typeof item.resultId === 'string')
      item.resultId = resultIds.get(item.resultId) ?? item.resultId;
    if (['control', 'result', 'ambiguous'].includes(String(item.kind))) item.pageId = targetPageId;
    return item;
  });
}

function restorePage(state: WorkspaceState, id: PageId): Result<Applied> {
  const page = requirePage(state, id);
  if (!page.ok) return page;
  const restored: PageMeta = { ...page.value, trashedAt: null };
  // a parent that is gone or still trashed sends the page to the top level
  if (restored.parentId !== null && isEffectivelyTrashed(state.pages, restored.parentId)) {
    restored.parentId = null;
  }
  const siblings = childrenOf(state.pages, restored.parentId).filter((sibling) => sibling.id !== id);
  return ok(withChanges(state, { pages: placeAmong(siblings, restored, undefined) }));
}

function insertPages(
  state: WorkspaceState,
  pages: PageMeta[],
  docs: Record<PageId, DocNode>,
): Result<Applied> {
  if (!Array.isArray(pages) || pages.length === 0) return fail('Nothing to insert.');
  const incoming = new Map<PageId, PageMeta>();
  for (const page of pages) {
    if (!ID_PATTERN.test(page.id)) return fail('Invalid page id in import.');
    if (state.pages[page.id] || incoming.has(page.id)) return fail(`Duplicate page id: ${page.id}`);
    incoming.set(page.id, { ...page, title: normalizeTitle(page.title) });
  }
  const combined = { ...state.pages, ...Object.fromEntries(incoming) };
  for (const page of incoming.values()) {
    if (page.parentId !== null && !combined[page.parentId])
      return fail('Imported page has a missing parent.');
    if (page.parentId !== null && isDescendantOf(combined, page.parentId, page.id)) {
      return fail('Imported pages contain a cycle.');
    }
  }
  const validDocs: Record<PageId, DocNode> = {};
  for (const id of incoming.keys()) {
    const doc = validateDoc(docs[id] ?? emptyDoc());
    if (!doc.ok) return fail(`Page ${id}: ${doc.error}`);
    validDocs[id] = doc.value;
  }
  return setDocs(withChanges(state, { pages: [...incoming.values()] }), validDocs);
}

function removePages(state: WorkspaceState, ids: PageId[]): Result<Applied> {
  if (ids.length === 0) return unchanged(state);
  const pages = { ...state.pages };
  const docs = { ...state.docs };
  const changes = emptyChanges();
  for (const id of ids) {
    delete pages[id];
    delete docs[id];
    changes.removed.add(id);
  }
  return ok({ state: { pages, docs }, changes });
}

// inserts the page at index and renumbers only the siblings that moved
function placeAmong(siblings: PageMeta[], page: PageMeta, index: number | undefined): PageMeta[] {
  const list = [...siblings];
  const at =
    index === undefined || !Number.isFinite(index) ? list.length : clamp(Math.floor(index), 0, list.length);
  list.splice(at, 0, page);
  const updated: PageMeta[] = [];
  list.forEach((item, position) => {
    if (item === page) updated.push({ ...page, order: position });
    else if (item.order !== position) updated.push({ ...item, order: position });
  });
  return updated;
}

function checkParent(state: WorkspaceState, parentId: PageId | null): Result<null> {
  if (parentId === null) return ok(null);
  if (!state.pages[parentId]) return fail('The parent page does not exist.');
  if (isEffectivelyTrashed(state.pages, parentId))
    return fail('Pages cannot be added inside a page in the trash.');
  return ok(null);
}

function requirePage(state: WorkspaceState, id: PageId): Result<PageMeta> {
  const page = typeof id === 'string' ? state.pages[id] : undefined;
  return page ? ok(page) : fail('That page no longer exists.');
}

function updatePage(state: WorkspaceState, page: PageMeta): Result<Applied> {
  return ok(withChanges(state, { pages: [page] }));
}

function unchanged(state: WorkspaceState): Result<Applied> {
  return ok({ state, changes: emptyChanges() });
}

function withChanges(state: WorkspaceState, update: { pages: PageMeta[] }): Applied {
  const pages = { ...state.pages };
  const changes = emptyChanges();
  for (const page of update.pages) {
    pages[page.id] = page;
    changes.pages.add(page.id);
  }
  return { state: { pages, docs: state.docs }, changes };
}

function setDocs(applied: Applied, docs: Record<PageId, DocNode>): Result<Applied> {
  const next = { ...applied.state.docs, ...docs };
  for (const id of Object.keys(docs)) applied.changes.docs.add(id);
  return ok({ state: { pages: applied.state.pages, docs: next }, changes: applied.changes });
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const result = tags
    .map((tag) => (typeof tag === 'string' ? normalizeTag(tag) : null))
    .filter((tag): tag is string => tag !== null);
  return [...new Set(result)].slice(0, 100);
}

function maxPropertyValueLength(prop: PropDef | undefined): number {
  if (prop?.type === 'richCanvas') return MAX_RICH_CANVAS_BYTES;
  if (prop?.type === 'image' || prop?.type === 'file') return MAX_ATTACHMENT_VALUE_LENGTH;
  return 10_000;
}

function validValue(value: unknown, maxStringLength = 10_000): value is PropValue {
  if (typeof value === 'string') return value.length <= maxStringLength;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  return Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === 'string');
}

function coerceDefault(prop: PropDef, value: FormulaValue | string[]): PropValue | undefined {
  let candidate: PropValue = value;
  if (prop.type === 'select' && typeof value === 'string') {
    candidate =
      prop.options.find((option) => option.id === value || option.name.toLowerCase() === value.toLowerCase())
        ?.id ?? value;
  } else if (prop.type === 'multiSelect' && (typeof value === 'string' || Array.isArray(value))) {
    const entries = (Array.isArray(value) ? value : value.split(',')).map((part) => part.trim());
    const options = entries.map((name) =>
      prop.options.find((option) => option.id === name || option.name.toLowerCase() === name.toLowerCase()),
    );
    if (options.some((option) => !option)) return undefined;
    candidate = options.map((option) => option!.id);
  }
  return scalarValueError(prop, candidate) === null ? candidate : undefined;
}

function persistentFormulaDefault(value: FormulaRuntimeValue): PropValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value) && value.length <= 200 && value.every((item) => typeof item === 'string'))
    return value;
  return undefined;
}

export function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  return title.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_TITLE_LENGTH);
}

function normalizeIcon(icon: unknown): Result<string | null> {
  if (icon === null || icon === undefined || icon === '') return ok(null);
  if (!validPageIcon(icon) || [...icon].length > MAX_ICON_LENGTH) return fail('Invalid page icon.');
  return ok(icon);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
