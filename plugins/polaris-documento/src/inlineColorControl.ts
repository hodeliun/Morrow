import type { PluginInlineColorControlHost } from '../../../src/app/plugins/registry';

let nextErrorId = 0;

function customHex(value: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
}

export function mountInlineColorControl(
  container: HTMLElement,
  host: PluginInlineColorControlHost,
): () => void {
  const document = container.ownerDocument;
  const root = document.createElement('span');
  root.className = 'color-custom-control';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', host.label);

  const pickerLabel = document.createElement('label');
  pickerLabel.className = 'color-custom-picker';
  pickerLabel.title = host.label;
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.value = customHex(host.color) ?? '#000000';
  picker.setAttribute('aria-label', host.label);
  picker.disabled = host.disabled;
  pickerLabel.append(picker);

  const hex = document.createElement('input');
  hex.className = 'color-hex-input';
  hex.type = 'text';
  hex.value = picker.value;
  hex.placeholder = '#RRGGBB';
  hex.maxLength = 7;
  hex.spellcheck = false;
  hex.autocomplete = 'off';
  hex.setAttribute('aria-label', host.inputLabel);
  hex.disabled = host.disabled;

  const errorId = `documento-inline-color-error-${++nextErrorId}`;
  hex.setAttribute('aria-describedby', errorId);
  const error = document.createElement('span');
  error.id = errorId;
  error.className = 'visually-hidden';
  error.textContent = host.invalidMessage;

  const setInvalid = (invalid: boolean) => {
    hex.setAttribute('aria-invalid', String(invalid));
    root.classList.toggle('is-invalid', invalid);
  };
  const apply = (value: string) => {
    const color = customHex(value);
    if (host.disabled || !color || !host.apply(color)) {
      setInvalid(true);
      return;
    }
    hex.value = color;
    picker.value = color;
    setInvalid(false);
    host.finish();
  };
  const onHexInput = () => {
    const color = customHex(hex.value);
    setInvalid(color === null);
    if (color) apply(color);
  };
  const onHexKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    apply(hex.value);
  };
  const onPickerChange = () => apply(picker.value);

  hex.addEventListener('input', onHexInput);
  hex.addEventListener('keydown', onHexKeyDown);
  picker.addEventListener('change', onPickerChange);
  root.append(pickerLabel, hex, error);
  container.append(root);

  return () => {
    hex.removeEventListener('input', onHexInput);
    hex.removeEventListener('keydown', onHexKeyDown);
    picker.removeEventListener('change', onPickerChange);
    root.remove();
  };
}
