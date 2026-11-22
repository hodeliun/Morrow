// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginInlineFormulaPresentationContext } from '../../../../src/app/plugins/registry';
import { formatInlineFormulaValue, mountInlineFormulaResult } from './inlineFormulaResult';

function context(
  formula: string,
  changes: Partial<PluginInlineFormulaPresentationContext> = {},
): PluginInlineFormulaPresentationContext {
  return {
    formula,
    outputType: 'auto',
    format: {},
    fallback: 'Original result',
    locale: 'en',
    ...changes,
  };
}

function render(formula: string, changes: Partial<PluginInlineFormulaPresentationContext> = {}) {
  const element = document.createElement('span');
  const removePresentation = mountInlineFormulaResult(element, context(formula, changes));
  document.body.append(element);
  return {
    element,
    cleanup: () => {
      removePresentation();
      element.remove();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Polaris Dados inline scalar result presentation', () => {
  it.each([
    ['0', '0'],
    ['false', 'No'],
    ['""', '[]'],
    ['[]', '[]'],
    ['null', '[]'],
  ])('distinguishes formula result %s', (formula, expected) => {
    const { element, cleanup } = render(formula);

    expect(element.textContent).toBe(expected);
    expect(element.dataset.inlineFormulaState).toBe('calculated');
    expect(element.getAttribute('aria-label')).toBe(`Formula result: ${expected}`);
    cleanup();
  });

  it('keeps fallback text for missing configuration, errors, unsupported types and non-scalar values', () => {
    const noConfig = render('');
    expect(noConfig.element.textContent).toBe('Original result');
    expect(noConfig.element.dataset.inlineFormulaState).toBe('unconfigured');
    expect(noConfig.element.getAttribute('aria-label')).toContain('Formula not configured');

    const error = render('1 +');
    expect(error.element.textContent).toBe('Original result');
    expect(error.element.dataset.inlineFormulaState).toBe('error');
    expect(error.element.getAttribute('aria-label')).toContain('Formula error:');

    const unsupported = render('1 + 2', { outputType: 'progress' });
    expect(unsupported.element.textContent).toBe('Original result');
    expect(unsupported.element.dataset.inlineFormulaState).toBe('unsupported');

    const list = render('[1, 2]');
    expect(list.element.textContent).toBe('Original result');
    expect(list.element.dataset.inlineFormulaState).toBe('unsupported');
    const emptyWithUnrecognizedFormat = render('null', { format: null });
    expect(emptyWithUnrecognizedFormat.element.textContent).toBe('[]');
    expect(emptyWithUnrecognizedFormat.element.dataset.inlineFormulaState).toBe('calculated');
    noConfig.cleanup();
    error.cleanup();
    unsupported.cleanup();
    list.cleanup();
    emptyWithUnrecognizedFormat.cleanup();
  });

  it('uses plain text for formula strings and restores the exact fallback on cleanup', () => {
    const source = '"<img src=x onerror=alert(1)>"';
    const { element, cleanup } = render(source);

    expect(element.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(element.querySelector('img')).toBeNull();
    cleanup();
    expect(element.textContent).toBe('Original result');
    expect(element.hasAttribute('aria-label')).toBe(false);
  });

  it('offers an edit action for eligible calculated and fallback results', () => {
    const onEdit = vi.fn();
    const { element, cleanup } = render('2 + 3', { onEdit });
    const button = element.querySelector<HTMLButtonElement>('button[aria-label="Edit formula"]');
    expect(element.textContent).toBe('5');
    expect(button).not.toBeNull();
    expect(button?.type).toBe('button');
    button?.focus();
    expect(document.activeElement).toBe(button);
    button?.click();
    expect(onEdit).toHaveBeenCalledOnce();
    cleanup();
    expect(element.querySelector('button')).toBeNull();
    expect(element.textContent).toBe('Original result');

    const invalidEdit = vi.fn();
    const invalid = render('1 +', { onEdit: invalidEdit });
    expect(invalid.element.querySelector<HTMLButtonElement>('button[aria-label="Edit formula"]')).not.toBeNull();
    expect(invalid.element.dataset.inlineFormulaState).toBe('error');
    invalid.element.querySelector<HTMLButtonElement>('button')!.click();
    expect(invalidEdit).toHaveBeenCalledOnce();
    invalid.cleanup();

    const unconfigured = render('', { onEdit: vi.fn() });
    expect(unconfigured.element.dataset.inlineFormulaState).toBe('unconfigured');
    expect(unconfigured.element.querySelector('button[aria-label="Edit formula"]')).not.toBeNull();
    unconfigured.cleanup();

    const unsupportedEdit = vi.fn();
    const unsupported = render('[1, 2]', { onEdit: unsupportedEdit });
    expect(unsupported.element.dataset.inlineFormulaState).toBe('unsupported');
    expect(unsupported.element.querySelector('button[aria-label="Edit formula"]')).not.toBeNull();
    unsupported.cleanup();
  });

  it('reuses number and date format settings only for supported scalar shapes', () => {
    const number = formatInlineFormulaValue(12.5, context('12.5', {
      outputType: 'number',
      format: { locale: 'en-US', precision: 1 },
    }));
    const date = formatInlineFormulaValue('2026-11-22', context('"2026-11-22"', {
      outputType: 'date',
      format: { dateStyle: 'short' },
    }));
    expect(number).toEqual({ kind: 'value', text: '12.5' });
    expect(date.kind).toBe('value');
    expect(formatInlineFormulaValue('not a date', context('"not a date"', { outputType: 'date', format: {} })))
      .toEqual({ kind: 'unsupported' });
  });

  it('matches published decimal, currency, percent and checkbox scalar formats', () => {
    expect(formatInlineFormulaValue(0, context('0', {
      outputType: 'number',
      format: { locale: 'en-US', precision: 0 },
    }))).toEqual({ kind: 'value', text: '0' });
    expect(formatInlineFormulaValue(-1.2, context('-1.2', {
      outputType: 'currency',
      format: { locale: 'en-US', currency: 'USD', precision: 2, negativeFormat: 'parentheses' },
    }))).toEqual({ kind: 'value', text: '($1.20)' });
    expect(formatInlineFormulaValue(0.5, context('0.5', {
      outputType: 'percent',
      format: { locale: 'en-US', precision: 0 },
    }))).toEqual({ kind: 'value', text: '50%' });
    expect(formatInlineFormulaValue(false, context('false', { outputType: 'checkbox' })))
      .toEqual({ kind: 'value', text: 'No' });
  });

  it('uses the browser locale for published auto/text numeric and date formats, while messages follow the app locale', () => {
    vi.stubGlobal('navigator', { language: 'en-US' });

    expect(formatInlineFormulaValue(12.5, context('12.5', {
      outputType: 'auto',
      format: { precision: 2 },
      locale: 'pt',
    }))).toEqual({ kind: 'value', text: '12.50' });
    expect(formatInlineFormulaValue(12.5, context('12.5', {
      outputType: 'auto',
      format: { currency: 'USD', precision: 2 },
      locale: 'pt',
    }))).toEqual({ kind: 'value', text: '$12.50' });
    expect(formatInlineFormulaValue(12.5, context('12.5', {
      outputType: 'text',
      format: { precision: 2 },
      locale: 'pt',
    }))).toEqual({ kind: 'value', text: '12.50' });
    expect(formatInlineFormulaValue(12.5, context('12.5', {
      outputType: 'text',
      format: { currency: 'USD', precision: 2 },
      locale: 'pt',
    }))).toEqual({ kind: 'value', text: '$12.50' });
    expect(formatInlineFormulaValue('2026-11-22', context('"2026-11-22"', {
      outputType: 'date',
      format: { dateStyle: 'short' },
      locale: 'pt',
    }))).toEqual({ kind: 'value', text: '11/22/26' });

    expect(formatInlineFormulaValue(12.5, context('12.5', {
      outputType: 'auto',
      format: { locale: 'pt-BR', precision: 2 },
      locale: 'en',
    }))).toEqual({ kind: 'value', text: '12,50' });
    expect(formatInlineFormulaValue('2026-11-22', context('"2026-11-22"', {
      outputType: 'date',
      format: { locale: 'pt-BR', dateStyle: 'short' },
      locale: 'en',
    }))).toEqual({ kind: 'value', text: '22/11/2026' });

    expect(formatInlineFormulaValue(false, context('false', {
      outputType: 'checkbox',
      format: {},
      locale: 'pt',
    }))).toEqual({ kind: 'value', text: 'Não' });
    const unconfigured = render('', { locale: 'pt' });
    const error = render('1 +', { locale: 'pt' });
    expect(unconfigured.element.getAttribute('aria-label')).toContain('Fórmula sem configuração');
    expect(error.element.getAttribute('aria-label')).toContain('Erro de fórmula');
    unconfigured.cleanup();
    error.cleanup();
  });

  it('localizes boolean results and preserves the published empty display', () => {
    const falseValue = render('false', { locale: 'pt' });
    const emptyList = render('[]', { locale: 'es' });
    expect(falseValue.element.textContent).toBe('Não');
    expect(emptyList.element.textContent).toBe('[]');
    falseValue.cleanup();
    emptyList.cleanup();
  });

  it('does not overflow while matching formula-number rounding for very large values', () => {
    const result = formatInlineFormulaValue(Number.MAX_VALUE, context('large'));
    expect(result).toEqual({ kind: 'value', text: String(Number.MAX_VALUE) });
  });
});
