import { useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import type {
  DatabaseDef,
  FormulaReferenceBinding,
  PageId,
  PageMeta,
  PropDef,
} from '../../../core/model';
import { displayTitle, newPageMeta } from '../../../core/model';
import {
  bindFormulaReferences,
  formulaResult,
  formulaValueText,
  rowsOf,
} from '../../../core/database';
import { isEffectivelyTrashed } from '../../../core/tree';
import { t } from '../../i18n';
import { tr } from '../../i18n/rich';
import { updateProp } from './data';
import { useWorkspace } from '../../workspace';
import {
  adjustFormulaBindings,
  FORMULA_EXAMPLES,
  FORMULA_FUNCTIONS,
  formulaDecorations,
  formulaIdentifier,
  formulaSuggestions,
} from './formulaEditorModel';
import type { FormulaDecoration, FormulaSuggestion } from './formulaEditorModel';

export interface FormulaDraftState {
  baseFormula: string;
  baseBindingsKey: string;
  source: string;
  bindings: FormulaReferenceBinding[];
  caret: number;
}

export interface FormulaSelectionRange {
  start: number;
  end: number;
}

export function formulaSelectionChanged(previous: FormulaSelectionRange, next: FormulaSelectionRange): boolean {
  return previous.start !== next.start || previous.end !== next.end;
}

export function moveFormulaSuggestionIndex(
  current: number,
  key: 'ArrowDown' | 'ArrowUp',
  count: number,
): number {
  if (count < 1) return 0;
  return key === 'ArrowDown' ? (current + 1) % count : (current - 1 + count) % count;
}

export function formulaSuggestionForCommitKey(
  key: string,
  suggestions: FormulaSuggestion[],
  activeIndex: number,
): FormulaSuggestion | undefined {
  return key === 'Enter' || key === 'Tab' ? suggestions[activeIndex] : undefined;
}

export function shouldResetFormulaSuggestionIndexOnKeyUp(
  key: string,
  selectionMoved: boolean,
  suggestionsOpen: boolean,
  suggestionCount: number,
): boolean {
  const navigatingSuggestions =
    suggestionsOpen && suggestionCount > 0 && (key === 'ArrowDown' || key === 'ArrowUp');
  return selectionMoved && !navigatingSuggestions;
}

export function applyFormulaSuggestion(
  source: string,
  bindings: FormulaReferenceBinding[],
  suggestion: FormulaSuggestion,
): { source: string; bindings: FormulaReferenceBinding[]; caret: number } {
  const nextSource =
    source.slice(0, suggestion.replaceStart) +
    suggestion.insertText +
    source.slice(suggestion.replaceEnd);
  let nextBindings = adjustFormulaBindings(source, nextSource, bindings);
  if (suggestion.binding)
    nextBindings = [
      ...nextBindings,
      {
        ...suggestion.binding,
        start: suggestion.replaceStart,
        end: suggestion.replaceStart + suggestion.insertText.length,
        source: suggestion.insertText,
      },
    ];
  return {
    source: nextSource,
    bindings: nextBindings,
    caret: suggestion.replaceStart + (suggestion.caretOffset ?? suggestion.insertText.length),
  };
}

export function updateFormulaDraftCaret(
  current: FormulaDraftState,
  formula: string,
  bindingsKey: string,
  savedBindings: FormulaReferenceBinding[],
  caret: number,
): FormulaDraftState {
  if (current.baseFormula !== formula || current.baseBindingsKey !== bindingsKey)
    return {
      baseFormula: formula,
      baseBindingsKey: bindingsKey,
      source: formula,
      bindings: savedBindings,
      caret,
    };
  return { ...current, caret };
}

export function FormulaEditor({
  dbId,
  prop,
  database,
  defaultFormula = false,
  autoFocus = false,
}: {
  dbId: PageId;
  prop: PropDef;
  database: DatabaseDef;
  defaultFormula?: boolean;
  autoFocus?: boolean;
}) {
  const state = useWorkspace();
  const formula = defaultFormula ? (prop.defaultFormula ?? '') : (prop.formula ?? '');
  const savedBindings = defaultFormula ? (prop.defaultFormulaBindings ?? []) : (prop.formulaBindings ?? []);
  const savedBindingsKey = JSON.stringify(savedBindings);
  const [draftState, setDraftState] = useState<FormulaDraftState>(() => ({
    baseFormula: formula,
    baseBindingsKey: savedBindingsKey,
    source: formula,
    bindings: savedBindings,
    caret: formula.length,
  }));
  const staleDraft = draftState.baseFormula !== formula || draftState.baseBindingsKey !== savedBindingsKey;
  const draft = staleDraft ? formula : draftState.source;
  const draftBindings = staleDraft ? savedBindings : draftState.bindings;
  const caret = staleDraft ? formula.length : draftState.caret;
  const [assistTableId, setAssistTableId] = useState(dbId);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [focused, setFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const selectionRangeRef = useRef<FormulaSelectionRange>({ start: formula.length, end: formula.length });
  const selectionChangedSinceKeyUpRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  const inputId = `${prop.id}-${defaultFormula ? 'default-formula' : 'formula'}`;

  useLayoutEffect(() => {
    const pendingCaret = pendingCaretRef.current;
    if (pendingCaret === null || !textareaRef.current) return;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(pendingCaret, pendingCaret);
    pendingCaretRef.current = null;
  });

  useLayoutEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const previewBindings = bindFormulaReferences(draft, dbId, state, draftBindings);
  const liveRows = rowsOf(state, dbId);
  const hasRows = liveRows.length > 0;
  const previewRow = liveRows[0] ?? makePreviewRow(dbId, database);
  const previewState = hasRows
    ? state
    : { ...state, pages: { ...state.pages, [previewRow.id]: previewRow } };
  const preview = draft.trim()
    ? formulaResult(
        previewRow,
        { ...prop, formula: draft, formulaBindings: previewBindings },
        database,
        0,
        previewState,
      )
    : null;
  const tables = Object.values(state.pages)
    .filter(
      (page) => page.kind === 'database' && page.database && !isEffectivelyTrashed(state.pages, page.id),
    )
    .sort((left, right) => displayTitle(left).localeCompare(displayTitle(right)));
  const assistTable = state.pages[assistTableId];
  const assistProperties = assistTable?.database?.properties ?? database.properties;
  const suggestions = focused && suggestionsOpen
    ? formulaSuggestions(draft, caret, dbId, database, state, previewBindings)
    : [];
  const selectedSuggestion = suggestions[activeSuggestion];
  const decorations = formulaDecorations(draft, previewBindings);
  const dirty = draft !== formula || JSON.stringify(previewBindings) !== JSON.stringify(savedBindings);

  const setDraftSource = (source: string, nextBindings = draftBindings, nextCaret = source.length) => {
    setDraftState({
      baseFormula: formula,
      baseBindingsKey: savedBindingsKey,
      source,
      bindings: nextBindings,
      caret: nextCaret,
    });
    setActiveSuggestion(0);
  };

  const insertAtEnd = (
    text: string,
    binding?: { kind: 'database'; databaseId: PageId } | { kind: 'property'; databaseId: PageId; propertyId: string },
    bindingText = text,
    caretOffset = text.length,
  ) => {
    const separator = text.startsWith('.') ? '' : draft && !/\s$/u.test(draft) ? ' ' : '';
    const start = draft.length + separator.length + text.indexOf(bindingText);
    const next = `${draft}${separator}${text}`;
    let nextBindings = adjustFormulaBindings(draft, next, draftBindings);
    if (binding)
      nextBindings = [
        ...nextBindings,
        { ...binding, start, end: start + bindingText.length, source: bindingText },
      ];
    setDraftSource(next, nextBindings, draft.length + separator.length + caretOffset);
    pendingCaretRef.current = draft.length + separator.length + caretOffset;
  };

  const selectSuggestion = (suggestion: FormulaSuggestion) => {
    const insertion = applyFormulaSuggestion(draft, draftBindings, suggestion);
    setDraftSource(insertion.source, insertion.bindings, insertion.caret);
    pendingCaretRef.current = insertion.caret;
    setSuggestionsOpen(false);
  };

  const save = () => {
    const bindings = bindFormulaReferences(draft, dbId, state, draftBindings);
    if (
      draft !== formula ||
      JSON.stringify(bindings) !== JSON.stringify(savedBindings)
    )
      updateProp(dbId, prop.id, (current) =>
        defaultFormula
          ? { ...current, defaultFormula: draft, defaultFormulaBindings: bindings }
          : { ...current, formula: draft, formulaBindings: bindings },
      );
    setDraftSource(draft, bindings, caret);
    setSuggestionsOpen(false);
  };

  const cancel = () => {
    setDraftSource(formula, savedBindings, formula.length);
    setSuggestionsOpen(false);
    pendingCaretRef.current = null;
  };

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (suggestions.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      setActiveSuggestion((current) =>
        moveFormulaSuggestionIndex(current, event.key as 'ArrowDown' | 'ArrowUp', suggestions.length),
      );
      return;
    }
    const suggestionToCommit = formulaSuggestionForCommitKey(event.key, suggestions, activeSuggestion);
    if (selectedSuggestion && suggestionToCommit) {
      event.preventDefault();
      selectSuggestion(suggestionToCommit);
      return;
    }
    if (event.key === 'Escape' && suggestionsOpen) {
      event.preventDefault();
      setSuggestionsOpen(false);
      return;
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  };

  const onTextareaChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const source = event.target.value;
    const nextCaret = event.target.selectionStart;
    selectionRangeRef.current = { start: nextCaret, end: event.target.selectionEnd };
    selectionChangedSinceKeyUpRef.current = false;
    const bindings = adjustFormulaBindings(draft, source, draftBindings);
    setDraftState({
      baseFormula: formula,
      baseBindingsKey: savedBindingsKey,
      source,
      bindings,
      caret: nextCaret,
    });
    setSuggestionsOpen(true);
    setActiveSuggestion(0);
  };

  const onTextareaSelectionChange = (element: HTMLTextAreaElement, resetActiveSuggestion = true) => {
    setDraftState((current) =>
      updateFormulaDraftCaret(current, formula, savedBindingsKey, savedBindings, element.selectionStart),
    );
    if (resetActiveSuggestion) setActiveSuggestion(0);
  };

  const insertFunction = (name: string) => insertAtEnd(`${name}()`, undefined, `${name}()`, name.length + 1);

  return (
    <div className="field formula-field">
      <span>{defaultFormula ? t('database.defaultFormula') : t('slash.items.math.title')}</span>
      <div className="formula-source-shell">
        <pre className="formula-highlight" aria-hidden="true" ref={highlightRef}>
          <FormulaSource source={draft} decorations={decorations} />
          {draft.endsWith('\n') ? '\u200b' : null}
        </pre>
        <textarea
          id={inputId}
          ref={textareaRef}
          data-autofocus={autoFocus ? '' : undefined}
          className="text-input small formula-input"
          spellCheck={false}
          value={draft}
          placeholder='prop("Price") * prop("Count")'
          aria-label={defaultFormula ? t('database.defaultFormula') : t('slash.items.math.title')}
          aria-autocomplete="list"
          aria-expanded={suggestions.length > 0}
          aria-controls={suggestions.length > 0 ? `${inputId}-suggestions` : undefined}
          aria-activedescendant={selectedSuggestion ? `${inputId}-suggestion-${activeSuggestion}` : undefined}
          onChange={onTextareaChange}
          onFocus={() => {
            setFocused(true);
            setSuggestionsOpen(true);
          }}
          onBlur={() => setFocused(false)}
          onClick={(event) => {
            selectionRangeRef.current = {
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            };
            selectionChangedSinceKeyUpRef.current = false;
            onTextareaSelectionChange(event.currentTarget);
          }}
          onKeyUp={(event) => {
            const nextSelection = {
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            };
            const selectionMoved =
              selectionChangedSinceKeyUpRef.current ||
              formulaSelectionChanged(selectionRangeRef.current, nextSelection);
            selectionRangeRef.current = nextSelection;
            selectionChangedSinceKeyUpRef.current = false;
            onTextareaSelectionChange(
              event.currentTarget,
              shouldResetFormulaSuggestionIndexOnKeyUp(
                event.key,
                selectionMoved,
                suggestionsOpen,
                suggestions.length,
              ),
            );
          }}
          onSelect={(event) => {
            const nextSelection = {
              start: event.currentTarget.selectionStart,
              end: event.currentTarget.selectionEnd,
            };
            if (formulaSelectionChanged(selectionRangeRef.current, nextSelection))
              selectionChangedSinceKeyUpRef.current = true;
            selectionRangeRef.current = nextSelection;
            onTextareaSelectionChange(event.currentTarget, false);
          }}
          onScroll={(event) => {
            if (!highlightRef.current) return;
            highlightRef.current.scrollTop = event.currentTarget.scrollTop;
            highlightRef.current.scrollLeft = event.currentTarget.scrollLeft;
          }}
          onKeyDown={onTextareaKeyDown}
        />
      </div>
      <div className="formula-assist" aria-label={t('database.formulaAssist')}>
        <label className="visually-hidden" htmlFor={`${inputId}-function`}>
          {t('database.formulaFunction')}
        </label>
        <select
          id={`${inputId}-function`}
          className="text-input small"
          value=""
          aria-label={t('database.formulaFunction')}
          onChange={(event) => {
            if (event.target.value) insertFunction(event.target.value);
          }}
        >
          <option value="">{t('database.formulaFunction')}</option>
          {FORMULA_FUNCTIONS.split(', ').map((name) => (
            <option key={name} value={name}>
              {name}()
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor={`${inputId}-field`}>
          {t('database.formulaField')}
        </label>
        <select
          id={`${inputId}-field`}
          className="text-input small"
          value=""
          aria-label={t('database.formulaField')}
          onChange={(event) => {
            const field = database.properties.find((item) => item.id === event.target.value);
            if (!field) return;
            const name = formulaIdentifier(field.name);
            insertAtEnd(`thisRow.${name}`, { kind: 'property', databaseId: dbId, propertyId: field.id }, name);
          }}
        >
          <option value="">{t('database.formulaField')}</option>
          {database.properties.map((field) => (
            <option key={field.id} value={field.id}>
              {choiceLabel(field.name, field.id, database.properties)}
            </option>
          ))}
        </select>
        <label className="visually-hidden" htmlFor={`${inputId}-table`}>
          {t('database.formulaTable')}
        </label>
        <select
          id={`${inputId}-table`}
          className="text-input small"
          value=""
          aria-label={t('database.formulaTable')}
          onChange={(event) => {
            const table = tables.find((item) => item.id === event.target.value);
            if (!table) return;
            setAssistTableId(table.id);
            const name = formulaIdentifier(displayTitle(table));
            insertAtEnd(name, { kind: 'database', databaseId: table.id }, name);
          }}
        >
          <option value="">{t('database.formulaTable')}</option>
          {tables.map((table) => (
            <option key={table.id} value={table.id}>
              {choiceLabel(
                displayTitle(table),
                table.id,
                tables.map((item) => ({ name: displayTitle(item) })),
              )}
            </option>
          ))}
        </select>
        {assistTableId !== dbId && (
          <select
            className="text-input small"
            value=""
            aria-label={t('database.formulaTableField')}
            onChange={(event) => {
              const field = assistProperties.find((item) => item.id === event.target.value);
              if (!field) return;
              const name = formulaIdentifier(field.name);
              insertAtEnd(`.${name}`, { kind: 'property', databaseId: assistTableId, propertyId: field.id }, name);
            }}
          >
            <option value="">{t('database.formulaTableField')}</option>
            {assistProperties.map((field) => (
              <option key={field.id} value={field.id}>
                {choiceLabel(field.name, field.id, assistProperties)}
              </option>
            ))}
          </select>
        )}
      </div>
      {suggestions.length > 0 && (
        <div
          className="formula-suggestions"
          id={`${inputId}-suggestions`}
          role="listbox"
          aria-label={t('database.formulaSuggestions')}
        >
          {suggestions.map((item, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === activeSuggestion}
              id={`${inputId}-suggestion-${index}`}
              key={`${item.kind}:${item.binding?.kind === 'database' ? item.binding.databaseId : item.binding?.kind === 'property' ? `${item.binding.databaseId}:${item.binding.propertyId}` : item.label}`}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveSuggestion(index)}
              onClick={() => selectSuggestion(item)}
            >
              <span>{item.label}</span>
              <small>{item.description || suggestionDescription(item.kind)}</small>
            </button>
          ))}
        </div>
      )}
      {preview?.error ? (
        <span className="formula-error" role="alert" aria-live="polite">
          {preview.error}
        </span>
      ) : preview ? (
        <div className="formula-preview" role="status" aria-live="polite">
          <span>
            {tr('database.formulaPreview', {
              value: <strong>{formulaValueText(prop, preview.value, previewState) || t('database.emptyValue')}</strong>,
              type: <span className="formula-preview-type">{formulaTypeLabel(preview.value)}</span>,
            })}
          </span>
          {!hasRows && <span className="muted small">{t('database.formulaNoRows')}</span>}
        </div>
      ) : null}
      <div className="field-inline formula-actions">
        <button type="button" className="button small" disabled={!dirty} onClick={save}>
          {t('common.save')}
        </button>
        <button type="button" className="button small" disabled={!dirty} onClick={cancel}>
          {t('common.cancel')}
        </button>
      </div>
      <details className="formula-help">
        <summary>{t('database.howFormulasWork')}</summary>
        <p className="muted small">
          {tr('database.formulaHelp', {
            prop: <code>prop("Name")</code>,
            maths: <code>+ - * / ^</code>,
            compare: <code>&gt; == !=</code>,
            and: <code>and</code>,
            or: <code>or</code>,
            not: <code>not</code>,
            functions: FORMULA_FUNCTIONS,
          })}
        </p>
        <ul className="formula-examples">
          {FORMULA_EXAMPLES.map((example) => (
            <li key={example}>
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  const bindings = bindFormulaReferences(example, dbId, state, draftBindings);
                  setDraftSource(example, bindings, example.length);
                  pendingCaretRef.current = example.length;
                }}
              >
                <code>{example}</code>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function choiceLabel(name: string, id: string, choices: Array<{ name: string }>): string {
  return choices.filter((choice) => choice.name.toLocaleLowerCase() === name.toLocaleLowerCase()).length > 1
    ? `${name} · ${id}`
    : name;
}

function suggestionDescription(kind: FormulaSuggestion['kind']): string {
  return t(
    kind === 'function'
      ? 'database.formulaFunction'
      : kind === 'database'
        ? 'database.formulaTable'
        : kind === 'context'
          ? 'database.formulaCurrentRow'
          : 'database.formulaTableField',
  );
}

function formulaTypeLabel(value: ReturnType<typeof formulaResult>['value']): string {
  if (value === null) return t('database.formulaTypeBlank');
  if (Array.isArray(value)) return t('database.formulaTypeList');
  if (typeof value === 'number') return t('database.typeNumber');
  if (typeof value === 'boolean') return t('database.typeCheckbox');
  if (typeof value === 'string') return t('database.typeText');
  if (value.formulaKind === 'row') return t('database.formulaTypeRow');
  if (value.formulaKind === 'rows') return t('database.formulaTypeRows');
  return t('database.formulaTypeTable');
}

function makePreviewRow(dbId: PageId, database: DatabaseDef): PageMeta {
  const properties = Object.fromEntries(
    database.properties.map((property) => [property.id, previewPropertyValue(property)]),
  );
  return newPageMeta({
    id: `formula-preview:${dbId}`,
    parentId: dbId,
    title: t('database.formulaPreviewRow'),
    properties,
  });
}

function previewPropertyValue(property: PropDef): PageMeta['properties'][string] {
  if (property.defaultValue !== undefined) return property.defaultValue;
  if (property.type === 'checkbox') return false;
  if (property.type === 'multiSelect') return [];
  if (property.type === 'relation') return property.relation?.multiple ? [] : null;
  if (['number', 'currency', 'percent', 'slider', 'progress', 'scale', 'duration'].includes(property.type))
    return 0;
  if (['text', 'email', 'url', 'phone'].includes(property.type)) return '';
  if (property.type === 'createdTime' || property.type === 'lastEditedTime') return 0;
  return null;
}

function FormulaSource({ source, decorations }: { source: string; decorations: FormulaDecoration[] }) {
  const pieces: ReactNode[] = [];
  let cursor = 0;
  for (const decoration of decorations) {
    if (decoration.start < cursor || decoration.end > source.length) continue;
    if (decoration.start > cursor) pieces.push(source.slice(cursor, decoration.start));
    pieces.push(
      <span key={`${decoration.start}:${decoration.end}`} className={`formula-token formula-token-${decoration.kind}`}>
        {source.slice(decoration.start, decoration.end)}
      </span>,
    );
    cursor = decoration.end;
  }
  if (cursor < source.length) pieces.push(source.slice(cursor));
  return <>{pieces}</>;
}
