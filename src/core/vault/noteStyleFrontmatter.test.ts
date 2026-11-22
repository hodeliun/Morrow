import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { updateMorrowNoteStyleFile, splitFrontmatter } from './frontmatter';
import type { NoteStyle } from '../noteStyle';

const STYLE: NoteStyle = {
  font: 'serif',
  fontSize: 19.5,
  lineHeight: 1.82,
  blockSpacing: 13,
  width: 'wide',
};

describe('updateMorrowNoteStyleFile', () => {
  it('changes only the five style values and preserves YAML context and body bytes', () => {
    const body = '# Heading  \r\n\r\n  keep   spacing\r\n';
    const source = [
      '---',
      '# keep top-level comment',
      'title: Note',
      '# keep style comment',
      'morrowNoteStyle:',
      '  # keep font comment',
      '  font: sans # keep inline comment',
      '  fontSize: 16',
      '  lineHeight: 1.68',
      '  blockSpacing: 9',
      '  width: comfortable',
      '  futureSetting:',
      '    # keep future comment',
      '    mode: keep',
      'defaults: &defaults',
      '  mode: retained',
      'aliasYaml: *defaults',
      'other:',
      '  # keep sibling comment',
      '  value: yes',
      '---',
      body,
    ].join('\n');
    const result = updateMorrowNoteStyleFile(source, STYLE);
    expect(result).not.toBeNull();
    const updated = splitFrontmatter(result!);
    expect(updated.body).toBe(body);
    expect(parse(updated.yaml, { uniqueKeys: true })).toEqual({
      title: 'Note',
      morrowNoteStyle: {
        ...STYLE,
        futureSetting: { mode: 'keep' },
      },
      defaults: { mode: 'retained' },
      aliasYaml: { mode: 'retained' },
      other: { value: 'yes' },
    });
    for (const comment of [
      '# keep top-level comment',
      '# keep style comment',
      '# keep font comment',
      '# keep inline comment',
      '# keep future comment',
      '# keep sibling comment',
    ])
      expect(result).toContain(comment);
    expect(updated.yaml.indexOf('title: Note')).toBeLessThan(updated.yaml.indexOf('morrowNoteStyle:'));
    expect(updated.yaml.indexOf('morrowNoteStyle:')).toBeLessThan(updated.yaml.indexOf('other:'));
  });

  it('adds style metadata without changing a body that has no frontmatter', () => {
    const body = '# Existing note\n\nText.  \n';
    const result = updateMorrowNoteStyleFile(body, STYLE);
    expect(result).not.toBeNull();
    const updated = splitFrontmatter(result!);
    expect(updated.data?.morrowNoteStyle).toEqual(STYLE);
    expect(updated.body).toBe(body);
  });

  it.each([
    ['empty frontmatter', '---\n---\nBody stays exact.\n'],
    ['comments-only frontmatter at EOF', '---\n# keep this comment\n---\nBody stays exact.\n'],
    ['empty CRLF frontmatter', '---\r\n---\r\nBody stays exact.\r\n'],
    ['comments-only CRLF frontmatter at EOF', '---\r\n# keep this comment\r\n---\r\nBody stays exact.\r\n'],
  ])('adds style fields safely to %s', (_name, source) => {
    const result = updateMorrowNoteStyleFile(source, STYLE);
    expect(result).not.toBeNull();
    const updated = splitFrontmatter(result!);
    expect(updated.data?.morrowNoteStyle).toEqual(STYLE);
    expect(updated.body).toBe(source.includes('\r\n') ? 'Body stays exact.\r\n' : 'Body stays exact.\n');
    if (source.includes('# keep this comment')) expect(result).toContain('# keep this comment');
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    expect(result).toContain(`morrowNoteStyle:${eol}  font: serif${eol}`);
  });

  it('fills missing owned fields inside an existing style map without reserializing future YAML', () => {
    const source = [
      '---',
      'title: Partial',
      'morrowNoteStyle:',
      '  # keep the style comment',
      '  font: sans # keep inline comment',
      '  futureSetting:',
      '    mode: keep',
      'other: sibling',
      '',
      '---',
      'Body stays exact.  ',
      '',
    ].join('\n');
    const result = updateMorrowNoteStyleFile(source, STYLE);
    expect(result).not.toBeNull();
    const updated = splitFrontmatter(result!);
    expect(updated.body).toBe('Body stays exact.  \n');
    expect(parse(updated.yaml, { uniqueKeys: true })).toEqual({
      title: 'Partial',
      morrowNoteStyle: { ...STYLE, futureSetting: { mode: 'keep' } },
      other: 'sibling',
    });
    expect(result).toContain('# keep the style comment');
    expect(result).toContain('# keep inline comment');
    expect(result).toContain('other: sibling\n\n---');
  });

  it.each([
    ['LF', '---\nmorrowNoteStyle:\n  font: sans', '\n', 'Body stays exact.\n'],
    ['CRLF', '---\r\nmorrowNoteStyle:\r\n  font: sans', '\r\n', 'Body stays exact.\r\n'],
  ])('inserts missing fields on a new line at the end of %s YAML', (_name, start, eol, body) => {
    const source = `${start} # keep inline comment${eol}  # keep trailing comment${eol}---${eol}${body}`;
    const result = updateMorrowNoteStyleFile(source, STYLE);
    expect(result).not.toBeNull();
    const updated = splitFrontmatter(result!);
    expect(updated.data?.morrowNoteStyle).toEqual(STYLE);
    expect(updated.body).toBe(body);
    expect(result).toContain(`font: serif # keep inline comment${eol}`);
    expect(result).toContain(`  # keep trailing comment${eol}`);
    expect(result).toContain(`  fontSize: 19.5${eol}`);
  });

  it.each([
    ['LF', '---\nmorrowNoteStyle:\n  font: sans # keep inline comment\n---\nBody stays exact.\n', '\n'],
    [
      'CRLF',
      '---\r\nmorrowNoteStyle:\r\n  font: sans # keep inline comment\r\n---\r\nBody stays exact.\r\n',
      '\r\n',
    ],
  ])('separates newly added fields from the final %s YAML line', (_name, source, eol) => {
    const result = updateMorrowNoteStyleFile(source, STYLE);
    expect(result).not.toBeNull();
    const updated = splitFrontmatter(result!);
    expect(updated.data?.morrowNoteStyle).toEqual(STYLE);
    expect(updated.body).toBe(source.includes('\r\n') ? 'Body stays exact.\r\n' : 'Body stays exact.\n');
    expect(result).toContain(`  font: serif # keep inline comment${eol}  fontSize: 19.5${eol}`);
  });

  it('uses frontmatter line endings without rewriting line endings in the note body', () => {
    const body = '# CRLF body\r\n\r\nExact bytes.  \r\n';
    const source = `---\r\ntitle: CRLF\r\n---\r\n${body}`;
    const result = updateMorrowNoteStyleFile(source, STYLE);
    expect(result).not.toBeNull();
    expect(result).toContain('morrowNoteStyle:\r\n  font: serif\r\n');
    expect(splitFrontmatter(result!).body).toBe(body);
  });

  it('preserves a BOM and refuses ambiguous or unsupported existing style YAML', () => {
    const bom = '\uFEFF';
    const withBom = updateMorrowNoteStyleFile(`${bom}Body\n`, STYLE);
    expect(withBom?.startsWith(bom)).toBe(true);
    expect(splitFrontmatter(withBom!.slice(1)).body).toBe('Body\n');

    expect(updateMorrowNoteStyleFile('---\nmorrowNoteStyle: future-string\n---\nBody\n', STYLE)).toBeNull();
    expect(
      updateMorrowNoteStyleFile('---\nmorrowNoteStyle:\n  font: sans\n  font: mono\n---\nBody\n', STYLE),
    ).toBeNull();
    expect(updateMorrowNoteStyleFile('---\nmorrowNoteStyle: sans\nBody\n', STYLE)).toBeNull();
  });
});
