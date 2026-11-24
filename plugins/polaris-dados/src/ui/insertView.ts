import type { DataApi, DataApiSnapshot } from '../../../../src/app/plugins/dataApi';
import type {
  PluginEditorInsertionApiV1,
  PluginEditorInsertionFailureReason,
  PluginEditorInsertionTargetV1,
} from '../../../../src/app/plugins/editorApi';
import { providerMessages } from './locale';
import type { SupportedLocale } from './locale';

export interface LinkedViewInsertPickerApi {
  readonly data: DataApi;
  readonly pages: {
    list(): readonly { readonly id: string; readonly title: string; readonly kind: string }[];
  };
  readonly editor: { readonly insertion: PluginEditorInsertionApiV1 };
  readonly locale: SupportedLocale;
}

type PickerMessages = ReturnType<typeof providerMessages>;

interface SourcePage {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
}

interface EligibleSource {
  readonly id: string;
  readonly title: string;
}

type SourceResult =
  | { readonly ok: true; readonly source: EligibleSource }
  | {
      readonly ok: false;
      readonly reason: 'missing' | 'unsupported' | 'readonly' | 'host-readonly' | 'api';
      readonly message: string;
    };

interface EligibleSourceList {
  readonly sources: EligibleSource[];
  readonly message: string;
}

function sourceFailure(
  reason: Extract<SourceResult, { readonly ok: false }>['reason'],
  messages: PickerMessages,
): SourceResult {
  const message =
    reason === 'missing'
      ? messages.pickerSourceMissing
      : reason === 'unsupported'
        ? messages.pickerSourceUnsupported
        : reason === 'host-readonly'
          ? messages.pickerReadOnly
          : reason === 'api'
            ? messages.pickerApiUnsupported
            : messages.pickerSourceReadonly;
  return { ok: false, reason, message };
}

interface PickerSession {
  readonly panel: HTMLElement;
  readonly select: HTMLSelectElement;
  readonly insertButton: HTMLButtonElement;
  readonly status: HTMLOutputElement;
  readonly messages: PickerMessages;
  target: PluginEditorInsertionTargetV1 | null;
  selectedSourceId: string;
}

export interface LinkedViewInsertPicker {
  open(): void;
  dispose(): void;
}

function resolvePageSource(
  api: LinkedViewInsertPickerApi,
  page: SourcePage,
  messages: PickerMessages,
): SourceResult {
  let snapshot: DataApiSnapshot;
  try {
    snapshot = api.data.snapshot(page.id);
  } catch {
    return sourceFailure('missing', messages);
  }

  if (snapshot.version !== 1 || snapshot.databaseId !== page.id)
    return sourceFailure('api', messages);
  if (snapshot.status === 'missing') return sourceFailure('missing', messages);
  if (snapshot.status === 'unsupported') return sourceFailure('unsupported', messages);
  if (snapshot.readonly || snapshot.diagnostic !== null) {
    const reason =
      snapshot.diagnostic?.code === 'host-readonly'
        ? 'host-readonly'
        : snapshot.diagnostic?.code === 'provider-inactive' || snapshot.diagnostic?.code === 'unsupported-database'
          ? 'unsupported'
          : 'readonly';
    return sourceFailure(reason, messages);
  }

  return { ok: true, source: { id: page.id, title: page.title } };
}

function resolveSource(api: LinkedViewInsertPickerApi, id: string, messages: PickerMessages): SourceResult {
  let pages: readonly SourcePage[];
  try {
    pages = api.pages.list();
  } catch {
    return sourceFailure('api', messages);
  }

  const page = pages.find((candidate) => candidate.id === id && candidate.kind === 'database');
  return page ? resolvePageSource(api, page, messages) : sourceFailure('missing', messages);
}

function eligibleSources(api: LinkedViewInsertPickerApi, messages: PickerMessages): EligibleSourceList {
  let pages: readonly SourcePage[];
  try {
    pages = api.pages.list();
  } catch {
    return { sources: [], message: messages.pickerApiUnsupported };
  }

  const failures: Array<Extract<SourceResult, { readonly ok: false }>> = [];
  const sources = pages.flatMap((page) => {
    if (page.kind !== 'database') return [];
    const result = resolvePageSource(api, page, messages);
    if (result.ok) return [result.source];
    failures.push(result);
    return [];
  });
  const failurePriority: Array<Extract<SourceResult, { readonly ok: false }>['reason']> = [
    'api',
    'host-readonly',
    'readonly',
    'unsupported',
    'missing',
  ];
  const firstFailure = failurePriority
    .map((reason) => failures.find((failure) => failure.reason === reason))
    .find((failure) => failure !== undefined);
  return { sources, message: firstFailure?.message ?? messages.pickerNoSources };
}

function truncateByCodePoint(value: string, maxUtf16Units: number): string {
  let result = '';
  for (const point of value) {
    if (result.length + point.length > maxUtf16Units) break;
    result += point;
  }
  return result;
}

export function defaultLinkedViewTitle(sourceTitle: string, messages: PickerMessages): string {
  const separator = ' — ';
  const suffix = messages.defaultViewSuffix;
  const prefixLength = Math.max(0, 300 - separator.length - suffix.length);
  const prefix = truncateByCodePoint(sourceTitle.trim() || messages.unnamedDatabase, prefixLength);
  return `${prefix}${separator}${suffix}`;
}

function toBase64UrlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPolarisDadosViewMarker(input: {
  readonly viewId: string;
  readonly sourceDatabaseId: string;
  readonly title: string;
}): string {
  const payload = JSON.stringify({
    version: 1,
    viewId: input.viewId,
    sourceDatabaseId: input.sourceDatabaseId,
    title: input.title,
    columnOrder: [] as string[],
    filter: null,
  });
  return `<!-- morrow:polaris-dados-view:v1:${toBase64UrlUtf8(payload)} -->`;
}

function createViewId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') return `view-${source.randomUUID()}`;
  if (typeof source?.getRandomValues !== 'function') throw new Error('Secure random IDs are not available.');

  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `view-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function insertionFailure(reason: PluginEditorInsertionFailureReason, messages: PickerMessages): string {
  switch (reason) {
    case 'already-used':
      return messages.pickerAlreadyUsed;
    case 'document-changed':
      return messages.pickerDocumentChanged;
    case 'selection-changed':
      return messages.pickerSelectionChanged;
    case 'target-changed':
    case 'peer-unavailable':
      return messages.pickerTargetChanged;
    case 'session-changed':
      return messages.pickerSessionChanged;
    case 'session-closed':
      return messages.pickerSessionClosed;
    case 'owner-ended':
      return messages.pickerOwnerEnded;
    case 'read-only':
      return messages.pickerReadOnly;
    case 'empty-content':
    case 'invalid-markdown':
    case 'insert-rejected':
      return messages.pickerInsertRejected;
  }
}

function button(owner: Document, label: string, action: string): HTMLButtonElement {
  const element = owner.createElement('button');
  element.type = 'button';
  element.dataset.polarisAction = action;
  element.textContent = label;
  return element;
}

function stylePicker(panel: HTMLElement): void {
  panel.style.position = 'fixed';
  panel.style.right = '1rem';
  panel.style.bottom = '1rem';
  panel.style.zIndex = '10000';
  panel.style.width = 'min(24rem, calc(100vw - 2rem))';
  panel.style.padding = '1rem';
  panel.style.display = 'grid';
  panel.style.gap = '0.75rem';
  panel.style.border = '1px solid var(--border, #777)';
  panel.style.borderRadius = '0.75rem';
  panel.style.background = 'var(--surface, Canvas)';
  panel.style.color = 'var(--text, CanvasText)';
  panel.style.boxShadow = '0 0.75rem 2rem #0004';
  panel.style.font = 'inherit';
}

function updateInsertEnabled(session: PickerSession): void {
  session.insertButton.disabled = !session.selectedSourceId || !session.target;
}

function captureTarget(api: LinkedViewInsertPickerApi): PluginEditorInsertionTargetV1 | null {
  try {
    return api.editor.insertion.capture();
  } catch {
    return null;
  }
}

export function createLinkedViewInsertPicker(api: LinkedViewInsertPickerApi): LinkedViewInsertPicker {
  let active: PickerSession | null = null;
  let disposed = false;

  const close = (session: PickerSession) => {
    if (active !== session) return;
    active = null;
    session.target?.dispose();
    session.target = null;
    session.panel.remove();
  };

  const open = () => {
    if (disposed) return;
    if (active) {
      active.panel.focus();
      return;
    }

    const target = captureTarget(api);

    const owner = document;
    const messages = providerMessages(api.locale);
    const panel = owner.createElement('section');
    panel.className = 'polaris-dados-insert-picker';
    panel.dataset.polarisDadosPicker = '';
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', messages.pickerTitle);
    panel.tabIndex = -1;
    stylePicker(panel);

    const heading = owner.createElement('h2');
    heading.textContent = messages.pickerTitle;

    const label = owner.createElement('label');
    label.htmlFor = 'polaris-dados-insert-source';
    label.textContent = messages.pickerSourceLabel;
    const select = owner.createElement('select');
    select.id = label.htmlFor;
    select.dataset.polarisAction = 'source';
    const placeholder = owner.createElement('option');
    placeholder.value = '';
    placeholder.textContent = messages.pickerChooseSource;
    select.append(placeholder);
    const sourceList = eligibleSources(api, messages);
    for (const source of sourceList.sources) {
      const option = owner.createElement('option');
      option.value = source.id;
      option.textContent = source.title;
      select.append(option);
    }
    if (select.options.length === 1) {
      placeholder.textContent = sourceList.message;
      select.disabled = true;
    }

    const status = owner.createElement('output');
    status.dataset.polarisAction = 'status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    const insertButton = button(owner, messages.pickerInsert, 'insert');
    const recaptureButton = button(owner, messages.pickerRecapture, 'recapture');
    const cancelButton = button(owner, messages.pickerCancel, 'cancel');
    const actions = owner.createElement('div');
    actions.style.display = 'flex';
    actions.style.flexWrap = 'wrap';
    actions.style.gap = '0.5rem';
    actions.append(insertButton, recaptureButton, cancelButton);
    panel.append(heading, label, select, status, actions);

    const session: PickerSession = {
      panel,
      select,
      insertButton,
      status,
      messages,
      target,
      selectedSourceId: '',
    };
    active = session;

    const setStatus = (message: string) => {
      session.status.textContent = message;
    };

    select.addEventListener('change', () => {
      if (disposed || active !== session) return;
      session.selectedSourceId = select.value;
      updateInsertEnabled(session);
      setStatus(
        !select.value
          ? messages.pickerChooseSource
          : session.target
            ? messages.pickerTargetCaptured
            : messages.pickerTargetUnavailable,
      );
    });

    recaptureButton.addEventListener('click', () => {
      if (disposed || active !== session) return;
      const replacement = captureTarget(api);
      const previous = session.target;
      session.target = replacement;
      previous?.dispose();
      updateInsertEnabled(session);
      if (!replacement) {
        setStatus(messages.pickerTargetUnavailable);
        return;
      }
      setStatus(messages.pickerTargetCaptured);
    });

    cancelButton.addEventListener('click', () => {
      if (disposed || active !== session) return;
      close(session);
    });

    insertButton.addEventListener('click', () => {
      if (disposed || active !== session) return;
      if (!session.selectedSourceId || !session.target) return;
      const source = resolveSource(api, session.selectedSourceId, messages);
      if (!source.ok) {
        setStatus(source.message);
        return;
      }

      let marker: string;
      try {
        marker = createPolarisDadosViewMarker({
          viewId: createViewId(),
          sourceDatabaseId: source.source.id,
          title: defaultLinkedViewTitle(source.source.title, messages),
        });
      } catch {
        setStatus(messages.pickerInsertFailed);
        return;
      }

      const insertionTarget = session.target;
      session.target = null;
      let result: ReturnType<PluginEditorInsertionTargetV1['insert']>;
      try {
        result = insertionTarget.insert(marker);
      } catch {
        insertionTarget.dispose();
        updateInsertEnabled(session);
        setStatus(messages.pickerInsertFailed);
        return;
      }
      if (result.ok) {
        close(session);
        return;
      }
      insertionTarget.dispose();
      updateInsertEnabled(session);
      setStatus(insertionFailure(result.reason, messages));
    });

    panel.addEventListener('keydown', (event) => {
      if (disposed || active !== session) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(session);
    });

    if (select.disabled) setStatus(sourceList.message);
    else if (!target) setStatus(messages.pickerTargetUnavailable);
    else setStatus(messages.pickerChooseSource);
    updateInsertEnabled(session);
    owner.body.append(panel);
    select.focus();
  };

  return {
    open,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (active) close(active);
    },
  };
}
