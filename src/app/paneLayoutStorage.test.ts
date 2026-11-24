import { describe, expect, it } from 'vitest';
import { migrateLegacySplit, visiblePaneLeaves } from './paneLayout';
import type { PaneLayout, PaneNode, PaneTabInstance } from './paneLayout';
import {
  MAX_PERSISTED_TABS_CHARS,
  PANE_TABS_STORAGE_KEY,
  persistPaneTabsSnapshot,
  persistPaneTabsSnapshotAfterLegacyEquivalence,
  readPaneTabsSnapshot,
  writePaneTabsSnapshot,
} from './paneLayoutStorage';

function forkSnapshot(): string {
  const tabs = [
    {
      id: 'group-a',
      groupId: 'group-a',
      target: '#/page/a-main',
      back: ['#/page/a-main-before'],
      forward: ['#/page/a-main-after'],
      pinned: true,
    },
    {
      id: 'group-a:side',
      groupId: 'group-a',
      target: '#/page/a-side',
      back: ['#/page/a-side-before'],
      forward: [],
      pinned: true,
    },
    {
      id: 'group-b',
      groupId: 'group-b',
      target: '#/page/b-main',
      back: ['#/page/b-main-before'],
      forward: ['#/page/b-main-after'],
    },
    {
      id: 'group-b:side',
      groupId: 'group-b',
      target: '#/page/b-side',
      back: ['#/page/b-side-before'],
      forward: [],
    },
  ];
  return JSON.stringify({
    schemaVersion: 2,
    paneLayout: {
      version: 1,
      id: 'electron-layout',
      root: {
        kind: 'split',
        id: 'root',
        axis: 'columns',
        ratio: 0.63,
        first: {
          kind: 'split',
          id: 'left',
          axis: 'rows',
          ratio: 0.47,
          first: { kind: 'leaf', id: 'a-main', tabId: 'group-a' },
          second: { kind: 'leaf', id: 'a-side', tabId: 'group-a:side' },
        },
        second: {
          kind: 'split',
          id: 'right',
          axis: 'rows',
          ratio: 0.52,
          first: { kind: 'leaf', id: 'b-main', tabId: 'group-b' },
          second: { kind: 'leaf', id: 'b-side', tabId: 'group-b:side' },
        },
      },
      focusedPaneId: 'b-side',
    },
    tabs,
    closed: ['#/page/closed-one', '#/page/closed-two'],
  });
}

function layoutWithInstances(
  count: number,
  groupCount = 20,
): PaneLayout<PaneTabInstance<string>> {
  const tabs = Array.from({ length: count }, (_, index) => {
    const group = index % groupCount;
    return {
      id: `instance-${index}`,
      groupId: `group-${group}`,
      target: `#/page/target-${index}`,
      back: [`#/page/back-${index}`],
      forward: [`#/page/forward-${index}`],
      ...(index % 2 === 0 ? { pinned: true } : {}),
    };
  });
  return {
    id: 'writer-layout',
    root: {
      kind: 'split',
      id: 'root',
      axis: 'columns',
      ratio: 0.63,
      first: {
        kind: 'split',
        id: 'left',
        axis: 'rows',
        ratio: 0.47,
        first: { kind: 'leaf', id: 'pane-1', tabId: 'instance-0' },
        second: { kind: 'leaf', id: 'pane-2', tabId: null },
      },
      second: {
        kind: 'split',
        id: 'right',
        axis: 'rows',
        ratio: 0.52,
        first: { kind: 'leaf', id: 'pane-3', tabId: null },
        second: { kind: 'leaf', id: 'pane-4', tabId: null },
      },
    },
    focusedPaneId: 'pane-4',
    topologyRevision: 37,
    tabs,
  };
}

function memoryStorage(initial: string | null, failRead = false, failWrite = false) {
  let raw = initial;
  const writes: string[] = [];
  return {
    writes,
    get raw() {
      return raw;
    },
    storage: {
      getItem(key: string) {
        if (key !== PANE_TABS_STORAGE_KEY) throw new Error('Unexpected storage key.');
        if (failRead) throw new Error('Read failed.');
        return raw;
      },
      setItem(key: string, value: string) {
        if (key !== PANE_TABS_STORAGE_KEY) throw new Error('Unexpected storage key.');
        if (failWrite) throw new Error('Write failed.');
        raw = value;
        writes.push(value);
      },
    },
  };
}

describe('published pane snapshot reader', () => {
  it('reads an unsplit Morrow 2.2 window without inventing a side pane', () => {
    const result = readPaneTabsSnapshot(
      JSON.stringify({
        tabs: [{ id: 'base-single', hash: '#/tasks', back: [], forward: [], side: null }],
        active: 'base-single',
        pane: 'main',
        closed: [],
      }),
    );

    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;
    expect(result.snapshot.tabs[0]?.side).toBeNull();
    expect(result.snapshot.pane).toBe('main');
  });

  it('reads the Morrow 2.2 unversioned snapshot with and without a split', () => {
    const raw = JSON.stringify({
      tabs: [
        {
          id: 'base-main',
          hash: '#/page/base-main',
          back: ['#/page/base-before'],
          forward: [],
          side: {
            hash: '#/page/base-side',
            back: ['#/page/side-before'],
            forward: ['#/page/side-after'],
          },
          pinned: true,
        },
        { id: 'base-single', hash: '#/tasks', back: [], forward: [], side: null },
      ],
      active: 'base-main',
      pane: 'side',
      closed: ['#/page/closed'],
    });

    const result = readPaneTabsSnapshot(raw);

    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;
    expect(result.snapshot).toEqual({
      tabs: [
        {
          id: 'base-main',
          hash: '#/page/base-main',
          back: ['#/page/base-before'],
          forward: [],
          side: {
            hash: '#/page/base-side',
            back: ['#/page/side-before'],
            forward: ['#/page/side-after'],
          },
          pinned: true,
        },
        { id: 'base-single', hash: '#/tasks', back: [], forward: [], side: null },
      ],
      active: 'base-main',
      pane: 'side',
      closed: ['#/page/closed'],
    });
  });

  it('keeps long 2.2 targets and histories beyond the v2 payload and target limits', () => {
    const target = `#/page/${'target'.repeat(1_500)}`;
    const back = Array.from({ length: 50 }, (_, index) => `#/page/${index}-${'history'.repeat(3_200)}`);
    const raw = JSON.stringify({
      tabs: [{ id: 'base-large', hash: target, back, forward: [], side: null }],
      active: 'base-large',
      pane: 'main',
      closed: [],
    });

    expect(target.length).toBeGreaterThan(8192);
    expect(raw.length).toBeGreaterThan(MAX_PERSISTED_TABS_CHARS);
    const result = readPaneTabsSnapshot(raw);

    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;
    expect(result.snapshot.tabs[0]?.hash).toBe(target);
    expect(result.snapshot.tabs[0]?.back).toEqual(back);
  });

  it('uses splitShare only to seed a migrated tree from a 2.2 split', () => {
    const result = readPaneTabsSnapshot(
      JSON.stringify({
        tabs: [
          {
            id: 'base-main',
            hash: '#/page/main',
            back: [],
            forward: [],
            side: { hash: '#/page/side', back: [], forward: [] },
          },
        ],
        active: 'base-main',
        pane: 'side',
        closed: [],
      }),
    );
    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;

    const layout = migrateLegacySplit('migration-layout', result.snapshot, 0.63);
    const leaves = visiblePaneLeaves(layout);
    expect(layout.root).toMatchObject({ kind: 'split', ratio: 0.63 });
    expect(layout.focusedPaneId).toBe(leaves[1]?.id);
    expect(layout.tabs).toHaveLength(2);
  });

  it('reads the complete latest-fork v2 snapshot without normalizing its targets', () => {
    const result = readPaneTabsSnapshot(forkSnapshot());

    expect(result.kind).toBe('current');
    if (result.kind !== 'current') return;
    expect(result.snapshot.layout.root).toMatchObject({ kind: 'split', ratio: 0.63 });
    expect(result.snapshot.layout.focusedPaneId).toBe('b-side');
    expect(result.snapshot.layout.tabs).toHaveLength(4);
    expect(result.snapshot.layout.tabs[1]).toMatchObject({
      id: 'group-a:side',
      groupId: 'group-a',
      target: '#/page/a-side',
      back: ['#/page/a-side-before'],
    });
    expect(result.snapshot.layout.tabs[3]?.forward).toEqual([]);
    expect(result.snapshot.closed).toEqual(['#/page/closed-one', '#/page/closed-two']);
  });

  it('reads the latest-fork two-pane form with its focused side and proportion', () => {
    const result = readPaneTabsSnapshot(
      JSON.stringify({
        schemaVersion: 2,
        paneLayout: {
          version: 1,
          id: 'two-pane-layout',
          root: {
            kind: 'split',
            id: 'two-pane-root',
            axis: 'columns',
            ratio: 0.61,
            first: { kind: 'leaf', id: 'main-pane', tabId: 'two-pane-tab' },
            second: { kind: 'leaf', id: 'side-pane', tabId: 'two-pane-tab:side' },
          },
          focusedPaneId: 'side-pane',
        },
        tabs: [
          {
            id: 'two-pane-tab',
            groupId: 'two-pane-tab',
            target: '#/page/main',
            back: ['#/page/main-before'],
            forward: [],
          },
          {
            id: 'two-pane-tab:side',
            groupId: 'two-pane-tab',
            target: '#/page/side',
            back: ['#/page/side-before'],
            forward: ['#/page/side-after'],
          },
        ],
        closed: ['#/page/closed'],
      }),
    );

    expect(result.kind).toBe('current');
    if (result.kind !== 'current') return;
    expect(result.snapshot.layout.root).toMatchObject({ kind: 'split', ratio: 0.61 });
    expect(result.snapshot.layout.tabs[1]).toMatchObject({
      id: 'two-pane-tab:side',
      target: '#/page/side',
      back: ['#/page/side-before'],
      forward: ['#/page/side-after'],
    });
    expect(result.snapshot.layout.focusedPaneId).toBe('side-pane');
  });

  it('recognizes future and malformed bytes without turning them into a legacy session', () => {
    const future = '{"schemaVersion":3,"tabs":[{"unknown":"kept"}]}';
    expect(readPaneTabsSnapshot(future)).toEqual({ kind: 'future', version: 3 });
    expect(
      readPaneTabsSnapshot(JSON.stringify({ schemaVersion: 1, paneLayout: { version: 1, opaque: true } })),
    ).toEqual({ kind: 'future', version: 1 });
    expect(readPaneTabsSnapshot('{malformed')).toEqual({ kind: 'invalid', reason: 'malformed-json' });
    expect(
      readPaneTabsSnapshot(
        JSON.stringify({
          tabs: [{ id: 'legacy', hash: '#/page/a', back: [], forward: [], side: null, futureField: true }],
          active: 'legacy',
          pane: 'main',
          closed: [],
        }),
      ).kind,
    ).toBe('invalid');
  });
});

describe('published pane snapshot writer', () => {
  it.each([21, 40])(
    'roundtrips all %i registered instances with complete layout state and no runtime revision',
    (instanceCount) => {
      const layout = layoutWithInstances(instanceCount);
      const closed = ['#/page/closed-a', '#/page/closed-b'];
      const raw = writePaneTabsSnapshot(layout, closed);
      const result = readPaneTabsSnapshot(raw);

      expect(new Set(layout.tabs.map((tab) => tab.groupId)).size).toBe(20);
      expect(result.kind).toBe('current');
      if (result.kind !== 'current') return;
      expect(result.snapshot.layout).toEqual({ ...layout, topologyRevision: 0 });
      expect(result.snapshot.closed).toEqual(closed);

      const wire = JSON.parse(raw) as Record<string, unknown>;
      expect(wire.schemaVersion).toBe(2);
      expect(wire.tabs).toEqual(layout.tabs);
      expect(wire.closed).toEqual(closed);
      expect(wire.paneLayout).toMatchObject({
        version: 1,
        id: layout.id,
        root: layout.root,
        focusedPaneId: layout.focusedPaneId,
      });
      expect(wire.paneLayout).not.toHaveProperty('topologyRevision');
    },
  );

  it('rejects a layout that exceeds the published 20-group cap even if its instance count fits', () => {
    expect(() => writePaneTabsSnapshot(layoutWithInstances(21, 21), [])).toThrow(
      'published limits',
    );
  });

  it.each([
    [
      'a 32-level shared-split DAG',
      () => {
        let node: unknown = { kind: 'leaf', id: 'deep-leaf', tabId: null };
        for (let index = 0; index < 32; index += 1) {
          node = {
            kind: 'split',
            id: `deep-split-${index}`,
            axis: 'columns',
            ratio: 0.5,
            first: node,
            second: node,
          };
        }
        return node as PaneNode;
      },
    ],
    [
      'a cyclic pane tree',
      () => {
        const node: {
          kind: 'split';
          id: string;
          axis: 'columns';
          ratio: number;
          first: unknown;
          second: unknown;
        } = {
          kind: 'split',
          id: 'cyclic-split',
          axis: 'columns',
          ratio: 0.5,
          first: null,
          second: { kind: 'leaf', id: 'cycle-leaf', tabId: null },
        };
        node.first = node;
        return node as unknown as PaneNode;
      },
    ],
    [
      'a nine-node tree within the depth limit',
      () => {
        const root = layoutWithInstances(1, 1).root;
        if (root.kind !== 'split' || root.first.kind !== 'split')
          throw new Error('The node-budget fixture needs nested splits.');
        const oversizedTree: PaneNode = {
          ...root,
          first: {
            ...root.first,
            first: {
              kind: 'split',
              id: 'budget-split',
              axis: 'columns',
              ratio: 0.5,
              first: { kind: 'leaf', id: 'budget-leaf-a', tabId: null },
              second: { kind: 'leaf', id: 'budget-leaf-b', tabId: null },
            },
          },
        };
        return oversizedTree;
      },
    ],
  ] as const)('rejects %s before traversing without bounds', (_name, makeRoot) => {
    const layout = { ...layoutWithInstances(1, 1), root: makeRoot() };
    const storage = memoryStorage(null);

    expect(persistPaneTabsSnapshot(storage.storage, layout, [], null)).toEqual({
      kind: 'protected',
      reason: 'invalid-candidate',
    });
    expect(storage.raw).toBeNull();
    expect(storage.writes).toEqual([]);
  });

  it('rejects candidate fields or values that the published reader would discard', () => {
    const layout = layoutWithInstances(2, 1);
    const withUnknownTabField = {
      ...layout,
      tabs: layout.tabs.map((tab, index) =>
        index === 0 ? { ...tab, futureField: 'keep me' } : tab,
      ),
    } as unknown as PaneLayout<PaneTabInstance<string>>;
    const withFalsePin = {
      ...layout,
      tabs: layout.tabs.map((tab, index) => (index === 0 ? { ...tab, pinned: false } : tab)),
    };
    const withTooMuchHistory = {
      ...layout,
      tabs: layout.tabs.map((tab, index) =>
        index === 0 ? { ...tab, back: Array.from({ length: 51 }, (_, item) => `#/page/${item}`) } : tab,
      ),
    };
    const splitRoot = layout.root;
    if (splitRoot.kind !== 'split') throw new Error('The writer fixture needs a split root.');

    expect(() => writePaneTabsSnapshot(withUnknownTabField, [])).toThrow('Invalid pane tabs');
    expect(() => writePaneTabsSnapshot(withFalsePin, [])).toThrow('losslessly readable');
    expect(() => writePaneTabsSnapshot(withTooMuchHistory, [])).toThrow('losslessly readable');
    expect(() => writePaneTabsSnapshot({ ...layout, root: { ...splitRoot, ratio: 0.9 } }, [])).toThrow();
  });

  it('writes the full snapshot into empty storage and reports a byte-identical no-op', () => {
    const layout = layoutWithInstances(21);
    const closed = ['#/page/closed'];
    const emptyStorage = memoryStorage(null);

    const first = persistPaneTabsSnapshot(emptyStorage.storage, layout, closed, null);
    expect(first).toEqual({ kind: 'written', raw: writePaneTabsSnapshot(layout, closed) });
    expect(emptyStorage.raw).toBe(first.kind === 'written' ? first.raw : null);
    expect(emptyStorage.writes).toHaveLength(1);

    const second = persistPaneTabsSnapshot(emptyStorage.storage, layout, closed, emptyStorage.raw);
    expect(second).toEqual({ kind: 'unchanged', raw: emptyStorage.raw });
    expect(emptyStorage.writes).toHaveLength(1);
  });

  it('keeps the current v2 source until the exact observed bytes still match before writing', () => {
    const initial = layoutWithInstances(4, 2);
    const candidate = {
      ...initial,
      topologyRevision: initial.topologyRevision + 1,
      tabs: initial.tabs.map((tab, index) =>
        index === 0 ? { ...tab, target: '#/page/updated' } : tab,
      ),
    };
    const sourceRaw = writePaneTabsSnapshot(initial, []);
    const storage = memoryStorage(sourceRaw);
    const result = persistPaneTabsSnapshot(storage.storage, candidate, ['#/page/closed'], sourceRaw);

    expect(result.kind).toBe('written');
    expect(readPaneTabsSnapshot(storage.raw).kind).toBe('current');
    expect(storage.writes).toHaveLength(1);

    const changedExternally = `${sourceRaw} `;
    const conflictedStorage = memoryStorage(changedExternally);
    const conflict = persistPaneTabsSnapshot(
      conflictedStorage.storage,
      candidate,
      ['#/page/closed'],
      sourceRaw,
    );
    expect(conflict).toEqual({ kind: 'conflict' });
    expect(conflictedStorage.raw).toBe(changedExternally);
    expect(conflictedStorage.writes).toEqual([]);
  });

  it.each([
    ['an unknown v2 field', (raw: string) => {
      const root = JSON.parse(raw) as Record<string, unknown>;
      (root.paneLayout as Record<string, unknown>).futureField = { keep: true };
      return JSON.stringify(root);
    }],
    ['a false pin the reader drops', (raw: string) => {
      const root = JSON.parse(raw) as { tabs: Array<Record<string, unknown>> };
      root.tabs[0]!.pinned = false;
      return JSON.stringify(root);
    }],
    ['more than 20 groups', (raw: string) => {
      const root = JSON.parse(raw) as { tabs: Array<Record<string, unknown>> };
      root.tabs[20]!.groupId = 'extra-group';
      return JSON.stringify(root);
    }],
  ] as const)('protects observed bytes containing %s', (_description, alter) => {
    const sourceRaw = alter(writePaneTabsSnapshot(layoutWithInstances(21), []));
    expect(readPaneTabsSnapshot(sourceRaw).kind).toBe('current');
    const storage = memoryStorage(sourceRaw);
    const result = persistPaneTabsSnapshot(
      storage.storage,
      layoutWithInstances(21),
      [],
      sourceRaw,
    );

    expect(result).toEqual({ kind: 'protected', reason: 'source-not-lossless' });
    expect(storage.raw).toBe(sourceRaw);
    expect(storage.writes).toEqual([]);
  });

  it('never overwrites a valid v0 source with complete histories and closed entries', () => {
    const legacyRaw = JSON.stringify({
      tabs: [
        {
          id: 'legacy',
          hash: '#/page/legacy',
          back: ['#/page/previous'],
          forward: ['#/page/next'],
          side: {
            hash: '#/page/side',
            back: ['#/page/side-previous'],
            forward: ['#/page/side-next'],
          },
          pinned: true,
        },
        { id: 'second', hash: '#/page/second', back: [], forward: [], side: null },
      ],
      active: 'legacy',
      pane: 'side',
      closed: ['#/page/closed'],
    });
    expect(readPaneTabsSnapshot(legacyRaw).kind).toBe('legacy');
    const storage = memoryStorage(legacyRaw);
    const layout = layoutWithInstances(1, 1);

    expect(persistPaneTabsSnapshot(storage.storage, layout, [], legacyRaw)).toEqual({
      kind: 'protected',
      reason: 'legacy-source',
    });
    expect(storage.raw).toBe(legacyRaw);
    expect(storage.writes).toEqual([]);
  });

  it('migrates v0 only when a complete baseline roundtrips to the observed legacy snapshot', () => {
    const legacyRaw = JSON.stringify({
      tabs: [
        {
          id: 'legacy',
          hash: '#/page/legacy',
          back: ['#/page/legacy-before'],
          forward: ['#/page/legacy-after'],
          side: {
            hash: '#/page/side',
            back: ['#/page/side-before'],
            forward: ['#/page/side-after'],
          },
          pinned: true,
        },
        { id: 'second', hash: '#/page/second', back: [], forward: [], side: null },
      ],
      active: 'legacy',
      pane: 'side',
      closed: ['#/page/closed'],
    });
    const observed = readPaneTabsSnapshot(legacyRaw);
    if (observed.kind !== 'legacy') throw new Error('The fixture must be a valid v0 snapshot.');
    const baseline = observed.snapshot;
    const baselineLayout = migrateLegacySplit('legacy-migration', baseline, 0.5);
    const changedLayout = {
      ...baselineLayout,
      tabs: baselineLayout.tabs.map((tab) =>
        tab.id === 'legacy:side' ? { ...tab, target: '#/page/side-updated' } : tab,
      ),
    };
    const storage = memoryStorage(legacyRaw);

    const result = persistPaneTabsSnapshotAfterLegacyEquivalence(
      storage.storage,
      changedLayout,
      baseline.closed,
      legacyRaw,
      baseline,
    );

    expect(result.kind).toBe('written');
    const written = readPaneTabsSnapshot(storage.raw);
    expect(written.kind).toBe('current');
    if (written.kind !== 'current') return;
    expect(written.snapshot.layout.tabs).toMatchObject([
      { id: 'legacy', target: '#/page/legacy', back: ['#/page/legacy-before'], forward: ['#/page/legacy-after'], pinned: true },
      { id: 'legacy:side', target: '#/page/side-updated', back: ['#/page/side-before'], forward: ['#/page/side-after'] },
      { id: 'second', target: '#/page/second' },
    ]);
    expect(written.snapshot.closed).toEqual(['#/page/closed']);
    expect(storage.writes).toHaveLength(1);
  });

  it('refuses v0 migration if the baseline omits history or if the exact source bytes changed', () => {
    const legacyRaw = JSON.stringify({
      tabs: [{ id: 'legacy', hash: '#/page/legacy', back: ['#/page/before'], forward: [], side: null }],
      active: 'legacy',
      pane: 'main',
      closed: ['#/page/closed'],
    });
    const observed = readPaneTabsSnapshot(legacyRaw);
    if (observed.kind !== 'legacy') throw new Error('The fixture must be a valid v0 snapshot.');
    const layout = migrateLegacySplit('legacy-migration', observed.snapshot, 0.5);
    const incompleteBaseline = {
      ...observed.snapshot,
      tabs: observed.snapshot.tabs.map((tab) => ({ ...tab, back: [] })),
    };
    const baselineStorage = memoryStorage(legacyRaw);

    expect(
      persistPaneTabsSnapshotAfterLegacyEquivalence(
        baselineStorage.storage,
        layout,
        observed.snapshot.closed,
        legacyRaw,
        incompleteBaseline,
      ),
    ).toEqual({ kind: 'protected', reason: 'source-not-lossless' });
    expect(baselineStorage.raw).toBe(legacyRaw);
    expect(baselineStorage.writes).toEqual([]);

    const changedRaw = `${legacyRaw} `;
    const conflictStorage = memoryStorage(changedRaw);
    expect(
      persistPaneTabsSnapshotAfterLegacyEquivalence(
        conflictStorage.storage,
        layout,
        observed.snapshot.closed,
        legacyRaw,
        observed.snapshot,
      ),
    ).toEqual({ kind: 'conflict' });
    expect(conflictStorage.raw).toBe(changedRaw);
    expect(conflictStorage.writes).toEqual([]);
  });

  it('refuses legacy fields the v2 reader cannot preserve', () => {
    const legacyRaw = JSON.stringify({
      tabs: [{ id: 'legacy', hash: '#/page/legacy', back: ['#/page/before'], forward: [], pinned: false }],
      active: 'legacy',
      pane: 'main',
      closed: [],
    });
    const observed = readPaneTabsSnapshot(legacyRaw);
    if (observed.kind !== 'legacy') throw new Error('The fixture must be a valid v0 snapshot.');
    const layout = migrateLegacySplit('legacy-migration', observed.snapshot, 0.5);
    const storage = memoryStorage(legacyRaw);

    expect(
      persistPaneTabsSnapshotAfterLegacyEquivalence(
        storage.storage,
        layout,
        observed.snapshot.closed,
        legacyRaw,
        observed.snapshot,
      ),
    ).toEqual({ kind: 'protected', reason: 'source-not-lossless' });
    expect(storage.raw).toBe(legacyRaw);
    expect(storage.writes).toEqual([]);
  });

  it.each([
    [
      'top-level keys',
      (raw: string) => raw.replace('"schemaVersion":2', '"schemaVersion":2,"schema\\u0056ersion":2'),
    ],
    [
      'nested layout keys',
      (raw: string) => raw.replace('"ratio":0.63', '"ratio":0.63,"ra\\u0074io":0.63'),
    ],
  ] as const)('protects duplicate decoded %s before the writer parse loses one', (_where, addDuplicate) => {
    const canonical = writePaneTabsSnapshot(layoutWithInstances(2, 1), []);
    const sourceRaw = addDuplicate(canonical);
    expect(sourceRaw).not.toBe(canonical);
    expect(() => JSON.parse(sourceRaw)).not.toThrow();
    expect(readPaneTabsSnapshot(sourceRaw).kind).toBe('current');

    const storage = memoryStorage(sourceRaw);
    expect(
      persistPaneTabsSnapshot(storage.storage, layoutWithInstances(2, 1), [], sourceRaw),
    ).toEqual({ kind: 'protected', reason: 'source-not-lossless' });
    expect(storage.raw).toBe(sourceRaw);
    expect(storage.writes).toEqual([]);
  });

  it.each([
    [
      'character limit',
      () => {
        const duplicate = '{"schemaVersion":2,"schema\\u0056ersion":2}';
        return `${duplicate}${' '.repeat(MAX_PERSISTED_TABS_CHARS - duplicate.length + 1)}`;
      },
    ],
    [
      'UTF-8 byte limit',
      () => {
        const duplicate = '{"schemaVersion":2,"schema\\u0056ersion":2}';
        const padding = 'é'.repeat(
          Math.floor((MAX_PERSISTED_TABS_CHARS - duplicate.length) / 2) + 1,
        );
        const raw = `${duplicate}${padding}`;
        if (raw.length > MAX_PERSISTED_TABS_CHARS) throw new Error('Fixture exceeds character cap.');
        if (new TextEncoder().encode(raw).byteLength <= MAX_PERSISTED_TABS_CHARS)
          throw new Error('Fixture does not exceed UTF-8 byte cap.');
        return raw;
      },
    ],
  ] as const)('protects oversized observed input by %s before duplicate scanning', (_limit, makeRaw) => {
    const sourceRaw = makeRaw();
    const storage = memoryStorage(sourceRaw);
    const result = persistPaneTabsSnapshot(
      storage.storage,
      layoutWithInstances(1, 1),
      [],
      sourceRaw,
    );

    expect(result).toEqual({ kind: 'protected', reason: 'unsupported-source' });
    expect(storage.raw).toBe(sourceRaw);
    expect(storage.writes).toEqual([]);
  });

  it('preserves exact bytes for a semantically unchanged v2 snapshot', () => {
    const layout = layoutWithInstances(4, 2);
    const canonical = writePaneTabsSnapshot(layout, ['#/page/closed']);
    const sourceRaw = ` ${JSON.stringify(JSON.parse(canonical), null, 2)} `;
    const storage = memoryStorage(sourceRaw);
    const runtimeOnlyChange = { ...layout, topologyRevision: layout.topologyRevision + 1 };

    const result = persistPaneTabsSnapshot(
      storage.storage,
      runtimeOnlyChange,
      ['#/page/closed'],
      sourceRaw,
    );

    expect(result).toEqual({ kind: 'unchanged', raw: sourceRaw });
    expect(storage.raw).toBe(sourceRaw);
    expect(storage.writes).toEqual([]);
  });

  it.each(['read', 'write'] as const)(
    'returns a clear storage error and preserves the source when %s fails',
    (operation) => {
      const sourceRaw = writePaneTabsSnapshot(layoutWithInstances(1, 1), []);
      const storage = memoryStorage(sourceRaw, operation === 'read', operation === 'write');
      const candidate = layoutWithInstances(2, 1);
      const result = persistPaneTabsSnapshot(storage.storage, candidate, [], sourceRaw);

      expect(result).toEqual({ kind: 'storage-error', operation });
      expect(storage.raw).toBe(sourceRaw);
      expect(storage.writes).toEqual([]);
    },
  );

  it('protects future and malformed sources without attempting a write', () => {
    for (const sourceRaw of ['{"schemaVersion":3,"opaque":true}', '{malformed']) {
      const storage = memoryStorage(sourceRaw);
      const result = persistPaneTabsSnapshot(
        storage.storage,
        layoutWithInstances(1, 1),
        [],
        sourceRaw,
      );
      expect(result).toEqual({ kind: 'protected', reason: 'unsupported-source' });
      expect(storage.raw).toBe(sourceRaw);
      expect(storage.writes).toEqual([]);
    }
  });
});
