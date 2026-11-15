import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  assertCollapsedParagraphCaret,
  assertPickerConfigSequence,
  decodePickerViewMarkers,
  findSourceSentenceParagraphIndex,
} from './native-picker.mjs';

const RUNNER = fileURLToPath(new URL('./native-bank-smoke.mjs', import.meta.url));
const first = {
  version: 1,
  viewId: 'fixture-view-1',
  sourceDatabaseId: 'fixture-source-1',
  title: 'Origin primary stock',
  columnOrder: ['price', 'quantity'],
  filter: { propertyId: 'quantity', op: 'gte', value: 1 },
};
const second = {
  version: 1,
  viewId: 'fixture-view-2',
  sourceDatabaseId: 'fixture-source-1',
  title: 'Origin low stock',
  columnOrder: ['name'],
  filter: { propertyId: 'quantity', op: 'gte', value: 3 },
};

function marker(config) {
  return `<!-- morrow:polaris-dados-view:v1:${Buffer.from(JSON.stringify(config)).toString('base64url')} -->`;
}

test('picker marker parser preserves the two existing config identities and rejects malformed markers', () => {
  assertPickerConfigSequence(decodePickerViewMarkers(`${marker(first)}\n\n${marker(second)}`), [first, second]);
  assert.throws(() => decodePickerViewMarkers('<!-- morrow:polaris-dados-view:v1:bm90LWpzb24 -->'), /Could not decode/);
  assert.throws(
    () => decodePickerViewMarkers(marker({ ...first, sourceDatabaseId: '' })),
    /invalid config shape/,
  );
});

test('picker config guard rejects duplicates, changed old views, and accidental extra markers', () => {
  assert.throws(() => assertPickerConfigSequence([first], [first, second]), /expected 2 configs/);
  assert.throws(() => assertPickerConfigSequence([first, { ...second, viewId: first.viewId }], [first, second]), /duplicate view IDs/);
  assert.throws(
    () => assertPickerConfigSequence([first, { ...second, filter: { propertyId: 'quantity', op: 'gte', value: 4 } }], [first, second]),
    /changed unexpectedly/,
  );
  assert.throws(
    () => assertPickerConfigSequence([first, second, { ...first, viewId: 'view-3' }], [first, second]),
    /expected 2 configs/,
  );
});

test('picker locates the source sentence inside a combined fixture paragraph and guards its caret', () => {
  assert.equal(
    findSourceSentenceParagraphIndex([
      '# Views',
      'Synthetic vault marker The two linked views below share Inventory.md and keep independent configuration.',
      'Other paragraph',
    ]),
    1,
  );
  assert.throws(
    () => findSourceSentenceParagraphIndex(['A different paragraph.']),
    /one paragraph containing the source sentence, got 0/,
  );
  assert.throws(
    () => findSourceSentenceParagraphIndex([
      'The two linked views below share Inventory.md and keep independent configuration.',
      'The two linked views below share Inventory.md and keep independent configuration.',
    ]),
    /one paragraph containing the source sentence, got 2/,
  );

  const token = 'E158-PICKER-test';
  const valid = {
    focusedEditor: true,
    anchorInEditor: true,
    anchorIsText: true,
    isCollapsed: true,
    anchorOffset: 31,
    anchorTextLength: 31,
    paragraphText: `Existing prose. ${token}`,
    editorText: `Existing prose. ${token}\nOther paragraph`,
  };
  assert.doesNotThrow(() => assertCollapsedParagraphCaret(valid, token));
  assert.throws(() => assertCollapsedParagraphCaret({ ...valid, isCollapsed: false }, token), /Pending text\/caret/);
  assert.throws(() => assertCollapsedParagraphCaret({ ...valid, anchorInEditor: false }, token), /Pending text\/caret/);
  assert.throws(() => assertCollapsedParagraphCaret({ ...valid, editorText: `${valid.editorText} ${token}` }, token), /Pending text\/caret/);
});

test('native runner exposes picker scenarios and rejects invalid dispatch before preflight', () => {
  const help = spawnSync(process.execPath, [RUNNER, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--scenario[^\n]*picker\|picker-independent/);

  const unknown = spawnSync(process.execPath, [RUNNER, '--check-only', '--scenario', 'unknown-picker'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown fixed scenario unknown-picker/);
  assert.match(unknown.stderr, /picker, picker-independent/);
  assert.doesNotMatch(unknown.stdout, /"outputPaths"/);

  for (const scenario of ['picker', 'picker-independent']) {
    const validButIncomplete = spawnSync(process.execPath, [RUNNER, '--check-only', '--scenario', scenario], { encoding: 'utf8' });
    assert.equal(validButIncomplete.status, 1, `${scenario}: ${validButIncomplete.stderr}`);
    assert.match(validButIncomplete.stderr, /Missing --expected-commit/);
    assert.doesNotMatch(validButIncomplete.stderr, /Unknown fixed scenario/);
    assert.doesNotMatch(validButIncomplete.stdout, /"outputPaths"/);
  }
});
