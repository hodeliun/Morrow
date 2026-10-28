import { describe, expect, it } from 'vitest';
import { shouldStopLinkedDatabaseControlEvent } from './linkedDatabaseEvents';

function event(type: string, selectorMatches: boolean): Event {
  return {
    type,
    target: {
      closest: (selector: string) => (selectorMatches && selector.includes('button') ? {} : null),
    },
  } as unknown as Event;
}

describe('linked database node view event boundary', () => {
  it('keeps control mouse events from changing the editor selection, including SVG targets inside buttons', () => {
    expect(shouldStopLinkedDatabaseControlEvent(event('mousedown', true))).toBe(true);
    expect(shouldStopLinkedDatabaseControlEvent(event('click', true))).toBe(true);
  });

  it('leaves block dragging and events outside linked view controls to ProseMirror', () => {
    expect(shouldStopLinkedDatabaseControlEvent(event('dragstart', true))).toBe(false);
    expect(shouldStopLinkedDatabaseControlEvent(event('mousedown', false))).toBe(false);
  });
});
