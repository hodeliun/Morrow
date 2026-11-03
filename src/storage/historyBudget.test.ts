import { describe, expect, it } from 'vitest';
import { MAX_SESSION_HISTORY_BYTES, SessionHistoryBudget } from './historyBudget';

describe('session history budget', () => {
  it('shares byte accounting across stores and registers a shared event only once', () => {
    const budget = new SessionHistoryBudget();
    const bytes = 512;
    const event = {
      id: 'view:multi-scope-event',
      bytes,
      sequence: budget.nextSequence(),
      protected: false,
      evict: () => budget.remove('view:multi-scope-event'),
    };

    expect(budget.register(event)).toBe(true);
    expect(budget.register(event)).toBe(true);
    expect(budget.usedBytes).toBe(bytes);
    expect(budget.nextSequence()).toBeGreaterThan(event.sequence);
  });

  it('evicts the globally oldest eligible entry and recalculates after causal-chain removal', () => {
    const budget = new SessionHistoryBudget();
    const firstId = 'data:older';
    const secondId = 'view:next';
    const removed: string[] = [];
    const firstBytes = MAX_SESSION_HISTORY_BYTES / 2;
    expect(
      budget.register({
        id: firstId,
        bytes: firstBytes,
        sequence: budget.nextSequence(),
        protected: false,
        evict: () => {
          removed.push(firstId, secondId);
          budget.remove(firstId);
          budget.remove(secondId);
        },
      }),
    ).toBe(true);
    expect(
      budget.register({
        id: secondId,
        bytes: firstBytes,
        sequence: budget.nextSequence(),
        protected: false,
        evict: () => {
          removed.push(secondId);
          budget.remove(secondId);
        },
      }),
    ).toBe(true);

    const newestId = 'view:newest';
    expect(
      budget.register({
        id: newestId,
        bytes: firstBytes,
        sequence: budget.nextSequence(),
        protected: false,
        evict: () => budget.remove(newestId),
      }),
    ).toBe(true);
    expect(removed).toEqual([firstId, secondId]);
    expect(budget.usedBytes).toBe(firstBytes);
  });

  it('keeps protected recovery entries and refuses a new payload when they fill the budget', () => {
    const budget = new SessionHistoryBudget();
    for (const [id, protectedEntry] of [
      ['data:pending', true],
      ['view:busy', true],
    ] as const) {
      expect(
        budget.register({
          id,
          bytes: MAX_SESSION_HISTORY_BYTES / 2,
          sequence: budget.nextSequence(),
          protected: protectedEntry,
          evict: () => budget.remove(id),
        }),
      ).toBe(true);
    }
    expect(budget.overLimit).toBe(false);
    expect(
      budget.register({
        id: 'data:conflict',
        bytes: 1,
        sequence: budget.nextSequence(),
        protected: true,
        evict: () => budget.remove('data:conflict'),
      }),
    ).toBe(true);
    expect(budget.overLimit).toBe(true);
    expect(
      budget.register({
        id: 'view:new-action',
        bytes: 128,
        sequence: budget.nextSequence(),
        protected: false,
        evict: () => budget.remove('view:new-action'),
      }),
    ).toBe(false);
    expect(budget.usedBytes).toBeGreaterThan(MAX_SESSION_HISTORY_BYTES);
  });
});
