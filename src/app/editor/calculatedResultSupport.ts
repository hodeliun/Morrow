import { boundedNumericControlFormatError, normalizeControlFormat } from '../../core/controls';
import type { DocNode } from '../../core/model';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

const INLINE_PARENTS = new Set(['paragraph', 'heading', 'detailsSummary']);
const RESULT_ATTRS = new Set(['resultId', 'name', 'formula', 'bindings', 'outputType', 'format', 'pageId']);
const OUTPUT_TYPES = new Set(['auto', 'text', 'number', 'currency', 'percent', 'scale', 'progress', 'date', 'checkbox']);

type RecordValue = Record<string, unknown>;

export { calculatedResultFormatError } from './calculatedResultFormat';


export interface CalculatedResultEditTarget {
  owner: object;
  pageId: string;
  resultId: string;
  configSignature: string;
}

export function createCalculatedResultConfigurationTransaction(
  transaction: Transaction,
  position: number,
  node: ProseMirrorNode,
  attrs: Record<string, unknown>,
): Transaction {
  return closeHistory(transaction).setNodeMarkup(position, undefined, { ...node.attrs, ...attrs });
}

export function closeCalculatedResultConfigurationHistory(transaction: Transaction): Transaction {
  return closeHistory(transaction).setMeta('addToHistory', false);
}

interface CalculatedResultEditorLike {
  isDestroyed: boolean;
  isEditable: boolean;
  state: {
    doc: {
      nodeAt: (position: number) => { type: { name: string }; attrs: RecordValue } | null;
    };
  };
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validFormulaBinding(value: unknown, formula: string): boolean {
  if (!isRecord(value)) return false;
  const start = value.start;
  const end = value.end;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    (start as number) < 0 ||
    (end as number) <= (start as number) ||
    typeof value.source !== 'string' ||
    (end as number) > formula.length ||
    formula.slice(start as number, end as number) !== value.source
  ) return false;
  const common = ['start', 'end', 'source', 'kind'];
  const stringField = (key: string) => typeof value[key] === 'string' && Boolean(value[key]);
  let specific: string[];
  switch (value.kind) {
    case 'database':
      specific = ['databaseId'];
      break;
    case 'property':
      specific = ['databaseId', 'propertyId'];
      break;
    case 'control':
      specific = ['pageId', 'controlId'];
      break;
    case 'result':
      specific = ['pageId', 'resultId'];
      break;
    case 'ambiguous':
      specific = ['pageId'];
      break;
    default:
      return false;
  }
  return Object.keys(value).every((key) => common.includes(key) || specific.includes(key)) &&
    specific.every(stringField);
}

function validCalculatedResultAttrs(attrs: unknown): boolean {
  if (!isRecord(attrs) || Object.keys(attrs).some((key) => !RESULT_ATTRS.has(key))) return false;
  if (typeof attrs.resultId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(attrs.resultId)) return false;
  if (attrs.name !== undefined && (typeof attrs.name !== 'string' || attrs.name.length > 100)) return false;
  if (typeof attrs.formula !== 'string' || attrs.formula.length > 2000) return false;
  if (!Array.isArray(attrs.bindings) || !attrs.bindings.every((binding) => validFormulaBinding(binding, attrs.formula as string))) return false;
  if (attrs.outputType !== undefined && (typeof attrs.outputType !== 'string' || !OUTPUT_TYPES.has(attrs.outputType))) return false;
  const format = attrs.format === undefined ? {} : isRecord(attrs.format) ? normalizeControlFormat(attrs.format) : null;
  if (format === null) return false;
  if (attrs.outputType === 'scale' && boundedNumericControlFormatError('scale', format)) return false;
  if (attrs.pageId !== undefined && attrs.pageId !== null && typeof attrs.pageId !== 'string') return false;
  return true;
}

export function calculatedResultConfigSignature(attrs: RecordValue): string {
  return JSON.stringify([
    attrs.name ?? '',
    attrs.formula ?? '',
    attrs.bindings ?? [],
    attrs.outputType ?? 'auto',
    attrs.format ?? {},
  ]);
}

export function captureCalculatedResultEditTarget(
  owner: object,
  pageId: string,
  resultId: string,
  attrs: RecordValue,
): CalculatedResultEditTarget {
  return { owner, pageId, resultId, configSignature: calculatedResultConfigSignature(attrs) };
}

export function isCurrentCalculatedResultEditTarget(
  editor: CalculatedResultEditorLike,
  getPos: () => number | undefined,
  target: CalculatedResultEditTarget,
): boolean {
  if (editor !== target.owner || editor.isDestroyed || !editor.isEditable) return false;
  try {
    const position = getPos();
    if (typeof position !== 'number' || !Number.isInteger(position)) return false;
    const node = editor.state.doc.nodeAt(position);
    if (
      !node ||
      node.type.name !== 'calculatedResult' ||
      node.attrs.resultId !== target.resultId ||
      (typeof node.attrs.pageId === 'string' && node.attrs.pageId.length > 0
        ? node.attrs.pageId
        : target.pageId) !== target.pageId
    ) return false;
    return calculatedResultConfigSignature(node.attrs) === target.configSignature;
  } catch {
    return false;
  }
}

/**
 * The current editor can safely edit calculated results only as inline nodes with
 * the known attribute shape. Keep other persisted forms on PageView's readonly path
 * until a lossless editor representation exists.
 */
export function findUnsupportedCalculatedResultContent(doc: DocNode): string[] {
  const reasons = new Set<string>();
  const pending: Array<{ node: DocNode; parent: DocNode | null }> = [{ node: doc, parent: null }];
  while (pending.length) {
    const { node, parent } = pending.pop()!;
    if (node.type === 'calculatedResult') {
      if (!parent || !INLINE_PARENTS.has(parent.type)) reasons.add('calculatedResult block placement');
      if (!validCalculatedResultAttrs(node.attrs)) reasons.add('calculatedResult attributes');
    }
    for (const child of node.content ?? []) pending.push({ node: child, parent: node });
  }
  return [...reasons];
}

export function shouldRenderMarkdownSourceEditor(
  sourceModePageId: string | null,
  pageId: string,
  pageKind: string,
  hasUnsupportedContent: boolean,
): boolean {
  return sourceModePageId === pageId && pageKind === 'page' && !hasUnsupportedContent;
}
