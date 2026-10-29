import { describe, expect, test } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { getImageCropAspectRatio, shouldResetCropOnImageReplace } from './Media';
import {
  createSectionFoldingPlugin,
  resetTemporaryFolding,
  revealAncestorsForPosition,
  sectionFoldingKey,
  toggleSectionCollapsed,
} from './CollapsibleHeading';

describe('Delivery 1: Editor extensions & interaction logic', () => {
  describe('Ticket #30 (Reviewer fix): Image aspect ratio preservation on replace', () => {
    test('preserves crop if new image has same natural aspect ratio (<= 0.01 delta)', () => {
      expect(shouldResetCropOnImageReplace(800 / 600, 1600 / 1200)).toBe(false);
      expect(shouldResetCropOnImageReplace(1.333, 1.339)).toBe(false);
    });

    test('resets crop if new image has different aspect ratio (> 0.01 delta)', () => {
      expect(shouldResetCropOnImageReplace(800 / 600, 600 / 800)).toBe(true);
      expect(shouldResetCropOnImageReplace(1.0, 16 / 9)).toBe(true);
    });

    test('handles missing or non-finite ratios safely without error', () => {
      expect(shouldResetCropOnImageReplace(null, 1.5)).toBe(false);
      expect(shouldResetCropOnImageReplace(1.5, null)).toBe(false);
      expect(shouldResetCropOnImageReplace(undefined, undefined)).toBe(false);
      expect(shouldResetCropOnImageReplace(Infinity, 1.0)).toBe(false);
    });
  });

  describe('Ticket #30: cropped preview aspect ratio', () => {
    test('keeps the natural landscape ratio when the normalized crop is square', () => {
      const crop = { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };

      expect(getImageCropAspectRatio(400 / 200, crop)).toBe(2);
    });
  });

  describe('Ticket #31 (Reviewer fix): Collapsible heading revealAncestorsForPosition', () => {
    const testSchema = new Schema({
      nodes: {
        doc: { content: 'block+' },
        paragraph: { content: 'inline*', group: 'block' },
        heading: {
          content: 'inline*',
          group: 'block',
          attrs: {
            level: { default: 1 },
            collapsible: { default: false },
            collapsed: { default: false },
          },
        },
        text: { group: 'inline' },
      },
    });

    function createMockView(docNode: ProsemirrorNode, editable = true): EditorView {
      let state = EditorState.create({
        schema: testSchema,
        doc: docNode,
        plugins: [createSectionFoldingPlugin()],
      });
      const view = {
        state,
        editable,
        dispatch: (tr: Transaction) => {
          state = state.apply(tr);
          view.state = state;
        },
      };
      return view as unknown as EditorView;
    }

    test('reveals collapsed section containing target', () => {
      const doc = testSchema.node('doc', null, [
        testSchema.node('heading', { level: 1, collapsible: true, collapsed: true }, [
          testSchema.text('Heading 1'),
        ]),
        testSchema.node('paragraph', null, [testSchema.text('Paragraph inside section 1')]),
      ]);
      const view = createMockView(doc);
      const originalDoc = view.state.doc;
      const targetPos = 16;
      const changed = revealAncestorsForPosition(view, targetPos);
      expect(changed).toBe(true);
      const h1 = view.state.doc.child(0);
      expect(h1.attrs.collapsed).toBe(true);
      expect(view.state.doc).toBe(originalDoc);
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.get(0)).toBe(false);
    });

    test('does NOT reopen earlier heading if intermediate heading of same or lower level closed it', () => {
      const doc = testSchema.node('doc', null, [
        testSchema.node('heading', { level: 1, collapsible: true, collapsed: true }, [
          testSchema.text('Heading 1 A'),
        ]),
        testSchema.node('paragraph', null, [testSchema.text('Paragraph A')]),
        testSchema.node('heading', { level: 1, collapsible: true, collapsed: true }, [
          testSchema.text('Heading 1 B'),
        ]),
        testSchema.node('paragraph', null, [testSchema.text('Paragraph B')]),
      ]);
      const view = createMockView(doc);
      const targetPos = 42;
      const changed = revealAncestorsForPosition(view, targetPos);
      expect(changed).toBe(true);
      const h1A = view.state.doc.child(0);
      const h1B = view.state.doc.child(2);
      expect(h1B.attrs.collapsed).toBe(true);
      expect(h1A.attrs.collapsed).toBe(true);
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.get(0)).toBeUndefined();
      const secondHeadingPosition = h1A.nodeSize + view.state.doc.child(1).nodeSize;
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.get(secondHeadingPosition)).toBe(
        false,
      );
    });

    test('reveals both parent and child heading when target is inside nested subsection', () => {
      const doc = testSchema.node('doc', null, [
        testSchema.node('heading', { level: 1, collapsible: true, collapsed: true }, [
          testSchema.text('Heading 1'),
        ]),
        testSchema.node('heading', { level: 2, collapsible: true, collapsed: true }, [
          testSchema.text('Subheading 2'),
        ]),
        testSchema.node('paragraph', null, [testSchema.text('Nested content')]),
      ]);
      const view = createMockView(doc);
      const targetPos = 30;
      const changed = revealAncestorsForPosition(view, targetPos);
      expect(changed).toBe(true);
      const h1 = view.state.doc.child(0);
      const h2 = view.state.doc.child(1);
      expect(h1.attrs.collapsed).toBe(true);
      expect(h2.attrs.collapsed).toBe(true);
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.get(0)).toBe(false);
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.get(h1.nodeSize)).toBe(false);
    });

    test('reveals a read-only target with decorations and leaves its document unchanged', () => {
      const doc = testSchema.node('doc', null, [
        testSchema.node('heading', { level: 1, collapsible: true, collapsed: true }, [
          testSchema.text('Read-only heading'),
        ]),
        testSchema.node('paragraph', null, [testSchema.text('Read-only target')]),
      ]);
      const view = createMockView(doc, false);
      const originalDoc = view.state.doc;
      const originalDecorationCount = sectionFoldingKey.getState(view.state)?.decorations.find().length;

      expect(originalDecorationCount).toBe(2);
      expect(revealAncestorsForPosition(view, 24)).toBe(true);
      expect(view.state.doc).toBe(originalDoc);
      expect(view.state.doc.child(0).attrs.collapsed).toBe(true);
      expect(sectionFoldingKey.getState(view.state)?.decorations.find()).toHaveLength(1);

      view.editable = true;
      resetTemporaryFolding(view);
      expect(sectionFoldingKey.getState(view.state)?.decorations.find()).toHaveLength(2);
      expect(view.state.doc.child(0).attrs.collapsed).toBe(true);
    });

    test('keeps a revealed section visible when edits map its heading and target positions', () => {
      const doc = testSchema.node('doc', null, [
        testSchema.node('paragraph', null, [testSchema.text('Intro')]),
        testSchema.node('heading', { level: 1, collapsible: true, collapsed: true }, [
          testSchema.text('Folded section'),
        ]),
        testSchema.node('paragraph', null, [testSchema.text('Target content')]),
      ]);
      const view = createMockView(doc);
      const headingPosition = view.state.doc.child(0).nodeSize;
      const targetParagraphPosition = headingPosition + view.state.doc.child(1).nodeSize;
      const targetPosition = targetParagraphPosition + 1 + 4;

      expect(revealAncestorsForPosition(view, targetPosition)).toBe(true);
      view.dispatch(view.state.tr.insertText('X', 3));
      const shiftedHeadingPosition = view.state.doc.child(0).nodeSize;
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.get(shiftedHeadingPosition)).toBe(
        false,
      );
      expect(view.state.doc.child(1).attrs.collapsed).toBe(true);
      expect(sectionFoldingKey.getState(view.state)?.decorations.find()).toHaveLength(1);

      const shiftedTargetPosition = shiftedHeadingPosition + view.state.doc.child(1).nodeSize + 1;
      view.dispatch(view.state.tr.insertText('Y', shiftedTargetPosition + 4));
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.get(shiftedHeadingPosition)).toBe(
        false,
      );
      expect(view.state.doc.child(1).attrs.collapsed).toBe(true);
      expect(view.state.doc.child(2).textContent).toBe('TargYet content');
      expect(sectionFoldingKey.getState(view.state)?.decorations.find()).toHaveLength(1);
    });

    test('persists explicit folding in edit mode and clears the temporary reveal override', () => {
      const doc = testSchema.node('doc', null, [
        testSchema.node('heading', { level: 1, collapsible: true, collapsed: true }, [
          testSchema.text('Folded section'),
        ]),
        testSchema.node('paragraph', null, [testSchema.text('Target content')]),
      ]);
      const view = createMockView(doc);

      expect(revealAncestorsForPosition(view, 20)).toBe(true);
      expect(sectionFoldingKey.getState(view.state)?.decorations.find()).toHaveLength(1);

      toggleSectionCollapsed(view, 0);
      expect(view.state.doc.child(0).attrs.collapsed).toBe(true);
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.has(0)).toBe(false);
      expect(sectionFoldingKey.getState(view.state)?.decorations.find()).toHaveLength(2);

      toggleSectionCollapsed(view, 0);
      expect(view.state.doc.child(0).attrs.collapsed).toBe(false);
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.has(0)).toBe(false);
      expect(sectionFoldingKey.getState(view.state)?.decorations.find()).toHaveLength(1);
    });

    test('keeps explicit fold changes local while the editor is read-only', () => {
      const doc = testSchema.node('doc', null, [
        testSchema.node('heading', { level: 1, collapsible: true, collapsed: false }, [
          testSchema.text('Expanded section'),
        ]),
        testSchema.node('paragraph', null, [testSchema.text('Target content')]),
      ]);
      const view = createMockView(doc, false);

      toggleSectionCollapsed(view, 0);
      expect(view.state.doc.child(0).attrs.collapsed).toBe(false);
      expect(sectionFoldingKey.getState(view.state)?.collapsedOverrides.get(0)).toBe(true);
      expect(sectionFoldingKey.getState(view.state)?.decorations.find()).toHaveLength(2);
    });
  });
});
