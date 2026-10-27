import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import { emptyWorkspace } from './model';
import type { DatabaseDef, PropDef, WorkspaceState } from './model';

function apply(state: WorkspaceState, command: Command): WorkspaceState {
  const result = applyCommand(state, command);
  if (!result.ok) throw new Error(result.error);
  return result.value.state;
}

function createDatabase(property: PropDef): WorkspaceState {
  const database: DatabaseDef = { properties: [property], views: [] };
  return apply(emptyWorkspace(), {
    type: 'page.create',
    id: 'numbers',
    parentId: null,
    now: 1,
    title: 'Numbers',
    kind: 'database',
    database,
  });
}

function sequenceProperty(overrides: Partial<PropDef> = {}): PropDef {
  return {
    id: 'number',
    name: 'Number',
    type: 'number',
    options: [],
    fillMode: 'default',
    defaultSequence: { start: 0, increment: 1 },
    ...overrides,
  };
}

function createRow(id: string, properties?: Record<string, number | null>): Command {
  return {
    type: 'page.create',
    id,
    parentId: 'numbers',
    now: 10,
    title: id,
    ...(properties ? { properties } : {}),
  };
}

describe('sequential numeric defaults', () => {
  it('assigns 0, 1, 2, keeps explicit values, and updates the database in the same command', () => {
    let state = createDatabase(sequenceProperty());
    state = apply(state, createRow('explicit', { number: 40 }));
    expect(state.pages.explicit!.properties.number).toBe(40);

    const first = applyCommand(state, createRow('first'));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect([...first.value.changes.pages].sort()).toEqual(['first', 'numbers']);
    state = first.value.state;
    state = apply(state, createRow('second'));
    state = apply(state, createRow('third'));

    expect([
      state.pages.first!.properties.number,
      state.pages.second!.properties.number,
      state.pages.third!.properties.number,
    ]).toEqual([0, 1, 2]);
    expect(state.pages.numbers!.database!.properties[0]!.sequenceNext).toBe(3);
  });

  it('starts after existing values when a sequence is enabled and leaves those rows unchanged', () => {
    const ordinary = sequenceProperty({ fillMode: undefined, defaultSequence: undefined });
    let state = createDatabase(ordinary);
    state = apply(state, createRow('existing-zero', { number: 0 }));
    state = apply(state, createRow('existing-one', { number: 1 }));
    const database = state.pages.numbers!.database!;
    state = apply(state, {
      type: 'database.set',
      id: 'numbers',
      now: 2,
      database: {
        ...database,
        properties: [sequenceProperty()],
      },
    });

    state = apply(state, createRow('new-row'));
    expect(state.pages['existing-zero']!.properties.number).toBe(0);
    expect(state.pages['existing-one']!.properties.number).toBe(1);
    expect(state.pages['new-row']!.properties.number).toBe(2);
  });

  it('does not rewind after undo or deletion', () => {
    let state = apply(createDatabase(sequenceProperty()), createRow('first'));
    state = apply(state, { type: 'page.trash', id: 'first', now: 11 });
    state = apply(state, { type: 'page.restore', id: 'first' });
    state = apply(state, createRow('second'));
    expect(state.pages.second!.properties.number).toBe(1);

    state = apply(state, { type: 'page.trash', id: 'first', now: 12 });
    state = apply(state, { type: 'page.deleteForever', id: 'first' });
    state = apply(state, createRow('third'));
    expect(state.pages.third!.properties.number).toBe(2);
  });

  it('rejects invalid increments and failed row creation without consuming a value', () => {
    let state = createDatabase(sequenceProperty({ format: { min: 1 } }));
    const invalid = applyCommand(state, {
      type: 'database.set',
      id: 'numbers',
      now: 2,
      database: {
        properties: [sequenceProperty({ defaultSequence: { start: 0, increment: 0 } })],
        views: [],
      },
    });
    expect(invalid.ok).toBe(false);
    expect(state.pages.numbers!.database!.properties[0]!.defaultSequence).toEqual({ start: 0, increment: 1 });

    const failedCreate = applyCommand(state, createRow('too-small'));
    expect(failedCreate.ok).toBe(false);
    expect(state.pages.numbers!.database!.properties[0]!.sequenceNext).toBeUndefined();
    expect(state.pages['too-small']).toBeUndefined();

    state = apply(state, {
      type: 'database.set',
      id: 'numbers',
      now: 3,
      database: {
        properties: [sequenceProperty({ format: { min: 0 } })],
        views: [],
      },
    });
    state = apply(state, createRow('first-valid'));
    expect(state.pages['first-valid']!.properties.number).toBe(0);
  });
});
