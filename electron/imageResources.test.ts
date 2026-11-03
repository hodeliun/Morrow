import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createImageResourceRegistry } from './imageResources.js';
import type { ImageVaultContext } from './imageResources.js';

const temporaryRoots: string[] = [];

function makeRoot(prefix: string): string {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  temporaryRoots.push(root);
  return root;
}

function fixture() {
  const root = makeRoot('morrow-image-resources-vault-');
  const userDataPath = makeRoot('morrow-image-resources-profile-');
  const images = path.join(root, 'Images', '素材');
  mkdirSync(images, { recursive: true });
  const context: ImageVaultContext = { root, realRoot: root, generation: 1 };
  const registry = createImageResourceRegistry({ getContext: () => context, userDataPath });
  return { root, userDataPath, images, context, registry };
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
  fileLength: number,
): Promise<number> {
  let bytes = 0;
  while (bytes < fileLength) {
    try {
      const result = await reader.read();
      if (result.done) return bytes;
      bytes += result.value.byteLength;
    } catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' });
      return bytes;
    }
  }
  return bytes;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('image resource registry', () => {
  it('issues opaque capabilities for validated image files without changing the vault', async () => {
    const { root, userDataPath, registry } = fixture();
    const relativePath = 'Images/素材/Concept art.PNG';
    const absolutePath = path.join(root, ...relativePath.split('/'));
    const original = Buffer.from('synthetic png bytes');
    writeFileSync(absolutePath, original);
    const vaultId = await registry.getVaultId();
    expect(vaultId).toMatch(/^[0-9a-f-]{36}$/i);

    const issued = await registry.issue(relativePath, vaultId);
    expect(issued).toMatchObject({ ok: true, mimeType: 'image/png', size: original.length });
    if (!issued.ok) throw new Error('Expected an image resource capability.');
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{40,48}$/);
    expect(issued.token).not.toContain('素材');
    expect(issued.token).not.toContain('Concept');

    const opened = await registry.open(issued.token);
    expect(opened).toMatchObject({ mimeType: 'image/png', size: original.length });
    expect(opened && (await readBody(opened.body))).toEqual(original);
    expect(readFileSync(absolutePath)).toEqual(original);
    expect(existsSync(path.join(root, '.morrow', 'vault.json'))).toBe(false);
    expect(readFileSync(path.join(userDataPath, 'image-viewer-vaults.json'), 'utf8')).not.toContain(root);
  });

  it('uses an explicit MIME type for each supported image extension, including SVG', async () => {
    const { root, registry } = fixture();
    const vaultId = await registry.getVaultId();
    const cases = [
      ['one.jpg', 'image/jpeg'],
      ['two.gif', 'image/gif'],
      ['three.webp', 'image/webp'],
      ['four.avif', 'image/avif'],
      ['five.bmp', 'image/bmp'],
      ['six.ico', 'image/x-icon'],
      ['seven.svg', 'image/svg+xml'],
    ] as const;
    for (const [name, mimeType] of cases) {
      writeFileSync(path.join(root, name), '<svg xmlns="http://www.w3.org/2000/svg" />');
      const issued = await registry.issue(name, vaultId);
      expect(issued).toMatchObject({ ok: true, mimeType });
    }
  });

  it('rejects traversal, non-image types, directories and symlinks', async () => {
    const { root, registry } = fixture();
    const vaultId = await registry.getVaultId();
    writeFileSync(path.join(root, 'ok.png'), 'image');
    writeFileSync(path.join(root, 'outside.png'), 'outside');
    mkdirSync(path.join(root, 'folder.png'));
    for (const relative of [
      '../outside.png',
      'Images/../../outside.png',
      'C:/outside.png',
      'folder\\image.png',
      'notes.md',
      'folder.png',
      '.morrow/private.png',
      '.git/objects/hidden.png',
      '.morrow-tmp-123/image.png',
    ]) {
      expect(await registry.issue(relative, vaultId)).toMatchObject({ ok: false, code: 'invalid-resource' });
    }

    const symlinkPath = path.join(root, 'linked.png');
    try {
      symlinkSync(
        path.join(root, 'outside.png'),
        symlinkPath,
        process.platform === 'win32' ? 'file' : undefined,
      );
    } catch {
      return;
    }
    expect(await registry.issue('linked.png', vaultId)).toMatchObject({
      ok: false,
      code: 'invalid-resource',
    });
  });

  it('ties route identities and capabilities to the canonical vault and generation', async () => {
    const { root, userDataPath, registry, context } = fixture();
    writeFileSync(path.join(root, 'image.png'), 'synthetic image');
    const vaultId = await registry.getVaultId();
    const issued = await registry.issue('image.png', vaultId);
    if (!issued.ok) throw new Error('Expected an image resource capability.');

    const otherRoot = makeRoot('morrow-other-vault-');
    const otherContext = { ...context, root: otherRoot, realRoot: otherRoot };
    const otherRegistry = createImageResourceRegistry({ getContext: () => otherContext, userDataPath });
    expect(await otherRegistry.getVaultId()).not.toBe(vaultId);

    context.root = otherRoot;
    context.realRoot = otherRoot;
    context.generation = 2;
    expect(await registry.open(issued.token)).toBeNull();
    expect(await registry.issue('image.png', vaultId)).toMatchObject({ ok: false, code: 'vault-changed' });
  });

  it('keeps vault identity stable across registry instances without storing the path', async () => {
    const { root, userDataPath, context, registry } = fixture();
    const first = await registry.getVaultId();
    const reopened = createImageResourceRegistry({ getContext: () => context, userDataPath });
    expect(await reopened.getVaultId()).toBe(first);
    const stored = readFileSync(path.join(userDataPath, 'image-viewer-vaults.json'), 'utf8');
    expect(stored).not.toContain(root);
    expect(stored).not.toContain(path.basename(root));
  });

  it('releases and clears capabilities, and returns unavailable for a removed file', async () => {
    const { root, registry } = fixture();
    const vaultId = await registry.getVaultId();
    const imagePath = path.join(root, 'image.png');
    writeFileSync(imagePath, 'synthetic image');

    const released = await registry.issue('image.png', vaultId);
    if (!released.ok) throw new Error('Expected an image resource capability.');
    registry.release(released.token);
    expect(await registry.open(released.token)).toBeNull();

    const removed = await registry.issue('image.png', vaultId);
    if (!removed.ok) throw new Error('Expected an image resource capability.');
    await rm(imagePath);
    expect(await registry.open(removed.token)).toBeNull();

    writeFileSync(imagePath, 'synthetic image');
    const cleared = await registry.issue('image.png', vaultId);
    if (!cleared.ok) throw new Error('Expected an image resource capability.');
    registry.clear();
    expect(await registry.open(cleared.token)).toBeNull();
  });

  it('does not let an in-flight open revive a released token or remove its replacement lease', async () => {
    const root = makeRoot('morrow-image-resource-open-race-');
    const userDataPath = makeRoot('morrow-image-resource-open-race-profile-');
    const context: ImageVaultContext = { root, realRoot: root, generation: 1 };
    const registry = createImageResourceRegistry({
      getContext: () => context,
      userDataPath,
      createToken: () => 'A'.repeat(43),
    });
    const imagePath = path.join(root, 'image.png');
    writeFileSync(imagePath, 'original bytes');
    const vaultId = await registry.getVaultId();
    const first = await registry.issue('image.png', vaultId);
    if (!first.ok) throw new Error('Expected the first image capability.');

    const staleOpen = registry.open(first.token);
    registry.release(first.token);
    writeFileSync(imagePath, 'replacement bytes');
    const replacement = await registry.issue('image.png', vaultId);
    if (!replacement.ok) throw new Error('Expected the replacement image capability.');
    expect(replacement.token).toBe(first.token);
    expect(await staleOpen).toBeNull();

    const reopened = await registry.open(replacement.token);
    expect(reopened && (await readBody(reopened.body))).toEqual(Buffer.from('replacement bytes'));
  });

  it('isolates same-file streams by token, closes released streams and uses byte-sized chunks', async () => {
    const { root, registry } = fixture();
    const vaultId = await registry.getVaultId();
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    writeFileSync(path.join(root, 'same image.png'), bytes);

    const [issuedA, issuedB, issuedC] = await Promise.all([
      registry.issue('same image.png', vaultId),
      registry.issue('same image.png', vaultId),
      registry.issue('same image.png', vaultId),
    ]);
    if (!issuedA.ok || !issuedB.ok || !issuedC.ok)
      throw new Error('Expected distinct image resource capabilities.');
    expect(new Set([issuedA.token, issuedB.token, issuedC.token]).size).toBe(3);

    const [streamA, streamB, streamC] = await Promise.all([
      registry.open(issuedA.token),
      registry.open(issuedB.token),
      registry.open(issuedC.token),
    ]);
    expect(streamA).not.toBeNull();
    expect(streamB).not.toBeNull();
    expect(streamC).not.toBeNull();
    const readerA = streamA!.body.getReader();
    const readerB = streamB!.body.getReader();
    const readerC = streamC!.body.getReader();

    registry.release(issuedA.token);
    expect(await readUntilStopped(readerA, bytes.length)).toBeLessThan(bytes.length);
    const nextB = await readerB.read();
    expect(nextB.done).toBe(false);
    expect(nextB.value!.byteLength).toBeLessThanOrEqual(64 * 1024);

    registry.clear();
    expect(await readUntilStopped(readerB, bytes.length)).toBeLessThan(bytes.length);
    expect(await readUntilStopped(readerC, bytes.length)).toBeLessThan(bytes.length);
  });
});
