import {
  closeSync,
  existsSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { open as openFileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMediaResourceRegistry } from './mediaResources.js';
import type { MediaVaultContext } from './mediaResources.js';

const temporaryRoots: string[] = [];

function makeRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function fixture() {
  const root = makeRoot('morrow-media-vault-');
  mkdirSync(path.join(root, 'Audio'), { recursive: true });
  mkdirSync(path.join(root, 'Video'), { recursive: true });
  const context: MediaVaultContext = { root, realRoot: root, generation: 1 };
  let nextToken = 0;
  const registry = createMediaResourceRegistry({
    getContext: () => context,
    createToken: () => (nextToken++).toString(36).padStart(43, 'a'),
  });
  return { root, context, registry };
}

async function readBody(body: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }
  return Buffer.concat(chunks);
}

async function readUntilStopped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  total: number,
): Promise<number> {
  let count = 0;
  while (count < total) {
    try {
      const result = await reader.read();
      if (result.done) return count;
      count += result.value.byteLength;
    } catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' });
      return count;
    }
  }
  return count;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('media resource capabilities', () => {
  it('reports a zero-byte media file as unavailable before opening or issuing a token', async () => {
    const root = makeRoot('morrow-media-empty-');
    mkdirSync(path.join(root, 'Audio'), { recursive: true });
    const context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    writeFileSync(path.join(root, 'Audio', 'empty.wav'), Buffer.alloc(0));
    const openFile = vi.fn();
    const createToken = vi.fn(() => 'a'.repeat(43));
    const onUnavailable = vi.fn();
    const registry = createMediaResourceRegistry({
      getContext: () => context,
      createToken,
      openFile,
      onUnavailable,
    } as unknown as Parameters<typeof createMediaResourceRegistry>[0]);

    expect(await registry.issue('Audio/empty.wav')).toEqual({ ok: false, code: 'file-unavailable' });
    expect(createToken).not.toHaveBeenCalled();
    expect(openFile).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('reports a real open EIO once using only the active token', async () => {
    const root = makeRoot('morrow-media-open-eio-');
    mkdirSync(path.join(root, 'Audio'), { recursive: true });
    const context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    writeFileSync(path.join(root, 'Audio', 'online-only.wav'), Buffer.from('synthetic media bytes'));
    const openFile = vi.fn(async () => {
      throw Object.assign(new Error('synthetic host path details'), { code: 'EIO' });
    });
    const onUnavailable = vi.fn();
    const registry = createMediaResourceRegistry({
      getContext: () => context,
      openFile,
      onUnavailable,
    } as unknown as Parameters<typeof createMediaResourceRegistry>[0]);
    const issued = await registry.issue('Audio/online-only.wav');
    if (!issued.ok) throw new Error('Expected the selected media capability.');

    expect(await registry.inspect(issued.token)).toBeNull();
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(issued.token);
    expect(JSON.stringify(onUnavailable.mock.calls)).not.toContain('EIO');
    expect(JSON.stringify(onUnavailable.mock.calls)).not.toContain('online-only.wav');
  });

  it('does not classify an aborted open as file-unavailable', async () => {
    const root = makeRoot('morrow-media-open-abort-');
    mkdirSync(path.join(root, 'Audio'), { recursive: true });
    const context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    writeFileSync(path.join(root, 'Audio', 'cancelled.wav'), Buffer.from('synthetic media bytes'));
    let attempts = 0;
    const openFile = vi.fn(async (location: string, flags: number) => {
      attempts += 1;
      if (attempts === 1)
        throw Object.assign(new Error('synthetic cancellation'), { name: 'AbortError', code: 'ABORT_ERR' });
      return openFileHandle(location, flags);
    });
    const onUnavailable = vi.fn();
    const registry = createMediaResourceRegistry({
      getContext: () => context,
      openFile,
      onUnavailable,
    } as unknown as Parameters<typeof createMediaResourceRegistry>[0]);
    const issued = await registry.issue('Audio/cancelled.wav');
    if (!issued.ok) throw new Error('Expected the selected media capability.');

    expect(await registry.inspect(issued.token)).toBeNull();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(await registry.inspect(issued.token)).toMatchObject({
      size: Buffer.byteLength('synthetic media bytes'),
    });
    expect(openFile).toHaveBeenCalledTimes(2);
  });

  it('closes an opened handle when the request is cancelled during open and keeps the capability reusable', async () => {
    const root = makeRoot('morrow-media-open-signal-abort-');
    mkdirSync(path.join(root, 'Audio'), { recursive: true });
    const context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    writeFileSync(path.join(root, 'Audio', 'cancelled.wav'), Buffer.from('synthetic media bytes'));
    const controller = new AbortController();
    let attempts = 0;
    let firstClose: ReturnType<typeof vi.fn> | null = null;
    const openFile = vi.fn(async (location: string, flags: number) => {
      const handle = await openFileHandle(location, flags);
      attempts += 1;
      if (attempts !== 1) return handle;
      controller.abort();
      firstClose = vi.fn(() => handle.close());
      return {
        stat: () => handle.stat(),
        close: firstClose,
        createReadStream: handle.createReadStream.bind(handle),
      };
    });
    const onUnavailable = vi.fn();
    const registry = createMediaResourceRegistry({
      getContext: () => context,
      openFile,
      onUnavailable,
    } as unknown as Parameters<typeof createMediaResourceRegistry>[0]);
    const issued = await registry.issue('Audio/cancelled.wav');
    if (!issued.ok) throw new Error('Expected the selected media capability.');

    expect(await registry.inspect(issued.token, controller.signal)).toBeNull();
    expect(firstClose).toHaveBeenCalledOnce();
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(await registry.inspect(issued.token)).toMatchObject({
      size: Buffer.byteLength('synthetic media bytes'),
    });
    expect(openFile).toHaveBeenCalledTimes(2);
  });

  it('does not report a capability after its vault generation becomes stale', async () => {
    const root = makeRoot('morrow-media-stale-vault-');
    mkdirSync(path.join(root, 'Audio'), { recursive: true });
    let context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    writeFileSync(path.join(root, 'Audio', 'stale.wav'), Buffer.from('synthetic media bytes'));
    const openFile = vi.fn();
    const onUnavailable = vi.fn();
    const registry = createMediaResourceRegistry({
      getContext: () => context,
      openFile,
      onUnavailable,
    } as unknown as Parameters<typeof createMediaResourceRegistry>[0]);
    const issued = await registry.issue('Audio/stale.wav');
    if (!issued.ok) throw new Error('Expected the selected media capability.');

    context = { ...context, generation: 2 };
    expect(await registry.inspect(issued.token)).toBeNull();
    expect(openFile).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('does not report a stream failure after the capability is released', async () => {
    const root = makeRoot('morrow-media-released-stream-');
    mkdirSync(path.join(root, 'Audio'), { recursive: true });
    const context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    const filePath = path.join(root, 'Audio', 'released.wav');
    writeFileSync(filePath, Buffer.from('synthetic media bytes'));
    const stream = new Readable({ read() {} });
    const onUnavailable = vi.fn();
    const registry = createMediaResourceRegistry({
      getContext: () => context,
      openFile: async () => ({
        stat: async () => lstatSync(filePath),
        close: async () => undefined,
        createReadStream: () => stream,
      }),
      onUnavailable,
    } as unknown as Parameters<typeof createMediaResourceRegistry>[0]);
    const issued = await registry.issue('Audio/released.wav');
    if (!issued.ok) throw new Error('Expected the selected media capability.');
    const opened = await registry.open(issued.token, 0, issued.size - 1);
    if (!opened) throw new Error('Expected an active stream capability.');

    registry.release(issued.token);
    stream.emit('error', Object.assign(new Error('synthetic stale stream error'), { code: 'EIO' }));
    await opened.body.cancel().catch(() => undefined);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('does not report a stream failure after the vault generation changes', async () => {
    const root = makeRoot('morrow-media-stale-stream-');
    mkdirSync(path.join(root, 'Audio'), { recursive: true });
    let context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    const filePath = path.join(root, 'Audio', 'stale-stream.wav');
    writeFileSync(filePath, Buffer.from('synthetic media bytes'));
    const stream = new Readable({ read() {} });
    const onUnavailable = vi.fn();
    const registry = createMediaResourceRegistry({
      getContext: () => context,
      openFile: async () => ({
        stat: async () => lstatSync(filePath),
        close: async () => undefined,
        createReadStream: () => stream,
      }),
      onUnavailable,
    } as unknown as Parameters<typeof createMediaResourceRegistry>[0]);
    const issued = await registry.issue('Audio/stale-stream.wav');
    if (!issued.ok) throw new Error('Expected the selected media capability.');
    const opened = await registry.open(issued.token, 0, issued.size - 1);
    if (!opened) throw new Error('Expected an active stream capability.');

    context = { ...context, generation: 2 };
    stream.emit('error', Object.assign(new Error('synthetic stale stream error'), { code: 'EIO' }));
    await opened.body.cancel().catch(() => undefined);
    expect(onUnavailable).not.toHaveBeenCalled();
  });

  it('reports an active read-stream EIO only once for its capability', async () => {
    const root = makeRoot('morrow-media-stream-eio-');
    mkdirSync(path.join(root, 'Video'), { recursive: true });
    const context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    const filePath = path.join(root, 'Video', 'stream.webm');
    const bytes = Buffer.from('synthetic stream bytes');
    writeFileSync(filePath, bytes);
    const onUnavailable = vi.fn();
    const openFile = vi.fn(async () => {
      return {
        stat: async () => lstatSync(filePath),
        close: async () => undefined,
        createReadStream: () => {
          let sent = false;
          const stream = new Readable({
            read() {
              if (sent) return;
              sent = true;
              this.push(Buffer.from('prefix'));
              process.nextTick(() =>
                this.destroy(Object.assign(new Error('synthetic stream path details'), { code: 'EIO' })),
              );
            },
          });
          return stream;
        },
      };
    });
    const registry = createMediaResourceRegistry({
      getContext: () => context,
      openFile,
      onUnavailable,
    } as unknown as Parameters<typeof createMediaResourceRegistry>[0]);
    const issued = await registry.issue('Video/stream.webm');
    if (!issued.ok) throw new Error('Expected the selected media capability.');

    const first = await registry.open(issued.token, 0, issued.size - 1);
    if (!first) throw new Error('Expected the active stream capability.');
    expect(openFile).toHaveBeenCalledTimes(1);
    const firstReader = first.body.getReader();
    expect(Buffer.from((await firstReader.read()).value ?? [])).toEqual(Buffer.from('prefix'));
    await expect(firstReader.read()).rejects.toMatchObject({ code: 'EIO' });
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(issued.token);

    const second = await registry.open(issued.token, 0, issued.size - 1);
    expect(second).toBeNull();
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledExactlyOnceWith(issued.token);
  });

  it('issues opaque capabilities for explicit media types without changing the original', async () => {
    const { root, registry } = fixture();
    const relativePath = 'Audio/素材/Interview.WAV';
    const absolutePath = path.join(root, ...relativePath.split('/'));
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    const original = Buffer.from('synthetic pcm bytes');
    writeFileSync(absolutePath, original);
    const before = lstatSync(absolutePath);

    const issued = await registry.issue(relativePath);
    expect(issued).toMatchObject({ ok: true, kind: 'audio', mimeType: 'audio/wav', size: original.length });
    if (!issued.ok) throw new Error('Expected a media capability.');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,48}$/);
    expect(issued.token).not.toContain('素材');
    expect(issued.token).not.toContain('Interview');
    expect(existsSync(path.join(root, '.morrow', 'vault.json'))).toBe(false);

    const metadata = await registry.inspect(issued.token);
    expect(metadata).toEqual({ kind: 'audio', mimeType: 'audio/wav', size: original.length });
    const opened = await registry.open(issued.token, 0, original.length - 1);
    expect(opened).toMatchObject({
      kind: 'audio',
      mimeType: 'audio/wav',
      size: original.length,
      start: 0,
      end: original.length - 1,
    });
    expect(opened && (await readBody(opened.body))).toEqual(original);
    expect(readFileSync(absolutePath)).toEqual(original);
    expect(lstatSync(absolutePath).mtimeMs).toBe(before.mtimeMs);
  });

  it('rejects non-media extensions before opening and validates path confinement', async () => {
    const { root, registry } = fixture();
    writeFileSync(path.join(root, 'notes.md'), 'synthetic note');
    writeFileSync(path.join(root, 'outside.wav'), 'outside');
    mkdirSync(path.join(root, 'folder.wav'));

    expect(await registry.issue('notes.md')).toEqual({ ok: false, code: 'unsupported-type' });
    for (const relativePath of [
      '../outside.wav',
      'Audio/../../outside.wav',
      'C:/outside.wav',
      'Audio\\clip.wav',
      '.morrow/private.wav',
      '.git/objects/hidden.wav',
      '.morrow-tmp-123/clip.wav',
      'folder.wav',
      'Audio/missing.wav',
    ])
      expect(await registry.issue(relativePath)).toEqual({ ok: false, code: 'invalid-resource' });
  });

  it('rejects symlinked resources that leave the vault', async () => {
    const { root, registry } = fixture();
    const outside = makeRoot('morrow-media-outside-');
    const outsidePath = path.join(outside, 'outside.wav');
    writeFileSync(outsidePath, 'synthetic external bytes');
    const linkPath = path.join(root, 'Audio', 'linked.wav');
    try {
      symlinkSync(outsidePath, linkPath, process.platform === 'win32' ? 'file' : undefined);
    } catch {
      return;
    }
    expect(await registry.issue('Audio/linked.wav')).toEqual({ ok: false, code: 'invalid-resource' });
  });

  it('supports bounded reads from a file larger than 100 MiB without materializing it', async () => {
    const { root, registry } = fixture();
    const file = path.join(root, 'Video', 'sparse.webm');
    const size = 110 * 1024 * 1024;
    const descriptor = openSync(file, 'w+');
    try {
      ftruncateSync(descriptor, size);
      writeSync(descriptor, Buffer.from('START'), 0, 5, 0);
      writeSync(descriptor, Buffer.from('TRAIL'), 0, 5, size - 5);
    } finally {
      closeSync(descriptor);
    }

    const issued = await registry.issue('Video/sparse.webm');
    if (!issued.ok) throw new Error('Expected a large media capability.');
    expect(await registry.inspect(issued.token)).toMatchObject({ size, mimeType: 'video/webm' });
    const opened = await registry.open(issued.token, size - 5, size - 1);
    expect(opened).not.toBeNull();
    const reader = opened!.body.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(new TextDecoder().decode(first.value)).toBe('TRAIL');
    expect(await reader.read()).toEqual({ done: true, value: undefined });
  });

  it('tracks independent streams and stops them on capability release or registry clear', async () => {
    const { root, registry } = fixture();
    const file = path.join(root, 'Video', 'large.webm');
    writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, 0x5a));
    const first = await registry.issue('Video/large.webm');
    const second = await registry.issue('Video/large.webm');
    if (!first.ok || !second.ok) throw new Error('Expected independent media capabilities.');
    expect(first.token).not.toBe(second.token);
    const streamA = await registry.open(first.token, 0, 4 * 1024 * 1024 - 1);
    const streamB = await registry.open(second.token, 0, 4 * 1024 * 1024 - 1);
    expect(streamA).not.toBeNull();
    expect(streamB).not.toBeNull();
    const readerA = streamA!.body.getReader();
    const readerB = streamB!.body.getReader();
    expect((await readerA.read()).done).toBe(false);
    expect((await readerB.read()).done).toBe(false);

    registry.release(first.token);
    expect(await readUntilStopped(readerA, 4 * 1024 * 1024)).toBeLessThan(4 * 1024 * 1024);
    expect(await readerB.read()).toMatchObject({ done: false });
    registry.clear();
    expect(await readUntilStopped(readerB, 4 * 1024 * 1024)).toBeLessThan(4 * 1024 * 1024);
    expect(await registry.inspect(second.token)).toBeNull();
  });

  it('cancels an active stream from the request signal', async () => {
    const root = makeRoot('morrow-media-cancel-signal-');
    mkdirSync(path.join(root, 'Video'), { recursive: true });
    const context: MediaVaultContext = { root, realRoot: root, generation: 1 };
    const file = path.join(root, 'Video', 'cancel.webm');
    writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, 0x52));
    const onUnavailable = vi.fn();
    const registry = createMediaResourceRegistry({ getContext: () => context, onUnavailable });
    const issued = await registry.issue('Video/cancel.webm');
    if (!issued.ok) throw new Error('Expected a media capability.');
    const controller = new AbortController();
    const opened = await registry.open(issued.token, 0, issued.size - 1, controller.signal);
    expect(opened).not.toBeNull();
    const reader = opened!.body.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    expect(await readUntilStopped(reader, issued.size)).toBeLessThan(issued.size);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(await registry.inspect(issued.token)).toMatchObject({ size: issued.size });
  });

  it('revokes a selected file after replacement, removal, or vault generation change', async () => {
    const { root, context, registry } = fixture();
    const file = path.join(root, 'Audio', 'replace.wav');
    const moved = path.join(root, 'Audio', 'replace.old.wav');
    writeFileSync(file, 'original bytes');
    const issued = await registry.issue('Audio/replace.wav');
    if (!issued.ok) throw new Error('Expected a media capability.');
    const before = lstatSync(file);
    writeFileSync(moved, readFileSync(file));
    rmSync(file);
    writeFileSync(file, 'replacement with different size');
    expect(await registry.inspect(issued.token)).toBeNull();
    expect(await registry.open(issued.token, 0, before.size - 1)).toBeNull();

    const current = await registry.issue('Audio/replace.wav');
    if (!current.ok) throw new Error('Expected a new capability after explicit selection.');
    context.generation = 'changed';
    expect(await registry.inspect(current.token)).toBeNull();
    expect(await registry.open(current.token, 0, current.size - 1)).toBeNull();
  });

  it('returns unavailable without a current vault', async () => {
    const root = makeRoot('morrow-media-no-vault-');
    const registry = createMediaResourceRegistry({ getContext: () => null });
    expect(await registry.issue('clip.wav')).toEqual({ ok: false, code: 'no-vault' });
    expect(await registry.inspect('a'.repeat(43))).toBeNull();
    expect(existsSync(root)).toBe(true);
  });
});
