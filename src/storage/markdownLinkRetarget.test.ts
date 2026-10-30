import { describe, expect, it } from 'vitest';
import { markdownToDoc } from '../core/markdown/parse';
import { docToMarkdown } from '../core/markdown/serialize';
import type { DocNode, PageId } from '../core/model';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { retargetLinks, VaultRepository } from './vaultRepository';

let counter = 0;
const newId = () => `markdown-link-${++counter}`;

const doc = (...texts: string[]): DocNode => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

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

async function run(session: WorkspaceSession, command: Parameters<WorkspaceSession['execute']>[0]): Promise<void> {
  const result = session.execute(command);
  if (!result.ok) throw new Error(result.error);
  await session.flush();
}

describe('Markdown links to moved pages', () => {
  it('resolves relative Markdown links with query and fragment without writing during open', async () => {
    const href = './Target%20Name.md?view=compact%2Fmobile&mode=quick#section%20one';
    const source = `[Compact view](${href})\n`;
    const vault = new MemoryVault({
      'Folder/Host.md': source,
      'Folder/Target Name.md': 'Target body.\n',
      'Moved.md': 'Moved body.\n',
    });
    const initialFiles = [...vault.files.entries()];
    const session = await open(vault);
    const movedHref = '../Moved/Target%20Name.md?view=compact%2Fmobile&mode=quick#section%20one';
    try {
      const host = idOf(session, 'Host');
      const target = idOf(session, 'Target Name');
      const link = session.getState().docs[host]!.content![0]!.content![0]!;

      expect(link).toMatchObject({
        type: 'pageLink',
        attrs: { id: target, label: 'Compact view', markdownHref: href, anchor: 'section one' },
      });
      expect([...vault.files.entries()]).toEqual(initialFiles);

      await run(session, { type: 'page.move', id: target, parentId: idOf(session, 'Moved') });
      expect(vault.text('Folder/Host.md')).toBe(`[Compact view](${movedHref})\n`);
    } finally {
      await session.close();
    }

    const movedFiles = [...vault.files.entries()];
    const reopened = await open(vault);
    try {
      const host = idOf(reopened, 'Host');
      const target = idOf(reopened, 'Target Name');
      expect(reopened.getState().docs[host]!.content![0]!.content![0]!).toMatchObject({
        type: 'pageLink',
        attrs: { id: target, markdownHref: movedHref, anchor: 'section one' },
      });
      expect([...vault.files.entries()]).toEqual(movedFiles);
    } finally {
      await reopened.close();
    }
  });

  it('updates only the moved stable target while preserving Markdown labels, encoding, and fragments', () => {
    const source =
      '[Manual de campo](./Manuais/Manual%20antigo.md#p%C3%A1gina-4) and [Registro](/keep/Registro%20est%C3%A1tico.md#topo)';
    const parsed = markdownToDoc(source, {
      resolveLink: (href) => (href.includes('Manual%20antigo') ? 'manual' : 'record'),
    });

    expect(
      docToMarkdown(parsed, {
        markdownLinkTarget: (id) => (id === 'manual' ? './Anexos/Manual novo.md' : null),
      }),
    ).toBe(
      '[Manual de campo](./Anexos/Manual%20novo.md#p%C3%A1gina-4) and [Registro](/keep/Registro%20est%C3%A1tico.md#topo)\n',
    );
  });

  it('retargets a moved and renamed page through unrelated saves and reopen without rewriting untouched links', async () => {
    const hostSource = '[Section link](./Target.md#section%20two)\n';
    const untouchedSource = '[Static link](/Static.md#top)\n';
    const vault = new MemoryVault({
      'Host.md': hostSource,
      'Untouched.md': untouchedSource,
      'Folder.md': 'Folder body.\n',
      'Target.md': 'Target body.\n',
      'Static.md': 'Static body.\n',
      'Other.md': 'Other body.\n',
    });
    const session = await open(vault);
    const target = idOf(session, 'Target');
    const host = idOf(session, 'Host');
    const other = idOf(session, 'Other');

    await run(session, { type: 'page.move', id: target, parentId: idOf(session, 'Folder') });
    expect(vault.text('Host.md')).toBe('[Section link](./Folder/Target.md#section%20two)\n');
    await run(session, { type: 'page.rename', id: target, title: 'New Target', now: 20 });
    const movedHref = './Folder/New%20Target.md#section%20two';
    expect(vault.text('Host.md')).toBe(`[Section link](${movedHref})\n`);

    const hostDoc = structuredClone(session.getState().docs[host]!);
    hostDoc.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'Edited after the move.' }] });
    await run(session, { type: 'page.setDoc', id: host, doc: hostDoc, now: 21 });
    expect(vault.text('Host.md')).toContain(`[Section link](${movedHref})`);
    expect(vault.text('Host.md')).toContain('Edited after the move.');

    await run(session, { type: 'page.setDoc', id: other, doc: doc('Unrelated edit.'), now: 22 });
    const hostAfterUnrelatedEdit = vault.text('Host.md');
    expect(hostAfterUnrelatedEdit).toContain(`[Section link](${movedHref})`);
    expect(vault.text('Untouched.md')).toBe(untouchedSource);
    await session.close();

    const reopened = await open(vault);
    expect(idOf(reopened, 'New Target')).toBe(target);
    const link = reopened.getState().docs[host]!.content![0]!.content![0]!;
    expect(link).toMatchObject({ type: 'pageLink', attrs: { id: target, markdownHref: movedHref } });
    expect(vault.text('Host.md')).toBe(hostAfterUnrelatedEdit);
    expect(vault.text('Untouched.md')).toBe(untouchedSource);
    await reopened.close();
  });

  it('retargets a relative link when only its host page moves', async () => {
    const source = '[Section link](./Target.md#frag)\n';
    const vault = new MemoryVault({
      'Host.md': source,
      'Plain Host.md': '[Section link](Target.md#frag)\n',
      'Folder.md': 'Folder body.\n',
      'Target.md': 'Target body.\n',
    });
    const session = await open(vault);

    await run(session, {
      type: 'page.move',
      id: idOf(session, 'Host'),
      parentId: idOf(session, 'Folder'),
    });
    await run(session, {
      type: 'page.move',
      id: idOf(session, 'Plain Host'),
      parentId: idOf(session, 'Folder'),
    });

    expect(vault.text('Folder/Host.md')).toBe('[Section link](../Target.md#frag)\n');
    expect(vault.text('Folder/Plain Host.md')).toBe('[Section link](../Target.md#frag)\n');
    expect(vault.text('Target.md')).toBe('Target body.\n');

    const host = idOf(session, 'Host');
    const edited = structuredClone(session.getState().docs[host]!);
    edited.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'Edited after moving.' }] });
    await run(session, { type: 'page.setDoc', id: host, doc: edited, now: 41 });
    expect(vault.text('Folder/Host.md')).toContain('[Section link](../Target.md#frag)');
    expect(vault.text('Folder/Host.md')).toContain('Edited after moving.');

    const plainHost = idOf(session, 'Plain Host');
    const plainEdited = structuredClone(session.getState().docs[plainHost]!);
    plainEdited.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'Edited without dot slash.' }] });
    await run(session, { type: 'page.setDoc', id: plainHost, doc: plainEdited, now: 42 });
    expect(vault.text('Folder/Plain Host.md')).toContain('[Section link](../Target.md#frag)');
    expect(vault.text('Folder/Plain Host.md')).toContain('Edited without dot slash.');
    await session.close();
  });

  it('leaves a relative link unchanged when its host and target move with their parent folder', async () => {
    const source = '[Section link](./Target.md#frag)\n';
    const vault = new MemoryVault({
      'Container.md': 'Container body.\n',
      'Folder.md': 'Folder body.\n',
      'Folder/Host.md': source,
      'Folder/Target.md': 'Target body.\n',
    });
    const session = await open(vault);
    const folder = idOf(session, 'Folder');

    await run(session, { type: 'page.move', id: folder, parentId: idOf(session, 'Container') });

    expect(vault.text('Container/Folder/Host.md')).toBe(source);
    expect(vault.text('Container/Folder/Target.md')).toBe('Target body.\n');
    await session.close();
  });

  it('does not rewrite a relative link when the host filename changes within the same folder', async () => {
    const source = '[Section link](./Target.md#frag)\n';
    const vault = new MemoryVault({ 'Host.md': source, 'Target.md': 'Target body.\n' });
    const session = await open(vault);

    await run(session, {
      type: 'page.rename',
      id: idOf(session, 'Host'),
      title: 'Renamed Host',
      now: 40,
    });

    expect(vault.text('Renamed Host.md')).toBe(source);
    await session.close();
  });

  it('retargets only inline links outside code and escaped syntax, preserving titles', () => {
    const source = [
      '[active](./Target.md#frag "keep this title")',
      '`[single code](./Target.md)`',
      '``[double code](./Target.md)``',
      '`[multiline code](./Target.md)\ncontinued`',
      String.raw`\[escaped](./Target.md)`,
      '```md',
      '[fenced](./Target.md)',
      '```',
    ].join('\n');

    expect(
      retargetLinks(source, () => null, (href) =>
        href.startsWith('./Target.md') ? './Folder/Target.md' : null,
      ),
    ).toBe(
      [
        '[active](./Folder/Target.md#frag "keep this title")',
        '`[single code](./Target.md)`',
        '``[double code](./Target.md)``',
        '`[multiline code](./Target.md)\ncontinued`',
        String.raw`\[escaped](./Target.md)`,
        '```md',
        '[fenced](./Target.md)',
        '```',
      ].join('\n'),
    );
  });

  it('preserves a long malformed label without repeated lookahead', () => {
    const malformed = '['.repeat(10_000) + '(./Target.md';
    expect(retargetLinks(malformed, () => null, () => './Moved.md')).toBe(malformed);
  });
});
