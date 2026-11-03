import { describe, expect, it, vi } from 'vitest';
import { listenForNamedControlConfiguration, requestNamedControlConfiguration } from './namedControlRequests';
import {
  cancelCalculatedResultConfigurationRequest,
  listenForCalculatedResultConfiguration,
  requestCalculatedResultConfiguration,
  requestCalculatedResultConfigurationForInsertedNode,
} from './calculatedResultRequests';

describe('calculated result configuration requests', () => {
  it('delivers a slash request after the inserted node mounts', () => {
    const owner = {};
    const listener = vi.fn();

    requestCalculatedResultConfiguration(owner, 'page-late-mount', 'result-late-mount');
    const dispose = listenForCalculatedResultConfiguration(owner, 'page-late-mount', 'result-late-mount', listener);
    const laterMount = vi.fn();
    const disposeLater = listenForCalculatedResultConfiguration(owner, 'page-late-mount', 'result-late-mount', laterMount);

    expect(listener).toHaveBeenCalledOnce();
    dispose();
    expect(laterMount).not.toHaveBeenCalled();
    disposeLater();
  });

  it('opens only the requested result and removes listeners on unmount', () => {
    const owner = {};
    const matching = vi.fn();
    const unrelated = vi.fn();
    const sameIdOtherPage = vi.fn();
    const namedControl = vi.fn();
    const dispose = listenForCalculatedResultConfiguration(owner, 'page-live', 'result-a', matching);
    const disposeUnrelated = listenForCalculatedResultConfiguration(owner, 'page-live', 'result-b', unrelated);
    const disposeOtherPage = listenForCalculatedResultConfiguration(owner, 'other-page', 'result-a', sameIdOtherPage);
    const disposeControl = listenForNamedControlConfiguration(owner, 'page-live', 'result-a', namedControl);

    requestCalculatedResultConfiguration(owner, 'page-live', 'result-a');
    dispose();
    disposeUnrelated();
    disposeOtherPage();
    requestNamedControlConfiguration(owner, 'page-live', 'result-a', { type: 'text' });
    disposeControl();

    expect(matching).toHaveBeenCalledOnce();
    expect(unrelated).not.toHaveBeenCalled();
    expect(sameIdOtherPage).not.toHaveBeenCalled();
    expect(namedControl).toHaveBeenCalledOnce();
  });

  it('clears a queued request if the inserted result is removed before its node view mounts', () => {
    const owner = {};
    const listener = vi.fn();

    requestCalculatedResultConfiguration(owner, 'page-undone', 'result-undone');
    cancelCalculatedResultConfigurationRequest(owner, 'page-undone', 'result-undone');
    const dispose = listenForCalculatedResultConfiguration(owner, 'page-undone', 'result-undone', listener);

    expect(listener).not.toHaveBeenCalled();
    dispose();
  });

  it('does not queue an editor request when insertion fails', () => {
    const owner = {};
    const listener = vi.fn();

    requestCalculatedResultConfigurationForInsertedNode(false, owner, 'page-failed', 'result-failed');
    const dispose = listenForCalculatedResultConfiguration(owner, 'page-failed', 'result-failed', listener);

    expect(listener).not.toHaveBeenCalled();
    dispose();
  });

  it('sends the same page and result ID only to the requesting editor instance', () => {
    const ownerA = {};
    const ownerB = {};
    const focusedA = vi.fn();
    const focusedB = vi.fn();
    const disposeA = listenForCalculatedResultConfiguration(ownerA, 'same-page', 'same-result', focusedA);
    const disposeB = listenForCalculatedResultConfiguration(ownerB, 'same-page', 'same-result', focusedB);

    requestCalculatedResultConfigurationForInsertedNode(true, ownerA, 'same-page', 'same-result');

    expect(focusedA).toHaveBeenCalledOnce();
    expect(focusedB).not.toHaveBeenCalled();
    disposeA();
    disposeB();
  });
});
