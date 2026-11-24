import { describe, expect, it, vi } from 'vitest';
import {
  captureExplicitMorrowNoteStyleFile,
  captureInheritedMorrowNoteStyleContext,
  decodeExplicitMorrowNoteStyleSnapshot,
  restoreExplicitMorrowNoteStyleFile,
  splitFrontmatter,
  updateMorrowNoteStyleFile,
} from '../core/vault/frontmatter';
import type {
  ExplicitMorrowNoteStyleSnapshot,
  MorrowNoteStyleRestoreContext,
} from '../core/vault/frontmatter';
import type { NoteStyle } from '../core/noteStyle';
import { MemoryVault } from './memoryVault';
import { SaveQueue } from './saveQueue';
import { WorkspaceSession } from './session';
import type { NoteStyleResult } from './session';
import type { DocNode, PageId } from '../core/model';
import { VaultRepository } from './vaultRepository';
import type { WorkspaceRepository, WriteBatch } from './repository';
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

async function open(
  vault: MemoryVault,
  repository: WorkspaceRepository = new VaultRepository(vault, nextId),
): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(repository, { delayMs: 0 });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function inheritedContext(source: string): MorrowNoteStyleRestoreContext {
  const context = captureInheritedMorrowNoteStyleContext(source);
  if (!context) throw new Error('The source has no safe inherited-style context.');
  return context;
}

function explicitContext(source: string): ExplicitMorrowNoteStyleSnapshot {
  const context = captureExplicitMorrowNoteStyleFile(source);
  if (!context) throw new Error('The source has no safe explicit-style context.');
  return context;
}

async function applyInheritedStyle(session: WorkspaceSession, pageId: PageId): Promise<void> {
  const initial = session.readNoteStyle(pageId);
  if (!initial.ok) throw new Error(initial.message);
  const applied = await session.setNoteStyle({
    pageId,
    style: EDITED,
    expectedRevision: initial.value.revision,
  });
  if (!applied.ok || !applied.value.style)
    throw new Error(applied.ok ? 'Style was not applied.' : applied.message);
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

const RESTORE_VARIANTS = ['inherited', 'explicit'] as const;
type RestoreVariant = (typeof RESTORE_VARIANTS)[number];
type RestoreAuthorization = NonNullable<
  Parameters<WorkspaceSession['restoreInheritedNoteStyle']>[0]['hostAuthorization']
>;

function restoreSource(variant: RestoreVariant): string {
  return variant === 'inherited'
    ? 'Original body.\n'
    : '---\nmorrowNoteStyle:\n  font: sans\n  fontSize: 15\n---\nOriginal body\n';
}

async function applyStyleForRestore(session: WorkspaceSession, pageId: PageId): Promise<string> {
  const initial = session.readNoteStyle(pageId);
  if (!initial.ok) throw new Error(initial.message);
  const applied = await session.setNoteStyle({
    pageId,
    style: EDITED,
    expectedRevision: initial.value.revision,
  });
  if (!applied.ok) throw new Error(applied.message);
  const current = session.readNoteStyle(pageId);
  if (!current.ok) throw new Error(current.message);
  return current.value.revision;
}

function restoreWithAuthorization(
  session: WorkspaceSession,
  variant: RestoreVariant,
  pageId: PageId,
  expectedRevision: string,
  source: string,
  hostAuthorization: RestoreAuthorization,
): Promise<NoteStyleResult> {
  return variant === 'inherited'
    ? session.restoreInheritedNoteStyle({
        pageId,
        expectedRevision,
        appliedStyle: EDITED,
        context: inheritedContext(source),
        hostAuthorization,
      })
    : session.restoreExplicitNoteStyle({
        pageId,
        expectedRevision,
        appliedStyle: EDITED,
        context: explicitContext(source),
        hostAuthorization,
      });
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

class GatedInitializeRepository extends VaultRepository {
  private nextGate: { entered: () => void; wait: Promise<void>; release: () => void } | null = null;

  holdNextInitialization(): { entered: Promise<void>; release: () => void } {
    let enteredResolve!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextGate = { entered: enteredResolve, wait, release };
    return { entered, release };
  }

  override async markInitialized(): Promise<void> {
    const gate = this.nextGate;
    if (gate) {
      this.nextGate = null;
      gate.entered();
      await gate.wait;
    }
    await super.markInitialized();
  }
}

class GatedRestoreWriteRepository extends VaultRepository {
  private nextGate: { entered: () => void; wait: Promise<void>; release: () => void } | null = null;

  holdNextRestoreWrite(): { entered: Promise<void>; release: () => void } {
    let enteredResolve!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.nextGate = { entered: enteredResolve, wait, release };
    return { entered, release };
  }

  override async write(batch: WriteBatch): Promise<void> {
    const gate = this.nextGate;
    if (gate && batch.noteStyleRestore) {
      this.nextGate = null;
      gate.entered();
      await gate.wait;
    }
    await super.write(batch);
  }
}

class CaptureCountingRepository extends VaultRepository {
  restoreContextWriteCalls = 0;

  override writeNoteStyle(batch: WriteBatch, options: { readonly captureRestoreContext: true }) {
    this.restoreContextWriteCalls++;
    return super.writeNoteStyle(batch, options);
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
  it('blocks a readable Markdown child when its YAML parent is protected', async () => {
    const parentSource = '---\ntitle: Protected parent\nfuture: [unterminated\n---\nParent body.\n';
    const childSource = '---\ntitle: Readable child\n---\nChild body.\n';
    const vault = new ObservedMemoryVault({
      'Protected.md': parentSource,
      'Protected/Child.md': childSource,
    });
    const session = await open(vault);
    const parentId = pageIdAt(session, 'Protected.md');
    const childId = pageIdAt(session, 'Protected/Child.md');

    try {
      expect(session.unreadable.has(parentId)).toBe(true);
      expect(session.unreadable.has(childId)).toBe(false);
      expect(session.pathOf(childId)).toBe('Protected/Child.md');
      expect(session.hasWritableNoteStyleSource(childId)).toBe(false);
      expect(session.canUpdateNoteStyleSource(childId, EDITED)).toBe(false);

      const revision = session.readNoteStyle(childId);
      if (!revision.ok) throw new Error(revision.message);
      const result = await session.setNoteStyle({
        pageId: childId,
        style: EDITED,
        expectedRevision: revision.value.revision,
      });

      expect(result).toMatchObject({ ok: false, code: 'read-only' });
      expect(vault.operationBatches).toEqual([]);
      expect(vault.text('Protected.md')).toBe(parentSource);
      expect(vault.text('Protected/Child.md')).toBe(childSource);
    } finally {
      await session.close();
    }
  });

  it('distinguishes a folder named like a Markdown file from a writable note source', async () => {
    const vault = new MemoryVault({ 'x.md/Child.md': 'Child note.\n' });
    const session = await open(vault);
    const folderId = pageIdAt(session, 'x.md');
    const childId = pageIdAt(session, 'x.md/Child.md');

    expect(session.pathOf(folderId)).toBe('x.md');
    expect(session.hasWritableNoteStyleSource(folderId)).toBe(false);
    expect(session.hasWritableNoteStyleSource(childId)).toBe(true);
    await session.close();
  });

  it('preflights the current style serializer without writing flow-style YAML', async () => {
    const source = [
      '---',
      'title: Flow style',
      'morrowNoteStyle: { font: sans, fontSize: 16, lineHeight: 1.68, blockSpacing: 9, width: comfortable }',
      '---',
      'Body stays exact.  ',
      '',
    ].join('\n');
    const emptyFlowSource = '---\ntitle: Empty flow style\nmorrowNoteStyle: {}\n---\nBody stays exact.\n';
    const vault = new ObservedMemoryVault({ 'Flow.md': source, 'Empty flow.md': emptyFlowSource });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Flow.md');
    const emptyFlowId = pageIdAt(session, 'Empty flow.md');
    const mtime = vault.modifiedTime('Flow.md');
    const emptyFlowMtime = vault.modifiedTime('Empty flow.md');

    expect(session.hasWritableNoteStyleSource(pageId)).toBe(true);
    expect(session.canUpdateNoteStyleSource(pageId, EDITED)).toBe(false);
    expect(session.hasWritableNoteStyleSource(emptyFlowId)).toBe(true);
    expect(session.canUpdateNoteStyleSource(emptyFlowId, EDITED)).toBe(false);
    expect(session.readNoteStyle(pageId)).toMatchObject({
      ok: true,
      value: {
        style: { font: 'sans', fontSize: 16, width: 'comfortable' },
      },
    });
    expect(vault.text('Flow.md')).toBe(source);
    expect(vault.text('Empty flow.md')).toBe(emptyFlowSource);
    expect(vault.modifiedTime('Flow.md')).toBe(mtime);
    expect(vault.modifiedTime('Empty flow.md')).toBe(emptyFlowMtime);
    expect(vault.operationBatches).toEqual([]);
    await session.close();
  });

  it('preflights a partial block style as writable so missing owned fields are not a false no-op', async () => {
    const source = '---\ntitle: Partial style\nmorrowNoteStyle:\n  font: sans\n---\nBody stays exact.\n';
    const vault = new ObservedMemoryVault({ 'Partial.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Partial.md');
    const mtime = vault.modifiedTime('Partial.md');

    expect(session.canUpdateNoteStyleSource(pageId, EDITED)).toBe(true);
    expect(session.readNoteStyle(pageId)).toMatchObject({
      ok: true,
      value: {
        style: { font: 'sans', fontSize: 16, lineHeight: 1.68, blockSpacing: 9, width: 'comfortable' },
      },
    });
    expect(vault.text('Partial.md')).toBe(source);
    expect(vault.modifiedTime('Partial.md')).toBe(mtime);
    expect(vault.operationBatches).toEqual([]);
    await session.close();
  });

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

  it('collects inherited context only for an opted-in confirmed write and keeps it out of storage', async () => {
    const source = '---\ntitle: Inherited\nstatus: keep\n---\nBody bytes stay exact.  \n';
    const ordinaryVault = new ObservedMemoryVault({ 'Ordinary.md': source });
    const ordinaryRepository = new CaptureCountingRepository(ordinaryVault, nextId);
    const ordinarySession = await open(ordinaryVault, ordinaryRepository);
    const ordinaryPageId = pageIdAt(ordinarySession, 'Ordinary.md');
    const ordinarySnapshot = ordinarySession.readNoteStyle(ordinaryPageId);
    if (!ordinarySnapshot.ok) throw new Error(ordinarySnapshot.message);
    const ordinary = await ordinarySession.setNoteStyle({
      pageId: ordinaryPageId,
      style: EDITED,
      expectedRevision: ordinarySnapshot.value.revision,
    });
    expect(ordinary.ok).toBe(true);
    expect('restoreContext' in ordinary).toBe(false);
    expect(ordinaryRepository.restoreContextWriteCalls).toBe(0);
    await ordinarySession.close();

    const vault = new ObservedMemoryVault({ 'Note.md': source });
    const repository = new CaptureCountingRepository(vault, nextId);
    const session = await open(vault, repository);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    const captured = await session.setNoteStyleWithRestoreContext({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });

    expect(captured).toMatchObject({
      ok: true,
      op: 'write',
      restoreContext: {
        kind: 'inherited',
        context: {
          hadFrontmatter: true,
          separatorAdded: true,
          emptyFrontmatterHadBlankLine: null,
        },
      },
    });
    expect(repository.restoreContextWriteCalls).toBe(1);
    const notePath = session.pathOf(pageId);
    if (!notePath) throw new Error('The test note has no Markdown source path.');
    const sourceOps = vault.operationBatches
      .flat()
      .filter((op) => (op.op === 'check' || op.op === 'write') && op.path === notePath);
    expect(sourceOps.at(-1)).toMatchObject({ op: 'write', expect: source });
    expect(vault.text(notePath)).not.toContain('restoreContext');
    expect(vault.text('.morrow/workspace.json') ?? '').not.toContain('restoreContext');
    expect(session.getState().pages[pageId]?.extra).not.toHaveProperty('restoreContext');
    await session.close();
  });

  it('captures the explicit partial style snapshot from the exact source used by CAS', async () => {
    const source =
      '---\ntitle: Partial\nmorrowNoteStyle:\n  font: "sans"\n  fontSize: 16.0\nfuture: keep\n---\nBody bytes.\n';
    const vault = new ObservedMemoryVault({ 'Note.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);

    const result = await session.setNoteStyleWithRestoreContext({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.op).toBe('write');
    expect(result.restoreContext?.kind).toBe('explicit');
    if (result.restoreContext?.kind !== 'explicit') throw new Error('Expected explicit style context.');
    expect(result.restoreContext.context.fields).toEqual({ font: ' "sans"', fontSize: ' 16.0' });
    const notePath = session.pathOf(pageId);
    if (!notePath) throw new Error('The test note has no Markdown source path.');
    const sourceWrite = vault.operationBatches.flat().find((op) => op.op === 'write' && op.path === notePath);
    expect(sourceWrite).toMatchObject({ expect: source });
    expect(vault.text(notePath)).not.toContain('fields:');
    await session.close();
  });

  it('captures reversible explicit context with nested unknown YAML at the end of the style', async () => {
    const source = '---\nmorrowNoteStyle:\n  font: serif\n  future:\n    child: yes\n---\nBody\n';
    const vault = new ObservedMemoryVault({ 'Note.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);

    const result = await session.setNoteStyleWithRestoreContext({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });

    expect(result).toMatchObject({ ok: true, op: 'write', restoreContext: { kind: 'explicit' } });
    if (!result.ok || result.restoreContext?.kind !== 'explicit') {
      throw new Error('Expected explicit style context.');
    }
    const notePath = session.pathOf(pageId);
    if (!notePath) throw new Error('The test note has no Markdown source path.');
    const appliedText = vault.text(notePath)!;
    expect(appliedText).not.toBe(source);
    expect(restoreExplicitMorrowNoteStyleFile(appliedText, EDITED, result.restoreContext.context)).toBe(source);
    expect(splitFrontmatter(appliedText).data?.morrowNoteStyle).toMatchObject({
      ...EDITED,
      future: { child: 'yes' },
    });
    expect(
      vault.operationBatches.flat().find((op) => op.op === 'write' && op.path === notePath),
    ).toMatchObject({
      expect: source,
    });
    await session.close();

    const reopened = await open(vault);
    expect(vault.text(notePath)).toBe(appliedText);
    expect(reopened.readNoteStyle(pageId)).toMatchObject({ ok: true, value: { style: EDITED } });
    await reopened.close();
  });

  it('keeps a safe style write when the previous explicit source has no safe inverse', async () => {
    const source =
      '---\nmorrowNoteStyle:\n  font: !!str sans\n  fontSize: 16\n  lineHeight: 1.68\n  blockSpacing: 9\n  width: comfortable\n---\nBody.\n';
    const vault = new MemoryVault({ 'Note.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);

    const result = await session.setNoteStyleWithRestoreContext({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });

    expect(result).toMatchObject({ ok: true, op: 'write', restoreContext: null });
    expect(splitFrontmatter(vault.text('Note.md')!).data?.morrowNoteStyle).toMatchObject(EDITED);
    await session.close();
  });

  it('keeps typed style writes working when the repository has no opt-in capture method', async () => {
    const vault = new MemoryVault({ 'Note.md': 'Body.\n' });
    const base = new VaultRepository(vault, nextId);
    const repository = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'writeNoteStyle') return undefined;
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as WorkspaceRepository;
    const session = await open(vault, repository);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);

    const result = await session.setNoteStyleWithRestoreContext({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });

    expect(result).toMatchObject({ ok: true, op: null, restoreContext: null });
    expect(splitFrontmatter(vault.text('Note.md')!).data?.morrowNoteStyle).toMatchObject(EDITED);
    await session.close();
  });

  it('keeps encrypted style writes successful without returning a restoration context', async () => {
    const vault = new MemoryVault({ 'Secret.md': 'Secret body.\n' });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Secret.md');
    expect((await session.protectPage(pageId, 'secure test password')).ok).toBe(true);
    await session.lockPage(pageId);
    expect((await session.unlockPage(pageId, 'secure test password')).ok).toBe(true);
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);

    const result = await session.setNoteStyleWithRestoreContext({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });

    expect(result).toMatchObject({ ok: true, op: 'write', restoreContext: null });
    expect(session.getState().pages[pageId]?.encrypted).toBe(true);
    await session.close();
  });

  it('does not return context for an equal-style check, a refused write, or a CAS conflict', async () => {
    const alreadyStyled = updateMorrowNoteStyleFile('Body.\n', EDITED);
    if (!alreadyStyled) throw new Error('Could not prepare the style-check source.');
    const checkVault = new ObservedMemoryVault({ 'Note.md': alreadyStyled });
    const checkSession = await open(checkVault);
    const checkPageId = pageIdAt(checkSession, 'Note.md');
    const checkSnapshot = checkSession.readNoteStyle(checkPageId);
    if (!checkSnapshot.ok) throw new Error(checkSnapshot.message);
    const checked = await checkSession.setNoteStyleWithRestoreContext({
      pageId: checkPageId,
      style: EDITED,
      expectedRevision: checkSnapshot.value.revision,
    });
    expect(checked).toMatchObject({ ok: true, op: 'check', restoreContext: null });
    expect(checkVault.operationBatches.flat().some((op) => op.op === 'check' && op.path === 'Note.md')).toBe(
      true,
    );
    expect(checkVault.operationBatches.flat().some((op) => op.op === 'write' && op.path === 'Note.md')).toBe(
      false,
    );
    await checkSession.close();

    const refusedVault = new FailOnceStyleVault({ 'Note.md': 'Body.\n' });
    const refusedSession = await open(refusedVault);
    const refusedPageId = pageIdAt(refusedSession, 'Note.md');
    const refusedSnapshot = refusedSession.readNoteStyle(refusedPageId);
    if (!refusedSnapshot.ok) throw new Error(refusedSnapshot.message);
    const refused = await refusedSession.setNoteStyleWithRestoreContext({
      pageId: refusedPageId,
      style: EDITED,
      expectedRevision: refusedSnapshot.value.revision,
    });
    expect(refused).toMatchObject({ ok: false, code: 'save-failed' });
    expect('restoreContext' in refused).toBe(false);
    expect(refusedVault.text('Note.md')).toBe('Body.\n');
    await refusedSession.close();
    const refusedReopened = await open(refusedVault);
    expect(refusedVault.text('Note.md')).toBe('Body.\n');
    expect(refusedReopened.readNoteStyle(refusedPageId)).toMatchObject({ ok: true, value: { style: null } });
    await refusedReopened.close();

    const conflictSource = 'Body before conflict.\n';
    const conflictVault = new ExternalConflictVault({ 'Note.md': conflictSource });
    const conflictSession = await open(conflictVault);
    await conflictSession.markInitialized();
    const conflictPageId = pageIdAt(conflictSession, 'Note.md');
    const conflictSnapshot = conflictSession.readNoteStyle(conflictPageId);
    if (!conflictSnapshot.ok) throw new Error(conflictSnapshot.message);
    const external = 'Body changed outside Morrow.\n';
    conflictVault.conflict = { path: 'Note.md', text: external };
    const conflicted = await conflictSession.setNoteStyleWithRestoreContext({
      pageId: conflictPageId,
      style: EDITED,
      expectedRevision: conflictSnapshot.value.revision,
    });
    expect(conflicted).toMatchObject({ ok: false, code: 'save-conflict' });
    expect('restoreContext' in conflicted).toBe(false);
    expect(conflictVault.text('Note.md')).toBe(external);
    await conflictSession.close();
  });

  it('delivers captured context only after the vault acknowledges the style write', async () => {
    const vault = new DelayedStyleVault({ 'Note.md': 'Body.\n' });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    let settled = false;
    const styling = session
      .setNoteStyleWithRestoreContext({
        pageId,
        style: EDITED,
        expectedRevision: initial.value.revision,
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await vault.styleWriteStarted;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(vault.text('Note.md')).toBe('Body.\n');
    vault.releaseStyleWrite();
    const confirmed = await styling;
    expect(confirmed).toMatchObject({ ok: true, restoreContext: { kind: 'inherited' } });
    expect(vault.text('Note.md')).not.toBe('Body.\n');
    await session.close();
  });

  it('keeps an acknowledged style application successful when session and queue observers throw', async () => {
    const vault = new ObservedMemoryVault({ 'Note.md': 'Body.\n' });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    let notifiedAfterThrow = 0;
    const unsubscribeThrowingSession = session.subscribe(() => {
      throw new Error('session observer failed');
    });
    const unsubscribeFollowingSession = session.subscribe(() => {
      notifiedAfterThrow++;
    });
    let savedQueueNotifications = 0;
    const unsubscribeThrowingQueue = session.queue.subscribe(() => {
      if (session.saveStatus.state === 'saved') throw new Error('queue observer failed');
    });
    const unsubscribeFollowingQueue = session.queue.subscribe(() => {
      if (session.saveStatus.state === 'saved') savedQueueNotifications++;
    });

    const applied = await session.setNoteStyleWithRestoreContext({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });
    const current = session.readNoteStyle(pageId);
    expect(applied).toMatchObject({ ok: true, op: 'write', value: { style: EDITED } });
    expect(notifiedAfterThrow).toBe(1);
    expect(savedQueueNotifications).toBe(1);
    expect(current).toMatchObject({ ok: true, value: { style: EDITED } });
    if (!current.ok) throw new Error(current.message);
    expect(current.value.revision).not.toBe(initial.value.revision);
    expect(session.saveStatus).toMatchObject({ state: 'saved', error: null, errorCode: null, failures: 0 });
    expect(session.queue.hasPending()).toBe(false);
    expect(await session.flush()).toBe(true);
    const saved = vault.text('Note.md');
    expect(saved).toContain('morrowNoteStyle:');

    unsubscribeThrowingSession();
    unsubscribeFollowingSession();
    unsubscribeThrowingQueue();
    unsubscribeFollowingQueue();
    await session.close();
    const reopened = await open(vault);
    expect(reopened.readNoteStyle(pageId)).toMatchObject({ ok: true, value: { style: EDITED } });
    expect(vault.text('Note.md')).toBe(saved);
    await reopened.close();
  });

  it.each(RESTORE_VARIANTS)(
    'keeps an acknowledged %s restoration successful when session and queue observers throw',
    async (variant) => {
      const source = restoreSource(variant);
      const vault = new ObservedMemoryVault({ 'Note.md': source });
      const session = await open(vault);
      const pageId = pageIdAt(session, 'Note.md');
      const expectedRevision = await applyStyleForRestore(session, pageId);
      let notifiedAfterThrow = 0;
      const unsubscribeThrowingSession = session.subscribe(() => {
        throw new Error('session observer failed');
      });
      const unsubscribeFollowingSession = session.subscribe(() => {
        notifiedAfterThrow++;
      });
      let savedQueueNotifications = 0;
      const unsubscribeThrowingQueue = session.queue.subscribe(() => {
        if (session.saveStatus.state === 'saved') throw new Error('queue observer failed');
      });
      const unsubscribeFollowingQueue = session.queue.subscribe(() => {
        if (session.saveStatus.state === 'saved') savedQueueNotifications++;
      });
      let writeStarted = 0;

      const restored = await restoreWithAuthorization(
        session,
        variant,
        pageId,
        expectedRevision,
        source,
        { isCurrent: () => true, onWriteStarted: () => writeStarted++ },
      );
      const current = session.readNoteStyle(pageId);
      expect(restored).toMatchObject({ ok: true });
      expect(notifiedAfterThrow).toBe(1);
      expect(savedQueueNotifications).toBe(1);
      expect(current).toMatchObject({
        ok: true,
        value: { style: variant === 'inherited' ? null : { font: 'sans', fontSize: 15 } },
      });
      if (!current.ok) throw new Error(current.message);
      expect(current.value.revision).not.toBe(expectedRevision);
      expect(writeStarted).toBe(1);
      expect(vault.text('Note.md')).toBe(source);
      expect(session.saveStatus).toMatchObject({ state: 'saved', error: null, errorCode: null, failures: 0 });
      expect(session.queue.hasPending()).toBe(false);
      expect(await session.flush()).toBe(true);

      unsubscribeThrowingSession();
      unsubscribeFollowingSession();
      unsubscribeThrowingQueue();
      unsubscribeFollowingQueue();
      await session.close();
      const reopened = await open(vault);
      expect(reopened.readNoteStyle(pageId)).toMatchObject({
        ok: true,
        value: { style: variant === 'inherited' ? null : { font: 'sans', fontSize: 15 } },
      });
      expect(vault.text('Note.md')).toBe(source);
      await reopened.close();
    },
  );

  it('rechecks revision and authorization before an opted-in style write dispatches', async () => {
    const revisionVault = new MemoryVault({ 'Note.md': 'Body.\n' });
    const revisionRepository = new GatedInitializeRepository(revisionVault, nextId);
    const revisionSession = await open(revisionVault, revisionRepository);
    const revisionPageId = pageIdAt(revisionSession, 'Note.md');
    const revisionSnapshot = revisionSession.readNoteStyle(revisionPageId);
    if (!revisionSnapshot.ok) throw new Error(revisionSnapshot.message);
    const revisionGate = revisionRepository.holdNextInitialization();
    const staleWrite = revisionSession.setNoteStyleWithRestoreContext({
      pageId: revisionPageId,
      style: EDITED,
      expectedRevision: revisionSnapshot.value.revision,
    });
    await revisionGate.entered;
    expect(
      revisionSession.execute({
        type: 'page.setDoc',
        id: revisionPageId,
        doc: textDoc('Body changed while the style waited.'),
        now: 902,
      }).ok,
    ).toBe(true);
    revisionGate.release();
    expect(await staleWrite).toMatchObject({ ok: false, code: 'stale-revision' });
    expect(revisionVault.text('Note.md')).not.toContain('morrowNoteStyle:');
    await revisionSession.flush();
    await revisionSession.close();

    const authorizationVault = new ObservedMemoryVault({ 'Note.md': 'Body.\n' });
    const authorizationRepository = new GatedInitializeRepository(authorizationVault, nextId);
    const authorizationSession = await open(authorizationVault, authorizationRepository);
    const authorizationPageId = pageIdAt(authorizationSession, 'Note.md');
    const authorizationSnapshot = authorizationSession.readNoteStyle(authorizationPageId);
    if (!authorizationSnapshot.ok) throw new Error(authorizationSnapshot.message);
    const authorizationGate = authorizationRepository.holdNextInitialization();
    let authorized = true;
    let writeStarted = 0;
    const revokedWrite = authorizationSession.setNoteStyleWithRestoreContext({
      pageId: authorizationPageId,
      style: EDITED,
      expectedRevision: authorizationSnapshot.value.revision,
      hostAuthorization: {
        isCurrent: () => authorized,
        onWriteStarted: () => writeStarted++,
      },
    });
    await authorizationGate.entered;
    authorized = false;
    authorizationGate.release();
    expect(await revokedWrite).toMatchObject({ ok: false, code: 'read-only' });
    expect(writeStarted).toBe(0);
    expect(
      authorizationVault.operationBatches.flat().some((op) => op.op === 'write' && op.path === 'Note.md'),
    ).toBe(false);
    await authorizationSession.close();
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

  it('restores the inherited style after accepted body and YAML edits, including no-frontmatter notes', async () => {
    const noFrontmatter = 'Original body bytes.\n';
    const plainVault = new MemoryVault({ 'Plain.md': noFrontmatter });
    const plainSession = await open(plainVault);
    const plainPageId = pageIdAt(plainSession, 'Plain.md');
    const plainContext = inheritedContext(noFrontmatter);
    await applyInheritedStyle(plainSession, plainPageId);
    const plainAfterApply = plainVault.text('Plain.md')!;
    const acceptedBody = 'Edited body bytes.\n';
    plainVault.external({ 'Plain.md': plainAfterApply.replace('Original body bytes.\n', acceptedBody) });
    const plainSnapshot = plainSession.readNoteStyle(plainPageId);
    if (!plainSnapshot.ok) throw new Error(plainSnapshot.message);

    const plainRestored = await plainSession.restoreInheritedNoteStyle({
      pageId: plainPageId,
      expectedRevision: plainSnapshot.value.revision,
      appliedStyle: EDITED,
      context: plainContext,
    });
    expect(plainRestored).toMatchObject({ ok: true, value: { style: null } });
    expect(plainVault.text('Plain.md')).toBe(acceptedBody);
    expect(Object.hasOwn(plainSession.getState().pages[plainPageId]!.extra, 'morrowNoteStyle')).toBe(false);
    expect(plainSession.queue.hasPending()).toBe(false);
    expect(plainSession.readNoteStyle(plainPageId)).toMatchObject({
      ok: true,
      value: { style: null },
    });
    await plainSession.close();
    const plainReopened = await open(plainVault);
    expect(pageIdAt(plainReopened, 'Plain.md')).toBe(plainPageId);
    expect(plainReopened.readNoteStyle(plainPageId)).toMatchObject({
      ok: true,
      value: { style: null },
    });
    await plainReopened.close();

    const withFrontmatter = '---\nstatus: original\n---\nBody before edit.\n';
    const yamlVault = new MemoryVault({ 'Yaml.md': withFrontmatter });
    const yamlSession = await open(yamlVault);
    const yamlPageId = pageIdAt(yamlSession, 'Yaml.md');
    const yamlContext = inheritedContext(withFrontmatter);
    await applyInheritedStyle(yamlSession, yamlPageId);
    const yamlAfterApply = yamlVault.text('Yaml.md')!;
    const acceptedYamlAndBody = yamlAfterApply
      .replace('status: original', 'status: accepted')
      .replace('Body before edit.\n', 'Body edited.\n');
    yamlVault.external({ 'Yaml.md': acceptedYamlAndBody });
    const yamlSnapshot = yamlSession.readNoteStyle(yamlPageId);
    if (!yamlSnapshot.ok) throw new Error(yamlSnapshot.message);

    const yamlRestored = await yamlSession.restoreInheritedNoteStyle({
      pageId: yamlPageId,
      expectedRevision: yamlSnapshot.value.revision,
      appliedStyle: EDITED,
      context: yamlContext,
    });
    expect(yamlRestored).toMatchObject({ ok: true, value: { style: null } });
    expect(yamlVault.text('Yaml.md')).toBe('---\nstatus: accepted\n---\nBody edited.\n');
    expect(Object.hasOwn(yamlSession.getState().pages[yamlPageId]!.extra, 'morrowNoteStyle')).toBe(false);
    expect(splitFrontmatter(yamlVault.text('Yaml.md')!).data).toEqual({ status: 'accepted' });
    await yamlSession.close();
    const yamlReopened = await open(yamlVault);
    expect(pageIdAt(yamlReopened, 'Yaml.md')).toBe(yamlPageId);
    expect(yamlReopened.readNoteStyle(yamlPageId)).toMatchObject({
      ok: true,
      value: { style: null },
    });
    await yamlReopened.close();
  });

  it('restores a partial explicit style, including null and absent fields, over accepted YAML/body edits', async () => {
    const original =
      '---\ntitle: Note\nmorrowNoteStyle:\n  font: "sans" # original font note\n  fontSize: null\n  width: wide\n  futureSetting:\n    mode: keep\nstatus: pending\n---\nOriginal body\n';
    const context = explicitContext(original);
    expect(decodeExplicitMorrowNoteStyleSnapshot(context)).toEqual({
      set: { font: 'sans', fontSize: null, width: 'wide' },
      remove: ['lineHeight', 'blockSpacing'],
    });

    const vault = new MemoryVault({ 'Note.md': original });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    const applied = await session.setNoteStyle({
      pageId,
      style: EDITED,
      expectedRevision: initial.value.revision,
    });
    expect(applied).toMatchObject({ ok: true, value: { style: EDITED } });

    const afterApply = vault.text('Note.md');
    if (!afterApply) throw new Error(`The note-style write moved unexpectedly: ${vault.paths().join(', ')}`);
    const accepted = afterApply
      .replace('# original font note', '# accepted font note')
      .replace('mode: keep', 'mode: accepted')
      .replace('status: pending', 'status: accepted')
      .replace('Original body', 'Accepted body');
    vault.external({ 'Note.md': accepted });
    const current = session.readNoteStyle(pageId);
    if (!current.ok) throw new Error(current.message);

    const restored = await session.restoreExplicitNoteStyle({
      pageId,
      expectedRevision: current.value.revision,
      appliedStyle: EDITED,
      context,
    });
    expect(restored.ok).toBe(true);
    const saved = vault.text('Note.md')!;
    expect(saved).toContain('font: "sans" # accepted font note');
    expect(saved).toContain('fontSize: null');
    expect(saved).toContain('width: wide');
    expect(saved).not.toContain('lineHeight:');
    expect(saved).not.toContain('blockSpacing:');
    expect(saved).toContain('mode: accepted');
    expect(saved).toContain('status: accepted');
    expect(splitFrontmatter(saved).body).toBe('Accepted body\n');
    expect(splitFrontmatter(saved).data?.morrowNoteStyle).toEqual({
      font: 'sans',
      fontSize: null,
      width: 'wide',
      futureSetting: { mode: 'accepted' },
    });
    expect(session.getState().pages[pageId]?.extra.morrowNoteStyle).toEqual(
      splitFrontmatter(saved).data?.morrowNoteStyle,
    );

    await session.close();
    const reopened = await open(vault);
    expect(pageIdAt(reopened, 'Note.md')).toBe(pageId);
    expect(reopened.getState().pages[pageId]?.extra.morrowNoteStyle).toEqual(
      splitFrontmatter(saved).data?.morrowNoteStyle,
    );
    expect(reopened.readNoteStyle(pageId)).toMatchObject({ ok: true });
    await reopened.close();
  });

  it('rechecks explicit restoration revision and mutation leases after initialization', async () => {
    const original = '---\nmorrowNoteStyle:\n  font: sans\n  fontSize: null\n---\nOriginal body\n';
    const vault = new MemoryVault({ 'Note.md': original });
    const repository = new GatedInitializeRepository(vault, nextId);
    const session = await open(vault, repository);
    const pageId = pageIdAt(session, 'Note.md');
    const context = explicitContext(original);
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    expect(
      await session.setNoteStyle({ pageId, style: EDITED, expectedRevision: initial.value.revision }),
    ).toMatchObject({ ok: true });

    const beforeEdit = session.readNoteStyle(pageId);
    if (!beforeEdit.ok) throw new Error(beforeEdit.message);
    const revisionGate = repository.holdNextInitialization();
    const staleRestore = session.restoreExplicitNoteStyle({
      pageId,
      expectedRevision: beforeEdit.value.revision,
      appliedStyle: EDITED,
      context,
    });
    await revisionGate.entered;
    expect(
      session.execute({
        type: 'page.setDoc',
        id: pageId,
        doc: textDoc('Accepted body during initialization.'),
        now: 881,
      }).ok,
    ).toBe(true);
    revisionGate.release();
    expect(await staleRestore).toMatchObject({ ok: false, code: 'stale-revision' });
    expect(await session.flush()).toBe(true);
    expect(splitFrontmatter(vault.text('Note.md')!).data?.morrowNoteStyle).toMatchObject(EDITED);
    expect(splitFrontmatter(vault.text('Note.md')!).body).toContain('Accepted body during initialization.');

    const beforeFence = session.readNoteStyle(pageId);
    if (!beforeFence.ok) throw new Error(beforeFence.message);
    const fenceGate = repository.holdNextInitialization();
    const fencedRestore = session.restoreExplicitNoteStyle({
      pageId,
      expectedRevision: beforeFence.value.revision,
      appliedStyle: EDITED,
      context,
    });
    await fenceGate.entered;
    const releaseFence = session.beginMutationFence();
    fenceGate.release();
    expect(await fencedRestore).toMatchObject({ ok: false, code: 'read-only' });
    expect(splitFrontmatter(vault.text('Note.md')!).data?.morrowNoteStyle).toMatchObject(EDITED);
    releaseFence();
    await session.close();
  });

  it('requires the exact applied five values and refuses an unsafe explicit source without retrying', async () => {
    const original = '---\ntitle: Note\nmorrowNoteStyle:\n  font: sans\n---\nBody\n';
    const vault = new MemoryVault({ 'Note.md': original });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const context = explicitContext(original);
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    expect(
      await session.setNoteStyle({ pageId, style: EDITED, expectedRevision: initial.value.revision }),
    ).toMatchObject({ ok: true });

    const applied = session.readNoteStyle(pageId);
    if (!applied.ok) throw new Error(applied.message);
    const changedStyle: NoteStyle = { ...EDITED, width: 'full' };
    expect(
      await session.setNoteStyle({
        pageId,
        style: changedStyle,
        expectedRevision: applied.value.revision,
      }),
    ).toMatchObject({ ok: true });
    const divergentBytes = vault.text('Note.md');
    const divergent = session.readNoteStyle(pageId);
    if (!divergent.ok) throw new Error(divergent.message);
    expect(
      await session.restoreExplicitNoteStyle({
        pageId,
        expectedRevision: divergent.value.revision,
        appliedStyle: EDITED,
        context,
      }),
    ).toMatchObject({ ok: false, code: 'stale-revision' });
    expect(vault.text('Note.md')).toBe(divergentBytes);

    const unsafe = divergentBytes!.replace('  lineHeight: 1.84', '  lineHeight: 1.84 # added later');
    vault.external({ 'Note.md': unsafe });
    const unsafeCurrent = session.readNoteStyle(pageId);
    if (!unsafeCurrent.ok) throw new Error(unsafeCurrent.message);
    expect(
      await session.restoreExplicitNoteStyle({
        pageId,
        expectedRevision: unsafeCurrent.value.revision,
        appliedStyle: changedStyle,
        context,
      }),
    ).toMatchObject({ ok: false, code: 'save-failed' });
    expect(vault.text('Note.md')).toBe(unsafe);
    expect(session.queue.hasPending()).toBe(false);
    expect(session.saveStatus.errorCode).toBe('unsafe-frontmatter');
    await session.close();
  });

  describe.each(RESTORE_VARIANTS)('%s restore host authorization', (variant) => {
    it('refuses revocation during initialization without dispatching a Markdown write', async () => {
      const source = restoreSource(variant);
      const vault = new ObservedMemoryVault({ 'Note.md': source });
      const repository = new GatedInitializeRepository(vault, nextId);
      const session = await open(vault, repository);
      const pageId = pageIdAt(session, 'Note.md');
      const expectedRevision = await applyStyleForRestore(session, pageId);
      const styledBytes = vault.text('Note.md');
      const operationBatchCount = vault.operationBatches.length;
      const initializeGate = repository.holdNextInitialization();
      let authorized = true;
      let writeStarted = 0;
      const hostAuthorization: RestoreAuthorization = {
        isCurrent: () => authorized,
        onWriteStarted: () => writeStarted++,
      };

      const restoring = restoreWithAuthorization(
        session,
        variant,
        pageId,
        expectedRevision,
        source,
        hostAuthorization,
      );
      await initializeGate.entered;
      authorized = false;
      initializeGate.release();

      expect(await restoring).toMatchObject({ ok: false, code: 'read-only' });
      expect(writeStarted).toBe(0);
      expect(vault.text('Note.md')).toBe(styledBytes);
      expect(
        vault.operationBatches
          .slice(operationBatchCount)
          .flat()
          .filter((op) => op.op === 'write' && op.path === 'Note.md'),
      ).toHaveLength(0);
      expect(session.readNoteStyle(pageId)).toMatchObject({ ok: true, value: { style: EDITED } });
      await session.close();
    });

    it('keeps a dispatched restore confirmed after host revocation and preserves a later body edit', async () => {
      const source = restoreSource(variant);
      const vault = new MemoryVault({ 'Note.md': source });
      const repository = new GatedRestoreWriteRepository(vault, nextId);
      const session = await open(vault, repository);
      const pageId = pageIdAt(session, 'Note.md');
      const expectedRevision = await applyStyleForRestore(session, pageId);
      const writeGate = repository.holdNextRestoreWrite();
      let authorized = true;
      let writeStarted = 0;
      const hostAuthorization: RestoreAuthorization = {
        isCurrent: () => authorized,
        onWriteStarted: () => writeStarted++,
      };

      const restoring = restoreWithAuthorization(
        session,
        variant,
        pageId,
        expectedRevision,
        source,
        hostAuthorization,
      );
      await writeGate.entered;
      expect(writeStarted).toBe(1);
      authorized = false;
      expect(
        session.execute({
          type: 'page.setDoc',
          id: pageId,
          doc: textDoc('Body accepted after dispatch.'),
          now: 883,
        }).ok,
      ).toBe(true);
      writeGate.release();

      expect(await restoring).toMatchObject({ ok: true });
      expect(await session.flush()).toBe(true);
      const saved = vault.text('Note.md')!;
      expect(splitFrontmatter(saved).body).toBe('Body accepted after dispatch.\n');
      if (variant === 'inherited') {
        expect(saved).toBe('Body accepted after dispatch.\n');
        expect(session.readNoteStyle(pageId)).toMatchObject({ ok: true, value: { style: null } });
      } else {
        expect(splitFrontmatter(saved).data?.morrowNoteStyle).toEqual({ font: 'sans', fontSize: 15 });
        expect(session.getState().pages[pageId]?.extra.morrowNoteStyle).toEqual({ font: 'sans', fontSize: 15 });
      }
      expect(writeStarted).toBe(1);
      await session.close();
    });

    it('returns the real CAS conflict after host revocation without retry or rollback', async () => {
      const source = restoreSource(variant);
      const vault = new ExternalConflictVault({ 'Note.md': source });
      const repository = new GatedRestoreWriteRepository(vault, nextId);
      const session = await open(vault, repository);
      const pageId = pageIdAt(session, 'Note.md');
      const expectedRevision = await applyStyleForRestore(session, pageId);
      const currentText = vault.text('Note.md')!;
      const externalBytes = currentText.replace('Original body', 'External bytes stay');
      vault.conflict = { path: 'Note.md', text: externalBytes };
      let observedConflict = 0;
      const unsubscribeThrowingQueue = session.queue.subscribe(() => {
        if (session.saveStatus.state === 'error') throw new Error('queue observer failed');
      });
      const unsubscribeFollowingQueue = session.queue.subscribe(() => {
        if (session.saveStatus.state === 'error') observedConflict++;
      });
      const writeGate = repository.holdNextRestoreWrite();
      let authorized = true;
      let writeStarted = 0;
      const hostAuthorization: RestoreAuthorization = {
        isCurrent: () => authorized,
        onWriteStarted: () => writeStarted++,
      };

      const restoring = restoreWithAuthorization(
        session,
        variant,
        pageId,
        expectedRevision,
        source,
        hostAuthorization,
      );
      await writeGate.entered;
      expect(writeStarted).toBe(1);
      authorized = false;
      writeGate.release();

      expect(await restoring).toMatchObject({ ok: false, code: 'save-conflict' });
      expect(writeStarted).toBe(1);
      expect(vault.styleWriteAttempts).toBe(1);
      expect(vault.text('Note.md')).toBe(externalBytes);
      expect(session.saveStatus.errorCode).toBe('save-conflict');
      expect(session.queue.hasPending()).toBe(false);
      expect(observedConflict).toBe(1);
      unsubscribeThrowingQueue();
      unsubscribeFollowingQueue();
      await session.close();

      const reopened = await open(vault);
      expect(reopened.readNoteStyle(pageId)).toMatchObject({ ok: true, value: { style: EDITED } });
      expect(vault.text('Note.md')).toBe(externalBytes);
      await reopened.close();
    });
  });

  it('publishes an explicit restore onto the latest session state after the source write ACK', async () => {
    const original =
      '---\nmorrowNoteStyle:\n  font: sans\n  fontSize: 15\n  futureSetting: keep\n---\nOriginal body\n';
    const vault = new MemoryVault({ 'Note.md': original });
    const repository = new GatedRestoreWriteRepository(vault, nextId);
    const session = await open(vault, repository);
    const pageId = pageIdAt(session, 'Note.md');
    const context = explicitContext(original);
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    expect(
      await session.setNoteStyle({ pageId, style: EDITED, expectedRevision: initial.value.revision }),
    ).toMatchObject({ ok: true });
    await session.markInitialized();
    const current = session.readNoteStyle(pageId);
    if (!current.ok) throw new Error(current.message);

    const writeGate = repository.holdNextRestoreWrite();
    const restoring = session.restoreExplicitNoteStyle({
      pageId,
      expectedRevision: current.value.revision,
      appliedStyle: EDITED,
      context,
    });
    await writeGate.entered;
    expect(
      session.execute({
        type: 'page.setDoc',
        id: pageId,
        doc: textDoc('Body accepted while the style write is awaiting ACK.'),
        now: 882,
      }).ok,
    ).toBe(true);
    writeGate.release();

    expect(await restoring).toMatchObject({ ok: true });
    expect(session.getState().pages[pageId]?.extra.morrowNoteStyle).toEqual({
      font: 'sans',
      fontSize: 15,
      futureSetting: 'keep',
    });
    expect(await session.flush()).toBe(true);
    expect(splitFrontmatter(vault.text('Note.md')!).data?.morrowNoteStyle).toEqual({
      font: 'sans',
      fontSize: 15,
      futureSetting: 'keep',
    });
    expect(splitFrontmatter(vault.text('Note.md')!).body).toContain(
      'Body accepted while the style write is awaiting ACK.',
    );
    await session.close();

    const reopened = await open(vault);
    expect(reopened.getState().pages[pageId]?.extra.morrowNoteStyle).toEqual({
      font: 'sans',
      fontSize: 15,
      futureSetting: 'keep',
    });
    expect(splitFrontmatter(vault.text('Note.md')!).body).toContain(
      'Body accepted while the style write is awaiting ACK.',
    );
    await reopened.close();
  });

  it('refuses an explicit restore CAS conflict once and preserves the external bytes for reopen', async () => {
    const original = '---\nmorrowNoteStyle:\n  font: sans\n  fontSize: 15\n---\nOriginal body\n';
    const vault = new ExternalConflictVault({ 'Note.md': original });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const context = explicitContext(original);
    const initial = session.readNoteStyle(pageId);
    if (!initial.ok) throw new Error(initial.message);
    expect(
      await session.setNoteStyle({ pageId, style: EDITED, expectedRevision: initial.value.revision }),
    ).toMatchObject({ ok: true });
    const beforeRestore = session.readNoteStyle(pageId);
    if (!beforeRestore.ok) throw new Error(beforeRestore.message);
    const currentText = vault.text('Note.md')!;
    const external = currentText.replace('Original body', 'External bytes stay');
    vault.conflict = { path: 'Note.md', text: external };

    expect(
      await session.restoreExplicitNoteStyle({
        pageId,
        expectedRevision: beforeRestore.value.revision,
        appliedStyle: EDITED,
        context,
      }),
    ).toMatchObject({ ok: false, code: 'save-conflict' });
    expect(vault.text('Note.md')).toBe(external);
    expect(vault.styleWriteAttempts).toBe(1);
    expect(session.queue.hasPending()).toBe(false);
    await session.close();

    const reopened = await open(vault);
    expect(reopened.readNoteStyle(pageId)).toMatchObject({
      ok: true,
      value: { style: EDITED },
    });
    expect(vault.text('Note.md')).toBe(external);
    await reopened.close();
  });

  it('rechecks the page revision after initialization and flushes an accepted body edit', async () => {
    const vault = new MemoryVault({ 'Note.md': 'Original body.\n' });
    const repository = new GatedInitializeRepository(vault, nextId);
    const session = await open(vault, repository);
    const pageId = pageIdAt(session, 'Note.md');
    const context = inheritedContext('Original body.\n');
    await applyInheritedStyle(session, pageId);
    const snapshot = session.readNoteStyle(pageId);
    if (!snapshot.ok) throw new Error(snapshot.message);
    const gate = repository.holdNextInitialization();

    const restoring = session.restoreInheritedNoteStyle({
      pageId,
      expectedRevision: snapshot.value.revision,
      appliedStyle: EDITED,
      context,
    });
    await gate.entered;
    expect(
      session.execute({
        type: 'page.setDoc',
        id: pageId,
        doc: textDoc('Accepted body during initialization.'),
        now: 880,
      }).ok,
    ).toBe(true);
    gate.release();

    expect(await restoring).toMatchObject({ ok: false, code: 'stale-revision' });
    expect(await session.flush()).toBe(true);
    expect(splitFrontmatter(vault.text('Note.md')!).data?.morrowNoteStyle).toMatchObject(EDITED);
    expect(splitFrontmatter(vault.text('Note.md')!).body).toContain('Accepted body during initialization.');
    await session.close();
    const reopened = await open(vault);
    expect(pageIdAt(reopened, 'Note.md')).toBe(pageId);
    expect(splitFrontmatter(vault.text('Note.md')!).body).toContain('Accepted body during initialization.');
    expect(reopened.readNoteStyle(pageId)).toMatchObject({
      ok: true,
      value: { style: EDITED },
    });
    await reopened.close();
  });

  it('rechecks the mutation fence after initialization and leaves the Markdown untouched', async () => {
    const vault = new MemoryVault({ 'Note.md': 'Original body.\n' });
    const repository = new GatedInitializeRepository(vault, nextId);
    const session = await open(vault, repository);
    const pageId = pageIdAt(session, 'Note.md');
    const context = inheritedContext('Original body.\n');
    await applyInheritedStyle(session, pageId);
    const snapshot = session.readNoteStyle(pageId);
    if (!snapshot.ok) throw new Error(snapshot.message);
    const styledText = vault.text('Note.md');
    const gate = repository.holdNextInitialization();

    const restoring = session.restoreInheritedNoteStyle({
      pageId,
      expectedRevision: snapshot.value.revision,
      appliedStyle: EDITED,
      context,
    });
    await gate.entered;
    const releaseFence = session.beginMutationFence();
    gate.release();

    expect(await restoring).toMatchObject({ ok: false, code: 'read-only' });
    expect(vault.text('Note.md')).toBe(styledText);
    releaseFence();
    await session.close();
  });

  it('refuses an unsafe current YAML edit without changing its bytes or retrying', async () => {
    const source = 'Original body.\n';
    const vault = new MemoryVault({ 'Note.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const context = inheritedContext(source);
    await applyInheritedStyle(session, pageId);
    const unsafe = vault.text('Note.md')!.replace('  font: serif\n', '  font: serif # accepted comment\n');
    vault.external({ 'Note.md': unsafe });
    const snapshot = session.readNoteStyle(pageId);
    if (!snapshot.ok) throw new Error(snapshot.message);

    const result = await session.restoreInheritedNoteStyle({
      pageId,
      expectedRevision: snapshot.value.revision,
      appliedStyle: EDITED,
      context,
    });
    expect(result).toMatchObject({ ok: false, code: 'save-failed' });
    expect(vault.text('Note.md')).toBe(unsafe);
    expect(session.queue.hasPending()).toBe(false);
    expect(session.saveStatus.errorCode).toBe('unsafe-frontmatter');
    await session.close();
  });

  it('preserves an external CAS conflict without retrying the restoration', async () => {
    const source = 'Original body.\n';
    const vault = new ExternalConflictVault({ 'Note.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Note.md');
    const context = inheritedContext(source);
    await applyInheritedStyle(session, pageId);
    const snapshot = session.readNoteStyle(pageId);
    if (!snapshot.ok) throw new Error(snapshot.message);
    const external = vault.text('Note.md')!.replace('Original body.\n', 'External bytes stay.\n');
    vault.conflict = { path: 'Note.md', text: external };

    const result = await session.restoreInheritedNoteStyle({
      pageId,
      expectedRevision: snapshot.value.revision,
      appliedStyle: EDITED,
      context,
    });
    expect(result).toMatchObject({ ok: false, code: 'save-conflict' });
    expect(vault.text('Note.md')).toBe(external);
    expect(vault.styleWriteAttempts).toBe(1);
    expect(vault.modifiedTime('Note.md')).toBe(vault.conflictMtime);
    expect(session.saveStatus.errorCode).toBe('save-conflict');
    expect(session.queue.hasPending()).toBe(false);
    await session.close();
  });

  it('rejects a changed style, unlocked encrypted notes, missing sources, and restore without the isolated lane', async () => {
    const source = 'Original body.\n';
    const vault = new MemoryVault({ 'Note.md': source, 'Folder/Child.md': 'Child.\n' });
    const repository = new VaultRepository(vault, nextId);
    const session = await open(vault, repository);
    const pageId = pageIdAt(session, 'Note.md');
    const context = inheritedContext(source);
    await applyInheritedStyle(session, pageId);
    const current = session.readNoteStyle(pageId);
    if (!current.ok) throw new Error(current.message);
    const changedStyle: NoteStyle = { ...EDITED, width: 'full' };
    const changed = await session.setNoteStyle({
      pageId,
      style: changedStyle,
      expectedRevision: current.value.revision,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error(changed.message);
    const changedText = vault.text('Note.md');
    const fresh = session.readNoteStyle(pageId);
    if (!fresh.ok) throw new Error(fresh.message);
    expect(
      await session.restoreInheritedNoteStyle({
        pageId,
        expectedRevision: fresh.value.revision,
        appliedStyle: EDITED,
        context,
      }),
    ).toMatchObject({ ok: false, code: 'stale-revision' });
    expect(vault.text('Note.md')).toBe(changedText);

    const folderPage = Object.values(session.getState().pages).find(
      (page) => page.kind === 'page' && page.title === 'Folder',
    );
    if (!folderPage) throw new Error('Missing synthetic folder page.');
    const folderSnapshot = session.readNoteStyle(folderPage.id);
    if (!folderSnapshot.ok) throw new Error(folderSnapshot.message);
    expect(
      await session.restoreInheritedNoteStyle({
        pageId: folderPage.id,
        expectedRevision: folderSnapshot.value.revision,
        appliedStyle: EDITED,
        context,
      }),
    ).toMatchObject({ ok: false, code: 'inaccessible' });

    const page = session.getState().pages[pageId]!;
    const withoutStyle = { ...page.extra };
    delete withoutStyle.morrowNoteStyle;
    const candidatePage = { ...page, extra: withoutStyle };
    const candidate = {
      ...session.getState(),
      pages: { ...session.getState().pages, [pageId]: candidatePage },
    };
    const laneLess: WriteBatch = {
      pages: [candidatePage],
      docs: [],
      removed: [],
      noteStyleRestore: { kind: 'restore-inherited', pageId, appliedStyle: changedStyle, context },
      state: candidate,
    };
    await expect(repository.write(laneLess)).rejects.toMatchObject({ code: 'unsafe-note-style' });

    await session.close();
  });

  it('rejects restoration while an encrypted page remains unlocked', async () => {
    const source = 'Secret body.\n';
    const vault = new MemoryVault({ 'Secret.md': source });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Secret.md');
    const context = inheritedContext(source);
    await applyInheritedStyle(session, pageId);
    expect((await session.protectPage(pageId, 'secure password for test')).ok).toBe(true);
    expect(session.getState().pages[pageId]?.encrypted).toBe(true);
    const encryptedBytes = vault.text('Secret.md');
    const snapshot = session.readNoteStyle(pageId);
    if (!snapshot.ok) throw new Error(snapshot.message);

    const result = await session.restoreInheritedNoteStyle({
      pageId,
      expectedRevision: snapshot.value.revision,
      appliedStyle: EDITED,
      context,
    });
    expect(result).toMatchObject({ ok: false, code: 'unsupported' });
    expect(vault.text('Secret.md')).toBe(encryptedBytes);
    expect(session.getState().docs[pageId]).toBeDefined();
    await session.close();
  });
});
