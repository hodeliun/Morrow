import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import { newPageMeta } from '../core/model';
import type { DocNode } from '../core/model';
import { openRepository } from './repository';
import { WorkspaceWriteError } from './repository';
import type { WorkspaceRepository, WriteBatch } from './repository';
import { SaveQueue } from './saveQueue';
import { WorkspaceSession } from './session';

function deleteRepository(name: string | undefined): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name ?? '');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

let dbCount = 0;
const names: string[] = [];
const freshName = () => {
  const name = `morrow-test-${dbCount++}`;
  names.push(name);
  return name;
};

afterEach(async () => {
  vi.useRealTimers();
  while (names.length) await deleteRepository(names.pop());
});

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function open(name: string, repository?: WorkspaceRepository): Promise<WorkspaceSession> {
  const session = await WorkspaceSession.open(repository ?? (await openRepository(name)));
  if (!session.ok) throw new Error(session.error);
  return session.value;
}

function must(session: WorkspaceSession, command: Command) {
  const result = session.execute(command);
  if (!result.ok) throw new Error(result.error);
}

describe('persistence', () => {
  it('survives closing and reopening the database', async () => {
    const name = freshName();
    const first = await open(name);
    expect(first.firstRun).toBe(true);
    must(first, { type: 'page.create', id: 'p', parentId: null, now: 1, title: 'Plans' });
    must(first, { type: 'page.create', id: 'c', parentId: 'p', now: 2, title: 'Child' });
    must(first, { type: 'page.setDoc', id: 'c', doc: doc('hello world'), now: 3 });
    await first.markInitialized();
    await first.close();

    const second = await open(name);
    expect(second.firstRun).toBe(false);
    expect(second.getState().pages.c?.parentId).toBe('p');
    expect(second.getState().docs.c).toEqual(doc('hello world'));
    await second.close();
  });

  it('persists deletions', async () => {
    const name = freshName();
    const first = await open(name);
    must(first, { type: 'page.create', id: 'p', parentId: null, now: 1 });
    await first.flush();
    must(first, { type: 'page.trash', id: 'p', now: 2 });
    must(first, { type: 'page.deleteForever', id: 'p' });
    await first.close();
    const second = await open(name);
    expect(second.getState().pages).toEqual({});
    expect(second.getState().docs).toEqual({});
    await second.close();
  });

  it('does not mark an emptied workspace as a first run', async () => {
    const name = freshName();
    const first = await open(name);
    await first.markInitialized();
    await first.close();
    const second = await open(name);
    expect(second.firstRun).toBe(false);
    await second.close();
  });
});

describe('save queue', () => {
  it('keeps failed writes and retries them with the latest content', async () => {
    vi.useFakeTimers();
    const writes: WriteBatch[] = [];
    let failNext = true;
    const writer = {
      async write(batch: WriteBatch) {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        writes.push(batch);
      },
    };
    let state = { pages: {}, docs: { a: doc('one') } };
    const queue = new SaveQueue(writer, () => state, { delayMs: 10 });
    queue.enqueue({ pages: new Set(), docs: new Set(['a']), removed: new Set() });
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.status.state).toBe('error');
    expect(queue.status.error).toBe('disk full');
    expect(queue.hasPending()).toBe(true);

    state = { pages: {}, docs: { a: doc('two') } };
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.status.state).toBe('saved');
    expect(writes).toHaveLength(1);
    expect(writes[0]!.docs).toEqual([{ id: 'a', doc: doc('two') }]);
    expect(queue.hasPending()).toBe(false);
  });

  it('serialises writes so a slow write is never overtaken', async () => {
    const order: string[] = [];
    let release!: () => void;
    const writer = {
      write: (batch: WriteBatch) => {
        const label = batch.docs.map((d) => d.id).join();
        order.push(`start ${label}`);
        if (label === 'a')
          return new Promise<void>(
            (resolve) =>
              (release = () => {
                order.push('end a');
                resolve();
              }),
          );
        order.push(`end ${label}`);
        return Promise.resolve();
      },
    };
    const state = { pages: {}, docs: { a: doc('a'), b: doc('b') } };
    const queue = new SaveQueue(writer, () => state, { delayMs: 1 });
    queue.enqueue({ pages: new Set(), docs: new Set(['a']), removed: new Set() });
    const first = queue.flush();
    queue.enqueue({ pages: new Set(), docs: new Set(['b']), removed: new Set() });
    const second = queue.flush();
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b']);
  });
});

describe('session', () => {
  it('rejects failed commands without touching state or storage', async () => {
    const session = await open(freshName());
    const before = session.getState();
    expect(session.execute({ type: 'page.rename', id: 'missing', title: 'x', now: 1 }).ok).toBe(false);
    expect(session.getState()).toBe(before);
    expect(session.queue.hasPending()).toBe(false);
    await session.close();
  });

  it('applies grouped commands atomically', async () => {
    const session = await open(freshName());
    const result = session.executeAll([
      { type: 'page.create', id: 'a', parentId: null, now: 1 },
      { type: 'page.create', id: 'a', parentId: null, now: 1 },
    ]);
    expect(result.ok).toBe(false);
    expect(session.getState().pages).toEqual({});
    await session.close();
  });

  it('protects pages whose content could not be read', async () => {
    const name = freshName();
    const repository = await openRepository(name);
    await repository.write({
      pages: [newPageMeta({ id: 'x', parentId: null, title: 'Broken' })],
      docs: [{ id: 'x', doc: { type: 'unknown-root' } as DocNode }],
      removed: [],
    });
    const session = await open(name, repository);
    expect(session.unreadable.has('x')).toBe(true);
    expect(session.problems).toHaveLength(1);
    expect(session.execute({ type: 'page.setDoc', id: 'x', doc: doc('overwrite'), now: 1 }).ok).toBe(false);
    await session.close();
  });
});

describe('opening a page', () => {
  it('waits 20 seconds, then writes navigation quietly without changing save status', async () => {
    vi.useFakeTimers();
    const writes: WriteBatch[] = [];
    let writeStatus: string | undefined;
    const state = { pages: { a: newPageMeta({ id: 'a', parentId: null }) }, docs: {} };
    const queue: SaveQueue = new SaveQueue(
      {
        async write(batch) {
          writeStatus = queue.status.state;
          writes.push(batch);
        },
      },
      () => state,
    );
    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);
    expect(queue.status.state).toBe('saved');
    expect(queue.status.lastSavedAt).toBeNull();
    expect(queue.isDirty('a')).toBe(false);
    expect(queue.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(writes).toHaveLength(0);
    expect(queue.status).toMatchObject({ state: 'saved', lastSavedAt: null });
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.pages.map((page) => page.id)).toEqual(['a']);
    expect(writes[0]?.quietPageIds).toEqual(['a']);
    expect(writeStatus).toBe('saved');
    expect(queue.status.state).toBe('saved');
    expect(queue.status.lastSavedAt).toBeNull();
    expect(queue.hasPending()).toBe(false);
  });

  it('debounces edits for 1.5 seconds and coalesces a pending quiet page update', async () => {
    vi.useFakeTimers();
    const writes: WriteBatch[] = [];
    let writeStatus: string | undefined;
    let state = {
      pages: { a: { ...newPageMeta({ id: 'a', parentId: null }), lastOpenedAt: 123 } },
      docs: { b: doc('first') },
    };
    const queue: SaveQueue = new SaveQueue(
      {
        async write(batch) {
          writeStatus = queue.status.state;
          writes.push(batch);
        },
      },
      () => state,
      { now: () => 9_999 },
    );

    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);
    expect(queue.isDirty('a')).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    queue.enqueue({ pages: new Set(), docs: new Set(['b']), removed: new Set() });
    await vi.advanceTimersByTimeAsync(1_000);
    state = { ...state, docs: { b: doc('latest') } };
    queue.enqueue({ pages: new Set(), docs: new Set(['b']), removed: new Set() });
    expect(queue.status.state).toBe('pending');
    expect(queue.isDirty('b')).toBe(true);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.pages).toEqual([state.pages.a]);
    expect(writes[0]?.quietPageIds).toEqual(['a']);
    expect(writes[0]?.docs).toEqual([{ id: 'b', doc: doc('latest') }]);
    expect(writeStatus).toBe('saving');
    expect(queue.status).toMatchObject({ state: 'saved', lastSavedAt: 9_999 });
    expect(queue.hasPending()).toBe(false);
  });

  it('does not postpone an existing edit deadline when quiet navigation arrives', async () => {
    vi.useFakeTimers();
    const writes: WriteBatch[] = [];
    const state = {
      pages: { a: { ...newPageMeta({ id: 'a', parentId: null }), lastOpenedAt: 321 } },
      docs: { b: doc('edited') },
    };
    const queue = new SaveQueue(
      {
        async write(batch) {
          writes.push(batch);
        },
      },
      () => state,
    );
    queue.enqueue({ pages: new Set(), docs: new Set(['b']), removed: new Set() });
    await vi.advanceTimersByTimeAsync(1_000);
    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);
    expect(queue.status.state).toBe('pending');

    await vi.advanceTimersByTimeAsync(499);
    expect(writes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(writes).toHaveLength(1);
    expect(writes[0]?.pages.map((page) => page.id)).toEqual(['a']);
    expect(writes[0]?.docs.map((record) => record.id)).toEqual(['b']);
    expect(queue.status.state).toBe('saved');
  });

  it('keeps quiet work dirty when a source check or a failed write still protects it', async () => {
    vi.useFakeTimers();
    const writes: WriteBatch[] = [];
    let fail = true;
    const queue = new SaveQueue(
      {
        async write(batch) {
          writes.push(batch);
          if (fail) {
            fail = false;
            throw new WorkspaceWriteError('save-conflict', 'external source changed', false);
          }
        },
      },
      () => ({ pages: { a: newPageMeta({ id: 'a', parentId: null }) }, docs: {} }),
      { quietDelayMs: 20_000 },
    );

    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);
    expect(queue.isDirty('a')).toBe(false);
    queue.enqueue({ pages: new Set(), docs: new Set(), removed: new Set() }, ['a']);
    expect(queue.isDirty('a')).toBe(true);
    expect(await queue.flush()).toBe(false);
    expect(queue.status).toMatchObject({ state: 'error', errorCode: 'save-conflict' });
    expect(queue.isDirty('a')).toBe(true);
    expect(writes[0]?.checkPages).toEqual(['a']);
    expect(await queue.flush()).toBe(true);
    expect(queue.status).toMatchObject({ state: 'saved', error: null, errorCode: null });
  });

  it('does not hide a dirty document on a page that also has a quiet navigation update', () => {
    const queue = new SaveQueue({ async write() {} }, () => ({
      pages: { a: newPageMeta({ id: 'a', parentId: null }) },
      docs: { a: doc('edited') },
    }));
    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);
    expect(queue.isDirty('a')).toBe(false);
    queue.enqueue({ pages: new Set(), docs: new Set(['a']), removed: new Set() });
    expect(queue.isDirty('a')).toBe(true);
    queue.dispose();
  });

  it('keeps quiet-only failures visible and retries them without turning them into edits', async () => {
    vi.useFakeTimers();
    const writes: WriteBatch[] = [];
    let fail = true;
    const queue = new SaveQueue(
      {
        async write(batch) {
          writes.push(batch);
          if (fail) {
            fail = false;
            throw new Error('temporary disk failure');
          }
        },
      },
      () => ({ pages: { a: newPageMeta({ id: 'a', parentId: null }) }, docs: {} }),
      { now: () => 1_234 },
    );
    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);

    expect(await queue.flush()).toBe(false);
    expect(queue.status).toMatchObject({ state: 'error', error: 'temporary disk failure' });
    expect(queue.isDirty('a')).toBe(true);
    expect(queue.isQuietPending('a')).toBe(false);
    expect(await queue.flush()).toBe(true);
    expect(writes).toHaveLength(2);
    expect(queue.status).toMatchObject({ state: 'saved', error: null, lastSavedAt: null });
  });

  it('preserves per-page quiet classification across a failed mixed batch retry', async () => {
    vi.useFakeTimers();
    const writes: WriteBatch[] = [];
    let fail = true;
    const state = {
      pages: {
        a: newPageMeta({ id: 'a', parentId: null }),
        b: newPageMeta({ id: 'b', parentId: null }),
      },
      docs: { b: doc('edited') },
    };
    const queue: SaveQueue = new SaveQueue(
      {
        async write(batch) {
          writes.push(batch);
          if (fail) {
            fail = false;
            await Promise.resolve();
            queue.enqueue({ pages: new Set(['b']), docs: new Set(), removed: new Set() }, true);
            throw new Error('temporary mixed-batch failure');
          }
        },
      },
      () => state,
    );

    try {
      queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);
      queue.enqueue({ pages: new Set(['b']), docs: new Set(['b']), removed: new Set() });
      await vi.advanceTimersByTimeAsync(1_499);
      expect(writes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(writes).toHaveLength(1);
      expect(writes[0]?.quietPageIds).toEqual(['a']);
      expect(queue.status.state).toBe('error');

      await vi.advanceTimersByTimeAsync(999);
      expect(writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(writes).toHaveLength(2);
      expect(writes[1]?.quietPageIds).toEqual(['a']);
      expect(writes[1]?.pages.map((page) => page.id).sort()).toEqual(['a', 'b']);
      expect(writes[1]?.docs.map((record) => record.id)).toEqual(['b']);
      expect(queue.status.state).toBe('saved');
    } finally {
      queue.dispose();
      vi.useRealTimers();
    }
  });

  it('queues a second quiet update made during an active write and flushes it before close', async () => {
    vi.useFakeTimers();
    const writes: WriteBatch[] = [];
    let release!: () => void;
    const page = { ...newPageMeta({ id: 'a', parentId: null }), lastOpenedAt: 321 };
    const queue = new SaveQueue(
      {
        write(batch) {
          writes.push(batch);
          if (writes.length === 1)
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          return Promise.resolve();
        },
      },
      () => ({ pages: { a: page }, docs: {} }),
      { quietDelayMs: 20_000 },
    );

    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() });
    const firstFlush = queue.flush();
    expect(queue.isDirty('a')).toBe(true);
    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);
    expect(queue.isDirty('a')).toBe(true);
    release();
    expect(await firstFlush).toBe(false);
    expect(queue.isQuietPending('a')).toBe(true);
    expect(queue.status.state).toBe('saved');

    expect(await queue.flush()).toBe(true);
    expect(writes).toHaveLength(2);
    expect(writes[1]?.pages).toEqual([page]);
    queue.dispose();
  });

  it('flushes a quiet page update immediately before its timer expires', async () => {
    const writes: WriteBatch[] = [];
    const queue = new SaveQueue(
      {
        async write(batch) {
          writes.push(batch);
        },
      },
      () => ({ pages: { a: newPageMeta({ id: 'a', parentId: null }) }, docs: {} }),
    );
    queue.enqueue({ pages: new Set(['a']), docs: new Set(), removed: new Set() }, true);

    expect(await queue.flush()).toBe(true);
    expect(writes).toHaveLength(1);
    expect(queue.status).toMatchObject({ state: 'saved', lastSavedAt: null });
    queue.dispose();
  });
});
