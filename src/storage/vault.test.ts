import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canvasFromDoc } from '../core/canvas';
import type { Command } from '../core/commands';
import { encryptPage, newPageKey } from '../core/crypto';
import type { DocNode, PageId } from '../core/model';
import { sampleCommands } from '../core/sample';
import { MemoryVault } from './memoryVault';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let counter = 0;
const newId = () => `id${++counter}`;

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

async function run(session: WorkspaceSession, command: Command): Promise<void> {
  const result = session.execute(command);
  if (!result.ok) throw new Error(result.error);
  await session.flush();
}

const OBSIDIAN = {
  'Welcome.md': '---\ntags: [start]\ncssclasses: wide\n---\n# Hello\n\nSee [[Projects/Garden|the garden]].\n',
  'Projects.md': 'All my projects.\n',
  'Projects/Garden.md': 'Back to [[Welcome]].\n\n* loose   formatting  kept\n',
  'Ideas/Loose idea.md': 'Just a thought with ![[pic.png]]\n',
  'attachments/pic.png': 'PNG',
  'Board.canvas': JSON.stringify({
    nodes: [
      { id: 'a', type: 'text', text: 'hello', x: 0, y: 0, width: 200, height: 80 },
      { id: 'b', type: 'file', file: 'Projects/Garden.md', x: 300, y: 0, width: 200, height: 80 },
    ],
    edges: [{ id: 'e', fromNode: 'a', toNode: 'b' }],
  }),
  '.obsidian/app.json': '{}',
};

function fingerprint(vault: MemoryVault, paths: string[]) {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      {
        hash: createHash('sha256').update(vault.text(path) ?? '<missing>').digest('hex'),
        mtime: vault.modifiedTime(path),
      },
    ]),
  );
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`no page at ${path}`);
  return id;
}

describe('opening a folder of markdown files', () => {
  it('reads pages, folders, links, images and canvases', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const state = session.getState();
    const titles = Object.values(state.pages)
      .map((page) => page.title)
      .sort();
    expect(titles).toEqual(['Board', 'Garden', 'Ideas', 'Loose idea', 'Projects', 'Welcome']);
    const garden = idOf(session, 'Garden');
    expect(state.pages[garden]!.parentId).toBe(idOf(session, 'Projects'));
    expect(state.pages[idOf(session, 'Loose idea')]!.parentId).toBe(idOf(session, 'Ideas'));
    expect(state.pages[idOf(session, 'Welcome')]!.tags).toEqual(['start']);
    const link = state.docs[idOf(session, 'Welcome')]!.content![1]!.content![1]!;
    expect(link.attrs).toMatchObject({ id: garden, alias: 'the garden' });
    const image = state.docs[idOf(session, 'Loose idea')]!.content!.find((node) => node.type === 'image');
    expect(image?.attrs?.fileId).toBe('attachments/pic.png');
    const board = canvasFromDoc(state.docs[idOf(session, 'Board')]);
    expect(board.nodes[1]).toMatchObject({ type: 'page', pageId: garden });
    expect(session.firstRun).toBe(false);
    await session.close();
  });

  it('only rewrites the file that was edited and keeps unknown properties', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    await run(session, { type: 'page.setDoc', id: welcome, doc: doc('Rewritten'), now: 5 });
    expect(vault.text('Welcome.md')).toBe('---\ntags: [start]\ncssclasses: wide\n---\nRewritten\n');
    expect(vault.text('Projects/Garden.md')).toBe(OBSIDIAN['Projects/Garden.md']);
    expect(vault.text('Board.canvas')).toBe(OBSIDIAN['Board.canvas']);
    await session.close();
  });

  it('changes only the frontmatter when only an icon or tags change', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    await run(session, { type: 'page.setIcon', id: welcome, icon: '📝', now: 5 });
    await run(session, { type: 'page.setTags', id: welcome, tags: ['start', 'new'], now: 6 });
    const text = vault.text('Welcome.md')!;
    expect(text.slice(text.indexOf('# Hello'))).toBe(
      OBSIDIAN['Welcome.md'].slice(OBSIDIAN['Welcome.md'].indexOf('# Hello')),
    );
    expect(text).toContain('icon: 📝');
    expect(text).toContain('cssclasses: wide');
    await session.close();
  });

  it('renames the file and updates links in other files without touching the rest of them', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    await run(session, { type: 'page.rename', id: idOf(session, 'Welcome'), title: 'Start here', now: 5 });
    expect(vault.text('Welcome.md')).toBeUndefined();
    expect(vault.text('Start here.md')).toBe(OBSIDIAN['Welcome.md']);
    expect(vault.text('Projects/Garden.md')).toBe('Back to [[Start here]].\n\n* loose   formatting  kept\n');
    await session.close();
  });

  it('moves pages with their folders and tidies up empty folders', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    await run(session, { type: 'page.move', id: idOf(session, 'Garden'), parentId: null });
    expect(vault.text('Garden.md')).toContain('Back to [[Welcome]]');
    expect(vault.dirs.has('Projects')).toBe(false);
    // the canvas follows the page to its new path
    expect(JSON.parse(vault.text('Board.canvas')!).nodes[1].file).toBe('Garden.md');
    await run(session, {
      type: 'page.move',
      id: idOf(session, 'Garden'),
      parentId: idOf(session, 'Welcome'),
    });
    expect(vault.text('Welcome/Garden.md')).toBeDefined();
    await session.close();
  });

  it('keeps trashed pages in .trash and puts them back on restore', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const projects = idOf(session, 'Projects');
    await run(session, { type: 'page.trash', id: projects, now: 99 });
    expect(vault.paths()).toEqual(
      expect.arrayContaining(['.trash/Projects.md', '.trash/Projects/Garden.md']),
    );
    expect(vault.text('Projects.md')).toBeUndefined();

    const reopened = await open(vault);
    expect(reopened.getState().pages[projects]!.trashedAt).toBe(99);
    await run(reopened, { type: 'page.restore', id: projects });
    expect(vault.text('Projects/Garden.md')).toBe(OBSIDIAN['Projects/Garden.md']);
    await run(reopened, { type: 'page.trash', id: projects, now: 100 });
    await run(reopened, { type: 'page.deleteForever', id: projects });
    expect(vault.trashed).toEqual(
      expect.arrayContaining(['.trash/Projects.md', '.trash/Projects/Garden.md']),
    );
    await session.close();
    await reopened.close();
  });

  it('remembers ids, order and favourites across restarts', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const ideas = idOf(session, 'Ideas');
    await run(session, { type: 'page.setFavorite', id: ideas, favorite: true });
    await run(session, { type: 'page.move', id: ideas, parentId: null, index: 0 });
    const reopened = await open(vault);
    expect(reopened.getState().pages[ideas]).toMatchObject({ favorite: true, order: 0 });
    await reopened.close();
    await session.close();
  });

  it('treats empty folders as pages, except the attachments folder', async () => {
    const vault = new MemoryVault({ 'Note.md': 'hi\n' });
    vault.dirs.add('attachments');
    vault.dirs.add('Someday');
    const session = await open(vault);
    expect(
      Object.values(session.getState().pages)
        .map((page) => page.title)
        .sort(),
    ).toEqual(['Note', 'Someday']);
    await session.close();
  });

  it('creates files for new pages and suffixes duplicate names', async () => {
    const vault = new MemoryVault();
    const session = await open(vault);
    expect(session.firstRun).toBe(true);
    await run(session, { type: 'page.create', id: 'a', parentId: null, now: 1, doc: doc('one') });
    await run(session, { type: 'page.create', id: 'b', parentId: null, now: 2, doc: doc('two') });
    await run(session, { type: 'page.create', id: 'c', parentId: 'a', now: 3, title: 'Child' });
    expect(vault.text('Untitled.md')).toBe('one\n');
    expect(vault.text('Untitled 2.md')).toBe('---\ntitle: Untitled\n---\ntwo\n');
    expect(vault.text('Untitled/Child.md')).toBe('');
    await session.close();
  });
});

describe('edits made outside morrow', () => {
  it('does not read its own first save back in as new pages', async () => {
    const vault = new MemoryVault();
    const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    expect(session.firstRun).toBe(true);
    // a slow disk: the watcher reports the first files while the rest are still being written
    vault.midway = (done) => {
      if (done === 3) vault.report(vault.paths().filter((path) => path.endsWith('.md')));
    };
    const seeded = session.executeAll(sampleCommands(newId, Date.now()));
    if (!seeded.ok) throw new Error(seeded.error);
    await session.flush();
    vault.midway = null;
    const titles = Object.values(session.getState().pages).map((page) => page.title);
    expect(titles.length).toBe(new Set(titles).size);
    await session.close();
  });

  it('does not take a page caught halfway through a move for an edit made elsewhere', async () => {
    const vault = new MemoryVault({
      'Trip.md': 'Look ![](attachments/pic.png)\n',
      'attachments/pic.png': 'PNG',
    });
    const repository = new VaultRepository(vault, newId);
    const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const trip = idOf(session, 'Trip');
    const picture = () => session.getState().docs[trip]!.content!.find((node) => node.type === 'image');
    await run(session, { type: 'page.trash', id: trip, now: 1 });
    await run(session, { type: 'page.restore', id: trip });
    // the watcher read the file right after it was renamed back, before its links were rewritten
    const stale = {
      path: 'Trip.md',
      text: 'Look\n\n![](../attachments/pic.png)\n',
      mtime: Date.now() - 60_000,
      birthtime: 0,
    };
    expect(repository.readChanges([stale], session.getState())).toBeNull();
    expect(picture()?.attrs?.fileId).toBe('attachments/pic.png');
    expect(vault.text('Trip.md')).toBe('Look\n\n![](attachments/pic.png)\n');
    await session.close();
  });

  it('picks up changed, new and deleted files', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const garden = idOf(session, 'Garden');
    vault.external({
      'Projects/Garden.md': 'Edited in another app.\n',
      'Projects/Orchard.md': 'New from git pull.\n',
      'Ideas/Loose idea.md': null,
    });
    const state = session.getState();
    expect(state.docs[garden]).toEqual(doc('Edited in another app.'));
    expect(idOf(session, 'Orchard')).toBeDefined();
    expect(state.pages[idOf(session, 'Orchard')]!.parentId).toBe(idOf(session, 'Projects'));
    expect(Object.values(state.pages).some((page) => page.title === 'Loose idea')).toBe(false);
    // a save afterwards leaves the outside edit alone
    await run(session, { type: 'page.rename', id: idOf(session, 'Welcome'), title: 'Welcome!', now: 9 });
    expect(vault.text('Projects/Garden.md')).toBe('Edited in another app.\n');
    await session.close();
  });

  it('keeps a page when the folder of its subpages goes away', async () => {
    const vault = new MemoryVault({ 'Parent.md': 'p\n', 'Parent/A.md': 'a\n', 'Parent/B.md': 'b\n' });
    const session = await open(vault);
    const parent = idOf(session, 'Parent');
    await run(session, { type: 'page.trash', id: idOf(session, 'A'), now: 5 });
    await run(session, { type: 'page.trash', id: idOf(session, 'B'), now: 6 });
    expect(vault.dirs.has('Parent')).toBe(false);
    // the watcher then reports the emptied folder morrow tidied away
    vault.folderGone('Parent');
    expect(session.getState().pages[parent]).toMatchObject({ title: 'Parent', trashedAt: null });
    expect(vault.text('Parent.md')).toBe('p\n');
    // a folder page is its folder, so it still goes with it
    vault.dirs.add('Someday');
    vault.external({ 'Someday/Idea.md': 'x\n' });
    const someday = idOf(session, 'Someday');
    vault.external({ 'Someday/Idea.md': null });
    vault.folderGone('Someday');
    expect(session.getState().pages[someday]).toBeUndefined();
    await session.close();
  });

  it('treats a file that moved as the same page', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    vault.external({ 'Welcome.md': null, 'Projects/Welcome.md': OBSIDIAN['Welcome.md'] });
    expect(session.getState().pages[welcome]!.parentId).toBe(idOf(session, 'Projects'));
    await session.close();
  });

  it('keeps unsaved edits and saves the other version in page history', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const garden = idOf(session, 'Garden');
    session.execute({ type: 'page.setDoc', id: garden, doc: doc('Mine'), now: 5 });
    vault.external({ 'Projects/Garden.md': 'Theirs\n' });
    expect(session.getState().docs[garden]).toEqual(doc('Mine'));
    await session.flush();
    expect(vault.text('Projects/Garden.md')).toBe('Mine\n');
    const history = await session.listSnapshots(garden);
    expect(history.some((snapshot) => JSON.stringify(snapshot.doc).includes('Theirs'))).toBe(true);
    await session.close();
  });
});

describe('E003 Polaris Dados representability guard', () => {
  it('uses non-mutating expected-content checks for present and absent vault files', async () => {
    const vault = new MemoryVault({ 'Note.md': 'original\n' });
    const before = fingerprint(vault, ['Note.md', 'Recent.json']);
    expect(
      await vault.apply([
        { op: 'check', path: 'Note.md', expect: 'original\n' },
        { op: 'check', path: 'Recent.json', expect: null },
      ]),
    ).toEqual([{ ok: true }, { ok: true }]);
    expect(await vault.apply([{ op: 'check', path: 'Note.md', expect: 'stale\n' }])).toEqual([
      { ok: false, code: 'conflict', message: 'changed on disk', current: 'original\n' },
    ]);
    expect(await vault.apply([{ op: 'check', path: 'Missing.md', expect: 'new\n' }])).toEqual([
      { ok: false, code: 'conflict', message: 'changed on disk', current: null },
    ]);
    expect(fingerprint(vault, ['Note.md', 'Recent.json'])).toEqual(before);
  });

  it('keeps fork data byte-for-byte after blocked edits, batches, rename and reopen', async () => {
    const vault = new MemoryVault(E003_POLARIS_DADOS_FIXTURE);
    const session = await open(vault);
    const legacyId = pageIdAt(session, 'Archive/Legacy.md');
    const rowId = pageIdAt(session, 'Archive/Legacy/Row.md');
    const forkContentId = pageIdAt(session, 'Fork content.md');
    const inventoryId = pageIdAt(session, 'Inventory.md');
    const paths = [
      'Archive/Legacy.md',
      'Archive/Legacy/Row.md',
      'Fork content.md',
      'Inventory.md',
      'Inventory/Widget.md',
    ];
    const before = fingerprint(vault, paths);

    expect(session.unreadable.has(legacyId)).toBe(true);
    expect(session.unreadable.has(rowId)).toBe(true);
    expect(session.unreadable.has(forkContentId)).toBe(true);
    expect(session.protectedReasons.get(legacyId)).toMatch(/database property/i);
    expect(session.protectedReasons.get(forkContentId)).toMatch(/Morrow block marker/i);
    const originalForkDoc = session.getState().docs[forkContentId];
    expect((await session.unlockPage(forkContentId, 'not-a-password')).ok).toBe(false);
    await session.lockPage(forkContentId);
    expect(session.getState().docs[forkContentId]).toEqual(originalForkDoc);
    expect(session.execute({ type: 'page.rename', id: legacyId, title: 'Renamed legacy', now: 50 }).ok).toBe(false);
    expect(
      session.execute({
        type: 'page.create',
        id: 'new-row',
        parentId: legacyId,
        title: 'Unsafe new row',
        now: 50,
      }).ok,
    ).toBe(false);
    expect(session.execute({ type: 'page.setFields', id: rowId, extra: {}, now: 51 }).ok).toBe(false);
    expect(
      session.executeAll([
        { type: 'page.setIcon', id: inventoryId, icon: '📦', now: 52 },
        { type: 'page.rename', id: forkContentId, title: 'Edited marker', now: 53 },
      ]).ok,
    ).toBe(false);
    expect(session.getState().pages[inventoryId]?.icon).toBeNull();
    expect(await session.flush()).toBe(true);
    expect(fingerprint(vault, paths)).toEqual(before);
    await session.close();

    const reopened = await open(vault);
    expect(reopened.unreadable.has(pageIdAt(reopened, 'Archive/Legacy.md'))).toBe(true);
    expect(reopened.unreadable.has(pageIdAt(reopened, 'Archive/Legacy/Row.md'))).toBe(true);
    expect(fingerprint(vault, paths)).toEqual(before);
    await reopened.close();
  });

  it('still edits and saves the upstream Name/Quantity/Price/Total synthetic database', async () => {
    const vault = new MemoryVault(E003_POLARIS_DADOS_FIXTURE);
    const session = await open(vault);
    const widgetId = pageIdAt(session, 'Inventory/Widget.md');
    const beforeDatabase = fingerprint(vault, ['Inventory.md']);
    await run(session, {
      type: 'page.setProperties',
      id: widgetId,
      values: { quantity: 3 },
      now: 60,
    });
    expect(vault.text('Inventory/Widget.md')).toContain('Quantity: 3');
    expect(vault.text('Inventory/Widget.md')).toContain('opaque-widget-7f21');
    expect(fingerprint(vault, ['Inventory.md'])).toEqual(beforeDatabase);
    expect(session.unreadable.has(widgetId)).toBe(false);
    await session.close();
  });

  it('rejects permanent deletion of a trashed parent with a protected descendant', async () => {
    const paths = [
      '.trash/Archive.md',
      '.trash/Archive/Legacy.md',
      '.trash/Archive/Legacy/Row.md',
      '.morrow/workspace.json',
    ];
    const vault = new MemoryVault({
      '.trash/Archive.md': '# Archive\n',
      '.trash/Archive/Legacy.md': E003_POLARIS_DADOS_FIXTURE['Archive/Legacy.md']!,
      '.trash/Archive/Legacy/Row.md': E003_POLARIS_DADOS_FIXTURE['Archive/Legacy/Row.md']!,
      '.morrow/workspace.json': JSON.stringify({
        pages: { '.trash/Archive.md': { id: 'archive', trashed: 123 } },
      }),
    });
    const session = await open(vault);
    const archiveId = pageIdAt(session, '.trash/Archive.md');
    const before = fingerprint(vault, paths);
    expect(session.execute({ type: 'page.deleteForever', id: archiveId }).ok).toBe(false);
    expect(session.getState().pages[archiveId]).toBeDefined();
    expect(fingerprint(vault, paths)).toEqual(before);
    await session.close();
  });

  it('refuses future workspace/recent registries before any file is rewritten', async () => {
    for (const [metadataPath, text] of [
      [
        '.morrow/workspace.json',
        JSON.stringify({ pages: { 'Inventory.md': { id: 'page-1', futureRegistry: { id: 'opaque' } } } }),
      ],
      ['.morrow/recent.json', JSON.stringify({ opened: {}, futureRecent: { id: 'opaque' } })],
    ]) {
      const vault = new MemoryVault({
        'Inventory.md': E003_POLARIS_DADOS_FIXTURE['Inventory.md']!,
        'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!,
        [metadataPath!]: text!,
      });
      const paths = ['Inventory.md', 'Inventory/Widget.md', metadataPath!];
      const before = fingerprint(vault, paths);
      const opened = await WorkspaceSession.open(new VaultRepository(vault, newId));
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.error).toMatch(/workspace registry|recent-items/i);
      expect(fingerprint(vault, paths)).toEqual(before);
    }
  });

  it('does not overwrite future registry metadata added after opening', async () => {
    const vault = new MemoryVault({ 'Note.md': 'Original note.\n' });
    const session = await open(vault);
    await session.markInitialized();
    const noteId = pageIdAt(session, 'Note.md');
    const registry = JSON.parse(vault.text('.morrow/workspace.json')!) as Record<string, unknown>;
    registry.futureField = { id: 'must-survive' };
    vault.external({ '.morrow/workspace.json': `${JSON.stringify(registry)}\n` });
    const paths = ['Note.md', 'Renamed.md', '.morrow/workspace.json', '.morrow/recent.json'];
    const before = fingerprint(vault, paths);

    expect(session.execute({ type: 'page.rename', id: noteId, title: 'Renamed', now: 70 }).ok).toBe(true);
    expect(await session.flush()).toBe(false);
    expect(vault.text('.morrow/workspace.json')).toContain('must-survive');
    expect(fingerprint(vault, paths)).toEqual(before);
    await session.close();
  });

  it('enforces protection at the repository write boundary', async () => {
    const vault = new MemoryVault(E003_POLARIS_DADOS_FIXTURE);
    const repository = new VaultRepository(vault, newId);
    const loaded = await repository.load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const legacy = loaded.value.pages.find((page) => repository.pathOf(page.id) === 'Archive/Legacy.md')!;
    const state = {
      pages: Object.fromEntries(loaded.value.pages.map((page) => [page.id, page])),
      docs: loaded.value.docs,
    };
    const changed = { ...legacy, title: 'Unsafe direct repository edit' };
    state.pages[legacy.id] = changed;
    const before = fingerprint(vault, ['Archive/Legacy.md']);
    await expect(
      repository.write({ pages: [changed], docs: [], removed: [], state }),
    ).rejects.toThrow(/cannot safely represent/i);
    expect(fingerprint(vault, ['Archive/Legacy.md'])).toEqual(before);
    repository.close();
  });

  it('keeps encrypted fork-only content locked when unlock finds it is not representable', async () => {
    const password = 'synthetic-password';
    const encrypted = await encryptPage(
      '---\nkind: page\n---\n<!-- morrow:image align="right" width="35%" -->\n',
      await newPageKey(password),
    );
    const vault = new MemoryVault({ 'Secret.md': encrypted });
    const session = await open(vault);
    const id = pageIdAt(session, 'Secret.md');
    const before = fingerprint(vault, ['Secret.md']);

    const unlocked = await session.unlockPage(id, password);
    expect(unlocked.ok).toBe(false);
    if (!unlocked.ok) expect(unlocked.error).toMatch(/Morrow cannot safely represent/i);
    expect(session.unreadable.has(id)).toBe(true);
    expect(fingerprint(vault, ['Secret.md'])).toEqual(before);
    await session.close();
    expect(fingerprint(vault, ['Secret.md'])).toEqual(before);
  });

  it('refuses attachment deletion through both session and repository when protected pages may reference it', async () => {
    const vault = new MemoryVault(E003_POLARIS_DADOS_FIXTURE);
    const session = await open(vault);
    const path = 'attachments/fork-image.png';
    const before = fingerprint(vault, [path]);
    await expect(session.deleteFiles([path])).rejects.toThrow(/protected page may reference them/i);
    expect(fingerprint(vault, [path])).toEqual(before);
    await session.close();

    const repository = new VaultRepository(vault, newId);
    const loaded = await repository.load();
    expect(loaded.ok).toBe(true);
    await expect(repository.deleteFiles([path])).rejects.toThrow(/protected page may reference them/i);
    expect(fingerprint(vault, [path])).toEqual(before);
    repository.close();
  });

  it('keeps a database and row protected when both receive unsupported external updates together', async () => {
    const vault = new MemoryVault(E003_POLARIS_DADOS_FIXTURE);
    const session = await open(vault);
    const databaseId = pageIdAt(session, 'Archive/Legacy.md');
    const rowId = pageIdAt(session, 'Archive/Legacy/Row.md');
    vault.external({
      'Archive/Legacy.md': `${E003_POLARIS_DADOS_FIXTURE['Archive/Legacy.md']}\n<!-- morrow:image crop="0,0,1,1" -->\n`,
      'Archive/Legacy/Row.md': `${E003_POLARIS_DADOS_FIXTURE['Archive/Legacy/Row.md']}\nExternal row update.\n`,
    });
    expect(session.unreadable.has(databaseId)).toBe(true);
    expect(session.unreadable.has(rowId)).toBe(true);
    expect(session.protectedReasons.has(rowId)).toBe(true);
    const before = fingerprint(vault, ['Archive/Legacy.md', 'Archive/Legacy/Row.md']);
    expect(session.execute({ type: 'page.rename', id: rowId, title: 'Unsafe row edit', now: 61 }).ok).toBe(false);
    expect(await session.flush()).toBe(true);
    expect(fingerprint(vault, ['Archive/Legacy.md', 'Archive/Legacy/Row.md'])).toEqual(before);
    await session.close();
  });
});

describe('page history', () => {
  it('names and deletes versions, and the names survive reopening', async () => {
    const vault = new MemoryVault({ 'Note.md': 'First\n' });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    await session.keepVersion(note);
    await run(session, { type: 'page.setDoc', id: note, doc: doc('Second'), now: 5 });
    await session.keepVersion(note);
    const [newest, older] = await session.listSnapshots(note);
    await session.changeSnapshot(note, older!.id, { name: 'Before the rewrite' });
    await session.changeSnapshot(note, newest!.id, null);
    await session.close();
    const reopened = await open(vault);
    const versions = await reopened.listSnapshots(note);
    expect(versions.map((version) => version.name)).toEqual(['Before the rewrite']);
    await reopened.close();
  });
});

describe('databases and journals in files', () => {
  it('writes row properties as readable frontmatter and reads them back', async () => {
    const vault = new MemoryVault();
    const session = await open(vault);
    const database = {
      properties: [
        {
          id: 'status',
          name: 'Status',
          type: 'select' as const,
          options: [{ id: 'o1', name: 'Reading', color: 'blue' as const }],
        },
        { id: 'pages', name: 'Pages', type: 'number' as const, options: [] },
      ],
      views: [
        {
          id: 'v',
          name: 'All',
          type: 'table' as const,
          filters: [],
          sorts: [],
          groupBy: null,
          dateProp: null,
          hidden: [],
        },
      ],
    };
    await run(session, {
      type: 'page.create',
      id: 'db',
      parentId: null,
      now: 1,
      title: 'Books',
      kind: 'database',
    });
    await run(session, { type: 'database.set', id: 'db', database, now: 2 });
    await run(session, { type: 'page.create', id: 'row', parentId: 'db', now: 3, title: 'Piranesi' });
    await run(session, {
      type: 'page.setProperties',
      id: 'row',
      values: { status: 'o1', pages: 272 },
      now: 4,
    });
    expect(vault.text('Books/Piranesi.md')).toBe('---\nStatus: Reading\nPages: 272\n---\n');
    expect(vault.text('Books.md')).toContain('kind: database');

    vault.external({ 'Books/Jonathan Strange.md': '---\nStatus: Finished\nPages: 782\n---\nLong.\n' });
    const reopened = await open(vault);
    const row = Object.values(reopened.getState().pages).find((page) => page.title === 'Jonathan Strange')!;
    const db = reopened.getState().pages.db!.database!;
    const finished = db.properties[0]!.options.find((option) => option.name === 'Finished');
    expect(row.properties).toEqual({ status: finished!.id, pages: 782 });
    await session.close();
    await reopened.close();
  });

  it('names daily notes by date and titles them in words', async () => {
    const vault = new MemoryVault({
      'Journal.md': '---\nkind: journal\n---\n',
      'Journal/2026-10-15.md': 'Rain.\n',
    });
    const session = await open(vault);
    const day = Object.values(session.getState().pages).find((page) => page.dailyDate === '2026-10-15');
    expect(day?.title).toMatch(/2026/);
    expect(day?.title).not.toBe('2026-10-15');
    await session.close();
  });
});

describe('encrypted pages in files', () => {
  it('keeps only ciphertext on disk and opens with the right password', async () => {
    const vault = new MemoryVault({ 'Diary.md': '---\ntags: [private]\n---\nDear diary.\n' });
    const session = await open(vault);
    const diary = idOf(session, 'Diary');
    await run(session, { type: 'page.setDoc', id: diary, doc: doc('Dear diary, version two.'), now: 5 });
    expect(vault.paths().some((path) => path.includes('history'))).toBe(false);
    expect([...vault.files.keys()].some((path) => path.startsWith('.morrow/history/'))).toBe(true);

    const protectedPage = await session.protectPage(diary, 'hunter2 but longer');
    expect(protectedPage.ok).toBe(true);
    const onDisk = vault.text('Diary.md')!;
    expect(onDisk).not.toContain('diary');
    expect(onDisk).not.toContain('private');
    expect([...vault.files.keys()].some((path) => path.startsWith('.morrow/history/'))).toBe(false);

    // editing an unlocked encrypted page keeps it encrypted
    await run(session, { type: 'page.setDoc', id: diary, doc: doc('Third secret.'), now: 6 });
    expect(vault.text('Diary.md')).not.toContain('Third');
    expect([...vault.files.keys()].some((path) => path.startsWith('.morrow/history/'))).toBe(false);

    const reopened = await open(vault);
    expect(reopened.getState().pages[diary]!.encrypted).toBe(true);
    expect(reopened.getState().docs[diary]).toBeUndefined();
    expect((await reopened.unlockPage(diary, 'wrong')).ok).toBe(false);
    expect((await reopened.unlockPage(diary, 'hunter2 but longer')).ok).toBe(true);
    expect(reopened.getState().docs[diary]).toEqual(doc('Third secret.'));
    expect(reopened.getState().pages[diary]!.tags).toEqual(['private']);

    await reopened.lockPage(diary);
    expect(reopened.getState().docs[diary]).toBeUndefined();
    expect(vault.text('Diary.md')).not.toContain('Third');

    expect((await reopened.unlockPage(diary, 'hunter2 but longer')).ok).toBe(true);
    await reopened.unprotectPage(diary);
    expect(vault.text('Diary.md')).toBe('---\ntags: [private]\n---\nThird secret.\n');
    await session.close();
    await reopened.close();
  });
});

describe('dates in pages', () => {
  it('stay dates when an old note for that day is in the trash', async () => {
    const session = await open(
      new MemoryVault({ 'Plans.md': 'Call on [[2026-11-10]]\n', '.trash/2026-11-10.md': 'old\n' }),
    );
    const line = session.getState().docs[idOf(session, 'Plans')]!.content![0]!;
    expect(line.content![1]).toEqual({ type: 'dateMention', attrs: { date: '2026-11-10' } });
  });
});

describe('deleting a page for good', () => {
  it('takes its history with it, so its pictures can be cleaned up', async () => {
    const vault = new MemoryVault({});
    const session = await open(vault);
    await run(session, { type: 'page.create', id: 'gone', parentId: null, now: 1, title: 'Gone' });
    await run(session, { type: 'page.setDoc', id: 'gone', doc: doc('first'), now: 2 });
    await run(session, { type: 'page.setDoc', id: 'gone', doc: doc('second'), now: 20 * 60_000 });
    expect(await session.listSnapshots('gone')).not.toEqual([]);
    await run(session, { type: 'page.trash', id: 'gone', now: 30 * 60_000 });
    await run(session, { type: 'page.deleteForever', id: 'gone' });
    expect(await session.listSnapshots('gone')).toEqual([]);
    expect(await vault.exists('.morrow/history/gone.json')).toBe(false);
  });
});
