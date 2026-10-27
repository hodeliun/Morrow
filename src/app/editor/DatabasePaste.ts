import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { planDatabaseCopy } from '../../core/databaseCopy';
import { newView } from '../../core/database';
import { displayTitle } from '../../core/model';
import type { PageId } from '../../core/model';
import { wouldCreateLinkedViewCycle } from '../../core/linkedViews';
import { copiedDatabaseId } from '../databaseClipboard';
import { t } from '../i18n';
import { newId } from '../platform/files';
import { openDialog, toast } from '../ui';
import { getState, run } from '../workspace';

export type DatabasePasteMode = 'structure' | 'rows' | 'view';

export const DatabasePaste = Extension.create<{ hostPageId: PageId }>({
  name: 'databasePaste',
  addOptions() {
    return { hostPageId: '' };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    const hostPageId = this.options.hostPageId;
    return [
      new Plugin({
        key: new PluginKey('databasePaste'),
        props: {
          handlePaste(view, event) {
            const sourceId = copiedDatabaseId(event.clipboardData?.getData('text/plain') ?? '');
            if (!sourceId || !editor.isEditable || !hostPageId) return false;
            event.preventDefault();
            const source = getState().pages[sourceId];
            if (!source?.database) return true;
            const position = view.state.selection.from;
            openDialog({
              kind: 'pasteDatabase',
              title: displayTitle(source),
              onChoose: (mode) => {
                const current = getState();
                const database = current.pages[sourceId];
                if (!database?.database || !current.pages[hostPageId]) {
                  toast(t('database.sourceUnavailable'), { tone: 'error' });
                  return;
                }
                if (mode === 'view') {
                  if (wouldCreateLinkedViewCycle(current, hostPageId, sourceId)) {
                    toast(t('database.recursiveView'), { tone: 'error' });
                    return;
                  }
                  const linked = newView('table', database.database, newId);
                  linked.name = t('database.linkedView');
                  editor.commands.insertContentAt(position, {
                    type: 'linkedDatabaseView',
                    attrs: { hostPageId, sourceDatabaseId: sourceId, blockId: newId(), view: linked },
                  });
                  return;
                }
                const plan = planDatabaseCopy(current, sourceId, hostPageId, mode === 'rows', newId, Date.now(), t('database.copySuffix'));
                if (!plan) {
                  toast(t('database.copyUnavailable'), { tone: 'error' });
                  return;
                }
                const inserted = run({ type: 'pages.insert', pages: plan.pages, docs: plan.docs });
                if (!inserted.ok) return;
                editor.commands.insertContentAt(position, {
                  type: 'pageLink',
                  attrs: { id: plan.databaseId, label: displayTitle(inserted.value.pages[plan.databaseId]!), embed: true },
                });
              },
            });
            return true;
          },
        },
      }),
    ];
  },
});
