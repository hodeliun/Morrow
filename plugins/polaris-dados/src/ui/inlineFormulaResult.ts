import type { PluginInlineFormulaPresentationContext } from '../../../../src/app/plugins/registry';
import type { FormulaRuntimeValue } from '../engine/formula';
import { computeRuntimeFormula } from '../engine/formula';
import { providerMessages } from './locale';
import { formatFormulaNumber } from './numberFormatting';

type DisplayResult = { readonly kind: 'value'; readonly text: string } | { readonly kind: 'unsupported' };

function publishedDefaultFormatLocale(): string {
  return typeof navigator === 'undefined' ? 'en-US' : navigator.language;
}

/** Formats only legacy result cases whose published display rules can be reproduced here. */
export function formatInlineFormulaValue(
  value: FormulaRuntimeValue,
  context: PluginInlineFormulaPresentationContext,
): DisplayResult {
  const messages = providerMessages(context.locale);
  if (value === null || value === '') return { kind: 'value', text: '[]' };
  if (Array.isArray(value))
    return value.length === 0
      ? { kind: 'value', text: '[]' }
      : { kind: 'unsupported' };
  if (typeof value === 'object') return { kind: 'unsupported' };

  const format = context.format;
  if (!format) return { kind: 'unsupported' };
  switch (context.outputType) {
    case 'auto':
    case 'text': {
      if (Object.keys(format).some((key) => !['locale', 'currency', 'precision', 'negativeFormat'].includes(key)))
        return { kind: 'unsupported' };
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return { kind: 'unsupported' };
        const formatLocale = format.locale ??
          (context.outputType === 'auto' || context.outputType === 'text' ? publishedDefaultFormatLocale() : context.locale);
        if (format.currency) {
          return {
            kind: 'value',
            text: formatFormulaNumber(value, format, 'currency', formatLocale, 2, 'BRL'),
          };
        }
        if (format.precision !== undefined) {
          return { kind: 'value', text: formatFormulaNumber(value, format, 'decimal', formatLocale, format.precision) };
        }
        const scaled = value * 1e6;
        return { kind: 'value', text: String(Number.isFinite(scaled) ? Math.round(scaled) / 1e6 : value) };
      }
      if (typeof value === 'boolean') return { kind: 'value', text: value ? messages.inlineFormulaTrue : messages.inlineFormulaFalse };
      return { kind: 'value', text: value };
    }
    case 'number':
    case 'currency':
    case 'percent': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { kind: 'unsupported' };
      const style = context.outputType === 'currency' ? 'currency' : context.outputType === 'percent' ? 'percent' : 'decimal';
      const effectiveFormat = {
        ...format,
        locale: format.locale ?? 'pt-BR',
        precision: format.precision ?? 2,
      };
      const text = formatFormulaNumber(value, effectiveFormat, style, 'pt-BR', 2, 'BRL');
      return { kind: 'value', text };
    }
    case 'checkbox':
      if (Object.keys(format).length > 0 || typeof value !== 'boolean') return { kind: 'unsupported' };
      return { kind: 'value', text: value ? messages.inlineFormulaTrue : messages.inlineFormulaFalse };
    case 'date': {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return { kind: 'unsupported' };
      if (Object.keys(format).some((key) => key !== 'locale' && key !== 'dateStyle')) return { kind: 'unsupported' };
      const [year, month, day] = value.split('-').map(Number);
      const date = new Date(0);
      date.setUTCFullYear(year!, month! - 1, day!);
      date.setUTCHours(0, 0, 0, 0);
      if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month! - 1 ||
        date.getUTCDate() !== day
      ) return { kind: 'unsupported' };
      try {
        const text = new Intl.DateTimeFormat(format.locale ?? publishedDefaultFormatLocale(), {
          dateStyle: format.dateStyle ?? 'medium',
          timeZone: 'UTC',
        }).format(date);
        return { kind: 'value', text };
      } catch {
        return { kind: 'unsupported' };
      }
    }
    default:
      return { kind: 'unsupported' };
  }
}

/** Mounts a text-only view; the host retains the marker and owns fallback restoration. */
export function mountInlineFormulaResult(
  container: HTMLElement,
  context: PluginInlineFormulaPresentationContext,
): () => void {
  const messages = providerMessages(context.locale);
  const showFallback = (state: 'unconfigured' | 'error' | 'unsupported', diagnosis: string) => {
    container.textContent = context.fallback;
    container.dataset.inlineFormulaState = state;
    container.setAttribute('aria-label', `${context.fallback}. ${diagnosis}`);
    container.setAttribute('title', diagnosis);
  };

  if (!context.formula.trim()) {
    showFallback('unconfigured', messages.inlineFormulaNotConfigured);
  } else {
    const evaluated = computeRuntimeFormula(context.formula, {});
    if (evaluated.error) {
      showFallback('error', messages.inlineFormulaErrorDetail(evaluated.error));
    } else {
      const display = formatInlineFormulaValue(evaluated.value, context);
      if (display.kind === 'unsupported') {
        showFallback('unsupported', messages.inlineFormulaUnsupported);
      } else {
        container.textContent = display.text;
        container.dataset.inlineFormulaState = 'calculated';
        container.setAttribute('aria-label', `${messages.inlineFormulaResult}: ${display.text}`);
        container.removeAttribute('title');
      }
    }
  }

  return () => {
    container.textContent = context.fallback;
    delete container.dataset.inlineFormulaState;
    container.removeAttribute('aria-label');
    container.removeAttribute('title');
  };
}
