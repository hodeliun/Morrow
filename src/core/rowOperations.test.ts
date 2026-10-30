import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { valueOf } from './database';
import { emptyDoc, newPageMeta } from './model';
import type { DatabaseDef, PageMeta, PropDef, WorkspaceState } from './model';
import {
  planDuplicateRows,
  planInsertRow,
  planMoveRows,
  planPasteRows,
  planReorderRows,
  planTrashRows,
  suggestRowPropertyMappings,
} from './rowOperations';
import {
  createRowClipboardPayload,
  parseRowClipboardText,
  serializeRowClipboard,
  validateRowClipboardPayload,
} from './rowClipboard';

const relation = (targetDatabaseId: string, multiple = true): PropDef => ({
  id: 'relation',
  name: 'People',
  type: 'relation',
  options: [],
  relation: {
    targetDatabaseId,
    multiple,
    isInverse: false,
    displayPropertyId: null,
    inversePropertyId: null,
    filters: [],
  },
});

const sourceProperties: PropDef[] = [
  { id: 'source-name', name: 'Name', type: 'text', options: [] },
  { id: 'source-count', name: 'Count', type: 'number', options: [] },
  { id: 'source-active', name: 'Active', type: 'checkbox', options: [] },
  { id: 'source-hidden', name: 'Hidden note', type: 'text', options: [] },
  { id: 'source-null', name: 'Optional note', type: 'text', options: [] },
  { id: 'source-derived', name: 'Double count', type: 'formula', formula: 'Count * 2', options: [] },
  { ...relation('people'), id: 'source-people' },
];

const destinationProperties: PropDef[] = [
  { id: 'dest-active', name: 'Active', type: 'checkbox', options: [] },
  { id: 'dest-count', name: 'Count', type: 'currency', options: [] },
  { id: 'dest-name', name: 'Name', type: 'text', options: [] },
  {
    id: 'dest-null',
    name: 'Optional note',
    type: 'text',
    options: [],
    fillMode: 'default',
    defaultValue: 'Default note',
  },
  {
    id: 'dest-default',
    name: 'Destination only',
    type: 'text',
    options: [],
    fillMode: 'default',
    defaultValue: 'Default value',
  },
  { id: 'dest-derived', name: 'Double count', type: 'formula', formula: 'Count + 10', options: [] },
  { ...relation('people'), id: 'dest-people' },
];

function database(id: string, properties: PropDef[]): PageMeta {
  const definition: DatabaseDef = { properties, views: [] };
  return newPageMeta({ id, parentId: null, kind: 'database', title: id, database: definition });
}

function row(
  id: string,
  parentId: string,
  title: string,
  order: number,
  properties: Record<string, PageMeta['properties'][string]> = {},
  extra: Record<string, unknown> = {},
): PageMeta {
  return newPageMeta({ id, parentId, title, order, properties, extra });
}

function makeState(): WorkspaceState {
  const pages = [
    database('source-db', sourceProperties),
    database('destination-db', destinationProperties),
    database('people', []),
    row('person-one', 'people', 'Person One', 0),
    row(
      'row-one',
      'source-db',
      'Alpha',
      0,
      {
        'source-name': 'Alpha',
        'source-count': 0,
        'source-active': false,
        'source-hidden': 'hidden value',
        'source-null': null,
        'source-derived': 999,
        'source-people': ['person-one'],
      },
      { Frontmatter: 'kept' },
    ),
    row('row-two', 'source-db', 'Beta', 1, { 'source-count': 2 }),
    row('dest-row', 'destination-db', 'Existing destination row', 0),
  ];
  return {
    pages: Object.fromEntries(pages.map((page) => [page.id, page])),
    docs: {
      'row-one': {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body to copy' }] }],
      },
      'row-two': emptyDoc(),
      'dest-row': emptyDoc(),
    },
  };
}

function applyPlan(state: WorkspaceState, commands: Parameters<typeof applyCommand>[1][]) {
  let current = state;
  for (const command of commands) {
    const applied = applyCommand(current, command);
    if (!applied.ok) throw new Error(applied.error);
    current = applied.value.state;
  }
  return current;
}

describe('row clipboard and row operation plans', () => {
  it('serializes complete selected rows, including hidden properties and document content', () => {
    const state = makeState();
    const copied = createRowClipboardPayload(state, 'source-db', ['row-one']);
    expect(copied.ok).toBe(true);
    if (!copied.ok) return;
    const serialized = serializeRowClipboard(copied.value);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const parsed = parseRowClipboardText(serialized.value);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rows[0]?.page.properties).toMatchObject({
      'source-count': 0,
      'source-active': false,
      'source-hidden': 'hidden value',
    });
    expect(parsed.value.rows[0]?.page.extra).toEqual({ Frontmatter: 'kept' });
    expect(parsed.value.rows[0]?.page.archivedAt).toBeNull();
    expect(parsed.value.rows[0]?.doc.content?.[0]?.content?.[0]?.text).toBe('Body to copy');

    const windowsClipboardText = serialized.value.replace(/\n/g, '\r\n');
    const parsedWindowsClipboard = parseRowClipboardText(windowsClipboardText);
    expect(parsedWindowsClipboard.ok).toBe(true);
    if (parsedWindowsClipboard.ok) {
      expect(parsedWindowsClipboard.value.rows[0]?.page.properties['source-count']).toBe(0);
      expect(parsedWindowsClipboard.value.rows[0]?.page.properties['source-active']).toBe(false);
      expect(parsedWindowsClipboard.value.rows[0]?.doc.content?.[0]?.content?.[0]?.text).toBe('Body to copy');
    }
  });

  it('rejects malformed and oversized row clipboard payloads instead of partially importing them', () => {
    const malformed = parseRowClipboardText('morrow-row-clipboard:v1\n{"version":1,"kind":"wrong"}');
    expect(malformed.ok).toBe(false);
    const oversized = parseRowClipboardText(`morrow-row-clipboard:v1\n${'x'.repeat(1_000_001)}`);
    expect(oversized.ok).toBe(false);
    const malformedHeader = parseRowClipboardText(
      'morrow-row-clipboard:v1\r\r\n{"version":1,"kind":"wrong"}',
    );
    expect(malformedHeader.ok).toBe(false);
  });

  it('round trips archive timestamps and accepts legacy clipboard rows without archivedAt', () => {
    const payload = createRowClipboardPayload(makeState(), 'source-db', ['row-one']);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    const timestamp = 1_790_000_000_000;
    const current = structuredClone(payload.value);
    current.rows[0]!.page.archivedAt = timestamp;
    const serialized = serializeRowClipboard(current);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const parsed = parseRowClipboardText(serialized.value);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.rows[0]?.page.archivedAt).toBe(timestamp);

    const legacy = structuredClone(payload.value);
    delete (legacy.rows[0]!.page as Partial<PageMeta>).archivedAt;
    const validatedLegacy = validateRowClipboardPayload(legacy);
    expect(validatedLegacy.ok).toBe(true);
    if (validatedLegacy.ok) expect(validatedLegacy.value.rows[0]?.page.archivedAt).toBeNull();
  });

  it('rejects malformed archive timestamps, unknown row fields and future clipboard versions atomically', () => {
    const state = makeState();
    const payload = createRowClipboardPayload(state, 'source-db', ['row-one']);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;

    const malformedTimestamp = structuredClone(payload.value);
    malformedTimestamp.rows[0]!.page.archivedAt = { timestamp: 'later' } as never;
    const before = structuredClone(state);
    const rejectedPlan = planPasteRows(
      state,
      'destination-db',
      malformedTimestamp,
      {},
      () => 'unused-copy-id',
      61,
      '(copy)',
    );
    expect(rejectedPlan.ok).toBe(false);
    if (!rejectedPlan.ok) expect(rejectedPlan.error).toContain('archivedAt');
    expect(state).toEqual(before);

    const unknownField = structuredClone(payload.value);
    Object.assign(unknownField.rows[0]!.page, { unsupportedFutureField: true });
    const rejectedField = validateRowClipboardPayload(unknownField);
    expect(rejectedField.ok).toBe(false);
    if (!rejectedField.ok) expect(rejectedField.error).toContain('unsupported row fields');

    const futureVersion: unknown = { ...payload.value, version: 2 };
    expect(validateRowClipboardPayload(futureVersion).ok).toBe(false);
  });

  it('rejects invalid property values before normalization can silently drop them', () => {
    const state = makeState();
    const payload = createRowClipboardPayload(state, 'source-db', ['row-one']);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    const malformed = structuredClone(payload.value);
    malformed.rows[0]!.page.properties['source-count'] = { invalid: true } as never;
    const result = validateRowClipboardPayload(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid property value');
  });

  it('duplicates selected rows with new ids, preserves hidden fields and content, and recalculates formulas', () => {
    const state = makeState();
    const plan = planDuplicateRows(state, 'source-db', ['row-one'], () => 'row-copy', 50, '(copy)');
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = applyPlan(state, plan.value.commands);
    const copy = next.pages['row-copy'];
    expect(copy?.title).toBe('Alpha (copy)');
    expect(copy?.properties).toMatchObject({
      'source-name': 'Alpha',
      'source-count': 0,
      'source-active': false,
      'source-hidden': 'hidden value',
      'source-people': ['person-one'],
    });
    expect(copy?.properties).not.toHaveProperty('source-derived');
    expect(copy?.extra).toEqual({ Frontmatter: 'kept' });
    expect(next.docs['row-copy']?.content?.[0]?.content?.[0]?.text).toBe('Body to copy');
    expect(valueOf(copy!, 'source-derived', next.pages['source-db']?.database ?? undefined, next)).toBe(0);
  });

  it('maps copied values by property name and compatible type, preserving zero and false', () => {
    const state = makeState();
    const payload = createRowClipboardPayload(state, 'source-db', ['row-one']);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    const mappings = suggestRowPropertyMappings(
      payload.value.sourceProperties,
      state.pages['destination-db']!.database!,
      payload.value.rows,
    );
    expect(mappings).toMatchObject({
      'source-name': 'dest-name',
      'source-count': 'dest-count',
      'source-active': 'dest-active',
      'source-people': 'dest-people',
    });
    const plan = planPasteRows(
      state,
      'destination-db',
      payload.value,
      mappings,
      () => 'pasted-row',
      60,
      '(copy)',
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const next = applyPlan(state, plan.value.commands);
    const pasted = next.pages['pasted-row'];
    expect(pasted?.parentId).toBe('destination-db');
    expect(pasted?.properties).toMatchObject({
      'dest-name': 'Alpha',
      'dest-count': 0,
      'dest-active': false,
      'dest-people': ['person-one'],
      'dest-null': null,
      'dest-default': 'Default value',
    });
    expect(pasted?.properties).not.toHaveProperty('source-hidden');
    expect(pasted?.extra).toEqual({ Frontmatter: 'kept', 'Hidden note': 'hidden value' });
    expect(valueOf(pasted!, 'dest-derived', next.pages['destination-db']?.database ?? undefined, next)).toBe(
      10,
    );
  });

  it('keeps identity and valid relations when moving rows, and rejects a move that would break an incoming relation', () => {
    const state = makeState();
    const payload = createRowClipboardPayload(state, 'source-db', ['row-one']);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    const mappings = suggestRowPropertyMappings(
      payload.value.sourceProperties,
      state.pages['destination-db']!.database!,
      payload.value.rows,
    );
    const move = planMoveRows(state, 'source-db', 'destination-db', ['row-one'], mappings, 70);
    expect(move.ok, move.ok ? '' : move.error).toBe(true);
    if (!move.ok) return;
    const next = applyPlan(state, move.value.commands);
    expect(next.pages['row-one']?.parentId).toBe('destination-db');
    expect(next.pages['row-one']?.properties).toMatchObject({
      'dest-name': 'Alpha',
      'dest-count': 0,
      'dest-active': false,
      'dest-people': ['person-one'],
    });
    expect(next.pages['row-one']?.properties).not.toHaveProperty('source-name');
    expect(next.pages['row-one']?.extra).toEqual({ Frontmatter: 'kept', 'Hidden note': 'hidden value' });

    const incomingProp: PropDef = {
      ...relation('source-db', false),
      id: 'owner-row',
      name: 'Source row',
    };
    const ownerDb = database('owner-db', [incomingProp]);
    const ownerRow = row('owner-one', 'owner-db', 'Owner', 0, { 'owner-row': 'row-one' });
    const withOwner: WorkspaceState = {
      pages: { ...state.pages, 'owner-db': ownerDb, 'owner-one': ownerRow },
      docs: state.docs,
    };
    const blocked = planMoveRows(withOwner, 'source-db', 'destination-db', ['row-one'], mappings, 80);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain('invalidate');
  });

  it('allows a move when an unrelated row already contains a dangling relation', () => {
    const state = makeState();
    const withUnrelatedDanglingRelation: WorkspaceState = {
      ...state,
      pages: {
        ...state.pages,
        'row-two': {
          ...state.pages['row-two']!,
          properties: { ...state.pages['row-two']!.properties, 'source-people': ['missing-person'] },
        },
      },
    };
    const payload = createRowClipboardPayload(withUnrelatedDanglingRelation, 'source-db', ['row-one']);
    if (!payload.ok) throw new Error(payload.error);
    const mappings = suggestRowPropertyMappings(
      payload.value.sourceProperties,
      withUnrelatedDanglingRelation.pages['destination-db']!.database!,
      payload.value.rows,
    );
    const moved = planMoveRows(
      withUnrelatedDanglingRelation,
      'source-db',
      'destination-db',
      ['row-one'],
      mappings,
      75,
    );
    expect(moved.ok, moved.ok ? '' : moved.error).toBe(true);
  });

  it('requires a compatible destination for nonempty relations and does not drop incompatible fields', () => {
    const state = makeState();
    const payload = createRowClipboardPayload(state, 'source-db', ['row-one']);
    expect(payload.ok).toBe(true);
    if (!payload.ok) return;
    const destination = state.pages['destination-db']!.database!;
    const changedDestination: DatabaseDef = {
      ...destination,
      properties: destination.properties.map((prop) =>
        prop.id === 'dest-people'
          ? { ...prop, relation: { ...prop.relation!, targetDatabaseId: 'other-people' } }
          : prop,
      ),
    };
    const mappings = suggestRowPropertyMappings(
      payload.value.sourceProperties,
      changedDestination,
      payload.value.rows,
    );
    mappings['source-people'] = 'dest-people';
    const plan = planPasteRows(
      {
        ...state,
        pages: {
          ...state.pages,
          'destination-db': { ...state.pages['destination-db']!, database: changedDestination },
        },
      },
      'destination-db',
      payload.value,
      mappings,
      () => 'blocked-copy',
      90,
      '(copy)',
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toContain('different table');
  });

  it('reorders whole row selections in stable visible order and journals one plan', () => {
    const state = makeState();
    const plan = planReorderRows(state, 'source-db', ['row-two'], 'row-one', 'before');
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.ok).toBe(true);
    const next = applyPlan(state, plan.value.commands);
    expect(
      Object.values(next.pages)
        .filter((page) => page.parentId === 'source-db')
        .sort((a, b) => a.order - b.order)
        .map((page) => page.id),
    ).toEqual(['row-two', 'row-one']);
    expect(plan.value.records.map((record) => record.id)).toContain('row-one');
    expect(plan.value.records.map((record) => record.id)).toContain('row-two');
  });

  it('reorders multi-row selections down and up in their original order', () => {
    const state = makeState();
    const pages = {
      ...state.pages,
      'row-three': row('row-three', 'source-db', 'Three', 2),
      'row-four': row('row-four', 'source-db', 'Four', 3),
    };
    const expanded = { ...state, pages };
    const downward = planReorderRows(expanded, 'source-db', ['row-one', 'row-two'], 'row-four', 'after');
    expect(downward.ok).toBe(true);
    if (downward.ok) {
      expect(childrenOrder(applyPlan(expanded, downward.value.commands), 'source-db')).toEqual([
        'row-three',
        'row-four',
        'row-one',
        'row-two',
      ]);
    }
    const upward = planReorderRows(expanded, 'source-db', ['row-three', 'row-four'], 'row-one', 'before');
    expect(upward.ok).toBe(true);
    if (upward.ok) {
      expect(childrenOrder(applyPlan(expanded, upward.value.commands), 'source-db')).toEqual([
        'row-three',
        'row-four',
        'row-one',
        'row-two',
      ]);
    }
  });

  it('inserts before or after an anchor and trashes a batch through existing page commands', () => {
    const state = makeState();
    const inserted = planInsertRow(state, 'source-db', 'row-one', 'before', 'new-row', 100);
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const afterInsert = applyPlan(state, inserted.value.commands);
    expect(afterInsert.pages['new-row']?.order).toBe(0);
    expect(afterInsert.pages['row-one']?.order).toBe(1);
    const trash = planTrashRows(state, 'source-db', ['row-one', 'row-two'], 110);
    expect(trash.ok).toBe(true);
    if (trash.ok) {
      expect(trash.value.commands).toHaveLength(2);
      expect(trash.value.records).toHaveLength(2);
    }
  });
});

function childrenOrder(state: WorkspaceState, parentId: string): string[] {
  return Object.values(state.pages)
    .filter((page) => page.parentId === parentId)
    .sort((a, b) => a.order - b.order)
    .map((page) => page.id);
}
