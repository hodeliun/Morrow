import { ArrowUpRight, ChevronDown, ChevronRight, Eye, Trash2 } from 'lucide-react';
import { NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
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
  const sourceId = typeof node.attrs.sourceDatabaseId === 'string' ? node.attrs.sourceDatabaseId : null;
  const source = sourceId ? state.pages[sourceId] : undefined;
  const view = node.attrs.view && typeof node.attrs.view === 'object' ? (node.attrs.view as ViewDef) : null;
  const hideTitle = view?.hideTitle === true;
  const collapsed = view?.collapsed === true;

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
    const database = state.pages[id]?.database as DatabaseDef | undefined;
    if (!database) return;
    const linkedView = newView('table', database, newId);
    linkedView.name = t('database.linkedView');
    updateAttributes({
      hostPageId,
      sourceDatabaseId: id,
      blockId: blockId ?? newId(),
      view: linkedView,
    });
  };

  const toggleCollapsed = () => {
    if (view) {
      updateAttributes({ view: { ...view, collapsed: !collapsed } });
    }
  };

  const showTitle = () => {
    if (view) {
      updateAttributes({ view: { ...view, hideTitle: false } });
    }
  };

  return (
    <NodeViewWrapper className="linked-database-block" contentEditable={false}>
      <section className="linked-database-view" aria-label={t('database.linkedView')}>
        <header className="linked-database-head">
          {view && (
            <button
              type="button"
              className="icon-button tiny"
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
              <span>{source ? displayTitle(source) : t('database.linkedView')}</span>
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
          {!hideTitle && source && view && editor.isEditable && (
            <DraftInput
              type="text"
              label={t('database.viewName')}
              className="text-input small linked-database-name"
              value={view.name}
              editable
              onCommit={(name) =>
                updateAttributes({ view: { ...view, name: name.trim() || t('database.linkedView') } })
              }
            />
          )}
          {editor.isEditable && (
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
          {editor.isEditable && (
            <button
              type="button"
              className="icon-button small"
              title={t('database.removeLinkedView')}
              aria-label={t('database.removeLinkedView')}
              onClick={deleteNode}
            >
              <Trash2 size={14} />
            </button>
          )}
        </header>
        {readableIssue ? (
          <p className="db-readonly-note" role="status">
            {readableIssue}
          </p>
        ) : source?.database && view && !collapsed ? (
          <DatabaseView
            page={source}
            editable={editor.isEditable}
            hostPageId={hostPageId}
            embeddedView={view}
            onEmbeddedViewChange={(change) => updateAttributes({ view: change(view) })}
          />
        ) : !source?.database && !issue ? (
          <p className="muted db-hint">{t('database.chooseSourceHint')}</p>
        ) : null}
      </section>
    </NodeViewWrapper>
  );
}
