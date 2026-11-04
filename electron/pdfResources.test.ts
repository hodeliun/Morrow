import { constants } from 'node:fs';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open as openFileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPdfProtocolHandler, createPdfResourceRegistry } from './pdfResources.js';
import type { PdfVaultContext } from './pdfResources.js';

const roots: string[] = [];

function makeRoot(prefix = 'morrow-pdf-vault-'): string {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function makeFixture() {
  const root = makeRoot();
  mkdirSync(path.join(root, 'Documents'), { recursive: true });
  const pdfPath = path.join(root, 'Documents', 'selected.pdf');
  const bytes = Buffer.from('%PDF-1.7\nsynthetic read-only PDF bytes\n%%EOF\n');
  writeFileSync(pdfPath, bytes, { flag: 'wx' });
  let context: PdfVaultContext = { root, realRoot: root, generation: 1, vaultId: 'vault-a' };
  let tokenIndex = 0;
  const registry = createPdfResourceRegistry({
    getContext: () => context,
    createToken: () => (tokenIndex++).toString(36).padStart(43, 'a'),
  });
  return {
    root,
    pdfPath,
    bytes,
    registry,
    get context() {
      return context;
    },
    setContext(next: PdfVaultContext) {
      context = next;
    },
  };
}

async function bodyBytes(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PDF selected-file resources', () => {
  it('issues an opaque capability only for the selected PDF and opens it read-only', async () => {
    const fixture = makeFixture();
    const open = vi.fn((filePath: string, flags: number) => openFileHandle(filePath, flags));
    const registry = createPdfResourceRegistry({
      getContext: () => fixture.context,
      createToken: () => 't'.repeat(43),
      openFile: open,
    });

    const issued = await registry.issue('Documents/selected.pdf', 'vault-a');
    expect(issued).toMatchObject({
      ok: true,
      token: 't'.repeat(43),
      mimeType: 'application/pdf',
      size: fixture.bytes.length,
    });
    if (!issued.ok) throw new Error('Expected the selected PDF capability.');
    expect(JSON.stringify(issued)).not.toContain(fixture.root);

    const opened = await registry.open(issued.token, 0, fixture.bytes.length - 1);
    expect(open).toHaveBeenCalled();
    expect(open.mock.calls.every(([, flags]) => (flags & constants.O_WRONLY) === 0)).toBe(true);
    expect(opened && Buffer.from(await new Response(opened.body).arrayBuffer())).toEqual(fixture.bytes);
  });

  it('rejects non-PDF types, absolute paths, traversal, reserved paths, and a different vault', async () => {
    const fixture = makeFixture();
    expect(await fixture.registry.issue('Documents/note.md', 'vault-a')).toEqual({
      ok: false,
      code: 'unsupported-type',
    });
    expect(await fixture.registry.issue('../outside.pdf', 'vault-a')).toEqual({
      ok: false,
      code: 'invalid-resource',
    });
    expect(
      await fixture.registry.issue(path.join(fixture.root, 'Documents', 'selected.pdf'), 'vault-a'),
    ).toEqual({ ok: false, code: 'invalid-resource' });
    expect(await fixture.registry.issue('.morrow/selected.pdf', 'vault-a')).toEqual({
      ok: false,
      code: 'invalid-resource',
    });
    expect(await fixture.registry.issue('Documents/selected.pdf', 'vault-b')).toEqual({
      ok: false,
      code: 'vault-changed',
    });
  });

  it('rejects a symlinked directory even when it points back to a valid PDF', async () => {
    const root = makeRoot('morrow-pdf-symlink-vault-');
    const outside = makeRoot('morrow-pdf-symlink-target-');
    const outsidePdf = path.join(outside, 'selected.pdf');
    writeFileSync(outsidePdf, Buffer.from('%PDF-1.7\nsynthetic\n%%EOF\n'));
    const link = path.join(root, 'linked');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const registry = createPdfResourceRegistry({
      getContext: () => ({ root, realRoot: root, generation: 1, vaultId: 'vault-a' }),
      createToken: () => 's'.repeat(43),
    });
    expect(await registry.issue('linked/selected.pdf', 'vault-a')).toEqual({
      ok: false,
      code: 'invalid-resource',
    });
  });

  it('serves HEAD, bounded single byte ranges, and rejects a foreign capability URL', async () => {
    const fixture = makeFixture();
    const issued = await fixture.registry.issue('Documents/selected.pdf', 'vault-a');
    if (!issued.ok) throw new Error('Expected the selected PDF capability.');
    const handle = createPdfProtocolHandler({ getRegistry: () => fixture.registry });
    const url = `morrow-pdf://document/${issued.token}/selected.pdf`;

    const head = await handle(new Request(url, { method: 'HEAD', headers: { Range: 'bytes=0-2' } }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('application/pdf');
    expect(head.headers.get('content-length')).toBe(String(fixture.bytes.length));
    expect(await bodyBytes(head)).toHaveLength(0);

    const range = await handle(new Request(url, { headers: { Range: 'bytes=1-4' } }));
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 1-4/${fixture.bytes.length}`);
    expect(await bodyBytes(range)).toEqual(fixture.bytes.subarray(1, 5));

    const unsatisfiable = await handle(
      new Request(url, { headers: { Range: `bytes=${fixture.bytes.length}-` } }),
    );
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe(`bytes */${fixture.bytes.length}`);
    expect((await handle(new Request(`morrow-pdf://document/${issued.token}/elsewhere.pdf`))).status).toBe(
      404,
    );
    expect(
      (
        await handle(
          new Request(
            `morrow-pdf://document/${issued.token}/selected.pdf?path=${encodeURIComponent(fixture.pdfPath)}`,
          ),
        )
      ).status,
    ).toBe(404);
  });

  it('revokes a capability and its active stream when its owner closes', async () => {
    const fixture = makeFixture();
    const issued = await fixture.registry.issue('Documents/selected.pdf', 'vault-a');
    if (!issued.ok) throw new Error('Expected the selected PDF capability.');
    const opened = await fixture.registry.open(issued.token, 0, fixture.bytes.length - 1);
    if (!opened) throw new Error('Expected an open read-only stream.');
    fixture.registry.release(issued.token);
    expect(await fixture.registry.inspect(issued.token)).toBeNull();
    await opened.body.cancel().catch(() => undefined);
    expect(await fixture.registry.open(issued.token, 0, fixture.bytes.length - 1)).toBeNull();
  });

  it('invalidates a capability when the vault changes or the selected file identity changes', async () => {
    const fixture = makeFixture();
    const issued = await fixture.registry.issue('Documents/selected.pdf', 'vault-a');
    if (!issued.ok) throw new Error('Expected the selected PDF capability.');
    fixture.setContext({ ...fixture.context, generation: 2 });
    expect(await fixture.registry.inspect(issued.token)).toBeNull();

    const second = makeFixture();
    const secondIssue = await second.registry.issue('Documents/selected.pdf', 'vault-a');
    if (!secondIssue.ok) throw new Error('Expected the second selected PDF capability.');
    rmSync(second.pdfPath);
    writeFileSync(second.pdfPath, Buffer.from('%PDF-1.7\nreplacement file\n%%EOF\n'));
    expect(await second.registry.inspect(secondIssue.token)).toBeNull();
  });

  it('reports a selected file that disappears after its capability is issued', async () => {
    const fixture = makeFixture();
    const onUnavailable = vi.fn();
    const registry = createPdfResourceRegistry({
      getContext: () => fixture.context,
      createToken: () => 'm'.repeat(43),
      onUnavailable,
    });
    const issued = await registry.issue('Documents/selected.pdf', 'vault-a');
    if (!issued.ok) throw new Error('Expected the selected PDF capability.');
    rmSync(fixture.pdfPath);

    expect(await registry.inspect(issued.token)).toBeNull();
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnavailable).toHaveBeenCalledWith(issued.token);
    expect(await registry.inspect(issued.token)).toBeNull();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });
});
