import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  captureInheritedMorrowNoteStyleContext,
  restoreInheritedMorrowNoteStyleFile,
  splitFrontmatter,
  updateMorrowNoteStyleFile,
} from './frontmatter';
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

describe('inherited note style restoration codec', () => {
  it('captures whether an envelope and its trailing separator existed before applying the style', () => {
    expect(captureInheritedMorrowNoteStyleContext('Body\n')).toEqual({
      hadFrontmatter: false,
      separatorAdded: false,
      emptyFrontmatterHadBlankLine: null,
    });
    expect(captureInheritedMorrowNoteStyleContext('---\nstatus: fixture\n---\nBody\n')).toEqual({
      hadFrontmatter: true,
      separatorAdded: true,
      emptyFrontmatterHadBlankLine: null,
    });
    expect(captureInheritedMorrowNoteStyleContext('---\nstatus: fixture\n\n---\nBody\n')).toEqual({
      hadFrontmatter: true,
      separatorAdded: false,
      emptyFrontmatterHadBlankLine: null,
    });
    expect(
      captureInheritedMorrowNoteStyleContext(`---\nmorrowNoteStyle:\n  font: serif\n---\nBody\n`),
    ).toBeNull();
    expect(captureInheritedMorrowNoteStyleContext('---\nstatus: broken\nBody\n')).toBeNull();
  });

  it.each([
    ['no frontmatter', 'Body stays exact.\n'],
    ['empty frontmatter', '---\n---\nBody stays exact.\n'],
    ['empty frontmatter with a blank line', '---\n\n---\nBody stays exact.\n'],
    ['empty CRLF frontmatter', '---\r\n---\r\nBody stays exact.\r\n'],
    ['empty CRLF frontmatter with a blank line', '---\r\n\r\n---\r\nBody stays exact.\r\n'],
    ['comments-only frontmatter', '---\n# Keep this note.\n---\nBody stays exact.\n'],
    ['neighbor YAML without a final newline', '---\nstatus: fixture\n---\nBody stays exact.\n'],
    ['neighbor YAML with a blank line before close', '---\nstatus: fixture\n\n---\nBody stays exact.\n'],
    ['CRLF frontmatter', '---\r\nstatus: fixture\r\n---\r\nBody stays exact.\r\n'],
  ])('restores the original envelope for %s', (_name, source) => {
    const context = captureInheritedMorrowNoteStyleContext(source);
    expect(context).not.toBeNull();
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    expect(applied).not.toBeNull();
    expect(restoreInheritedMorrowNoteStyleFile(applied!, STYLE, context!)).toBe(source);
  });

  it('keeps a BOM and later body edits while removing a newly created envelope', () => {
    const bom = '\uFEFF';
    const source = `${bom}Original body\r\n\r\nKeep trailing spaces.  \r\n`;
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    expect(context).toEqual({
      hadFrontmatter: false,
      separatorAdded: false,
      emptyFrontmatterHadBlankLine: null,
    });
    expect(applied).not.toBeNull();

    const edited = applied!.replace('Original body', 'Edited body');
    expect(restoreInheritedMorrowNoteStyleFile(edited, STYLE, context!)).toBe(
      `${bom}Edited body\r\n\r\nKeep trailing spaces.  \r\n`,
    );
  });

  it('preserves edited neighboring YAML, comments, and body bytes', () => {
    const source = [
      '---',
      '# keep this comment',
      'status: fixture',
      'other:',
      '  value: original',
      '---',
      'Original body  ',
      '',
    ].join('\n');
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    expect(context?.separatorAdded).toBe(true);
    expect(applied).not.toBeNull();

    const edited = applied!
      .replace('status: fixture', 'status: later')
      .replace('value: original', 'value: newer')
      .replace('Original body  ', 'Edited body  ');
    const restored = restoreInheritedMorrowNoteStyleFile(edited, STYLE, context!);
    expect(restored).not.toBeNull();
    expect(restored).toBe(
      [
        '---',
        '# keep this comment',
        'status: later',
        'other:',
        '  value: newer',
        '---',
        'Edited body  ',
        '',
      ].join('\n'),
    );
  });

  it('retains new metadata and comments around the style block', () => {
    const source = '---\nstatus: fixture\n---\nBody\n';
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    expect(applied).not.toBeNull();

    const metadataBeforeStyle = applied!.replace(
      'morrowNoteStyle:',
      'owner: added later\n# keep this later comment\nmorrowNoteStyle:',
    );
    const restoredBefore = restoreInheritedMorrowNoteStyleFile(metadataBeforeStyle, STYLE, context!);
    expect(splitFrontmatter(restoredBefore!).data).toEqual({ status: 'fixture', owner: 'added later' });
    expect(restoredBefore).toContain('# keep this later comment');
    expect(splitFrontmatter(restoredBefore!).body).toBe('Body\n');

    const metadataAfterStyle = applied!.replace('---\nBody', 'owner: added later\n---\nBody edited');
    const restoredAfter = restoreInheritedMorrowNoteStyleFile(metadataAfterStyle, STYLE, context!);
    expect(splitFrontmatter(restoredAfter!).data).toEqual({ status: 'fixture', owner: 'added later' });
    expect(splitFrontmatter(restoredAfter!).body).toBe('Body edited\n');
    expect(restoredAfter).toBe('---\nstatus: fixture\nowner: added later\n---\nBody edited\n');
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('preserves one blank line added after the style block for %s', (_name, eol) => {
    const source = `---${eol}status: orig${eol}---${eol}Body${eol}`;
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    expect(applied).not.toBeNull();

    const edited = applied!.replace(
      `width: wide${eol}---${eol}Body${eol}`,
      `width: wide${eol}${eol}---${eol}Body${eol}`,
    );
    const restored = restoreInheritedMorrowNoteStyleFile(edited, STYLE, context!);
    expect(restored).not.toBeNull();
    expect(restored).toBe(`---${eol}status: orig${eol}${eol}---${eol}Body${eol}`);
    expect(splitFrontmatter(restored!).data).toEqual({ status: 'orig' });
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('removes only the style line terminator before new neighbor metadata for %s', (_name, eol) => {
    const source = `---${eol}status: orig${eol}---${eol}Body${eol}`;
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    expect(applied).not.toBeNull();

    const edited = applied!.replace(
      `width: wide${eol}---${eol}Body${eol}`,
      `width: wide \t${eol}owner: Alice${eol}---${eol}Body${eol}`,
    );
    const restored = restoreInheritedMorrowNoteStyleFile(edited, STYLE, context!);
    expect(restored).toBe(`---${eol}status: orig${eol}owner: Alice${eol}---${eol}Body${eol}`);
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])(
    'does not leave an initial blank line before new owner metadata for a new note using %s body',
    (_name, bodyEol) => {
      const source = `Body${bodyEol}`;
      const context = captureInheritedMorrowNoteStyleContext(source);
      const applied = updateMorrowNoteStyleFile(source, STYLE);
      expect(applied).not.toBeNull();

      const edited = applied!.replace(
        `width: wide\n---\nBody${bodyEol}`,
        `width: wide \t\nowner: Alice\n---\nBody edited${bodyEol}`,
      );
      const restored = restoreInheritedMorrowNoteStyleFile(edited, STYLE, context!);
      expect(restored).toBe(`---\nowner: Alice\n---\nBody edited${bodyEol}`);
    },
  );

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('discards trailing horizontal whitespace without keeping it as a neighbor for %s', (_name, eol) => {
    const style = { ...STYLE, width: 'comfortable' as const };
    const source = `---${eol}status: orig${eol}---${eol}Body${eol}`;
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, style);
    expect(applied).not.toBeNull();

    const edited = applied!.replace(
      `width: comfortable${eol}---${eol}Body${eol}`,
      `width: comfortable \t${eol}---${eol}Body${eol}`,
    );
    const restored = restoreInheritedMorrowNoteStyleFile(edited, style, context!);
    expect(restored).toBe(source);
  });

  it.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('keeps the blank line after a horizontal-whitespace style terminator for %s', (_name, eol) => {
    const style = { ...STYLE, width: 'comfortable' as const };
    const source = `---${eol}status: orig${eol}---${eol}Body${eol}`;
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, style);
    expect(applied).not.toBeNull();

    const edited = applied!.replace(
      `width: comfortable${eol}---${eol}Body${eol}`,
      `width: comfortable \t${eol}${eol}---${eol}Body${eol}`,
    );
    const restored = restoreInheritedMorrowNoteStyleFile(edited, style, context!);
    expect(restored).toBe(`---${eol}status: orig${eol}${eol}---${eol}Body${eol}`);
  });

  it('restores an empty existing envelope if its previous YAML neighbor was removed', () => {
    const source = '---\nstatus: orig\n---\nBody\n';
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    expect(applied).not.toBeNull();

    const edited = applied!.replace('status: orig\n', '');
    const restored = restoreInheritedMorrowNoteStyleFile(edited, STYLE, context!);
    expect(restored).not.toBeNull();
    expect(restored).toBe('---\n\n---\nBody\n');
    expect(splitFrontmatter(restored!).data).toEqual({});
    expect(splitFrontmatter(restored!).body).toBe('Body\n');
  });

  it('refuses to remove the created envelope when edited body bytes would become frontmatter', () => {
    const source = 'Original body\n';
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    expect(applied).not.toBeNull();

    const editedBody = '---\ntag: later\n---\nBody\n';
    const edited = applied!.replace('Original body\n', editedBody);
    expect(splitFrontmatter(edited).body).toBe(editedBody);
    expect(restoreInheritedMorrowNoteStyleFile(edited, STYLE, context!)).toBeNull();
    expect(splitFrontmatter(edited).data?.morrowNoteStyle).toEqual(STYLE);
  });

  it.each([
    ['font', { ...STYLE, font: 'mono' }],
    ['size', { ...STYLE, fontSize: 20 }],
    ['line height', { ...STYLE, lineHeight: 1.9 }],
    ['spacing', { ...STYLE, blockSpacing: 18 }],
    ['width', { ...STYLE, width: 'full' }],
  ])('refuses a changed applied %s', (_name, changedStyle) => {
    const source = 'Body\n';
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    const changed = updateMorrowNoteStyleFile(applied!, changedStyle as NoteStyle);
    expect(changed).not.toBeNull();
    expect(restoreInheritedMorrowNoteStyleFile(changed!, STYLE, context!)).toBeNull();
  });

  it.each([
    [
      'new nested style entry',
      (applied: string) => applied.replace('  width: wide', '  width: wide\n  futureFlag: true'),
    ],
    [
      'comment inside the style block',
      (applied: string) => applied.replace('  font: serif', '  # keep this later comment\n  font: serif'),
    ],
    [
      'flow style map',
      (applied: string) =>
        applied.replace(
          /morrowNoteStyle:\n(?:[ \t]{2}.*\n){5}/,
          'morrowNoteStyle: { font: serif, fontSize: 19.5, lineHeight: 1.82, blockSpacing: 13, width: wide }\n',
        ),
    ],
  ])('refuses %s rather than discarding it', (_name, edit) => {
    const source = 'Body\n';
    const context = captureInheritedMorrowNoteStyleContext(source);
    const applied = updateMorrowNoteStyleFile(source, STYLE);
    const changed = edit(applied!);
    expect(restoreInheritedMorrowNoteStyleFile(changed, STYLE, context!)).toBeNull();
  });
});
