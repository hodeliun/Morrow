import { describe, expect, it } from 'vitest';
import {
  applyFormulaSuggestion,
  formulaSelectionChanged,
  formulaSuggestionForCommitKey,
  moveFormulaSuggestionIndex,
  shouldResetFormulaSuggestionIndexOnKeyUp,
  updateFormulaDraftCaret,
} from './FormulaEditor';
import type { FormulaDraftState } from './FormulaEditor';
import { emptyDoc, newPageMeta } from '../../../core/model';
import type { DatabaseDef, PageMeta, PropDef, WorkspaceState } from '../../../core/model';
import { formulaSuggestions } from './formulaEditorModel';
import type { FormulaSuggestion } from './formulaEditorModel';

function relationSuggestions(): FormulaSuggestion[] {
  const authors: PropDef[] = [
    { id: 'author-name', name: 'Author Name', type: 'text', options: [] },
    { id: 'biography-long', name: 'Biography Long', type: 'text', options: [] },
  ];
  const authorDatabase: DatabaseDef = { properties: authors, views: [] };
  const authorPage = newPageMeta({
    id: 'authors',
    parentId: null,
    title: 'Authors',
    kind: 'database',
    database: authorDatabase,
    createdAt: 1,
    updatedAt: 1,
  });
  const booksDatabase: DatabaseDef = {
    properties: [
      {
        id: 'author-relation',
        name: 'Autor',
        type: 'relation',
        options: [],
        relation: {
          targetDatabaseId: 'authors',
          multiple: false,
          isInverse: false,
          displayPropertyId: null,
          inversePropertyId: null,
          filters: [],
        },
      },
    ],
    views: [],
  };
  const booksPage = newPageMeta({
    id: 'books',
    parentId: null,
    title: 'Books',
    kind: 'database',
    database: booksDatabase,
    createdAt: 1,
    updatedAt: 1,
  });
  const state: WorkspaceState = {
    pages: { authors: authorPage, books: booksPage } as Record<string, PageMeta>,
    docs: { authors: emptyDoc(), books: emptyDoc() },
  };
  return formulaSuggestions('Autor.', 'Autor.'.length, 'books', booksDatabase, state, []);
}

const suggestions = relationSuggestions();

describe('FormulaEditor keyboard suggestions', () => {
  it('moves to a suggestion after the first and wraps in both directions', () => {
    expect(suggestions.map((suggestion) => suggestion.label)).toEqual(['Author Name', 'Biography Long']);
    const activeIndex = moveFormulaSuggestionIndex(0, 'ArrowDown', suggestions.length);

    expect(activeIndex).toBe(1);
    expect(suggestions[activeIndex]?.label).toBe('Biography Long');
    expect(moveFormulaSuggestionIndex(activeIndex, 'ArrowDown', suggestions.length)).toBe(0);
    expect(moveFormulaSuggestionIndex(0, 'ArrowUp', suggestions.length)).toBe(1);
    expect(moveFormulaSuggestionIndex(0, 'ArrowDown', 0)).toBe(0);
  });

  it.each(['Tab', 'Enter'])('%s commits the active suggestion and preserves its caret and binding', (key) => {
    const selected = formulaSuggestionForCommitKey(key, suggestions, 1);

    expect(selected?.label).toBe('Biography Long');
    const insertion = applyFormulaSuggestion('Autor.', [], selected!);
    expect(insertion).toEqual({
      source: 'Autor.`Biography Long`',
      bindings: [
        {
          kind: 'property',
          databaseId: 'authors',
          propertyId: 'biography-long',
          start: 6,
          end: 22,
          source: '`Biography Long`',
        },
      ],
      caret: 22,
    });

    const committedState: FormulaDraftState = {
      baseFormula: '',
      baseBindingsKey: '[]',
      ...insertion,
    };
    const afterKeyUp = updateFormulaDraftCaret(committedState, '', '[]', [], insertion.caret);
    expect(afterKeyUp.source).toBe(insertion.source);
    expect(afterKeyUp.bindings).toEqual(insertion.bindings);
    expect(afterKeyUp.caret).toBe(insertion.caret);
  });

  it('does not treat suggestion navigation as a commit key', () => {
    expect(formulaSuggestionForCommitKey('ArrowDown', suggestions, 1)).toBeUndefined();
  });

  it('keeps the active suggestion during arrow navigation and resets after other keys', () => {
    expect(shouldResetFormulaSuggestionIndexOnKeyUp('ArrowDown', false, true, suggestions.length)).toBe(false);
    expect(shouldResetFormulaSuggestionIndexOnKeyUp('ArrowUp', false, true, suggestions.length)).toBe(false);
    expect(shouldResetFormulaSuggestionIndexOnKeyUp('ArrowLeft', true, true, suggestions.length)).toBe(true);
    expect(shouldResetFormulaSuggestionIndexOnKeyUp('ArrowDown', true, false, 0)).toBe(true);
  });

  it('does not reset the active suggestion when React reports onSelect without a range move', () => {
    const originalRange = { start: 6, end: 6 };
    const afterArrowDownIndex = moveFormulaSuggestionIndex(0, 'ArrowDown', suggestions.length);
    const selectRange = { start: 6, end: 6 };
    const resetFromSelect = formulaSelectionChanged(originalRange, selectRange);
    const resetFromKeyUp = shouldResetFormulaSuggestionIndexOnKeyUp(
      'ArrowDown',
      formulaSelectionChanged(selectRange, originalRange),
      true,
      suggestions.length,
    );

    expect(resetFromSelect).toBe(false);
    expect(resetFromKeyUp).toBe(false);
    expect(afterArrowDownIndex).toBe(1);
  });

  it('resets the active suggestion when the selected caret range actually changes', () => {
    expect(formulaSelectionChanged({ start: 6, end: 6 }, { start: 5, end: 5 })).toBe(true);
    expect(formulaSelectionChanged({ start: 6, end: 6 }, { start: 6, end: 8 })).toBe(true);
  });
});
