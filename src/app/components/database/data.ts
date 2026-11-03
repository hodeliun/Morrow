import type { Command } from '../../../core/commands';
import { newOption, rowsOf } from '../../../core/database';
import type { DatabaseDef, PageId, PropDef, PropValue, SelectOption, ViewDef } from '../../../core/model';
import { foldText } from '../../../core/search';
import { adoptRows } from '../../../core/properties';
import { findKey } from '../../../core/vault/frontmatter';
import { writeProperty } from '../../../core/vault/pageFile';
import { linkedViewReferences, viewUsesProperty } from '../../../core/linkedViews';
import { newId } from '../../platform/files';
import { getState, run, runAll } from '../../workspace';
import { t } from '../../i18n';
import { toast } from '../../ui';

export function databaseOf(id: PageId): DatabaseDef | null {
  return getState().pages[id]?.database ?? null;
}

export function titleAliasConflicts(database: DatabaseDef, alias: string): boolean {
  const folded = foldText(alias.trim());
  return database.properties.some((property) => foldText(property.name.trim()) === folded);
}

// every change to a database's properties and views goes through here as one step. rows whose frontmatter
// has a key named like a property, such as one just added, get that value in it
export function updateDatabase(
  id: PageId,
  change: (database: DatabaseDef) => DatabaseDef,
  addKeys: string[] = [],
): boolean {
  const current = databaseOf(id);
  if (!current) return false;
  const state = getState();
  const nextDatabase = change(current);
  const removed = current.properties.filter(
    (property) => !nextDatabase.properties.some((candidate) => candidate.id === property.id),
  );
  const adopted = adoptRows(nextDatabase, rowsOf(state, id), newId, addKeys);
  const rows = adopted.rows.map((row) => {
    const properties = { ...row.properties };
    const extra = { ...row.extra };
    for (const property of removed) {
      if (!Object.prototype.hasOwnProperty.call(properties, property.id)) continue;
      const value = writeProperty(property, properties[property.id] ?? null, state);
      if (value !== undefined) {
        let key = findKey(extra, property.name) ?? property.name;
        if (findKey(extra, property.name) !== undefined) key = `${property.name} (removed ${property.id})`;
        let suffix = 2;
        while (findKey(extra, key) !== undefined)
          key = `${property.name} (removed ${property.id} ${suffix++})`;
        extra[key] = value;
      }
      delete properties[property.id];
    }
    return { ...row, properties, extra };
  });
  const now = Date.now();
  const result = runAll([
    { type: 'database.set', id, database: adopted.database, now },
    ...rows.map((row): Command => ({
      type: 'page.setFields',
      id: row.id,
      properties: row.properties,
      extra: row.extra,
      now,
    })),
  ]);
  if (!result.ok) toast(result.error, { tone: 'error' });
  return result.ok;
}

// turns frontmatter keys the rows already have into columns, with a type that fits their values
export function addColumnsFromPages(id: PageId, keys: string[]): boolean {
  return updateDatabase(id, (database) => database, keys);
}

export function updateProp(dbId: PageId, propId: string, change: (prop: PropDef) => PropDef): boolean {
  return updateDatabase(dbId, (database) => ({
    ...database,
    properties: database.properties.map((prop) => (prop.id === propId ? change(prop) : prop)),
  }));
}

export function updateView(dbId: PageId, viewId: string, change: (view: ViewDef) => ViewDef): void {
  updateDatabase(dbId, (database) => ({
    ...database,
    views: database.views.map((view) => (view.id === viewId ? change(view) : view)),
  }));
}

export function deleteProperty(dbId: PageId, propertyId: string): boolean {
  const state = getState();
  const database = state.pages[dbId]?.database;
  const property = database?.properties.find((candidate) => candidate.id === propertyId);
  if (!database || !property) return false;

  const linkedUse = linkedViewReferences(state, dbId).find(
    (reference) => reference.view && viewUsesProperty(reference.view, propertyId),
  );
  if (linkedUse) {
    toast(
      t('database.columnUsedByLinkedView', { name: linkedUse.view?.name || t('database.linkedView') }),
      { tone: 'error' },
    );
    return false;
  }

  const relationUse = Object.values(state.pages)
    .flatMap((owner) => owner.database?.properties.map((candidate) => ({ owner, candidate })) ?? [])
    .find(
      ({ owner, candidate }) =>
        !(owner.id === dbId && candidate.id === propertyId) &&
        candidate.type === 'relation' &&
        candidate.relation?.targetDatabaseId === dbId &&
        candidate.relation.displayPropertyId === propertyId,
    )?.candidate;
  if (relationUse) {
    toast(
      t('database.columnUsedByRelationDisplay', { name: property.name, relation: relationUse.name }),
      { tone: 'error' },
    );
    return false;
  }

  const dependentFormula = Object.values(state.pages)
    .flatMap((owner) => owner.database?.properties.map((candidate) => ({ ownerId: owner.id, candidate })) ?? [])
    .find(
      ({ ownerId, candidate }) =>
        (ownerId !== dbId || candidate.id !== propertyId) &&
        [...(candidate.formulaBindings ?? []), ...(candidate.defaultFormulaBindings ?? [])].some(
          (binding) =>
            binding.kind === 'property' && binding.databaseId === dbId && binding.propertyId === propertyId,
        ),
    )?.candidate;
  if (dependentFormula) {
    toast(t('database.columnUsedByFormula', { name: dependentFormula.name }), { tone: 'error' });
    return false;
  }

  return updateDatabase(dbId, (current) => ({
    ...current,
    displayPropertyId: current.displayPropertyId === propertyId ? null : current.displayPropertyId,
    properties: current.properties.filter((item) => item.id !== propertyId),
    views: current.views.map((view) => removePropertyFromView(view, propertyId)),
  }));
}

export function setValue(rowId: PageId, propId: string, value: PropValue): boolean {
  const state = getState();
  const row = state.pages[rowId];
  const database = row?.parentId ? state.pages[row.parentId]?.database : undefined;
  const prop = database?.properties.find((candidate) => candidate.id === propId);
  if (prop?.type === 'relation') {
    return run({ type: 'relation.set', id: rowId, propertyId: propId, value, now: Date.now() }).ok;
  } else {
    return run({ type: 'page.setProperties', id: rowId, values: { [propId]: value }, now: Date.now() }).ok;
  }
}

// adds an option to a select property and returns it, or the existing one with that name
export function ensureOption(dbId: PageId, propId: string, name: string): SelectOption | null {
  const prop = databaseOf(dbId)?.properties.find((candidate) => candidate.id === propId);
  const clean = name.trim();
  if (!prop || !clean) return null;
  const existing = prop.options.find((option) => option.name.toLowerCase() === clean.toLowerCase());
  if (existing) return existing;
  const option = newOption(clean, prop.options.length, newId);
  updateProp(dbId, propId, (current) => ({ ...current, options: [...current.options, option] }));
  return option;
}

export function createRow(dbId: PageId, values: Record<string, PropValue> = {}, title = ''): PageId | null {
  const id = newId();
  const result = run({ type: 'page.create', id, parentId: dbId, now: Date.now(), title, properties: values });
  return result.ok ? id : null;
}

function removePropertyFromView(view: ViewDef, propertyId: string): ViewDef {
  const widths = { ...view.widths };
  const align = { ...view.align };
  const summaries = { ...view.summaries };
  delete widths[propertyId];
  delete align[propertyId];
  delete summaries[propertyId];
  return {
    ...view,
    filters: view.filters.filter((rule) => rule.prop !== propertyId),
    filterGroups: view.filterGroups
      ?.map((group) => ({ ...group, filters: group.filters.filter((rule) => rule.prop !== propertyId) }))
      .filter((group) => group.filters.length > 0),
    sorts: view.sorts.filter((sort) => sort.prop !== propertyId),
    hidden: view.hidden.filter((id) => id !== propertyId),
    groupBy: view.groupBy === propertyId ? null : view.groupBy,
    dateProp: view.dateProp === propertyId ? null : view.dateProp,
    widths,
    frozenThrough: view.frozenThrough === propertyId ? undefined : view.frozenThrough,
    order: view.order?.filter((id) => id !== propertyId),
    wrap: view.wrap?.filter((id) => id !== propertyId),
    align,
    summaries,
    conditionalFormats: view.conditionalFormats?.filter((rule) => rule.prop !== propertyId),
    cardProperties: view.cardProperties?.filter((id) => id !== propertyId),
    cardImageProp: view.cardImageProp === propertyId ? null : view.cardImageProp,
  };
}
