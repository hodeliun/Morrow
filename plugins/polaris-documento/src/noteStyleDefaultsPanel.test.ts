// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PluginNoteStyleBatchPreviewLease,
  PluginNoteStyleBatchConfirmationResult,
  PluginNoteStyleBatchPreviewConfirmationLabels,
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

const CONFIRMATION_LABELS: PluginNoteStyleBatchPreviewConfirmationLabels = {
  beginApply: 'Apply to existing pages',
  confirmPreserve: 'Apply the default style to {count} eligible pages while preserving existing styles?',
  confirmOverwrite: 'Overwrite representable saved styles on {count} eligible pages with the default style?',
  confirm: 'Apply styles',
  cancel: 'Cancel',
  applying: 'Applying styles…',
  applyFailed: 'The operation ended unexpectedly.',
  resultTitle: 'Style update results',
  confirmedCount: 'Confirmed',
  refusedCount: 'Refused',
  unattemptedCount: 'Not attempted',
  noteConfirmed: 'Applied',
  noteRefused: 'Refused',
  noteUnattempted: 'Not attempted',
  complete: 'Style update completed.',
  partial: 'Some pages were not updated.',
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
    expect(container.querySelector('[data-note-style-batch-action="begin-apply"]')).toBeNull();

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
    preview?.click();
    expect(createdModes).toEqual(['preserve', 'overwrite', 'overwrite']);
    expect(container.querySelector('.note-style-batch-count')?.textContent).toBe('Eligible pages: 5');
  });

  it('confirms inline, reports ordered outcomes, and keeps focus outside the panel', async () => {
    let active = true;
    let invalidateCalls = 0;
    let confirmCalls = 0;
    let confirmedLease: PluginNoteStyleBatchPreviewLease | null = null;
    let createdLease: PluginNoteStyleBatchPreviewLease | null = null;
    let resolveConfirmation!: (value: PluginNoteStyleBatchConfirmationResult) => void;
    const pendingConfirmation = new Promise<PluginNoteStyleBatchConfirmationResult>((resolve) => {
      resolveConfirmation = resolve;
    });
    const summary: PluginNoteStyleBatchPreviewSummary = Object.freeze({
      mode: 'preserve',
      candidateCount: 3,
      titles: Object.freeze(['One', 'Two', 'Three']),
      preservedCount: 0,
      noOpCount: 0,
      protectedPageCount: 0,
      protectedFormatCount: 0,
      unsupportedSourceCount: 0,
      unsupportedContainerCount: 0,
    });
    const listeners = new Set<() => void>();
    const lease: PluginNoteStyleBatchPreviewLease = {
      summary,
      isCurrent: () => active,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const host: PluginNoteStyleDefaultsPanelHost = {
      initial: STYLE,
      labels: LABELS,
      batchPreviewLabels: BATCH_LABELS,
      batchPreviewConfirmation: {
        labels: CONFIRMATION_LABELS,
        confirm(candidate) {
          confirmCalls++;
          confirmedLease = candidate;
          // Consuming the lease notifies the host path, while the panel has already detached.
          active = false;
          for (const notify of [...listeners]) notify();
          return pendingConfirmation;
        },
      },
      batchPreview: {
        create(mode) {
          active = true;
          createdLease = { ...lease, summary: { ...summary, mode } };
          return createdLease;
        },
        invalidate() {
          invalidateCalls++;
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

    const preview = container.querySelector<HTMLButtonElement>('[data-note-style-batch-action="preview"]');
    preview?.click();
    expect(container.querySelector('[data-note-style-batch-action="begin-apply"]')?.textContent).toBe(
      CONFIRMATION_LABELS.beginApply,
    );

    const beginApply = container.querySelector<HTMLButtonElement>(
      '[data-note-style-batch-action="begin-apply"]',
    );
    beginApply?.click();
    expect(container.querySelector('[data-note-style-batch-confirmation]')).not.toBeNull();
    expect(container.querySelector('.note-style-batch-confirmation-prompt')?.textContent).toBe(
      'Apply the default style to 3 eligible pages while preserving existing styles?',
    );
    expect(container.querySelector('[data-note-style-batch-action="confirm"]')?.textContent).toBe(
      CONFIRMATION_LABELS.confirm,
    );

    container.querySelector<HTMLButtonElement>(
      '[data-note-style-batch-action="cancel-confirmation"]',
    )?.click();
    expect(container.querySelector('[data-note-style-batch-confirmation]')).toBeNull();
    expect(container.querySelector('.note-style-batch-count')).not.toBeNull();
    expect(invalidateCalls).toBe(0);

    container.querySelector<HTMLButtonElement>(
      '[data-note-style-batch-action="begin-apply"]',
    )?.click();
    const confirm = container.querySelector<HTMLButtonElement>('[data-note-style-batch-action="confirm"]');
    confirm?.click();
    expect(confirmCalls).toBe(1);
    expect(confirmedLease).toBe(createdLease);
    expect(container.querySelector('.note-style-batch-preview')?.getAttribute('data-busy')).toBe('true');
    expect(container.querySelector<HTMLButtonElement>('[data-note-style-batch-action="preview"]')?.disabled).toBe(
      true,
    );
    expect(invalidateCalls).toBe(0);
    confirm?.click();
    expect(confirmCalls).toBe(1);

    const externalFocus = document.createElement('button');
    document.body.append(externalFocus);
    externalFocus.focus();
    const outcome: PluginNoteStyleBatchConfirmationResult = {
      mode: 'preserve',
      confirmedCount: 1,
      refusedCount: 1,
      unattemptedCount: 1,
      outcomes: [
        { title: 'One', order: 1, status: 'confirmed' },
        { title: 'Two', order: 2, status: 'refused' },
        { title: 'Three', order: 3, status: 'unattempted' },
      ],
    };
    resolveConfirmation(outcome);
    await pendingConfirmation;
    await Promise.resolve();

    expect(document.activeElement).toBe(externalFocus);
    expect(container.querySelector('.note-style-batch-status')?.textContent).toBe(
      CONFIRMATION_LABELS.partial,
    );
    expect(container.querySelector('[data-note-style-batch-result-count="confirmed"]')?.textContent).toBe(
      'Confirmed: 1',
    );
    expect(container.querySelector('[data-note-style-batch-result-count="refused"]')?.textContent).toBe(
      'Refused: 1',
    );
    expect(container.querySelector('[data-note-style-batch-result-count="unattempted"]')?.textContent).toBe(
      'Not attempted: 1',
    );
    expect(Array.from(container.querySelectorAll('[data-note-style-batch-outcome]')).map((item) => item.textContent)).toEqual([
      'One: Applied',
      'Two: Refused',
      'Three: Not attempted',
    ]);
    expect(container.querySelector('[data-note-style-batch-outcome="refused"]')?.getAttribute('data-note-style-batch-order')).toBe(
      '2',
    );

    const mode = container.querySelector<HTMLSelectElement>('[data-note-style-batch-mode]');
    if (!mode) throw new Error('The batch mode selector did not remain mounted.');
    mode.value = 'overwrite';
    mode.dispatchEvent(new Event('change', { bubbles: true }));
    expect(container.querySelector('.note-style-batch-result-counts')).not.toBeNull();
    preview?.click();
    expect(container.querySelector('.note-style-batch-result-counts')).toBeNull();
    externalFocus.remove();
  });

  it('ignores a confirmation result after the panel unmounts', async () => {
    let resolveConfirmation!: (value: PluginNoteStyleBatchConfirmationResult) => void;
    const pendingConfirmation = new Promise<PluginNoteStyleBatchConfirmationResult>((resolve) => {
      resolveConfirmation = resolve;
    });
    const summary: PluginNoteStyleBatchPreviewSummary = Object.freeze({
      mode: 'overwrite',
      candidateCount: 1,
      titles: Object.freeze(['One']),
      preservedCount: 0,
      noOpCount: 0,
      protectedPageCount: 0,
      protectedFormatCount: 0,
      unsupportedSourceCount: 0,
      unsupportedContainerCount: 0,
    });
    let active = true;
    const host: PluginNoteStyleDefaultsPanelHost = {
      initial: STYLE,
      labels: LABELS,
      batchPreviewLabels: BATCH_LABELS,
      batchPreviewConfirmation: {
        labels: CONFIRMATION_LABELS,
        confirm: () => pendingConfirmation,
      },
      batchPreview: {
        create(mode) {
          active = true;
          return {
            summary: { ...summary, mode },
            isCurrent: () => active,
            subscribe: () => () => {},
          };
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
    previewAndConfirm(container);
    expect(container.querySelector('.note-style-batch-preview')?.getAttribute('data-busy')).toBe('true');
    cleanup?.();
    unmount = null;
    const detachedContainer = container;
    resolveConfirmation({
      mode: 'overwrite',
      confirmedCount: 1,
      refusedCount: 0,
      unattemptedCount: 0,
      outcomes: [{ title: 'One', order: 1, status: 'confirmed' }],
    });
    await pendingConfirmation;
    await Promise.resolve();
    expect(detachedContainer.textContent).toBe('');
  });

  it('shows a stale message and allows a fresh preview when the host rejects the lease', async () => {
    let active = true;
    let createCalls = 0;
    let confirmCalls = 0;
    const summary: PluginNoteStyleBatchPreviewSummary = Object.freeze({
      mode: 'overwrite',
      candidateCount: 1,
      titles: Object.freeze(['One']),
      preservedCount: 0,
      noOpCount: 0,
      protectedPageCount: 0,
      protectedFormatCount: 0,
      unsupportedSourceCount: 0,
      unsupportedContainerCount: 0,
    });
    const host: PluginNoteStyleDefaultsPanelHost = {
      initial: STYLE,
      labels: LABELS,
      batchPreviewLabels: BATCH_LABELS,
      batchPreviewConfirmation: {
        labels: CONFIRMATION_LABELS,
        async confirm() {
          confirmCalls++;
          active = false;
          return null;
        },
      },
      batchPreview: {
        create(mode) {
          active = true;
          createCalls++;
          return {
            summary: { ...summary, mode },
            isCurrent: () => active,
            subscribe: () => () => {},
          };
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
    previewAndConfirm(container);

    await Promise.resolve();
    expect(confirmCalls).toBe(1);
    expect(container.querySelector('.note-style-batch-status')?.textContent).toBe(BATCH_LABELS.stale);
    expect(container.querySelector('[data-note-style-batch-action="preview"]')).not.toBeNull();
    expect(container.querySelector('[data-note-style-batch-result-count]')).toBeNull();

    container.querySelector<HTMLButtonElement>('[data-note-style-batch-action="preview"]')?.click();
    expect(createCalls).toBe(2);
    expect(container.querySelector('.note-style-batch-count')).not.toBeNull();
  });

  it('expires the preview visually without invalidating the host and returns focus to Preview', () => {
    let active = true;
    let invalidateCalls = 0;
    const listeners = new Set<() => void>();
    const summary: PluginNoteStyleBatchPreviewSummary = Object.freeze({
      mode: 'preserve',
      candidateCount: 1,
      titles: Object.freeze(['One']),
      preservedCount: 0,
      noOpCount: 0,
      protectedPageCount: 0,
      protectedFormatCount: 0,
      unsupportedSourceCount: 0,
      unsupportedContainerCount: 0,
    });
    const host: PluginNoteStyleDefaultsPanelHost = {
      initial: STYLE,
      labels: LABELS,
      batchPreviewLabels: BATCH_LABELS,
      batchPreviewConfirmation: {
        labels: CONFIRMATION_LABELS,
        confirm: async () => null,
      },
      batchPreview: {
        create(mode) {
          active = true;
          return {
            summary: { ...summary, mode },
            isCurrent: () => active,
            subscribe(listener) {
              listeners.add(listener);
              expireCurrent = () => {
                active = false;
                for (const notify of [...listeners]) notify();
              };
              return () => listeners.delete(listener);
            },
          };
        },
        invalidate() {
          invalidateCalls++;
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
    container.querySelector<HTMLButtonElement>('[data-note-style-batch-action="preview"]')?.click();
    const beginApply = container.querySelector<HTMLButtonElement>(
      '[data-note-style-batch-action="begin-apply"]',
    );
    beginApply?.focus();
    beginApply?.click();
    expect(document.activeElement).toBe(
      container.querySelector('[data-note-style-batch-action="cancel-confirmation"]'),
    );

    expireCurrent?.();
    expect(container.querySelector('.note-style-batch-status')?.textContent).toBe(BATCH_LABELS.stale);
    expect(invalidateCalls).toBe(0);
    expect(document.activeElement).toBe(
      container.querySelector('[data-note-style-batch-action="preview"]'),
    );
  });

  function previewAndConfirm(target: HTMLDivElement): void {
    target.querySelector<HTMLButtonElement>('[data-note-style-batch-action="preview"]')?.click();
    target.querySelector<HTMLButtonElement>('[data-note-style-batch-action="begin-apply"]')?.click();
    target.querySelector<HTMLButtonElement>('[data-note-style-batch-action="confirm"]')?.click();
  }

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
