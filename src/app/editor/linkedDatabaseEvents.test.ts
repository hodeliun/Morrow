import { describe, expect, it } from 'vitest';
import { shouldStopLinkedDatabaseNodeViewEvent } from './linkedDatabaseEvents';

interface EventOptions {
  insideNodeView?: boolean;
  insideGrid?: boolean;
  dragSource?: boolean;
  dataTransferTypes?: string[];
}

function event(type: string, options: EventOptions = {}): Event {
  return {
    type,
    target: {
      closest: (selector: string) => {
        if (selector === '.linked-database-block' && options.insideNodeView) return {};
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

  it('leaves editor events outside the widget and unrelated widget events alone', () => {
    expect(shouldStopLinkedDatabaseNodeViewEvent(event('mousedown'))).toBe(false);
    expect(shouldStopLinkedDatabaseNodeViewEvent(event('keydown', { insideNodeView: true }))).toBe(false);
    expect(shouldStopLinkedDatabaseNodeViewEvent(event('focus', { insideNodeView: true }))).toBe(false);
    expect(shouldStopLinkedDatabaseNodeViewEvent({ type: 'mousedown', target: null } as Event)).toBe(false);
  });
});
