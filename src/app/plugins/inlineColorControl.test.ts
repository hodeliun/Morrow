import { afterEach, describe, expect, it, vi } from 'vitest';
import { addPluginInlineColorControl, documentoInlineColorControl, subscribePlugins } from './registry';

describe('Documento inline color control registration', () => {
  let dispose: (() => void) | null = null;

  afterEach(() => {
    dispose?.();
    dispose = null;
  });

  it('invalidates a mounted owner immediately when disabled or replaced', () => {
    const firstMount = vi.fn();
    const firstCleanup = addPluginInlineColorControl('polaris-documento', firstMount);
    const first = documentoInlineColorControl();
    expect(first?.isActive()).toBe(true);

    const secondMount = vi.fn();
    dispose = addPluginInlineColorControl('polaris-documento', secondMount);
    const second = documentoInlineColorControl();
    expect(first?.isActive()).toBe(false);
    expect(second?.mount).toBe(secondMount);
    expect(second?.isActive()).toBe(true);

    firstCleanup();
    expect(documentoInlineColorControl()).toBe(second);

    dispose();
    dispose = null;
    expect(second?.isActive()).toBe(false);
    expect(documentoInlineColorControl()).toBeNull();
  });

  it('notifies the open color panel when its control appears and disappears', () => {
    const listener = vi.fn();
    const unsubscribe = subscribePlugins(listener);
    dispose = addPluginInlineColorControl('polaris-documento', () => {});
    expect(listener).toHaveBeenCalledOnce();

    dispose();
    dispose = null;
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
