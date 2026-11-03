import type { NamedControlDef, PageId } from '../../core/model';

export interface NamedControlEditSnapshot {
  pageId: PageId;
  controlId: string;
  mode: 'existing' | 'create';
  configurationSignature: string | null;
}

export type NamedControlEditConflict = 'target-changed' | 'removed' | 'already-exists' | 'configuration-changed';

export function namedControlConfigurationSignature(control: NamedControlDef): string {
  const format = Object.entries(control.format ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    control.id,
    control.name,
    control.type,
    control.textFormat ?? null,
    control.defaultValue,
    control.options.map(({ id, name, color }) => [id, name, color]),
    format,
    control.relation ? [control.relation.targetDatabaseId, control.relation.multiple] : null,
  ]);
}

export function captureNamedControlEdit(
  pageId: PageId,
  controlId: string,
  control: NamedControlDef | undefined,
): NamedControlEditSnapshot {
  const existing = control?.id === controlId ? control : undefined;
  return {
    pageId,
    controlId,
    mode: existing ? 'existing' : 'create',
    configurationSignature: existing ? namedControlConfigurationSignature(existing) : null,
  };
}

export function namedControlEditConflict(
  snapshot: NamedControlEditSnapshot | null,
  pageId: PageId,
  controlId: string,
  current: NamedControlDef | undefined,
): NamedControlEditConflict | null {
  if (!snapshot || snapshot.pageId !== pageId || snapshot.controlId !== controlId) return 'target-changed';
  if (snapshot.mode === 'existing') {
    if (!current) return 'removed';
    return namedControlConfigurationSignature(current) === snapshot.configurationSignature
      ? null
      : 'configuration-changed';
  }
  return current ? 'already-exists' : null;
}
