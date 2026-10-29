import { describe, expect, it } from 'vitest';
import { PageEditorDocumentTracker } from './pageEditorCommit';

describe('page editor document commits', () => {
  it('commits the last editable snapshot after a read-only programmatic change', () => {
    const saved = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved' }] }],
    };
    const edited = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }],
    };
    const readonlyMutation = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'readonly mutation' }] }],
    };
    const tracker = new PageEditorDocumentTracker(saved);

    expect(tracker.recordUpdate(true, true, edited)).toEqual({ type: 'track', document: edited });
    expect(tracker.recordUpdate(false, true, readonlyMutation)).toEqual({
      type: 'restore',
      document: edited,
    });

    // The timer and unmount commit paths both consume this same pending editable snapshot.
    expect(tracker.takePending()).toEqual({ document: edited });
    expect(tracker.takePending()).toBeNull();
  });

  it('does not create a pending commit for a read-only programmatic mutation', () => {
    const saved = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved' }] }],
    };
    const readonlyMutation = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'readonly mutation' }] }],
    };
    const tracker = new PageEditorDocumentTracker(saved);

    expect(tracker.recordUpdate(false, true, readonlyMutation)).toEqual({ type: 'restore', document: saved });
    expect(tracker.takePending()).toBeNull();
  });

  it('accepts external source synchronization without scheduling a write', () => {
    const saved = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'saved' }] }],
    };
    const edited = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'edited' }] }],
    };
    const external = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'external update' }] }],
    };
    const tracker = new PageEditorDocumentTracker(saved);

    tracker.recordUpdate(true, true, edited);
    tracker.syncFromSource(external);

    expect(tracker.recordUpdate(false, true, edited)).toEqual({ type: 'restore', document: external });
    expect(tracker.takePending()).toBeNull();
  });
});
