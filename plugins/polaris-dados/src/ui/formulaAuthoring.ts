import type {
  PluginInlineFormulaEditHost,
  PluginInlineFormulaInsertionFailureReason,
  PluginInlineFormulaInsertionHost,
  PluginInlineFormulaInsertionResult,
} from '../../../../src/app/plugins/inlineFormulaApi';
import type { SupportedLocale } from '../../../../src/app/i18n';
import type { FormulaRuntimeValue } from '../engine/formula';
import { computeRuntimeFormula } from '../engine/formula';
import { formatInlineFormulaValue } from './inlineFormulaResult';

export interface FormulaAuthoringMessages {
  readonly slashTitle: string;
  readonly slashDescription: string;
  readonly slashKeywords: string;
  readonly title: string;
  readonly editTitle: string;
  readonly nameLabel: string;
  readonly namePlaceholder: string;
  readonly formulaLabel: string;
  readonly formulaPlaceholder: string;
  readonly save: string;
  readonly cancel: string;
  readonly close: string;
  readonly formulaRequired: string;
  readonly formulaError: (detail: string) => string;
  readonly scalarRequired: string;
  readonly formatMismatch: string;
  readonly insertionError: (reason: PluginInlineFormulaInsertionFailureReason) => string;
}

const MESSAGES: Record<SupportedLocale, FormulaAuthoringMessages> = {
  pt: {
    slashTitle: 'Fórmula inline',
    slashDescription: 'Insira um resultado calculado no corpo da nota.',
    slashKeywords: 'fórmula formula resultado cálculo inline',
    title: 'Inserir fórmula inline',
    editTitle: 'Editar fórmula inline',
    nameLabel: 'Nome (opcional)',
    namePlaceholder: 'Ex.: Total',
    formulaLabel: 'Fórmula',
    formulaPlaceholder: 'Ex.: 2 + 3',
    save: 'Salvar',
    cancel: 'Cancelar',
    close: 'Fechar formulário',
    formulaRequired: 'Digite uma fórmula.',
    formulaError: (detail) => `Não foi possível avaliar a fórmula: ${detail}`,
    scalarRequired: 'A fórmula precisa resultar em um valor simples, como número, texto ou verdadeiro/falso.',
    formatMismatch: 'O resultado não é compatível com o formato atual desta fórmula.',
    insertionError: (reason) => {
      switch (reason) {
        case 'read-only':
          return 'Esta nota está em modo somente leitura.';
        case 'owner-ended':
          return 'O Polaris Dados foi desativado. O comando continua na nota.';
        case 'document-changed':
          return 'A nota mudou. O comando continua na nota; abra um novo formulário.';
        case 'selection-changed':
          return 'A seleção mudou. O comando continua na nota; abra um novo formulário.';
        case 'target-changed':
          return 'O painel ou a nota mudou. O comando continua na nota original.';
        case 'session-changed':
        case 'session-closed':
          return 'O cofre mudou ou foi fechado. O comando continua na nota original.';
        case 'peer-unavailable':
          return 'O editor não está mais disponível. O comando continua na nota.';
        case 'unsupported-target':
          return 'Este local não aceita fórmulas inline.';
        case 'invalid-input':
          return 'Confira o nome e a fórmula informados.';
        case 'already-used':
          return 'Este comando já foi concluído ou cancelado.';
        case 'empty-content':
        case 'invalid-markdown':
        case 'insert-rejected':
          return 'Não foi possível inserir a fórmula. O comando continua na nota.';
        default:
          return 'Não foi possível inserir a fórmula. O comando continua na nota.';
      }
    },
  },
  en: {
    slashTitle: 'Inline formula',
    slashDescription: 'Insert a calculated result in the note.',
    slashKeywords: 'formula result calculated inline',
    title: 'Insert inline formula',
    editTitle: 'Edit inline formula',
    nameLabel: 'Name (optional)',
    namePlaceholder: 'For example, Total',
    formulaLabel: 'Formula',
    formulaPlaceholder: 'For example, 2 + 3',
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close form',
    formulaRequired: 'Enter a formula.',
    formulaError: (detail) => `Could not evaluate this formula: ${detail}`,
    scalarRequired: 'The formula must return a simple value, such as a number, text, or true/false.',
    formatMismatch: 'This result is not compatible with the current formula format.',
    insertionError: (reason) => {
      switch (reason) {
        case 'read-only':
          return 'This note is read-only.';
        case 'owner-ended':
          return 'Polaris Dados was turned off. The command remains in the note.';
        case 'document-changed':
          return 'The note changed. The command remains in the note; open a new form.';
        case 'selection-changed':
          return 'The selection changed. The command remains in the note; open a new form.';
        case 'target-changed':
          return 'The pane or note changed. The command remains in the original note.';
        case 'session-changed':
        case 'session-closed':
          return 'The vault changed or closed. The command remains in the original note.';
        case 'peer-unavailable':
          return 'The editor is no longer available. The command remains in the note.';
        case 'unsupported-target':
          return 'This location does not support inline formulas.';
        case 'invalid-input':
          return 'Check the name and formula.';
        case 'already-used':
          return 'This command was already completed or cancelled.';
        case 'empty-content':
        case 'invalid-markdown':
        case 'insert-rejected':
          return 'The formula could not be inserted. The command remains in the note.';
        default:
          return 'The formula could not be inserted. The command remains in the note.';
      }
    },
  },
  es: {
    slashTitle: 'Fórmula en línea',
    slashDescription: 'Inserta un resultado calculado en la nota.',
    slashKeywords: 'fórmula formula resultado cálculo en línea',
    title: 'Insertar fórmula en línea',
    editTitle: 'Editar fórmula en línea',
    nameLabel: 'Nombre (opcional)',
    namePlaceholder: 'Por ejemplo, Total',
    formulaLabel: 'Fórmula',
    formulaPlaceholder: 'Por ejemplo, 2 + 3',
    save: 'Guardar',
    cancel: 'Cancelar',
    close: 'Cerrar formulario',
    formulaRequired: 'Escribe una fórmula.',
    formulaError: (detail) => `No se pudo evaluar la fórmula: ${detail}`,
    scalarRequired: 'La fórmula debe devolver un valor simple, como número, texto o verdadero/falso.',
    formatMismatch: 'El resultado no es compatible con el formato actual de esta fórmula.',
    insertionError: (reason) => {
      switch (reason) {
        case 'read-only':
          return 'Esta nota es de solo lectura.';
        case 'owner-ended':
          return 'Se desactivó Polaris Dados. El comando permanece en la nota.';
        case 'document-changed':
          return 'La nota cambió. El comando permanece en la nota; abre otro formulario.';
        case 'selection-changed':
          return 'La selección cambió. El comando permanece en la nota; abre otro formulario.';
        case 'target-changed':
          return 'Cambió el panel o la nota. El comando permanece en la nota original.';
        case 'session-changed':
        case 'session-closed':
          return 'Cambió o se cerró la bóveda. El comando permanece en la nota original.';
        case 'peer-unavailable':
          return 'El editor ya no está disponible. El comando permanece en la nota.';
        case 'unsupported-target':
          return 'Este lugar no admite fórmulas en línea.';
        case 'invalid-input':
          return 'Revisa el nombre y la fórmula.';
        case 'already-used':
          return 'Este comando ya se completó o canceló.';
        case 'empty-content':
        case 'invalid-markdown':
        case 'insert-rejected':
          return 'No se pudo insertar la fórmula. El comando permanece en la nota.';
        default:
          return 'No se pudo insertar la fórmula. El comando permanece en la nota.';
      }
    },
  },
};

export function formulaAuthoringMessages(locale: SupportedLocale): FormulaAuthoringMessages {
  return MESSAGES[locale];
}

interface ActiveForm {
  readonly focus: () => void;
  readonly close: () => void;
}

/** Owns the one lightweight formula dialog for this Polaris Dados activation. */
export function createFormulaAuthoringController(locale: SupportedLocale): {
  readonly onInvoke: (host: PluginInlineFormulaInsertionHost) => void;
  readonly onEdit: (host: PluginInlineFormulaEditHost) => void;
  readonly dispose: () => void;
} {
  const messages = formulaAuthoringMessages(locale);
  let active: ActiveForm | null = null;
  let disposed = false;

  return {
    onInvoke(host) {
      if (disposed) {
        host.cancel();
        return;
      }
      if (active) {
        host.dismiss?.();
        host.cancel();
        active.focus();
        return;
      }

      host.dismiss?.();
      active = mountFormulaDialog(host, messages, 'insert', locale, () => {
        active = null;
      });
    },
    onEdit(host) {
      if (disposed) {
        host.cancel();
        return;
      }
      if (active) {
        host.cancel();
        active.focus();
        return;
      }

      active = mountFormulaDialog(host, messages, 'edit', locale, () => {
        active = null;
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      active?.close();
      active = null;
    },
  };
}

function mountFormulaDialog(
  host: PluginInlineFormulaInsertionHost | PluginInlineFormulaEditHost,
  messages: FormulaAuthoringMessages,
  mode: 'insert' | 'edit',
  locale: SupportedLocale,
  onClose: () => void,
): ActiveForm {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const id = `polaris-formula-${Math.random().toString(36).slice(2)}`;
  const backdrop = document.createElement('div');
  backdrop.className = 'dialog-backdrop formula-authoring-backdrop';
  const form = document.createElement('form');
  form.className = 'dialog dialog-small formula-authoring-dialog';
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');
  form.setAttribute('aria-labelledby', `${id}-title`);
  form.noValidate = true;

  const header = document.createElement('header');
  header.className = 'dialog-header';
  const title = document.createElement('h2');
  title.id = `${id}-title`;
  title.textContent = mode === 'edit' ? messages.editTitle : messages.title;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'icon-button dialog-close';
  closeButton.setAttribute('aria-label', messages.close);
  closeButton.textContent = '×';
  header.append(title, closeButton);

  const body = document.createElement('div');
  body.className = 'dialog-body formula-authoring-body';
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '12px';
  const nameField = createField(id, 'name', messages.nameLabel, messages.namePlaceholder);
  nameField.control.maxLength = 100;
  nameField.control.autocomplete = 'off';
  nameField.control.spellcheck = false;
  const formulaField = mode === 'edit'
    ? createField(id, 'formula', messages.formulaLabel, messages.formulaPlaceholder, true)
    : createField(id, 'formula', messages.formulaLabel, messages.formulaPlaceholder);
  formulaField.control.maxLength = 2000;
  formulaField.control.autocomplete = 'off';
  formulaField.control.spellcheck = false;
  formulaField.control.setAttribute('data-autofocus', 'true');
  let renderedInitialName: string | null = null;
  if (mode === 'edit') {
    const initial = (host as PluginInlineFormulaEditHost).initial;
    nameField.control.value = initial.name;
    renderedInitialName = nameField.control.value;
    formulaField.control.value = initial.formula;
  }
  const error = document.createElement('div');
  error.className = 'field-error formula-authoring-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  body.append(nameField.field, formulaField.field, error);

  const footer = document.createElement('footer');
  footer.className = 'dialog-footer';
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'button';
  cancelButton.textContent = messages.cancel;
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'button primary';
  saveButton.textContent = messages.save;
  footer.append(cancelButton, saveButton);

  form.append(header, body, footer);
  backdrop.append(form);
  document.body.append(backdrop);

  let closed = false;
  let submitting = false;
  const setError = (text: string) => {
    error.textContent = text;
    error.hidden = !text;
  };
  const close = (restoreFocus: boolean, cancelHost: boolean) => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onDocumentKeyDown, true);
    let mayRestoreFocus = false;
    if (restoreFocus) {
      try {
        mayRestoreFocus = host.canRestoreFocus?.() === true;
      } catch {
        mayRestoreFocus = false;
      }
    }
    if (cancelHost) {
      try {
        host.cancel();
      } catch {
        /* A closed capture cannot keep the form alive. */
      }
    }
    const focusWasInForm = form.contains(document.activeElement);
    backdrop.remove();
    onClose();
    if (restoreFocus && mayRestoreFocus && focusWasInForm && previousFocus?.isConnected) {
      previousFocus.focus({ preventScroll: true });
    }
  };
  const cancel = () => close(true, true);
  const reasonForFailure = (reason: PluginInlineFormulaInsertionFailureReason): string =>
    messages.insertionError(reason);
  const submit = () => {
    if (closed || submitting || saveButton.disabled) return;
    const editHost = mode === 'edit' ? host as PluginInlineFormulaEditHost : null;
    const enteredFormula = formulaField.control.value;
    // Textarea normalizes source CRLF/CR to LF. Preserve the exact saved formula
    // when the user submits without changing its text.
    const formula = editHost && normalizeTextareaValue(enteredFormula) ===
      normalizeTextareaValue(editHost.initial.formula)
      ? editHost.initial.formula
      : enteredFormula;
    if (!formula.trim()) {
      setError(messages.formulaRequired);
      formulaField.control.focus();
      return;
    }
    const evaluation = computeRuntimeFormula(formula, {});
    if (evaluation.error) {
      setError(messages.formulaError(evaluation.error));
      formulaField.control.focus();
      return;
    }
    if (!isScalar(evaluation.value)) {
      setError(messages.scalarRequired);
      formulaField.control.focus();
      return;
    }

    if (editHost) {
      const display = formatInlineFormulaValue(evaluation.value, {
        formula,
        outputType: editHost.initial.outputType,
        format: editHost.initial.format,
        fallback: editHost.initial.name,
        locale,
      });
      if (display.kind === 'unsupported') {
        setError(messages.formatMismatch);
        formulaField.control.focus();
        return;
      }
    }

    submitting = true;
    const enteredName = nameField.control.value;
    const name = editHost && enteredName === renderedInitialName
      ? editHost.initial.name
      : mode === 'edit' ? enteredName : enteredName.trim();
    let result: PluginInlineFormulaInsertionResult;
    try {
      result = mode === 'edit'
        ? (host as PluginInlineFormulaEditHost).confirm({ formula, name })
        : (host as PluginInlineFormulaInsertionHost).confirm({ formula, ...(name ? { name } : {}) });
    } catch {
      result = { ok: false, reason: 'insert-rejected' };
    }
    if (result.ok) {
      close(false, false);
      if (editHost) {
        try {
          editHost.focusAfterEdit?.();
        } catch {
          // The host may have been switched or removed while the form closed.
        }
      }
      return;
    }
    submitting = false;
    setError(reasonForFailure(result.reason));
    if (result.reason !== 'invalid-input') saveButton.disabled = true;
    formulaField.control.focus();
  };
  const onSubmit = (event: SubmitEvent) => {
    event.preventDefault();
    event.stopPropagation();
    submit();
  };
  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (closed || !form.contains(event.target as Node)) return;
    // During IME confirmation, Enter belongs to the composition session rather
    // than the dialog. Let the browser and input method finish it untouched.
    if (event.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
      return;
    }
    if (event.key === 'Enter') {
      // Buttons retain native activation. The formula editor is multiline, so
      // plain Enter inserts a newline and Ctrl/Meta+Enter submits it.
      if (event.target instanceof HTMLButtonElement) return;
      if (event.target instanceof HTMLTextAreaElement) {
        if (!event.ctrlKey && !event.metaKey) return;
      } else if (!(event.target instanceof HTMLInputElement)) {
        return;
      }
      // Repeated submit keydowns must not confirm twice. Plain textarea Enter
      // and all button keydowns have already been left to the browser above.
      if (event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      submit();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...form.querySelectorAll<HTMLElement>('input, textarea, button:not(:disabled)')];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  form.addEventListener('submit', onSubmit);
  cancelButton.addEventListener('click', cancel);
  closeButton.addEventListener('click', cancel);
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) cancel();
  });
  document.addEventListener('keydown', onDocumentKeyDown, true);
  formulaField.control.focus();

  return {
    focus: () => formulaField.control.focus(),
    close: () => close(true, true),
  };
}

function createField(
  prefix: string,
  name: 'name' | 'formula',
  labelText: string,
  placeholder: string,
  multiline?: false,
): { readonly field: HTMLLabelElement; readonly control: HTMLInputElement };
function createField(
  prefix: string,
  name: 'name' | 'formula',
  labelText: string,
  placeholder: string,
  multiline: true,
): { readonly field: HTMLLabelElement; readonly control: HTMLTextAreaElement };
function createField(
  prefix: string,
  name: 'name' | 'formula',
  labelText: string,
  placeholder: string,
  multiline = false,
): { readonly field: HTMLLabelElement; readonly control: HTMLInputElement | HTMLTextAreaElement } {
  const field = document.createElement('label');
  field.className = 'field formula-authoring-field';
  field.htmlFor = `${prefix}-${name}`;
  field.append(document.createTextNode(labelText));
  const control = multiline ? document.createElement('textarea') : document.createElement('input');
  control.id = field.htmlFor;
  control.className = 'text-input';
  control.placeholder = placeholder;
  if (control instanceof HTMLInputElement) control.type = 'text';
  field.append(control);
  return { field, control } as {
    readonly field: HTMLLabelElement;
    readonly control: HTMLInputElement | HTMLTextAreaElement;
  };
}

function normalizeTextareaValue(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function isScalar(value: FormulaRuntimeValue): boolean {
  return (
    value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  );
}
