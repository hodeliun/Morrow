import { describe, expect, it, vi } from 'vitest';
import { splitFrontmatter, updateMorrowNoteStyleFile } from '../core/vault/frontmatter';
import type { NoteStyle } from '../core/noteStyle';
import { MemoryVault } from './memoryVault';
import { SaveQueue } from './saveQueue';
import { WorkspaceSession } from './session';
import type { DocNode, PageId } from '../core/model';
import { VaultRepository } from './vaultRepository';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';

let idCounter = 0;
const nextId = () => `note-style-${++idCounter}`;

const ORIGINAL = [
  '---',
  '# page comment stays',
  'title: Note',
  'morrowNoteStyle:',
  '  # saved font comment stays',
  '  font: sans # inline comment stays',
  '  fontSize: 16',
  '  lineHeight: 1.68',
  '  blockSpacing: 9',
  '  width: comfortable',
  '  futureSetting:',
  '    # future comment stays',
  '    mode: retained',
  'futureYaml:',
  '  # sibling comment stays',
  '  value: retained',
  '---',
  '# Exact body  ',
  '',
  '  spacing stays   ',
  '',
].join('\n');

const EDITED: NoteStyle = {
  font: 'serif',
  fontSize: 19.5,
  lineHeight: 1.84,
  blockSpacing: 17,
  width: 'wide',
};

const textDoc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(new VaultRepository(vault, nextId), { delayMs: 0 });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

class ExternalConflictVault extends MemoryVault {
  conflict: { path: string; text: string } | null = null;
  styleWriteAttempts = 0;
  conflictMtime: number | undefined;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const conflict = this.conflict;
    if (conflict && ops.some((op) => (op.op === 'check' || op.op === 'write') && op.path === conflict.path)) {
      this.conflict = null;
      this.styleWriteAttempts++;
      this.external({ [conflict.path]: conflict.text });
      this.conflictMtime = this.modifiedTime(conflict.path);
    }
    return super.apply(ops);
  }
}

class DelayedStyleVault extends MemoryVault {
  private enteredResolve!: () => void;
  private releaseWrite!: () => void;
  readonly styleWriteStarted = new Promise<void>((resolve) => {
    this.enteredResolve = resolve;
  });
  private readonly styleWriteGate = new Promise<void>((resolve) => {
    this.releaseWrite = resolve;
  });
  private delayed = false;

  releaseStyleWrite(): void {
    this.releaseWrite();
  }

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    if (
      !this.delayed &&
      ops.some((op) => op.op === 'write' && op.path === 'Note.md' && op.text.includes('morrowNoteStyle:'))
    ) {
      this.delayed = true;
      this.enteredResolve();
      await this.styleWriteGate;
    }
    return super.apply(ops);
  }
}

class FailOnceStyleVault extends MemoryVault {
  private failed = false;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    if (
      !this.failed &&
      ops.some((op) => op.op === 'write' && op.path === 'Note.md' && op.text.includes('morrowNoteStyle:'))
    ) {
      this.failed = true;
      return [{ ok: false as const, code: 'error' as const, message: 'simulated write refusal' }];
    }
    return super.apply(ops);
  }
}

class ObservedMemoryVault extends MemoryVault {
  readonly operationBatches: VaultOp[][] = [];

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.operationBatches.push(ops.map((op) => ({ ...op })));
    return super.apply(ops);
  }
}

describe('typed note style persistence', () => {
  it('writes only the style, preserves raw YAML and body, then reopens at the same page id', async () => {
    const vault = new MemoryVault({ 'Note.md': ORIGINAL, 'Untouched.md': 'Leave me alone.\n' });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const untouchedTime = vault.modifiedTime('Untouched.md');
    const initial = session.readNoteStyle(pageId);
    expect(initial.ok).toBe(true);
    if (!initial.ok) throw new Error(initial.message);
    expect(initial.value.style).toEqual({
      font: 'sans',
      fontSize: 16,
      lineHeight: 1.68,
      blockSpacing: 9,
      width: 'comfortable',
    });

    const saved = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error(saved.message);
    expect(saved.value.pageId).toBe(pageId);
    expect(saved.value.style).toEqual(EDITED);
    expect(session.saveStatus.state).toBe('saved');

    const raw = vault.text('Note.md')!;
    const split = splitFrontmatter(raw);
    expect(split.body).toBe(splitFrontmatter(ORIGINAL).body);
    expect(split.data?.morrowNoteStyle).toEqual({
      ...EDITED,
      futureSetting: { mode: 'retained' },
    });
    expect(split.data?.futureYaml).toEqual({ value: 'retained' });
    for (const comment of [
      '# page comment stays',
      '# saved font comment stays',
      '# inline comment stays',
      '# future comment stays',
      '# sibling comment stays',
    ])
      expect(raw).toContain(comment);
    expect(split.yaml.indexOf('title: Note')).toBeLessThan(split.yaml.indexOf('morrowNoteStyle:'));
    expect(split.yaml.indexOf('morrowNoteStyle:')).toBeLessThan(split.yaml.indexOf('futureYaml:'));
    expect(vault.text('Untouched.md')).toBe('Leave me alone.\n');
    expect(vault.modifiedTime('Untouched.md')).toBe(untouchedTime);

    await session.close();
    const reopened = await open(vault);
    expect(pageIdAt(reopened, 'Note.md')).toBe(pageId);
    const afterReopen = reopened.readNoteStyle(pageId);
    expect(afterReopen.ok && afterReopen.value.style).toEqual(EDITED);
    await reopened.close();
  });

  it('saves a comments-only frontmatter block after initializing sidecars first', async () => {
    const source = '---\n# keep this comment\n---\nBody bytes stay exact.  \n';
    const vault = new ObservedMemoryVault({ 'Note.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);

    const result = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });
    expect(result.ok && result.value.style).toEqual(EDITED);
    const markdown = splitFrontmatter(vault.text('Note.md')!);
    expect(markdown.body).toBe('Body bytes stay exact.  \n');
    expect(vault.text('Note.md')).toContain('# keep this comment');

    const markdownWrite = vault.operationBatches.findIndex((batch) =>
      batch.some((op) => op.op === 'write' && op.path === 'Note.md'),
    );
    expect(markdownWrite).toBeGreaterThanOrEqual(0);
    expect(
      vault.operationBatches
        .slice(markdownWrite + 1)
        .flat()
        .some((op) => op.op === 'write' && op.path.startsWith('.morrow/')),
    ).toBe(false);
    await session.close();
  });

  it('checks equal style values on disk without normalizing their raw YAML formatting', async () => {
    const source = ORIGINAL.replace('fontSize: 16', 'fontSize: 16.0');
    const vault = new ObservedMemoryVault({ 'Note.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    const mtime = vault.modifiedTime('Note.md');

    const result = await session.setNoteStyle({
      pageId,
      style: initial.value.style!,
      expectedRevision: initial.value.revision,
    });
    expect(result.ok && result.value.style).toEqual(initial.value.style);
    expect(vault.text('Note.md')).toBe(source);
    expect(vault.modifiedTime('Note.md')).toBe(mtime);
    const sourceOps = vault.operationBatches
      .flat()
      .filter((op) => (op.op === 'check' || op.op === 'write') && op.path === 'Note.md');
    expect(sourceOps.some((op) => op.op === 'check')).toBe(true);
    expect(sourceOps.some((op) => op.op === 'write')).toBe(false);
    await session.close();
  });

  it('keeps a concurrent body edit queued behind a confirmed style write', async () => {
    const vault = new DelayedStyleVault({ 'Note.md': ORIGINAL });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);

    const styling = session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });
    await vault.styleWriteStarted;
    const editedDoc = textDoc('Concurrent body edit');
    expect(session.execute({ type: 'page.setDoc', id: pageId, doc: editedDoc, now: 456 }).ok).toBe(true);
    expect(session.queue.isDirty(pageId)).toBe(true);
    let flushFinished = false;
    const flushing = session.flush().then((saved) => {
      flushFinished = saved;
    });
    let closeFinished = false;
    const closing = session.close().then(() => {
      closeFinished = true;
    });
    await Promise.resolve();
    expect(flushFinished).toBe(false);
    expect(closeFinished).toBe(false);
    vault.releaseStyleWrite();

    const styled = await styling;
    expect(styled.ok && styled.value.style).toEqual(EDITED);
    expect(session.getState().docs[pageId]).toEqual(editedDoc);
    await flushing;
    expect(flushFinished).toBe(true);
    await closing;
    const stored = vault.text('Note.md')!;
    expect(splitFrontmatter(stored).data?.morrowNoteStyle).toMatchObject(EDITED);
    expect(splitFrontmatter(stored).body).toContain('Concurrent body edit');
    await session.close();
  });

  it('rearms a transient ordinary-save retry after an isolated write releases its reservation', async () => {
    vi.useFakeTimers();
    let writes = 0;
    let isolatedCalled = false;
    const queue = new SaveQueue(
      {
        async write() {
          writes++;
          if (writes === 1) throw new Error('temporary disk failure');
        },
      },
      () => ({ pages: {}, docs: {} }),
      { delayMs: 1, maxRetryMs: 25 },
    );

    try {
      queue.enqueue({ pages: new Set(['queued-page']), docs: new Set(), removed: new Set() });
      const isolated = await queue.runIsolated(['styled-page'], async () => {
        isolatedCalled = true;
      });

      expect(isolated).toEqual({ ok: false });
      expect(isolatedCalled).toBe(false);
      expect(writes).toBe(1);
      expect(queue.status).toMatchObject({ state: 'error', error: 'temporary disk failure' });
      expect(queue.hasPending()).toBe(true);

      await vi.advanceTimersByTimeAsync(24);
      expect(writes).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(writes).toBe(2);
      expect(queue.status).toMatchObject({ state: 'saved', error: null, failures: 0 });
      expect(queue.hasPending()).toBe(false);
    } finally {
      queue.dispose();
      vi.useRealTimers();
    }
  });

  it('uses the validated style snapshot when the caller mutates its input during the disk write', async () => {
    const vault = new DelayedStyleVault({ 'Note.md': ORIGINAL });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    const requested: NoteStyle = { ...EDITED };

    const styling = session.setNoteStyle({
      pageId,
      style: requested,
      expectedRevision: initial.value.revision,
    });
    await vault.styleWriteStarted;
    requested.font = 'mono';
    vault.releaseStyleWrite();

    const saved = await styling;
    expect(saved.ok && saved.value.style).toEqual(EDITED);
    expect(session.readNoteStyle(pageId)).toMatchObject({
      ok: true,
      value: { style: EDITED },
    });
    expect(splitFrontmatter(vault.text('Note.md')!).data?.morrowNoteStyle).toMatchObject(EDITED);
    await session.close();
  });

  it('does not retain a refused style in the queue and allows a safe body save on that file', async () => {
    const vault = new FailOnceStyleVault({ 'Note.md': ORIGINAL });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const before = session.readNoteStyle(pageId);
    if (!before.ok) throw new Error(before.message);

    const refused = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: before.value.revision,
    });
    expect(refused).toMatchObject({ ok: false, code: 'save-failed' });
    expect(vault.text('Note.md')).toBe(ORIGINAL);
    expect(session.readNoteStyle(pageId)).toMatchObject({
      ok: true,
      value: { style: before.value.style },
    });
    expect(session.queue.hasPending()).toBe(false);

    expect(
      session.execute({
        type: 'page.setDoc',
        id: pageId,
        doc: textDoc('Safe body edit after style refusal'),
        now: 457,
      }).ok,
    ).toBe(true);
    expect(await session.flush()).toBe(true);
    const after = splitFrontmatter(vault.text('Note.md')!);
    expect(after.data?.morrowNoteStyle).toEqual(splitFrontmatter(ORIGINAL).data?.morrowNoteStyle);
    expect(after.body).toContain('Safe body edit after style refusal');
    expect(session.saveStatus.state).toBe('saved');
    await session.close();
  });

  it('restores a valid legacy profile style or derives the 2.2 font and width fallback', async () => {
    const vault = new MemoryVault({ 'Note.md': ORIGINAL });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);

    const reset = await session.restoreNoteStyle({
      pageId,
      expectedRevision: initial.value.revision,
      profileDefault: { font: 'serif', fontSize: 20, lineHeight: 1.7, blockSpacing: 10, width: 'full' },
      font: 'mono',
      width: 'wide',
    });
    expect(reset.ok && reset.value.style).toEqual({
      font: 'serif',
      fontSize: 20,
      lineHeight: 1.7,
      blockSpacing: 10,
      width: 'full',
    });

    if (!reset.ok) throw new Error(reset.message);
    const fallback = await session.restoreNoteStyle({
      pageId,
      expectedRevision: reset.value.revision,
      profileDefault: { font: 'serif', fontSize: 45 },
      font: 'mono',
      width: 'full',
    });
    expect(fallback.ok && fallback.value.style).toEqual({
      font: 'mono',
      fontSize: 14.5,
      lineHeight: 1.75,
      blockSpacing: 8,
      width: 'full',
    });
    expect(splitFrontmatter(vault.text('Note.md')!).body).toBe(splitFrontmatter(ORIGINAL).body);
    await session.close();
  });

  it('does not revive a style-editor revision after page state changes A→B→A', async () => {
    const vault = new MemoryVault({ 'Note.md': ORIGINAL });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const original = session.readNoteStyle(pageId);
    if (!original.ok) throw new Error(original.message);

    expect(session.execute({ type: 'page.setFavorite', id: pageId, favorite: true }).ok).toBe(true);
    expect(session.execute({ type: 'page.setFavorite', id: pageId, favorite: false }).ok).toBe(true);
    const returned = session.readNoteStyle(pageId);
    if (!returned.ok) throw new Error(returned.message);
    expect(returned.value.revision).not.toBe(original.value.revision);

    const stale = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: original.value.revision,
    });
    expect(stale).toMatchObject({ ok: false, code: 'stale-revision' });
    await session.close();
  });

  it('refuses to style a protected read-only note without touching its source', async () => {
    const source = '<!-- morrow:image align="right" width="35%" -->\n';
    const vault = new MemoryVault({ 'Protected.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Protected.md');
    expect(session.unreadable.has(pageId)).toBe(true);
    const snapshot = session.readNoteStyle(pageId);
    if (!snapshot.ok) throw new Error(snapshot.message);
    const beforeMtime = vault.modifiedTime('Protected.md');

    const result = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: snapshot.value.revision,
    });
    expect(result).toMatchObject({ ok: false, code: 'read-only' });
    expect(vault.text('Protected.md')).toBe(source);
    expect(vault.modifiedTime('Protected.md')).toBe(beforeMtime);
    await session.close();
  });

  it('rejects stale, trashed, inaccessible, invalid, and externally conflicted writes without replacing file bytes', async () => {
    const vault = new ExternalConflictVault({
      'Note.md': ORIGINAL,
      'Other.md': 'Other note.\n',
      'Folder/Child.md': 'Child.\n',
    });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const stale = session.readNoteStyle(pageId);
    if (!stale.ok) throw new Error(stale.message);

    const rename = session.execute({ type: 'page.rename', id: pageId, title: 'Renamed', now: 123 });
    expect(rename.ok).toBe(true);
    expect(await session.flush()).toBe(true);
    const staleResult = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: stale.value.revision,
    });
    expect(staleResult).toMatchObject({ ok: false, code: 'stale-revision' });

    const renamedPath = 'Renamed.md';
    const current = session.readNoteStyle(pageId);
    if (!current.ok) throw new Error(current.message);
    const invalidResult = await session.setNoteStyle({
      pageId,
      style: { ...EDITED, fontSize: 100 },
      expectedRevision: current.value.revision,
    });
    expect(invalidResult).toMatchObject({ ok: false, code: 'invalid-style' });
    expect(vault.text(renamedPath)).toBeDefined();

    const childId = pageIdAt(session, 'Folder/Child.md');
    const folderPageId = session.getState().pages[childId]!.parentId!;
    expect(session.pathOf(folderPageId)).not.toBeNull();
    const inaccessible = session.readNoteStyle(folderPageId);
    if (!inaccessible.ok) throw new Error(inaccessible.message);
    const inaccessibleWrite = await session.setNoteStyle({
      pageId: folderPageId,
      style: EDITED,
      expectedRevision: inaccessible.value.revision,
    });
    expect(inaccessibleWrite).toMatchObject({ ok: false, code: 'inaccessible' });

    const trashed = session.execute({ type: 'page.trash', id: pageId, now: 124 });
    expect(trashed.ok).toBe(true);
    expect(await session.flush()).toBe(true);
    const trashedSnapshot = session.readNoteStyle(pageId);
    if (!trashedSnapshot.ok) throw new Error(trashedSnapshot.message);
    const trashBytes = vault.text('.trash/Renamed.md')!;
    const trashedWrite = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: trashedSnapshot.value.revision,
    });
    expect(trashedWrite).toMatchObject({ ok: false, code: 'trashed' });
    expect(vault.text('.trash/Renamed.md')).toBe(trashBytes);
    await session.close();
  });

  it('refuses a source changed between revision check and write without rebasing over its bytes', async () => {
    const vault = new ExternalConflictVault({ 'Note.md': ORIGINAL, 'Other.md': 'Other body.\n' });
    const session = await open(vault);
    await session.markInitialized();
    const pageId = pageIdAt(session, 'Note.md');
    const snapshot = session.readNoteStyle(pageId);
    if (!snapshot.ok) throw new Error(snapshot.message);
    const external = '---\ntitle: External\nfutureYaml: keep\n---\nExternal body bytes stay.\n';
    vault.conflict = { path: 'Note.md', text: external };

    const result = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: snapshot.value.revision,
    });
    expect(result).toMatchObject({ ok: false, code: 'save-conflict' });
    expect(vault.text('Note.md')).toBe(external);
    expect(vault.styleWriteAttempts).toBe(1);
    expect(vault.modifiedTime('Note.md')).toBe(vault.conflictMtime);
    expect(session.saveStatus.errorCode).toBe('save-conflict');
    const current = session.readNoteStyle(pageId);
    expect(current.ok && current.value.style).toEqual({
      font: 'sans',
      fontSize: 16,
      lineHeight: 1.68,
      blockSpacing: 9,
      width: 'comfortable',
    });
    expect(session.queue.hasPending()).toBe(false);

    const otherPageId = pageIdAt(session, 'Other.md');
    expect(
      session.execute({
        type: 'page.setDoc',
        id: otherPageId,
        doc: textDoc('Ordinary save after style conflict'),
        now: 789,
      }).ok,
    ).toBe(true);
    expect(await session.flush()).toBe(true);
    expect(vault.text('Other.md')).toContain('Ordinary save after style conflict');
    expect(vault.text('Note.md')).toBe(external);
    expect(session.saveStatus.state).toBe('saved');
    await session.close();
    expect(vault.text('Note.md')).toBe(external);

    const reopened = await open(vault);
    expect(pageIdAt(reopened, 'Note.md')).toBe(pageId);
    const fresh = reopened.readNoteStyle(pageId);
    if (!fresh.ok) throw new Error(fresh.message);
    expect(fresh.value.style).toBeNull();
    const recovered = await reopened.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: fresh.value.revision,
    });
    expect(recovered.ok && recovered.value.style).toEqual(EDITED);
    const recoveredPath = reopened.pathOf(pageId);
    expect(recoveredPath).not.toBeNull();
    expect(vault.text(recoveredPath!)!).not.toBe(external);
    expect(splitFrontmatter(vault.text(recoveredPath!)!).body).toBe('External body bytes stay.\n');
    await reopened.close();
  });

  it('checks disk before confirming a reducer no-op with the same style values', async () => {
    const styledSource = updateMorrowNoteStyleFile(ORIGINAL, EDITED);
    if (!styledSource) throw new Error('Could not prepare a note with the requested style.');
    const vault = new ExternalConflictVault({ 'Note.md': styledSource });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const snapshot = session.readNoteStyle(pageId);
    if (!snapshot.ok) throw new Error(snapshot.message);
    expect(snapshot.value.style).toEqual(EDITED);

    const external = styledSource.replace('# Exact body  ', '# External body  ');
    vault.conflict = { path: 'Note.md', text: external };
    const result = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: snapshot.value.revision,
    });

    expect(result).toMatchObject({ ok: false, code: 'save-conflict' });
    expect(vault.text('Note.md')).toBe(external);
    expect(vault.styleWriteAttempts).toBe(1);
    expect(vault.modifiedTime('Note.md')).toBe(vault.conflictMtime);
    expect(session.saveStatus.errorCode).toBe('save-conflict');
    await session.close();
  });
});
