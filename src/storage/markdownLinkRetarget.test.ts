import { describe, expect, it } from 'vitest';
import type { DocNode, PageId } from '../core/model';
import { walk } from '../core/doc';
import type { Command } from '../core/commands';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { retargetLinks, VaultRepository } from './vaultRepository';

let generatedId = 0;
const newId = () => `markdown-link-${++generatedId}`;

function registryFor(paths: string[]): string {
  return JSON.stringify({
    version: 1,
    pages: Object.fromEntries(paths.map((path, index) => [path, { id: `markdown-link-page-${index + 1}` }])),
  });
}

function vaultFiles(files: Record<string, string>): Record<string, string> {
  return {
    ...files,
    '.morrow/workspace.json': registryFor(Object.keys(files)),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

function makeVault(files: Record<string, string>): MemoryVault {
  return new MemoryVault(vaultFiles(files));
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
  if (!opened.ok) throw new Error(opened.error);
  const saved = await opened.value.flush();
  if (!saved) throw new Error('The synthetic vault did not finish its initial save.');
  return opened.value;
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

async function runAll(session: WorkspaceSession, commands: Command[]): Promise<void> {
  const result = session.executeAll(commands);
  if (!result.ok) throw new Error(result.error);
  if (!(await session.flush())) throw new Error('The synthetic vault failed to save the requested commands.');
}

function markdownPageLinks(doc: DocNode): DocNode[] {
  const links: DocNode[] = [];
  walk(doc, (node) => {
    if (node.type === 'pageLink' && typeof node.attrs?.markdownHref === 'string') links.push(node);
    return true;
  });
  return links;
}

function fingerprint(
  vault: MemoryVault,
  path: string,
): { text: string | undefined; mtime: number | undefined } {
  return { text: vault.text(path), mtime: vault.modifiedTime(path) };
}

class ConflictMemoryVault extends MemoryVault {
  conflictBeforeNextApply: { path: string; text: string } | null = null;

  override async apply(operations: Parameters<MemoryVault['apply']>[0]) {
    const conflict = this.conflictBeforeNextApply;
    if (conflict) {
      this.files.set(conflict.path, conflict.text);
      this.conflictBeforeNextApply = null;
    }
    return super.apply(operations);
  }
}

describe('Markdown page link retargeting through the vault repository', () => {
  it('keeps wiki-looking text in Markdown destinations and code spans untouched', () => {
    const markdown =
      '[some `code [[WikiTarget]]` label](./Target.md?mode=[[WikiTarget]]#Section) [[WikiTarget]]\n';
    const updated = retargetLinks(
      markdown,
      (target) => (target === 'WikiTarget' ? 'RenamedWikiTarget' : null),
      (href) => (href === './Target.md?mode=[[WikiTarget]]#Section' ? '../Moved/Target.md' : null),
    );

    expect(updated).toBe(
      '[some `code [[WikiTarget]]` label](../Moved/Target.md?mode=[[WikiTarget]]#Section) [[RenamedWikiTarget]]\n',
    );
  });

  it('maps table destinations near both ends of a long supported row', () => {
    const href = './Target.md?q=a#z';
    const movedHref = '../Moved/Target.md?q=a#z';
    const longCell = 'x'.repeat(300_000);
    const body = [
      '| First | Second |',
      '| - | - |',
      `| [first](${href}) | ${longCell} [last](${href}) |`,
    ].join('\n');

    const updated = retargetLinks(
      body,
      () => null,
      (original) => (original === href ? '../Moved/Target.md' : null),
    );

    expect(updated).toContain(`[first](${movedHref})`);
    expect(updated).toContain(`${longCell} [last](${movedHref})`);
  });

  it('retargets a moved destination by exact file path and preserves raw suffixes and unrelated files', async () => {
    const oldHref = './Target.md?view=compact&amp;token=%2f#Section%2F';
    const rootHref = '/Notes/Target.md?root=1#Root%2F';
    const originalBody = [
      `[Open &amp; target](${oldHref})`,
      `[Root target](${rootHref})`,
      '![media](./Target.md)',
      '[external](https://example.org/Target.md)',
      '[ambiguous](Note.md)',
      '`[inline code](./Target.md)`',
      '<!-- [comment](./Target.md) -->',
      '```md',
      '[fenced](./Target.md)',
      '```',
      '    [indented code](./Target.md)',
      '- list item',
      '  ~~~md',
      '  [nested list fence](./Target.md)',
      '  ~~~~',
      '',
      '[after nested list fence](./Target.md)',
      '<div>',
      '[raw HTML block](./Target.md)',
      '</div>',
      '',
      '[after raw HTML block](./Target.md)',
      '[[Notes/Target]]',
      '[[WikiTarget]]',
      '',
    ].join('\n');
    const files = {
      'Notes/Source.md': originalBody,
      'Notes/Target.md': '# Original target\n',
      'Other/Target.md': '# Same basename elsewhere\n',
      'Left/Note.md': '# Ambiguous one\n',
      'Right/Note.md': '# Ambiguous two\n',
      'Notes/WikiTarget.md': '# Stable wiki target\n',
      'Archive/Keep.md': '# Keep folder\n',
      'Unrelated.md': 'Do not rewrite me.\n',
      'assets/guide.bin': 'binary placeholder bytes',
    };
    const vault = makeVault(files);
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const unchangedPaths = ['Other/Target.md', 'Unrelated.md', 'assets/guide.bin'];
    const unchangedBefore = Object.fromEntries(
      unchangedPaths.map((path) => [path, fingerprint(vault, path)]),
    );
    let sessionClosed = false;

    try {
      expect(markdownPageLinks(session.getState().docs[sourceId]!).map((link) => link.attrs?.id)).toEqual([
        targetId,
        targetId,
        targetId,
        targetId,
      ]);

      await runAll(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'Target (moved)', now: 1 },
      ]);

      const movedHref = '../Archive/Target%20%28moved%29.md?view=compact&amp;token=%2f#Section%2F';
      const movedRootHref = '/Archive/Target%20%28moved%29.md?root=1#Root%2F';
      const updatedBody = vault.text('Notes/Source.md')!;
      expect(session.pathOf(targetId)).toBe('Archive/Target (moved).md');
      expect(updatedBody).toContain(`[Open &amp; target](${movedHref})`);
      expect(updatedBody).toContain(`[Root target](${movedRootHref})`);
      expect(updatedBody).toContain('![media](./Target.md)');
      expect(updatedBody).toContain('[external](https://example.org/Target.md)');
      expect(updatedBody).toContain('[ambiguous](Note.md)');
      expect(updatedBody).toContain('`[inline code](./Target.md)`');
      expect(updatedBody).toContain('<!-- [comment](./Target.md) -->');
      expect(updatedBody).toContain('[fenced](./Target.md)');
      expect(updatedBody).toContain('    [indented code](./Target.md)');
      expect(updatedBody).toContain('  [nested list fence](./Target.md)');
      expect(updatedBody).toContain('[after nested list fence](../Archive/Target%20%28moved%29.md)');
      expect(updatedBody).toContain('<div>\n[raw HTML block](./Target.md)\n</div>');
      expect(updatedBody).toContain('[after raw HTML block](../Archive/Target%20%28moved%29.md)');
      expect(updatedBody).toContain('[[Target (moved)]]');
      expect(updatedBody).toContain('[[WikiTarget]]');
      expect(
        Object.fromEntries(unchangedPaths.map((path) => [path, fingerprint(vault, path)])),
        `Vault paths after move: ${JSON.stringify(vault.paths())}`,
      ).toEqual(unchangedBefore);

      await session.close();
      sessionClosed = true;
      const reopened = await open(vault);
      try {
        const reopenedSourceId = pageIdAt(reopened, 'Notes/Source.md');
        const reopenedTargetId = pageIdAt(reopened, 'Archive/Target (moved).md');
        const links = markdownPageLinks(reopened.getState().docs[reopenedSourceId]!);
        expect(reopenedTargetId).toBe(targetId);
        expect(links.map((link) => link.attrs?.id)).toEqual([targetId, targetId, targetId, targetId]);
        expect(links.map((link) => link.attrs?.markdownHref)).toEqual([
          movedHref,
          movedRootHref,
          '../Archive/Target%20%28moved%29.md',
          '../Archive/Target%20%28moved%29.md',
        ]);
        expect(links[0]!.attrs).toMatchObject({ alias: 'Open & target', anchor: 'Section/' });
        expect(links[1]!.attrs).toMatchObject({ alias: 'Root target', anchor: 'Root/' });
      } finally {
        await reopened.close();
      }
      return;
    } finally {
      if (!sessionClosed) await session.close();
    }
  });

  it('uses parser source ranges for eligible links across malformed, inline, math, table and nested content', async () => {
    const suffix = '?q=a#z';
    const originalHref = './Target.md' + suffix;
    const escapedTableHref = './Target.md?q=a\\|b#z';
    const eol = '\r\n';
    const body = [
      'An unmatched ` delimiter.',
      '',
      `[after unmatched](${originalHref})`,
      '',
      `<span title="[fake](${originalHref})">x</span> [inline real](${originalHref})`,
      '',
      '$$',
      `[math](${originalHref})`,
      '$$',
      '',
      `[after math](${originalHref})`,
      '',
      '    [indented code](./Target.md)',
      '',
      '- list item',
      '  ~~~md',
      '  [nested list fence](./Target.md)',
      '  ~~~~',
      '',
      '[after nested fence](./Target.md)',
      '',
      '<div>',
      '[raw HTML block](./Target.md)',
      '</div>',
      '',
      '[after raw HTML block](./Target.md)',
      '',
      '| A | B | C | D | E |',
      '| - | - | - | - | - |',
      `| a\\|b [first](${escapedTableHref}) | [same](${originalHref}) | [same](${originalHref}) | [[Notes/Target\\|Alias]] | [[Notes/Target\\|Alias]] |`,
      '',
      '[[Notes/Target]]',
      `[real](${originalHref})`,
      '',
      '[unfinished](',
      '',
      '> - [quoted](./Target.md?q=a#z)',
      '',
      '> - nested table follows',
      '>',
      '>   | A | B |',
      '>   | - | - |',
      `>   | a\\|b [nested first](${escapedTableHref}) | [nested second](${originalHref}) |`,
      '',
      '> - [multiline](',
      '>     ./Target.md?q=a#z',
      '>     "title"',
      '>   )',
      '',
    ].join(eol);
    const vault = makeVault({
      'Notes/Source.md': body,
      'Notes/Target.md': '# Target\n',
      'Archive/Keep.md': '# Keep folder\n',
    });
    const session = await open(vault);
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');

    try {
      await runAll(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'Target (moved)', now: 4 },
      ]);

      const href = `../Archive/Target%20%28moved%29.md${suffix}`;
      const updated = vault.text('Notes/Source.md')!;
      expect(updated).toContain('An unmatched ` delimiter.');
      expect(updated).toContain(`[after unmatched](${href})`);
      expect(updated).toContain(`<span title="[fake](${originalHref})">x</span> [inline real](${href})`);
      expect(updated).toContain('$$' + eol + `[math](${originalHref})` + eol + '$$');
      expect(updated).toContain(`[after math](${href})`);
      expect(updated).toContain('    [indented code](./Target.md)');
      expect(updated).toContain('  [nested list fence](./Target.md)');
      expect(updated).toContain('[after nested fence](../Archive/Target%20%28moved%29.md)');
      expect(updated).toContain('<div>' + eol + '[raw HTML block](./Target.md)' + eol + '</div>');
      expect(updated).toContain('[after raw HTML block](../Archive/Target%20%28moved%29.md)');
      expect(updated).toContain(
        `| a\\|b [first](../Archive/Target%20%28moved%29.md?q=a\\|b#z) | [same](${href}) | [same](${href}) | [[Target (moved)\\|Alias]] | [[Target (moved)\\|Alias]] |`,
      );
      expect(updated).toContain(`[[Target (moved)]]${eol}[real](${href})`);
      expect(updated).toContain('[unfinished](' + eol);
      expect(updated).toContain(`> - [quoted](${href})`);
      expect(updated).toContain(
        `>   | a\\|b [nested first](../Archive/Target%20%28moved%29.md?q=a\\|b#z) | [nested second](${href}) |`,
      );
      expect(updated).toContain(`> - [multiline](${eol}>     ${href}${eol}>     "title"${eol}>   )`);
      expect(markdownPageLinks(session.getState().docs[pageIdAt(session, 'Notes/Source.md')]!).length).toBe(
        13,
      );
    } finally {
      await session.close();
    }
  });

  it('retargets a moved source and uses the stable target ID when the stale link is serialized later', async () => {
    const href = './Target.md?mode=raw#Section';
    const body = `[Open target](${href})\n`;
    const files = {
      'Notes/Source.md': body,
      'Notes/Target.md': '# Intended target\n',
      'Archive/Target.md': '# Same basename, different page\n',
      'Archive/Keep.md': '# Keep folder\n',
      'Unrelated.md': 'Keep bytes and mtime.\n',
    };
    const vault = makeVault(files);
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const unrelatedBefore = fingerprint(vault, 'Unrelated.md');
    let sessionClosed = false;

    try {
      await runAll(session, [{ type: 'page.move', id: sourceId, parentId: archiveId }]);
      expect(session.pathOf(sourceId)).toBe('Archive/Source.md');
      expect(vault.text('Archive/Source.md')).toBe(`[Open target](../Notes/Target.md?mode=raw#Section)\n`);
      expect(markdownPageLinks(session.getState().docs[sourceId]!)[0]!.attrs?.markdownHref).toBe(href);

      const edited = structuredClone(session.getState().docs[sourceId]!);
      edited.content![0]!.content!.push({ type: 'text', text: ' edited after moving' });
      const result = session.execute({ type: 'page.setDoc', id: sourceId, doc: edited, now: 2 });
      if (!result.ok) throw new Error(result.error);
      expect(await session.flush()).toBe(true);

      expect(vault.text('Archive/Source.md')).toBe(
        `[Open target](../Notes/Target.md?mode=raw#Section) edited after moving\n`,
      );
      expect(pageIdAt(session, 'Notes/Target.md')).toBe(targetId);
      expect(fingerprint(vault, 'Unrelated.md')).toEqual(unrelatedBefore);

      await session.close();
      sessionClosed = true;
      const reopened = await open(vault);
      try {
        const reopenedSourceId = pageIdAt(reopened, 'Archive/Source.md');
        const reopenedTargetId = pageIdAt(reopened, 'Notes/Target.md');
        const link = markdownPageLinks(reopened.getState().docs[reopenedSourceId]!)[0]!;
        expect(reopenedTargetId).toBe(targetId);
        expect(link.attrs).toMatchObject({
          id: targetId,
          markdownHref: '../Notes/Target.md?mode=raw#Section',
          alias: 'Open target',
          anchor: 'Section',
        });
      } finally {
        await reopened.close();
      }
      return;
    } finally {
      if (!sessionClosed) await session.close();
    }
  });

  it('retargets simultaneous source and destination moves from their before and after paths', async () => {
    const files = {
      'Notes/Source.md': '[Target](./Target.md?view=full#Heading)\n',
      'Notes/Target.md': '# Target\n',
      'Archive/Keep.md': '# Archive\n',
      'Other/Keep.md': '# Other\n',
      'Unrelated.md': 'No churn.\n',
    };
    const vault = makeVault(files);
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const otherId = pageIdAt(session, 'Other');
    const unrelatedBefore = fingerprint(vault, 'Unrelated.md');

    try {
      await runAll(session, [
        { type: 'page.move', id: sourceId, parentId: archiveId },
        { type: 'page.move', id: targetId, parentId: otherId },
      ]);

      expect(session.pathOf(sourceId)).toBe('Archive/Source.md');
      expect(session.pathOf(targetId)).toBe('Other/Target.md');
      expect(vault.text('Archive/Source.md')).toBe('[Target](../Other/Target.md?view=full#Heading)\n');
      expect(fingerprint(vault, 'Unrelated.md')).toEqual(unrelatedBefore);
    } finally {
      await session.close();
    }
  });

  it('preserves an authored case variant when its exact resolver still identifies the same page', async () => {
    const href = './target.md?q=a#z';
    const vault = makeVault({
      'Notes/Source.md': `[Open target](${href})\n`,
      'Notes/Target.md': '# Target\n',
    });
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');

    try {
      expect(markdownPageLinks(session.getState().docs[sourceId]!)[0]!.attrs).toMatchObject({
        id: targetId,
        markdownHref: href,
      });
      const edited = structuredClone(session.getState().docs[sourceId]!);
      edited.content![0]!.content!.push({ type: 'text', text: ' edited' });
      const result = session.execute({ type: 'page.setDoc', id: sourceId, doc: edited, now: 3 });
      if (!result.ok) throw new Error(result.error);
      expect(await session.flush()).toBe(true);
      expect(vault.text('Notes/Source.md')).toBe(`[Open target](${href}) edited\n`);
    } finally {
      await session.close();
    }
  });

  it('checks a changed referrer before moving files and leaves its external bytes intact', async () => {
    const files = {
      'Notes/Source.md': '[Target](./Target.md?view=full#Heading)\n',
      'Notes/Target.md': '# Target\n',
      'Archive/Keep.md': '# Archive\n',
      'Unrelated.md': 'No churn.\n',
    };
    const vault = new ConflictMemoryVault(vaultFiles(files));
    const session = await open(vault);
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const externalSource = '[External edit made after opening]\n';

    try {
      vault.conflictBeforeNextApply = { path: 'Notes/Source.md', text: externalSource };
      const result = session.execute({ type: 'page.move', id: targetId, parentId: archiveId });
      if (!result.ok) throw new Error(result.error);
      expect(await session.flush()).toBe(false);
      expect(vault.text('Notes/Source.md')).toBe(externalSource);
      expect(vault.text('Notes/Target.md')).toBe('# Target\n');
      expect(vault.text('Archive/Target.md')).toBeUndefined();
      expect(session.pathOf(targetId)).toBe('Notes/Target.md');
    } finally {
      await session.close();
    }
  });
});
