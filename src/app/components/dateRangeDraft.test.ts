import { describe, expect, it } from 'vitest';
import {
  dateRangeDraftInput,
  dateRangeValueSignature,
  reconcileDateRangeDraft,
} from './dateRangeDraft';

describe('date range input draft synchronization', () => {
  const identity = 't26-host:t26-period';

  it('keeps a partial local edit when the persisted value has not changed', () => {
    const persisted = ['2026-11-06', '2026-11-10'];
    const partial = { start: '2026-11-07', end: '' };

    expect(reconcileDateRangeDraft(
      identity,
      identity,
      dateRangeValueSignature(persisted),
      dateRangeValueSignature(persisted),
      partial,
      persisted,
    )).toBe(partial);
  });

  it('keeps the same completed draft object when its own persisted update catches up', () => {
    const previous = ['2026-11-06', '2026-11-10'];
    const committed = ['2026-11-07', '2026-11-11'];
    const completed = { start: committed[0]!, end: committed[1]! };

    expect(reconcileDateRangeDraft(
      identity,
      identity,
      dateRangeValueSignature(previous),
      dateRangeValueSignature(committed),
      completed,
      committed,
    )).toBe(completed);
  });

  it('adopts a changed external preset, reset, or other-pane value', () => {
    const previous = ['2026-11-06', '2026-11-10'];
    const external = ['2026-12-01', '2026-12-07'];
    const draft = { start: '2026-11-08', end: '' };

    expect(reconcileDateRangeDraft(
      identity,
      identity,
      dateRangeValueSignature(previous),
      dateRangeValueSignature(external),
      draft,
      external,
    )).toEqual(dateRangeDraftInput(external));
    expect(reconcileDateRangeDraft(
      identity,
      identity,
      dateRangeValueSignature(previous),
      dateRangeValueSignature(null),
      draft,
      null,
    )).toEqual({ start: '', end: '' });
  });

  it('resets a draft when the page/control identity changes, even if its value is equal', () => {
    const persisted = ['2026-11-06', '2026-11-10'];
    const partial = { start: '2026-11-07', end: '' };

    expect(reconcileDateRangeDraft(
      't26-host-a:t26-period',
      't26-host-b:t26-period',
      dateRangeValueSignature(persisted),
      dateRangeValueSignature(persisted),
      partial,
      persisted,
    )).toEqual(dateRangeDraftInput(persisted));
  });
});
