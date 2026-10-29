import { describe, expect, it } from 'vitest';
import { createPaneLayout, migrateLegacySplit } from './paneLayout';
import {
  MAX_PERSISTED_HISTORY,
  MAX_PERSISTED_TABS_CHARS,
  PANE_TABS_STORAGE_KEY,
  persistPaneTabsSnapshot,
  readPaneTabsSnapshot,
  writePaneTabsSnapshot,
} from './paneLayoutStorage';

describe('pane tab persistence boundary', () => {
  it('migrates all twenty legacy groups and up to forty main/side histories without truncation', () => {
    const legacy = {
      active: 'legacy-19',
      pane: 'side' as const,
      closed: Array.from({ length: 10 }, (_, index) => `#/closed/${index}`),
      tabs: Array.from({ length: 20 }, (_, index) => ({
        id: `legacy-${index}`,
        hash: `#/main/${index}`,
        back: [`#/main/${index}/before`],
        forward: [`#/main/${index}/after`],
        side: {
          hash: `#/side/${index}`,
          back: [`#/side/${index}/before`],
          forward: [`#/side/${index}/after`],
        },
      })),
    };

    const result = readPaneTabsSnapshot(JSON.stringify(legacy));

    expect(result.kind).toBe('legacy');
    if (result.kind !== 'legacy') return;
    expect(result.snapshot.tabs).toHaveLength(20);
    expect(result.snapshot.tabs.every((tab) => tab.side !== null)).toBe(true);
    const migrated = migrateLegacySplit('layout-v2', result.snapshot, 0.63);
    expect(migrated.tabs).toHaveLength(40);
    expect(migrated.tabs[38]).toMatchObject({
      groupId: 'legacy-19',
      target: '#/main/19',
      back: ['#/main/19/before'],
      forward: ['#/main/19/after'],
    });
    expect(migrated.tabs[39]).toMatchObject({
      groupId: 'legacy-19',
      target: '#/side/19',
      back: ['#/side/19/before'],
      forward: ['#/side/19/after'],
    });
    expect(result.snapshot.closed).toEqual(legacy.closed);
  });

  it('round trips a versioned pane layout, focus, histories, and closed-tab history', () => {
    const layout = createPaneLayout(
      'layout-persisted',
      [
        {
          id: 'tab-a',
          groupId: 'group-a',
          target: '#/page/a',
          back: ['#/page/previous'],
          forward: ['#/page/next'],
        },
        { id: 'tab-b', groupId: 'group-b', target: '#/page/b', back: [], forward: [] },
      ],
      'tab-a',
      'two-columns',
    );
    const focused = { ...layout, focusedPaneId: 'layout-persisted:pane:2' };
    const serialized = writePaneTabsSnapshot(focused, ['#/closed/a']);

    const result = readPaneTabsSnapshot(serialized);

    expect(result.kind).toBe('current');
    if (result.kind !== 'current') return;
    expect(result.snapshot.layout).toEqual({ ...focused, topologyRevision: 0 });
    expect(result.snapshot.closed).toEqual(['#/closed/a']);
  });

  it('recognizes a future schema without interpreting it as legacy state', () => {
    const raw = JSON.stringify({ schemaVersion: 3, tabs: [{ not: 'legacy' }] });
    expect(readPaneTabsSnapshot(raw)).toEqual({ kind: 'future', version: 3 });

    const untouched = { value: raw };
    const storage = {
      setItem: (key: string, value: string) => {
        if (key === PANE_TABS_STORAGE_KEY) untouched.value = value;
      },
    };
    const fallback = createPaneLayout('layout-safe-fallback', [], null);
    expect(persistPaneTabsSnapshot(storage, fallback, [], false)).toBe(false);
    expect(untouched.value).toBe(raw);
  });

  it('rejects malformed, oversized, truncated legacy and over-deep current snapshots without repairing them', () => {
    expect(readPaneTabsSnapshot('{broken')).toEqual({ kind: 'invalid', reason: 'malformed-json' });
    expect(readPaneTabsSnapshot(' '.repeat(MAX_PERSISTED_TABS_CHARS + 1))).toEqual({
      kind: 'invalid',
      reason: 'payload-too-large',
    });
    expect(
      readPaneTabsSnapshot(
        JSON.stringify({
          active: 'legacy-20',
          tabs: Array.from({ length: 21 }, (_, index) => ({
            id: `legacy-${index}`,
            hash: '#/',
            back: [],
            forward: [],
            side: null,
          })),
        }),
      ).kind,
    ).toBe('invalid');

    const tooDeep = {
      kind: 'split',
      id: 'split-0',
      axis: 'columns',
      ratio: 0.5,
      first: {
        kind: 'split',
        id: 'split-1',
        axis: 'columns',
        ratio: 0.5,
        first: {
          kind: 'split',
          id: 'split-2',
          axis: 'columns',
          ratio: 0.5,
          first: {
            kind: 'split',
            id: 'split-3',
            axis: 'columns',
            ratio: 0.5,
            first: { kind: 'leaf', id: 'leaf-a', tabId: 'tab-a' },
            second: { kind: 'leaf', id: 'leaf-b', tabId: null },
          },
          second: { kind: 'leaf', id: 'leaf-c', tabId: null },
        },
        second: { kind: 'leaf', id: 'leaf-d', tabId: null },
      },
      second: { kind: 'leaf', id: 'leaf-e', tabId: null },
    };
    const invalidCurrent = {
      schemaVersion: 2,
      paneLayout: {
        version: 1,
        id: 'layout-deep',
        focusedPaneId: 'leaf-a',
        root: tooDeep,
      },
      tabs: [{ id: 'tab-a', groupId: 'group-a', target: '#/', back: [], forward: [] }],
      closed: [],
    };
    expect(readPaneTabsSnapshot(JSON.stringify(invalidCurrent))).toEqual({
      kind: 'invalid',
      reason: 'invalid-v2-payload',
    });
  });

  it('preserves the legacy 50-entry history bound exactly', () => {
    const history = Array.from({ length: MAX_PERSISTED_HISTORY }, (_, index) => `#/page/${index}`);
    const result = readPaneTabsSnapshot(
      JSON.stringify({
        active: 'legacy-a',
        pane: 'main',
        tabs: [{ id: 'legacy-a', hash: '#/current', back: history, forward: [], side: null }],
      }),
    );
    expect(result.kind).toBe('legacy');
    if (result.kind === 'legacy') expect(result.snapshot.tabs[0]?.back).toEqual(history);
  });

  it('refuses to persist a fallback derived from malformed storage', () => {
    const raw = '{broken';
    expect(readPaneTabsSnapshot(raw)).toEqual({ kind: 'invalid', reason: 'malformed-json' });
    let stored = raw;
    const storage = {
      setItem: (_key: string, value: string) => {
        stored = value;
      },
    };
    const fallback = createPaneLayout('layout-corrupt-fallback', [], null);

    expect(persistPaneTabsSnapshot(storage, fallback, [], false)).toBe(false);
    expect(stored).toBe(raw);
  });
});
