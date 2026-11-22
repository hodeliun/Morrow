import { describe, expect, it } from 'vitest';
import type { Command } from '../core/commands';
import { planArchiveImport } from '../core/importer';
import { emptyWorkspace } from '../core/model';
import type { PageId } from '../core/model';
import { planMarkdownImport } from '../core/portability';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import {
  MANAGED_KEYS,
  readPageText,
  renderPageText,
  UnsafeFrontmatterUpdateError,
} from '../core/vault/pageFile';
import { splitFrontmatter } from '../core/vault/frontmatter';
import { databaseFromSubpages, fieldsForMove, releaseRow } from '../core/properties';
import { defaultDatabase } from '../core/database';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let counter = 0;
const newId = () => `id${++counter}`;

class TrackedMemoryVault extends MemoryVault {
  applyCount = 0;
  readonly writtenPaths: string[] = [];

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.applyCount += 1;
    this.writtenPaths.push(...ops.filter((op) => op.op === 'write').map((op) => op.path));
    return super.apply(ops);
  }
}

class ConflictInjectingMemoryVault extends TrackedMemoryVault {
  conflict: { path: string; current: string } | null = null;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const conflict = this.conflict;
    if (conflict && ops.some((op) => op.op === 'write' && op.path === conflict.path)) {
      this.files.set(conflict.path, conflict.current);
      this.conflict = null;
    }
    return super.apply(ops);
  }
}

class FailNamedWriteMemoryVault extends TrackedMemoryVault {
  failPath: string | null = null;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const failPath = this.failPath;
    const failedAt = failPath
      ? ops.findIndex((op) => op.op === 'write' && op.path === failPath)
      : -1;
    if (failedAt > 0) {
      this.failPath = null;
      return [
        ...(await super.apply(ops.slice(0, failedAt))),
        { ok: false, code: 'error', message: 'injected write failure' },
      ];
    }
    return super.apply(ops);
  }
}

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

async function runAll(session: WorkspaceSession, commands: Command[]): Promise<void> {
  const result = session.executeAll(commands);
  if (!result.ok) throw new Error(result.error);
  await session.flush();
}

// what the app's move does: carry the page's values along, then move it
async function move(session: WorkspaceSession, id: PageId, parentId: PageId | null): Promise<void> {
  const plan = fieldsForMove(session.getState().pages, id, parentId, newId);
  await runAll(session, [
    ...(plan?.database
      ? [{ type: 'database.set', id: plan.database.id, database: plan.database.database, now: 5 } as const]
      : []),
    ...(plan
      ? [
          {
            type: 'page.setFields',
            id,
            properties: plan.fields.properties,
            extra: plan.fields.extra,
            now: 5,
          } as const,
        ]
      : []),
    { type: 'page.move', id, parentId },
  ]);
}

const NOTE = '---\ndate: 2024-05-01\nauthor: Ursula\nrating: 4\n---\nA note from obsidian.\n';
const OKF_NOTE = `---
# OKF metadata comment
sources: # source records
  - id: source-001
    title: Original source
    locator: https://example.test/source
anchor: &evidence
  id: evidence-001
  enabled: false
mirror: *evidence
typed: !!str 003 # keep the explicit YAML type
nullable: null
disabled: false
zero: 0
---
Original body\n`;

function paragraph(text: string) {
  return { type: 'doc' as const, content: [{ type: 'paragraph' as const, content: [{ type: 'text' as const, text }] }] };
}

describe('frontmatter from other apps', () => {
  it('keeps complex YAML through a body edit, a metadata edit, and reopening', async () => {
    const vault = new TrackedMemoryVault({ 'Note.md': OKF_NOTE });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    const pageId = note;

    await runAll(session, [{ type: 'page.setDoc', id: note, doc: paragraph('Edited body'), now: 2 }]);
    const afterBodyEdit = vault.text('Note.md')!;
    expect(splitFrontmatter(afterBodyEdit).head).toBe(splitFrontmatter(OKF_NOTE).head);

    await runAll(session, [{ type: 'page.setIcon', id: note, icon: '🌱', now: 3 }]);
    const saved = vault.text('Note.md')!;
    const extra = readPageText(saved).extra;
    expect(saved).toContain('# OKF metadata comment');
    expect(saved).toContain('# source records');
    expect(saved).toContain('# keep the explicit YAML type');
    expect(saved).toContain('!!str');
    expect(saved).toContain('mirror: *evidence');
    expect(saved).toContain('icon: 🌱');
    expect(saved).toContain('Edited body');
    expect(extra.sources).toEqual([
      { id: 'source-001', title: 'Original source', locator: 'https://example.test/source' },
    ]);
    expect(extra.anchor).toEqual({ id: 'evidence-001', enabled: false });
    expect(extra.mirror).toEqual({ id: 'evidence-001', enabled: false });
    expect(extra.typed).toBe('003');
    expect(Object.hasOwn(extra, 'nullable')).toBe(true);
    expect(extra.nullable).toBeNull();
    expect(extra.disabled).toBe(false);
    expect(extra.zero).toBe(0);
    expect(Object.hasOwn(extra, 'absent')).toBe(false);

    await session.close();
    const reopened = await open(vault);
    const reopenedId = idOf(reopened, 'Note');
    expect(reopenedId).toBe(pageId);
    expect(reopened.getState().pages[reopenedId]!.extra.sources).toEqual(extra.sources);
    expect(reopened.getState().pages[reopenedId]!.extra.nullable).toBeNull();
    expect(reopened.getState().pages[reopenedId]!.extra.disabled).toBe(false);
    expect(reopened.getState().pages[reopenedId]!.extra.zero).toBe(0);
    await reopened.close();
  });

  it('reads a saved note style without claiming the YAML key and preserves it byte-for-byte on a body edit', async () => {
    const source = `---\nmorrowNoteStyle:\n  font: serif\n  fontSize: 19\n  lineHeight: 1.8\n  blockSpacing: 12\n  width: wide\nfutureStyleData:\n  opaque: !!str 001\n  enabled: false\n---\nOriginal body\n`;
    const vault = new TrackedMemoryVault({ 'Note.md': source });
    const session = await open(vault);
    const note = idOf(session, 'Note');

    expect(vault.applyCount).toBe(0);
    expect(MANAGED_KEYS.has('morrowNoteStyle')).toBe(false);
    expect(session.getState().pages[note]?.extra.morrowNoteStyle).toEqual({
      font: 'serif',
      fontSize: 19,
      lineHeight: 1.8,
      blockSpacing: 12,
      width: 'wide',
    });
    expect(session.getState().pages[note]?.extra.futureStyleData).toEqual({ opaque: '001', enabled: false });

    await runAll(session, [{ type: 'page.setDoc', id: note, doc: paragraph('Edited body'), now: 2 }]);
    const saved = vault.text('Note.md')!;
    expect(splitFrontmatter(saved).head).toBe(splitFrontmatter(source).head);
    expect(saved.endsWith('Edited body\n')).toBe(true);
    expect(readPageText(saved).extra.morrowNoteStyle).toEqual(readPageText(source).extra.morrowNoteStyle);
    await session.close();
  });

  it('keeps a legacy tag anchor on unrelated edits and does not restore it after removal', async () => {
    const original = '---\ntag: &topic alpha\nmirror: *topic\n---\nOriginal body\n';
    const vault = new TrackedMemoryVault({ 'Note.md': original });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    const originalHead = splitFrontmatter(original).head;

    await runAll(session, [{ type: 'page.setDoc', id: note, doc: paragraph('Body edit'), now: 2 }]);
    expect(splitFrontmatter(vault.text('Note.md')!).head).toBe(originalHead);

    await runAll(session, [{ type: 'page.setIcon', id: note, icon: '🏷️', now: 3 }]);
    expect(vault.text('Note.md')).toContain('tag: &topic alpha');
    expect(vault.text('Note.md')).toContain('mirror: *topic');
    expect(readPageText(vault.text('Note.md')!).extra.mirror).toBe('alpha');

    const removed = session.execute({ type: 'page.setTags', id: note, tags: [], now: 4 });
    expect(removed.ok).toBe(true);
    expect(session.getState().pages[note]!.tags).toEqual([]);
    expect(await session.flush()).toBe(false);
    expect(session.saveStatus.errorCode).toBe('unsafe-frontmatter');
    expect(vault.text('Note.md')).toContain('tag: &topic alpha');
    expect(vault.text('Note.md')).toContain('mirror: *topic');
    await session.close();
  });

  it('does not write note content on open and close', async () => {
    const vault = new TrackedMemoryVault({ 'Note.md': OKF_NOTE });
    const originalMtime = vault.modifiedTime('Note.md');
    const session = await open(vault);
    const note = idOf(session, 'Note');
    const opened = session.execute({ type: 'page.markOpened', id: note, now: 10 });
    expect(opened.ok).toBe(true);
    await session.close();

    expect(vault.text('Note.md')).toBe(OKF_NOTE);
    expect(vault.modifiedTime('Note.md')).toBe(originalMtime);
    expect(vault.writtenPaths.filter((path) => path.endsWith('.md'))).toEqual([]);
  });

  it.each([
    ['without a header', 'Body without a header\n'],
    ['with an empty header', '---\n\n---\nBody in an empty header\n'],
  ])('can add metadata to a note %s and reopen it', async (_name, text) => {
    const vault = new TrackedMemoryVault({ 'Note.md': text });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    const pageId = note;
    await runAll(session, [{ type: 'page.setIcon', id: note, icon: '📝', now: 2 }]);
    expect(vault.text('Note.md')).toContain('icon: 📝');
    expect(vault.text('Note.md')).toContain(splitFrontmatter(text).body);
    await session.close();

    const reopened = await open(vault);
    const reopenedId = idOf(reopened, 'Note');
    expect(reopenedId).toBe(pageId);
    expect(reopened.getState().pages[reopenedId]!.icon).toBe('📝');
    await reopened.close();
  });

  it('rejects an ambiguous second note before writing, then retries the safe edit', async () => {
    const safeOriginal = OKF_NOTE;
    const ambiguousOriginal = '---\nauthor: first\nauthor: second\n---\nOriginal B\n';
    const vault = new TrackedMemoryVault({ 'A.md': safeOriginal, 'B.md': ambiguousOriginal });
    const session = await open(vault);
    const safeId = idOf(session, 'A');
    const ambiguousId = idOf(session, 'B');
    const safePageId = safeId;

    const staged = session.executeAll([
      { type: 'page.setDoc', id: safeId, doc: paragraph('Edited A'), now: 2 },
      { type: 'page.setIcon', id: ambiguousId, icon: '📌', now: 2 },
    ]);
    expect(staged.ok).toBe(true);
    expect(await session.flush()).toBe(false);
    expect(session.saveStatus.errorCode).toBe('unsafe-frontmatter');
    expect(session.saveStatus.error).toContain('No files were changed.');
    expect(vault.applyCount).toBe(0);
    expect(vault.writtenPaths).toEqual([]);
    expect(vault.text('A.md')).toBe(safeOriginal);
    expect(vault.text('B.md')).toBe(ambiguousOriginal);

    const reverted = session.execute({ type: 'page.setIcon', id: ambiguousId, icon: null, now: 3 });
    expect(reverted.ok).toBe(true);
    expect(await session.flush()).toBe(true);
    expect(session.saveStatus.state).toBe('saved');
    expect(vault.text('A.md')).toBe(`${splitFrontmatter(safeOriginal).head}Edited A\n`);
    expect(vault.text('B.md')).toBe(ambiguousOriginal);
    expect(vault.writtenPaths.filter((path) => path.endsWith('.md'))).toEqual(['A.md']);

    await session.close();
    const reopened = await open(vault);
    expect(idOf(reopened, 'A')).toBe(safePageId);
    expect(vault.text('B.md')).toBe(ambiguousOriginal);
    await reopened.close();
  });

  it('does not snapshot or retry over duplicate YAML that arrives during a write conflict', async () => {
    const original = '---\nauthor: Ursula\n---\nOriginal body\n';
    const external = '---\nauthor: first\nauthor: second\n---\nExternal body\n';
    const vault = new ConflictInjectingMemoryVault({ 'Note.md': original });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    const draft = paragraph('Staged body');
    const changed = session.execute({ type: 'page.setDoc', id: note, doc: draft, now: 2 });
    expect(changed.ok).toBe(true);
    vault.conflict = { path: 'Note.md', current: external };

    expect(await session.flush()).toBe(false);
    expect(session.saveStatus.errorCode).toBe('unsafe-frontmatter');
    expect(session.queue.isDirty(note)).toBe(true);
    expect(session.getState().docs[note]).toEqual(draft);
    expect(vault.text('Note.md')).toBe(external);
    expect(vault.applyCount).toBe(1);
    const snapshots = await session.listSnapshots(note);
    expect(JSON.stringify(snapshots)).not.toContain('External body');
    expect(vault.text(`.morrow/history/${note}.json`)).toBeUndefined();
    await session.close();
    expect(vault.text('Note.md')).toBe(external);
  });

  it('reverts a page already written when a later page in the batch fails', async () => {
    const originalA = '---\ntag: &topic alpha\nmirror: *topic\n---\nOriginal A\n';
    const originalB = '---\nauthor: Ursula\n---\nOriginal B\n';
    const vault = new FailNamedWriteMemoryVault({ 'A.md': originalA, 'B.md': originalB });
    const session = await open(vault);
    const a = idOf(session, 'A');
    const b = idOf(session, 'B');
    vault.failPath = 'B.md';

    const staged = session.executeAll([
      { type: 'page.setDoc', id: a, doc: paragraph('Edited A'), now: 2 },
      { type: 'page.setIcon', id: a, icon: '🌱', now: 2 },
      { type: 'page.setIcon', id: b, icon: '📌', now: 2 },
    ]);
    expect(staged.ok).toBe(true);
    expect(await session.flush()).toBe(false);
    expect(vault.text('A.md')).toContain('Edited A');
    expect(vault.text('A.md')).toContain('icon: 🌱');
    expect(vault.text('B.md')).toBe(originalB);

    const reverted = session.executeAll([
      { type: 'page.setDoc', id: a, doc: paragraph('Original A'), now: 3 },
      { type: 'page.setIcon', id: a, icon: null, now: 3 },
    ]);
    expect(reverted.ok).toBe(true);
    expect(await session.flush()).toBe(true);
    expect(vault.text('A.md')).toBe(originalA);
    expect(vault.text('B.md')).toContain('icon: 📌');
    expect(readPageText(vault.text('A.md')!).extra.mirror).toBe('alpha');
    await session.close();
  });

  it('refuses an edit when it changes an untouched alias value', async () => {
    const original = '---\nshared: &value before\nmirror: *value\n---\nBody\n';
    const vault = new TrackedMemoryVault({ 'Note.md': original });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    const changed = session.execute({
      type: 'page.setFields',
      id: note,
      extra: { shared: 'after', mirror: 'before' },
      now: 2,
    });
    expect(changed.ok).toBe(true);

    expect(await session.flush()).toBe(false);
    expect(session.saveStatus.errorCode).toBe('unsafe-frontmatter');
    expect(vault.applyCount).toBe(0);
    expect(vault.text('Note.md')).toBe(original);
    await session.close();
  });

  it('preserves an opaque header for body edits and refuses metadata edits', () => {
    const original = '---\ntitle: [unterminated\n---\nBody\n';
    const source = readPageText(original).source;
    const head = splitFrontmatter(original).head;

    expect(renderPageText({}, source, 'Edited body\n')).toBe(`${head}Edited body\n`);
    expect(() => renderPageText({ icon: '📌' }, source, 'Body\n')).toThrow(UnsafeFrontmatterUpdateError);
  });

  it('shows obsidian properties on the page and saves edits to them in place', async () => {
    const vault = new MemoryVault({ 'Note.md': NOTE });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    expect(session.getState().pages[note]!.extra).toEqual({
      date: '2024-05-01',
      author: 'Ursula',
      rating: 4,
    });
    await runAll(session, [
      {
        type: 'page.setFields',
        id: note,
        extra: { date: '2024-05-01', author: 'Ursula K. Le Guin', rating: 4, read: true },
        now: 2,
      },
    ]);
    expect(vault.text('Note.md')).toBe(
      '---\ndate: 2024-05-01\nauthor: Ursula K. Le Guin\nrating: 4\nread: true\n---\nA note from obsidian.\n',
    );
    await session.close();
  });

  it('rewrites only the property that changed, leaving the style and comments of the rest', async () => {
    const text = '---\n# from obsidian\naliases: [Earthsea note]\nauthor: Ursula\nread: true\n---\nBody\n';
    const vault = new MemoryVault({ 'Note.md': text });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    await runAll(session, [
      {
        type: 'page.setFields',
        id: note,
        extra: { aliases: ['Earthsea note'], author: 'Ursula K. Le Guin', rating: 5 },
        now: 2,
      },
    ]);
    expect(vault.text('Note.md')).toBe(
      '---\n# from obsidian\naliases: [Earthsea note]\nauthor: Ursula K. Le Guin\nrating: 5\n---\nBody\n',
    );
    await session.close();
  });

  it('fills a database column whatever the case of the key, and keeps the file spelling', async () => {
    const database = defaultDatabase(newId);
    const vault = new MemoryVault({
      'Reading.md': `---\nkind: database\ndatabase:\n  properties:\n    - id: ${database.properties[1]!.id}\n      name: Date\n      type: date\n  views: []\n---\n`,
      'Reading/Note.md': NOTE,
    });
    const session = await open(vault);
    const note = session.getState().pages[idOf(session, 'Note')]!;
    expect(note.properties[database.properties[1]!.id]).toBe('2024-05-01');
    expect(note.extra).toEqual({ author: 'Ursula', rating: 4 });
    await runAll(session, [{ type: 'page.rename', id: note.id, title: 'Renamed', now: 3 }]);
    // date stays date, no empty Date is added beside it
    expect(vault.text('Reading/Renamed.md')).toBe(
      '---\ndate: 2024-05-01\nauthor: Ursula\nrating: 4\n---\nA note from obsidian.\n',
    );
    await session.close();
  });

  it('keeps a value the column can not hold instead of dropping it', async () => {
    const vault = new MemoryVault({
      'Tasks.md':
        '---\nkind: database\ndatabase:\n  properties:\n    - id: due\n      name: Due\n      type: date\n  views: []\n---\n',
      'Tasks/Call.md': '---\nDue: next tuesday\n---\n',
    });
    const session = await open(vault);
    const call = idOf(session, 'Call');
    expect(session.getState().pages[call]!.extra).toEqual({ Due: 'next tuesday' });
    await runAll(session, [{ type: 'page.rename', id: call, title: 'Call mum', now: 3 }]);
    expect(vault.text('Tasks/Call mum.md')).toBe('---\nDue: next tuesday\n---\n');
    await session.close();
  });

  it('turns frontmatter into columns when a page moves into a database, and back when it leaves', async () => {
    const vault = new MemoryVault({ 'Note.md': NOTE });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    await runAll(session, [
      { type: 'page.create', id: 'db', parentId: null, now: 1, title: 'Books', kind: 'database' },
      { type: 'database.set', id: 'db', database: defaultDatabase(newId), now: 1 },
    ]);
    await move(session, note, 'db');
    const db = session.getState().pages.db!.database!;
    expect(db.properties.map((prop) => [prop.name, prop.type])).toEqual([
      ['Status', 'select'],
      ['Date', 'date'],
      ['author', 'text'],
      ['rating', 'number'],
    ]);
    const row = session.getState().pages[note]!;
    expect(row.extra).toEqual({});
    expect(Object.values(row.properties).sort()).toEqual([4, '2024-05-01', 'Ursula'].sort());
    expect(vault.text('Books/Note.md')).toBe(
      '---\ndate: 2024-05-01\nauthor: Ursula\nrating: 4\n---\nA note from obsidian.\n',
    );

    await move(session, note, null);
    expect(session.getState().pages[note]!.properties).toEqual({});
    expect(vault.text('Note.md')).toBe(NOTE);
    await session.close();
  });

  it('keeps the spelling of a key added in morrow when it later fills a column', async () => {
    const vault = new MemoryVault({ 'Note.md': 'Body\n' });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    // added empty first, the way the page header adds one, then filled in
    await runAll(session, [{ type: 'page.setFields', id: note, extra: { status: '' }, now: 2 }]);
    await runAll(session, [{ type: 'page.setFields', id: note, extra: { status: 'Finished' }, now: 2 }]);
    await runAll(session, [
      { type: 'page.create', id: 'db', parentId: null, now: 3, title: 'Books', kind: 'database' },
      { type: 'database.set', id: 'db', database: defaultDatabase(newId), now: 3 },
    ]);
    await move(session, note, 'db');
    expect(vault.text('Books/Note.md')).toBe('---\nstatus: Finished\n---\nBody\n');
    await session.close();
  });

  it('turns a folder of notes into a database with columns from their frontmatter', async () => {
    const vault = new MemoryVault({
      'Books/Dune.md': '---\nstatus: Read\nyear: 1965\ngenre: [sci-fi]\n---\n',
      'Books/Emma.md': '---\nstatus: Reading\nyear: 1815\n---\n',
      'Books/Kindred.md': '---\nstatus: Read\nyear: 1979\nurl: https://example.com\n---\n',
    });
    const session = await open(vault);
    const books = idOf(session, 'Books');
    const adopted = databaseFromSubpages(session.getState().pages, books, newId, () =>
      defaultDatabase(newId),
    );
    expect(adopted.database.properties.map((prop) => [prop.name, prop.type])).toEqual([
      ['status', 'select'],
      ['year', 'number'],
      ['genre', 'multiSelect'],
      ['url', 'url'],
    ]);
    expect(adopted.database.views.map((view) => view.type)).toEqual(['table', 'board']);
    expect(adopted.rows).toHaveLength(3);
    await runAll(session, [
      { type: 'page.setKind', id: books, kind: 'database', now: 2 },
      { type: 'database.set', id: books, database: adopted.database, now: 2 },
      ...adopted.rows.map((row): Command => ({ type: 'page.setFields', ...row, now: 2 })),
    ]);
    // the folder gets a note saying it is a database, the rows' files are unchanged
    expect(vault.text('Books.md')).toContain('kind: database');
    expect(vault.text('Books/Emma.md')).toBe('---\nstatus: Reading\nyear: 1815\n---\n');
    const emma = session.getState().pages[idOf(session, 'Emma')]!;
    expect(releaseRow(emma, session.getState().pages[books]!.database!)).toEqual({
      status: 'Reading',
      year: 1815,
    });
    await session.close();
  });
});

describe('importing notes with frontmatter', () => {
  const text =
    '---\ntitle: Real title\nicon: 🌱\ntags: [garden, ideas]\nmood: calm\n---\n# Real title\n\nBody\n';

  it('reads loose files into page fields instead of text', () => {
    const plan = planMarkdownImport(emptyWorkspace(), [{ name: 'note.md', text }], null, newId, 0);
    const page = plan.pages[0]!;
    expect(page).toMatchObject({
      title: 'Real title',
      icon: '🌱',
      tags: ['garden', 'ideas'],
      extra: { mood: 'calm' },
    });
    expect(plan.docs[page.id]).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
    });
  });

  it('keeps a first heading that differs from the title, and reads archives the same way', () => {
    const data = new TextEncoder().encode('---\ntitle: Short\n---\n# A longer heading\n');
    const plan = planArchiveImport(emptyWorkspace(), [{ path: 'Folder/Short.md', data }], null, newId, 0);
    const page = plan.pages.find((candidate) => candidate.title === 'Short')!;
    expect(plan.docs[page.id]!.content![0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
  });
});
