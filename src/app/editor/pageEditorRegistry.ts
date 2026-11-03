import type { Editor } from '@tiptap/core';
import type { DocNode, PageId } from '../../core/model';

export interface PageEditorDocumentTarget {
  pageId: PageId;
  doc: DocNode;
}

type MatchesDocument = (doc: DocNode) => boolean;

interface EditorRegistration {
  editor: Editor;
  matchesDocument: MatchesDocument;
}

const editorsByPage = new Map<PageId, Map<Editor, EditorRegistration>>();

/** Register one live pane editor and remove only that registration on cleanup. */
export function registerPageEditor(
  pageId: PageId,
  editor: Editor,
  matchesDocument: MatchesDocument,
): () => void {
  const editors = editorsByPage.get(pageId) ?? new Map<Editor, EditorRegistration>();
  const registration = { editor, matchesDocument };
  editors.set(editor, registration);
  editorsByPage.set(pageId, editors);
  return () => {
    if (editors.get(editor) !== registration) return;
    editors.delete(editor);
    if (editors.size === 0) editorsByPage.delete(pageId);
  };
}

/** Check only currently registered pane editors for the affected pages. */
export function pageEditorsMatchDocuments(targets: readonly PageEditorDocumentTarget[]): boolean {
  for (const target of targets) {
    for (const { editor, matchesDocument } of editorsByPage.get(target.pageId)?.values() ?? []) {
      if (editor.isDestroyed) return false;
      try {
        if (!matchesDocument(target.doc)) return false;
      } catch {
        return false;
      }
    }
  }
  return true;
}
