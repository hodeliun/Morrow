import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Plugin } from '@tiptap/pm/state';
import { newId } from '../platform/files';
import { LinkedDatabaseViewNode } from '../components/database/LinkedDatabaseView';
import { shouldStopLinkedDatabaseControlEvent } from './linkedDatabaseEvents';

interface LinkedDatabaseOptions {
  hostPageId: string;
}

export const LinkedDatabaseView = Node.create<LinkedDatabaseOptions>({
  name: 'linkedDatabaseView',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { hostPageId: '' };
  },

  addAttributes() {
    return {
      hostPageId: {
        default: this.options.hostPageId,
        parseHTML: (element) => element.getAttribute('data-host-page-id'),
        renderHTML: (attributes) => ({ 'data-host-page-id': attributes.hostPageId ?? '' }),
      },
      sourceDatabaseId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-source-database-id'),
        renderHTML: (attributes) =>
          attributes.sourceDatabaseId ? { 'data-source-database-id': attributes.sourceDatabaseId } : {},
      },
      blockId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-linked-view-id'),
        renderHTML: (attributes) => (attributes.blockId ? { 'data-linked-view-id': attributes.blockId } : {}),
      },
      view: {
        default: null,
        parseHTML: (element) => {
          try {
            return JSON.parse(element.getAttribute('data-view-config') ?? 'null') as unknown;
          } catch {
            return null;
          }
        },
        renderHTML: (attributes) => ({ 'data-view-config': JSON.stringify(attributes.view ?? null) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-morrow-linked-view]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-morrow-linked-view': '', class: 'linked-database-view' }),
      'Linked database view — open in Morrow to edit shared rows.',
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(LinkedDatabaseViewNode, {
      stopEvent: ({ event }) => shouldStopLinkedDatabaseControlEvent(event),
    });
  },

  addProseMirrorPlugins() {
    const hostPageId = this.options.hostPageId;
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, nextState) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null;
          const blockIds = new Set<string>();
          const viewIds = new Set<string>();
          const transaction = nextState.tr;
          nextState.doc.descendants((node, position) => {
            if (node.type.name !== 'linkedDatabaseView') return;
            const attrs = { ...node.attrs } as Record<string, unknown>;
            let changed = false;
            if (attrs.hostPageId !== hostPageId) {
              attrs.hostPageId = hostPageId;
              changed = true;
            }
            let blockId = typeof attrs.blockId === 'string' ? attrs.blockId : '';
            if (!blockId || blockIds.has(blockId)) {
              blockId = newId();
              attrs.blockId = blockId;
              changed = true;
            }
            blockIds.add(blockId);
            if (attrs.view && typeof attrs.view === 'object') {
              const view = { ...(attrs.view as Record<string, unknown>) };
              let viewId = typeof view.id === 'string' ? view.id : '';
              if (!viewId || viewIds.has(viewId)) {
                viewId = newId();
                view.id = viewId;
                attrs.view = view;
                changed = true;
              }
              viewIds.add(viewId);
            }
            if (changed) transaction.setNodeMarkup(position, undefined, attrs);
          });
          return transaction.docChanged ? transaction : null;
        },
      }),
    ];
  },
});
