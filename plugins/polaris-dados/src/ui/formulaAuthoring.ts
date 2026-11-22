import type {
  PluginInlineFormulaInsertionFailureReason,
  PluginInlineFormulaInsertionHost,
  PluginInlineFormulaInsertionResult,
} from '../../../../src/app/plugins/inlineFormulaApi';
import type { SupportedLocale } from '../../../../src/app/i18n';
import type { FormulaRuntimeValue } from '../engine/formula';
import { computeRuntimeFormula } from '../engine/formula';

export interface FormulaAuthoringMessages {
  readonly slashTitle: string;
  readonly slashDescription: string;
  readonly slashKeywords: string;
  readonly title: string;
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
  readonly insertionError: (reason: PluginInlineFormulaInsertionFailureReason) => string;
}

const MESSAGES: Record<SupportedLocale, FormulaAuthoringMessages> = {
  pt: {
    slashTitle: 'Fórmula inline',
    slashDescription: 'Insira um resultado calculado no corpo da nota.',
    slashKeywords: 'fórmula formula resultado cálculo inline',
    title: 'Inserir fórmula inline',
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
      active = mountFormulaDialog(host, messages, () => {
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
  host: PluginInlineFormulaInsertionHost,
  messages: FormulaAuthoringMessages,
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
  title.textContent = messages.title;
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
  nameField.input.maxLength = 100;
  nameField.input.autocomplete = 'off';
  nameField.input.spellcheck = false;
  const formulaField = createField(id, 'formula', messages.formulaLabel, messages.formulaPlaceholder);
  formulaField.input.maxLength = 2000;
  formulaField.input.autocomplete = 'off';
  formulaField.input.spellcheck = false;
  formulaField.input.setAttribute('data-autofocus', 'true');
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
    const formula = formulaField.input.value;
    if (!formula.trim()) {
      setError(messages.formulaRequired);
      formulaField.input.focus();
      return;
    }
    const evaluation = computeRuntimeFormula(formula, {});
    if (evaluation.error) {
      setError(messages.formulaError(evaluation.error));
      formulaField.input.focus();
      return;
    }
    if (!isScalar(evaluation.value)) {
      setError(messages.scalarRequired);
      formulaField.input.focus();
      return;
    }

    submitting = true;
    const name = nameField.input.value.trim();
    let result: PluginInlineFormulaInsertionResult;
    try {
      result = host.confirm({ formula, ...(name ? { name } : {}) });
    } catch {
      result = { ok: false, reason: 'insert-rejected' };
    }
    if (result.ok) {
      close(false, false);
      return;
    }
    submitting = false;
    setError(reasonForFailure(result.reason));
    if (result.reason !== 'invalid-input') saveButton.disabled = true;
    formulaField.input.focus();
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
      // Repeated keydown events must not submit a second time, but the first
      // Enter on a button is its native keyboard activation (including Cancel
      // and Close). Input Enter is handled here to avoid implicit submit plus
      // the form's submit event both processing the same key press.
      if (event.repeat) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (!(event.target instanceof HTMLInputElement)) return;
      event.preventDefault();
      event.stopPropagation();
      submit();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...form.querySelectorAll<HTMLElement>('input, button:not(:disabled)')];
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
  formulaField.input.focus();

  return {
    focus: () => formulaField.input.focus(),
    close: () => close(true, true),
  };
}

function createField(
  prefix: string,
  name: 'name' | 'formula',
  labelText: string,
  placeholder: string,
): { readonly field: HTMLLabelElement; readonly input: HTMLInputElement } {
  const field = document.createElement('label');
  field.className = 'field formula-authoring-field';
  field.htmlFor = `${prefix}-${name}`;
  field.append(document.createTextNode(labelText));
  const input = document.createElement('input');
  input.id = field.htmlFor;
  input.className = 'text-input';
  input.type = 'text';
  input.placeholder = placeholder;
  field.append(input);
  return { field, input };
}

function isScalar(value: FormulaRuntimeValue): boolean {
  return (
    value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  );
}
