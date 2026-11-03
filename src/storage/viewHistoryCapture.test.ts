import { describe, expect, it } from 'vitest';
import type { DatabaseDef, DocNode, PageId, ViewDef } from '../core/model';
import {
  linkedViewHostMatches,
  linkedViewConfigSnapshot,
  linkedViewConfigChange,
  primaryViewConfigSnapshot,
  primaryViewConfigChanges,
  replaceLinkedViewConfig,
  replacePrimaryViewConfig,
  viewConfigMatches,
  viewHistoryIdentityKey,
} from './viewHistoryCapture';

function view(id: string, changes: Partial<ViewDef> = {}): ViewDef {
  return {
    id,
    name: 'Table',
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
    ...changes,
  };
}

function database(views: ViewDef[], changes: Partial<DatabaseDef> = {}): DatabaseDef {
  return { properties: [], views, ...changes };
}

function linkedDoc(viewDef: ViewDef, changes: { text?: string; blockId?: string; rawState?: unknown } = {}): DocNode {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: changes.text ?? 'unchanged text' }] },
      {
        type: 'linkedDatabaseView',
        attrs: {
          hostPageId: 'host-page',
          sourceDatabaseId: 'source-db',
          blockId: changes.blockId ?? 'stable-block',
          view: viewDef,
          viewRawState: changes.rawState ?? { raw: { marker: 'preserve-me' } },
        },
      },
    ],
  };
}

describe('view history capture helpers', () => {
  it('accepts only a missing or exact linked host when the owner is known', () => {
    const host = 'host-page' as PageId;
    expect(linkedViewHostMatches({}, host)).toBe(true);
    expect(linkedViewHostMatches({ hostPageId: undefined }, host)).toBe(true);
    expect(linkedViewHostMatches({ hostPageId: host }, host)).toBe(true);
    for (const attrs of [undefined, null, { hostPageId: null }, { hostPageId: '' }, { hostPageId: 'foreign' }])
      expect(linkedViewHostMatches(attrs, host)).toBe(false);
    expect(linkedViewHostMatches({}, '' as PageId)).toBe(false);
  });

  it('uses unambiguous identity keys for database and linked views', () => {
    expect(viewHistoryIdentityKey({ kind: 'database', databaseId: 'a:b' as PageId, viewId: 'c' })).not.toBe(
      viewHistoryIdentityKey({ kind: 'database', databaseId: 'a' as PageId, viewId: 'b:c' }),
    );
    expect(viewHistoryIdentityKey({ kind: 'database', databaseId: 'host' as PageId, viewId: 'block' })).not.toBe(
      viewHistoryIdentityKey({ kind: 'linked', hostPageId: 'host' as PageId, blockId: 'block' }),
    );
    expect(viewHistoryIdentityKey({ kind: 'linked', hostPageId: 'host' as PageId, blockId: 'same' })).not.toBe(
      viewHistoryIdentityKey({ kind: 'linked', hostPageId: 'another-host' as PageId, blockId: 'same' }),
    );
  });

  it('captures only changed, existing primary views while keeping other views untouched', () => {
    const before = database([view('table-a'), view('list-b', { type: 'list' })]);
    const after = database([
      view('table-a', { filters: [{ prop: 'status', op: 'is', value: 'open' }] as ViewDef['filters'] }),
      view('list-b', { type: 'list', name: 'Renamed list' }),
    ]);

    const changes = primaryViewConfigChanges('database' as PageId, before, after);
    expect(changes).toHaveLength(2);
    expect(changes.map(({ identity }) => identity)).toEqual([
      { kind: 'database', databaseId: 'database', viewId: 'table-a' },
      { kind: 'database', databaseId: 'database', viewId: 'list-b' },
    ]);
    expect(changes[0]?.before.view.filters).toEqual([]);
    expect(changes[0]?.after.view.filters).toHaveLength(1);
  });

  it('ignores schema changes, added/deleted views, and ambiguous duplicate IDs', () => {
    const before = database([view('table-a')]);
    expect(primaryViewConfigChanges('database' as PageId, before, database([view('table-a', { name: 'Changed' })], {
      properties: [{ id: 'new-property', name: 'New', type: 'text', options: [] }],
    }))).toEqual([]);
    expect(primaryViewConfigChanges('database' as PageId, before, database([view('table-a', { name: 'Changed' }), view('new-view')]))).toEqual([]);
    expect(primaryViewConfigChanges('database' as PageId, before, database([view('table-a', { name: 'Changed' }), view('table-a')]))).toEqual([]);
    expect(primaryViewConfigChanges('database' as PageId, database([view('table-a'), view('new-view')]), database([view('table-a', { name: 'Changed' })]))).toEqual([]);
  });

  it('captures an isolated linked view change by host and block identity', () => {
    const beforeView = view('linked-view');
    const afterView = view('linked-view', { hidden: ['status'], name: 'Compact' });
    const change = linkedViewConfigChange('host-page' as PageId, 'stable-block', linkedDoc(beforeView), linkedDoc(afterView));

    expect(change).not.toBeNull();
    expect(change?.identity).toEqual({ kind: 'linked', hostPageId: 'host-page', blockId: 'stable-block' });
    expect(change?.before.view).toEqual(beforeView);
    expect(change?.after.view).toEqual(afterView);
    expect(change?.before.viewRawState).toEqual({ raw: { marker: 'preserve-me' } });
    expect(viewConfigMatches(change!.after, { view: afterView, viewRawState: change!.after.viewRawState })).toBe(true);
    expect(viewConfigMatches(change!.before, change!.after)).toBe(false);
    const current = linkedViewConfigSnapshot(linkedDoc(afterView), 'host-page' as PageId, 'stable-block');
    expect(current).toEqual(change?.after);
    const restored = replaceLinkedViewConfig(
      linkedDoc(afterView),
      'host-page' as PageId,
      'stable-block',
      change!.after,
      change!.before,
    );
    expect(linkedViewConfigSnapshot(restored!, 'host-page' as PageId, 'stable-block')).toEqual(change?.before);
  });

  it('captures legacy linked views with an omitted host without adding the host to stored attrs', () => {
    const before = linkedDoc(view('linked-view'));
    const after = linkedDoc(view('linked-view', { name: 'Legacy renamed' }));
    delete before.content![1]!.attrs!.hostPageId;
    delete after.content![1]!.attrs!.hostPageId;

    const change = linkedViewConfigChange('host-page' as PageId, 'stable-block', before, after);
    expect(change?.before.view.name).toBe('Table');
    expect(change?.after.view.name).toBe('Legacy renamed');
    expect(linkedViewConfigSnapshot(after, 'host-page' as PageId, 'stable-block')).toEqual(change?.after);

    const restored = replaceLinkedViewConfig(
      after,
      'host-page' as PageId,
      'stable-block',
      change!.after,
      change!.before,
    );
    expect(restored?.content?.[1]?.attrs?.hostPageId).toBeUndefined();
    expect(linkedViewConfigSnapshot(restored!, 'host-page' as PageId, 'stable-block')).toEqual(change?.before);
  });

  it('does not treat null, empty, or foreign linked hosts as a legacy omission', () => {
    for (const hostPageId of [null, '', 'another-host']) {
      const before = linkedDoc(view('linked-view'));
      const after = linkedDoc(view('linked-view', { name: 'Must not capture' }));
      before.content![1]!.attrs!.hostPageId = hostPageId;
      after.content![1]!.attrs!.hostPageId = hostPageId;
      expect(linkedViewConfigSnapshot(after, 'host-page' as PageId, 'stable-block')).toBeNull();
      expect(linkedViewConfigChange('host-page' as PageId, 'stable-block', before, after)).toBeNull();
    }
    const legacy = linkedDoc(view('linked-view'));
    delete legacy.content![1]!.attrs!.hostPageId;
    expect(linkedViewConfigSnapshot(legacy, '' as PageId, 'stable-block')).toBeNull();
    expect(linkedViewConfigChange('' as PageId, 'stable-block', legacy, linkedDoc(view('linked-view', { name: 'Changed' })))).toBeNull();
  });

  it('replaces a primary view only when its expected configuration still matches', () => {
    const before = view('table-a');
    const after = view('table-a', { sorts: [{ prop: 'score', dir: 'desc' }] });
    const databaseDef = database([after, view('other-view', { type: 'list' })]);
    const expected = primaryViewConfigSnapshot(databaseDef, 'table-a');
    expect(expected).toEqual({ view: after });
    const replaced = replacePrimaryViewConfig(databaseDef, 'table-a', expected!, { view: before });
    expect(replaced?.views).toEqual([before, view('other-view', { type: 'list' })]);
    expect(replacePrimaryViewConfig(databaseDef, 'table-a', { view: before }, { view: after })).toBeNull();
  });

  it('does not classify mixed text, structural, or ambiguous linked-node edits as view history', () => {
    const beforeView = view('linked-view');
    const changedView = view('linked-view', { name: 'Changed' });
    expect(
      linkedViewConfigChange(
        'host-page' as PageId,
        'stable-block',
        linkedDoc(beforeView),
        linkedDoc(changedView, { text: 'text changed too' }),
      ),
    ).toBeNull();
    expect(
      linkedViewConfigChange(
        'host-page' as PageId,
        'stable-block',
        linkedDoc(beforeView),
        linkedDoc(changedView, { blockId: 'different-block' }),
      ),
    ).toBeNull();
    const twoBlocks: DocNode = {
      type: 'doc',
      content: [linkedDoc(beforeView).content![1]!, linkedDoc(beforeView).content![1]!],
    };
    expect(linkedViewConfigChange('host-page' as PageId, 'stable-block', twoBlocks, twoBlocks)).toBeNull();
    expect(linkedViewConfigChange('host-page' as PageId, 'stable-block', linkedDoc(beforeView), linkedDoc(beforeView))).toBeNull();
  });
});
