import { describe, expect, it, vi } from 'vitest';
import { createChooseBrowserOnceAction } from './externalOpenErrorActions';
import { fileHandlerErrorKey } from './fileHandlerMessages';

describe('choose-browser-once toast action', () => {
  it('keeps existing error codes mapped to their localized messages', () => {
    expect(fileHandlerErrorKey('application-missing')).toBe('fileCatalog.applicationMissing');
  });

  it('waits for the action to run before retrying with the selected browser', () => {
    const chooseOnce = vi.fn();
    const action = createChooseBrowserOnceAction(
      { url: 'https://example.test/path', canChooseBrowser: true },
      'Choose another browser',
      chooseOnce,
    );

    expect(chooseOnce).not.toHaveBeenCalled();
    expect(action?.label).toBe('Choose another browser');
    action?.run();
    expect(chooseOnce).toHaveBeenCalledExactlyOnceWith('https://example.test/path');
  });

  it.each([
    [{ url: null, canChooseBrowser: true }],
    [{ url: 'https://example.test/', canChooseBrowser: false }],
  ])('does not offer or run recovery for a non-retryable error: %j', (error) => {
    const chooseOnce = vi.fn();
    const action = createChooseBrowserOnceAction(error, 'Choose another browser', chooseOnce);

    expect(action).toBeUndefined();
    expect(chooseOnce).not.toHaveBeenCalled();
  });
});
