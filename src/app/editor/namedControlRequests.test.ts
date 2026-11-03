import { describe, expect, it, vi } from 'vitest';
import {
  cancelNamedControlConfigurationRequest,
  listenForNamedControlConfiguration,
  requestNamedControlConfiguration,
} from './namedControlRequests';

describe('named control configuration requests', () => {
  it('routes the same control identity to only the requesting editor instance', () => {
    const ownerA = {};
    const ownerB = {};
    const openA = vi.fn();
    const openB = vi.fn();
    const disposeA = listenForNamedControlConfiguration(ownerA, 'same-page', 'same-control', openA);
    const disposeB = listenForNamedControlConfiguration(ownerB, 'same-page', 'same-control', openB);

    requestNamedControlConfiguration(ownerA, 'same-page', 'same-control', { type: 'relation', targetDatabaseId: 'table-a' });

    expect(openA).toHaveBeenCalledExactlyOnceWith({ type: 'relation', targetDatabaseId: 'table-a' });
    expect(openB).not.toHaveBeenCalled();
    disposeA();
    disposeB();
  });

  it('cancels only the removed control request for that editor owner', () => {
    const ownerA = {};
    const ownerB = {};
    const openA = vi.fn();
    const openB = vi.fn();

    requestNamedControlConfiguration(ownerA, 'page-a', 'control-a', { type: 'text' });
    requestNamedControlConfiguration(ownerB, 'page-a', 'control-a', { type: 'number' });
    cancelNamedControlConfigurationRequest(ownerA, 'page-a', 'control-a');
    const disposeA = listenForNamedControlConfiguration(ownerA, 'page-a', 'control-a', openA);
    const disposeB = listenForNamedControlConfiguration(ownerB, 'page-a', 'control-a', openB);

    expect(openA).not.toHaveBeenCalled();
    expect(openB).toHaveBeenCalledExactlyOnceWith({ type: 'number' });
    disposeA();
    disposeB();
  });
});
