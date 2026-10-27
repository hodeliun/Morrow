import { Copy, Maximize2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { displayTitle } from '../../../core/model';
import type { PageId } from '../../../core/model';
import { openPage } from '../../router';
import { run, useWorkspace } from '../../workspace';
import { PageIcon } from '../Sidebar';
import { DatabaseView } from './DatabaseView';
import { t } from '../../i18n';
import { copyDatabase } from '../../databaseClipboard';

// a database living inside another page, with all its views, still a page of its own
export function EmbeddedDatabase({ pageId, editable }: { pageId: PageId; editable: boolean }) {
  const state = useWorkspace();
  const page = state.pages[pageId];
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const canceling = useRef(false);
  if (!page?.database) return null;
  const finishRename = () => {
    if (!canceling.current && draft !== page.title)
      run({ type: 'page.rename', id: page.id, title: draft, now: Date.now() });
    canceling.current = false;
    setRenaming(false);
  };
  return (
    <div className="inline-database">
      <div className="inline-database-head">
        {renaming && editable ? (
          <span className="inline-database-title">
            <PageIcon page={page} />
            <input
              type="text"
              className="inline-database-rename"
              aria-label={t('page.titleAria')}
              autoFocus
              value={draft}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={finishRename}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') event.currentTarget.blur();
                if (event.key === 'Escape') {
                  canceling.current = true;
                  event.currentTarget.blur();
                }
              }}
            />
          </span>
        ) : (
          <button
            type="button"
            className="inline-database-title"
            title={
              editable
                ? t('database.renameInlineDatabase', { title: displayTitle(page) })
                : t('database.openAsAFullPage')
            }
            aria-label={
              editable
                ? t('database.renameInlineDatabase', { title: displayTitle(page) })
                : t('database.openAsAFullPage')
            }
            onClick={() => {
              if (!editable) return openPage(page.id);
              setDraft(page.title);
              setRenaming(true);
            }}
          >
            <PageIcon page={page} />
            <span>{displayTitle(page)}</span>
          </button>
        )}
        <div className="inline-database-actions">
          {editable && (
            <button type="button" className="icon-button" title={t('database.copyDatabase')} aria-label={t('database.copyDatabase')} onClick={() => void copyDatabase(page.id)}>
              <Copy size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            title={t('database.openAsAFullPage')}
            aria-label={t('database.openAsAFullPage')}
            onClick={() => openPage(page.id)}
          >
            <Maximize2 size={14} />
          </button>
        </div>
      </div>
      <DatabaseView page={page} editable={editable} />
    </div>
  );
}
