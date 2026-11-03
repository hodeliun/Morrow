import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import { LinkedDatabaseView as LinkedDatabaseViewExtension } from './LinkedDatabase';
import {
  shouldDisableLinkedDatabaseDropCursor,
  shouldStopLinkedDatabaseNodeViewEvent,
} from './linkedDatabaseEvents';

interface EventOptions {
  insideNodeView?: boolean;
  insideGrid?: boolean;
  dragSource?: boolean;
  columnDropTarget?: boolean;
  dataTransferTypes?: string[];
}

function event(type: string, options: EventOptions = {}): Event {
  return {
    type,
    target: {
      closest: (selector: string) => {
        if (selector === '.linked-database-block' && options.insideNodeView) return {};
        if (selector === '.linked-database-view .db-table th' && options.columnDropTarget) return {};
        if (selector.includes('.linked-database-view') && options.insideGrid) return {};
        if (selector.includes('[draggable="true"]') && options.dragSource) return {};
        return null;
      },
    },
    dataTransfer: options.dataTransferTypes ? { types: options.dataTransferTypes } : null,
  } as unknown as Event;
}

describe('linked database node view event boundary', () => {
  it('keeps grid pointer selection and focused input events inside the widget', () => {
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
      expect(shouldStopLinkedDatabaseNodeViewEvent(event(type, { insideNodeView: true }))).toBe(true);
    }
    for (const type of ['keydown', 'keypress', 'keyup', 'copy', 'cut', 'paste', 'beforeinput', 'input']) {
      expect(
        shouldStopLinkedDatabaseNodeViewEvent(event(type, { insideNodeView: true, insideGrid: true })),
      ).toBe(true);
    }
  });

  it('keeps row drag events with the grid while preserving external block drag and drop', () => {
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(event('dragstart', { insideNodeView: true, dragSource: true })),
    ).toBe(true);
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(
        event('dragover', { insideNodeView: true, dataTransferTypes: ['application/x-morrow-row-ids'] }),
      ),
    ).toBe(true);
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(
        event('drop', { insideNodeView: true, dataTransferTypes: ['application/x-morrow-row-ids'] }),
      ),
    ).toBe(true);
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(
        event('dragover', { insideNodeView: true, dataTransferTypes: ['text/html', 'text/plain'] }),
      ),
    ).toBe(false);
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(
        event('drop', { insideNodeView: true, dataTransferTypes: ['text/html', 'text/plain'] }),
      ),
    ).toBe(false);
  });

  it('keeps column reordering inside linked table headers without capturing unrelated drops', () => {
    const columnPayload = ['application/x-morrow-column-id'];
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(event('dragstart', { insideNodeView: true, dragSource: true })),
    ).toBe(true);
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(
        event('dragover', {
          insideNodeView: true,
          columnDropTarget: true,
          dataTransferTypes: columnPayload,
        }),
      ),
    ).toBe(true);
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(
        event('drop', {
          insideNodeView: true,
          columnDropTarget: true,
          dataTransferTypes: columnPayload,
        }),
      ),
    ).toBe(true);
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(
        event('drop', {
          insideNodeView: true,
          dataTransferTypes: columnPayload,
        }),
      ),
    ).toBe(false);
    expect(
      shouldStopLinkedDatabaseNodeViewEvent(
        event('dragover', {
          insideNodeView: true,
          columnDropTarget: true,
          dataTransferTypes: ['text/html', 'text/plain'],
        }),
      ),
    ).toBe(false);
  });

  it('disables the ProseMirror marker only for column payloads over linked database views', () => {
    const columnPayload = ['application/x-morrow-column-id'];
    expect(
      shouldDisableLinkedDatabaseDropCursor(
        event('dragover', { insideGrid: true, dataTransferTypes: columnPayload }),
      ),
    ).toBe(true);
    expect(
      shouldDisableLinkedDatabaseDropCursor(
        event('dragover', {
          insideGrid: true,
          dataTransferTypes: ['application/x-morrow-row-ids'],
        }),
      ),
    ).toBe(false);
    expect(
      shouldDisableLinkedDatabaseDropCursor(
        event('dragover', {
          insideGrid: true,
          dataTransferTypes: ['text/html', 'text/plain'],
        }),
      ),
    ).toBe(false);
    expect(
      shouldDisableLinkedDatabaseDropCursor(
        event('dragover', { insideNodeView: true, dataTransferTypes: columnPayload }),
      ),
    ).toBe(false);
    expect(
      shouldDisableLinkedDatabaseDropCursor(
        event('dragend', { insideGrid: true, dataTransferTypes: columnPayload }),
      ),
    ).toBe(false);
  });

  it('adds the scoped drop-cursor guard to the linked-view node, not paragraph', () => {
    const schema = getSchema([StarterKit, LinkedDatabaseViewExtension]);
    const linkedViewSpec = schema.nodes.linkedDatabaseView!.spec as Record<string, unknown>;
    const paragraphSpec = schema.nodes.paragraph!.spec as Record<string, unknown>;
    expect(typeof linkedViewSpec.disableDropCursor).toBe('function');
    expect(paragraphSpec.disableDropCursor).toBeUndefined();

    const disableDropCursor = linkedViewSpec.disableDropCursor as (
      view: unknown,
      pos: unknown,
      event: Event,
    ) => boolean;
    expect(disableDropCursor(null, null, event('dragover', {
      insideGrid: true,
      dataTransferTypes: ['application/x-morrow-column-id'],
    }))).toBe(true);
    expect(disableDropCursor(null, null, event('dragover', {
      insideGrid: true,
      dataTransferTypes: ['application/x-morrow-row-ids'],
    }))).toBe(false);
  });

  it('leaves editor events outside the widget and unrelated widget events alone', () => {
    expect(shouldStopLinkedDatabaseNodeViewEvent(event('mousedown'))).toBe(false);
    expect(shouldStopLinkedDatabaseNodeViewEvent(event('keydown', { insideNodeView: true }))).toBe(false);
    expect(shouldStopLinkedDatabaseNodeViewEvent(event('focus', { insideNodeView: true }))).toBe(false);
    expect(shouldStopLinkedDatabaseNodeViewEvent({ type: 'mousedown', target: null } as Event)).toBe(false);
  });
});
