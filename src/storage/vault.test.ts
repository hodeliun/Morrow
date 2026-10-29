import { describe, expect, it } from 'vitest';
import { canvasDoc, canvasFromDoc } from '../core/canvas';
import type { Command } from '../core/commands';
import type { DocNode, PageId, WorkspaceState } from '../core/model';
import { encodeFileIcon, encodeLucideIcon, sanitizeSvg } from '../core/icons';
import { sampleCommands } from '../core/sample';
import { isPageTreeFileVisible, normalizeFileCatalogPreferences } from '../core/vault/fileCatalog';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';
import type { VaultBridge } from './vaultBridge';

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

const FUTURE_READONLY = [
  '---',
  'title: Future',
  'kind: database',
  'database:',
  '  properties:',
  '    - id: safe-field',
  '      name: Safe field',
  '      type: text',
  '      options: []',
  '    - id: future-field',
  '      name: Future field',
  '      type: future-text-v99',
  '  views:',
  '    - id: future-view',
  '      name: Primary',
  '      type: table',
  '      filters: []',
  '      sorts: []',
  '      groupBy: null',
  '      dateProp: null',
  '      hidden: []',
  '---',
  '# Future source',
  '',
].join('\n');

function failFirstApply(vault: MemoryVault): VaultBridge {
  let shouldFail = true;
  return new Proxy(vault as unknown as VaultBridge, {
    get(target, property) {
      if (property === 'apply')
        return async (ops: Parameters<VaultBridge['apply']>[0]) => {
          if (shouldFail) {
            shouldFail = false;
            return [{ ok: false, code: 'error', message: 'synthetic disk failure' }];
          }
          return target.apply(ops);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function failAfterFirstPageWrite(vault: MemoryVault): VaultBridge {
  let shouldFail = true;
  return new Proxy(vault as unknown as VaultBridge, {
    get(target, property) {
      if (property === 'apply')
        return async (ops: Parameters<VaultBridge['apply']>[0]) => {
          const pageWrites = ops.flatMap((op, index) =>
            op.op === 'write' && op.id ? [index] : [],
          );
          const failAt = pageWrites[1];
          if (shouldFail && failAt !== undefined) {
            shouldFail = false;
            const completed = await target.apply(ops.slice(0, failAt));
            if (completed.length !== failAt || completed.some((result) => !result.ok)) return completed;
            return [...completed, { ok: false, code: 'error', message: 'synthetic partial failure' }];
          }
          return target.apply(ops);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
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

  it('preserves the original canvas bytes when only recording that it was opened', async () => {
    const originalCanvas = JSON.stringify({
      futureCanvasField: { preserve: 'unknown root metadata' },
      nodes: [
        {
          id: 'garden',
          type: 'file',
          file: 'Projects/Garden.md',
          x: 300,
          y: 0,
          width: 200,
          height: 80,
          futureNodeField: 'unknown node metadata',
        },
      ],
      edges: [],
    });
    const vault = new MemoryVault({ ...OBSIDIAN, 'Board.canvas': originalCanvas });
    const session = await open(vault);
    await run(session, { type: 'page.markOpened', id: idOf(session, 'Board'), now: 5 });

    expect(vault.text('Board.canvas')).toBe(originalCanvas);
    await session.close();
  });

  it('keeps future-schema Markdown byte-for-byte through an open-only save and reopen', async () => {
    const vault = new MemoryVault({ 'Future.md': FUTURE_READONLY });
    const session = await open(vault);
    const future = idOf(session, 'Future');

    await run(session, { type: 'page.markOpened', id: future, now: 5 });
    expect(vault.text('Future.md')).toBe(FUTURE_READONLY);
    expect(JSON.parse(vault.text('.morrow/recent.json')!).opened[future]).toBe(5);
    expect(JSON.parse(vault.text('.morrow/workspace.json')!).pages['Future.md'].id).toBe(future);
    await session.close();

    const reopened = await open(vault);
    expect(idOf(reopened, 'Future')).toBe(future);
    expect(vault.text('Future.md')).toBe(FUTURE_READONLY);
    await reopened.close();
  });

  it('keeps an externally changed future-schema source exact after recording that it was opened', async () => {
    const vault = new MemoryVault({ 'Future.md': FUTURE_READONLY });
    const session = await open(vault);
    const future = idOf(session, 'Future');
    const external = FUTURE_READONLY.replace('Safe field', 'Safe field from sync').replace(
      '# Future source',
      '# Future source from sync',
    );

    vault.external({ 'Future.md': external });
    await run(session, { type: 'page.markOpened', id: future, now: 6 });

    expect(vault.text('Future.md')).toBe(external);
    expect(JSON.parse(vault.text('.morrow/recent.json')!).opened[future]).toBe(6);
    await session.close();
  });

  it('keeps the latest accepted watcher baseline when an event is held during another save', async () => {
    const vault = new MemoryVault({ 'Future.md': FUTURE_READONLY, 'Other.md': 'Before.\n' });
    const repository = new VaultRepository(vault, newId);
    const loaded = await repository.load();
    if (!loaded.ok) throw new Error(loaded.error);
    let state: WorkspaceState = {
      pages: Object.fromEntries(loaded.value.pages.map((page) => [page.id, page])),
      docs: loaded.value.docs,
    };
    repository.attachState(() => state);
    repository.onExternalChange((patch) => {
      const pages = { ...state.pages };
      for (const page of patch.pages) pages[page.id] = page;
      const docs = { ...state.docs, ...patch.docs };
      state = { pages, docs };
      return patch.pages.map((page) => page.id);
    });
    const pageId = (title: string) =>
      Object.values(state.pages).find((page) => page.title === title)?.id;
    const future = pageId('Future');
    const other = pageId('Other');
    if (!future || !other) throw new Error('test pages were not loaded');
    const openedFuture = { ...state.pages[future]!, lastOpenedAt: 5 };
    const editedOther = { ...state.pages[other]!, updatedAt: 9 };
    const otherDoc = doc('Other edited.');
    const batchState: WorkspaceState = {
      pages: { ...state.pages, [future]: openedFuture, [other]: editedOther },
      docs: { ...state.docs, [other]: otherDoc },
    };
    const external = FUTURE_READONLY.replace('# Future source', '# Future source from sync');
    let delivered = false;
    vault.midway = () => {
      if (delivered) return;
      delivered = true;
      vault.external({ 'Future.md': external });
    };

    await repository.write({
      pages: [openedFuture, editedOther],
      docs: [{ id: other, doc: otherDoc }],
      removed: [],
      state: batchState,
    });
    vault.midway = null;
    expect(delivered).toBe(true);
    expect(state.pages[future]!.updatedAt).toBeGreaterThan(openedFuture.updatedAt);

    const markedAfterExternal = { ...state.pages[future]!, lastOpenedAt: 11 };
    const nextState: WorkspaceState = {
      pages: { ...state.pages, [future]: markedAfterExternal },
      docs: state.docs,
    };
    await repository.write({ pages: [markedAfterExternal], docs: [], removed: [], state: nextState });

    expect(vault.text('Future.md')).toBe(external);
    repository.close();
  });

  it('persists a real supported frontmatter edit while retaining other metadata', async () => {
    const original = '---\ntitle: Original\nexternalNote: keep me\n---\nBody.\n';
    const vault = new MemoryVault({ 'Original.md': original });
    const session = await open(vault);
    const page = idOf(session, 'Original');

    await run(session, {
      type: 'page.setFields',
      id: page,
      extra: { externalNote: 'updated', anotherUnknownField: 'preserve me' },
      now: 7,
    });

    expect(vault.text('Original.md')).toContain('externalNote: updated');
    expect(vault.text('Original.md')).toContain('anotherUnknownField: preserve me');
    expect(vault.text('Original.md')).toContain('Body.');
    await session.close();
  });

  it('retries a failed metadata save after a disk conflict without skipping the edit', async () => {
    const original = '---\nexternalNote: original\n---\nOriginal body.\n';
    const vault = new MemoryVault({ 'Note.md': original });
    const repository = new VaultRepository(failFirstApply(vault), newId);
    const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const page = idOf(session, 'Note');

    const changed = session.execute({
      type: 'page.setFields',
      id: page,
      extra: { externalNote: 'from Morrow' },
      now: 8,
    });
    if (!changed.ok) throw new Error(changed.error);
    expect(await session.flush()).toBe(false);
    expect(vault.text('Note.md')).toBe(original);

    const external = '---\nexternalNote: from disk\n---\nExternal body.\n';
    vault.external({ 'Note.md': external });
    expect(await session.flush()).toBe(true);
    expect(vault.text('Note.md')).toContain('externalNote: from Morrow');
    const snapshots = await session.listSnapshots(page);
    expect(snapshots.some((snapshot) => JSON.stringify(snapshot.doc).includes('External body.'))).toBe(true);
    await session.close();
  });

  it('keeps metadata changes pending when a multi-page save partially succeeds', async () => {
    const vault = new MemoryVault({
      'First.md': '---\nexternalNote: original first\n---\nFirst body.\n',
      'Second.md': '---\nexternalNote: original second\n---\nSecond body.\n',
    });
    const repository = new VaultRepository(failAfterFirstPageWrite(vault), newId);
    const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const first = idOf(session, 'First');
    const second = idOf(session, 'Second');

    const changed = session.executeAll([
      {
        type: 'page.setFields',
        id: first,
        extra: { externalNote: 'changed first' },
        now: 9,
      },
      {
        type: 'page.setFields',
        id: second,
        extra: { externalNote: 'changed second' },
        now: 10,
      },
    ]);
    if (!changed.ok) throw new Error(changed.error);

    expect(await session.flush()).toBe(false);
    expect(vault.text('First.md')).toContain('externalNote: changed first');
    expect(vault.text('Second.md')).toContain('externalNote: original second');
    expect(await session.flush()).toBe(true);
    expect(vault.text('First.md')).toContain('externalNote: changed first');
    expect(vault.text('Second.md')).toContain('externalNote: changed second');
    await session.close();
  });

  it('writes edited canvas documents and retargets page cards after a page moves', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const board = idOf(session, 'Board');
    const data = canvasFromDoc(session.getState().docs[board]);
    data.nodes.push({
      id: 'new-card',
      type: 'text',
      text: 'Edited card',
      x: 550,
      y: 0,
      width: 200,
      height: 80,
    });

    await run(session, { type: 'page.setDoc', id: board, doc: canvasDoc(data), now: 5 });
    const edited = JSON.parse(vault.text('Board.canvas')!);
    expect(edited.nodes).toHaveLength(3);
    expect(edited.nodes.find((node: { id: string }) => node.id === 'new-card')).toMatchObject({
      type: 'text',
      text: 'Edited card',
    });
    expect(edited.nodes.find((node: { id: string }) => node.id === 'b')).toMatchObject({
      file: 'Projects/Garden.md',
    });

    await run(session, { type: 'page.move', id: idOf(session, 'Garden'), parentId: null });
    const moved = JSON.parse(vault.text('Board.canvas')!);
    expect(moved.nodes.find((node: { id: string }) => node.id === 'b')).toMatchObject({ file: 'Garden.md' });
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

  it('persists and reopens custom text, highlight and block colours from Markdown', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    const customDoc: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockBackground: '#a1b2c3' },
          content: [
            { type: 'text', text: 'Signal', marks: [{ type: 'textColor', attrs: { color: '#124abc' } }] },
            { type: 'text', text: ' and ' },
            { type: 'text', text: 'attention', marks: [{ type: 'highlight', attrs: { color: '#f0a5d2' } }] },
          ],
        },
      ],
    };

    await run(session, { type: 'page.setDoc', id: welcome, doc: customDoc, now: 5 });
    const saved = vault.text('Welcome.md')!;
    expect(saved).toContain('<!-- morrow:block-background:#a1b2c3 -->');
    expect(saved).toContain('<span style="color: #124abc">Signal</span>');
    expect(saved).toContain('<mark style="background: #f0a5d2">attention</mark>');
    await session.close();

    const reopened = await open(vault);
    expect(reopened.getState().docs[welcome]).toEqual(customDoc);
    await reopened.close();
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

  it('persists colored catalog icons through the existing frontmatter field and reopening', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    const icon = encodeLucideIcon('BookOpen', '#22c55e')!;
    await run(session, { type: 'page.setIcon', id: welcome, icon, now: 5 });
    expect(vault.text('Welcome.md')).toContain(icon);
    await session.close();

    const reopened = await open(vault);
    expect(reopened.getState().pages[welcome]?.icon).toBe(icon);
    await reopened.close();
  });

  it('persists a sanitized SVG attachment icon and its local file through reopening', async () => {
    const vault = new MemoryVault(OBSIDIAN);
    const session = await open(vault);
    const welcome = idOf(session, 'Welcome');
    const svg = sanitizeSvg('<svg viewBox="0 0 24 24" onload="alert(1)"><path d="M1 1L23 23"/></svg>')!;
    const bytes = new TextEncoder().encode(svg);
    const stored = await session.addFiles([
      {
        meta: {
          id: 'icon-svg',
          name: 'character.svg',
          type: 'image/svg+xml',
          size: bytes.byteLength,
          createdAt: 5,
        },
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      },
    ]);
    if (!stored.ok) throw new Error(stored.error);
    const fileId = stored.value[0]!.id;
    const icon = encodeFileIcon(fileId)!;
    await run(session, { type: 'page.setIcon', id: welcome, icon, now: 6 });
    expect(vault.text('Welcome.md')).toContain(icon);
    const attachment = vault.files.get(fileId);
    expect(attachment).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(attachment as ArrayBuffer)).toBe(svg);
    await session.close();

    const reopened = await open(vault);
    expect(reopened.getState().pages[welcome]?.icon).toBe(icon);
    const file = await reopened.getFile(fileId);
    expect(file && new TextDecoder().decode(file.data)).toBe(svg);
    await reopened.close();
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

  it('persists sequential counters across grouped creation, deletion and vault reopening', async () => {
    const vault = new MemoryVault();
    let session = await open(vault);
    await run(session, {
      type: 'page.create',
      id: 'sequence-db',
      parentId: null,
      now: 1,
      title: 'Numbers',
      kind: 'database',
      database: {
        properties: [
          {
            id: 'number',
            name: 'Number',
            type: 'number',
            options: [],
            fillMode: 'default',
            defaultSequence: { start: 0, increment: 1 },
          },
        ],
        views: [],
      },
    });
    await run(session, {
      type: 'page.create',
      id: 'sequence-first',
      parentId: 'sequence-db',
      now: 2,
      title: 'First',
    });
    expect(session.getState().pages['sequence-first']!.properties.number).toBe(0);

    const grouped = session.executeAll([
      {
        type: 'page.create',
        id: 'sequence-second',
        parentId: 'sequence-db',
        now: 3,
        title: 'Second',
      },
      {
        type: 'page.create',
        id: 'sequence-third',
        parentId: 'sequence-db',
        now: 4,
        title: 'Third',
      },
    ]);
    if (!grouped.ok) throw new Error(grouped.error);
    expect(grouped.value.pages['sequence-second']!.properties.number).toBe(1);
    expect(grouped.value.pages['sequence-third']!.properties.number).toBe(2);
    await session.flush();

    await run(session, { type: 'page.trash', id: 'sequence-first', now: 5 });
    await run(session, { type: 'page.deleteForever', id: 'sequence-first' });
    await session.close();

    expect(vault.text('Numbers.md')).toContain('sequenceNext: 3');
    session = await open(vault);
    await run(session, {
      type: 'page.create',
      id: 'sequence-fourth',
      parentId: 'sequence-db',
      now: 6,
      title: 'Fourth',
    });
    expect(session.getState().pages['sequence-fourth']!.properties.number).toBe(3);
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

  it('keeps externally changed named control values and defaults through a later save', async () => {
    const vault = new MemoryVault({
      'Controls.md':
        '---\nmorrowControls:\n  - id: amount\n    name: Amount\n    type: number\n    value: 1\n    defaultValue: 2\n    options: []\n---\nBefore.\n',
    });
    const session = await open(vault);
    const page = idOf(session, 'Controls');
    const external =
      '---\nexternalNote: keep me\nmorrowControls:\n  - id: amount\n    name: Amount\n    type: number\n    value: 7\n    defaultValue: 9\n    options: []\n---\nBefore.\n';
    vault.external({ 'Controls.md': external });

    expect(session.getState().pages[page]?.controls).toMatchObject([
      { id: 'amount', value: 7, defaultValue: 9 },
    ]);
    await run(session, { type: 'page.setDoc', id: page, doc: doc('Edited in Morrow.'), now: 10 });
    expect(vault.text('Controls.md')).toContain('externalNote: keep me');

    const reopened = await open(vault);
    expect(reopened.getState().pages[page]?.controls).toMatchObject([
      { id: 'amount', value: 7, defaultValue: 9 },
    ]);
    expect(reopened.getState().pages[page]?.extra).toMatchObject({ externalNote: 'keep me' });
    await reopened.close();
    await session.close();
  });

  it('does not restore named controls removed externally after a later save', async () => {
    const vault = new MemoryVault({
      'Controls.md':
        '---\nexternalNote: keep me\nmorrowControls:\n  - id: amount\n    name: Amount\n    type: number\n    value: 1\n    defaultValue: 2\n    options: []\n---\nBefore.\n',
    });
    const session = await open(vault);
    const page = idOf(session, 'Controls');
    vault.external({ 'Controls.md': '---\nexternalNote: keep me\n---\nBefore.\n' });

    expect(session.getState().pages[page]?.controls).toEqual([]);
    await run(session, { type: 'page.setDoc', id: page, doc: doc('Edited in Morrow.'), now: 11 });
    expect(vault.text('Controls.md')).not.toContain('morrowControls:');

    const reopened = await open(vault);
    expect(reopened.getState().pages[page]?.controls).toEqual([]);
    expect(reopened.getState().pages[page]?.extra).toMatchObject({ externalNote: 'keep me' });
    await reopened.close();
    await session.close();
  });

  it('leaves externally invalid named control metadata read only', async () => {
    const original =
      '---\nexternalNote: keep me\nmorrowControls:\n  - id: amount\n    name: Amount\n    type: number\n    value: 1\n    defaultValue: 2\n    options: []\n---\nBefore.\n';
    const vault = new MemoryVault({ 'Controls.md': original });
    const session = await open(vault);
    const page = idOf(session, 'Controls');
    const invalid =
      '---\nexternalNote: changed elsewhere\nmorrowControls:\n  - id: amount\n    name: Amount\n    type: unsupported\n    value: 1\n    defaultValue: 2\n    options: []\n---\nExternal edit.\n';
    vault.external({ 'Controls.md': invalid });

    expect(session.unreadable.has(page)).toBe(true);
    session.execute({ type: 'page.setIcon', id: page, icon: '📝', now: 12 });
    await session.flush();
    expect(vault.text('Controls.md')).toBe(invalid);
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

describe('ordinary file catalog', () => {
  it('hides Markdown and canvas rows without changing page parsing or explicit references', async () => {
    const session = await open(new MemoryVault(OBSIDIAN));
    const state = session.getState();
    const preferences = normalizeFileCatalogPreferences({ mode: 'selected', selectedExtensions: [] });
    const welcome = idOf(session, 'Welcome');
    const garden = idOf(session, 'Garden');
    const board = idOf(session, 'Board');
    const looseIdea = idOf(session, 'Loose idea');

    expect(isPageTreeFileVisible(session.pathOf(welcome), preferences)).toBe(false);
    expect(isPageTreeFileVisible(session.pathOf(board), preferences)).toBe(false);
    expect(state.pages[garden]).toBeDefined();
    const link = state.docs[welcome]!.content![1]!.content![1]!;
    expect(link.attrs).toMatchObject({ id: garden, alias: 'the garden' });
    expect(canvasFromDoc(state.docs[board]).nodes[1]).toMatchObject({ type: 'page', pageId: garden });
    const image = state.docs[looseIdea]!.content!.find((node) => node.type === 'image');
    expect(image?.attrs?.fileId).toBe('attachments/pic.png');

    await session.close();
  });

  it('keeps media-only folders out of Pages while preserving explicit references', async () => {
    const note = '---\nunknownProperty: kept\n---\nSee ![[Research/Papers/Study.PDF]].\n';
    const vault = new MemoryVault({
      'Notes.md': note,
      'Research/Papers/Study.PDF': 'synthetic pdf bytes',
      'Research/Media/Clip.MP4': 'synthetic video bytes',
      'attachments/Inline.png': 'synthetic attachment bytes',
    });
    const session = await open(vault);
    const state = session.getState();
    const notes = idOf(session, 'Notes');
    const catalog = session.getFileCatalog();

    expect(Object.values(state.pages).map((page) => page.title)).toEqual(['Notes']);
    expect(catalog.files.map((file) => file.path)).toHaveLength(3);
    expect(catalog.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'Research/Media/Clip.MP4',
        'Research/Papers/Study.PDF',
        'attachments/Inline.png',
      ]),
    );
    expect(catalog.folders).toContain('Research/Papers');
    expect(catalog.folders).toContain('Research/Media');
    expect(JSON.stringify(state.docs[notes])).toContain('Research/Papers/Study.PDF');
    expect(vault.text('Notes.md')).toBe(note);
    await session.close();
  });

  it('publishes binary-only watcher changes, removes subtrees, and keeps empty folders as pages', async () => {
    const vault = new MemoryVault({
      'Index.md': 'A stable note.\n',
      'Media/One.PDF': 'one',
      'Media/Nested/Two.Mp4': 'two',
    });
    const session = await open(vault);
    let catalogUpdates = 0;
    const unsubscribe = session.subscribeFileCatalog(() => catalogUpdates++);
    const originalPages = Object.keys(session.getState().pages);

    vault.external({ 'Media/Nested/Three.PDF': 'three' });
    expect(session.getFileCatalog().files.map((file) => file.path)).toContain('Media/Nested/Three.PDF');
    expect(session.getFileCatalog().files.find((file) => file.path.endsWith('Three.PDF'))?.size).toBe(5);
    vault.external({ 'Media/Nested/Three.PDF': null });
    expect(session.getFileCatalog().files.some((file) => file.path.endsWith('Three.PDF'))).toBe(false);
    vault.folderGone('Media');
    expect(session.getFileCatalog().files).toEqual([]);
    expect(Object.keys(session.getState().pages)).toEqual(originalPages);
    expect(catalogUpdates).toBeGreaterThanOrEqual(3);

    vault.emptyFolder('Empty external folder');
    expect(
      Object.values(session.getState().pages).some((page) => page.title === 'Empty external folder'),
    ).toBe(true);
    expect(session.getFileCatalog().folders).toEqual([]);
    expect(vault.text('Empty external folder.md')).toBeUndefined();
    unsubscribe();
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
