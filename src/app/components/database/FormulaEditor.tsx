import { useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react';
import type { DatabaseDef, FormulaReferenceBinding, PageId, PageMeta, PropDef, WorkspaceState } from '../../../core/model';
import { displayTitle, newPageMeta } from '../../../core/model';
import { bindFormulaReferences, formulaResult, formulaValueText, rowsOf } from '../../../core/database';
import type { FormulaResult } from '../../../core/database';
import type { FormulaRuntimeValue } from '../../../core/formula';
import { isEffectivelyTrashed } from '../../../core/tree';
import { t } from '../../i18n';
import { tr } from '../../i18n/rich';
import './FormulaEditor.css';
import { updateProp } from './data';
import { useWorkspace } from '../../workspace';
import {
  adjustFormulaBindings,
  FORMULA_EXAMPLES,
  FORMULA_FUNCTIONS,
  formulaDecorations,
  formulaIdentifier,
  presentFormulaDiagnostic,
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

export interface DocumentFormulaDraft {
  source: string;
  bindings: FormulaReferenceBinding[];
}

export function createInitialFormulaDraftState(
  formula: string,
  savedBindings: FormulaReferenceBinding[],
  initialDraft?: DocumentFormulaDraft,
): FormulaDraftState {
  const source = initialDraft?.source ?? formula;
  const bindings = initialDraft
    ? adjustFormulaBindings(source, source, initialDraft.bindings)
        .filter(
          (binding) =>
            Number.isInteger(binding.start) &&
            Number.isInteger(binding.end) &&
            binding.start >= 0 &&
            binding.end > binding.start &&
            binding.end <= source.length &&
            source.slice(binding.start, binding.end) === binding.source,
        )
        .map((binding) => ({ ...binding }))
    : savedBindings;
  return {
    baseFormula: formula,
    baseBindingsKey: JSON.stringify(savedBindings),
    source,
    bindings,
    caret: source.length,
  };
}

export interface FormulaSelectionRange {
  start: number;
  end: number;
}

export function preserveFormulaEditorFocusOnActionMouseDown(event: { preventDefault(): void }): void {
  event.preventDefault();
}

function syncFormulaHighlightScrollbarGutter(
  textarea: HTMLTextAreaElement | null,
  highlight: HTMLPreElement | null,
) {
  if (!textarea || !highlight) return;
  const gutter = Math.max(0, highlight.clientWidth - textarea.clientWidth);
  const nextValue = `${gutter}px`;
  if (highlight.style.getPropertyValue('--formula-scrollbar-gutter') !== nextValue)
    highlight.style.setProperty('--formula-scrollbar-gutter', nextValue);
}

export function formulaSelectionChanged(
  previous: FormulaSelectionRange,
  next: FormulaSelectionRange,
): boolean {
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
    source.slice(0, suggestion.replaceStart) + suggestion.insertText + source.slice(suggestion.replaceEnd);
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

export interface DocumentFormulaReference {
  key: string;
  id: string;
  name: string;
  formulaName?: string;
  label?: string;
  kind: 'control' | 'result';
}

export interface DocumentFormulaFormattedResult {
  text: string;
  error: string | null;
}

interface DatabaseFormulaEditorProps {
  mode?: 'database';
  dbId: PageId;
  prop: PropDef;
  database: DatabaseDef;
  defaultFormula?: boolean;
  autoFocus?: boolean;
}

interface DocumentFormulaEditorProps {
  mode: 'document';
  id: string;
  pageId: PageId;
  ownerDatabaseId: PageId | null;
  database: DatabaseDef | null;
  formula: string;
  bindings: FormulaReferenceBinding[];
  initialDraft?: DocumentFormulaDraft;
  onDraftChange?: (source: string, bindings: FormulaReferenceBinding[]) => void;
  references: DocumentFormulaReference[];
  editable: boolean;
  label: string;
  applyLabel?: string;
  bindReferences: (source: string, bindings: FormulaReferenceBinding[]) => FormulaReferenceBinding[];
  evaluate: (source: string, bindings: FormulaReferenceBinding[]) => FormulaResult;
  formatResult: (value: FormulaRuntimeValue) => DocumentFormulaFormattedResult;
  onApply: (source: string, bindings: FormulaReferenceBinding[]) => boolean | void;
  onCancel: () => void;
  autoFocus?: boolean;
}

type FormulaEditorProps = DatabaseFormulaEditorProps | DocumentFormulaEditorProps;

export function documentFormulaContext(state: WorkspaceState, pageId: PageId): {
  ownerDatabaseId: PageId | null;
  database: DatabaseDef | null;
} {
  const parentId = state.pages[pageId]?.parentId ?? null;
  const owner = parentId ? state.pages[parentId] : undefined;
  return owner?.kind === 'database' && owner.database
    ? { ownerDatabaseId: owner.id, database: owner.database }
    : { ownerDatabaseId: null, database: null };
}

export function FormulaEditor(props: FormulaEditorProps) {
  const documentMode = props.mode === 'document' ? props : null;
  const databaseMode = props.mode === 'document' ? null : props;
  const dbId = documentMode ? documentMode.ownerDatabaseId : databaseMode!.dbId;
  const database = documentMode ? documentMode.database : databaseMode!.database;
  const prop = databaseMode?.prop;
  const defaultFormula = databaseMode?.defaultFormula ?? false;
  const autoFocus = props.autoFocus ?? false;
  const state = useWorkspace();
  const formula = documentMode
    ? documentMode.formula
    : defaultFormula
      ? (prop!.defaultFormula ?? '')
      : (prop!.formula ?? '');
  const savedBindings = documentMode
    ? documentMode.bindings
    : defaultFormula
      ? (prop!.defaultFormulaBindings ?? [])
      : (prop!.formulaBindings ?? []);
  const savedBindingsKey = JSON.stringify(savedBindings);
  const [draftState, setDraftState] = useState<FormulaDraftState>(() =>
    createInitialFormulaDraftState(formula, savedBindings, documentMode?.initialDraft),
  );
  const staleDraft =
    !documentMode?.initialDraft &&
    (draftState.baseFormula !== formula || draftState.baseBindingsKey !== savedBindingsKey);
  const draft = staleDraft ? formula : draftState.source;
  const draftBindings = staleDraft ? savedBindings : draftState.bindings;
  const caret = staleDraft ? formula.length : draftState.caret;
  const [assistTableId, setAssistTableId] = useState<PageId | null>(dbId);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(0);
  const [focused, setFocused] = useState(false);
  const [applied, setApplied] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  const selectionRangeRef = useRef<FormulaSelectionRange>({ start: formula.length, end: formula.length });
  const selectionChangedSinceKeyUpRef = useRef(false);
  const pendingCaretRef = useRef<number | null>(null);
  const inputId = documentMode ? documentMode.id : `${prop!.id}-${defaultFormula ? 'default-formula' : 'formula'}`;

  useLayoutEffect(() => {
    syncFormulaHighlightScrollbarGutter(textareaRef.current, highlightRef.current);
    const pendingCaret = pendingCaretRef.current;
    if (pendingCaret === null || !textareaRef.current) return;
    textareaRef.current.focus();
    textareaRef.current.setSelectionRange(pendingCaret, pendingCaret);
    pendingCaretRef.current = null;
  });

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const syncScrollbarGutter = () =>
      syncFormulaHighlightScrollbarGutter(textareaRef.current, highlightRef.current);
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncScrollbarGutter);
    resizeObserver?.observe(textarea);
    window.addEventListener('resize', syncScrollbarGutter);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', syncScrollbarGutter);
    };
  }, []);

  useLayoutEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const previewBindings = documentMode
    ? documentMode.bindReferences(draft, draftBindings)
    : bindFormulaReferences(draft, dbId!, state, draftBindings);
  const liveRows = documentMode ? [] : rowsOf(state, dbId!);
  const hasRows = liveRows.length > 0;
  const previewRow = documentMode || !databaseMode || !dbId
    ? null
    : liveRows[0] ?? makePreviewRow(dbId, databaseMode.database);
  const previewState: WorkspaceState = !previewRow || hasRows
    ? state
    : { ...state, pages: { ...state.pages, [previewRow.id]: previewRow } };
  const preview: FormulaResult | null = !draft.trim()
    ? null
    : documentMode
      ? documentMode.evaluate(draft, previewBindings)
      : formulaResult(
          previewRow!,
          { ...prop!, formula: draft, formulaBindings: previewBindings },
          databaseMode!.database,
          0,
          previewState,
        );
  const formattedDocumentPreview = documentMode && preview
    ? documentMode.formatResult(preview.value)
    : null;
  const formulaDiagnostic = preview?.error
    ? presentFormulaDiagnostic(preview.error, {
        memberAfterDot: (token) => t('formulaUx.memberAfterDot', { token }),
        unexpectedToken: (token) => t('formulaUx.unexpectedToken', { token }),
        invalidSummary: t('formulaUx.invalidSummary'),
      })
    : null;
  const tables = Object.values(state.pages)
    .filter(
      (page) => page.kind === 'database' && page.database && !isEffectivelyTrashed(state.pages, page.id),
    )
    .sort((left, right) => displayTitle(left).localeCompare(displayTitle(right)));
  const assistTable = assistTableId ? state.pages[assistTableId] : undefined;
  const assistProperties = assistTable?.database?.properties ?? database?.properties ?? [];
  const suggestions =
    focused && suggestionsOpen && (!documentMode || documentMode.editable) && database && dbId
      ? formulaSuggestions(draft, caret, dbId!, database, state, previewBindings)
      : [];
  const selectedSuggestion = suggestions[activeSuggestion];
  const decorations = formulaDecorations(draft, previewBindings, state);
  const dirty = draft !== formula || JSON.stringify(previewBindings) !== JSON.stringify(savedBindings);

  const notifyDocumentDraftChange = (source: string, bindings: FormulaReferenceBinding[]) => {
    if (!documentMode?.editable) return;
    documentMode.onDraftChange?.(source, bindings.map((binding) => ({ ...binding })));
  };

  const setDraftSource = (
    source: string,
    nextBindings = draftBindings,
    nextCaret = source.length,
    notify = true,
  ) => {
    setDraftState({
      baseFormula: formula,
      baseBindingsKey: savedBindingsKey,
      source,
      bindings: nextBindings,
      caret: nextCaret,
    });
    if (notify) notifyDocumentDraftChange(source, nextBindings);
    setActiveSuggestion(0);
    setApplied(false);
  };

  const insertAtEnd = (
    text: string,
    binding?:
      | { kind: 'database'; databaseId: PageId }
      | { kind: 'property'; databaseId: PageId; propertyId: string }
      | { kind: 'control'; pageId: PageId; controlId: string }
      | { kind: 'result'; pageId: PageId; resultId: string },
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
    if (documentMode && !documentMode.editable) return;
    const bindings = documentMode
      ? documentMode.bindReferences(draft, draftBindings)
      : bindFormulaReferences(draft, dbId!, state, draftBindings);
    const saved = documentMode
      ? documentMode.onApply(draft, bindings) !== false
      : !(draft !== formula || JSON.stringify(bindings) !== JSON.stringify(savedBindings)) ||
        updateProp(dbId!, prop!.id, (current) =>
          defaultFormula
            ? { ...current, defaultFormula: draft, defaultFormulaBindings: bindings }
            : { ...current, formula: draft, formulaBindings: bindings },
        );
    if (saved) setDraftSource(draft, bindings, caret, false);
    setApplied(saved);
    setSuggestionsOpen(false);
  };

  const cancel = () => {
    setDraftSource(formula, savedBindings, formula.length, false);
    setSuggestionsOpen(false);
    pendingCaretRef.current = null;
    documentMode?.onCancel();
  };

  const onTextareaKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (documentMode && !documentMode.editable) return;
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
    if (event.key === 'Escape' && suggestionsOpen && (!documentMode || suggestions.length > 0)) {
      event.preventDefault();
      setSuggestionsOpen(false);
      return;
    }
    if (event.key === 'Escape' && documentMode) {
      event.preventDefault();
      cancel();
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
    notifyDocumentDraftChange(source, bindings);
    setApplied(false);
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
  const insertDocumentReference = (key: string) => {
    if (!documentMode) return;
    const reference = documentMode.references.find((item) => item.key === key);
    if (!reference) return;
    const source = formulaIdentifier(reference.formulaName ?? reference.name);
    const binding = reference.kind === 'control'
      ? { kind: 'control' as const, pageId: documentMode.pageId, controlId: reference.id }
      : { kind: 'result' as const, pageId: documentMode.pageId, resultId: reference.id };
    insertAtEnd(source, binding, source);
  };

  return (
    <div className="field formula-field formula-editor">
      <span>{documentMode?.label ?? (defaultFormula ? t('database.defaultFormula') : t('slash.items.math.title'))}</span>
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
          readOnly={documentMode ? !documentMode.editable : undefined}
          value={draft}
          placeholder={documentMode ? t('controls.formulaPlaceholder') : 'prop("Price") * prop("Count")'}
          aria-label={documentMode?.label ?? (defaultFormula ? t('database.defaultFormula') : t('slash.items.math.title'))}
          aria-describedby={`${inputId}-legend`}
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
      <div
        className="formula-editor-legend"
        id={`${inputId}-legend`}
        role="group"
        aria-label={t('formulaUx.legend')}
      >
        {(
          [
            ['database', t('formulaUx.table')],
            ['relation', t('formulaUx.relation')],
            ['property', t('formulaUx.property')],
            ['control', t('formulaUx.control')],
            ['result', t('formulaUx.result')],
            ['function', t('formulaUx.function')],
            ['ambiguous', t('formulaUx.ambiguous')],
          ] as const
        ).map(([kind, label]) => (
          <span className="formula-editor-legend-item" key={kind}>
            <span aria-hidden="true" className={`formula-editor-swatch formula-editor-swatch-${kind}`} />
            {label}
          </span>
        ))}
      </div>
      <div className="formula-assist" aria-label={t('database.formulaAssist')}>
        {documentMode && (
          <>
            <label className="visually-hidden" htmlFor={`${inputId}-reference`}>
              {t('controls.insertReference')}
            </label>
            <select
              id={`${inputId}-reference`}
              className="text-input small"
              value=""
              aria-label={t('controls.insertReference')}
              disabled={!documentMode.editable}
              onChange={(event) => {
                if (event.target.value) insertDocumentReference(event.target.value);
                event.currentTarget.value = '';
              }}
            >
              <option value="">{t('controls.chooseReference')}</option>
              {documentMode.references.map((reference) => (
                <option key={reference.key} value={reference.key}>
                  {reference.label ?? t(reference.kind === 'control' ? 'controls.referenceControl' : 'controls.referenceResult', {
                    name: reference.name,
                  })}
                </option>
              ))}
            </select>
          </>
        )}
        <label className="visually-hidden" htmlFor={`${inputId}-function`}>
          {t('database.formulaFunction')}
        </label>
        <select
          id={`${inputId}-function`}
          className="text-input small"
          value=""
          aria-label={t('database.formulaFunction')}
          disabled={documentMode ? !documentMode.editable : undefined}
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
        {database && dbId && (
          <>
            <label className="visually-hidden" htmlFor={`${inputId}-field`}>
              {t('database.formulaField')}
            </label>
            <select
              id={`${inputId}-field`}
              className="text-input small"
              value=""
              aria-label={t('database.formulaField')}
              disabled={documentMode ? !documentMode.editable : undefined}
              onChange={(event) => {
                const field = database.properties.find((item) => item.id === event.target.value);
                if (!field) return;
                const name = formulaIdentifier(field.name);
                insertAtEnd(
                  `thisRow.${name}`,
                  { kind: 'property', databaseId: dbId, propertyId: field.id },
                  name,
                );
              }}
            >
              <option value="">{t('database.formulaField')}</option>
              {database.properties.map((field) => (
                <option key={field.id} value={field.id}>
                  {choiceLabel(field.name, field.id, database.properties)}
                </option>
              ))}
            </select>
          </>
        )}
        <label className="visually-hidden" htmlFor={`${inputId}-table`}>
          {t('database.formulaTable')}
        </label>
        <select
          id={`${inputId}-table`}
          className="text-input small"
          value=""
          aria-label={t('database.formulaTable')}
          disabled={documentMode ? !documentMode.editable : undefined}
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
        {assistTableId && assistTableId !== dbId && (
          <select
            className="text-input small"
            value=""
            aria-label={t('database.formulaTableField')}
            disabled={documentMode ? !documentMode.editable : undefined}
            onChange={(event) => {
              const field = assistProperties.find((item) => item.id === event.target.value);
              if (!field) return;
              const name = formulaIdentifier(field.name);
              insertAtEnd(
                `.${name}`,
                { kind: 'property', databaseId: assistTableId, propertyId: field.id },
                name,
              );
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
      {formulaDiagnostic ? (
        <div className="formula-error" role="alert" aria-live="polite">
          <span className="formula-error-primary">{formulaDiagnostic.primary}</span>
          {formulaDiagnostic.technicalDetail !== null && (
            <details className="formula-error-details">
              <summary>{t('formulaUx.technicalDetails')}</summary>
              <code dir="auto">{formulaDiagnostic.technicalDetail}</code>
            </details>
          )}
        </div>
      ) : formattedDocumentPreview?.error ? (
        <div className="formula-error" role="alert" aria-live="polite">
          <span className="formula-error-primary">{formattedDocumentPreview.error}</span>
        </div>
      ) : preview ? (
        <div className="formula-preview" role="status" aria-live="polite">
          <span>
            {tr('database.formulaPreview', {
              value: (
                <strong>
                  {documentMode
                    ? formattedDocumentPreview?.text || t('database.emptyValue')
                    : formulaValueText(prop!, preview.value, previewState) || t('database.emptyValue')}
                </strong>
              ),
              type: <span className="formula-preview-type">{formulaTypeLabel(preview.value)}</span>,
            })}
          </span>
          {formattedDocumentPreview?.error && <span className="formula-error-primary">{formattedDocumentPreview.error}</span>}
          {!documentMode && !hasRows && <span className="muted small">{t('database.formulaNoRows')}</span>}
        </div>
      ) : null}
      <div className="field-inline formula-actions">
        <button
          type="button"
          className="button small"
          disabled={documentMode ? !documentMode.editable : !dirty}
          onMouseDown={preserveFormulaEditorFocusOnActionMouseDown}
          onClick={save}
        >
          {documentMode?.applyLabel ?? t('formulaUx.apply')}
        </button>
        <button
          type="button"
          className="button small"
          disabled={documentMode ? false : !dirty}
          onMouseDown={preserveFormulaEditorFocusOnActionMouseDown}
          onClick={cancel}
        >
          {t('common.cancel')}
        </button>
        {applied && (
          <span className="muted small formula-editor-applied" role="status">
            {t('formulaUx.applied')}
          </span>
        )}
      </div>
      {!documentMode && <details className="formula-help">
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
                  const bindings = bindFormulaReferences(example, dbId!, state, draftBindings);
                  setDraftSource(example, bindings, example.length);
                  pendingCaretRef.current = example.length;
                }}
              >
                <code>{example}</code>
              </button>
            </li>
          ))}
        </ul>
      </details>}
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
      <span
        key={`${decoration.start}:${decoration.end}`}
        className={`formula-token formula-token-${decoration.kind}`}
      >
        {source.slice(decoration.start, decoration.end)}
      </span>,
    );
    cursor = decoration.end;
  }
  if (cursor < source.length) pieces.push(source.slice(cursor));
  return <>{pieces}</>;
}
