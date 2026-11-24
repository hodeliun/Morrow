import type { NoteStyle, NoteStyleFont, NoteStyleWidth } from '../../../src/core/noteStyle';
import type {
  PluginNoteStylePanelMount,
  PluginNoteStylePanelResult,
} from '../../../src/app/plugins/registry';

const FONT_OPTIONS: readonly NoteStyleFont[] = ['sans', 'serif', 'mono'];
const WIDTH_OPTIONS: readonly NoteStyleWidth[] = ['comfortable', 'wide', 'full'];
const PREVIEW_WIDTHS: Readonly<Record<NoteStyleWidth, string>> = {
  comfortable: '68%',
  wide: '84%',
  full: '100%',
};

function copyStyle(style: Readonly<NoteStyle>): NoteStyle {
  return {
    font: style.font,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    blockSpacing: style.blockSpacing,
    width: style.width,
  };
}

/** Mounts the Documento-owned controls and a local-only sample into the host dialog. */
export const mountNoteStylePanel: PluginNoteStylePanelMount = (container, host) => {
  const document = container.ownerDocument;
  const root = document.createElement('form');
  root.className = 'note-style-panel';
  root.noValidate = true;
  root.setAttribute('aria-label', host.labels.title);

  let draft = copyStyle(host.initial);
  let savedBaseline = copyStyle(host.initial);
  let active = true;
  let inFlight = false;

  const controls = document.createElement('div');
  controls.className = 'note-style-controls';

  const font = document.createElement('select');
  font.className = 'text-input small';
  font.dataset.noteStyleField = 'font';
  font.setAttribute('aria-label', host.labels.font);
  for (const optionValue of FONT_OPTIONS) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = host.labels.fonts[optionValue];
    font.append(option);
  }

  const width = document.createElement('select');
  width.className = 'text-input small';
  width.dataset.noteStyleField = 'width';
  width.setAttribute('aria-label', host.labels.width);
  for (const optionValue of WIDTH_OPTIONS) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = host.labels.widths[optionValue];
    width.append(option);
  }

  const fontSize = document.createElement('input');
  fontSize.type = 'range';
  fontSize.min = '12';
  fontSize.max = '32';
  fontSize.step = '0.5';
  fontSize.dataset.noteStyleField = 'fontSize';
  fontSize.setAttribute('aria-label', host.labels.fontSize);

  const lineHeight = document.createElement('input');
  lineHeight.type = 'range';
  lineHeight.min = '1.2';
  lineHeight.max = '2.4';
  lineHeight.step = '0.01';
  lineHeight.dataset.noteStyleField = 'lineHeight';
  lineHeight.setAttribute('aria-label', host.labels.lineHeight);

  const blockSpacing = document.createElement('input');
  blockSpacing.type = 'range';
  blockSpacing.min = '0';
  blockSpacing.max = '40';
  blockSpacing.step = '1';
  blockSpacing.dataset.noteStyleField = 'blockSpacing';
  blockSpacing.setAttribute('aria-label', host.labels.blockSpacing);

  const fontSizeOutput = document.createElement('output');
  const lineHeightOutput = document.createElement('output');
  const blockSpacingOutput = document.createElement('output');

  const field = (label: string, control: HTMLElement, output?: HTMLOutputElement) => {
    const wrapper = document.createElement('label');
    wrapper.className = 'note-style-field';
    const caption = document.createElement('span');
    caption.textContent = label;
    wrapper.append(caption, control);
    if (output) wrapper.append(output);
    controls.append(wrapper);
  };

  field(host.labels.font, font);
  field(host.labels.fontSize, fontSize, fontSizeOutput);
  field(host.labels.lineHeight, lineHeight, lineHeightOutput);
  field(host.labels.blockSpacing, blockSpacing, blockSpacingOutput);
  field(host.labels.width, width);

  const previewFrame = document.createElement('div');
  previewFrame.className = 'note-style-preview-frame';
  previewFrame.setAttribute('role', 'group');
  previewFrame.setAttribute('aria-label', host.labels.previewWidth);
  const previewLabel = document.createElement('span');
  previewLabel.className = 'note-style-preview-label';
  previewLabel.textContent = host.labels.previewWidth;
  const preview = document.createElement('div');
  preview.className = 'note-style-preview';
  const previewHeading = document.createElement('strong');
  previewHeading.textContent = host.labels.previewHeading;
  const previewBody = document.createElement('span');
  previewBody.textContent = host.labels.previewBody;
  preview.append(previewHeading, previewBody);
  previewFrame.append(previewLabel, preview);

  const status = document.createElement('p');
  status.className = 'note-style-status';
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'popover-actions';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'button small';
  save.dataset.noteStyleAction = 'save';
  save.textContent = host.labels.save;
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'button small';
  restore.dataset.noteStyleAction = 'restore';
  restore.textContent = host.labels.restore;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'button small';
  cancel.dataset.noteStyleAction = 'cancel';
  cancel.textContent = host.labels.cancel;
  actions.append(save, cancel, restore);

  root.append(controls, previewFrame, status, actions);
  container.append(root);

  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.hidden = message.length === 0;
    status.setAttribute('role', isError ? 'alert' : 'status');
    status.classList.toggle('is-error', isError);
  };

  const setBusy = (busy: boolean) => {
    root.dataset.busy = String(busy);
    for (const control of [font, fontSize, lineHeight, blockSpacing, width, save, cancel, restore])
      control.setAttribute('aria-disabled', String(busy));
  };

  const render = () => {
    font.value = draft.font;
    width.value = draft.width;
    fontSize.value = String(draft.fontSize);
    lineHeight.value = String(draft.lineHeight);
    blockSpacing.value = String(draft.blockSpacing);
    fontSizeOutput.textContent = `${draft.fontSize} px`;
    lineHeightOutput.textContent = draft.lineHeight.toFixed(2);
    blockSpacingOutput.textContent = `${draft.blockSpacing} px`;
    preview.className = `note-style-preview font-${draft.font}`;
    preview.style.width = PREVIEW_WIDTHS[draft.width];
    preview.style.setProperty('--note-font-size', `${draft.fontSize}px`);
    preview.style.setProperty('--note-line-height', String(draft.lineHeight));
    preview.style.setProperty('--note-block-spacing', `${draft.blockSpacing}px`);
  };

  const update = (fieldName: string, value: string) => {
    switch (fieldName) {
      case 'font':
        if (FONT_OPTIONS.includes(value as NoteStyleFont)) draft = { ...draft, font: value as NoteStyleFont };
        break;
      case 'fontSize':
        draft = { ...draft, fontSize: Number(value) };
        break;
      case 'lineHeight':
        draft = { ...draft, lineHeight: Number(value) };
        break;
      case 'blockSpacing':
        draft = { ...draft, blockSpacing: Number(value) };
        break;
      case 'width':
        if (WIDTH_OPTIONS.includes(value as NoteStyleWidth))
          draft = { ...draft, width: value as NoteStyleWidth };
        break;
      default:
        return;
    }
    render();
  };

  const run = async (operation: () => Promise<PluginNoteStylePanelResult>) => {
    if (!active) return;
    if (inFlight) {
      setStatus(host.labels.saveBusy, true);
      return;
    }
    inFlight = true;
    setBusy(true);
    setStatus(host.labels.saving);
    try {
      const result = await operation();
      if (!active) return;
      if (!result.ok) setStatus(result.message, true);
      else {
        draft = copyStyle(result.style);
        savedBaseline = copyStyle(result.style);
        render();
        setStatus(result.message ?? '');
      }
    } catch {
      if (active) setStatus(host.labels.saveFailed, true);
    } finally {
      if (active) {
        inFlight = false;
        setBusy(false);
      }
    }
  };

  const onInput = (event: Event) => {
    if (inFlight) {
      render();
      return;
    }
    const target = event.target as HTMLInputElement | null;
    if (!target || !root.contains(target) || !target.dataset.noteStyleField) return;
    update(target.dataset.noteStyleField, target.value);
  };
  const onChange = (event: Event) => {
    if (inFlight) {
      render();
      return;
    }
    const target = event.target as HTMLSelectElement | null;
    if (!target || !root.contains(target) || !target.dataset.noteStyleField) return;
    update(target.dataset.noteStyleField, target.value);
  };
  const onSubmit = (event: Event) => {
    event.preventDefault();
    const submitted = copyStyle(draft);
    void run(() => host.save(submitted));
  };
  const onClick = (event: MouseEvent) => {
    const target = event.target as Element | null;
    const button = target?.closest<HTMLButtonElement>('button[data-note-style-action]');
    if (!button || !root.contains(button)) return;
    if (button.dataset.noteStyleAction === 'cancel') {
      if (active && !inFlight) {
        draft = copyStyle(savedBaseline);
        render();
        setStatus('');
        host.cancel();
      }
      return;
    }
    if (button.dataset.noteStyleAction === 'restore') void run(() => host.restore());
  };

  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  root.addEventListener('submit', onSubmit);
  root.addEventListener('click', onClick);
  render();

  return () => {
    if (!active) return;
    active = false;
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    root.removeEventListener('submit', onSubmit);
    root.removeEventListener('click', onClick);
    root.remove();
  };
};
