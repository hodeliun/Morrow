import { describe, expect, it } from 'vitest';
import { emptyWorkspace, newPageMeta } from '../../core/model';
import type { PageId, PageMeta, WorkspaceState } from '../../core/model';
import { isEffectivelyTrashed } from '../../core/tree';
import { legacyNoteStyle, projectNoteStyle } from '../../core/noteStyle';
import type { NoteStyle } from '../../core/noteStyle';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import type { VaultOp, VaultOpResult } from '../../core/vault/plan';
import type { Preferences } from '../platform/preferences';
import { getPreferences } from '../platform/preferences';
import { createNoteStyleBatchPreviewHost } from './noteStyleBatchPreview';

const DEFAULT_STYLE: NoteStyle = {
  font: 'serif',
  fontSize: 20,
  lineHeight: 1.8,
  blockSpacing: 10,
  width: 'wide',
};

const OTHER_STYLE: NoteStyle = {
  font: 'mono',
  fontSize: 14.5,
  lineHeight: 1.75,
  blockSpacing: 8,
  width: 'comfortable',
};

class HeldPageCreateVault extends MemoryVault {
  private enteredResolve!: () => void;
  private releaseWrite!: () => void;
  private held = false;
  readonly writeStarted = new Promise<void>((resolve) => {
    this.enteredResolve = resolve;
  });
  private readonly writeGate = new Promise<void>((resolve) => {
    this.releaseWrite = resolve;
  });

  release(): void {
    this.releaseWrite();
  }

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    if (!this.held && ops.some((op) => op.op === 'write' && op.path === 'Queued note.md')) {
      this.held = true;
      this.enteredResolve();
      await this.writeGate;
    }
    return super.apply(ops);
  }
}

class ObservedPreviewVault extends MemoryVault {
  readonly operationBatches: VaultOp[][] = [];

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.operationBatches.push(ops.map((op) => ({ ...op })));
    return super.apply(ops);
  }
}

class FailOnceNoteWriteVault extends ObservedPreviewVault {
  private failed = false;
  private failPath: string | null = null;

  failNextWriteAt(path: string): void {
    this.failPath = path;
  }

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    if (!this.failed && this.failPath && ops.some((op) => op.op === 'write' && op.path === this.failPath)) {
      this.failed = true;
      this.operationBatches.push(ops.map((op) => ({ ...op })));
      return ops.map((op) =>
        op.op === 'write' && op.path === this.failPath
          ? { ok: false as const, code: 'error' as const, message: 'simulated write refusal' }
          : { ok: true as const },
      );
    }
    return super.apply(ops);
  }
}

interface SessionHarness {
  readonly session: WorkspaceSession;
  setState(state: WorkspaceState): void;
  setRevision(id: PageId, revision: string): void;
  setWritable(id: PageId, value: boolean): void;
  setStyleRepresentable(id: PageId, value: boolean): void;
  setPath(id: PageId, path: string): void;
  setQueuePending(value: boolean): void;
  notify(): void;
}

interface RuntimeHarness {
  readonly runtime: {
    getSession(): WorkspaceSession;
    getSessionGeneration(): number;
    subscribeSession(listener: () => void): () => void;
    getPreferences(): Preferences;
    subscribePreferences(listener: () => void): () => void;
  };
  setSession(session: WorkspaceSession): void;
  setPreferences(preferences: Preferences): void;
}

function makeSession(): SessionHarness {
  let currentState = emptyWorkspace();
  const closed = false;
  const fenced = false;
  const unreadable = new Set<PageId>();
  const protectedReasons = new Map<PageId, string>();
  const writable = new Set<PageId>();
  const unrepresentable = new Set<PageId>();
  const physicalPaths = new Map<PageId, string>();
  const revisions = new Map<PageId, string>();
  const listeners = new Set<() => void>();
  const fenceListeners = new Set<() => void>();
  const closeListeners = new Set<() => void>();
  const queueListeners = new Set<() => void>();
  let queuePending = false;
  let queueState: 'saved' | 'pending' | 'saving' | 'error' = 'saved';
  const queue = {
    hasPending: () => queuePending,
    hasNonQuietPendingChanges: () => queuePending,
    subscribe(listener: () => void) {
      queueListeners.add(listener);
      return () => queueListeners.delete(listener);
    },
  };

  const session = {
    getState: () => currentState,
    queue,
    get saveStatus() {
      return { state: queueState, lastSavedAt: null, error: null, errorCode: null, failures: 0 };
    },
    get isClosed() {
      return closed;
    },
    get isMutationFenced() {
      return fenced;
    },
    unreadable,
    protectedReasons,
    pathOf: (id: PageId) => physicalPaths.get(id) ?? null,
    hasWritableNoteStyleSource(id: PageId) {
      const page = currentState.pages[id];
      const parent = page?.parentId ? currentState.pages[page.parentId] : undefined;
      return Boolean(
        !closed &&
          !fenced &&
          page?.kind === 'page' &&
          !isEffectivelyTrashed(currentState.pages, id) &&
          !page.encrypted &&
          !unreadable.has(id) &&
          !protectedReasons.has(id) &&
          !(parent?.kind === 'database' && Object.hasOwn(parent.extra, 'polarisDados')) &&
          writable.has(id),
      );
    },
    canUpdateNoteStyleSource(id: PageId) {
      return Boolean(
        !unrepresentable.has(id) &&
          !closed &&
          !fenced &&
          writable.has(id) &&
          currentState.pages[id]?.kind === 'page',
      );
    },
    readNoteStyle(id: PageId) {
      const page = currentState.pages[id];
      if (closed || !page || page.kind !== 'page')
        return { ok: false as const, code: 'unsupported' as const, message: 'unavailable' };
      return {
        ok: true as const,
        value: {
          pageId: id,
          revision: revisions.get(id) ?? `${id}:r1`,
          style: projectNoteStyle(page.extra.morrowNoteStyle),
        },
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeMutationFence(listener: () => void) {
      fenceListeners.add(listener);
      return () => fenceListeners.delete(listener);
    },
    onClose(listener: () => void) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  } as unknown as WorkspaceSession;

  return {
    session,
    setState(state) {
      currentState = state;
    },
    setRevision(id, revision) {
      revisions.set(id, revision);
    },
    setWritable(id, value) {
      if (value) writable.add(id);
      else writable.delete(id);
    },
    setStyleRepresentable(id, value) {
      if (value) unrepresentable.delete(id);
      else unrepresentable.add(id);
    },
    setPath(id, path) {
      physicalPaths.set(id, path);
    },
    setQueuePending(value) {
      queuePending = value;
      queueState = value ? 'pending' : 'saved';
      for (const listener of [...queueListeners]) listener();
    },
    notify() {
      for (const listener of [...listeners]) listener();
    },
  };
}

function makeRuntime(initialSession: WorkspaceSession): RuntimeHarness {
  let currentSession = initialSession;
  let generation = 1;
  let preferences: Preferences = {
    ...getPreferences(),
    font: 'serif',
    width: 'wide',
    defaultNoteStyle: DEFAULT_STYLE,
  };
  const sessionListeners = new Set<() => void>();
  const preferenceListeners = new Set<() => void>();

  return {
    runtime: {
      getSession: () => currentSession,
      getSessionGeneration: () => generation,
      subscribeSession(listener) {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      getPreferences: () => preferences,
      subscribePreferences(listener) {
        preferenceListeners.add(listener);
        return () => preferenceListeners.delete(listener);
      },
    },
    setSession(next) {
      currentSession = next;
      generation += 1;
      for (const listener of [...sessionListeners]) listener();
    },
    setPreferences(next) {
      preferences = next;
      for (const listener of [...preferenceListeners]) listener();
    },
  };
}

function makeFixture(): { session: SessionHarness; state: WorkspaceState } {
  const session = makeSession();
  const state = emptyWorkspace();
  const pages: Record<PageId, PageMeta> = {};
  const add = (
    id: string,
    title: string,
    fields: Partial<PageMeta> = {},
    source = true,
  ) => {
    pages[id] = newPageMeta({
      id,
      parentId: null,
      title,
      createdAt: 1,
      ...fields,
    });
    if (source) session.setWritable(id, true);
    if (source) session.setPath(id, `${title}.md`);
  };

  add('blank', 'No override');
  add('different', 'Different style', { extra: { morrowNoteStyle: OTHER_STYLE } });
  add('matching', 'Already matches', { extra: { morrowNoteStyle: DEFAULT_STYLE } });
  add('opaque', 'Opaque style', { extra: { morrowNoteStyle: 'future-format' } });
  add('flow-style', 'Flow style', { extra: { morrowNoteStyle: OTHER_STYLE } });
  add('empty-flow-style', 'Empty flow style', { extra: { morrowNoteStyle: {} } });
  add('partial-style', 'Partial style', { extra: { morrowNoteStyle: { font: 'sans' } } });
  session.setStyleRepresentable('flow-style', false);
  session.setStyleRepresentable('empty-flow-style', false);
  add('journal-root', 'Journal', { kind: 'journal' }, false);
  add('template-root', 'Templates', { kind: 'templates' }, false);
  session.setPath('journal-root', 'Journal');
  session.setPath('template-root', 'Templates');
  add('daily', '2026-11-24', { parentId: 'journal-root', dailyDate: '2026-11-24' });
  add('template-note', 'Template note', { parentId: 'template-root' });
  add('extra-1', 'Extra one');
  add('extra-2', 'Extra two');
  add('extra-3', 'Extra three');
  add('fallback-match', 'Profile fallback match', {
    extra: { morrowNoteStyle: legacyNoteStyle('mono', 'full') },
  });
  add('encrypted', 'Encrypted', { encrypted: true });
  add('unreadable', 'Unreadable');
  add('protected', 'Protected');
  add('unsupported', 'No Markdown source', {}, false);
  add('trash-root', 'Trash root', { trashedAt: 3 }, false);
  add('trash-child', 'Hidden under trash', { parentId: 'trash-root' });
  add('datos', 'Datos', { kind: 'database', extra: { polarisDados: {} } }, false);
  add('datos-row', 'Datos row', { parentId: 'datos' });

  session.session.unreadable.add('unreadable');
  session.session.protectedReasons.set('protected', 'Host protected');
  session.setState({ ...state, pages });
  return { session, state: { ...state, pages } };
}

function createHost(runtime: RuntimeHarness['runtime']) {
  let mounted = true;
  let registrationActive = true;
  const host = createNoteStyleBatchPreviewHost(
    () => mounted,
    () => registrationActive,
    runtime,
  );
  return {
    host,
    setMounted(value: boolean) {
      mounted = value;
    },
    setRegistrationActive(value: boolean) {
      registrationActive = value;
    },
  };
}

describe('existing note-style preview', () => {
  it('classifies preserved, matching, opaque, protected, trashed, and unsupported sources', () => {
    const before = makeFixture();
    const runtime = makeRuntime(before.session.session);
    const { host } = createHost(runtime.runtime);
    const beforeText = JSON.stringify(before.session.session.getState());

    const preserve = host.create('preserve');
    expect(preserve?.summary).toMatchObject({
      mode: 'preserve',
      candidateCount: 6,
      preservedCount: 7,
      noOpCount: 0,
      protectedPageCount: 4,
      protectedFormatCount: 0,
      unsupportedSourceCount: 1,
      unsupportedContainerCount: 2,
    });
    expect(preserve?.summary.titles).toEqual([
      'No override',
      '2026-11-24',
      'Template note',
      'Extra one',
    ]);
    expect(preserve?.summary.titles).toHaveLength(4);
    expect(preserve?.summary).not.toHaveProperty('targets');
    expect(JSON.stringify(preserve?.summary)).not.toContain('future-format');

    const overwrite = host.create('overwrite');
    expect(preserve?.isCurrent()).toBe(false);
    expect(overwrite?.summary).toMatchObject({
      mode: 'overwrite',
      candidateCount: 9,
      preservedCount: 0,
      noOpCount: 1,
      protectedPageCount: 4,
      protectedFormatCount: 3,
      unsupportedSourceCount: 1,
      unsupportedContainerCount: 2,
    });
    expect(overwrite?.summary.titles).toHaveLength(4);
    expect(JSON.stringify(overwrite?.summary)).not.toContain('datos-row');
    expect(JSON.stringify(overwrite?.summary)).not.toContain('future-format');
    expect(JSON.stringify(before.session.session.getState())).toBe(beforeText);
  });

  it('uses the saved default or the #241 profile font and width fallback', () => {
    const fixture = makeFixture();
    const runtime = makeRuntime(fixture.session.session);
    runtime.setPreferences({
      ...runtime.runtime.getPreferences(),
      defaultNoteStyle: undefined,
      font: 'mono',
      width: 'full',
    });
    const { host } = createHost(runtime.runtime);
    const preview = host.create('overwrite');

    expect(preview?.summary.noOpCount).toBe(1);
    expect(preview?.summary.titles).toHaveLength(4);
  });

  it('uses only five valid stored style fields for no-op checks and preflights partial/flow YAML', () => {
    const fixture = makeFixture();
    const runtime = makeRuntime(fixture.session.session);
    runtime.setPreferences({
      ...runtime.runtime.getPreferences(),
      defaultNoteStyle: undefined,
      font: 'sans',
      width: 'comfortable',
    });
    const { host } = createHost(runtime.runtime);
    const preview = host.create('overwrite');

    expect(preview?.summary).toMatchObject({
      candidateCount: 10,
      noOpCount: 0,
      protectedFormatCount: 3,
    });
    expect(preview?.summary.titles).not.toContain('Empty flow style');
    expect(preview?.summary.titles).toContain('Partial style');
  });

  it('keeps candidate ids and revisions host-owned and expires on revision, mode, config, session, and activation changes', () => {
    const fixture = makeFixture();
    const runtime = makeRuntime(fixture.session.session);
    const { host, setRegistrationActive, setMounted } = createHost(runtime.runtime);
    const lease = host.create('preserve');
    if (!lease) throw new Error('The preview lease was not created.');
    expect(lease.isCurrent()).toBe(true);
    expect(lease.summary).not.toHaveProperty('targetIds');
    expect(lease.summary).not.toHaveProperty('revisions');

    let notified = 0;
    const stop = lease.subscribe(() => notified++);
    fixture.session.setRevision('blank', 'blank:r2');
    fixture.session.notify();
    expect(lease.isCurrent()).toBe(false);
    expect(notified).toBe(1);
    stop();

    const eligibilityFixture = makeFixture();
    const eligibilityRuntime = makeRuntime(eligibilityFixture.session.session);
    const eligibilityHost = createHost(eligibilityRuntime.runtime).host;
    const eligibilityLease = eligibilityHost.create('preserve');
    if (!eligibilityLease) throw new Error('The eligibility preview lease was not created.');
    eligibilityFixture.session.setWritable('unsupported', true);
    eligibilityFixture.session.notify();
    expect(eligibilityLease.isCurrent()).toBe(false);

    const modeLease = host.create('preserve');
    if (!modeLease) throw new Error('The preview lease was not recreated.');
    host.invalidate();
    expect(modeLease.isCurrent()).toBe(false);

    const configLease = host.create('preserve');
    if (!configLease) throw new Error('The preview lease was not recreated.');
    runtime.setPreferences({ ...runtime.runtime.getPreferences(), defaultNoteStyle: OTHER_STYLE });
    expect(configLease.isCurrent()).toBe(false);

    const sessionLease = host.create('preserve');
    if (!sessionLease) throw new Error('The preview lease was not recreated.');
    runtime.setSession(makeFixture().session.session);
    expect(sessionLease.isCurrent()).toBe(false);

    const activationLease = host.create('preserve');
    if (!activationLease) throw new Error('The preview lease was not recreated.');
    setRegistrationActive(false);
    expect(activationLease.isCurrent()).toBe(false);
    setMounted(false);
  });

  it('refuses pending-write snapshots and expires a lease when the save queue becomes pending', () => {
    const fixture = makeFixture();
    const runtime = makeRuntime(fixture.session.session);
    const { host } = createHost(runtime.runtime);
    const lease = host.create('preserve');
    if (!lease) throw new Error('The idle preview lease was not created.');

    let invalidations = 0;
    lease.subscribe(() => invalidations++);
    fixture.session.setQueuePending(true);

    expect(lease.isCurrent()).toBe(false);
    expect(invalidations).toBe(1);
    expect(host.create('preserve')).toBeNull();

    fixture.session.setQueuePending(false);
    expect(host.create('preserve')?.isCurrent()).toBe(true);
  });

  it('counts a readable child under a protected parent as protected, not writable', () => {
    const fixture = makeFixture();
    const parent = newPageMeta({
      id: 'protected-parent',
      parentId: null,
      title: 'Protected parent',
      createdAt: 1,
    });
    const child = newPageMeta({
      id: 'readable-child',
      parentId: parent.id,
      title: 'Readable child',
      createdAt: 1,
    });
    fixture.session.setWritable(child.id, true);
    fixture.session.setPath(child.id, 'Protected parent/Readable child.md');
    fixture.session.session.unreadable.add(parent.id);
    fixture.session.session.protectedReasons.set(parent.id, 'Malformed YAML');
    const state = {
      ...fixture.state,
      pages: { ...fixture.state.pages, [parent.id]: parent, [child.id]: child },
    };
    fixture.session.setState(state);
    const runtime = makeRuntime(fixture.session.session);
    const { host } = createHost(runtime.runtime);

    const preview = host.create('overwrite');

    expect(preview?.summary.protectedPageCount).toBe(6);
    expect(preview?.summary.candidateCount).toBe(9);
    expect(preview?.summary.titles).not.toContain('Readable child');
  });

  it('waits for a queued Markdown source to be confirmed before taking a snapshot', async () => {
    const vault = new HeldPageCreateVault();
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'queued-note-id'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const preferences: Preferences = {
      ...getPreferences(),
      font: DEFAULT_STYLE.font,
      width: DEFAULT_STYLE.width,
      defaultNoteStyle: DEFAULT_STYLE,
    };
    const runtime = {
      getSession: () => session,
      getSessionGeneration: () => 1,
      subscribeSession: () => () => {},
      getPreferences: () => preferences,
      subscribePreferences: () => () => {},
    };
    const host = createNoteStyleBatchPreviewHost(() => true, () => true, runtime);
    let sessionChanges = 0;
    const stop = session.subscribe(() => sessionChanges++);

    try {
      const created = session.execute({
        type: 'page.create',
        id: 'queued-note-id',
        parentId: null,
        title: 'Queued note',
        now: 1,
      });
      expect(created.ok).toBe(true);
      await vault.writeStarted;
      const changesBeforeConfirmation = sessionChanges;

      expect(session.queue.hasPending()).toBe(true);
      expect(session.saveStatus.state).toBe('saving');
      expect(host.create('preserve')).toBeNull();

      vault.release();
      expect(await session.queue.flush()).toBe(true);
      expect(session.pathOf('queued-note-id')).toBe('Queued note.md');
      expect(sessionChanges).toBe(changesBeforeConfirmation);

      const confirmed = host.create('preserve');
      expect(confirmed?.isCurrent()).toBe(true);
      expect(confirmed?.summary).toMatchObject({
        candidateCount: 1,
        titles: ['Queued note'],
        unsupportedSourceCount: 0,
      });
    } finally {
      stop();
      vault.release();
      await session.close();
    }
  });

  it('keeps the preview current during a quiet page.markOpened save without extra writes', async () => {
    const source = '---\ntitle: Read me\n---\nBody.\n';
    const vault = new ObservedPreviewVault({ 'Read me.md': source });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'recent-note-id'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const pageId = Object.keys(session.getState().pages).find(
      (id) => session.pathOf(id) === 'Read me.md',
    );
    if (!pageId) throw new Error('The fixture note did not load.');
    const runtime = {
      getSession: () => session,
      getSessionGeneration: () => 1,
      subscribeSession: () => () => {},
      getPreferences: () => getPreferences(),
      subscribePreferences: () => () => {},
    };
    const host = createNoteStyleBatchPreviewHost(() => true, () => true, runtime);
    const mtime = vault.modifiedTime('Read me.md');

    try {
      const marked = session.execute({ type: 'page.markOpened', id: pageId, now: 10 });

      expect(marked.ok).toBe(true);
      expect(session.queue.hasPending()).toBe(true);
      expect(session.saveStatus.state).toBe('saved');

      const lease = host.create('preserve');
      if (!lease) throw new Error('The preview was not created while only recent metadata was pending.');
      let invalidations = 0;
      lease.subscribe(() => invalidations++);

      const markedAgain = session.execute({ type: 'page.markOpened', id: pageId, now: 11 });

      expect(markedAgain.ok).toBe(true);
      expect(session.queue.hasPending()).toBe(true);
      expect(session.saveStatus.state).toBe('saved');
      expect(lease.isCurrent()).toBe(true);
      expect(lease.summary.candidateCount).toBe(1);
      expect(invalidations).toBe(0);
      expect(vault.operationBatches).toEqual([]);
      expect(vault.text('Read me.md')).toBe(source);
      expect(vault.modifiedTime('Read me.md')).toBe(mtime);
    } finally {
      session.queue.dispose();
      await session.close();
    }
  });

  it('allows previews after a refused flow-style write but fences an error with real queued work', async () => {
    const flowSource = [
      '---',
      'title: Flow style',
      'morrowNoteStyle: { font: sans, fontSize: 16, lineHeight: 1.68, blockSpacing: 9, width: comfortable }',
      '---',
      'Body stays exact.  ',
      '',
    ].join('\n');
    const otherSource = '---\ntitle: Other\n---\nOriginal body.\n';
    const vault = new FailOnceNoteWriteVault({ 'Flow style.md': flowSource, 'Other.md': otherSource });
    let idCounter = 0;
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `preview-${++idCounter}`), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const pageIdFor = (path: string) =>
      Object.keys(session.getState().pages).find((id) => session.pathOf(id) === path);
    const flowPageId = pageIdFor('Flow style.md');
    const otherPageId = pageIdFor('Other.md');
    if (!flowPageId || !otherPageId) throw new Error('The Markdown fixtures did not load.');
    const flowPath = session.pathOf(flowPageId);
    const otherPath = session.pathOf(otherPageId);
    if (!flowPath || !otherPath) throw new Error('The Markdown source paths were not confirmed.');
    vault.failNextWriteAt(otherPath);
    expect(await session.queue.flush()).toBe(true);
    const flowSourcePath = vault.paths().find((path) => vault.text(path) === flowSource);
    if (!flowSourcePath) throw new Error('The original flow-style Markdown bytes were not present after opening.');
    const initial = session.readNoteStyle(flowPageId);
    if (!initial.ok) throw new Error(initial.message);
    const flowMtime = vault.modifiedTime(flowSourcePath);
    const operationCountBeforeRefusal = vault.operationBatches.length;

    try {
      const refused = await session.setNoteStyle({
        pageId: flowPageId,
        style: DEFAULT_STYLE,
        expectedRevision: initial.value.revision,
      });

      expect(refused.ok).toBe(false);
      expect(session.saveStatus.state).toBe('error');
      expect(session.queue.hasPending()).toBe(false);
      expect(session.queue.hasNonQuietPendingChanges()).toBe(false);

      const marked = session.execute({ type: 'page.markOpened', id: otherPageId, now: 3 });
      expect(marked.ok).toBe(true);
      expect(session.saveStatus.state).toBe('error');
      expect(session.queue.hasPending()).toBe(true);
      expect(session.queue.hasNonQuietPendingChanges()).toBe(false);
      const styleAttemptOps = vault.operationBatches.slice(operationCountBeforeRefusal).flat();
      expect(styleAttemptOps.filter((op) => op.op === 'write' && op.path === flowSourcePath)).toEqual([]);
      expect(vault.text(flowSourcePath)).toBe(flowSource);
      expect(vault.modifiedTime(flowSourcePath)).toBe(flowMtime);

      const runtime = makeRuntime(session);
      const { host } = createHost(runtime.runtime);
      const preserve = host.create('preserve');
      expect(preserve?.isCurrent()).toBe(true);
      expect(preserve?.summary.preservedCount).toBe(1);

      const overwrite = host.create('overwrite');
      expect(overwrite?.isCurrent()).toBe(true);
      expect(overwrite?.summary).toMatchObject({
        candidateCount: 1,
        protectedFormatCount: 1,
      });
      expect(vault.text(flowSourcePath)).toBe(flowSource);
      expect(vault.modifiedTime(flowSourcePath)).toBe(flowMtime);

      const changed = session.execute({
        type: 'page.setDoc',
        id: otherPageId,
        doc: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Edited body.' }] }],
        },
        now: 2,
      });
      expect(changed.ok).toBe(true);
      expect(await session.flush()).toBe(false);
      expect(session.saveStatus.state).toBe('error');
      expect(session.queue.hasNonQuietPendingChanges()).toBe(true);
      expect(overwrite?.isCurrent()).toBe(false);
      expect(host.create('preserve')).toBeNull();
      expect(host.create('overwrite')).toBeNull();
    } finally {
      await session.close();
    }
  });
});
