import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { VaultScan } from '../core/vault/load';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import type { VaultBridge, VaultChange, VaultFileInfo } from './vaultBridge';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';
import { encodePolarisDadosViewMarker } from '../core/polarisDadosView';
import type { PolarisDadosViewData } from '../core/polarisDadosView';

const NOTE_PATH = 'Notes.md';
const WORKSPACE_PATH = '.morrow/workspace.json';
const RECENT_PATH = '.morrow/recent.json';
const NOTE_ID = 'note-1';

const viewData: PolarisDadosViewData = {
  version: 1,
  viewId: 'view-1',
  sourceDatabaseId: 'source-that-does-not-exist',
  title: 'Synthetic linked view',
  columnOrder: ['name', 'quantity'],
  filter: null,
};

const validMarker = encodePolarisDadosViewMarker(viewData);
const validNote = 'Before the view.\n\n' + validMarker + '\n\nAfter the view.\n';
const nestedOpen = '<details>\n<summary>Nested</summary>\n\n';
const nestedClose = '\n\n</details>';
const deeplyNestedNotes = [32, 64, 65].map(
  (depth) => nestedOpen.repeat(depth) + validMarker + nestedClose.repeat(depth),
);
const deeplyQuotedNotes = [20, 21, 65].map((depth) => '> '.repeat(depth) + validMarker + '\n');

function rawViewMarker(version: string, payload: unknown): string {
  return (
    '<!-- morrow:polaris-dados-view:' +
    version +
    ':' +
    Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') +
    ' -->'
  );
}

const unknownVersionMarker = rawViewMarker('v2', viewData);
const malformedMarker = '<!-- morrow:polaris-dados-view:v1:%%% -->';
const extraFieldMarker = rawViewMarker('v1', { ...viewData, futureOption: 'keep raw' });
const duplicateMarker = encodePolarisDadosViewMarker({ ...viewData, title: 'second occurrence' });
const protectedFixtures = [
  { note: '-\n  ' + validMarker + '\n', markers: [validMarker] },
  { note: '- # Heading\n\n  ' + validMarker + '\n', markers: [validMarker] },
  { note: '- > Quote\n  >\n  > ' + validMarker + '\n', markers: [validMarker] },
  ...deeplyNestedNotes.map((note) => ({ note, markers: [validMarker] })),
  ...deeplyQuotedNotes.map((note) => ({ note, markers: [validMarker] })),
  { note: 'Before protected data.\n\n' + unknownVersionMarker + '\n\nAfter.\n', markers: [unknownVersionMarker] },
  { note: 'Before malformed data.\n\n' + malformedMarker + '\n\nAfter.\n', markers: [malformedMarker] },
  { note: 'Before unknown fields.\n\n' + extraFieldMarker + '\n\nAfter.\n', markers: [extraFieldMarker] },
  {
    note: 'Before duplicate views.\n\n' + validMarker + '\n\n' + duplicateMarker + '\n\nAfter.\n',
    markers: [validMarker, duplicateMarker],
  },
];

class NodeFileVaultBridge implements VaultBridge {
  private readonly listeners = new Set<(changes: VaultChange[]) => void>();
  readonly appliedOps: VaultOp[][] = [];

  constructor(readonly root: string) {}

  private absolute(path: string): string {
    return join(this.root, ...path.split('/'));
  }

  absoluteForTest(path: string): string {
    return this.absolute(path);
  }

  async scan(): Promise<VaultScan> {
    const files: VaultScan['files'] = [];
    const folders: VaultScan['folders'] = [];
    const others: string[] = [];
    const visit = async (relative: string): Promise<void> => {
      const directory = relative ? this.absolute(relative) : this.root;
      const entries = await readdir(directory, { withFileTypes: true });
      if (relative) {
        const info = await stat(directory);
        folders.push({ path: relative, mtime: info.mtimeMs, empty: entries.length === 0 });
      }
      for (const entry of entries) {
        const path = relative ? relative + '/' + entry.name : entry.name;
        const absolute = this.absolute(path);
        if (entry.isDirectory()) {
          await visit(path);
          continue;
        }
        const info = await stat(absolute);
        if (['.md', '.canvas'].includes(extname(path).toLowerCase())) {
          files.push({
            path,
            text: await readFile(absolute, 'utf8'),
            mtime: info.mtimeMs,
            birthtime: info.birthtimeMs,
          });
        } else {
          others.push(path);
        }
      }
    };
    await visit('');
    const json = async (path: string): Promise<unknown> => {
      const text = await this.readText(path);
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    };
    return {
      files,
      folders,
      others,
      registry: await json(WORKSPACE_PATH),
      recent: await json(RECENT_PATH),
    };
  }

  async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    this.appliedOps.push(ops.map((op) => ({ ...op })) as VaultOp[]);
    const results: VaultOpResult[] = [];
    for (const op of ops) {
      try {
        if (op.op === 'check') {
          const current = await this.readText(op.path);
          if (current !== op.expect) {
            results.push({ ok: false, code: 'conflict', message: 'changed on disk', current });
            break;
          }
        } else if (op.op === 'write') {
          const current = await this.readText(op.path);
          if (op.expect !== undefined && current !== op.expect) {
            results.push({ ok: false, code: 'conflict', message: 'changed on disk', current });
            break;
          }
          await mkdir(dirname(this.absolute(op.path)), { recursive: true });
          await writeFile(this.absolute(op.path), op.text, 'utf8');
        } else if (op.op === 'rename') {
          try {
            await access(this.absolute(op.from));
          } catch {
            if (op.optional) {
              results.push({ ok: true });
              continue;
            }
            results.push({ ok: false, code: 'error', message: 'missing: ' + op.from });
            break;
          }
          try {
            await access(this.absolute(op.to));
            results.push({ ok: false, code: 'exists', message: op.to + ' exists' });
            break;
          } catch {
            await mkdir(dirname(this.absolute(op.to)), { recursive: true });
            await rename(this.absolute(op.from), this.absolute(op.to));
          }
        } else if (op.op === 'remove' || op.op === 'delete') {
          await unlink(this.absolute(op.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
        } else if (op.op === 'rmdir') {
          await rmdir(this.absolute(op.path)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error;
          });
        }
        results.push({ ok: true });
      } catch (error) {
        results.push({ ok: false, code: 'error', message: String(error) });
        break;
      }
    }
    return results;
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(this.absolute(path), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async readBytes(path: string): Promise<ArrayBuffer | null> {
    try {
      const bytes = await readFile(this.absolute(path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async createFile(path: string, data: ArrayBuffer): Promise<void> {
    await mkdir(dirname(this.absolute(path)), { recursive: true });
    await writeFile(this.absolute(path), new Uint8Array(data), { flag: 'wx' });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.absolute(path));
      return true;
    } catch {
      return false;
    }
  }

  async listFiles(directory: string): Promise<VaultFileInfo[]> {
    const files: VaultFileInfo[] = [];
    for (const entry of await readdir(this.absolute(directory), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const path = directory ? directory + '/' + entry.name : entry.name;
      const info = await stat(this.absolute(path));
      files.push({ path, size: info.size, mtime: info.mtimeMs });
    }
    return files;
  }

  onChange(listener: (changes: VaultChange[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  fileUrl(): null {
    return null;
  }
}

async function makeVault(note: string): Promise<NodeFileVaultBridge> {
  const root = await mkdtemp(join(tmpdir(), 'morrow-e003-linked-view-'));
  const files: Record<string, string> = {
    [NOTE_PATH]: note,
    [WORKSPACE_PATH]: JSON.stringify({
      version: 1,
      pages: { [NOTE_PATH]: { id: NOTE_ID, created: 1, order: 0 } },
    }),
    [RECENT_PATH]: JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, ...path.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, text, 'utf8');
  }
  return new NodeFileVaultBridge(root);
}

async function dispose(bridge: NodeFileVaultBridge): Promise<void> {
  await rm(bridge.root, { recursive: true, force: true });
}

async function open(bridge: NodeFileVaultBridge): Promise<WorkspaceSession> {
  let generatedId = 0;
  const result = await WorkspaceSession.open(
    new VaultRepository(bridge, () => 'unexpected-generated-' + ++generatedId),
    { delayMs: 60_000 },
  );
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

async function fingerprintFiles(bridge: NodeFileVaultBridge) {
  const paths: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    for (const entry of await readdir(relative ? join(bridge.root, relative) : bridge.root, {
      withFileTypes: true,
    })) {
      const path = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) await visit(path);
      else paths.push(path);
    }
  };
  await visit('');
  const entries = await Promise.all(
    paths.sort().map(async (path) => {
      const absolute = bridge.absoluteForTest(path);
      const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute, { bigint: true })]);
      return [
        path,
        {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mtimeNs: info.mtimeNs.toString(),
          size: info.size.toString(),
        },
      ] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function linkedViewFrom(session: WorkspaceSession) {
  const doc = session.getState().docs[NOTE_ID];
  if (!doc) throw new Error('The synthetic note did not load.');
  return doc.content?.find((node) => node.type === 'polarisDadosView') ?? null;
}

describe('independent linked-view persistence checks with real temporary files', () => {
  it('opens and reopens a valid view with an absent source without writing or creating pages', async () => {
    const bridge = await makeVault(validNote);
    let first: WorkspaceSession | undefined;
    let second: WorkspaceSession | undefined;
    try {
      const before = await fingerprintFiles(bridge);
      first = await open(bridge);
      expect(first.protectedReasons.has(NOTE_ID)).toBe(false);
      expect(linkedViewFrom(first)).toEqual({ type: 'polarisDadosView', attrs: viewData });
      expect(first.getState().pages[viewData.sourceDatabaseId]).toBeUndefined();
      expect(await first.flush()).toBe(true);
      await first.close();
      first = undefined;

      expect(await fingerprintFiles(bridge)).toEqual(before);
      expect(bridge.appliedOps).toEqual([]);

      second = await open(bridge);
      expect(second.protectedReasons.has(NOTE_ID)).toBe(false);
      expect(linkedViewFrom(second)).toEqual({ type: 'polarisDadosView', attrs: viewData });
      expect(second.getState().pages[viewData.sourceDatabaseId]).toBeUndefined();
      expect(await second.flush()).toBe(true);
      await second.close();
      second = undefined;

      expect(await fingerprintFiles(bridge)).toEqual(before);
      expect(bridge.appliedOps).toEqual([]);
    } finally {
      if (first && !first.isClosed) await first.close();
      if (second && !second.isClosed) await second.close();
      await dispose(bridge);
    }
  });

  it('protects unknown, malformed, extra-field, and duplicate markers before normalization', async () => {
    for (const [index, fixture] of protectedFixtures.entries()) {
      const bridge = await makeVault(fixture.note);
      let session: WorkspaceSession | undefined;
      try {
        const before = await fingerprintFiles(bridge);
        session = await open(bridge);
        expect(
          session.protectedReasons.get(NOTE_ID),
          `protected fixture ${index + 1}: ${JSON.stringify(fixture.note.slice(0, 80))}`,
        ).toBeTruthy();

        const raw = session.getState().docs[NOTE_ID]?.content?.[0];
        expect(raw?.type).toBe('rawBlock');
        expect(raw?.attrs?.text).toBe(fixture.note);
        for (const marker of fixture.markers) expect(String(raw?.attrs?.text)).toContain(marker);
        expect(session.getState().pages[viewData.sourceDatabaseId]).toBeUndefined();

        const edit = session.execute({
          type: 'page.setDoc',
          id: NOTE_ID,
          doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'overwrite' }] }] },
          now: 2,
        });
        expect(edit.ok).toBe(false);
        expect(await session.flush()).toBe(true);
        await session.close();
        session = undefined;

        expect(await fingerprintFiles(bridge)).toEqual(before);
        expect(bridge.appliedOps).toEqual([]);
      } finally {
        if (session && !session.isClosed) await session.close();
        await dispose(bridge);
      }
    }
  });
});
