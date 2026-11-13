/** Stable public contract for asynchronous plugin editor insertions. */
export type PluginEditorInsertionFailureReason =
  | 'already-used'
  | 'document-changed'
  | 'empty-content'
  | 'invalid-markdown'
  | 'owner-ended'
  | 'peer-unavailable'
  | 'read-only'
  | 'selection-changed'
  | 'session-changed'
  | 'session-closed'
  | 'target-changed'
  | 'insert-rejected';

export type PluginEditorInsertionResultV1 =
  { readonly ok: true } | { readonly ok: false; readonly reason: PluginEditorInsertionFailureReason };

/** Opaque target captured before opening an asynchronous picker. */
export interface PluginEditorInsertionTargetV1 {
  readonly version: 1;
  /** Returns ok when the editor accepts the insertion; persistence follows the normal autosave path. */
  insert(markdown: string): PluginEditorInsertionResultV1;
  /** Releases the capture when a picker is cancelled or unmounted. */
  dispose(): void;
}

/** Versioned plugin-facing insertion capture capability. */
export interface PluginEditorInsertionApiV1 {
  readonly version: 1;
  /** Captures the active page editor, or returns null when there is no safe target. */
  capture(): PluginEditorInsertionTargetV1 | null;
}
