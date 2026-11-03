import { describe, expect, it } from 'vitest';
import type { NamedControlDef } from '../../core/model';
import { captureNamedControlEdit, namedControlEditConflict } from './controlEditGuard';

const control: NamedControlDef = {
  id: 'topic',
  name: 'Topic',
  type: 'text',
  value: 'live',
  defaultValue: '',
  options: [],
};

describe('named control edit guard', () => {
  it('rejects a removed control instead of treating its old draft as a create request', () => {
    const snapshot = captureNamedControlEdit('page', control.id, control);
    expect(namedControlEditConflict(snapshot, 'page', control.id, undefined)).toBe('removed');
  });

  it('rejects external configuration changes without comparing the live value', () => {
    const snapshot = captureNamedControlEdit('page', control.id, control);
    expect(namedControlEditConflict(snapshot, 'page', control.id, { ...control, name: 'Renamed elsewhere' }))
      .toBe('configuration-changed');
    expect(namedControlEditConflict(snapshot, 'page', control.id, { ...control, value: 'new live value' }))
      .toBeNull();
  });

  it('rejects an ID created elsewhere while the user was configuring a missing control', () => {
    const snapshot = captureNamedControlEdit('page', control.id, undefined);
    expect(snapshot.mode).toBe('create');
    expect(namedControlEditConflict(snapshot, 'page', control.id, control)).toBe('already-exists');
  });
});
