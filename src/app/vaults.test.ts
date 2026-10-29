import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  events: [] as string[],
  commitEditors: vi.fn(),
  getSession: vi.fn(),
  reload: vi.fn(),
  select: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('./editor/commits', () => ({ commitEditors: harness.commitEditors }));
vi.mock('./legacy', () => ({ COPY_LEGACY_KEY: 'morrow.copyLegacy' }));
vi.mock('./platform/desktop', () => ({ desktop: { vault: { select: harness.select } } }));
vi.mock('./i18n', () => ({
  t: (key: string, values?: Record<string, string>) =>
    key === 'topBar.saveError' ? `Save error: ${values?.error ?? ''}` : key,
}));
vi.mock('./ui', () => ({ toast: harness.toast }));
vi.mock('./workspace', () => ({ getSession: harness.getSession }));

import { switchVault } from './vaults';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

function sessionWithFlush(flush: () => Promise<boolean>, error: string | null = null) {
  return { flush: vi.fn(flush), queue: { status: { error } } };
}

describe('switchVault', () => {
  beforeEach(() => {
    harness.events.length = 0;
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { reload: harness.reload } },
    });
    harness.select.mockImplementation(async () => {
      harness.events.push('select');
      return { ok: true };
    });
    harness.reload.mockImplementation(() => harness.events.push('reload'));
    harness.commitEditors.mockImplementation(() => harness.events.push('commit'));
  });

  afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });

  it('blocks vault selection and reload when flushing leaves edits pending', async () => {
    const queue = { status: { error: 'disk unavailable' } };
    const session = { flush: vi.fn().mockResolvedValue(false), queue };
    harness.getSession.mockReturnValue(session);

    await expect(switchVault('vault-b')).resolves.toBe(false);

    expect(harness.commitEditors).toHaveBeenCalledOnce();
    expect(session.flush).toHaveBeenCalledOnce();
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.getSession()).toBe(session);
    expect(session.queue).toBe(queue);
    expect(queue.status.error).toBe('disk unavailable');
    expect(harness.toast).toHaveBeenCalledWith('Save error: disk unavailable', { tone: 'error' });
  });

  it('blocks vault selection and reload when flushing throws', async () => {
    const session = {
      flush: vi.fn().mockRejectedValue(new Error('write failed')),
      queue: { status: { error: null } },
    };
    harness.getSession.mockReturnValue(session);

    await expect(switchVault('vault-b')).resolves.toBe(false);

    expect(harness.commitEditors).toHaveBeenCalledOnce();
    expect(session.flush).toHaveBeenCalledOnce();
    expect(harness.select).not.toHaveBeenCalled();
    expect(harness.reload).not.toHaveBeenCalled();
    expect(harness.getSession()).toBe(session);
    expect(session.queue.status.error).toBeNull();
    expect(harness.toast).toHaveBeenCalledWith('Save error: write failed', { tone: 'error' });
  });

  it('allows the first vault when no workspace session exists yet', async () => {
    harness.getSession.mockImplementation(() => {
      throw new Error('Workspace is not open yet.');
    });

    await expect(switchVault('vault-a')).resolves.toBe(true);

    expect(harness.commitEditors).not.toHaveBeenCalled();
    expect(harness.select).toHaveBeenCalledWith('vault-a');
    expect(harness.events).toEqual(['select', 'reload']);
  });

  it('commits, flushes, selects, and reloads in order', async () => {
    const session = sessionWithFlush(async () => {
      harness.events.push('flush');
      return true;
    });
    harness.getSession.mockReturnValue(session);

    await expect(switchVault('vault-b')).resolves.toBe(true);

    expect(harness.events).toEqual(['commit', 'flush', 'select', 'reload']);
    expect(session.flush).toHaveBeenCalledOnce();
  });
});
