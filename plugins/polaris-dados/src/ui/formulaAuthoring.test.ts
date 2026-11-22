// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  PluginInlineFormulaConfirmation,
  PluginInlineFormulaEditConfirmation,
  PluginInlineFormulaEditHost,
  PluginInlineFormulaEditInitial,
  PluginInlineFormulaInsertionHost,
  PluginInlineFormulaInsertionResult,
} from '../../../../src/app/plugins/inlineFormulaApi';
import { createFormulaAuthoringController, formulaAuthoringMessages } from './formulaAuthoring';

const controllers = new Set<ReturnType<typeof createFormulaAuthoringController>>();

function controller(locale: 'pt' | 'en' | 'es' = 'en') {
  const result = createFormulaAuthoringController(locale);
  controllers.add(result);
  return result;
}

type TestHost = PluginInlineFormulaInsertionHost & {
  dismiss: () => void;
  canRestoreFocus: () => boolean;
  confirm: (input: PluginInlineFormulaConfirmation) => PluginInlineFormulaInsertionResult;
  cancel: () => void;
};

type TestEditHost = PluginInlineFormulaEditHost & {
  focusAfterEdit: () => void;
  confirm: (input: PluginInlineFormulaEditConfirmation) => PluginInlineFormulaInsertionResult;
  cancel: () => void;
};

function host(result: PluginInlineFormulaInsertionResult = { ok: true }, canRestoreFocus = true): TestHost {
  return {
    dismiss: vi.fn(),
    canRestoreFocus: vi.fn(() => canRestoreFocus),
    confirm: vi.fn((_input: PluginInlineFormulaConfirmation) => result),
    cancel: vi.fn(),
  };
}

function editHost(
  initial: PluginInlineFormulaEditInitial,
  result: PluginInlineFormulaInsertionResult = { ok: true },
): TestEditHost {
  return {
    initial,
    focusAfterEdit: vi.fn(),
    canRestoreFocus: vi.fn(() => true),
    confirm: vi.fn((_input: PluginInlineFormulaEditConfirmation) => result),
    cancel: vi.fn(),
  };
}

function form(): HTMLFormElement {
  const result = document.querySelector<HTMLFormElement>('form[role="dialog"]');
  if (!result) throw new Error('The inline formula form did not open.');
  return result;
}

afterEach(() => {
  for (const item of controllers) item.dispose();
  controllers.clear();
  document.body.replaceChildren();
});

describe('Polaris Dados inline formula form', () => {
  it.each([
    ['pt', 'Inserir fórmula inline', 'Nome (opcional)', 'Fórmula', 'Salvar', 'Cancelar'],
    ['en', 'Insert inline formula', 'Name (optional)', 'Formula', 'Save', 'Cancel'],
    ['es', 'Insertar fórmula en línea', 'Nombre (opcional)', 'Fórmula', 'Guardar', 'Cancelar'],
  ] as const)('provides accessible %s labels', (locale, title, name, formula, save, cancel) => {
    const action = controller(locale);
    action.onInvoke(host());

    expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(title);
    expect(form().querySelector('label[for$="-name"]')?.textContent).toContain(name);
    expect(form().querySelector('label[for$="-formula"]')?.textContent).toContain(formula);
    expect(form().querySelector('button[type="submit"]')?.textContent).toBe(save);
    expect(form().querySelector('footer button[type="button"]')?.textContent).toBe(cancel);
    const formulaLabel = form().querySelector<HTMLLabelElement>('label[for$="-formula"]');
    expect(document.activeElement).toBe(document.getElementById(formulaLabel!.htmlFor));
  });

  it('dismisses the slash menu before focusing the form and confirms only a valid scalar formula', () => {
    const action = controller('en');
    const operation = host();
    action.onInvoke(operation);
    expect(operation.dismiss).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(
      form().querySelector('input[aria-label="Formula"]') ??
        form().querySelector('label[for$="-formula"] input'),
    );

    const formula = form().querySelector<HTMLInputElement>('label[for$="-formula"] input')!;
    const name = form().querySelector<HTMLInputElement>('label[for$="-name"] input')!;
    const save = form().querySelector<HTMLButtonElement>('button[type="submit"]')!;
    formula.value = '1 +';
    save.click();
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('Could not evaluate');
    expect(operation.confirm).not.toHaveBeenCalled();

    formula.value = '[1, 2]';
    save.click();
    expect(form().querySelector('[role="alert"]')?.textContent).toContain('simple value');
    expect(operation.confirm).not.toHaveBeenCalled();

    name.value = '  Total  ';
    formula.value = '2 + 3';
    save.click();
    expect(operation.confirm).toHaveBeenCalledWith({ formula: '2 + 3', name: 'Total' });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(operation.cancel).not.toHaveBeenCalled();
  });

  it('keeps the draft on a host failure, then cancels without confirming again', () => {
    const action = controller('pt');
    const operation = host({ ok: false, reason: 'read-only' });
    action.onInvoke(operation);
    const formula = form().querySelector<HTMLInputElement>('label[for$="-formula"] input')!;
    formula.value = '2 + 3';
    form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click();

    expect(form().querySelector('[role="alert"]')?.textContent).toContain('somente leitura');
    expect(form().querySelector<HTMLInputElement>('label[for$="-formula"] input')?.value).toBe('2 + 3');
    expect(form().querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    form().querySelector<HTMLButtonElement>('button[type="button"]')!.click();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(operation.cancel).toHaveBeenCalledOnce();
  });

  it('reuses the dialog with prefilled values and preserves an intentionally empty name', () => {
    const action = controller('en');
    const operation = editHost({
      name: 'Old <total> & tax', formula: '2 + 3', outputType: 'auto', format: {},
    });
    action.onEdit(operation);

    expect(form().querySelector('h2')?.textContent).toBe('Edit inline formula');
    const name = form().querySelector<HTMLInputElement>('label[for$="-name"] input')!;
    const formula = form().querySelector<HTMLTextAreaElement>('label[for$="-formula"] textarea')!;
    expect(name.value).toBe('Old <total> & tax');
    expect(formula.value).toBe('2 + 3');

    name.value = '';
    formula.value = '6 * 7';
    form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    expect(operation.confirm).toHaveBeenCalledWith({ formula: '6 * 7', name: '' });
    expect(operation.confirm).toHaveBeenCalledOnce();
    expect(operation.cancel).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('cancels an edit without confirming or changing the prefilled draft', () => {
    const action = controller('pt');
    const operation = editHost({ name: 'Total', formula: '2 + 3', outputType: 'auto', format: {} });
    action.onEdit(operation);
    form().querySelector<HTMLTextAreaElement>('label[for$="-formula"] textarea')!.value = '9 + 9';
    form().querySelector<HTMLButtonElement>('footer button[type="button"]')!.click();
    expect(operation.confirm).not.toHaveBeenCalled();
    expect(operation.cancel).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps an edited formula in the existing output format', () => {
    const action = controller('en');
    const operation = editHost({
      name: 'Count',
      formula: '2 + 3',
      outputType: 'number',
      format: { locale: 'en-US', precision: 2 },
    });
    action.onEdit(operation);
    const formula = form().querySelector<HTMLTextAreaElement>('label[for$="-formula"] textarea')!;
    const save = form().querySelector<HTMLButtonElement>('button[type="submit"]')!;
    formula.value = '"not a number"';
    save.click();

    expect(form().querySelector('[role="alert"]')?.textContent).toContain('not compatible');
    expect(operation.confirm).not.toHaveBeenCalled();
    expect(form().querySelector<HTMLTextAreaElement>('label[for$="-formula"] textarea')?.value).toBe('"not a number"');

    formula.value = '6 * 7';
    save.click();
    expect(operation.confirm).toHaveBeenCalledWith({ formula: '6 * 7', name: 'Count' });
    expect(operation.confirm).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('keeps multiline formulas in a textarea and returns the original CRLF literal on Ctrl+Enter no-op', () => {
    const action = controller('en');
    const originalFormula = '1 +\r\n2';
    const operation = editHost({
      name: 'Two', formula: originalFormula, outputType: 'auto', format: {},
    });
    action.onEdit(operation);

    const formula = form().querySelector<HTMLTextAreaElement>('label[for$="-formula"] textarea')!;
    expect(form().querySelector('label[for$="-formula"] input')).toBeNull();
    expect(formula.value.replace(/\r\n?/g, '\n')).toBe('1 +\n2');
    const plainEnter = new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    });
    formula.dispatchEvent(plainEnter);
    expect(plainEnter.defaultPrevented).toBe(false);
    expect(operation.confirm).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    const confirmEnter = new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    });
    formula.dispatchEvent(confirmEnter);
    expect(confirmEnter.defaultPrevented).toBe(true);
    expect(operation.confirm).toHaveBeenCalledWith({ formula: originalFormula, name: 'Two' });
    expect(operation.confirm).toHaveBeenCalledOnce();
    expect(operation.focusAfterEdit).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('returns the original name literal when the text input renders it with normalization', () => {
    const action = controller('en');
    const originalName = 'Line\r\nbreak';
    const operation = editHost({
      name: originalName, formula: '2 + 3', outputType: 'auto', format: {},
    });
    action.onEdit(operation);
    const name = form().querySelector<HTMLInputElement>('label[for$="-name"] input')!;
    const renderedName = name.value;
    expect(renderedName).not.toBe('');

    form().querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    expect(operation.confirm).toHaveBeenCalledWith({ formula: '2 + 3', name: originalName });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it.each([
    ['Cancel', 'footer button[type="button"]'],
    ['Close', 'button[aria-label="Close form"]'],
  ])('leaves native Enter activation on the %s button intact', (_label, selector) => {
    const action = controller('en');
    const operation = host();
    action.onInvoke(operation);
    const button = form().querySelector<HTMLButtonElement>(selector)!;
    button.focus();

    const keydown = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    button.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(false);
    expect(operation.confirm).not.toHaveBeenCalled();

    // happy-dom does not synthesize the browser's keyboard click from keydown.
    button.click();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(operation.confirm).not.toHaveBeenCalled();
    expect(operation.cancel).toHaveBeenCalledOnce();
  });

  it('lets Enter natively activate Save and submit the formula once', () => {
    const action = controller('en');
    const operation = host();
    action.onInvoke(operation);
    const input = form().querySelector<HTMLInputElement>('label[for$="-formula"] input')!;
    input.value = '2 + 3';
    const saveButton = form().querySelector<HTMLButtonElement>('button[type="submit"]')!;
    saveButton.focus();

    const keydown = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    saveButton.dispatchEvent(keydown);
    expect(keydown.defaultPrevented).toBe(false);
    expect(operation.confirm).not.toHaveBeenCalled();

    // happy-dom does not synthesize the browser's keyboard click from keydown.
    saveButton.click();
    expect(operation.confirm).toHaveBeenCalledWith({ formula: '2 + 3' });
    expect(operation.confirm).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(operation.cancel).not.toHaveBeenCalled();
  });

  it('does not submit while Enter is confirming IME composition', () => {
    const action = controller('en');
    const operation = host();
    action.onInvoke(operation);
    const input = form().querySelector<HTMLInputElement>('label[for$="-formula"] input')!;
    input.value = '2 + 3';
    input.focus();

    const keydown = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(keydown);

    expect(keydown.defaultPrevented).toBe(false);
    expect(operation.confirm).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('submits Enter from an input once and suppresses held-key repeats', () => {
    const action = controller('en');
    const operation = host({ ok: false, reason: 'invalid-input' });
    action.onInvoke(operation);
    const input = form().querySelector<HTMLInputElement>('label[for$="-formula"] input')!;
    input.value = '2 + 3';

    const initial = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(initial);
    expect(initial.defaultPrevented).toBe(true);
    expect(operation.confirm).toHaveBeenCalledOnce();

    const repeat = new KeyboardEvent('keydown', {
      key: 'Enter',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(repeat);
    expect(repeat.defaultPrevented).toBe(true);
    expect(operation.confirm).toHaveBeenCalledOnce();
  });

  it('cancels on Escape, preserves the active dialog on a repeated invocation, and disposes cleanly', () => {
    const action = controller('en');
    const first = host();
    const repeated = host();
    action.onInvoke(first);
    const input = form().querySelector<HTMLInputElement>('label[for$="-formula"] input')!;
    input.value = '2 + 3';
    action.onInvoke(repeated);
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.activeElement).toBe(input);
    expect(repeated.cancel).toHaveBeenCalledOnce();

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.confirm).not.toHaveBeenCalled();

    const third = host();
    action.onInvoke(third);
    action.dispose();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(third.cancel).toHaveBeenCalledOnce();
  });

  it('does not restore focus to a connected editor when the host says its captured pane is no longer current', () => {
    const returnButton = document.createElement('button');
    returnButton.textContent = 'Old pane';
    document.body.append(returnButton);
    returnButton.focus();
    const action = controller('en');
    const operation = host({ ok: true }, false);
    action.onInvoke(operation);

    form().querySelector<HTMLButtonElement>('footer button[type="button"]')!.click();
    expect(operation.canRestoreFocus).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(returnButton);
  });

  it('keeps the form labels in each app locale while the formula language stays the same', () => {
    expect(formulaAuthoringMessages('pt').formulaLabel).toBe('Fórmula');
    expect(formulaAuthoringMessages('en').formulaLabel).toBe('Formula');
    expect(formulaAuthoringMessages('es').formulaLabel).toBe('Fórmula');
    expect(formulaAuthoringMessages('pt').slashKeywords).toContain('formula');
  });
});
