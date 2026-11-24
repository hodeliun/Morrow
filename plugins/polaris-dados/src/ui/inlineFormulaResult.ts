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
  let removeEditButtonListener: (() => void) | null = null;
  const appendEditButton = () => {
    if (!context.onEdit) return;
    const doc = container.ownerDocument;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'inline-formula-edit-action';
    button.setAttribute('aria-label', messages.inlineFormulaEdit);
    button.title = messages.inlineFormulaEdit;
    button.style.display = 'inline-flex';
    button.style.alignItems = 'center';
    button.style.justifyContent = 'center';
    button.style.width = '1.5em';
    button.style.height = '1.5em';
    button.style.marginInlineStart = '0.2em';
    button.style.verticalAlign = 'middle';
    const icon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.style.width = '1em';
    icon.style.height = '1em';
    const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 16.5V20h3.5L18.8 8.7l-3.5-3.5L4 16.5Zm13.9-9.8 1.4-1.4a1 1 0 0 0 0-1.4l-1.2-1.2a1 1 0 0 0-1.4 0l-1.4 1.4 2.6 2.6Z');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.7');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    icon.append(path);
    button.append(icon);
    const onClick = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      context.onEdit?.();
    };
    button.addEventListener('click', onClick);
    removeEditButtonListener = () => button.removeEventListener('click', onClick);
    container.append(button);
  };
  const showValue = (text: string) => {
    removeEditButtonListener?.();
    removeEditButtonListener = null;
    const output = container.ownerDocument.createElement('span');
    output.className = 'inline-formula-value';
    output.textContent = text;
    const name = context.name?.trim() ? context.name : null;
    if (name) {
      const label = container.ownerDocument.createElement('span');
      label.className = 'inline-formula-name';
      label.textContent = name;
      container.replaceChildren(label, container.ownerDocument.createTextNode(' '), output);
    } else {
      container.replaceChildren(output);
    }
    container.dataset.inlineFormulaState = 'calculated';
    container.setAttribute(
      'aria-label',
      `${messages.inlineFormulaResult}: ${name ? `${name} ` : ''}${text}`,
    );
    container.removeAttribute('title');
    appendEditButton();
  };
  const showFallback = (state: 'unconfigured' | 'error' | 'unsupported', diagnosis: string) => {
    removeEditButtonListener?.();
    removeEditButtonListener = null;
    container.replaceChildren();
    container.textContent = context.fallback;
    container.dataset.inlineFormulaState = state;
    container.setAttribute('aria-label', `${context.fallback}. ${diagnosis}`);
    container.setAttribute('title', diagnosis);
    appendEditButton();
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
        showValue(display.text);
      }
    }
  }

  return () => {
    removeEditButtonListener?.();
    removeEditButtonListener = null;
    container.textContent = context.fallback;
    delete container.dataset.inlineFormulaState;
    container.removeAttribute('aria-label');
    container.removeAttribute('title');
  };
}
