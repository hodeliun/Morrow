import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPluginNoteStyleDefaultsPanel,
  addPluginNoteStylePanel,
  documentoNoteStyleDefaultsPanel,
  documentoNoteStylePanel,
  subscribePlugins,
} from './registry';

describe('Documento note-style panel registration', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('is exclusive to Documento and requires a mount function', () => {
    expect(() => addPluginNoteStylePanel('polaris-dados', () => {})).toThrow(/only polaris documento/i);
    expect(() => addPluginNoteStylePanel('polaris-documento', null as never)).toThrow(/mount function/i);
    expect(documentoNoteStylePanel()).toBeNull();
  });

  it('invalidates replaced and removed generations without letting old cleanup remove the new mount', () => {
    const firstMount = vi.fn();
    const removeFirst = addPluginNoteStylePanel('polaris-documento', firstMount);
    const first = documentoNoteStylePanel();
    expect(first?.isActive()).toBe(true);

    const secondMount = vi.fn();
    dispose = addPluginNoteStylePanel('polaris-documento', secondMount);
    const second = documentoNoteStylePanel();
    expect(first?.isActive()).toBe(false);
    expect(second?.mount).toBe(secondMount);
    expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);
    expect(second?.isActive()).toBe(true);

    removeFirst();
    expect(documentoNoteStylePanel()).toBe(second);

    dispose();
    dispose = null;
    expect(second?.isActive()).toBe(false);
    expect(documentoNoteStylePanel()).toBeNull();
  });

  it('notifies a mounted PageView when the panel appears and disappears', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePlugins(listener);
    dispose = addPluginNoteStylePanel('polaris-documento', () => {});
    expect(listener).toHaveBeenCalledOnce();

    dispose();
    dispose = null;
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});

describe('Documento note-style defaults registration', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('is Documento-only and invalidates replacements without removing the successor', () => {
    expect(() => addPluginNoteStyleDefaultsPanel('polaris-dados', () => {})).toThrow(
      /only polaris documento/i,
    );
    expect(() => addPluginNoteStyleDefaultsPanel('polaris-documento', null as never)).toThrow(
      /mount function/i,
    );

    const firstMount = vi.fn();
    const removeFirst = addPluginNoteStyleDefaultsPanel('polaris-documento', firstMount);
    const first = documentoNoteStyleDefaultsPanel();
    expect(first?.isActive()).toBe(true);

    const secondMount = vi.fn();
    dispose = addPluginNoteStyleDefaultsPanel('polaris-documento', secondMount);
    const second = documentoNoteStyleDefaultsPanel();
    expect(first?.isActive()).toBe(false);
    expect(second?.mount).toBe(secondMount);
    expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);

    removeFirst();
    expect(documentoNoteStyleDefaultsPanel()).toBe(second);

    dispose();
    dispose = null;
    expect(documentoNoteStyleDefaultsPanel()).toBeNull();
  });
});
