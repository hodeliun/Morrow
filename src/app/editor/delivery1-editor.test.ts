import { describe, expect, test } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import type { Node as ProsemirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { shouldResetCropOnImageReplace } from './Media';
import { revealAncestorsForPosition } from './CollapsibleHeading';

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

    function createMockView(docNode: ProsemirrorNode): EditorView {
      let state = EditorState.create({ schema: testSchema, doc: docNode });
      const view = {
        state,
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
      const targetPos = 16;
      const changed = revealAncestorsForPosition(view, targetPos);
      expect(changed).toBe(true);
      const h1 = view.state.doc.child(0);
      expect(h1.attrs.collapsed).toBe(false);
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
      expect(h1B.attrs.collapsed).toBe(false);
      expect(h1A.attrs.collapsed).toBe(true);
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
      expect(h1.attrs.collapsed).toBe(false);
      expect(h2.attrs.collapsed).toBe(false);
    });
  });
});
