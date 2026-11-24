import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';
import type { PageId } from '../../core/model';
import type { WorkspaceSession } from '../../storage/session';
import { selectedBlocks } from './BlockSelect';
import type { BlockRange } from './BlockSelect';
import { getPreferences, subscribePreferences } from '../platform/preferences';
import { parseRoute } from '../router';
import {
  isPaneTabVisible,
  paneIdForTabId,
  routeHashForPane,
  routeHashForTabId,
  subscribeTabs,
  targetPane,
} from '../tabs';
import type { PaneId } from '../tabs';
import { getSession, getWorkspaceSessionGeneration, subscribeWorkspaceSession } from '../workspace';

export interface BlockMenuOrigin {
  readonly editor: Editor;
  readonly doc: ProseMirrorNode;
  readonly selection: Selection;
  readonly blockSelection: Readonly<BlockRange> | null;
  readonly pageId: PageId;
  readonly paneId: PaneId;
  readonly tabId: string | null;
  readonly session: WorkspaceSession;
  readonly sessionGeneration: number;
}

/** Capture the exact editor, route owner, workspace session, and selection when the block menu opens. */
export function captureBlockMenuOrigin(
  editor: Editor,
  pageId: PageId,
  paneId: PaneId,
  tabId: string | null,
): BlockMenuOrigin | null {
  try {
    return {
      editor,
      doc: editor.state.doc,
      selection: editor.state.selection,
      blockSelection: (() => {
        const range = selectedBlocks(editor.state);
        return range ? { from: range.from, to: range.to } : null;
      })(),
      pageId,
      paneId,
      tabId,
      session: getSession(),
      sessionGeneration: getWorkspaceSessionGeneration(),
    };
  } catch {
    return null;
  }
}

/** The owner remains valid across its own background transaction, but not after a tab or pane switch. */
export function isBlockMenuOwnerCurrent(origin: BlockMenuOrigin): boolean {
  try {
    if (
      origin.editor.isDestroyed ||
      !origin.editor.isEditable ||
      getSession() !== origin.session ||
      getWorkspaceSessionGeneration() !== origin.sessionGeneration ||
      origin.session.isClosed ||
      origin.session.isMutationFenced ||
      getPreferences().readingMode ||
      targetPane() !== origin.paneId
    ) {
      return false;
    }
    if (origin.tabId !== null) {
      if (!isPaneTabVisible(origin.tabId) || paneIdForTabId(origin.tabId) !== origin.paneId) return false;
    }
    const hash = origin.tabId === null ? routeHashForPane(origin.paneId) : routeHashForTabId(origin.tabId);
    const route = parseRoute(hash);
    return route.name === 'page' && route.id === origin.pageId;
  } catch {
    return false;
  }
}

/** The initial request remains valid only while the original document and selection are unchanged. */
export function isBlockMenuRequestCurrent(origin: BlockMenuOrigin): boolean {
  if (
    !isBlockMenuOwnerCurrent(origin) ||
    origin.editor.state.doc !== origin.doc ||
    origin.editor.state.selection !== origin.selection
  ) {
    return false;
  }
  const currentBlockSelection = selectedBlocks(origin.editor.state);
  return (
    currentBlockSelection?.from === origin.blockSelection?.from &&
    currentBlockSelection?.to === origin.blockSelection?.to
  );
}

/** Listen to tab/layout mutations without subscribing to unrelated workspace state. */
export function subscribeBlockMenuOrigin(origin: BlockMenuOrigin, listener: () => void): () => void {
  const cleanups = [
    subscribeTabs(listener),
    subscribePreferences(listener),
    subscribeWorkspaceSession(listener),
    origin.session.subscribeMutationFence(listener),
    origin.session.onClose(listener),
  ];
  return () => {
    for (const cleanup of cleanups.reverse()) cleanup();
  };
}
