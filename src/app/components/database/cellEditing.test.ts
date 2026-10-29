import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../../../storage/memoryVault';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { DraftInput } from './PropertyValue';
import {
  attemptCellDraftCommit,
  cellEditStartKey,
  cellPickerStartProps,
  isCellEditableNow,
  parseCellNumberDraft,
  placeInitialCellDraftCaret,
} from './cellEditing';

describe('cellEditStartKey', () => {
  it('returns printable text, including spaces and non-ASCII keys', () => {
    expect(cellEditStartKey({ key: 'a' })).toEqual({ kind: 'text', text: 'a' });
    expect(cellEditStartKey({ key: ' ' })).toEqual({ kind: 'text', text: ' ' });
    expect(cellEditStartKey({ key: 'ç' })).toEqual({ kind: 'text', text: 'ç' });
  });

  it('does not consume navigation keys or keyboard shortcuts', () => {
    for (const key of ['ArrowDown', 'Enter', 'Tab', 'Escape', 'Delete', 'F2'])
      expect(cellEditStartKey({ key })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: 'c', ctrlKey: true })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: 'v', metaKey: true })).toEqual({ kind: 'none' });
    expect(cellEditStartKey({ key: 'x', altKey: true })).toEqual({ kind: 'none' });
  });

  it('preserves AltGraph and IME composition input', () => {
    expect(cellEditStartKey({ key: '@', ctrlKey: true, altKey: true, altGraph: true })).toEqual({
      kind: 'text',
      text: '@',
    });
    expect(cellEditStartKey({ key: 'Process', isComposing: true })).toEqual({ kind: 'composition' });
    expect(cellEditStartKey({ key: 'Dead' })).toEqual({ kind: 'composition' });
    expect(cellEditStartKey({ key: 'Unidentified', keyCode: 229 })).toEqual({ kind: 'composition' });
  });

  it('seeds the editor with the first character instead of the previous cell value', () => {
    const markup = renderToStaticMarkup(
      createElement(DraftInput, {
        type: 'text',
        label: 'Notes',
        value: 'previous value',
        editable: true,
        gridMode: true,
        initialDraft: 'N',
        onCommit: () => {},
      }),
    );

    expect(markup).toContain('value="N"');
    expect(markup).not.toContain('previous value');
  });
});

describe('parseCellNumberDraft', () => {
  it.each<[string, string, number]>([
    ['-5.25', 'en-US', -5.25],
    ['.5', 'en-US', 0.5],
    ['-0.5', 'en-US', -0.5],
    [',5', 'pt-BR', 0.5],
  ])('parses %s with locale %s without losing its leading character', (draft, locale, expected) => {
    expect(parseCellNumberDraft(draft, locale)).toBe(expected);
  });

  it.each<[string, string]>([
    ['-', 'pt-BR'],
    ['.', 'en-US'],
    [',', 'pt-BR'],
    ['1,2.3', 'pt-BR'],
    ['1,234', 'en-US'],
    ['not a number', 'en-US'],
  ])('rejects invalid or partial draft %s in locale %s', (draft, locale) => {
    expect(parseCellNumberDraft(draft, locale)).toBeNull();
  });
});

describe('cellPickerStartProps', () => {
  it.each(['select', 'multiSelect', 'relation'])(
    'passes the first printable character to the %s picker query',
    (type) => {
      const startKey = cellEditStartKey({ key: 'a' });

      expect(cellPickerStartProps(type, startKey)).toEqual({
        initialText: 'a',
        openPickerOnEdit: true,
      });
    },
  );

  it('opens pickers for composition without replacing the composing text with a seed', () => {
    const startKey = cellEditStartKey({ key: 'Process', isComposing: true });

    expect(cellPickerStartProps('select', startKey)).toEqual({ openPickerOnEdit: true });
  });

  it('does not seed or open a picker for F2 editing', () => {
    const startKey = cellEditStartKey({ key: 'F2' });

    expect(cellPickerStartProps('select', startKey)).toEqual({});
  });
});

describe('placeInitialCellDraftCaret', () => {
  it('puts the continued-typing caret after the seeded first character', () => {
    const positions: Array<[number | null, number | null]> = [];
    const pending = { current: true };

    placeInitialCellDraftCaret(
      { value: '#', setSelectionRange: (start, end) => positions.push([start, end]) },
      pending,
    );

    expect(positions).toEqual([[1, 1]]);
    expect(pending.current).toBe(false);
  });

  it('does not reset the caret after later focus or when no first-key draft exists', () => {
    const positions: Array<[number | null, number | null]> = [];
    const setSelectionRange = (start: number | null, end: number | null) => positions.push([start, end]);
    const pending = { current: true };

    placeInitialCellDraftCaret({ value: '#', setSelectionRange }, pending);
    placeInitialCellDraftCaret({ value: '#Titulo', setSelectionRange }, pending);
    placeInitialCellDraftCaret({ value: 'existing text', setSelectionRange }, { current: false });

    expect(positions).toEqual([[1, 1]]);
  });

  it('leaves numeric input caret placement to the browser', () => {
    const positions: Array<[number | null, number | null]> = [];
    const pending = { current: true };

    placeInitialCellDraftCaret(
      { type: 'number', value: '5', setSelectionRange: (start, end) => positions.push([start, end]) },
      pending,
    );

    expect(positions).toEqual([]);
    expect(pending.current).toBe(false);
  });
});

describe('attemptCellDraftCommit', () => {
  it('keeps partial numeric input invalid and does not commit escaped or read-only drafts', () => {
    const validate = (draft: string) =>
      parseCellNumberDraft(draft, 'pt-BR') === null ? 'Enter a valid number.' : null;
    const onCommit = vi.fn(() => true);

    expect(
      attemptCellDraftCommit({
        editable: true,
        draft: '-',
        value: '3',
        validate,
        onCommit,
      }),
    ).toEqual({ kind: 'invalid', error: 'Enter a valid number.' });
    expect(
      attemptCellDraftCommit({
        editable: true,
        draft: null,
        value: '3',
        validate,
        onCommit,
      }),
    ).toEqual({ kind: 'unchanged' });
    expect(
      attemptCellDraftCommit({
        editable: true,
        canEditNow: () => false,
        draft: '-0.5',
        value: '3',
        validate,
        onCommit,
      }),
    ).toEqual({ kind: 'readonly' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('does not validate or write a pending draft after edit permission is revoked', () => {
    const validate = vi.fn(() => null);
    const onCommit = vi.fn(() => true);

    const result = attemptCellDraftCommit({
      editable: false,
      draft: 'r',
      value: 'Row title',
      validate,
      onCommit,
    });

    expect(result).toEqual({ kind: 'readonly' });
    expect(validate).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('checks live edit permission when the rendered editable prop is stale', () => {
    const validate = vi.fn(() => null);
    const onCommit = vi.fn(() => true);

    const result = attemptCellDraftCommit({
      editable: true,
      canEditNow: () => false,
      draft: 'late draft',
      value: 'saved value',
      validate,
      onCommit,
    });

    expect(result).toEqual({ kind: 'readonly' });
    expect(validate).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('leaves workspace state and save queue unchanged after same-tick revocation', async () => {
    let nextId = 0;
    const vault = new MemoryVault();
    const open = async () => {
      const result = await WorkspaceSession.open(
        new VaultRepository(vault, () => `livePermission${++nextId}`),
        { delayMs: 0 },
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    };
    const session = await open();
    const created = session.execute({
      type: 'page.create',
      id: 'live-permission-row',
      parentId: null,
      title: 'Saved title',
      now: 1,
    });
    if (!created.ok) throw new Error(created.error);
    expect(await session.flush()).toBe(true);

    const stateBefore = session.getState();
    const onCommit = vi.fn((title: string) =>
      session.execute({ type: 'page.rename', id: 'live-permission-row', title, now: 2 }),
    );
    const result = attemptCellDraftCommit({
      editable: true,
      canEditNow: () => false,
      draft: 'late title',
      value: 'Saved title',
      onCommit,
    });

    expect(result).toEqual({ kind: 'readonly' });
    expect(onCommit).not.toHaveBeenCalled();
    expect(session.getState()).toBe(stateBefore);
    expect(session.getState().pages['live-permission-row']?.title).toBe('Saved title');
    expect(session.queue.hasPending()).toBe(false);
    expect(session.queue.isDirty('live-permission-row')).toBe(false);
    await session.close();

    const reopened = await open();
    expect(reopened.getState().pages['live-permission-row']?.title).toBe('Saved title');
    expect(reopened.queue.hasPending()).toBe(false);
    await reopened.close();
  });

  it('keeps validation feedback for an editable draft and skips its write', () => {
    const onCommit = vi.fn(() => true);
    const result = attemptCellDraftCommit({
      editable: true,
      draft: 'invalid',
      value: 'previous',
      validate: () => 'Correct this value.',
      onCommit,
    });

    expect(result).toEqual({ kind: 'invalid', error: 'Correct this value.' });
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('isCellEditableNow', () => {
  it('combines the rendered permission with the synchronous host permission', () => {
    expect(isCellEditableNow(true, () => false)).toBe(false);
    expect(isCellEditableNow(false, () => true)).toBe(false);
    expect(isCellEditableNow(true)).toBe(true);
  });
});
