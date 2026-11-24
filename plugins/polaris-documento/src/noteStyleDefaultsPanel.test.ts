// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PluginNoteStyleBatchPreviewLease,
  PluginNoteStyleDefaultsPanelHost,
  PluginNoteStyleBatchPreviewMode,
  PluginNoteStyleBatchPreviewSummary,
  PluginNoteStylePanelHost,
} from '../../../src/app/plugins/registry';
import { mountNoteStyleDefaultsPanel } from './noteStyleDefaultsPanel';

const STYLE = {
  font: 'serif' as const,
  fontSize: 20,
  lineHeight: 1.8,
  blockSpacing: 10,
  width: 'wide' as const,
};

const LABELS = {
  title: 'Default for new pages',
  trigger: 'Page style',
  font: 'Font',
  fontSize: 'Text size',
  lineHeight: 'Line height',
  blockSpacing: 'Block spacing',
  width: 'Page width',
  previewWidth: 'Page width preview',
  previewHeading: 'Preview heading',
  previewBody: 'This is a preview of your text.',
  fonts: { serif: 'Serif', sans: 'Sans-serif', mono: 'Monospace' },
  widths: { comfortable: 'Comfortable', wide: 'Wide', full: 'Full' },
  save: 'Save default',
  restore: 'Restore profile default',
  cancel: 'Discard changes',
  saving: 'Saving…',
  saveFailed: 'Could not save.',
  saveConflict: 'The page changed.',
  saveBusy: 'A style change is being saved.',
};

const BATCH_LABELS = {
  title: 'Preview existing pages',
  help: 'Read-only preview; no pages are changed.',
  mode: 'Existing page styles',
  preserve: 'Preserve existing styles',
  overwrite: 'Overwrite representable styles',
  preview: 'Preview pages',
  cleared: 'Preview cleared.',
  stale: 'Preview is out of date.',
  unavailable: 'Preview is unavailable.',
  candidateCount: 'Eligible pages',
  titles: 'Sample titles',
  preservedCount: 'Existing styles preserved',
  noOpCount: 'Already match the default',
  protectedPageCount: 'Encrypted or host-protected pages',
  protectedFormatCount: 'Opaque style values kept protected',
  unsupportedSourceCount: 'Pages without a writable Markdown source',
  unsupportedContainerCount: 'Journal or Templates containers outside the style API',
  noCandidates: 'No pages match this preview.',
};

describe('Documento existing-page style preview panel', () => {
  let container: HTMLDivElement | null = null;
  let unmount: (() => void) | null = null;
  let expireCurrent: (() => void) | null = null;

  afterEach(() => {
    unmount?.();
    unmount = null;
    container?.remove();
    container = null;
    expireCurrent = null;
  });

  it('shows only a mode selector, read-only count, and at most four sample titles', () => {
    let active = true;
    const createdModes: PluginNoteStyleBatchPreviewMode[] = [];
    const summary: PluginNoteStyleBatchPreviewSummary = Object.freeze({
      mode: 'preserve',
      candidateCount: 5,
      titles: Object.freeze(['One', 'Two', 'Three', 'Four', 'Five']),
      preservedCount: 2,
      noOpCount: 0,
      protectedPageCount: 1,
      protectedFormatCount: 0,
      unsupportedSourceCount: 0,
      unsupportedContainerCount: 1,
    });
    const host: PluginNoteStyleDefaultsPanelHost = {
      initial: STYLE,
      labels: LABELS,
      batchPreviewLabels: BATCH_LABELS,
      batchPreview: {
        create(mode) {
          active = true;
          createdModes.push(mode);
          const listeners = new Set<() => void>();
          const lease: PluginNoteStyleBatchPreviewLease = {
            summary: { ...summary, mode },
            isCurrent: () => active,
            subscribe(listener) {
              listeners.add(listener);
              expireCurrent = () => {
                active = false;
                for (const notify of listeners) notify();
              };
              return () => listeners.delete(listener);
            },
          };
          return lease;
        },
        invalidate() {
          active = false;
        },
      },
      async save(style) {
        return { ok: true, style };
      },
      async restore() {
        return { ok: true, style: STYLE };
      },
      cancel() {},
    };

    container = document.createElement('div');
    document.body.append(container);
    const cleanup = mountNoteStyleDefaultsPanel(container, host);
    unmount = typeof cleanup === 'function' ? cleanup : null;

    const mode = container.querySelector<HTMLSelectElement>('[data-note-style-batch-mode]');
    const preview = container.querySelector<HTMLButtonElement>(
      '[data-note-style-batch-action="preview"]',
    );
    expect(mode?.getAttribute('aria-label')).toBe(BATCH_LABELS.mode);
    expect(Array.from(mode?.options ?? []).map((option) => option.value)).toEqual([
      'preserve',
      'overwrite',
    ]);
    expect(container.textContent).toContain(BATCH_LABELS.help);

    preview?.click();
    expect(createdModes).toEqual(['preserve']);
    expect(container.querySelector('.note-style-batch-count')?.textContent).toBe('Eligible pages: 5');
    expect(Array.from(container.querySelectorAll('.note-style-batch-titles li')).map((item) => item.textContent)).toEqual([
      'One',
      'Two',
      'Three',
      'Four',
    ]);
    expect(container.querySelector('[data-note-style-batch-action="apply"]')).toBeNull();
    expect(container.querySelector('[data-note-style-batch-action="undo"]')).toBeNull();

    if (!mode) throw new Error('The existing-style mode control did not mount.');
    mode.value = 'overwrite';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelector('.note-style-batch-count')).toBeNull();
    expect(container.querySelector('.note-style-batch-status')?.textContent).toBe(BATCH_LABELS.cleared);
    preview?.click();
    expect(createdModes).toEqual(['preserve', 'overwrite']);

    expireCurrent?.();
    expect(container.querySelector('.note-style-batch-count')).toBeNull();
    expect(container.querySelector('.note-style-batch-status')?.textContent).toBe(BATCH_LABELS.stale);
  });

  it('falls back to the existing #241 defaults panel when mounted by an older host', () => {
    const legacyHost: PluginNoteStylePanelHost = {
      initial: STYLE,
      labels: LABELS,
      async save(style) {
        return { ok: true, style };
      },
      async restore() {
        return { ok: true, style: STYLE };
      },
      cancel() {},
    };

    container = document.createElement('div');
    document.body.append(container);
    const cleanup = mountNoteStyleDefaultsPanel(
      container,
      legacyHost as unknown as PluginNoteStyleDefaultsPanelHost,
    );
    unmount = typeof cleanup === 'function' ? cleanup : null;

    expect(container.querySelector('[data-note-style-field="font"]')).not.toBeNull();
    expect(container.querySelector('[data-note-style-action="restore"]')).not.toBeNull();
    expect(container.querySelector('[data-note-style-batch-mode]')).toBeNull();
  });
});
