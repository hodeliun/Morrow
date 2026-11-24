import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultFilePage } from '../platform/desktop';
import {
  addPluginSidebarFileCatalog,
  polarisArquivosSidebarFileCatalog,
  subscribePlugins,
} from './registry';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('Polaris Arquivos sidebar catalog registration', () => {
  it('is exclusive, validates the mount, and supports a host with no file capability', () => {
    expect(() =>
      addPluginSidebarFileCatalog('polaris-dados', 1, () => {}, { isActive: () => true }, () => true),
    ).toThrow(/only polaris arquivos/i);
    expect(() =>
      addPluginSidebarFileCatalog('polaris-arquivos', 1, null as never, { isActive: () => true }, () => true),
    ).toThrow(/mount function/i);

    const dispose = addPluginSidebarFileCatalog(
      'polaris-arquivos',
      1,
      () => {},
      { isActive: () => true },
      () => true,
    );
    cleanups.push(dispose);
    const registration = polarisArquivosSidebarFileCatalog();
    expect(registration?.owner).toBe('polaris-arquivos');
    expect(registration?.host.listFilesPage).toBeUndefined();
    expect(registration?.isActive()).toBe(true);
  });

  it('invalidates replaced owners and old cleanup cannot remove the newer mount', () => {
    const firstMount = vi.fn();
    const firstOwnerActive = vi.fn(() => true);
    const removeFirst = addPluginSidebarFileCatalog(
      'polaris-arquivos',
      10,
      firstMount,
      { isActive: () => true },
      firstOwnerActive,
    );
    cleanups.push(removeFirst);
    const first = polarisArquivosSidebarFileCatalog();

    let secondActive = true;
    const secondMount = vi.fn();
    const secondHost = { isActive: () => secondActive };
    const removeSecond = addPluginSidebarFileCatalog(
      'polaris-arquivos',
      11,
      secondMount,
      secondHost,
      () => true,
    );
    cleanups.push(removeSecond);
    const second = polarisArquivosSidebarFileCatalog();
    expect(first?.isActive()).toBe(false);
    expect(second?.mount).toBe(secondMount);
    expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);

    removeFirst();
    expect(polarisArquivosSidebarFileCatalog()).toBe(second);
    secondActive = false;
    expect(polarisArquivosSidebarFileCatalog()).toBeNull();
    removeSecond();
    expect(polarisArquivosSidebarFileCatalog()).toBeNull();
  });

  it('binds catalog calls to the exact registration lease, including pending requests', async () => {
    let resolveFirst!: (value: VaultFilePage) => void;
    const firstPending = new Promise<VaultFilePage>((resolve) => {
      resolveFirst = resolve;
    });
    const firstList = vi.fn(() => firstPending);
    const firstReadPreferences = vi.fn(() => ({ status: 'ready' as const, value: { mode: 'selected' } }));
    const firstWritePreferences = vi.fn(() => ({ status: 'saved' as const }));
    const ownerIsActive = () => true;
    const sessionHost = {
      isActive: () => true,
      listFilesPage: firstList,
      readPreferences: firstReadPreferences,
      writePreferences: firstWritePreferences,
    };
    const removeFirst = addPluginSidebarFileCatalog(
      'polaris-arquivos',
      20,
      () => {},
      sessionHost,
      ownerIsActive,
    );
    cleanups.push(removeFirst);
    const first = polarisArquivosSidebarFileCatalog();
    expect(first!.host.readPreferences!()).toEqual({ status: 'ready', value: { mode: 'selected' } });
    const pendingFromFirst = first!.host.listFilesPage!('Media', null, 200);
    expect(firstList).toHaveBeenCalledOnce();

    const secondList = vi.fn(async (): Promise<VaultFilePage> => ({
      generation: 2,
      status: 'ready',
      entries: [{ name: 'current.pdf', path: 'Media/current.pdf', kind: 'file', size: 2, modified: null }],
      nextCursor: null,
      error: null,
    }));
    const secondReadPreferences = vi.fn(() => ({ status: 'ready' as const, value: { mode: 'all' } }));
    const removeSecond = addPluginSidebarFileCatalog(
      'polaris-arquivos',
      21,
      () => {},
      { isActive: () => true, listFilesPage: secondList, readPreferences: secondReadPreferences },
      ownerIsActive,
    );
    cleanups.push(removeSecond);
    const second = polarisArquivosSidebarFileCatalog();

    expect(first?.isActive()).toBe(false);
    expect(first!.host.readPreferences!()).toEqual({ status: 'unavailable' });
    expect(first!.host.writePreferences!(null)).toEqual({ status: 'unavailable' });
    expect(firstWritePreferences).not.toHaveBeenCalled();
    expect((await first!.host.listFilesPage!('Media', null, 200)).status).toBe('stale');
    expect(firstList).toHaveBeenCalledOnce();
    resolveFirst({
      generation: 1,
      status: 'ready',
      entries: [{ name: 'old.pdf', path: 'Media/old.pdf', kind: 'file', size: 1, modified: null }],
      nextCursor: null,
      error: null,
    });
    expect((await pendingFromFirst).status).toBe('stale');

    const current = await second!.host.listFilesPage!('Media', null, 200);
    expect(current.entries[0]?.name).toBe('current.pdf');
    expect(secondList).toHaveBeenCalledOnce();
    expect(second!.host.readPreferences!()).toEqual({ status: 'ready', value: { mode: 'all' } });
    expect(secondReadPreferences).toHaveBeenCalledOnce();
    removeSecond();
    expect((await second!.host.listFilesPage!('Media', null, 200)).status).toBe('stale');
    expect(secondList).toHaveBeenCalledOnce();
  });

  it('notifies the single sidebar slot when registration appears and is removed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePlugins(listener);
    cleanups.push(unsubscribe);
    const dispose = addPluginSidebarFileCatalog(
      'polaris-arquivos',
      1,
      () => {},
      { isActive: () => true },
      () => true,
    );
    cleanups.push(dispose);
    expect(listener).toHaveBeenCalledOnce();
    dispose();
    expect(polarisArquivosSidebarFileCatalog()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
