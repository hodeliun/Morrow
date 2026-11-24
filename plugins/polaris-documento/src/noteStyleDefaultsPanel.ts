import type {
  PluginNoteStyleBatchPreviewLease,
  PluginNoteStyleBatchPreviewMode,
  PluginNoteStyleDefaultsPanelMount,
} from '../../../src/app/plugins/registry';
import { mountNoteStylePanel } from './noteStylePanel';

const MODES: readonly PluginNoteStyleBatchPreviewMode[] = ['preserve', 'overwrite'];

/** Reuses the #241 default-style controls and adds a read-only existing-pages preview. */
export const mountNoteStyleDefaultsPanel: PluginNoteStyleDefaultsPanelMount = (container, host) => {
  // A newer plugin can be loaded by a host whose #241 defaults API predates batch preview.
  // Keep the original controls available there; older plugins are already compatible with newer
  // hosts because their mount only consumes the shared base panel contract.
  if (
    !host.batchPreview ||
    typeof host.batchPreview.create !== 'function' ||
    typeof host.batchPreview.invalidate !== 'function' ||
    !host.batchPreviewLabels
  )
    return mountNoteStylePanel(container, host);

  const document = container.ownerDocument;
  const defaultsRoot = document.createElement('div');
  container.append(defaultsRoot);
  const unmountDefaults = mountNoteStylePanel(defaultsRoot, host);

  const root = document.createElement('section');
  root.className = 'note-style-batch-preview';
  const heading = document.createElement('h4');
  heading.textContent = host.batchPreviewLabels.title;
  const help = document.createElement('p');
  help.textContent = host.batchPreviewLabels.help;

  const modeField = document.createElement('label');
  modeField.className = 'note-style-batch-mode';
  const modeLabel = document.createElement('span');
  modeLabel.textContent = host.batchPreviewLabels.mode;
  const mode = document.createElement('select');
  mode.className = 'text-input small';
  mode.dataset.noteStyleBatchMode = 'true';
  mode.setAttribute('aria-label', host.batchPreviewLabels.mode);
  for (const value of MODES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value === 'preserve'
      ? host.batchPreviewLabels.preserve
      : host.batchPreviewLabels.overwrite;
    mode.append(option);
  }
  modeField.append(modeLabel, mode);

  const previewButton = document.createElement('button');
  previewButton.type = 'button';
  previewButton.className = 'button small';
  previewButton.dataset.noteStyleBatchAction = 'preview';
  previewButton.textContent = host.batchPreviewLabels.preview;

  const status = document.createElement('p');
  status.className = 'note-style-batch-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const result = document.createElement('div');
  result.className = 'note-style-batch-result';

  root.append(heading, help, modeField, previewButton, status, result);
  container.append(root);

  let active = true;
  let lease: PluginNoteStyleBatchPreviewLease | null = null;
  let stopLease: (() => void) | null = null;
  let notice = '';

  const detachLease = () => {
    stopLease?.();
    stopLease = null;
    lease = null;
  };

  const clearResult = (message: string) => {
    result.replaceChildren();
    status.textContent = message;
  };

  const render = (preview: PluginNoteStyleBatchPreviewLease) => {
    result.replaceChildren();
    status.textContent = '';

    const count = document.createElement('p');
    count.className = 'note-style-batch-count';
    count.textContent = `${host.batchPreviewLabels.candidateCount}: ${preview.summary.candidateCount}`;
    result.append(count);

    if (preview.summary.candidateCount === 0) {
      const none = document.createElement('p');
      none.className = 'note-style-batch-empty';
      none.textContent = host.batchPreviewLabels.noCandidates;
      result.append(none);
    } else {
      const sampleTitle = document.createElement('p');
      sampleTitle.className = 'note-style-batch-sample-title';
      sampleTitle.textContent = host.batchPreviewLabels.titles;
      const titles = document.createElement('ul');
      titles.className = 'note-style-batch-titles';
      for (const title of preview.summary.titles.slice(0, 4)) {
        const item = document.createElement('li');
        item.textContent = title;
        titles.append(item);
      }
      result.append(sampleTitle, titles);
    }

    const diagnosticRows: Array<[string, number]> = [
      [host.batchPreviewLabels.preservedCount, preview.summary.preservedCount],
      [host.batchPreviewLabels.noOpCount, preview.summary.noOpCount],
      [host.batchPreviewLabels.protectedPageCount, preview.summary.protectedPageCount],
      [host.batchPreviewLabels.protectedFormatCount, preview.summary.protectedFormatCount],
      [host.batchPreviewLabels.unsupportedSourceCount, preview.summary.unsupportedSourceCount],
      [host.batchPreviewLabels.unsupportedContainerCount, preview.summary.unsupportedContainerCount],
    ];
    const visibleRows = diagnosticRows.filter(([, value]) => value > 0);
    if (visibleRows.length > 0) {
      const diagnostics = document.createElement('ul');
      diagnostics.className = 'note-style-batch-diagnostics';
      for (const [label, value] of visibleRows) {
        const item = document.createElement('li');
        item.textContent = `${label}: ${value}`;
        diagnostics.append(item);
      }
      result.append(diagnostics);
    }
  };

  const expirePreview = () => {
    if (!lease) return;
    const current = lease;
    detachLease();
    host.batchPreview.invalidate();
    if (active && !current.isCurrent()) clearResult(host.batchPreviewLabels.stale);
  };

  const showPreview = () => {
    detachLease();
    notice = '';
    const next = host.batchPreview.create(mode.value as PluginNoteStyleBatchPreviewMode);
    if (!next) {
      clearResult(host.batchPreviewLabels.unavailable);
      return;
    }
    lease = next;
    render(next);
    stopLease = next.subscribe(() => {
      if (lease === next && !next.isCurrent()) expirePreview();
    });
    if (!next.isCurrent()) expirePreview();
  };

  const onChange = () => {
    if (!active) return;
    if (lease) {
      detachLease();
      host.batchPreview.invalidate();
      notice = host.batchPreviewLabels.cleared;
      clearResult(notice);
    }
  };
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>('button[data-note-style-batch-action="preview"]');
    if (!button || !root.contains(button)) return;
    showPreview();
  };

  mode.addEventListener('change', onChange);
  root.addEventListener('click', onClick);

  return () => {
    if (!active) return;
    active = false;
    mode.removeEventListener('change', onChange);
    root.removeEventListener('click', onClick);
    detachLease();
    host.batchPreview.invalidate();
    unmountDefaults?.();
    defaultsRoot.remove();
    root.remove();
  };
};
