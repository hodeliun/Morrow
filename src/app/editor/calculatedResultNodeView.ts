import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ReactNodeViewRendererOptions } from '@tiptap/react';

function effectivePageId(node: ProseMirrorNode, hostPageId: string): string {
  return String(node.attrs.pageId || hostPageId || '');
}

function resultId(node: ProseMirrorNode): string {
  return String(node.attrs.resultId ?? '');
}

function sameCalculatedResultIdentity(
  previous: ProseMirrorNode,
  next: ProseMirrorNode,
  hostPageId: string,
): boolean {
  return effectivePageId(previous, hostPageId) === effectivePageId(next, hostPageId) &&
    resultId(previous) === resultId(next);
}

export function calculatedResultNodeViewOptions(
  hostPageId: string,
): Pick<ReactNodeViewRendererOptions, 'update'> {
  return {
    update({ oldNode, newNode, updateProps }) {
      if (!sameCalculatedResultIdentity(oldNode, newNode, hostPageId)) return false;
      updateProps();
      return true;
    },
  };
}
