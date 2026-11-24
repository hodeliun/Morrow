import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteStyle } from '../../../src/core/noteStyle';
import type {
  PluginNoteStylePanelHost,
  PluginNoteStylePanelLabels,
  PluginNoteStylePanelResult,
} from '../../../src/app/plugins/registry';
import { en } from '../../../src/app/i18n/locales/en';
import { pt } from '../../../src/app/i18n/locales/pt';
import { mountNoteStylePanel } from './noteStylePanel';

const INITIAL_STYLE: NoteStyle = {
  font: 'sans',
  fontSize: 16,
  lineHeight: 1.68,
  blockSpacing: 9,
  width: 'comfortable',
};

const CHANGED_STYLE: NoteStyle = {
  font: 'serif',
  fontSize: 22.5,
  lineHeight: 2.12,
  blockSpacing: 18,
  width: 'wide',
};

const RESTORED_STYLE: NoteStyle = {
  font: 'mono',
  fontSize: 15,
  lineHeight: 1.5,
  blockSpacing: 6,
  width: 'full',
};

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

function labelsFor(locale: 'en' | 'pt'): PluginNoteStylePanelLabels {
  return locale === 'en' ? en.pageStyle : pt.pageStyle;
}

function panelHost(
  locale: 'en' | 'pt' = 'en',
  overrides: Partial<PluginNoteStylePanelHost> = {},
): PluginNoteStylePanelHost {
  const labels = labelsFor(locale);
  return {
    initial: { ...INITIAL_STYLE },
    labels,
    save: vi.fn(async (style: NoteStyle) => ({ ok: true as const, style: { ...style } })),
    restore: vi.fn(async () => ({ ok: true as const, style: { ...INITIAL_STYLE } })),
    cancel: vi.fn(),
    ...overrides,
  };
}

function mount(window: Window, host: PluginNoteStylePanelHost) {
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const unmount = mountNoteStylePanel(container as unknown as HTMLElement, host);
  const cleanup = typeof unmount === 'function' ? unmount : () => {};
  return { container, cleanup };
}

function input(window: Window, element: HTMLInputElement | HTMLSelectElement, value: string): void {
  element.value = value;
  const eventName = element.tagName === 'SELECT' ? 'change' : 'input';
  element.dispatchEvent(new window.Event(eventName, { bubbles: true }) as unknown as Event);
}

function submit(window: Window, form: HTMLFormElement): void {
  form.dispatchEvent(
    new window.Event('submit', { bubbles: true, cancelable: true }) as unknown as Event,
  );
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('Polaris Documento per-note style panel', () => {
  it('mounts the five bounded controls and updates only the local sample', () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const host = panelHost('en');
    const { container, cleanup } = mount(window, host);
    const labels = host.labels;

    const font = container.querySelector(`select[aria-label="${labels.font}"]`) as unknown as HTMLSelectElement;
    const width = container.querySelector(`select[aria-label="${labels.width}"]`) as unknown as HTMLSelectElement;
    const fontSize = container.querySelector(
      `input[aria-label="${labels.fontSize}"]`,
    ) as unknown as HTMLInputElement;
    const lineHeight = container.querySelector(
      `input[aria-label="${labels.lineHeight}"]`,
    ) as unknown as HTMLInputElement;
    const blockSpacing = container.querySelector(
      `input[aria-label="${labels.blockSpacing}"]`,
    ) as unknown as HTMLInputElement;
    const preview = container.querySelector('.note-style-preview') as unknown as HTMLElement;

    expect([...font.options].map((option) => option.value)).toEqual(['sans', 'serif', 'mono']);
    expect([...width.options].map((option) => option.value)).toEqual(['comfortable', 'wide', 'full']);
    expect([fontSize.min, fontSize.max, fontSize.step]).toEqual(['12', '32', '0.5']);
    expect([lineHeight.min, lineHeight.max, lineHeight.step]).toEqual(['1.2', '2.4', '0.01']);
    expect([blockSpacing.min, blockSpacing.max, blockSpacing.step]).toEqual(['0', '40', '1']);
    expect(preview.style.width).toBe('68%');

    input(window, font, 'serif');
    input(window, fontSize, '22.5');
    input(window, lineHeight, '2.12');
    input(window, blockSpacing, '18');
    input(window, width, 'wide');

    expect(preview.className).toContain('font-serif');
    expect(preview.style.width).toBe('84%');
    expect(preview.style.getPropertyValue('--note-font-size')).toBe('22.5px');
    expect(preview.style.getPropertyValue('--note-line-height')).toBe('2.12');
    expect(preview.style.getPropertyValue('--note-block-spacing')).toBe('18px');
    expect(container.querySelector('output')?.textContent).toBe('22.5 px');
    expect(host.save).not.toHaveBeenCalled();
    expect(host.restore).not.toHaveBeenCalled();

    input(window, width, 'full');
    expect(preview.style.width).toBe('100%');
    cleanup();
  });

  it('uses the host sample text and field labels in English and Portuguese', () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const english = panelHost('en');
    const portuguese = panelHost('pt');
    const englishPanel = mount(window, english);
    const portuguesePanel = mount(window, portuguese);

    expect(englishPanel.container.querySelector('.note-style-preview-label')?.textContent).toBe(
      'Page width preview',
    );
    expect(englishPanel.container.querySelector('.note-style-preview strong')?.textContent).toBe(
      'Preview heading',
    );
    expect(englishPanel.container.querySelector('.note-style-preview span')?.textContent).toBe(
      'This is a preview of your text.',
    );
    expect(portuguesePanel.container.querySelector('.note-style-preview-label')?.textContent).toBe(
      'Prévia da largura da página',
    );
    expect(portuguesePanel.container.querySelector('.note-style-preview strong')?.textContent).toBe(
      'Prévia do título',
    );
    expect(portuguesePanel.container.querySelector('.note-style-preview span')?.textContent).toBe(
      'Esta é uma prévia do texto.',
    );
    expect(portuguesePanel.container.querySelector(`select[aria-label="${portuguese.labels.font}"]`))
      .not.toBeNull();

    englishPanel.cleanup();
    portuguesePanel.cleanup();
  });

  it('saves a copy of the current draft only when submitted', async () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const host = panelHost('en');
    const { container, cleanup } = mount(window, host);
    const font = container.querySelector('select[data-note-style-field="font"]') as unknown as HTMLSelectElement;
    const fontSize = container.querySelector(
      'input[data-note-style-field="fontSize"]',
    ) as unknown as HTMLInputElement;
    const lineHeight = container.querySelector(
      'input[data-note-style-field="lineHeight"]',
    ) as unknown as HTMLInputElement;
    const blockSpacing = container.querySelector(
      'input[data-note-style-field="blockSpacing"]',
    ) as unknown as HTMLInputElement;
    const width = container.querySelector('select[data-note-style-field="width"]') as unknown as HTMLSelectElement;
    const form = container.querySelector('form') as unknown as HTMLFormElement;

    input(window, font, CHANGED_STYLE.font);
    input(window, fontSize, String(CHANGED_STYLE.fontSize));
    input(window, lineHeight, String(CHANGED_STYLE.lineHeight));
    input(window, blockSpacing, String(CHANGED_STYLE.blockSpacing));
    input(window, width, CHANGED_STYLE.width);

    expect(host.save).not.toHaveBeenCalled();
    submit(window, form);
    await settle();

    expect(host.save).toHaveBeenCalledOnce();
    expect(host.save).toHaveBeenCalledWith(CHANGED_STYLE);
    expect(host.initial).toEqual(INITIAL_STYLE);
    cleanup();
  });

  it('keeps the draft after save conflict and restore failure', async () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const labels = labelsFor('en');
    const host = panelHost('en', {
      save: vi.fn(async () => ({
        ok: false as const,
        code: 'save-conflict' as const,
        message: labels.saveConflict,
      })),
      restore: vi.fn(async () => ({
        ok: false as const,
        code: 'save-failed' as const,
        message: labels.saveFailed,
      })),
    });
    const { container, cleanup } = mount(window, host);
    const fontSize = container.querySelector(
      'input[data-note-style-field="fontSize"]',
    ) as unknown as HTMLInputElement;
    const form = container.querySelector('form') as unknown as HTMLFormElement;
    input(window, fontSize, '24.5');

    submit(window, form);
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(labels.saveConflict);
    expect(fontSize.value).toBe('24.5');
    expect(container.querySelector('.note-style-preview')?.getAttribute('style')).toContain(
      '--note-font-size: 24.5px',
    );

    const restore = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === labels.restore,
    )!;
    restore.click();
    await settle();
    expect(host.restore).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(labels.saveFailed);
    expect(fontSize.value).toBe('24.5');
    expect(host.cancel).not.toHaveBeenCalled();
    cleanup();
  });

  it('blocks duplicate submissions and ignores a result after unmount', async () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    let resolveSave!: (result: PluginNoteStylePanelResult) => void;
    const host = panelHost('en', {
      save: vi.fn(
        (_style: NoteStyle) =>
          new Promise<PluginNoteStylePanelResult>((resolve) => {
            resolveSave = resolve;
          }),
      ),
    });
    const { container, cleanup } = mount(window, host);
    const form = container.querySelector('form') as unknown as HTMLFormElement;
    const save = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === host.labels.save,
    )!;

    save.focus();
    submit(window, form);
    submit(window, form);
    expect(host.save).toHaveBeenCalledOnce();
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(save.disabled).toBe(false);
    expect(window.document.activeElement).toBe(save);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(host.labels.saveBusy);

    const font = container.querySelector(
      'select[data-note-style-field="font"]',
    ) as unknown as HTMLSelectElement;
    input(window, font, 'mono');
    expect(font.value).toBe(INITIAL_STYLE.font);

    cleanup();
    resolveSave({
      ok: false,
      code: 'save-conflict',
      message: host.labels.saveConflict,
    });
    await settle();

    expect(container.childElementCount).toBe(0);
    expect(host.save).toHaveBeenCalledOnce();
  });

  it('restores through the host, cancels without writing, and discards drafts on remount', async () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const firstHost = panelHost('en');
    const first = mount(window, firstHost);
    const fontSize = first.container.querySelector(
      'input[data-note-style-field="fontSize"]',
    ) as unknown as HTMLInputElement;
    input(window, fontSize, '25');

    const restore = [...first.container.querySelectorAll('button')].find(
      (button) => button.textContent === firstHost.labels.restore,
    )!;
    restore.click();
    await settle();
    expect(firstHost.restore).toHaveBeenCalledOnce();
    expect(firstHost.save).not.toHaveBeenCalled();

    const cancel = [...first.container.querySelectorAll('button')].find(
      (button) => button.textContent === firstHost.labels.cancel,
    )!;
    cancel.click();
    expect(firstHost.cancel).toHaveBeenCalledOnce();
    expect(firstHost.save).not.toHaveBeenCalled();
    first.cleanup();

    const reopened = mount(window, panelHost('en'));
    expect(
      (reopened.container.querySelector('input[data-note-style-field="fontSize"]') as unknown as HTMLInputElement)
        .value,
    ).toBe(String(INITIAL_STYLE.fontSize));
    reopened.cleanup();
  });

  it('discards to the latest successful save or restore within the same mount', async () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const host = panelHost('en', {
      restore: vi.fn(async () => ({ ok: true as const, style: { ...RESTORED_STYLE } })),
    });
    const { container, cleanup } = mount(window, host);
    const font = container.querySelector('select[data-note-style-field="font"]') as unknown as HTMLSelectElement;
    const form = container.querySelector('form') as unknown as HTMLFormElement;
    const action = (name: string) =>
      container.querySelector(`button[data-note-style-action="${name}"]`) as unknown as HTMLButtonElement;

    input(window, font, CHANGED_STYLE.font);
    submit(window, form);
    await settle();
    expect(font.value).toBe(CHANGED_STYLE.font);

    input(window, font, 'mono');
    action('cancel').click();
    expect(font.value).toBe(CHANGED_STYLE.font);

    action('restore').click();
    await settle();
    expect(font.value).toBe(RESTORED_STYLE.font);
    input(window, font, 'sans');
    action('cancel').click();
    expect(font.value).toBe(RESTORED_STYLE.font);

    expect(host.save).toHaveBeenCalledOnce();
    expect(host.restore).toHaveBeenCalledOnce();
    cleanup();
  });

  it('keeps two mounts isolated from each other', () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const first = mount(window, panelHost('en'));
    const second = mount(window, panelHost('pt'));
    const firstFont = first.container.querySelector(
      'select[data-note-style-field="font"]',
    ) as unknown as HTMLSelectElement;
    const secondFont = second.container.querySelector(
      'select[data-note-style-field="font"]',
    ) as unknown as HTMLSelectElement;
    input(window, firstFont, 'mono');

    expect(secondFont.value).toBe('sans');
    expect(first.container.querySelector('.note-style-preview')?.className).toContain('font-mono');
    expect(second.container.querySelector('.note-style-preview')?.className).toContain('font-sans');
    first.cleanup();
    expect(second.container.querySelector('.note-style-preview')).not.toBeNull();
    second.cleanup();
  });
});
