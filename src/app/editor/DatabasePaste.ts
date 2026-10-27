import { Extension } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
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
import { commitEditors, undoRedoEditor } from './commits';
import { getSession, getState } from '../workspace';

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
          handlePaste(_view, event) {
            const sourceId = copiedDatabaseId(event.clipboardData?.getData('text/plain') ?? '');
            if (!sourceId || !editor.isEditable || !hostPageId) return false;
            event.preventDefault();
            const source = getState().pages[sourceId];
            if (!source?.database) return true;
            openDialog({
              kind: 'pasteDatabase',
              title: displayTitle(source),
              onChoose: (mode) => {
                commitEditors();
                const current = getState();
                const database = current.pages[sourceId];
                if (
                  editor.isDestroyed ||
                  !editor.isEditable ||
                  !database?.database ||
                  !current.pages[hostPageId]
                ) {
                  toast(t('database.sourceUnavailable'), { tone: 'error' });
                  return;
                }
                const position = Math.min(editor.state.selection.from, editor.state.doc.content.size);
                if (mode === 'view') {
                  if (wouldCreateLinkedViewCycle(current, hostPageId, sourceId)) {
                    toast(t('database.recursiveView'), { tone: 'error' });
                    return;
                  }
                  const linked = newView('table', database.database, newId);
                  linked.name = t('database.linkedView');
                  editor.view.dispatch(closeHistory(editor.state.tr));
                  const inserted = editor.commands.insertContentAt(position, {
                    type: 'linkedDatabaseView',
                    attrs: { hostPageId, sourceDatabaseId: sourceId, blockId: newId(), view: linked },
                  });
                  if (!inserted) toast(t('database.copyUnavailable'), { tone: 'error' });
                  else {
                    editor.view.dispatch(closeHistory(editor.state.tr));
                    commitEditors();
                  }
                  return;
                }
                const plan = planDatabaseCopy(
                  current,
                  sourceId,
                  hostPageId,
                  mode === 'rows',
                  newId,
                  Date.now(),
                  t('database.copySuffix'),
                );
                if (!plan) {
                  toast(t('database.copyUnavailable'), { tone: 'error' });
                  return;
                }
                const copiedDatabase = plan.pages.find((page) => page.id === plan.databaseId);
                if (!copiedDatabase) {
                  toast(t('database.copyUnavailable'), { tone: 'error' });
                  return;
                }
                editor.view.dispatch(closeHistory(editor.state.tr));
                const added = editor.commands.insertContentAt(position, {
                  type: 'pageLink',
                  attrs: {
                    id: plan.databaseId,
                    label: displayTitle(copiedDatabase),
                    embed: true,
                  },
                });
                if (!added) {
                  toast(t('database.copyUnavailable'), { tone: 'error' });
                  return;
                }
                editor.view.dispatch(closeHistory(editor.state.tr));

                const inserted = getSession().insertDatabasePaste(
                  plan.databaseId,
                  hostPageId,
                  plan.pages,
                  plan.docs,
                );
                if (!inserted.ok) {
                  undoRedoEditor(editor, hostPageId, 'undo');
                  toast(t('database.copyUnavailable'), { tone: 'error' });
                  return;
                }
                commitEditors();
              },
            });
            return true;
          },
        },
      }),
    ];
  },
});
