import type { Editor } from '@tiptap/core';
import type { FormulaReferenceBinding, PageId, PropertyFormat } from '../../core/model';
import type { CalculatedResultEditTarget } from './calculatedResultSupport';

export type CalculatedResultOutputType =
  | 'auto'
  | 'text'
  | 'number'
  | 'currency'
  | 'percent'
  | 'scale'
  | 'progress'
  | 'date'
  | 'checkbox';

export interface CalculatedResultConfigurationDraft {
  name: string;
  outputType: CalculatedResultOutputType;
  format: PropertyFormat;
}

/**
 * An active, unsaved result edit. `target` is the original conflict snapshot;
 * the other fields are mutable editor state and must never replace that snapshot.
 */
export interface CalculatedResultDraftSnapshot {
  target: CalculatedResultEditTarget;
  config: CalculatedResultConfigurationDraft;
  formula: string;
  bindings: FormulaReferenceBinding[];
}

export interface CalculatedResultFormulaDraftSeed {
  source: string;
  bindings: FormulaReferenceBinding[];
}

interface ResultNodeLike {
  type: { name: string };
  attrs: Record<string, unknown>;
}

interface OwnerDrafts {
  pages: Map<PageId, Map<string, CalculatedResultDraftSnapshot>>;
  onTransaction: (event: {
    transaction: { docChanged: boolean };
    appendedTransactions?: Array<{ docChanged: boolean }>;
  }) => void;
  onDestroy: () => void;
}

const draftsByOwner = new WeakMap<Editor, OwnerDrafts>();

function cloneSnapshot(snapshot: CalculatedResultDraftSnapshot): CalculatedResultDraftSnapshot {
  return {
    target: { ...snapshot.target },
    config: { ...snapshot.config, format: { ...snapshot.config.format } },
    formula: snapshot.formula,
    bindings: snapshot.bindings.map((binding) => ({ ...binding })),
  };
}

function ownerPageDrafts(ownerDrafts: OwnerDrafts, pageId: PageId, create: boolean): Map<string, CalculatedResultDraftSnapshot> | undefined {
  let pageDrafts = ownerDrafts.pages.get(pageId);
  if (!pageDrafts && create) {
    pageDrafts = new Map();
    ownerDrafts.pages.set(pageId, pageDrafts);
  }
  return pageDrafts;
}

function hasResult(editor: Editor, pageId: PageId, resultId: string): boolean {
  let found = false;
  editor.state.doc.descendants((node: ResultNodeLike) => {
    if (
      node.type.name === 'calculatedResult' &&
      node.attrs.resultId === resultId &&
      (typeof node.attrs.pageId === 'string' && node.attrs.pageId.length > 0
        ? node.attrs.pageId
        : pageId) === pageId
    ) {
      found = true;
      return false;
    }
    return !found;
  });
  return found;
}

function detachOwner(editor: Editor, ownerDrafts: OwnerDrafts): void {
  if (!editor.isDestroyed) {
    editor.off('transaction', ownerDrafts.onTransaction);
    editor.off('destroy', ownerDrafts.onDestroy);
  }
  draftsByOwner.delete(editor);
}

function ownerDraftsFor(editor: Editor): OwnerDrafts {
  const existing = draftsByOwner.get(editor);
  if (existing) return existing;

  const ownerDrafts: OwnerDrafts = {
    pages: new Map(),
    onTransaction: () => undefined,
    onDestroy: () => undefined,
  };
  ownerDrafts.onTransaction = ({ transaction, appendedTransactions = [] }) => {
    if (!transaction.docChanged && !appendedTransactions.some((item) => item.docChanged)) return;
    for (const [pageId, pageDrafts] of ownerDrafts.pages) {
      for (const resultId of pageDrafts.keys()) {
        if (!hasResult(editor, pageId, resultId)) pageDrafts.delete(resultId);
      }
      if (!pageDrafts.size) ownerDrafts.pages.delete(pageId);
    }
    if (!ownerDrafts.pages.size) detachOwner(editor, ownerDrafts);
  };
  ownerDrafts.onDestroy = () => {
    ownerDrafts.pages.clear();
    detachOwner(editor, ownerDrafts);
  };

  draftsByOwner.set(editor, ownerDrafts);
  editor.on('transaction', ownerDrafts.onTransaction);
  editor.on('destroy', ownerDrafts.onDestroy);
  return ownerDrafts;
}

export function readCalculatedResultDraft(
  owner: Editor,
  pageId: PageId,
  resultId: string,
): CalculatedResultDraftSnapshot | null {
  if (owner.isDestroyed) return null;
  const snapshot = draftsByOwner.get(owner)?.pages.get(pageId)?.get(resultId);
  return snapshot ? cloneSnapshot(snapshot) : null;
}

export function writeCalculatedResultDraft(snapshot: CalculatedResultDraftSnapshot): void {
  const owner = snapshot.target.owner as Editor;
  if (owner.isDestroyed) return;
  const existingOwnerDrafts = draftsByOwner.get(owner);
  const alreadyTracked = existingOwnerDrafts
    ?.pages.get(snapshot.target.pageId)
    ?.has(snapshot.target.resultId) ?? false;
  if (!alreadyTracked && !hasResult(owner, snapshot.target.pageId, snapshot.target.resultId)) return;
  const ownerDrafts = existingOwnerDrafts ?? ownerDraftsFor(owner);
  const previous = ownerPageDrafts(ownerDrafts, snapshot.target.pageId, false)?.get(snapshot.target.resultId);
  const next = previous ? { ...snapshot, target: previous.target } : snapshot;
  ownerPageDrafts(ownerDrafts, snapshot.target.pageId, true)!.set(
    snapshot.target.resultId,
    cloneSnapshot(next),
  );
}

export function clearCalculatedResultDraft(
  owner: Editor,
  pageId: PageId,
  resultId: string,
): void {
  const ownerDrafts = draftsByOwner.get(owner);
  if (!ownerDrafts) return;
  const pageDrafts = ownerPageDrafts(ownerDrafts, pageId, false);
  pageDrafts?.delete(resultId);
  if (pageDrafts && !pageDrafts.size) ownerDrafts.pages.delete(pageId);
  if (!ownerDrafts.pages.size) detachOwner(owner, ownerDrafts);
}

export function calculatedResultFormulaDraftSeed(
  session: Pick<CalculatedResultDraftSnapshot, 'formula' | 'bindings'> | null,
  persistedFormula: string,
  persistedBindings: FormulaReferenceBinding[],
): CalculatedResultFormulaDraftSeed {
  const source = session?.formula ?? persistedFormula;
  const bindings = session?.bindings ?? persistedBindings;
  return { source, bindings: bindings.map((binding) => ({ ...binding })) };
}
