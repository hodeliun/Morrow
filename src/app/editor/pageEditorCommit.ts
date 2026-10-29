export type PageEditorDocumentUpdate<T> =
  { type: 'none' } | { type: 'track'; document: T } | { type: 'restore'; document: T };

export class PageEditorDocumentTracker<T> {
  private latestEditableDocument: T;
  private pending = false;

  constructor(initialDocument: T) {
    this.latestEditableDocument = initialDocument;
  }

  recordUpdate(editable: boolean, documentChanged: boolean, liveDocument: T): PageEditorDocumentUpdate<T> {
    if (!documentChanged) return { type: 'none' };
    if (!editable) return { type: 'restore', document: this.latestEditableDocument };
    this.latestEditableDocument = liveDocument;
    this.pending = true;
    return { type: 'track', document: liveDocument };
  }

  syncFromSource(document: T): void {
    this.latestEditableDocument = document;
    this.pending = false;
  }

  takePending(): { document: T } | null {
    if (!this.pending) return null;
    this.pending = false;
    return { document: this.latestEditableDocument };
  }
}
