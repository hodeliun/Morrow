import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  captureExplicitMorrowNoteStyleFile,
  parseSimple,
  restoreExplicitMorrowNoteStyleFile,
  splitFrontmatter,
  updateMorrowNoteStyleFile,
} from './frontmatter';
import type { NoteStyle } from '../noteStyle';

// whenever the quick reader answers, it must read exactly what yaml itself reads
const VALUES = [
  '4',
  '4.5',
  '1e3',
  '0x1A',
  '0o17',
  '007',
  '-0',
  '+3',
  '-2.5e-3',
  '.5',
  '5.',
  '.inf',
  '.nan',
  '1_000',
  'true',
  'True',
  'TRUE',
  'tRue',
  'false',
  'yes',
  'no',
  'on',
  'null',
  'Null',
  '~',
  '',
  '2024-05-01',
  '2024-05-01T10:00:00Z',
  'Ursula K. Le Guin',
  'a, b',
  'a: b',
  'a:b',
  'a #c',
  'a#c',
  "'q'",
  '"q"',
  'x y',
  '#tag',
  '@x',
  '`x`',
  'a/b',
  'café',
  "it's",
  '-x',
  '- x',
  '? x',
  '| x',
  '> x',
  '%x',
  '&a',
  '*a',
  '!x',
  '[a, b]',
  '[]',
  '[ ]',
  '[a, 1, true]',
  '[a, ]',
  '[a b, c]',
  '[[a]]',
  '{a: 1}',
  'C++',
  'v1.2.3',
  '+',
];
const KEYS = ['title', 'date', 'my key', 'k2', 'Status', '_x', 'a-b', '1key', 'tags', 'key:x'];

let seed = 7;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]!;

function sample(): string {
  const lines: string[] = [];
  const count = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < count; i++) {
    const key = pick(KEYS);
    if (rand() < 0.2) {
      lines.push(`${key}:`);
      const indent = pick(['', '  ', '    ']);
      for (let j = Math.floor(rand() * 3); j > 0; j--)
        lines.push(`${rand() < 0.1 ? ' ' : ''}${indent}- ${pick(VALUES)}`);
    } else lines.push(`${key}:${pick([' ', '  ', '\t', ''])}${pick(VALUES)}${pick(['', ' ', ' # note'])}`);
    if (rand() < 0.05) lines.push(pick(['', '# comment', '  nested: 1']));
  }
  return lines.join('\n');
}

describe('the quick frontmatter reader', () => {
  it('agrees with yaml whenever it answers', () => {
    let answered = 0;
    for (let i = 0; i < 20_000; i++) {
      const text = sample();
      const quick = parseSimple(text);
      if (quick === null) continue;
      answered++;
      let full: unknown;
      try {
        full = parse(text, { uniqueKeys: false }) ?? {};
      } catch {
        throw new Error(`answered where yaml fails:\n${text}`);
      }
      expect(quick, text).toEqual(full);
    }
    // it should still take the common shapes itself
    expect(answered).toBeGreaterThan(1000);
  });

  it('reads the usual note frontmatter', () => {
    expect(
      parseSimple(
        'date: 2024-05-01\ntags: [a, b]\nrating: 4\ndone: true\naliases:\n  - One\n  - Two\nempty:',
      ),
    ).toEqual({
      date: '2024-05-01',
      tags: ['a', 'b'],
      rating: 4,
      done: true,
      aliases: ['One', 'Two'],
      empty: null,
    });
  });
});

const APPLIED_STYLE: NoteStyle = {
  font: 'mono',
  fontSize: 18,
  lineHeight: 1.9,
  blockSpacing: 12,
  width: 'wide',
};

function applyStyle(source: string): string {
  const updated = updateMorrowNoteStyleFile(source, APPLIED_STYLE);
  if (updated === null) throw new Error('The test style could not be applied.');
  return updated;
}

function insertBeforeClosingDelimiter(text: string, content: string, lineBreak = '\n'): string {
  const start = text.indexOf('morrowNoteStyle:');
  const closing = text.indexOf(`${lineBreak}---`, start);
  if (start < 0 || closing < 0) throw new Error('The test frontmatter closing delimiter was not found.');
  return `${text.slice(0, closing)}${content}${text.slice(closing)}`;
}

describe('explicit note style restoration codec', () => {
  it('restores complete original scalar lexemes and preserves later YAML and body edits', () => {
    const original =
      '\uFEFF---\r\ntitle: Before\r\nmorrowNoteStyle:\r\n  font: "serif" # original font note\r\n  fontSize: 20.0\r\n  lineHeight: 1.7\r\n  blockSpacing: null\r\n  width: wide\r\n  custom: keep\r\nfuture: yes\r\n---\r\nOriginal body\r\n';
    const snapshot = captureExplicitMorrowNoteStyleFile(original);
    expect(snapshot).toEqual({
      kind: 'explicit',
      fields: {
        font: ' "serif"',
        fontSize: ' 20.0',
        lineHeight: ' 1.7',
        blockSpacing: ' null',
        width: ' wide',
      },
      separatorAdded: false,
      separatorAnchorKey: null,
    });

    const applied = applyStyle(original);
    const edited = applied
      .replace('title: Before', 'title: After')
      .replace('# original font note', '# edited font note')
      .replace('  custom: keep', '  custom: edited')
      .replace('future: yes', 'future: no')
      .replace('Original body', 'Body edited');
    const restored = restoreExplicitMorrowNoteStyleFile(edited, APPLIED_STYLE, snapshot!);

    expect(restored).toBe(
      '\uFEFF---\r\ntitle: After\r\nmorrowNoteStyle:\r\n  font: "serif" # edited font note\r\n  fontSize: 20.0\r\n  lineHeight: 1.7\r\n  blockSpacing: null\r\n  width: wide\r\n  custom: edited\r\nfuture: no\r\n---\r\nBody edited\r\n',
    );
  });

  it.each([
    { name: 'LF', lineBreak: '\n', bom: '' },
    { name: 'CRLF with BOM', lineBreak: '\r\n', bom: '\uFEFF' },
  ])('restores partial overrides byte for byte with $name', ({ lineBreak, bom }) => {
    const original = `${bom}---${lineBreak}title: before${lineBreak}morrowNoteStyle:${lineBreak}  font: 'serif'${lineBreak}  fontSize: null${lineBreak}---${lineBreak}Body${lineBreak}`;
    const snapshot = captureExplicitMorrowNoteStyleFile(original);
    expect(snapshot?.fields).toEqual({ font: " 'serif'", fontSize: ' null' });
    expect(snapshot?.separatorAdded).toBe(true);

    const restored = restoreExplicitMorrowNoteStyleFile(applyStyle(original), APPLIED_STYLE, snapshot!);
    expect(restored).toBe(original);
  });

  it.each([
    {
      name: 'nested map',
      value: '  future:\n    # nested map comment\n    child: yes # leaf comment',
      anchor: 'future',
    },
    {
      name: 'block list',
      value: '  futureList:\n    - first # list comment\n    - nested:\n        child: yes # leaf comment',
      anchor: 'futureList',
    },
  ])('restores a last $name field byte for byte with LF and CRLF', ({ value, anchor }) => {
    for (const lineBreak of ['\n', '\r\n']) {
      const original = `---${lineBreak}title: before${lineBreak}morrowNoteStyle:${lineBreak}  font: serif${lineBreak}${value.replaceAll('\n', lineBreak)}${lineBreak}---${lineBreak}Body${lineBreak}`;
      const snapshot = captureExplicitMorrowNoteStyleFile(original);
      expect(snapshot?.separatorAdded).toBe(true);
      expect(snapshot?.separatorAnchorKey).toBe(anchor);

      expect(restoreExplicitMorrowNoteStyleFile(applyStyle(original), APPLIED_STYLE, snapshot!)).toBe(
        original,
      );
    }
  });

  it('keeps an added blank line and neighboring YAML key after a nested separator', () => {
    const lineBreak = '\n';
    const original = `---${lineBreak}title: before${lineBreak}morrowNoteStyle:${lineBreak}  font: serif${lineBreak}  future:${lineBreak}    child: yes${lineBreak}---${lineBreak}Body${lineBreak}`;
    const snapshot = captureExplicitMorrowNoteStyleFile(original)!;
    const applied = applyStyle(original);

    const withBlank = insertBeforeClosingDelimiter(applied, lineBreak, lineBreak);
    expect(restoreExplicitMorrowNoteStyleFile(withBlank, APPLIED_STYLE, snapshot)).toBe(
      original.replace(`${lineBreak}---${lineBreak}Body`, `${lineBreak}${lineBreak}---${lineBreak}Body`),
    );

    const withNeighbor = insertBeforeClosingDelimiter(applied, 'futureRoot: edited', lineBreak);
    expect(restoreExplicitMorrowNoteStyleFile(withNeighbor, APPLIED_STYLE, snapshot)).toBe(
      original.replace(
        `${lineBreak}---${lineBreak}Body`,
        `${lineBreak}futureRoot: edited${lineBreak}---${lineBreak}Body`,
      ),
    );
  });

  it('preserves a newly added blank line and a neighboring YAML key when cleaning the appended separator', () => {
    const lineBreak = '\n';
    const original = `---${lineBreak}title: before${lineBreak}morrowNoteStyle:${lineBreak}  font: serif${lineBreak}  fontSize: null${lineBreak}---${lineBreak}Body${lineBreak}`;
    const snapshot = captureExplicitMorrowNoteStyleFile(original)!;
    const applied = applyStyle(original);

    const withBlank = insertBeforeClosingDelimiter(applied, lineBreak, lineBreak);
    expect(restoreExplicitMorrowNoteStyleFile(withBlank, APPLIED_STYLE, snapshot)).toBe(
      original.replace(`${lineBreak}---${lineBreak}Body`, `${lineBreak}${lineBreak}---${lineBreak}Body`),
    );

    const withNeighbor = insertBeforeClosingDelimiter(applied, 'future: edited', lineBreak);
    expect(restoreExplicitMorrowNoteStyleFile(withNeighbor, APPLIED_STYLE, snapshot)).toBe(
      original.replace(
        `${lineBreak}---${lineBreak}Body`,
        `${lineBreak}future: edited${lineBreak}---${lineBreak}Body`,
      ),
    );

    const withBlankBeforeNeighbor = insertBeforeClosingDelimiter(
      applied,
      `${lineBreak}owner: new`,
      lineBreak,
    );
    expect(restoreExplicitMorrowNoteStyleFile(withBlankBeforeNeighbor, APPLIED_STYLE, snapshot)).toBe(
      original.replace(
        `${lineBreak}---${lineBreak}Body`,
        `${lineBreak}${lineBreak}owner: new${lineBreak}---${lineBreak}Body`,
      ),
    );
  });

  it('preserves a neighboring YAML key that was already after the style map', () => {
    const source =
      '---\ntitle: before\nmorrowNoteStyle:\n  font: serif\n  fontSize: null\nfuture: original\n---\nBody\n';
    const snapshot = captureExplicitMorrowNoteStyleFile(source)!;
    expect(snapshot.separatorAdded).toBe(false);
    expect(restoreExplicitMorrowNoteStyleFile(applyStyle(source), APPLIED_STYLE, snapshot)).toBe(source);
  });

  it('preserves comments that were already after a partial style map', () => {
    const source = '---\nmorrowNoteStyle:\n  font: serif\n  # existing style note\n---\nBody\n';
    const snapshot = captureExplicitMorrowNoteStyleFile(source)!;
    expect(restoreExplicitMorrowNoteStyleFile(applyStyle(source), APPLIED_STYLE, snapshot)).toBe(source);
  });

  it('refuses changed styles, duplicate fields, aliases, anchors, and comments on introduced lines', () => {
    const source = '---\nmorrowNoteStyle:\n  font: serif\n---\nBody\n';
    const snapshot = captureExplicitMorrowNoteStyleFile(source)!;
    const applied = applyStyle(source);
    const changed = applied.replace('fontSize: 18', 'fontSize: 19');
    expect(restoreExplicitMorrowNoteStyleFile(changed, APPLIED_STYLE, snapshot)).toBeNull();

    expect(
      captureExplicitMorrowNoteStyleFile('---\nmorrowNoteStyle:\n  font: serif\n  font: mono\n---\nBody\n'),
    ).toBeNull();
    expect(
      captureExplicitMorrowNoteStyleFile('---\nmorrowNoteStyle:\n  font: &base serif\n---\nBody\n'),
    ).toBeNull();
    expect(
      captureExplicitMorrowNoteStyleFile('---\nmorrowNoteStyle:\n  font: *base\n---\nBody\n'),
    ).toBeNull();

    const withNewComment = applied.replace('fontSize: 18', 'fontSize: 18 # added after apply');
    expect(restoreExplicitMorrowNoteStyleFile(withNewComment, APPLIED_STYLE, snapshot)).toBeNull();
  });

  it('refuses tagged touched keys and values while preserving tags on unknown YAML', () => {
    const source =
      '---\nmorrowNoteStyle:\n  font: serif\n  custom: !custom preserved\nfuture: !!str neighbor\n---\nBody\n';
    const snapshot = captureExplicitMorrowNoteStyleFile(source)!;
    const applied = applyStyle(source);
    const taggedTouchedLines = [
      applied.replace('  width: wide', '  width: !custom wide'),
      applied.replace('  width: wide', '  width: !!str wide'),
      applied.replace('  font: mono', '  font: !custom mono'),
      applied.replace('  font: mono', '  font: !!str mono'),
      applied.replace('  width: wide', '  !custom width: wide'),
      applied.replace('  width: wide', '  !!str width: wide'),
      applied.replace('  font: mono', '  !custom font: mono'),
      applied.replace('  font: mono', '  !!str font: mono'),
    ];
    for (const edited of taggedTouchedLines)
      expect(restoreExplicitMorrowNoteStyleFile(edited, APPLIED_STYLE, snapshot)).toBeNull();

    const taggedOriginals = [
      '---\nmorrowNoteStyle:\n  font: !custom serif\n---\nBody\n',
      '---\nmorrowNoteStyle:\n  font: !!str serif\n---\nBody\n',
      '---\nmorrowNoteStyle:\n  !custom font: serif\n---\nBody\n',
      '---\nmorrowNoteStyle:\n  !!str font: serif\n---\nBody\n',
    ];
    for (const original of taggedOriginals) expect(captureExplicitMorrowNoteStyleFile(original)).toBeNull();

    expect(restoreExplicitMorrowNoteStyleFile(applied, APPLIED_STYLE, snapshot)).toBe(source);
  });

  it('refuses multiline style scalars rather than normalizing them', () => {
    const source = '---\nmorrowNoteStyle:\n  font: >-\n    serif\n---\nBody\n';
    expect(captureExplicitMorrowNoteStyleFile(source)).toBeNull();
  });

  it('reparses a successful restore as an explicit style override', () => {
    const source = '---\nmorrowNoteStyle:\n  font: "serif"\n  fontSize: 20.0\n---\nBody\n';
    const snapshot = captureExplicitMorrowNoteStyleFile(source)!;
    const restored = restoreExplicitMorrowNoteStyleFile(applyStyle(source), APPLIED_STYLE, snapshot);
    expect(restored).not.toBeNull();
    expect(splitFrontmatter(restored!).data?.morrowNoteStyle).toEqual({ font: 'serif', fontSize: 20 });
    expect(restored).toBe(source);
  });
});
