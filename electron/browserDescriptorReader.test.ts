import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BROWSER_DESCRIPTOR_BYTES, readBoundedBrowserDescriptor } from './browserDescriptorReader.js';
import type { BrowserDescriptorFileSystem, BrowserDescriptorVaultContext } from './browserDescriptorReader.js';

const roots: string[] = [];

async function fixture(contents: string | Buffer = '{"url":"https://docs.google.com/document/d/synthetic"}') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'morrow-browser-descriptor-')));
  roots.push(root);
  const directory = path.join(root, 'notes');
  await mkdir(directory);
  const candidate = path.join(directory, 'synthetic.gdoc');
  await writeFile(candidate, contents);
  const context: BrowserDescriptorVaultContext = {
    root,
    realRoot: root,
    generation: 7,
  };
  return { root, candidate, context };
}

function changedInode(stats: Stats): Stats {
  const changed = Object.create(stats) as Stats;
  Object.defineProperty(changed, 'ino', { value: stats.ino === 0 ? 1 : 0 });
  if (changed.ino === stats.ino) throw new Error('The synthetic identity change must produce a distinct inode.');
  return changed;
}

function baseFileSystem(): BrowserDescriptorFileSystem {
  return { lstat, realpath, open };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('bounded browser descriptor reads', () => {
  it('reads a small descriptor only while the same in-vault file and context remain current', async () => {
    const { candidate, context } = await fixture();
    const contents = await readBoundedBrowserDescriptor({
      candidate,
      context,
      getCurrentContext: () => context,
    });

    expect(contents).toBe('{"url":"https://docs.google.com/document/d/synthetic"}');
  });

  it('rejects a handle whose identity differs from the validated path before reading', async () => {
    const { candidate, context } = await fixture();
    let readCount = 0;
    const fileSystem: BrowserDescriptorFileSystem = {
      ...baseFileSystem(),
      async open(location, flags) {
        const actual = await open(location, flags);
        return {
          async stat() {
            return changedInode(await actual.stat());
          },
          async read(buffer, offset, length, position) {
            readCount += 1;
            return actual.read(buffer, offset, length, position);
          },
          close: () => actual.close(),
        };
      },
    };

    expect(
      await readBoundedBrowserDescriptor({
        candidate,
        context,
        getCurrentContext: () => context,
        fileSystem,
      }),
    ).toBeNull();
    expect(readCount).toBe(0);
  });

  it('rejects a path identity change after reading instead of returning buffered bytes', async () => {
    const { candidate, context } = await fixture();
    let candidateLookups = 0;
    let readCount = 0;
    const fileSystem: BrowserDescriptorFileSystem = {
      ...baseFileSystem(),
      async lstat(location) {
        const stats = await lstat(location);
        if (path.resolve(location) !== candidate) return stats;
        candidateLookups += 1;
        return candidateLookups === 3 ? changedInode(stats) : stats;
      },
      async open(location, flags) {
        const actual = await open(location, flags);
        return {
          stat: () => actual.stat(),
          async read(buffer, offset, length, position) {
            readCount += 1;
            return actual.read(buffer, offset, length, position);
          },
          close: () => actual.close(),
        };
      },
    };

    expect(
      await readBoundedBrowserDescriptor({
        candidate,
        context,
        getCurrentContext: () => context,
        fileSystem,
      }),
    ).toBeNull();
    expect(readCount).toBe(1);
    expect(candidateLookups).toBe(3);
  });

  it('rejects a vault generation change while the read is in progress', async () => {
    const { candidate, context } = await fixture();
    let currentContext: BrowserDescriptorVaultContext | null = context;
    const fileSystem: BrowserDescriptorFileSystem = {
      ...baseFileSystem(),
      async open(location, flags) {
        const actual = await open(location, flags);
        return {
          stat: () => actual.stat(),
          async read(buffer, offset, length, position) {
            const result = await actual.read(buffer, offset, length, position);
            currentContext = { ...context, generation: context.generation + 1 };
            return result;
          },
          close: () => actual.close(),
        };
      },
    };

    expect(
      await readBoundedBrowserDescriptor({
        candidate,
        context,
        getCurrentContext: () => currentContext,
        fileSystem,
      }),
    ).toBeNull();
  });

  it('does not open a descriptor larger than 64 KiB', async () => {
    const { candidate, context } = await fixture(Buffer.alloc(MAX_BROWSER_DESCRIPTOR_BYTES + 1, 0x61));
    let openCount = 0;
    const fileSystem: BrowserDescriptorFileSystem = {
      ...baseFileSystem(),
      async open(location, flags) {
        openCount += 1;
        return open(location, flags);
      },
    };

    expect(
      await readBoundedBrowserDescriptor({
        candidate,
        context,
        getCurrentContext: () => context,
        fileSystem,
      }),
    ).toBeNull();
    expect(openCount).toBe(0);
  });
});
