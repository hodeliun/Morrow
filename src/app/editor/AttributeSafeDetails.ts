/*
 * Adapted from @tiptap/extension-details 3.32.0, src/details.ts.
 *
 * MIT License
 * Copyright (c) 2025, Tiptap GmbH
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * Copyright and permission notice reproduced from
 * @tiptap/extension-details/LICENSE.md.
 */
import { mergeAttributes } from '@tiptap/core';
import { Details } from '@tiptap/extension-details';
import type { DetailsRenderToggleButtonOptions } from '@tiptap/extension-details';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { ViewMutationRecord } from '@tiptap/pm/view';

export const AttributeSafeDetails = Details.extend({
  addNodeView() {
    return ({ editor, getPos, node, HTMLAttributes }) => {
      const dom = document.createElement('div');
      const attributes = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': this.name,
      });

      Object.entries(attributes).forEach(([key, value]) => dom.setAttribute(key, value));

      const toggle = document.createElement('button');

      toggle.type = 'button';

      const renderToggleButton = (
        options: Omit<DetailsRenderToggleButtonOptions, 'element'>,
      ) => {
        this.options.renderToggleButton({
          element: toggle,
          ...options,
        });
      };

      dom.append(toggle);

      const content = document.createElement('div');

      dom.append(content);

      const toggleDetailsContent = (options?: { setToValue?: boolean; node?: ProseMirrorNode }) => {
        const { setToValue, node: currentNode = node } = options || {};

        if (setToValue !== undefined) {
          if (setToValue) {
            if (dom.classList.contains(this.options.openClassName)) {
              return;
            }
            dom.classList.add(this.options.openClassName);
          } else {
            if (!dom.classList.contains(this.options.openClassName)) {
              return;
            }
            dom.classList.remove(this.options.openClassName);
          }
        } else {
          dom.classList.toggle(this.options.openClassName);
        }

        const isOpen = dom.classList.contains(this.options.openClassName);

        renderToggleButton({
          isOpen,
          node: currentNode,
        });

        const event = new Event('toggleDetailsContent');
        const detailsContent = content.querySelector(':scope > div[data-type="detailsContent"]');

        detailsContent?.dispatchEvent(event);
      };

      renderToggleButton({
        isOpen: Boolean(node.attrs.open),
        node,
      });

      if (node.attrs.open) {
        setTimeout(() => toggleDetailsContent());
      }

      toggle.addEventListener('click', () => {
        toggleDetailsContent();

        if (!this.options.persist) {
          editor.commands.focus(undefined, { scrollIntoView: false });

          return;
        }

        if (editor.isEditable && typeof getPos === 'function') {
          const { from, to } = editor.state.selection;

          editor
            .chain()
            .command(({ tr }) => {
              const pos = getPos();

              if (typeof pos !== 'number') {
                return false;
              }

              const currentNode = tr.doc.nodeAt(pos);

              if (currentNode?.type !== this.type) {
                return false;
              }

              tr.setNodeMarkup(pos, undefined, {
                ...currentNode.attrs,
                open: !currentNode.attrs.open,
              });

              return true;
            })
            .setTextSelection({
              from,
              to,
            })
            .focus(undefined, { scrollIntoView: false })
            .run();
        }
      });

      return {
        dom,
        contentDOM: content,
        ignoreMutation(mutation: ViewMutationRecord) {
          if (mutation.type === 'selection') {
            return false;
          }

          const target = mutation.target;
          const isInsideWrapper = dom.contains(target);
          const isInsideToggleButton = toggle.contains(target);

          return isInsideToggleButton || !isInsideWrapper || dom === target;
        },
        update: (updatedNode) => {
          if (updatedNode.type !== this.type) {
            return false;
          }

          if (updatedNode.attrs.open !== undefined) {
            toggleDetailsContent({
              setToValue: updatedNode.attrs.open,
              node: updatedNode,
            });
          } else {
            renderToggleButton({
              isOpen: dom.classList.contains(this.options.openClassName),
              node: updatedNode,
            });
          }

          return true;
        },
      };
    };
  },
});
