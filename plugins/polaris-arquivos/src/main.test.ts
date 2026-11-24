import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginSidebarFileCatalogMount } from '../../../src/app/plugins/registry';
import { activate } from './main';

describe('Polaris Arquivos activation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tolerates an absent sidebar capability', () => {
    expect(() => activate(null)).not.toThrow();
    expect(() => activate({})).not.toThrow();
    expect(() => activate({ sidebar: { fileCatalog: {} } })).not.toThrow();
  });

  it('registers one host mount and removes it and local styles on cleanup', () => {
    const calls: string[] = [];
    const add = vi.fn((_mount: PluginSidebarFileCatalogMount) => {
      calls.push('register');
      return () => calls.push('unregister');
    });
    const addStyles = vi.fn(() => {
      calls.push('style');
      return () => calls.push('unstyled');
    });
    const cleanup = activate({ sidebar: { fileCatalog: { add } }, styles: { add: addStyles }, locale: 'pt' });

    expect(add).toHaveBeenCalledOnce();
    expect(addStyles).toHaveBeenCalledOnce();
    cleanup();
    cleanup();
    expect(calls).toEqual(['style', 'register', 'unregister', 'unstyled']);
  });
});
