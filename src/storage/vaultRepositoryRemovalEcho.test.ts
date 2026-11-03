import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { DatabaseDef, PageId } from '../core/model';
import { asTableActionPlan, planInsertRow } from '../core/rowOperations';
import type { VaultOp } from '../core/vault/plan';
import type { VaultOpResult } from '../core/vault/plan';
import { childrenOf } from '../core/tree';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { executeTableAction } from './tableActions';
import { VaultRepository } from './vaultRepository';
import type { VaultBridge, VaultChange } from './vaultBridge';

const FIXED_TIME = 1_800_000_000_000;
const TABLE_ID = 'echo-test-table';
const FIRST_ROW_ID = 'echo-test-first-row';
const SECOND_ROW_ID = 'echo-test-second-row';
const INSERTED_ROW_ID = 'echo-test-inserted-row';
const IDENTITY = { kind: 'database' as const, databaseId: TABLE_ID, viewId: 'echo-test-view' };

let generatedId = 0;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function change(path: string, text: string, mtime: number): VaultChange {
  return {
    path,
    text,
    mtime,
    birthtime: mtime,
    size: new TextEncoder().encode(text).byteLength,
  };
}

function activeRows(session: WorkspaceSession): PageId[] {
  return childrenOf(session.getState().pages, TABLE_ID).map((page) => page.id);
}

function testBridge(vault: MemoryVault) {
  let listener: ((changes: VaultChange[]) => void) | null = null;
  let existsOverride: ((path: string) => Promise<boolean>) | null = null;
  let applyOverride: ((ops: VaultOp[]) => Promise<VaultOpResult[]>) | null = null;

  const bridge: VaultBridge = {
    root: vault.root,
    scan: () => vault.scan(),
    apply: (ops) => (applyOverride ? applyOverride(ops) : vault.apply(ops)),
    readText: (path) => vault.readText(path),
    readBytes: (path) => vault.readBytes(path),
    createFile: (path, data) => vault.createFile(path, data),
    exists: (path) => (existsOverride ? existsOverride(path) : vault.exists(path)),
    listFiles: (path) => vault.listFiles(path),
    onChange: (nextListener) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    },
    fileUrl: (path) => vault.fileUrl(path),
  };

  return {
    bridge,
    emit(changes: VaultChange[]): unknown {
      if (!listener) throw new Error('The repository watcher is not attached.');
      // A future async watcher may return its completion promise even though the bridge contract is void.
      return (listener as (changes: VaultChange[]) => unknown)(changes);
    },
    setExistsOverride(override: ((path: string) => Promise<boolean>) | null): void {
      existsOverride = override;
    },
    setApplyOverride(override: ((ops: VaultOp[]) => Promise<VaultOpResult[]>) | null): void {
      applyOverride = override;
    },
  };
}

async function scenario() {
  const vault = new MemoryVault();
  const watcher = testBridge(vault);
  const repository = new VaultRepository(watcher.bridge, () => `echo-generated-${++generatedId}`);
  const opened = await WorkspaceSession.open(repository, { delayMs: 0 });
  if (!opened.ok) throw new Error(opened.error);
  const session = opened.value;
  const database: DatabaseDef = { properties: [], views: [] };
  const seed: Command[] = [
    {
      type: 'page.create',
      id: TABLE_ID,
      parentId: null,
      title: 'Items',
      kind: 'database',
      database,
      now: 1,
    },
    { type: 'page.create', id: FIRST_ROW_ID, parentId: TABLE_ID, title: 'One', now: 1 },
    { type: 'page.create', id: SECOND_ROW_ID, parentId: TABLE_ID, title: 'Two', now: 1 },
  ];
  const seeded = session.executeAll(seed);
  if (!seeded.ok) throw new Error(seeded.error);
  if (!(await session.flush())) throw new Error('The synthetic table fixture did not save.');

  return { vault, watcher, repository, session };
}

async function insertAndUndoRow(current: Awaited<ReturnType<typeof scenario>>) {
  const { session, repository, vault } = current;
  const planned = planInsertRow(
    session.getState(),
    TABLE_ID,
    FIRST_ROW_ID,
    'before',
    INSERTED_ROW_ID,
    20,
    false,
  );
  if (!planned.ok) throw new Error(planned.error);
  const inserted = await executeTableAction(
    session,
    asTableActionPlan(planned.value, 'Insert row before'),
    20,
  );
  if (inserted.status !== 'saved') throw new Error(`The synthetic row insert was ${inserted.status}.`);

  const path = repository.pathOf(INSERTED_ROW_ID);
  if (!path) throw new Error('The inserted row has no saved path.');
  const originalText = vault.text(path);
  if (originalText === undefined) throw new Error('The inserted row file is missing.');

  const undoCandidate = session.getContextualHistory(TABLE_ID, IDENTITY).undo;
  if (!undoCandidate || undoCandidate.owner.kind !== 'data')
    throw new Error('The inserted row did not create a contextual data undo item.');
  const undone = await session.stepContextualHistory(TABLE_ID, IDENTITY, 'undo', undefined, undoCandidate.id);
  if (undone.status !== 'applied') throw new Error(`The synthetic row undo was ${undone.status}.`);

  return { path, originalText };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('confirmed row removals and delayed watcher writes', () => {
  it('does not recreate an undone row from its delayed same-millisecond write event', async () => {
    const current = await scenario();
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    try {
      const { path, originalText } = await insertAndUndoRow(current);
      expect(current.vault.files.has(path)).toBe(false);
      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);

      await current.watcher.emit([change(path, originalText, FIXED_TIME)]);

      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);
      expect(current.session.getState().pages[INSERTED_ROW_ID]).toBeUndefined();
    } finally {
      await current.session.close();
    }
  });

  it('accepts a same-content external recreation at the same path and millisecond', async () => {
    const current = await scenario();
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    try {
      const { path, originalText } = await insertAndUndoRow(current);
      expect(current.vault.files.has(path)).toBe(false);

      // The new file is real even though its bytes and reported timestamp match the old row.
      current.vault.files.set(path, originalText);
      await current.watcher.emit([change(path, originalText, FIXED_TIME)]);

      expect(current.vault.files.has(path)).toBe(true);
      expect(current.vault.text(path)).toBe(originalText);
      expect(activeRows(current.session)).toHaveLength(3);
      expect(activeRows(current.session)).not.toContain(INSERTED_ROW_ID);
    } finally {
      await current.session.close();
    }
  });

  it('discards a pending old event when a newer same-path recreation arrives during the existence check', async () => {
    const current = await scenario();
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    const gate = deferred<boolean>();
    try {
      const { path, originalText } = await insertAndUndoRow(current);
      let existsCalls = 0;
      current.watcher.setExistsOverride((candidate) => {
        if (candidate === path && existsCalls++ === 0) return gate.promise;
        return current.vault.exists(candidate);
      });
      const observedTitles: string[] = [];
      const stopObserving = current.repository.onExternalChange((patch) => {
        observedTitles.push(...patch.pages.map((page) => page.title));
        return patch.pages.map((page) => page.id);
      });

      const oldDelivery = current.watcher.emit([change(path, originalText, FIXED_TIME)]);
      expect(existsCalls).toBe(1);

      const newerText = '---\ntitle: Fresh external row\n---\nNew external content.\n';
      current.vault.files.set(path, newerText);
      const newerDelivery = current.watcher.emit([change(path, newerText, FIXED_TIME + 1)]);
      // This is the result of the check that began before the new file was written.
      gate.resolve(false);
      await Promise.all([oldDelivery, newerDelivery]);

      expect(observedTitles).toEqual(['Fresh external row']);
      expect(activeRows(current.session)).toHaveLength(3);
      expect(Object.values(current.session.getState().pages).some((page) => page.title === 'Fresh external row')).toBe(
        true,
      );
      stopObserving();
    } finally {
      gate.resolve(false);
      await current.session.close();
    }
  });

  it('puts an earlier confirmed recreation before unrelated watcher changes held by a save', async () => {
    const current = await scenario();
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    const existsGate = deferred<boolean>();
    const applyStarted = deferred<void>();
    const finishApply = deferred<void>();
    const externalPatchOrder: string[] = [];
    let externalDelivered = false;
    let heldEventSent = false;
    const externalApplied = deferred<void>();
    let stopObserving = () => {};
    try {
      const { path, originalText } = await insertAndUndoRow(current);
      expect(current.vault.files.has(path)).toBe(false);

      // The path is a real same-time recreation, reported with the exact old content.
      current.vault.files.set(path, originalText);
      let existsCalls = 0;
      current.watcher.setExistsOverride((candidate) => {
        if (candidate === path && existsCalls++ === 0) return existsGate.promise;
        return current.vault.exists(candidate);
      });
      stopObserving = current.repository.onExternalChange((patch) => {
        externalPatchOrder.push(
          ...patch.pages.map((page) => (page.title === 'Held external note' ? 'B' : 'A')),
        );
        if (externalPatchOrder.length >= 2 && !externalDelivered) {
          externalDelivered = true;
          externalApplied.resolve();
        }
        return patch.pages.map((page) => page.id);
      });

      const oldDelivery = current.watcher.emit([change(path, originalText, FIXED_TIME)]);
      expect(existsCalls).toBe(1);

      const otherPath = 'External note.md';
      const otherText = '---\ntitle: Held external note\n---\nA separate external write.\n';
      current.vault.files.set(otherPath, otherText);
      current.vault.midway = () => {
        if (!heldEventSent) {
          heldEventSent = true;
          current.watcher.emit([change(otherPath, otherText, FIXED_TIME + 1)]);
        }
      };
      current.watcher.setApplyOverride(async (ops) => {
        const results = await current.vault.apply(ops);
        applyStarted.resolve();
        await finishApply.promise;
        return results;
      });

      const renamed = current.session.execute({
        type: 'page.rename',
        id: FIRST_ROW_ID,
        title: 'One saved',
        now: FIXED_TIME + 2,
      });
      if (!renamed.ok) throw new Error(renamed.error);
      const saving = current.session.queue.flush();
      await applyStarted.promise;

      // Resolve A while the save is still active and B is already in the repository's held list.
      existsGate.resolve(true);
      await oldDelivery;
      expect(externalPatchOrder).toEqual([]);

      finishApply.resolve();
      expect(await saving).toBe(true);
      await externalApplied.promise;

      expect(externalPatchOrder).toEqual(['A', 'B']);
      expect(activeRows(current.session)).toHaveLength(3);
    } finally {
      existsGate.resolve(true);
      finishApply.resolve();
      stopObserving();
      await current.session.close();
    }
  });

  it('retains an event after an exists error, keeps its error through unrelated writes, then retries before save', async () => {
    const current = await scenario();
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    try {
      const { path, originalText } = await insertAndUndoRow(current);
      let existsCalls = 0;
      let failChecks = 2;
      current.watcher.setExistsOverride((candidate) => {
        if (candidate !== path) return current.vault.exists(candidate);
        existsCalls++;
        if (failChecks > 0) {
          failChecks--;
          return Promise.reject(new Error('synthetic existence check failure at C:\\private\\vault'));
        }
        return current.vault.exists(candidate);
      });
      const observedPatches: string[] = [];
      const queueStatuses: string[] = [];
      const stopQueueStatus = current.session.queue.subscribe(() => {
        queueStatuses.push(current.session.queue.status.state);
      });
      const stopObserving = current.repository.onExternalChange((patch) => {
        observedPatches.push(...patch.pages.map((page) => page.title));
        return patch.pages.map((page) => page.id);
      });

      try {
        await current.watcher.emit([change(path, originalText, FIXED_TIME)]);
      } catch {
        // A failed existence check may surface through the repository retry/error path.
      }
      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);
      expect(existsCalls).toBe(1);
      expect(observedPatches).toEqual([]);
      expect(current.session.saveStatus.state).toBe('error');
      expect(current.session.saveStatus.error).not.toContain('C:\\private\\vault');
      expect(current.session.queue.status.state).toBe('error');
      expect(queueStatuses).toContain('error');
      const stableErrorSnapshot = current.session.saveStatus;
      expect(current.session.saveStatus).toBe(stableErrorSnapshot);

      const renamed = current.session.execute({
        type: 'page.rename',
        id: FIRST_ROW_ID,
        title: 'One saved while waiting',
        now: FIXED_TIME + 2,
      });
      if (!renamed.ok) throw new Error(renamed.error);
      // Ordinary writes use SaveQueue directly and must not clear an unrelated watcher error.
      expect(await current.session.queue.flush()).toBe(true);
      expect(current.session.saveStatus.state).toBe('error');
      expect(existsCalls).toBe(1);

      const retryOrder: string[] = [];
      const originalQueueFlush = current.session.queue.flush.bind(current.session.queue);
      const queueFlushSpy = vi.spyOn(current.session.queue, 'flush').mockImplementation(async () => {
        retryOrder.push('queue');
        return originalQueueFlush();
      });
      retryOrder.push('retry-fails');
      expect(await current.session.flush()).toBe(false);
      expect(retryOrder).toEqual(['retry-fails']);
      expect(queueFlushSpy).not.toHaveBeenCalled();
      expect(existsCalls).toBe(2);
      expect(current.session.saveStatus.state).toBe('error');
      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);

      retryOrder.length = 0;
      current.watcher.setExistsOverride((candidate) => {
        if (candidate === path) {
          retryOrder.push('exists');
          existsCalls++;
        }
        return current.vault.exists(candidate);
      });
      // Session.flush is the existing manual retry action; repository recovery precedes SaveQueue.
      expect(await current.session.flush()).toBe(true);
      expect(retryOrder).toEqual(['exists', 'queue']);
      expect(queueFlushSpy).toHaveBeenCalledTimes(1);
      expect(existsCalls).toBe(3);
      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);
      expect(current.session.saveStatus.state).toBe('saved');
      expect(current.session.queue.status.state).toBe('saved');
      expect(queueStatuses.at(-1)).toBe('saved');
      expect(current.vault.text('Items/One saved while waiting.md')).toBeDefined();

      // A duplicate watcher delivery after recovery must not create another row.
      await current.watcher.emit([change(path, originalText, FIXED_TIME)]);
      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);
      expect(observedPatches).toEqual([]);
      stopObserving();
      stopQueueStatus();
    } finally {
      await current.session.close();
    }
  });

  it('retries retained A before newer held B after an existence failure without applying either twice', async () => {
    const current = await scenario();
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    try {
      const { path, originalText } = await insertAndUndoRow(current);
      current.vault.files.set(path, originalText);
      let existsCalls = 0;
      current.watcher.setExistsOverride((candidate) => {
        if (candidate === path && existsCalls++ === 0)
          return Promise.reject(new Error('synthetic existence check failure'));
        return current.vault.exists(candidate);
      });

      const patchOrder: string[] = [];
      const stopObserving = current.repository.onExternalChange((patch) => {
        patchOrder.push(
          ...patch.pages.map((page) => (page.title === 'Held external note' ? 'B' : 'A')),
        );
        return patch.pages.map((page) => page.id);
      });
      try {
        await current.watcher.emit([change(path, originalText, FIXED_TIME)]);
      } catch {
        // The failed event remains pending for the ordinary Session.flush retry path.
      }
      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);
      expect(patchOrder).toEqual([]);
      expect(current.session.saveStatus.state).toBe('error');

      const otherPath = 'Held external note.md';
      const otherText = '---\ntitle: Held external note\n---\nA later external write.\n';
      current.vault.files.set(otherPath, otherText);
      await current.watcher.emit([change(otherPath, otherText, FIXED_TIME + 1)]);
      expect(patchOrder).toEqual([]);

      expect(await current.session.flush()).toBe(true);
      expect(existsCalls).toBe(2);
      expect(patchOrder).toEqual(['A', 'B']);
      expect(activeRows(current.session)).toHaveLength(3);
      expect(Object.values(current.session.getState().pages).some((page) => page.title === 'Held external note')).toBe(
        true,
      );

      await current.watcher.emit([change(otherPath, otherText, FIXED_TIME + 1)]);
      expect(patchOrder).toEqual(['A', 'B']);
      stopObserving();
    } finally {
      await current.session.close();
    }
  });

  it('does not publish a pending removal echo after the repository closes', async () => {
    const current = await scenario();
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    const gate = deferred<boolean>();
    try {
      const { path, originalText } = await insertAndUndoRow(current);
      let existsCalls = 0;
      current.watcher.setExistsOverride((candidate) => {
        if (candidate === path) {
          existsCalls++;
          return gate.promise;
        }
        return current.vault.exists(candidate);
      });

      const delivery = current.watcher.emit([change(path, originalText, FIXED_TIME)]);
      expect(existsCalls).toBe(1);
      await current.session.close();
      gate.resolve(false);
      await delivery;

      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);
    } finally {
      gate.resolve(false);
      await current.session.close();
    }
  });

  it('drops an existence rejection that arrives after close without publishing a retry error', async () => {
    const current = await scenario();
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_TIME);
    const gate = deferred<boolean>();
    try {
      const { path, originalText } = await insertAndUndoRow(current);
      let existsCalls = 0;
      current.watcher.setExistsOverride((candidate) => {
        if (candidate === path) {
          existsCalls++;
          if (existsCalls === 1) return Promise.reject(new Error('initial synthetic existence failure'));
          return gate.promise;
        }
        return current.vault.exists(candidate);
      });
      const statuses: string[] = [];
      current.session.queue.subscribe(() => statuses.push(current.session.saveStatus.state));

      try {
        await current.watcher.emit([change(path, originalText, FIXED_TIME)]);
      } catch {
        // The first failure is retained for the explicit retry path.
      }
      expect(current.session.saveStatus.state).toBe('error');
      expect(statuses).toContain('error');
      const notificationsBeforeClose = statuses.length;
      const retry = current.session.flush();
      // The retained event is in its second, pending existence check.
      expect(existsCalls).toBe(2);
      await current.session.close();
      gate.reject(new Error('late synthetic existence error'));
      expect(await retry).toBe(false);

      expect(current.session.saveStatus.state).toBe('error');
      expect(statuses).toHaveLength(notificationsBeforeClose);
      expect(activeRows(current.session)).toEqual([FIRST_ROW_ID, SECOND_ROW_ID]);
    } finally {
      gate.reject(new Error('cleanup after pending existence check'));
      await current.session.close();
    }
  });

  it('keeps a normal public flush waiting for a save already in flight', async () => {
    const current = await scenario();
    const applyStarted = deferred<void>();
    const releaseApply = deferred<void>();
    try {
      current.watcher.setApplyOverride(async (ops) => {
        applyStarted.resolve();
        await releaseApply.promise;
        return current.vault.apply(ops);
      });
      const renamed = current.session.execute({
        type: 'page.rename',
        id: FIRST_ROW_ID,
        title: 'Write already in flight',
        now: FIXED_TIME + 10,
      });
      if (!renamed.ok) throw new Error(renamed.error);

      await applyStarted.promise;
      const originalQueueFlush = current.session.queue.flush.bind(current.session.queue);
      const queueFlushSpy = vi.spyOn(current.session.queue, 'flush').mockImplementation(originalQueueFlush);
      const flushing = current.session.flush();
      // A normal flush must join SaveQueue's existing write, rather than returning a spurious false.
      await Promise.resolve();
      expect(queueFlushSpy).toHaveBeenCalledTimes(1);
      releaseApply.resolve();
      expect(await flushing).toBe(true);
      expect(current.vault.text('Items/Write already in flight.md')).toBeDefined();
    } finally {
      releaseApply.resolve();
      await current.session.close();
    }
  });
});
