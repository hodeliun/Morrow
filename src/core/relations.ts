import { displayTitle } from './model';
import type { PageId, PageMeta, PropDef, PropValue, RelationConfig, WorkspaceState } from './model';
import { databaseRowLabel, filterOpsFor, matchesFilter, rowsOf, valueOf } from './database';
import { foldText } from './search';
import { isEffectivelyTrashed } from './tree';

export type RelationDiagnosticCode =
  | 'unconfigured'
  | 'target-database-missing'
  | 'target-outside-database'
  | 'target-trashed'
  | 'legacy-title'
  | 'legacy-ambiguous'
  | 'target-missing'
  | 'inverse-missing'
  | 'inverse-mismatch'
  | 'cardinality-mismatch'
  | 'invalid-filter'
  | 'unsupported-value';

export interface RelationDiagnostic {
  code: RelationDiagnosticCode;
  reference?: string;
  count?: number;
}

export interface RelationReference {
  page: PageMeta | null;
  label: string;
  diagnostic: RelationDiagnostic | null;
}

export function relationIds(value: PropValue): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))];
}

export function relationConfig(prop: PropDef): RelationConfig {
  return (
    prop.relation ?? {
      targetDatabaseId: null,
      multiple: false,
      isInverse: false,
      displayPropertyId: null,
      inversePropertyId: null,
      filters: [],
    }
  );
}

// Stable references for formulas and other core consumers. Legacy titles are intentionally excluded.
export function resolveRelationRows(state: WorkspaceState, prop: PropDef, value: PropValue): PageMeta[] {
  const targetDatabaseId = prop.relation?.targetDatabaseId;
  const targetDatabase = targetDatabaseId ? state.pages[targetDatabaseId] : undefined;
  if (targetDatabase?.kind !== 'database') return [];
  return relationIds(value)
    .map((id) => state.pages[id])
    .filter(
      (page): page is PageMeta =>
        Boolean(page) && page!.parentId === targetDatabaseId && !isEffectivelyTrashed(state.pages, page!.id),
    );
}

// Choices are scoped to one database and every saved option filter must match.
export function relationOptions(state: WorkspaceState, prop: PropDef, query = ''): PageMeta[] {
  const targetId = prop.relation?.targetDatabaseId;
  const database = targetId ? state.pages[targetId] : undefined;
  if (database?.kind !== 'database' || !database.database) return [];
  if (
    prop.relation?.filters.some(
      (rule) => !database.database!.properties.some((item) => item.id === rule.prop),
    )
  )
    return [];
  const wanted = foldText(query.trim());
  return rowsOf(state, targetId!).filter((row) => {
    if (!prop.relation!.filters.every((rule) => matchesFilter(row, rule, database.database!, state)))
      return false;
    if (!wanted) return true;
    const title = displayTitle(row);
    const label = relationDisplayLabel(state, prop, row);
    return foldText(`${title} ${label}`).includes(wanted);
  });
}

export function relationDisplayLabel(state: WorkspaceState, prop: PropDef, row: PageMeta): string {
  return databaseRowLabel(state, row, prop.relation?.displayPropertyId);
}

export function resolveRelationReference(
  state: WorkspaceState,
  prop: PropDef,
  token: string,
): RelationReference {
  const config = prop.relation;
  if (!config?.targetDatabaseId) {
    const direct = state.pages[token];
    if (direct) {
      return {
        page: direct,
        label: displayTitle(direct),
        diagnostic: { code: 'unconfigured', reference: token },
      };
    }
    const folded = foldText(token.trim());
    const candidates = Object.values(state.pages).filter((page) => foldText(displayTitle(page)) === folded);
    if (candidates.length === 1) {
      return {
        page: candidates[0]!,
        label: displayTitle(candidates[0]!),
        diagnostic: { code: 'unconfigured', reference: token },
      };
    }
    return {
      page: null,
      label: token,
      diagnostic:
        candidates.length > 1
          ? { code: 'legacy-ambiguous', reference: token, count: candidates.length }
          : token
            ? { code: 'target-missing', reference: token }
            : null,
    };
  }

  const targetId = config.targetDatabaseId;
  const targetDatabase = state.pages[targetId];
  if (targetDatabase?.kind !== 'database' || !targetDatabase.database) {
    return { page: null, label: token, diagnostic: { code: 'target-database-missing', reference: token } };
  }
  const direct = state.pages[token];
  if (direct) {
    if (direct.parentId !== targetId) {
      return { page: null, label: token, diagnostic: { code: 'target-outside-database', reference: token } };
    }
    if (isEffectivelyTrashed(state.pages, direct.id)) {
      return {
        page: direct,
        label: relationDisplayLabel(state, prop, direct),
        diagnostic: { code: 'target-trashed', reference: token },
      };
    }
    return { page: direct, label: relationDisplayLabel(state, prop, direct), diagnostic: null };
  }

  const folded = foldText(token.trim());
  const candidates = rowsOf(state, targetId).filter((page) => foldText(displayTitle(page)) === folded);
  if (candidates.length === 1) {
    return {
      page: candidates[0]!,
      label: relationDisplayLabel(state, prop, candidates[0]!),
      diagnostic: { code: 'legacy-title', reference: token },
    };
  }
  return {
    page: null,
    label: token,
    diagnostic:
      candidates.length > 1
        ? { code: 'legacy-ambiguous', reference: token, count: candidates.length }
        : { code: 'target-missing', reference: token },
  };
}

export function relationDiagnostics(
  state: WorkspaceState,
  row: PageMeta,
  prop: PropDef,
): RelationDiagnostic[] {
  const sourceDatabase = row.parentId ? state.pages[row.parentId] : undefined;
  const stored = valueOf(row, prop.id, sourceDatabase?.database ?? undefined, state);
  const tokens = relationIds(stored);
  const diagnostics: RelationDiagnostic[] = [];
  const add = (diagnostic: RelationDiagnostic | null) => {
    if (!diagnostic) return;
    if (!diagnostics.some((item) => item.code === diagnostic.code && item.reference === diagnostic.reference))
      diagnostics.push(diagnostic);
  };
  if (tokens.length > 0 && !prop.relation?.targetDatabaseId) add({ code: 'unconfigured' });
  if (prop.relation && !prop.relation.multiple && tokens.length > 1) add({ code: 'cardinality-mismatch' });
  if (
    !prop.relation?.isInverse &&
    Object.keys(row.extra).some((key) => key.toLocaleLowerCase() === prop.name.toLocaleLowerCase())
  )
    add({ code: 'unsupported-value' });
  if (
    prop.relation?.isInverse &&
    (relationIds(row.properties[prop.id] ?? null).length > 0 ||
      Object.keys(row.extra).some((key) => key.toLocaleLowerCase() === prop.name.toLocaleLowerCase()))
  )
    add({ code: 'inverse-mismatch' });
  for (const token of tokens) add(resolveRelationReference(state, prop, token).diagnostic);

  const targetDatabaseId = prop.relation?.targetDatabaseId;
  const targetDatabase = targetDatabaseId ? state.pages[targetDatabaseId] : undefined;
  if (targetDatabaseId && (targetDatabase?.kind !== 'database' || !targetDatabase.database)) {
    add({ code: 'target-database-missing' });
    return diagnostics;
  }
  if (
    targetDatabase?.database &&
    prop.relation?.filters.some(
      (rule) => !targetDatabase.database!.properties.some((candidate) => candidate.id === rule.prop),
    )
  )
    add({ code: 'invalid-filter' });
  if (!prop.relation?.inversePropertyId || sourceDatabase?.kind !== 'database' || !sourceDatabase.database) {
    return diagnostics;
  }
  const inverse = targetDatabase?.database?.properties.find(
    (item) => item.id === prop.relation!.inversePropertyId,
  );
  if (!inverse || inverse.type !== 'relation') {
    add({ code: 'inverse-missing' });
    return diagnostics;
  }
  const expectedIsInverse = !prop.relation.isInverse;
  if (
    !inverse.relation ||
    inverse.relation?.targetDatabaseId !== sourceDatabase.id ||
    inverse.relation.inversePropertyId !== prop.id ||
    inverse.relation.isInverse !== expectedIsInverse
  ) {
    add({ code: 'inverse-mismatch' });
  }
  if (!prop.relation.isInverse) {
    for (const target of resolveRelationRows(state, prop, stored)) {
      if (relationIds(target.properties[inverse.id] ?? null).length > 0)
        add({ code: 'inverse-mismatch', reference: target.id });
    }
  }
  return diagnostics;
}

export function relationFilterableProperties(prop: PropDef): boolean {
  return filterOpsFor(prop.type).length > 0;
}

export function relationTokenLabel(state: WorkspaceState, prop: PropDef, token: string): string {
  return resolveRelationReference(state, prop, token).label;
}

export function relatedRowsFromValue(
  state: WorkspaceState,
  prop: PropDef,
  value: PropValue,
): Array<{ id: PageId; label: string }> {
  return resolveRelationRows(state, prop, value).map((page) => ({
    id: page.id,
    label: relationDisplayLabel(state, prop, page),
  }));
}
