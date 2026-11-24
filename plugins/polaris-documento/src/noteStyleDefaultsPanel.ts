import type {
  PluginNoteStyleBatchConfirmationOutcome,
  PluginNoteStyleBatchConfirmationStatus,
  PluginNoteStyleBatchPreviewLease,
  PluginNoteStyleBatchPreviewMode,
  PluginNoteStyleBatchPreviewSummary,
  PluginNoteStyleDefaultsPanelMount,
} from '../../../src/app/plugins/registry';
import { mountNoteStylePanel } from './noteStylePanel';

const MODES: readonly PluginNoteStyleBatchPreviewMode[] = ['preserve', 'overwrite'];

/** Reuses the #241 default-style controls and adds a read-only preview with optional confirmation. */
const mountNoteStyleDefaultsPanelImpl: PluginNoteStyleDefaultsPanelMount = (container, host) => {
  // A newer plugin can be loaded by a #241 host whose defaults contract predates batch preview.
  // A #307 host still gets preview-only behavior because its confirmation port is optional.
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
  status.tabIndex = -1;
  const result = document.createElement('div');
  result.className = 'note-style-batch-result';

  root.append(heading, help, modeField, previewButton, status, result);
  container.append(root);

  let active = true;
  let lease: PluginNoteStyleBatchPreviewLease | null = null;
  let stopLease: (() => void) | null = null;
  let confirmationOpen = false;
  let busy = false;
  let confirmationRun = 0;

  const confirmation = host.batchPreviewConfirmation;

  const syncControls = () => {
    mode.disabled = busy || confirmationOpen;
    previewButton.disabled = busy || confirmationOpen;
    root.dataset.busy = String(busy);
  };

  const detachLease = () => {
    stopLease?.();
    stopLease = null;
    lease = null;
  };

  const clearResult = (message: string) => {
    result.replaceChildren();
    status.textContent = message;
  };

  const appendPreviewSummary = (preview: PluginNoteStyleBatchPreviewSummary) => {
    result.dataset.noteStyleBatchMode = preview.mode;
    result.dataset.noteStyleBatchCandidateCount = String(preview.candidateCount);

    const count = document.createElement('p');
    count.className = 'note-style-batch-count';
    count.textContent = `${host.batchPreviewLabels.candidateCount}: ${preview.candidateCount}`;
    result.append(count);

    if (preview.candidateCount === 0) {
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
      for (const title of preview.titles.slice(0, 4)) {
        const item = document.createElement('li');
        item.textContent = title;
        titles.append(item);
      }
      result.append(sampleTitle, titles);
    }

    const diagnosticRows: Array<[string, number]> = [
      [host.batchPreviewLabels.preservedCount, preview.preservedCount],
      [host.batchPreviewLabels.noOpCount, preview.noOpCount],
      [host.batchPreviewLabels.protectedPageCount, preview.protectedPageCount],
      [host.batchPreviewLabels.protectedFormatCount, preview.protectedFormatCount],
      [host.batchPreviewLabels.unsupportedSourceCount, preview.unsupportedSourceCount],
      [host.batchPreviewLabels.unsupportedContainerCount, preview.unsupportedContainerCount],
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

  const outcomeLabel = (outcome: PluginNoteStyleBatchConfirmationOutcome): string => {
    const labels = confirmation?.labels;
    if (!labels) return outcome.status;
    const statusLabels: Record<PluginNoteStyleBatchConfirmationStatus, string> = {
      confirmed: labels.noteConfirmed,
      refused: labels.noteRefused,
      unattempted: labels.noteUnattempted,
    };
    return statusLabels[outcome.status];
  };

  const render = (preview: PluginNoteStyleBatchPreviewLease, showConfirmation = false) => {
    result.replaceChildren();
    status.textContent = '';
    appendPreviewSummary(preview.summary);

    if (confirmation && preview.summary.candidateCount > 0 && !showConfirmation) {
      const beginApply = document.createElement('button');
      beginApply.type = 'button';
      beginApply.className = 'button small';
      beginApply.dataset.noteStyleBatchAction = 'begin-apply';
      beginApply.textContent = confirmation.labels.beginApply;
      result.append(beginApply);
    }

    if (confirmation && preview.summary.candidateCount > 0 && showConfirmation) {
      const panel = document.createElement('div');
      panel.className = 'note-style-batch-confirmation';
      panel.dataset.noteStyleBatchConfirmation = 'true';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', confirmation.labels.confirm);

      const prompt = document.createElement('p');
      prompt.className = 'note-style-batch-confirmation-prompt';
      prompt.dataset.noteStyleBatchConfirmMode = preview.summary.mode;
      prompt.textContent = (
        preview.summary.mode === 'preserve'
          ? confirmation.labels.confirmPreserve
          : confirmation.labels.confirmOverwrite
      ).replace('{count}', String(preview.summary.candidateCount));
      panel.append(prompt);

      const actions = document.createElement('div');
      actions.className = 'note-style-batch-confirmation-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'button small';
      cancel.dataset.noteStyleBatchAction = 'cancel-confirmation';
      cancel.textContent = confirmation.labels.cancel;
      cancel.disabled = busy;
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'button small primary';
      apply.dataset.noteStyleBatchAction = 'confirm';
      apply.textContent = confirmation.labels.confirm;
      apply.disabled = busy;
      actions.append(cancel, apply);
      panel.append(actions);
      result.append(panel);
    }
  };

  const renderConfirmationResult = (confirmationResult: {
    readonly outcomes: readonly PluginNoteStyleBatchConfirmationOutcome[];
    readonly confirmedCount: number;
    readonly refusedCount: number;
    readonly unattemptedCount: number;
  }) => {
    result.replaceChildren();
    result.removeAttribute('data-note-style-batch-mode');
    result.removeAttribute('data-note-style-batch-candidate-count');

    const title = document.createElement('h4');
    title.className = 'note-style-batch-result-title';
    title.dataset.noteStyleBatchResultTitle = 'true';
    title.tabIndex = -1;
    title.textContent = confirmation!.labels.resultTitle;
    result.append(title);

    const counts: Array<[PluginNoteStyleBatchConfirmationStatus, string, number]> = [
      ['confirmed', confirmation!.labels.confirmedCount, confirmationResult.confirmedCount],
      ['refused', confirmation!.labels.refusedCount, confirmationResult.refusedCount],
      ['unattempted', confirmation!.labels.unattemptedCount, confirmationResult.unattemptedCount],
    ];
    const countList = document.createElement('ul');
    countList.className = 'note-style-batch-result-counts';
    for (const [kind, label, value] of counts) {
      const item = document.createElement('li');
      item.dataset.noteStyleBatchResultCount = kind;
      item.textContent = `${label}: ${value}`;
      countList.append(item);
    }
    result.append(countList);

    const outcomes = document.createElement('ol');
    outcomes.className = 'note-style-batch-outcomes';
    for (const outcome of confirmationResult.outcomes) {
      const item = document.createElement('li');
      item.dataset.noteStyleBatchOutcome = outcome.status;
      item.dataset.noteStyleBatchOrder = String(outcome.order);
      item.textContent = `${outcome.title}: ${outcomeLabel(outcome)}`;
      outcomes.append(item);
    }
    result.append(outcomes);

    status.textContent = confirmationResult.refusedCount > 0 || confirmationResult.unattemptedCount > 0
      ? confirmation!.labels.partial
      : confirmation!.labels.complete;
  };

  const expirePreview = () => {
    const current = lease;
    if (!current) return;
    const focusedControl = document.activeElement;
    const returnToPreview =
      focusedControl instanceof HTMLElement &&
      result.contains(focusedControl) &&
      focusedControl.matches('button[data-note-style-batch-action]');
    detachLease();
    confirmationOpen = false;
    syncControls();
    if (active && !current.isCurrent()) {
      clearResult(host.batchPreviewLabels.stale);
      if (returnToPreview) previewButton.focus();
    }
  };

  const showPreview = () => {
    if (!active || busy || confirmationOpen) return;
    detachLease();
    confirmationOpen = false;
    status.textContent = '';
    result.replaceChildren();
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

  const beginConfirmation = () => {
    if (!active || busy || confirmationOpen || !confirmation) return;
    const current = lease;
    if (!current || current.summary.candidateCount === 0) return;
    if (!current.isCurrent()) {
      expirePreview();
      return;
    }
    const hadPanelFocus = root.contains(document.activeElement);
    confirmationOpen = true;
    syncControls();
    render(current, true);
    if (hadPanelFocus)
      result.querySelector<HTMLButtonElement>('[data-note-style-batch-action="cancel-confirmation"]')?.focus();
  };

  const cancelConfirmation = () => {
    if (!active || busy || !confirmationOpen) return;
    const current = lease;
    const hadPanelFocus = root.contains(document.activeElement);
    confirmationOpen = false;
    syncControls();
    if (!current || !current.isCurrent()) {
      expirePreview();
      return;
    }
    render(current);
    if (hadPanelFocus)
      result.querySelector<HTMLButtonElement>('[data-note-style-batch-action="begin-apply"]')?.focus();
  };

  const confirmPreview = async () => {
    if (!active || busy || !confirmationOpen || !confirmation) return;
    const current = lease;
    if (!current || !current.isCurrent()) {
      expirePreview();
      return;
    }

    // Keep the exact lease before detaching its observer. Consuming it expires the preview;
    // calling host.invalidate() here would also cancel the confirmation's first write.
    const leaseToConfirm = current;
    const hadPanelFocus = root.contains(document.activeElement);
    busy = true;
    confirmationOpen = true;
    detachLease();
    syncControls();
    render(leaseToConfirm, true);
    status.textContent = confirmation.labels.applying;
    if (hadPanelFocus) status.focus();
    const runId = ++confirmationRun;

    try {
      const confirmationResult = await confirmation.confirm(leaseToConfirm);
      if (!active || runId !== confirmationRun) return;
      const shouldFocusResult = root.contains(document.activeElement);
      busy = false;
      confirmationOpen = false;
      syncControls();
      if (!confirmationResult) {
        clearResult(host.batchPreviewLabels.stale);
        if (shouldFocusResult) previewButton.focus();
        return;
      }
      renderConfirmationResult(confirmationResult);
      if (shouldFocusResult)
        result.querySelector<HTMLElement>('[data-note-style-batch-result-title]')?.focus();
    } catch {
      if (!active || runId !== confirmationRun) return;
      const shouldFocusRetry = root.contains(document.activeElement);
      busy = false;
      confirmationOpen = false;
      syncControls();
      clearResult(confirmation.labels.applyFailed);
      if (shouldFocusRetry) previewButton.focus();
    }
  };

  const onChange = () => {
    if (!active || busy) return;
    if (lease || confirmationOpen) {
      confirmationOpen = false;
      detachLease();
      host.batchPreview.invalidate();
      syncControls();
      clearResult(host.batchPreviewLabels.cleared);
    }
  };
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>('button[data-note-style-batch-action]');
    if (!button || !root.contains(button) || busy) return;
    switch (button.dataset.noteStyleBatchAction) {
      case 'preview':
        showPreview();
        break;
      case 'begin-apply':
        beginConfirmation();
        break;
      case 'cancel-confirmation':
        cancelConfirmation();
        break;
      case 'confirm':
        void confirmPreview();
        break;
    }
  };

  mode.addEventListener('change', onChange);
  root.addEventListener('click', onClick);

  return () => {
    if (!active) return;
    active = false;
    confirmationRun++;
    mode.removeEventListener('change', onChange);
    root.removeEventListener('click', onClick);
    detachLease();
    host.batchPreview.invalidate();
    unmountDefaults?.();
    defaultsRoot.remove();
    root.remove();
  };
};

export const mountNoteStyleDefaultsPanel = Object.assign(mountNoteStyleDefaultsPanelImpl, {
  supportsLiveProfileDefaults: true as const,
});
