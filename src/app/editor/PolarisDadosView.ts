import { Node } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import {
  decodePolarisDadosViewMarker,
  encodePolarisDadosViewMarker,
  isPolarisDadosViewData,
  polarisDadosViewDocIssue,
} from '../../core/polarisDadosView';

function fallbackElement(titleValue: unknown, sourceValue: unknown): HTMLElement {
  const dom = document.createElement('aside');
  dom.className = 'polaris-dados-view-fallback';
  dom.contentEditable = 'false';

  const title = document.createElement('strong');
  title.textContent = typeof titleValue === 'string' ? titleValue : 'Linked view';
  const unavailable = document.createElement('p');
  unavailable.textContent = 'Linked view unavailable.';
  const source = document.createElement('p');
  source.append(document.createTextNode('Source database: '));
  const sourceId = document.createElement('code');
  sourceId.textContent = typeof sourceValue === 'string' ? sourceValue : '';
  source.append(sourceId);

  dom.append(title, unavailable, source);
  return dom;
}

function rawPolarisDadosViewMarkers(doc: ProseMirrorNode): Map<string, number> {
  const markers = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name !== 'rawBlock' || typeof node.attrs.text !== 'string') return;
    const source = node.attrs.text as string;
    const openings = /<!--[ \t\r\n]*morrow:polaris-dados-view\s*:/gi;
    let match: RegExpExecArray | null;
    while ((match = openings.exec(source))) {
      const end = source.indexOf('-->', match.index);
      const marker = source.slice(match.index, end === -1 ? source.length : end + 3);
      markers.set(marker, (markers.get(marker) ?? 0) + 1);
    }
  });
  return markers;
}

function addsRawPolarisDadosViewMarker(before: ProseMirrorNode, after: ProseMirrorNode): boolean {
  const previous = rawPolarisDadosViewMarkers(before);
  for (const [marker, count] of rawPolarisDadosViewMarkers(after)) {
    if (count > (previous.get(marker) ?? 0)) return true;
  }
  return false;
}

export const PolarisDadosView = Node.create({
  name: 'polarisDadosView',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      version: { default: null },
      viewId: { default: null },
      sourceDatabaseId: { default: null },
      title: { default: null },
      columnOrder: { default: null },
      filter: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-morrow-polaris-dados-view]',
        getAttrs: (element) => {
          const marker = (element as HTMLElement).getAttribute('data-morrow-polaris-dados-view');
          const data = marker ? decodePolarisDadosViewMarker(marker) : null;
          return data ?? false;
        },
      },
    ];
  },

  renderHTML({ node }) {
    const data = isPolarisDadosViewData(node.attrs) ? node.attrs : null;
    const marker = data ? encodePolarisDadosViewMarker(data) : '';
    const title = typeof data?.title === 'string' ? data.title : 'Linked view';
    const source = typeof data?.sourceDatabaseId === 'string' ? data.sourceDatabaseId : '';
    return [
      'div',
      { 'data-morrow-polaris-dados-view': marker },
      ['strong', {}, title],
      ['p', {}, 'Linked view unavailable.'],
      ['p', {}, 'Source database: ', ['code', {}, source]],
    ];
  },

  addNodeView() {
    return ({ node }) => ({
      dom: fallbackElement(node.attrs.title, node.attrs.sourceDatabaseId),
    });
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        filterTransaction: (transaction) => {
          if (!transaction.docChanged) return true;
          return (
            polarisDadosViewDocIssue(transaction.doc.toJSON()) === null &&
            !addsRawPolarisDadosViewMarker(transaction.before, transaction.doc)
          );
        },
      }),
    ];
  },
});
