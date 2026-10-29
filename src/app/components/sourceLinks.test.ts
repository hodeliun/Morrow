import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '../../core/markdown/parse';
import type { DocNode, PageId } from '../../core/model';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { sourceFileResolver, sourceMarkdown, sourceMarkdownParseOptions } from './sourceLinks';

let counter = 0;
const newId = () => `source-links-${++counter}`;

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const session = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
  if (!session.ok) throw new Error(session.error);
  return session.value;
}

function idOf(session: WorkspaceSession, title: string): PageId {
  const page = Object.values(session.getState().pages).find((candidate) => candidate.title === title);
  if (!page) throw new Error(`no page ${title}`);
  return page.id;
}

async function run(session: WorkspaceSession, command: Parameters<WorkspaceSession['execute']>[0]) {
  const result = session.execute(command);
  if (!result.ok) throw new Error(result.error);
  await session.flush();
}

const textDoc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('Markdown source path adapter', () => {
  it('round-trips the stable link after target rename, source edit, unrelated save, and reopen', async () => {
    const vault = new MemoryVault({
      'Host.md': '[Section link](./Target.md#part%20two)\n',
      'Target.md': 'Target body.\n',
      'Other.md': 'Other body.\n',
    });
    const session = await open(vault);
    const host = idOf(session, 'Host');
    const target = idOf(session, 'Target');
    const other = idOf(session, 'Other');
    const pathOf = (id: PageId) => session.pathOf(id);

    await run(session, { type: 'page.rename', id: target, title: 'Renamed Target', now: 50 });
    const source = sourceMarkdown(session.getState().docs[host]!, session.getState(), host, pathOf);
    const updatedHref = './Renamed%20Target.md#part%20two';
    expect(source).toContain(`[Section link](${updatedHref})`);

    const state = session.getState();
    const parsed = markdownToDoc(`${source}\nAn unrelated source edit.\n`, {
      ...sourceMarkdownParseOptions(state, host, pathOf),
    });
    await run(session, { type: 'page.setDoc', id: host, doc: parsed, now: 51 });
    expect(vault.text('Host.md')).toContain(`[Section link](${updatedHref})`);

    await run(session, { type: 'page.setDoc', id: other, doc: textDoc('Unrelated edit.'), now: 52 });
    await session.close();

    const reopened = await open(vault);
    expect(idOf(reopened, 'Renamed Target')).toBe(target);
    const link = reopened.getState().docs[host]!.content![0]!.content![0]!;
    expect(link).toMatchObject({
      type: 'pageLink',
      attrs: { id: target, markdownHref: updatedHref },
    });
    expect(vault.text('Host.md')).toContain(`[Section link](${updatedHref})`);
    await reopened.close();
  });

  it('decodes a percent-encoded literal percent path once when a space filename also exists', async () => {
    const vault = new MemoryVault({
      'Host.md': '[Literal percent](./Percent%2520name.md#part%20two)\n',
      'Percent%20name.md': '# Literal percent target\n',
      'Percent name.md': '# Decoded space target\n',
    });
    const session = await open(vault);
    const host = idOf(session, 'Host');
    const pathOf = (id: PageId) => session.pathOf(id);
    const pages = Object.values(session.getState().pages);
    const literalPercentTarget = pages.find((page) => pathOf(page.id) === 'Percent%20name.md');
    const decodedSpaceTarget = pages.find((page) => pathOf(page.id) === 'Percent name.md');
    if (!literalPercentTarget || !decodedSpaceTarget) throw new Error('Both synthetic percent-path pages must load.');

    const source = vault.text('Host.md')!;
    const parsed = markdownToDoc(source, {
      ...sourceMarkdownParseOptions(session.getState(), host, pathOf),
    });
    const link = parsed.content?.[0]?.content?.[0];

    expect(link).toMatchObject({
      type: 'pageLink',
      attrs: { id: literalPercentTarget.id, markdownHref: './Percent%2520name.md#part%20two' },
    });
    expect(literalPercentTarget.id).not.toBe(decodedSpaceTarget.id);
    expect(sourceMarkdown(parsed, session.getState(), host, pathOf)).toContain(
      '[Literal percent](./Percent%2520name.md#part%20two)',
    );
    await session.close();
  });

  it('retargets a renamed space filename to a literal percent filename without changing its fragment', async () => {
    const vault = new MemoryVault({
      'Host.md': '[Section](./Folder/Percent%20name.md#part%20two)\n',
      'Folder/Percent name.md': 'Target body stays.\n',
      'Other/Percent%20name.md': 'Coexisting literal-percent filename.\n',
      'Untouched.md': 'Untouched bytes stay.\n',
    });
    const session = await open(vault);
    const pathOf = (id: PageId) => session.pathOf(id);
    const target = Object.values(session.getState().pages).find(
      (page) => pathOf(page.id) === 'Folder/Percent name.md',
    );
    const host = idOf(session, 'Host');
    if (!target) throw new Error('Synthetic space-filename target must load.');
    const targetId = target.id;
    const untouchedBytes = vault.text('Untouched.md');
    const coexistingLiteralBytes = vault.text('Other/Percent%20name.md');

    await run(session, { type: 'page.rename', id: targetId, title: 'Percent%20name', now: 60 });

    const updatedPath = 'Folder/Percent%20name.md';
    const updatedHref = './Folder/Percent%2520name.md#part%20two';
    expect(session.pathOf(targetId)).toBe(updatedPath);
    expect(vault.text('Folder/Percent name.md')).toBeUndefined();
    expect(vault.text(updatedPath)).toContain('Target body stays.');
    expect(vault.text('Host.md')).toContain(`[Section](${updatedHref})`);
    expect(vault.text('Untouched.md')).toBe(untouchedBytes);
    expect(vault.text('Other/Percent%20name.md')).toBe(coexistingLiteralBytes);

    const reopened = await open(vault);
    expect(reopened.pathOf(targetId)).toBe(updatedPath);
    expect(Object.values(reopened.getState().pages).find((page) => page.id === targetId)?.title).toBe(
      'Percent%20name',
    );
    const reopenedLink = reopened.getState().docs[host]!.content![0]!.content![0]!;
    expect(reopenedLink).toMatchObject({
      type: 'pageLink',
      attrs: { id: targetId, markdownHref: updatedHref },
    });
    expect(vault.text('Host.md')).toContain(`[Section](${updatedHref})`);
    expect(vault.text('Untouched.md')).toBe(untouchedBytes);
    await reopened.close();
  });

  it('resolves nested media paths in context and never maps remote or ambiguous names locally', async () => {
    const vault = new MemoryVault({
      'Notes/Nested/Host.md': 'Host body.\n',
      'attachments/left/photo same.png': 'test image bytes',
      'attachments/right/photo same.png': 'other test image bytes',
      'attachments/docs/manual same.pdf': 'test document bytes',
    });
    const session = await open(vault);
    const state = session.getState();
    const host = idOf(session, 'Host');
    const sourcePath = session.pathOf(host)!;
    const sourceDir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
    const files = await session.listFiles();
    const text = [
      '![Left](../../attachments/left/photo%20same.png?size=1#view)',
      '![Right](../../attachments/right/photo%20same.png#right)',
      '[Manual](../../attachments/docs/manual%20same.pdf?download=1#page%202)',
      '![Remote](https://remote.example/photo%20same.png)',
      '[Remote manual](https://remote.example/manual%20same.pdf)',
      '![Fragment](#photo%20same.png)',
      '![Outside](../../../attachments/left/photo%20same.png)',
    ].join('\n\n');
    const parsed = markdownToDoc(text, {
      ...sourceMarkdownParseOptions(state, host, (id) => session.pathOf(id), sourceFileResolver(files, sourceDir)),
    });
    const nodes: DocNode[] = [];
    const visit = (node: DocNode) => {
      nodes.push(node);
      for (const child of node.content ?? []) visit(child);
    };
    visit(parsed);

    const images = nodes.filter((node) => node.type === 'image');
    expect(images.map((node) => node.attrs?.fileId)).toEqual([
      'attachments/left/photo same.png',
      'attachments/right/photo same.png',
      null,
      null,
      null,
    ]);
    const manualLink = nodes.find(
      (node) => node.type === 'fileAttachment' && node.attrs?.markdownHref === '../../attachments/docs/manual%20same.pdf?download=1#page%202',
    );
    expect(manualLink?.attrs).toMatchObject({
      fileId: 'attachments/docs/manual same.pdf',
      name: 'manual same.pdf',
    });
    const remoteLink = nodes.find((node) =>
      node.marks?.some((mark) => mark.type === 'link' && mark.attrs?.href === 'https://remote.example/manual%20same.pdf'),
    );
    expect(remoteLink?.marks?.find((mark) => mark.type === 'link')?.attrs?.fileRef).toBeUndefined();

    const pathlessResolver = sourceFileResolver(files, null);
    expect(pathlessResolver('photo%20same.png')).toBeNull();
    expect(sourceFileResolver(files, sourceDir)('photo%20same.png')).toBeNull();
    expect(pathlessResolver('attachments/left/photo%20same.png')).toMatchObject({
      fileId: 'attachments/left/photo same.png',
    });
    await session.close();
  });

  it('serializes source media relative to a nested host and preserves root-relative hrefs', async () => {
    const vault = new MemoryVault({ 'Notes/Nested/Host.md': 'Host body.\n' });
    const session = await open(vault);
    const state = session.getState();
    const host = idOf(session, 'Host');
    const pathOf = (id: PageId) => session.pathOf(id);
    const mediaDoc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            fileId: 'attachments/left/photo same.png',
            alt: 'Photo',
            markdownHref: '../../attachments/left/photo%20same.png?size=1#view',
          },
        },
        {
          type: 'fileAttachment',
          attrs: {
            fileId: 'attachments/docs/manual same.pdf',
            name: 'manual same.pdf',
            markdownHref: '../../attachments/docs/manual%20same.pdf?download=1#page%202',
          },
        },
        {
          type: 'image',
          attrs: {
            fileId: 'attachments/left/photo same.png',
            alt: 'Root style',
            markdownHref: '/attachments/left/photo%20same.png#root',
          },
        },
      ],
    };
    const source = sourceMarkdown(mediaDoc, state, host, pathOf);
    expect(source).toContain('![Photo](../../attachments/left/photo%20same.png?size=1#view)');
    expect(source).toContain('[manual same.pdf](../../attachments/docs/manual%20same.pdf?download=1#page%202)');
    expect(source).toContain('![Root style](/attachments/left/photo%20same.png#root)');
    await session.close();
  });

  it('escapes a literal percent in a real file path when the original href names a space', async () => {
    const vault = new MemoryVault({ 'Notes/Host.md': 'Host body.\n' });
    const session = await open(vault);
    const host = idOf(session, 'Host');
    const fileDoc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'image',
          attrs: {
            fileId: 'attachments/photo%20name.png',
            alt: 'Literal percent path',
            markdownHref: '../attachments/photo%20name.png?size=1#view',
          },
        },
      ],
    };

    const source = sourceMarkdown(fileDoc, session.getState(), host, (id) => session.pathOf(id));

    expect(source).toContain('![Literal percent path](../attachments/photo%2520name.png?size=1#view)');
    await session.close();
  });
});
