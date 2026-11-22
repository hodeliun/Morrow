import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPluginInlineFormulaPresentation,
  polarisDadosInlineFormulaPresentation,
  subscribeInlineFormulaPresentation,
} from './registry';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('Polaris Dados inline formula presentation registry', () => {
  it('is exclusive, notifies mounted readers and only removes its own active generation', () => {
    const firstMount = vi.fn();
    const replacementMount = vi.fn();
    const listener = vi.fn();
    const unsubscribe = subscribeInlineFormulaPresentation(listener);
    cleanups.push(unsubscribe);

    const removeFirst = addPluginInlineFormulaPresentation('polaris-dados', firstMount);
    cleanups.push(removeFirst);
    const first = polarisDadosInlineFormulaPresentation();
    expect(first?.owner).toBe('polaris-dados');
    expect(first?.isActive()).toBe(true);

    const removeReplacement = addPluginInlineFormulaPresentation('polaris-dados', replacementMount);
    cleanups.push(removeReplacement);
    const replacement = polarisDadosInlineFormulaPresentation();
    expect(first?.isActive()).toBe(false);
    expect(replacement?.generation).toBeGreaterThan(first?.generation ?? 0);
    expect(replacement?.mount).toBe(replacementMount);
    removeFirst();
    expect(polarisDadosInlineFormulaPresentation()).toBe(replacement);
    removeReplacement();
    expect(polarisDadosInlineFormulaPresentation()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('rejects registration from another plugin owner', () => {
    expect(() => addPluginInlineFormulaPresentation('polaris-documento', () => {})).toThrow(/only polaris dados/i);
  });

  it('continues notifying remaining readers when one listener throws', () => {
    const calls: string[] = [];
    const removeBroken = subscribeInlineFormulaPresentation(() => {
      calls.push('broken');
      throw new Error('synthetic listener failure');
    });
    const removeHealthy = subscribeInlineFormulaPresentation(() => calls.push('healthy'));
    const remove = addPluginInlineFormulaPresentation('polaris-dados', () => {});

    expect(calls).toEqual(['broken', 'healthy']);
    expect(() => remove()).not.toThrow();
    expect(calls).toEqual(['broken', 'healthy', 'broken', 'healthy']);

    removeBroken();
    removeHealthy();
  });
});
