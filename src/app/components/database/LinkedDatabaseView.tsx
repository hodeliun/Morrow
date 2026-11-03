import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import type { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { Fragment } from '@tiptap/pm/model';
import type { Node as ProseNode } from '@tiptap/pm/model';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CREATED_PROP, newView, TITLE_PROP, UPDATED_PROP } from '../../../core/database';
import { linkedViewSourceError, wouldCreateLinkedViewCycle } from '../../../core/linkedViews';
import type { DatabaseDef, DocNode, PageId, ViewDef } from '../../../core/model';
import { isEffectivelyTrashed } from '../../../core/tree';
import { sameTableActionValue } from '../../../storage/tableActions';
import { linkedViewConfigSnapshot, replaceLinkedViewConfig } from '../../../storage/viewHistoryCapture';
import { newId } from '../../platform/files';
import { openPage } from '../../router';
import { getSession, getState, useWorkspace } from '../../workspace';
import { commitEditors, stepLinkedViewContextualHistory } from '../../editor/commits';
import { pageEditorsMatchDocuments } from '../../editor/pageEditorRegistry';
import { DatabaseView } from './DatabaseView';
import { DraftInput } from './PropertyValue';
import { t, useTranslation } from '../../i18n';
import { displayTitle } from '../../../core/model';
import { confirmAction, toast } from '../../ui';

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

export interface LinkedViewSourceCompatibility {
  missingPropertyIds: string[];
  unverifiedPropertyIds: string[];
  previousSourcePropertyIds: string[];
  validationIncomplete: boolean;
}

const LINKED_VIEW_MARKER_FIELDS = new Set(['sourceDatabaseId', 'blockId', 'view']);
const LINKED_VIEW_CONFIG_FIELDS = new Set([
  'id',
  'name',
  'type',
  'filters',
  'sorts',
  'groupBy',
  'dateProp',
  'hidden',
  'widths',
  'frozenThrough',
  'rowHeight',
  'hideTitle',
  'collapsed',
  'collapseEnabled',
  'filterGroups',
  'filterGroupLogic',
  'search',
  'order',
  'wrap',
  'align',
  'summaries',
  'conditionalFormats',
  'cardProperties',
  'cardImageProp',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutTrailingEmpty(doc: ProseNode): ProseNode {
  let count = doc.childCount;
  while (
    count > 0 &&
    doc.child(count - 1).type.name === 'paragraph' &&
    doc.child(count - 1).content.size === 0
  )
    count--;
  if (count === doc.childCount) return doc;
  const children: ProseNode[] = [];
  for (let index = 0; index < count; index++) children.push(doc.child(index));
  return doc.copy(Fragment.from(children));
}

function editorMatchesDocument(editor: Editor, expected: DocNode): boolean {
  try {
    const expectedNode = editor.schema.nodeFromJSON(expected as JSONContent);
    return withoutTrailingEmpty(editor.state.doc).eq(withoutTrailingEmpty(expectedNode));
  } catch {
    return false;
  }
}

function linkedViewRawStateIsOpaque(view: ViewDef | null, rawState: unknown): boolean {
  if (rawState === null || rawState === undefined) return false;
  if (!isRecord(rawState) || !isRecord(rawState.raw)) return true;

  const raw = rawState.raw;
  if (Object.keys(raw).some((field) => !LINKED_VIEW_MARKER_FIELDS.has(field))) return true;
  if (!Object.prototype.hasOwnProperty.call(raw, 'view') || raw.view === null) return false;
  if (!isRecord(raw.view)) return true;
  if (!view) return true;
  return Object.keys(raw.view).some((field) => !LINKED_VIEW_CONFIG_FIELDS.has(field));
}

function linkedViewRawStateHasStoredView(rawState: unknown): boolean {
  if (rawState === null || rawState === undefined) return false;
  if (!isRecord(rawState) || !isRecord(rawState.raw)) return true;
  return Object.prototype.hasOwnProperty.call(rawState.raw, 'view') && rawState.raw.view !== null;
}

export function linkedViewSourceCompatibility(
  view: ViewDef | null,
  currentSourceId: PageId | null,
  target: DatabaseDef,
  rawState?: unknown,
  hasUnparsedView = false,
): LinkedViewSourceCompatibility {
  const targetHasOpaqueSchema = Boolean(target.unsupportedProperties?.length);
  const opaqueViewState = hasUnparsedView || linkedViewRawStateIsOpaque(view, rawState);
  if (!view)
    return {
      missingPropertyIds: [],
      unverifiedPropertyIds: [],
      previousSourcePropertyIds: [],
      validationIncomplete: targetHasOpaqueSchema || opaqueViewState,
    };
  const targetIds = new Set(target.properties.map((property) => property.id));
  const builtInIds = new Set([TITLE_PROP, CREATED_PROP, UPDATED_PROP]);
  const referencedIds = new Set<string>();
  const previousSourcePropertyIds = new Set<string>();
  const addPropertyId = (id: unknown) => {
    if (typeof id === 'string' && id.length > 0 && !builtInIds.has(id)) referencedIds.add(id);
  };
  const addRule = (rule: ViewDef['filters'][number]) => {
    addPropertyId(rule.prop);
    for (const binding of rule.formulaBindings ?? []) {
      if (binding.kind !== 'property' || binding.databaseId !== currentSourceId) continue;
      addPropertyId(binding.propertyId);
      previousSourcePropertyIds.add(binding.propertyId);
    }
  };

  for (const rule of view.filters ?? []) addRule(rule);
  for (const group of view.filterGroups ?? []) {
    for (const rule of group.filters ?? []) addRule(rule);
  }
  for (const sort of view.sorts ?? []) addPropertyId(sort.prop);
  addPropertyId(view.groupBy);
  addPropertyId(view.dateProp);
  for (const id of view.hidden ?? []) addPropertyId(id);
  for (const id of view.order ?? []) addPropertyId(id);
  for (const id of Object.keys(view.widths ?? {})) addPropertyId(id);
  addPropertyId(view.frozenThrough);
  for (const id of view.wrap ?? []) addPropertyId(id);
  for (const id of Object.keys(view.align ?? {})) addPropertyId(id);
  for (const id of Object.keys(view.summaries ?? {})) addPropertyId(id);
  for (const rule of view.conditionalFormats ?? []) addRule(rule);
  for (const id of view.cardProperties ?? []) addPropertyId(id);
  addPropertyId(view.cardImageProp);

  const notInTarget = [...referencedIds].filter((id) => !targetIds.has(id));
  const sortIds = (ids: Set<string> | string[]) =>
    [...ids].sort((left, right) => left.localeCompare(right));
  return {
    missingPropertyIds: targetHasOpaqueSchema ? [] : sortIds(notInTarget),
    unverifiedPropertyIds: targetHasOpaqueSchema ? sortIds(notInTarget) : [],
    previousSourcePropertyIds: sortIds(previousSourcePropertyIds),
    validationIncomplete:
      targetHasOpaqueSchema ||
      opaqueViewState ||
      Boolean(view.unsupportedConditionalFormats?.length),
  };
}

export function linkedViewNodeIdentityMatches(
  typeName: string,
  attrs: Record<string, unknown>,
  expected: {
    typeName: string;
    hostPageId: string;
    blockId: string | null;
    sourceDatabaseId: PageId | null;
    viewId: string | null;
  },
): boolean {
  const sourceId = typeof attrs.sourceDatabaseId === 'string' ? attrs.sourceDatabaseId : null;
  const viewId = isRecord(attrs.view) && typeof attrs.view.id === 'string' ? attrs.view.id : null;
  return (
    typeName === expected.typeName &&
    attrs.hostPageId === expected.hostPageId &&
    attrs.blockId === expected.blockId &&
    sourceId === expected.sourceDatabaseId &&
    viewId === expected.viewId
  );
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
  getPos,
  updateAttributes,
  deleteNode,
}: NodeViewProps) {
  useTranslation();
  const state = useWorkspace();
  const extensionHost = (extension.options as { hostPageId?: unknown }).hostPageId;
  const hostPageId =
    typeof extensionHost === 'string' && extensionHost
      ? extensionHost
      : typeof node.attrs.hostPageId === 'string'
        ? node.attrs.hostPageId
        : '';
  const blockId = typeof node.attrs.blockId === 'string' ? node.attrs.blockId : null;
  const sourceId = typeof node.attrs.sourceDatabaseId === 'string' ? node.attrs.sourceDatabaseId : null;
  const view =
    isRecord(node.attrs.view) && typeof node.attrs.view.id === 'string'
      ? (node.attrs.view as unknown as ViewDef)
      : null;
  const editableState = useEditorEditable(editor);
  const canEditNow = useCallback(() => !editor.isDestroyed && editor.isEditable, [editor]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const currentLinkedNode = () => {
    if (!mounted.current || !canEditNow() || typeof getPos !== 'function') return null;
    try {
      const position = getPos();
      if (typeof position !== 'number') return null;
      const liveNode = editor.view.state.doc.nodeAt(position);
      if (
        !liveNode ||
        !linkedViewNodeIdentityMatches(liveNode.type.name, liveNode.attrs, {
          typeName: node.type.name,
          hostPageId,
          blockId,
          sourceDatabaseId: sourceId,
          viewId: view?.id ?? null,
        })
      )
        return null;
      return liveNode;
    } catch {
      return null;
    }
  };
  const updateLinkedView = (change: (current: ViewDef) => ViewDef) => {
    if (!blockId || !canEditNow()) return;
    commitEditors();
    if (!mounted.current || !canEditNow() || editor.isDestroyed) return;

    const expectedDoc = getSession().getState().docs[hostPageId];
    if (!expectedDoc || typeof getPos !== 'function') return;
    if (!editorMatchesDocument(editor, expectedDoc)) return;
    if (!pageEditorsMatchDocuments([{ pageId: hostPageId, doc: expectedDoc }])) {
      toast(t('database.linkedViewUpdateConflict'), { tone: 'error' });
      return;
    }

    const liveNode = currentLinkedNode();
    if (!liveNode) return;
    const currentSnapshot = linkedViewConfigSnapshot(expectedDoc, hostPageId, blockId);
    const currentView =
      isRecord(liveNode.attrs.view) && typeof liveNode.attrs.view.id === 'string'
        ? (liveNode.attrs.view as unknown as ViewDef)
        : null;
    if (
      !currentSnapshot ||
      !currentView ||
      !sameTableActionValue(currentSnapshot.view, currentView) ||
      !sameTableActionValue(currentSnapshot.viewRawState, liveNode.attrs.viewRawState)
    )
      return;

    const nextView = change(currentSnapshot.view);
    if (sameTableActionValue(currentSnapshot.view, nextView)) return;
    const nextSnapshot = {
      ...currentSnapshot,
      view: nextView,
    };
    const nextDoc = replaceLinkedViewConfig(
      expectedDoc,
      hostPageId,
      blockId,
      currentSnapshot,
      nextSnapshot,
    );
    if (!nextDoc) return;

    const result = getSession().executeLinkedViewConfigChange(
      { kind: 'linked', hostPageId, blockId },
      expectedDoc,
      nextDoc,
      canEditNow,
      (receipt) => {
        if (
          !receipt.id ||
          (receipt.status !== 'ready' && receipt.status !== 'unavailable') ||
          receipt.identity.hostPageId !== hostPageId ||
          receipt.identity.blockId !== blockId ||
          receipt.change.identity.kind !== 'linked' ||
          receipt.change.identity.hostPageId !== hostPageId ||
          receipt.change.identity.blockId !== blockId ||
          !mounted.current ||
          !canEditNow() ||
          editor.isDestroyed
        )
          return false;
        let position: number;
        try {
          const currentPosition = getPos();
          if (typeof currentPosition !== 'number') return false;
          position = currentPosition;
        } catch {
          return false;
        }
        if (!editorMatchesDocument(editor, expectedDoc)) return false;
        const targetNode = editor.view.state.doc.nodeAt(position);
        if (
          !targetNode ||
          !linkedViewNodeIdentityMatches(targetNode.type.name, targetNode.attrs, {
            typeName: node.type.name,
            hostPageId,
            blockId,
            sourceDatabaseId: sourceId,
            viewId: receipt.change.before.view.id,
          }) ||
          !sameTableActionValue(targetNode.attrs.view, receipt.change.before.view)
        )
          return false;

        const attrs: Record<string, unknown> = { ...targetNode.attrs, view: receipt.change.after.view };
        if (Object.hasOwn(receipt.change.after, 'viewRawState'))
          attrs.viewRawState = receipt.change.after.viewRawState;
        else delete attrs.viewRawState;
        const transaction = editor.view.state.tr.setNodeMarkup(position, undefined, attrs);
        transaction.setMeta('addToHistory', false);
        transaction.setMeta('preventUpdate', true);
        try {
          editor.view.dispatch(transaction);
        } catch {
          return false;
        }
        return editorMatchesDocument(editor, nextDoc);
      },
    );
    if (!result.ok) {
      toast(
        result.reason?.kind === 'dataHistoryBusy'
          ? t('database.dataHistoryBusy')
          : t('database.linkedViewUpdateConflict'),
        { tone: 'error' },
      );
    }
  };
  const source = sourceId ? state.pages[sourceId] : undefined;
  const collapseEnabled = linkedViewCollapseEnabled(view);
  const [localLayout, setLocalLayout] = useState<{
    blockId: string | null;
    revision: number;
    collapsed: boolean | null;
  }>({ blockId, revision: editableState.revision, collapsed: null });
  const localLayoutApplies =
    !editableState.editable &&
    localLayout.blockId === blockId &&
    localLayout.revision === editableState.revision;
  const hideTitle = view?.hideTitle === true;
  const collapsed = collapseEnabled
    ? localLayoutApplies && localLayout.collapsed !== null
      ? localLayout.collapsed
      : view?.collapsed === true
    : false;
  const displayView = view ? { ...view, hideTitle, collapsed } : null;

  const updateLocalLayout = (change: Partial<Pick<typeof localLayout, 'collapsed'>>) => {
    setLocalLayout((previous) => {
      const base =
        previous.blockId === blockId && previous.revision === editableState.revision
          ? previous
          : { blockId, revision: editableState.revision, collapsed: null };
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
  const reportSourceIssue = (message: string | null) => {
    if (!message) return;
    toast(
      message.includes('recursive') ? t('database.recursiveView') : t('database.sourceUnavailable'),
      { tone: 'error' },
    );
  };
  const persistSourceSelection = (id: PageId, confirmedCompatibility: string | null = null) => {
    const liveNode = currentLinkedNode();
    if (!liveNode) return;
    const liveAttrs = liveNode.attrs as Record<string, unknown>;
    const currentSourceId =
      typeof liveAttrs.sourceDatabaseId === 'string' ? liveAttrs.sourceDatabaseId : null;
    const currentView =
      isRecord(liveAttrs.view) && typeof liveAttrs.view.id === 'string'
        ? (liveAttrs.view as unknown as ViewDef)
        : null;
    const currentState = getState();
    const currentTarget = currentState.pages[id];
    const targetDatabase = currentTarget?.database;
    const currentIssue = linkedViewSourceError(
      currentState,
      hostPageId,
      id,
      typeof liveAttrs.blockId === 'string' ? liveAttrs.blockId : null,
    );
    if (!currentTarget || !targetDatabase || currentIssue) {
      reportSourceIssue(currentIssue ?? 'The linked view source is unavailable.');
      return;
    }
    const compatibility = linkedViewSourceCompatibility(
      currentView,
      currentSourceId,
      targetDatabase,
      liveAttrs.viewRawState,
      liveAttrs.view !== null && liveAttrs.view !== undefined && currentView === null,
    );
    const hasCompatibilityWarning =
      compatibility.missingPropertyIds.length > 0 ||
      compatibility.unverifiedPropertyIds.length > 0 ||
      compatibility.previousSourcePropertyIds.length > 0 ||
      compatibility.validationIncomplete;
    const compatibilitySignature = JSON.stringify({
      currentSourceId,
      targetId: id,
      viewId: currentView?.id ?? null,
      compatibility,
    });
    if (hasCompatibilityWarning && confirmedCompatibility !== compatibilitySignature) {
      const warningParts = [
        t('database.linkedViewSourceChangeWarning', { source: displayTitle(currentTarget) }),
        compatibility.missingPropertyIds.length > 0
          ? t('database.linkedViewSourceMissingIds', {
              ids: compatibility.missingPropertyIds.join(', '),
            })
          : '',
        compatibility.unverifiedPropertyIds.length > 0
          ? t('database.linkedViewSourceUnverifiedIds', {
              ids: compatibility.unverifiedPropertyIds.join(', '),
            })
          : '',
        compatibility.previousSourcePropertyIds.length > 0
          ? t('database.linkedViewSourceBoundIds', {
              ids: compatibility.previousSourcePropertyIds.join(', '),
            })
          : '',
        compatibility.validationIncomplete ? t('database.linkedViewSourceValidationIncomplete') : '',
      ].filter(Boolean);
      confirmAction({
        title: t('database.linkedViewSourceChangeTitle'),
        body: warningParts.join(' '),
        confirmLabel: t('common.confirm'),
        onConfirm: () => persistSourceSelection(id, compatibilitySignature),
      });
      return;
    }
    runIfEditorEditable(
      editor,
      () => {
        const currentNode = currentLinkedNode();
        if (!currentNode) return;
        const currentAttrs = currentNode.attrs as Record<string, unknown>;
        if (
          (currentAttrs.view !== null && currentAttrs.view !== undefined) ||
          linkedViewRawStateHasStoredView(currentAttrs.viewRawState)
        ) {
          // Updating only the source keeps view IDs and opaque Markdown marker state intact.
          updateAttributes({ sourceDatabaseId: id });
          return;
        }
        const linkedView = newView('table', targetDatabase, newId);
        linkedView.name = t('database.linkedView');
        const selectedBlockId = typeof currentAttrs.blockId === 'string' ? currentAttrs.blockId : newId();
        updateAttributes(
          currentAttrs.viewRawState === null || currentAttrs.viewRawState === undefined
            ? linkedViewSourceSelectionAttributes(hostPageId, id, selectedBlockId, linkedView)
            : { sourceDatabaseId: id, blockId: selectedBlockId, view: linkedView },
        );
      },
      () => Boolean(currentLinkedNode()),
    );
  };
  const selectSource = (id: string) => {
    if (!id || (id === sourceId && view)) return;
    persistSourceSelection(id);
  };

  const toggleCollapsed = () => {
    if (!view || !collapseEnabled) return;
    const nextCollapsed = !collapsed;
    runLinkedViewLayoutAction(
      editor,
      () => updateLinkedView((current) => ({ ...current, collapsed: nextCollapsed })),
      () => updateLocalLayout({ collapsed: nextCollapsed }),
      canEditNow,
    );
  };

  const linkedSourceOptions = source?.database
    ? {
        sourceId,
        source,
        candidates,
        editable: editableState.editable,
        onSelectSource: selectSource,
        onOpenSource: () => openPage(source.id),
      }
    : undefined;

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
          {!hideTitle && source && view ? (
            <DraftInput
              type="text"
              label={t('database.viewName')}
              className="text-input small linked-database-name"
              value={view.name}
              editable={editableState.editable}
              historyStep={(direction) => {
                if (!sourceId || !blockId) return;
                void stepLinkedViewContextualHistory(
                  sourceId,
                  { kind: 'linked', hostPageId, blockId },
                  direction,
                  canEditNow,
                ).then((result) => {
                  if (result.status === 'applied' || result.status === 'empty') return;
                  const message =
                    result.status === 'blocked'
                      ? result.reason === 'related'
                        ? t('database.historyBlocked')
                        : t('database.historyPermissionChanged')
                      : result.status === 'conflict'
                        ? t('database.actionRecoveryConflict')
                        : result.status === 'unavailable'
                          ? t('database.dataHistoryUnavailable')
                          : t('database.actionRecoveryPending');
                  toast(message, {
                    tone: result.status === 'conflict' || result.status === 'unavailable' ? 'error' : 'info',
                  });
                });
              }}
              onCommit={(name) =>
                runIfEditorEditable(
                  editor,
                  () => updateLinkedView((current) => ({ ...current, name: name.trim() || t('database.linkedView') })),
                  canEditNow,
                )
              }
            />
          ) : !hideTitle ? (
            <strong>{t('database.linkedView')}</strong>
          ) : null}
          {editableState.editable && (!source?.database || !view || readableIssue) && (
            <select
              className="text-input small linked-database-picker"
              aria-label={t('database.chooseSource')}
              value={sourceId ?? ''}
              onChange={(event) => {
                const selected = event.currentTarget.value;
                selectSource(selected);
                if (selected !== (sourceId ?? '')) event.currentTarget.value = sourceId ?? '';
              }}
            >
              <option value="">{t('database.chooseSource')}</option>
              {sourceId && !candidates.some((candidate) => candidate.id === sourceId) && (
                <option value={sourceId}>{source ? displayTitle(source) : sourceId}</option>
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
            linkedBlockId={blockId ?? undefined}
            embeddedView={displayView}
            linkedSourceOptions={linkedSourceOptions}
            onEmbeddedViewChange={(change) =>
              runIfEditorEditable(
                editor,
                () => {
                  if (view) updateLinkedView(change);
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
