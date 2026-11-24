import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertExactViewTopology,
  assertExactRowProjection,
  assertViewConfigs,
  compareContentSnapshots,
  decodeLinkedViewMarkers,
} from './native-functional.mjs';

const first = {
  version: 1,
  viewId: 'polaris-linked-view-1',
  sourceDatabaseId: 'polaris-source-1',
  title: 'Origin primary stock',
  columnOrder: ['price', 'quantity'],
  filter: { propertyId: 'quantity', op: 'gte', value: 1 },
};
const second = {
  version: 1,
  viewId: 'polaris-linked-view-2',
  sourceDatabaseId: 'polaris-source-1',
  title: 'Origin low stock',
  columnOrder: ['name'],
  filter: { propertyId: 'quantity', op: 'gte', value: 3 },
};

function marker(config) {
  return `<!-- morrow:polaris-dados-view:v1:${Buffer.from(JSON.stringify(config)).toString('base64url')} -->`;
}

test('linked-view marker parsing preserves both distinct fixture identities and configs', () => {
  const parsed = decodeLinkedViewMarkers(`${marker(first)}\n\n${marker(second)}`);
  assertViewConfigs(parsed, [first, second], 'fixture parse');
});

test('linked-view verification rejects a missing, duplicate, or changed config', () => {
  assert.throws(() => assertViewConfigs([first], [first, second]), /expected 2 configs/);
  assert.throws(
    () => assertViewConfigs([first, { ...second, viewId: first.viewId }], [first, second]),
    /duplicate view IDs/,
  );
  assert.throws(
    () => assertViewConfigs([first, { ...second, title: 'Changed' }], [first, second]),
    /changed unexpectedly/,
  );
  assert.throws(
    () => decodeLinkedViewMarkers('<!-- morrow:polaris-dados-view:v1:bm90LWpzb24 -->'),
    /Could not decode/,
  );
});

test('view topology requires exactly two one-root wrappers in the expected order', () => {
  assert.doesNotThrow(() =>
    assertExactViewTopology(
      {
        providerCount: 2,
        views: [
          { rootCount: 1, title: first.title },
          { rootCount: 1, title: second.title },
        ],
      },
      [first.title, second.title],
    ),
  );
  assert.throws(
    () =>
      assertExactViewTopology(
        {
          providerCount: 3,
          views: [
            { rootCount: 2, title: first.title },
            { rootCount: 1, title: second.title },
          ],
        },
        [first.title, second.title],
      ),
    /exactly 2/,
  );
  assert.throws(
    () =>
      assertExactViewTopology(
        {
          providerCount: 2,
          views: [
            { rootCount: 1, title: second.title },
            { rootCount: 1, title: first.title },
          ],
        },
        [first.title, second.title],
      ),
    /wrong title/,
  );
});

test('source and linked views require exact row counts and a shared stable row ID', () => {
  assert.doesNotThrow(() => assertExactRowProjection([{ id: 'row-1' }], true, 'row-1', 'source'));
  assert.doesNotThrow(() => assertExactRowProjection([], false, 'row-1', 'filtered view'));
  assert.throws(
    () => assertExactRowProjection([{ id: 'row-1' }, { id: 'row-1' }], true, 'row-1'),
    /exactly 1 row/,
  );
  assert.throws(() => assertExactRowProjection([{ id: 'row-other' }], true, 'row-1'), /stable row ID/);
  assert.throws(() => assertExactRowProjection([{ id: 'row-1' }], false, 'row-1'), /exactly 0 row/);
});

test('no-write comparison checks both content bytes and mtime', () => {
  const before = {
    'Inventory.md': { hash: 'schema', mtimeMs: 10, size: 20 },
    'Inventory/Widget.md': { hash: 'row', mtimeMs: 11, size: 30 },
  };
  const same = {
    'Inventory.md': { hash: 'schema', mtimeMs: 10, size: 20 },
    'Inventory/Widget.md': { hash: 'row', mtimeMs: 11, size: 30 },
  };
  const result = compareContentSnapshots(before, same, 'open');
  assert.equal(result['Inventory.md'].bytesUnchanged, true);
  assert.equal(result['Inventory/Widget.md'].mtimeUnchanged, true);
  assert.throws(
    () =>
      compareContentSnapshots(
        before,
        {
          ...same,
          'Inventory/Widget.md': { hash: 'row', mtimeMs: 12, size: 30 },
        },
        'open',
      ),
    /changed bytes or mtime/,
  );
  assert.throws(
    () =>
      compareContentSnapshots(
        before,
        {
          ...same,
          'Inventory/Widget.md': { hash: 'changed', mtimeMs: 11, size: 30 },
        },
        'open',
      ),
    /changed bytes or mtime/,
  );
});
