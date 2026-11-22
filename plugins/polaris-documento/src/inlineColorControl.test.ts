import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginInlineColorControlHost } from '../../../src/app/plugins/registry';
import { mountInlineColorControl } from './inlineColorControl';

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

function controlHost(overrides: Partial<PluginInlineColorControlHost> = {}) {
  return {
    color: '#787774',
    label: 'Custom text colour',
    inputLabel: 'HEX colour for text',
    invalidMessage: 'Enter a valid six-digit HEX colour.',
    disabled: false,
    apply: vi.fn(() => true),
    finish: vi.fn(),
    ...overrides,
  } satisfies PluginInlineColorControlHost;
}

describe('Documento inline color input', () => {
  it('accepts only six-digit HEX and normalizes it before applying and returning focus', () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const container = window.document.createElement('div');
    const host = controlHost();
    const unmount = mountInlineColorControl(container as unknown as HTMLElement, host);
    const input = container.querySelector('.color-hex-input') as unknown as HTMLInputElement;

    expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(host.label);
    expect(input.getAttribute('aria-label')).toBe(host.inputLabel);
    expect(input.disabled).toBe(false);

    input.value = '#12345g';
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(host.apply).not.toHaveBeenCalled();
    expect(host.finish).not.toHaveBeenCalled();

    input.value = '#A1B2C3';
    input.dispatchEvent(new window.Event('input', { bubbles: true }) as unknown as Event);
    expect(host.apply).toHaveBeenCalledWith('#a1b2c3');
    expect(host.finish).toHaveBeenCalledOnce();
    expect(input.getAttribute('aria-invalid')).toBe('false');

    unmount();
    expect(container.querySelector('.color-custom-control')).toBeNull();
  });

  it('uses the native picker, and disables input when the selected editor is readonly', () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const container = window.document.createElement('div');
    const host = controlHost({ disabled: true });
    mountInlineColorControl(container as unknown as HTMLElement, host);
    const picker = container.querySelector('input[type="color"]') as unknown as HTMLInputElement;
    const input = container.querySelector('.color-hex-input') as unknown as HTMLInputElement;
    expect(picker.disabled).toBe(true);
    expect(input.disabled).toBe(true);

    picker.value = '#abcdef';
    picker.dispatchEvent(new window.Event('change', { bubbles: true }) as unknown as Event);
    expect(host.apply).not.toHaveBeenCalled();
    expect(host.finish).not.toHaveBeenCalled();
  });
});
