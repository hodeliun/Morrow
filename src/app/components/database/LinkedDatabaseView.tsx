import { ArrowUpRight, ChevronDown, ChevronRight, Eye, Trash2 } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useCallback, useEffect, useState } from 'react';
import { newView } from '../../../core/database';
import { linkedViewSourceError, wouldCreateLinkedViewCycle } from '../../../core/linkedViews';
import type { DatabaseDef, ViewDef } from '../../../core/model';
import { isEffectivelyTrashed } from '../../../core/tree';
import { newId } from '../../platform/files';
import { openPage } from '../../router';
import { useWorkspace } from '../../workspace';
import { PageIcon } from '../Sidebar';
import { DatabaseView } from './DatabaseView';
import { DraftInput } from './PropertyValue';
import { t } from '../../i18n';
import { displayTitle } from '../../../core/model';

type EditableEditor = Pick<Editor, 'isEditable' | 'isDestroyed' | 'view' | 'on' | 'off'>;

export function linkedViewCollapseEnabled(view: ViewDef | null): boolean {
  return view !== null && view.collapseEnabled !== false;
}

export function withLinkedViewCollapseEnabled<T extends object>(
  view: T,
  enabled: boolean,
): T & { collapseEnabled: boolean } {
  return { ...view, collapseEnabled: enabled };
}

export function linkedViewSourceSelectionAttributes(
  hostPageId: string,
  sourceDatabaseId: string,
  blockId: string,
  view: ViewDef,
) {
  return { hostPageId, sourceDatabaseId, blockId, view, viewRawState: null };
}

export function subscribeToEditorEditable(
  editor: EditableEditor,
  onChange: (editable: boolean) => void,
): () => void {
  let previous: boolean | null = null;
  const sync = () => {
    if (editor.isDestroyed || previous === editor.isEditable) return;
    previous = editor.isEditable;
    onChange(previous);
  };

  editor.on('update', sync);
  const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sync);
  observer?.observe(editor.view.dom, { attributes: true, attributeFilter: ['contenteditable'] });
  sync();

  return () => {
    editor.off('update', sync);
    observer?.disconnect();
  };
}

function useEditorEditable(editor: EditableEditor): { editable: boolean; revision: number } {
  const [state, setState] = useState(() => ({ editable: editor.isEditable, revision: 0 }));

  useEffect(
    () =>
      subscribeToEditorEditable(editor, (editable) => {
        setState((previous) =>
          previous.editable === editable ? previous : { editable, revision: previous.revision + 1 },
        );
      }),
    [editor],
  );

  return state;
}

export function runIfEditorEditable(
  editor: Pick<Editor, 'isEditable'>,
  action: () => void,
  canEditNow?: () => boolean,
): boolean {
  if (canEditNow ? !canEditNow() : !editor.isEditable) return false;
  action();
  return true;
}

export function runLinkedViewLayoutAction(
  editor: Pick<Editor, 'isEditable'> & Partial<Pick<Editor, 'isDestroyed'>>,
  persist: () => void,
  keepLocal: () => void,
  canEditNow?: () => boolean,
): void {
  if (canEditNow ? canEditNow() : editor.isEditable) persist();
  else if (!editor.isDestroyed) keepLocal();
}

export function LinkedDatabaseViewNode({
  node,
  editor,
  extension,
  updateAttributes,
  deleteNode,
}: NodeViewProps) {
  const state = useWorkspace();
  const extensionHost = (extension.options as { hostPageId?: unknown }).hostPageId;
  const hostPageId =
    typeof extensionHost === 'string' && extensionHost
      ? extensionHost
      : typeof node.attrs.hostPageId === 'string'
        ? node.attrs.hostPageId
        : '';
  const blockId = typeof node.attrs.blockId === 'string' ? node.attrs.blockId : null;
  const editableState = useEditorEditable(editor);
  const canEditNow = useCallback(() => !editor.isDestroyed && editor.isEditable, [editor]);
  const sourceId = typeof node.attrs.sourceDatabaseId === 'string' ? node.attrs.sourceDatabaseId : null;
  const source = sourceId ? state.pages[sourceId] : undefined;
  const view = node.attrs.view && typeof node.attrs.view === 'object' ? (node.attrs.view as ViewDef) : null;
  const collapseEnabled = linkedViewCollapseEnabled(view);
  const [localLayout, setLocalLayout] = useState<{
    blockId: string | null;
    revision: number;
    hideTitle: boolean | null;
    collapsed: boolean | null;
  }>({ blockId, revision: editableState.revision, hideTitle: null, collapsed: null });
  const localLayoutApplies =
    !editableState.editable &&
    localLayout.blockId === blockId &&
    localLayout.revision === editableState.revision;
  const hideTitle =
    localLayoutApplies && localLayout.hideTitle !== null ? localLayout.hideTitle : view?.hideTitle === true;
  const collapsed = collapseEnabled
    ? localLayoutApplies && localLayout.collapsed !== null
      ? localLayout.collapsed
      : view?.collapsed === true
    : false;
  const displayView = view ? { ...view, hideTitle, collapsed } : null;

  const updateLocalLayout = (change: Partial<Pick<typeof localLayout, 'hideTitle' | 'collapsed'>>) => {
    setLocalLayout((previous) => {
      const base =
        previous.blockId === blockId && previous.revision === editableState.revision
          ? previous
          : { blockId, revision: editableState.revision, hideTitle: null, collapsed: null };
      return { ...base, ...change };
    });
  };

  const candidates = Object.values(state.pages).filter(
    (page) =>
      page.kind === 'database' &&
      page.database &&
      !isEffectivelyTrashed(state.pages, page.id) &&
      !wouldCreateLinkedViewCycle(state, hostPageId, page.id, blockId),
  );
  const issue = sourceId ? linkedViewSourceError(state, hostPageId, sourceId, blockId) : null;
  const readableIssue = issue
    ? issue.includes('recursive')
      ? t('database.recursiveView')
      : t('database.sourceUnavailable')
    : null;
  const selectSource = (id: string) => {
    runIfEditorEditable(
      editor,
      () => {
        const database = state.pages[id]?.database as DatabaseDef | undefined;
        if (!database) return;
        const linkedView = newView('table', database, newId);
        linkedView.name = t('database.linkedView');
        updateAttributes(linkedViewSourceSelectionAttributes(hostPageId, id, blockId ?? newId(), linkedView));
      },
      canEditNow,
    );
  };

  const toggleCollapsed = () => {
    if (!view || !collapseEnabled) return;
    const nextCollapsed = !collapsed;
    runLinkedViewLayoutAction(
      editor,
      () => updateAttributes({ view: { ...view, collapsed: nextCollapsed } }),
      () => updateLocalLayout({ collapsed: nextCollapsed }),
      canEditNow,
    );
  };

  const showTitle = () => {
    if (!view) return;
    runLinkedViewLayoutAction(
      editor,
      () => updateAttributes({ view: { ...view, hideTitle: false } }),
      () => updateLocalLayout({ hideTitle: false }),
      canEditNow,
    );
  };

  return (
    <NodeViewWrapper className="linked-database-block" contentEditable={false}>
      <section className="linked-database-view" aria-label={t('database.linkedView')}>
        <header className="linked-database-head">
          {view && collapseEnabled && (
            <button
              type="button"
              className="icon-button tiny linked-database-collapse"
              aria-label={collapsed ? t('database.expandDatabase') : t('database.collapseDatabase')}
              title={collapsed ? t('database.expandDatabase') : t('database.collapseDatabase')}
              onClick={toggleCollapsed}
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
          {hideTitle ? (
            <button
              type="button"
              className="inline-database-hidden-title-trigger"
              onClick={showTitle}
              title={t('database.showTitle')}
              aria-label={t('database.showTitle')}
            >
              <Eye size={13} />
              <span>{t('database.showTitle')}</span>
            </button>
          ) : source ? (
            <button type="button" className="linked-database-source" onClick={() => openPage(source.id)}>
              <PageIcon page={source} />
              <span>{displayTitle(source)}</span>
              <ArrowUpRight size={14} />
            </button>
          ) : (
            <strong>{t('database.linkedView')}</strong>
          )}
          {hideTitle && source && (
            <button
              type="button"
              className="icon-button small linked-database-open-source"
              title={t('database.openSourceDatabase')}
              aria-label={t('database.openSourceDatabase')}
              onClick={() => openPage(source.id)}
            >
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          )}
          {!hideTitle && source && view && editableState.editable && (
            <DraftInput
              type="text"
              label={t('database.viewName')}
              className="text-input small linked-database-name"
              value={view.name}
              editable
              onCommit={(name) =>
                runIfEditorEditable(
                  editor,
                  () => updateAttributes({ view: { ...view, name: name.trim() || t('database.linkedView') } }),
                  canEditNow,
                )
              }
            />
          )}
          {editableState.editable && (!hideTitle || !source) && (
            <select
              className="text-input small linked-database-picker"
              aria-label={t('database.chooseSource')}
              value={sourceId ?? ''}
              onChange={(event) => selectSource(event.target.value)}
            >
              <option value="">{t('database.chooseSource')}</option>
              {source && !candidates.some((candidate) => candidate.id === source.id) && (
                <option value={source.id}>{displayTitle(source)}</option>
              )}
              {candidates.map((page) => (
                <option key={page.id} value={page.id}>
                  {displayTitle(page)}
                </option>
              ))}
            </select>
          )}
          {editableState.editable && (
            <button
              type="button"
              className="icon-button small"
              title={t('database.removeLinkedView')}
              aria-label={t('database.removeLinkedView')}
              onClick={() => runIfEditorEditable(editor, deleteNode, canEditNow)}
            >
              <Trash2 size={14} />
            </button>
          )}
        </header>
        {readableIssue ? (
          <p className="db-readonly-note" role="status">
            {readableIssue}
          </p>
        ) : source?.database && displayView && !collapsed ? (
          <DatabaseView
            page={source}
            editable={editableState.editable}
            canEditNow={canEditNow}
            hostPageId={hostPageId}
            embeddedView={displayView}
            onEmbeddedViewChange={(change) =>
              runIfEditorEditable(
                editor,
                () => {
                  if (view) updateAttributes({ view: change(view) });
                },
                canEditNow,
              )
            }
          />
        ) : !source?.database && !issue ? (
          <p className="muted db-hint">{t('database.chooseSourceHint')}</p>
        ) : null}
      </section>
    </NodeViewWrapper>
  );
}
