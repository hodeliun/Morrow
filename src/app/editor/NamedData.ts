import { mergeAttributes, Node } from '@tiptap/core';
import type { PageId } from '../../core/model';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { Fragment, Slice } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { getState, run } from '../workspace';
import { newId } from '../platform/files';
import { CalculatedResultNode, NamedControlNode } from '../components/NamedData';

interface NamedDataOptions {
  hostPageId: PageId;
}

function decodeResult(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const value = JSON.parse(decodeURIComponent(raw)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export const NamedControl = Node.create<NamedDataOptions>({
  name: 'namedControl',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { hostPageId: '' };
  },

  addAttributes() {
    return {
      controlId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-morrow-control'),
        renderHTML: (attributes) => attributes.controlId ? { 'data-morrow-control': String(attributes.controlId) } : {},
      },
      pageId: {
        default: this.options.hostPageId,
        parseHTML: (element) => element.getAttribute('data-morrow-page-id') ?? this.options.hostPageId,
        renderHTML: (attributes) => attributes.pageId ? { 'data-morrow-page-id': String(attributes.pageId) } : {},
      },
      label: {
        default: 'Control',
        parseHTML: (element) => element.textContent ?? 'Control',
        renderHTML: () => ({}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-morrow-control]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { class: 'named-control' }), String(node.attrs.label ?? 'Control')];
  },

  renderText({ node }) {
    return String(node.attrs.label ?? 'Control');
  },

  addNodeView() {
    return ReactNodeViewRenderer(NamedControlNode);
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const hostPageId = this.options.hostPageId;
    return [new Plugin({
      props: {
        // Pasting a control block creates a new page-scoped identity. Formula blocks pasted with it
        // follow the copied identities; references to items outside the pasted slice stay external.
        transformPasted(slice) {
          if (!editor.isEditable || !hostPageId || !getState().pages[hostPageId]) return slice;
          const state = getState();
          const host = state.pages[hostPageId]!;
          const controlMap = new Map<string, { id: string; name: string }>();
          const resultMap = new Map<string, string>();
          const reservedNames = new Set(host.controls.map((control) => control.name.toLocaleLowerCase()));
          const uniqueName = (base: string) => {
            let suffix = 1;
            let name = `${base} copy`;
            while (reservedNames.has(name.toLocaleLowerCase())) name = `${base} copy ${++suffix}`;
            reservedNames.add(name.toLocaleLowerCase());
            return name;
          };
          const collect = (node: ProseMirrorNode) => {
            if (node.type.name === 'namedControl' && typeof node.attrs.controlId === 'string') {
              const sourcePageId = typeof node.attrs.pageId === 'string' ? node.attrs.pageId : hostPageId;
              const sourceId = node.attrs.controlId;
              const key = `${sourcePageId}:${sourceId}`;
              if (!controlMap.has(key)) {
                const sourceControl = state.pages[sourcePageId]?.controls.find((control) => control.id === sourceId);
                if (sourceControl) {
                  const id = newId();
                  const name = uniqueName(sourceControl.name);
                  const created = run({
                    type: 'page.control.configure',
                    id: hostPageId,
                    control: { ...sourceControl, id, name },
                    now: Date.now(),
                  });
                  if (created.ok) controlMap.set(key, { id, name });
                }
              }
            }
            if (node.type.name === 'calculatedResult' && typeof node.attrs.resultId === 'string') {
              const sourcePageId = typeof node.attrs.pageId === 'string' ? node.attrs.pageId : hostPageId;
              const key = `${sourcePageId}:${node.attrs.resultId}`;
              if (!resultMap.has(key)) resultMap.set(key, newId());
            }
            node.content.forEach(collect);
          };
          slice.content.forEach(collect);
          const remapBindings = (value: unknown) => {
            if (!Array.isArray(value)) return value;
            return value.map((raw) => {
              if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
              const binding = { ...(raw as Record<string, unknown>) };
              if (typeof binding.pageId !== 'string') return binding;
              if (binding.kind === 'control' && typeof binding.controlId === 'string') {
                const mapped = controlMap.get(`${binding.pageId}:${binding.controlId}`);
                if (mapped) { binding.pageId = hostPageId; binding.controlId = mapped.id; }
              }
              if (binding.kind === 'result' && typeof binding.resultId === 'string') {
                const mapped = resultMap.get(`${binding.pageId}:${binding.resultId}`);
                if (mapped) { binding.pageId = hostPageId; binding.resultId = mapped; }
              }
              return binding;
            });
          };
          const transform = (node: ProseMirrorNode): ProseMirrorNode => {
            if (node.isText) return node;
            const children: ProseMirrorNode[] = [];
            node.content.forEach((child) => children.push(transform(child)));
            let attrs: Record<string, unknown> | null = null;
            if (node.type.name === 'namedControl' && typeof node.attrs.controlId === 'string') {
              const sourcePageId = typeof node.attrs.pageId === 'string' ? node.attrs.pageId : hostPageId;
              const mapped = controlMap.get(`${sourcePageId}:${node.attrs.controlId}`);
              if (mapped) attrs = { ...node.attrs, controlId: mapped.id, pageId: hostPageId, label: mapped.name };
            }
            if (node.type.name === 'calculatedResult') {
              const sourcePageId = typeof node.attrs.pageId === 'string' ? node.attrs.pageId : hostPageId;
              const resultId = typeof node.attrs.resultId === 'string' ? resultMap.get(`${sourcePageId}:${node.attrs.resultId}`) : undefined;
              attrs = {
                ...node.attrs,
                ...(resultId ? { resultId } : {}),
                pageId: hostPageId,
                bindings: remapBindings(node.attrs.bindings),
              };
            }
            const content = Fragment.fromArray(children);
            if (attrs) return node.type.create(attrs, content, node.marks);
            return content.eq(node.content) ? node : node.copy(content);
          };
          return new Slice(Fragment.fromArray(slice.content.content.map(transform)), slice.openStart, slice.openEnd);
        },
      },
    })];
  },
});

export const CalculatedResult = Node.create<NamedDataOptions>({
  name: 'calculatedResult',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { hostPageId: '' };
  },

  addAttributes() {
    const decode = (field: string, fallback: unknown) => ({
      default: fallback,
      parseHTML: (element: HTMLElement) => decodeResult(element.getAttribute('data-morrow-result'))[field] ?? fallback,
      renderHTML: () => ({}),
    });
    return {
      resultId: decode('resultId', null),
      name: decode('name', 'Result'),
      formula: decode('formula', ''),
      bindings: decode('bindings', []),
      outputType: decode('outputType', 'auto'),
      format: decode('format', {}),
      pageId: decode('pageId', this.options.hostPageId),
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-morrow-result]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const encoded = encodeURIComponent(JSON.stringify(node.attrs)).replaceAll("'", '%27');
    return [
      'span',
      mergeAttributes(HTMLAttributes, { 'data-morrow-result': encoded, class: 'calculated-result' }),
      String(node.attrs.name ?? 'Result'),
    ];
  },

  renderText({ node }) {
    return String(node.attrs.name ?? 'Result');
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalculatedResultNode);
  },
});
