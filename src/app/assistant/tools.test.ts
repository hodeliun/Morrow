import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDef, DocNode, ViewDef } from '../../core/model';
import { markdownToDoc } from '../../core/markdown/parse';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { registerCommit } from '../editor/commits';
import { getState, setSession } from '../workspace';
import { pageMarkdown, runTool } from './tools';
import type { Proposal } from './tools';

// navigation is not part of these tests
vi.mock('../router', () => ({ openPage: vi.fn(), activeRoute: () => ({ name: 'home' }) }));

let counter = 0;
let vault: MemoryVault;
let session: WorkspaceSession;

beforeEach(async () => {
  vault = new MemoryVault({
    'Garden.md': '# Garden\n\nPlant tomatoes in May.\n\n## Pests\n\nSlugs love tomatoes.\n',
    'Secret.md': 'nothing here\n',
  });
  const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `id${++counter}`), {
    delayMs: 0,
  });
  if (!opened.ok) throw new Error(opened.error);
  session = opened.value;
  setSession(session);
});

const idOf = (title: string) => Object.values(getState().pages).find((page) => page.title === title)!.id;
const call = (name: string, input: Record<string, unknown>) => runTool({ id: 't', name, input });
const proposal = (outcome: ReturnType<typeof runTool>): Proposal => {
  if (outcome.kind !== 'proposal') throw new Error(`expected a proposal, got ${JSON.stringify(outcome)}`);
  return outcome.proposal;
};

function view(id: string, name: string): ViewDef {
  return {
    id,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
  };
}

function seedLinkedView(): { pageId: string; original: DocNode; markdown: string } {
  const database: DatabaseDef = { properties: [], views: [view('source-view', 'Source')] };
  const created = session.execute({
    type: 'page.create',
    id: 'source-db',
    parentId: null,
    title: 'Source database',
    kind: 'database',
    database,
    now: 1,
  });
  if (!created.ok) throw new Error(created.error);
  const pageId = idOf('Garden');
  const initial = session.getState().docs[pageId]!;
  const doc: DocNode = {
    ...initial,
    content: [
      ...(initial.content ?? []),
      {
        type: 'linkedDatabaseView',
        attrs: {
          hostPageId: pageId,
          sourceDatabaseId: 'source-db',
          blockId: 'linked-block',
          view: view('linked-view', 'Primary'),
          viewRawState: null,
        },
      },
    ],
  };
  const updated = session.execute({ type: 'page.setDoc', id: pageId, doc, now: 2 });
  if (!updated.ok) throw new Error(updated.error);
  const original = session.getState().docs[pageId]!;
  return { pageId, original, markdown: pageMarkdown(session.getState(), original) };
}

describe('assistant tools', () => {
  it('search and read pages as morrow markdown', () => {
    const found = call('search_pages', { query: 'slugs' });
    expect(found).toMatchObject({ kind: 'result' });
    expect(found.kind === 'result' && found.content).toContain(`Garden (id: ${idOf('Garden')}`);
    const read = call('read_page', { page: 'Garden' });
    expect(read.kind === 'result' && read.content).toContain('# Garden\n\nPlant tomatoes in May.');
  });

  it('edits only after approval, keeps the old version, and undoes', async () => {
    const edit = proposal(
      call('edit_page', {
        page: 'Garden',
        find: 'Slugs love tomatoes.',
        replace: 'Slugs love tomatoes.\n\n- [ ] Set traps',
      }),
    );
    // the user's own heading stays, only the new lines are added
    expect(edit.after).toContain('# Garden');
    expect(edit.after).toContain('- [ ] Set traps');
    expect(vault.text('Garden.md')).not.toContain('Set traps');
    const applied = await edit.apply();
    await session.flush();
    expect(vault.text('Garden.md')).toBe(
      '# Garden\n\nPlant tomatoes in May.\n\n## Pests\n\nSlugs love tomatoes.\n\n- [ ] Set traps\n',
    );
    const versions = await session.listSnapshots(idOf('Garden'));
    expect(
      versions.some(
        (version) =>
          JSON.stringify(version.doc).includes('Slugs') && !JSON.stringify(version.doc).includes('traps'),
      ),
    ).toBe(true);
    applied.undo();
    await session.flush();
    expect(vault.text('Garden.md')).not.toContain('Set traps');
  });

  it('blocks a linked-marker proposal when another pane commits during keepVersion', async () => {
    const { pageId, original } = seedLinkedView();
    const edit = proposal(call('edit_page', { page: 'Garden', find: 'Primary', replace: 'Renamed' }));
    const rawParsed = markdownToDoc(edit.after);
    expect(rawParsed.content!.find((node) => node.type === 'linkedDatabaseView')!.attrs?.hostPageId).toBeUndefined();
    const changedDuringAwait = structuredClone(original);
    changedDuringAwait.content![0]!.content![0]!.text = 'Committed from another pane';
    const keepVersion = session.keepVersion.bind(session);
    vi.spyOn(session, 'keepVersion').mockImplementation(async (id) => {
      await keepVersion(id);
      const changed = session.execute({
        type: 'page.setDoc',
        id: pageId,
        doc: changedDuringAwait,
        now: 3,
      });
      if (!changed.ok) throw new Error(changed.error);
    });

    await expect(edit.apply()).rejects.toThrow('The page changed in the meantime. Read it again before changing it.');
    const current = session.getState().docs[pageId]!;
    expect(current.content![0]!.content![0]!.text).toBe('Committed from another pane');
    expect((current.content!.find((node) => node.type === 'linkedDatabaseView')!.attrs?.view as ViewDef).name).toBe(
      'Primary',
    );
    expect(edit.after).toContain('Renamed');
  });

  it('guards the returned undo closure when another pane has a pending linked-host edit', async () => {
    const { pageId } = seedLinkedView();
    const edit = proposal(call('edit_page', { page: 'Garden', find: 'Primary', replace: 'Renamed' }));
    const applied = await edit.apply();
    const appliedLink = session.getState().docs[pageId]!.content!.find((node) => node.type === 'linkedDatabaseView')!;
    expect(appliedLink.attrs?.hostPageId).toBe(pageId);
    expect((appliedLink.attrs?.view as ViewDef).name).toBe('Renamed');

    const pendingPaneDoc = structuredClone(session.getState().docs[pageId]!);
    pendingPaneDoc.content![0]!.content![0]!.text = 'Pending text from another pane';
    const unregister = registerCommit(() => {
      const committed = session.execute({ type: 'page.setDoc', id: pageId, doc: pendingPaneDoc, now: 4 });
      if (!committed.ok) throw new Error(committed.error);
    });
    try {
      expect(() => applied.undo()).toThrow('The page changed in the meantime. Read it again before changing it.');
    } finally {
      unregister();
    }

    const current = session.getState().docs[pageId]!;
    expect(current.content![0]!.content![0]!.text).toBe('Pending text from another pane');
    expect((current.content!.find((node) => node.type === 'linkedDatabaseView')!.attrs?.view as ViewDef).name).toBe(
      'Renamed',
    );
  });

  it('keeps each version before every change, without copies of the same one', async () => {
    for (const line of ['First', 'Second', 'Third']) {
      // typing still waiting to be saved goes into the version kept before the change
      session.execute({
        type: 'page.setDoc',
        id: idOf('Garden'),
        doc: {
          ...session.getState().docs[idOf('Garden')]!,
          content: [
            ...session.getState().docs[idOf('Garden')]!.content!,
            { type: 'paragraph', content: [{ type: 'text', text: `typed ${line}` }] },
          ],
        },
        now: Date.now(),
      });
      await proposal(call('append_to_page', { page: 'Garden', markdown: `${line} added` })).apply();
    }
    await session.flush();
    const versions = (await session.listSnapshots(idOf('Garden'))).map((version) =>
      JSON.stringify(version.doc),
    );
    expect(new Set(versions).size).toBe(versions.length);
    for (const line of ['First', 'Second', 'Third'])
      expect(versions.some((text) => text.includes(`typed ${line}`) && !text.includes(`${line} added`))).toBe(
        true,
      );
  });

  it('refuses edits that do not match exactly once', () => {
    expect(call('edit_page', { page: 'Garden', find: 'not there', replace: 'x' })).toMatchObject({
      isError: true,
    });
    expect(call('edit_page', { page: 'Garden', find: 'tomatoes', replace: 'x' })).toMatchObject({
      isError: true,
    });
  });

  it('makes new pages without repeating the title or keeping frontmatter', async () => {
    const create = proposal(
      call('create_page', {
        title: 'Soup',
        markdown: '---\ntags: [food]\n---\n# Soup\n\nTomato soup with [[Garden]] tomatoes.',
      }),
    );
    await create.apply();
    await session.flush();
    expect(vault.text('Soup.md')).toBe('Tomato soup with [[Garden]] tomatoes.\n');
  });

  it('keeps locked pages out of reach', async () => {
    const locked = await session.protectPage(idOf('Secret'), 'correct horse');
    expect(locked.ok).toBe(true);
    expect(call('read_page', { page: 'Secret' })).toMatchObject({ isError: true });
    expect(call('append_to_page', { page: 'Secret', markdown: 'x' })).toMatchObject({ isError: true });
  });
});
