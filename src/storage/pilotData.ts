import { displayTitle } from '../core/model';
import type { DatabaseDef, PageId, PageMeta, PropDef, PropValue, WorkspaceState } from '../core/model';
import { isEffectivelyTrashed } from '../core/tree';
import { readProperty, reservedPropertyName, sameValue, writeProperty } from '../core/vault/pageFile';
import type { WorkspaceSession } from './session';
import type { DataApiSnapshot, DataApiDiagnostic } from '../app/plugins/dataApi';

/** Host storage adapter for the narrow Polaris Dados v1 snapshot and cell-patch contract. */
export interface PilotDataBackend {
  snapshot(databaseId: PageId): DataApiSnapshot;
  patchCell(input: {
    databaseId: PageId;
    rowId: PageId;
    propertyId: string;
    value: unknown;
    expectedRevision: string;
  }): { ok: true; revision: string } | { ok: false; code: string; message: string };
  history(input: {
    databaseId: PageId;
    direction: 'undo' | 'redo';
    expectedRevision: string;
  }):
    { ok: true; status: 'staged' | 'no-op'; revision: string } | { ok: false; code: string; message: string };
  flush(): Promise<boolean>;
}

export function createPilotDataBackend(session: WorkspaceSession): PilotDataBackend {
  return {
    snapshot: (databaseId) => snapshot(session, databaseId),
    patchCell: (input) => session.patchPilotDataCell(input),
    history: (input) => session.pilotDataHistoryChange(input),
    flush: () => session.flush(),
  };
}

function snapshot(session: WorkspaceSession, databaseId: PageId): DataApiSnapshot {
  const state = session.getState();
  const revision = session.pilotDataRevision(databaseId);
  const database = state.pages[databaseId];
  if (!database || !Object.hasOwn(database.extra, 'polarisDados')) {
    return freeze({ version: 1, status: 'missing', databaseId, revision });
  }

  const diagnostic = databaseDiagnostic(session, state, database);
  if (diagnostic) {
    return freeze({ version: 1, status: 'unsupported', databaseId, revision, diagnostic });
  }

  const rows = Object.values(state.pages)
    .filter((page) => page.parentId === database.id && !isEffectivelyTrashed(state.pages, page.id))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((page) => ({ id: page.id, title: displayTitle(page), properties: structuredClone(page.properties) }));
  const schema: DatabaseDef = structuredClone(database.database!);
  return freeze({
    version: 1,
    status: 'ready',
    databaseId,
    revision,
    schema,
    rows,
    history: session.pilotDataHistorySnapshot(databaseId),
    readonly: false,
    diagnostic: null,
  });
}

function databaseDiagnostic(
  session: WorkspaceSession,
  state: WorkspaceState,
  database: PageMeta,
): DataApiDiagnostic | null {
  if (database.kind !== 'database' || !database.database) {
    return {
      code: 'unsupported-database',
      message: 'The opted-in page does not have a database schema this host can represent.',
    };
  }
  if (isEffectivelyTrashed(state.pages, database.id)) {
    return { code: 'database-trashed', message: 'The opted-in database is in the trash.' };
  }
  const databaseReason = session.protectedReasons.get(database.id);
  if (session.unreadable.has(database.id) || databaseReason) {
    return {
      code: 'database-unreadable',
      message: databaseReason ?? 'The opted-in database is read only.',
    };
  }
  const propertyIds = new Set<string>();
  const propertyNames = new Set<string>();
  for (const property of database.database.properties) {
    const name = property.name.trim().toLowerCase();
    if (!name || reservedPropertyName(name) || propertyIds.has(property.id) || propertyNames.has(name)) {
      return {
        code: 'ambiguous-schema',
        message:
          'The database schema has duplicate, empty, or reserved property identifiers/names and is read only.',
      };
    }
    propertyIds.add(property.id);
    propertyNames.add(name);
  }
  const liveRows = Object.values(state.pages).filter(
    (page) => page.parentId === database.id && !isEffectivelyTrashed(state.pages, page.id),
  );
  const canvasRow = liveRows.find((row) => row.kind === 'canvas');
  if (canvasRow) {
    return {
      code: 'unrepresentable-cell',
      message: `Canvas row “${displayTitle(canvasRow)}” cannot be represented safely as a Polaris Dados row.`,
    };
  }
  for (const row of liveRows) {
    const leftover = Object.keys(row.extra).find((key) => propertyNames.has(key.toLowerCase()));
    if (leftover !== undefined) {
      return {
        code: 'unrepresentable-cell',
        message: `The value for database property “${leftover}” on row “${displayTitle(row)}” could not be represented safely.`,
      };
    }
    const unsupportedProperty = Object.entries(row.properties).find(([propertyId, value]) => {
      const property = database.database!.properties.find((candidate) => candidate.id === propertyId);
      return !property || !propertyValueRoundTrips(property, value);
    });
    if (unsupportedProperty) {
      return {
        code: 'unrepresentable-cell',
        message: `The value for database property “${unsupportedProperty[0]}” on row “${displayTitle(row)}” cannot be represented safely by the current schema.`,
      };
    }
  }
  const unreadableRow = Object.values(state.pages).find(
    (page) => page.parentId === database.id && !isEffectivelyTrashed(state.pages, page.id) &&
      (session.unreadable.has(page.id) || session.protectedReasons.has(page.id) || page.encrypted),
  );
  if (unreadableRow) {
    return {
      code: 'row-unreadable',
      message:
        session.protectedReasons.get(unreadableRow.id) ??
        `Row “${displayTitle(unreadableRow)}” is read only, so the complete database snapshot is unavailable.`,
    };
  }
  return null;
}

function propertyValueRoundTrips(property: PropDef, value: unknown): boolean {
  if (property.type === 'formula') return false;
  const serialized = writeProperty(property, value as PropValue | undefined, true);
  if (serialized === undefined) return false;
  const roundTrip = readProperty(property, serialized, () => '__polaris_unsupported_option__');
  return roundTrip.added.length === 0 && sameValue(roundTrip.value, value);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}
