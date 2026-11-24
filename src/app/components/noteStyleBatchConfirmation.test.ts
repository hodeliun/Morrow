import { describe, expect, it } from 'vitest';
import type { NoteStyle } from '../../core/noteStyle';
import type { DocNode } from '../../core/model';
import { MemoryVault } from '../../storage/memoryVault';
import type { VaultOp, VaultOpResult } from '../../core/vault/plan';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import type { Preferences } from '../platform/preferences';
import { getPreferences } from '../platform/preferences';
import { confirmNoteStyleBatchPreview, createNoteStyleBatchPreviewHost } from './noteStyleBatchPreview';
import type { PluginNoteStyleBatchPreviewLease } from '../plugins/registry';

const DEFAULT_STYLE: NoteStyle = {
  font: 'serif',
  fontSize: 20,
  lineHeight: 1.8,
  blockSpacing: 10,
  width: 'wide',
};

const noteSource = (title: string) => `---\ntitle: ${title}\n---\n${title} body.\n`;
const textDoc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

class ObservedVault extends MemoryVault {
  readonly batches: VaultOp[][] = [];

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.batches.push(ops.map((op) => ({ ...op })));
    return super.apply(ops);
  }
}

class HeldApplyVault extends ObservedVault {
  private predicate: ((ops: VaultOp[]) => boolean) | null = null;
  private entered = false;
  private enterResolve!: () => void;
  private releaseResolve!: () => void;
  private readonly releaseGate = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });
  readonly held = new Promise<void>((resolve) => {
    this.enterResolve = resolve;
  });

  holdWhen(predicate: (ops: VaultOp[]) => boolean): void {
    this.predicate = predicate;
  }

  release(): void {
    this.releaseResolve();
  }

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    if (!this.entered && this.predicate?.(ops)) {
      this.entered = true;
      this.enterResolve();
      await this.releaseGate;
    }
    return super.apply(ops);
  }
}

class AfterInitializeRepository extends VaultRepository {
  afterInitialize: () => void = () => {};

  override async markInitialized(): Promise<void> {
    await super.markInitialized();
    this.afterInitialize();
  }
}

class HeldInitializationRepository extends VaultRepository {
  private enteredResolve!: () => void;
  private releaseResolve!: () => void;
  private readonly releaseGate = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });
  readonly initializationStarted = new Promise<void>((resolve) => {
    this.enteredResolve = resolve;
  });

  releaseInitialization(): void {
    this.releaseResolve();
  }

  override async markInitialized(): Promise<void> {
    await super.markInitialized();
    this.enteredResolve();
    await this.releaseGate;
  }
}

class ConflictAfterFirstStyleWriteVault extends ObservedVault {
  private injected = false;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    const firstStyleWrite = ops.some(
      (op) => op.op === 'write' && op.path === 'One.md' && op.text.includes('morrowNoteStyle:'),
    );
    const result = await super.apply(ops);
    if (firstStyleWrite && !this.injected) {
      this.injected = true;
      await super.apply([
        {
          op: 'write',
          path: 'Second.md',
          text: '---\ntitle: Second\nexternal: changed\n---\nExternal edit.\n',
        },
      ]);
    }
    return result;
  }
}

function makeRuntime(initialSession: WorkspaceSession) {
  let currentSession = initialSession;
  let generation = 1;
  let preferences: Preferences = {
    ...getPreferences(),
    font: DEFAULT_STYLE.font,
    width: DEFAULT_STYLE.width,
    defaultNoteStyle: DEFAULT_STYLE,
  };
  const sessionListeners = new Set<() => void>();
  const preferenceListeners = new Set<() => void>();
  const registrationListeners = new Set<() => void>();

  return {
    runtime: {
      getSession: () => currentSession,
      getSessionGeneration: () => generation,
      subscribeSession(listener: () => void) {
        sessionListeners.add(listener);
        return () => sessionListeners.delete(listener);
      },
      getPreferences: () => preferences,
      subscribePreferences(listener: () => void) {
        preferenceListeners.add(listener);
        return () => preferenceListeners.delete(listener);
      },
      subscribeRegistration(listener: () => void) {
        registrationListeners.add(listener);
        return () => registrationListeners.delete(listener);
      },
    },
    setSession(next: WorkspaceSession) {
      currentSession = next;
      generation += 1;
      for (const listener of [...sessionListeners]) listener();
    },
    setPreferences(next: Preferences) {
      preferences = next;
      for (const listener of [...preferenceListeners]) listener();
    },
    notifyRegistration() {
      for (const listener of [...registrationListeners]) listener();
    },
    preferences: () => preferences,
  };
}

function createHost(runtime: ReturnType<typeof makeRuntime>) {
  let mounted = true;
  let active = true;
  const host = createNoteStyleBatchPreviewHost(
    () => mounted,
    () => active,
    runtime.runtime,
  );
  return {
    host,
    setActive(value: boolean) {
      active = value;
      runtime.notifyRegistration();
    },
    setMounted(value: boolean) {
      mounted = value;
    },
  };
}

async function openSession(vault: MemoryVault): Promise<WorkspaceSession> {
  let id = 0;
  const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `note-${++id}`), {
    delayMs: 0,
  });
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

function pageIdAt(session: WorkspaceSession, path: string): string {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function styleWrites(vault: ObservedVault): string[] {
  return vault.batches
    .flat()
    .filter((op): op is Extract<VaultOp, { op: 'write' }> => op.op === 'write' && op.path.endsWith('.md'))
    .map((op) => op.path);
}

describe('host-only note-style preview confirmation', () => {
  it('rejects stale leases and consumes a current lease once across multiple confirmed notes', async () => {
    const vault = new HeldApplyVault({
      'One.md': noteSource('One'),
      'Two.md': noteSource('Two'),
    });
    vault.holdWhen((ops) => ops.some((op) => op.op === 'write' && op.path === 'One.md'));
    const session = await openSession(vault);
    const runtime = makeRuntime(session);
    const controls = createHost(runtime);
    const stale = controls.host.create('preserve');
    if (!stale) throw new Error('The preview lease was not created.');
    runtime.setPreferences({ ...runtime.preferences(), font: 'mono' });
    expect(await confirmNoteStyleBatchPreview(stale)).toBeNull();
    expect(styleWrites(vault)).toEqual([]);

    runtime.setPreferences({
      ...runtime.preferences(),
      font: DEFAULT_STYLE.font,
      width: DEFAULT_STYLE.width,
      defaultNoteStyle: DEFAULT_STYLE,
    });
    const lease = controls.host.create('preserve');
    if (!lease) throw new Error('The fresh preview lease was not created.');
    expect(lease).not.toHaveProperty('confirm');

    let reentrantPreview: PluginNoteStyleBatchPreviewLease | null = null;
    let reentrantConfirmation: Promise<unknown> | null = null;
    const stopThrowing = lease.subscribe(() => {
      throw new Error('A preview subscriber failed.');
    });
    const stop = lease.subscribe(() => {
      reentrantPreview = controls.host.create('overwrite');
      reentrantConfirmation = confirmNoteStyleBatchPreview(lease);
    });

    try {
      const execution = confirmNoteStyleBatchPreview(lease);
      await vault.held;
      expect(reentrantPreview).toBeNull();
      expect(await reentrantConfirmation).toBeNull();
      expect(await confirmNoteStyleBatchPreview(lease)).toBeNull();
      vault.release();

      const result = await execution;
      expect(result).toMatchObject({
        mode: 'preserve',
        confirmedCount: 2,
        refusedCount: 0,
        unattemptedCount: 0,
        outcomes: [
          { title: 'One', order: 1, status: 'confirmed' },
          { title: 'Two', order: 2, status: 'confirmed' },
        ],
      });
      expect(JSON.stringify(result)).not.toContain('note-');
      expect(lease.isCurrent()).toBe(false);
      expect(styleWrites(vault)).toEqual(['One.md', 'Two.md']);
      expect(vault.text('One.md')).toContain('morrowNoteStyle:');
      expect(vault.text('Two.md')).toContain('morrowNoteStyle:');
    } finally {
      stop();
      stopThrowing();
      vault.release();
      await session.close();
    }
  });

  it('keeps a confirmed first note when the second source conflicts and leaves later notes unattempted', async () => {
    const one = noteSource('One');
    const two = noteSource('Second');
    const three = noteSource('Third');
    const vault = new ConflictAfterFirstStyleWriteVault({
      'One.md': one,
      'Second.md': two,
      'Third.md': three,
    });
    const session = await openSession(vault);
    const controls = createHost(makeRuntime(session));
    const lease = controls.host.create('preserve');
    if (!lease) throw new Error('The preview lease was not created.');

    try {
      const result = await confirmNoteStyleBatchPreview(lease);
      expect(result).toMatchObject({
        confirmedCount: 1,
        refusedCount: 1,
        unattemptedCount: 1,
        outcomes: [
          { title: 'One', order: 1, status: 'confirmed' },
          { title: 'Second', order: 2, status: 'refused' },
          { title: 'Third', order: 3, status: 'unattempted' },
        ],
      });
      expect(session.saveStatus.errorCode).toBe('save-conflict');
      expect(vault.text('One.md')).toContain('morrowNoteStyle:');
      expect(vault.text('Second.md')).toBe(
        '---\ntitle: Second\nexternal: changed\n---\nExternal edit.\n',
      );
      expect(vault.text('Third.md')).toBe(three);
    } finally {
      await session.close();
    }
  });

  it('does not dispatch the style write when the captured profile changes after metadata initialization', async () => {
    const vault = new ObservedVault({ 'One.md': noteSource('One') });
    let id = 0;
    const repository = new AfterInitializeRepository(vault, () => `note-${++id}`);
    const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const runtime = makeRuntime(session);
    repository.afterInitialize = () => {
      const captured = runtime.preferences();
      runtime.setPreferences({ ...captured, width: 'comfortable' });
      runtime.setPreferences(captured);
    };
    const controls = createHost(runtime);
    const lease = controls.host.create('preserve');
    if (!lease) throw new Error('The preview lease was not created.');
    const original = vault.text('One.md');

    try {
      const result = await confirmNoteStyleBatchPreview(lease);
      expect(result).toMatchObject({
        confirmedCount: 0,
        refusedCount: 0,
        unattemptedCount: 1,
        outcomes: [{ title: 'One', order: 1, status: 'unattempted' }],
      });
      expect(vault.text('One.md')).toBe(original);
      expect(styleWrites(vault)).toEqual([]);
      expect(vault.batches.flat().some((op) => op.op === 'write' && op.path === '.morrow/workspace.json')).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('rechecks the original revision after metadata initialization and saves a concurrent body edit', async () => {
    const originals = {
      'One.md': noteSource('One'),
      'Two.md': noteSource('Two'),
      'Three.md': noteSource('Three'),
    };
    const vault = new ObservedVault(originals);
    let id = 0;
    const repository = new HeldInitializationRepository(vault, () => `note-${++id}`);
    const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    const runtime = makeRuntime(session);
    const controls = createHost(runtime);
    const lease = controls.host.create('preserve');
    if (!lease) throw new Error('The preview lease was not created.');
    const oneId = pageIdAt(session, 'One.md');
    let refusalCode: string | null = null;
    const setNoteStyle = session.setNoteStyle.bind(session);
    session.setNoteStyle = async (input) => {
      const result = await setNoteStyle(input);
      if (!result.ok) refusalCode = result.code;
      return result;
    };

    try {
      const execution = confirmNoteStyleBatchPreview(lease);
      await repository.initializationStarted;
      expect(session.execute({
        type: 'page.setDoc',
        id: oneId,
        doc: textDoc('Concurrent body edit.'),
        now: 5,
      }).ok).toBe(true);
      repository.releaseInitialization();

      const result = await execution;
      if (!result) throw new Error('The consumed preview returned no result.');
      expect(result).toMatchObject({
        confirmedCount: 0,
        refusedCount: 1,
        unattemptedCount: 2,
      });
      expect(result.outcomes).toEqual(
        lease.summary.titles.map((title, index) => ({
          title,
          order: index + 1,
          status: index === 0 ? 'refused' : 'unattempted',
        })),
      );
      expect(refusalCode).toBe('stale-revision');

      const saved = await session.flush();
      expect(saved).toBe(true);
      expect(vault.text('One.md')).toContain('Concurrent body edit.');
      expect(vault.text('One.md')).not.toContain('morrowNoteStyle:');
      expect(vault.text('Two.md')).toBe(originals['Two.md']);
      expect(vault.text('Three.md')).toBe(originals['Three.md']);
      expect(
        vault.batches.flat().some(
          (op) => op.op === 'write' && op.path.endsWith('.md') && op.text.includes('morrowNoteStyle:'),
        ),
      ).toBe(false);
    } finally {
      repository.releaseInitialization();
      await session.close();
    }
  });

  it('stops at a fence while the isolated write waits for queued quiet metadata', async () => {
    const vault = new HeldApplyVault({ 'One.md': noteSource('One'), 'Two.md': noteSource('Two') });
    vault.holdWhen((ops) => ops.some((op) => op.op === 'write' && op.path === '.morrow/recent.json'));
    const session = await openSession(vault);
    const oneId = pageIdAt(session, 'One.md');
    const originals = new Map(['One.md', 'Two.md'].map((path) => [path, vault.text(path)]));
    expect(session.execute({ type: 'page.markOpened', id: oneId, now: 5 }).ok).toBe(true);
    expect(session.saveStatus.state).toBe('saved');
    expect(session.queue.hasPending()).toBe(true);
    const controls = createHost(makeRuntime(session));
    const lease = controls.host.create('preserve');
    if (!lease) throw new Error('The quiet snapshot should still be previewable.');

    try {
      const execution = confirmNoteStyleBatchPreview(lease);
      await vault.held;
      const releaseFence = session.beginMutationFence();
      vault.release();
      const result = await execution;
      releaseFence();

      expect(result).toMatchObject({ confirmedCount: 0, refusedCount: 0, unattemptedCount: 2 });
      expect(styleWrites(vault)).toEqual([]);
      expect(vault.text('One.md')).toBe(originals.get('One.md'));
      expect(vault.text('Two.md')).toBe(originals.get('Two.md'));
      expect(controls.host.create('preserve')?.summary.candidateCount).toBe(2);
    } finally {
      vault.release();
      await session.close();
    }
  });

  it.each(['profile', 'session', 'registration', 'fence'] as const)(
    'counts an in-flight confirmation if %s changes context, then leaves later notes unattempted',
    async (change) => {
      const vault = new HeldApplyVault({
        'One.md': noteSource('One'),
        'Second.md': noteSource('Second'),
        'Third.md': noteSource('Third'),
      });
      vault.holdWhen((ops) => ops.some((op) => op.op === 'write' && op.path === 'One.md'));
      const session = await openSession(vault);
      const runtime = makeRuntime(session);
      const controls = createHost(runtime);
      const lease = controls.host.create('preserve');
      if (!lease) throw new Error('The preview lease was not created.');
      const replacement = change === 'session'
        ? await openSession(new MemoryVault({ 'Replacement.md': noteSource('Replacement') }))
        : null;

      try {
        const execution = confirmNoteStyleBatchPreview(lease);
        await vault.held;
        if (change === 'profile') {
          const original = runtime.preferences();
          runtime.setPreferences({ ...original, width: 'comfortable' });
          runtime.setPreferences(original);
        } else if (change === 'session' && replacement) {
          runtime.setSession(replacement);
          runtime.setSession(session);
        } else if (change === 'registration') {
          controls.setActive(false);
          controls.setActive(true);
        } else {
          const releaseFence = session.beginMutationFence();
          releaseFence();
        }
        vault.release();

        const result = await execution;
        expect(result).toMatchObject({
          confirmedCount: 1,
          refusedCount: 0,
          unattemptedCount: 2,
          outcomes: [
            { title: 'One', order: 1, status: 'confirmed' },
            { title: 'Second', order: 2, status: 'unattempted' },
            { title: 'Third', order: 3, status: 'unattempted' },
          ],
        });
        expect(vault.text('One.md')).toContain('morrowNoteStyle:');
        expect(vault.text('Second.md')).toBe(noteSource('Second'));
        expect(vault.text('Third.md')).toBe(noteSource('Third'));
        expect(styleWrites(vault)).toEqual(['One.md']);
        expect(controls.host.create('preserve')?.summary).toMatchObject({
          candidateCount: 2,
          preservedCount: 1,
        });
      } finally {
        vault.release();
        if (replacement) await replacement.close();
        await session.close();
      }
    },
  );
});
