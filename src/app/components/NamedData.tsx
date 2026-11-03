import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { bindPageFormulaReferences, documentFormulaResult, formatDisplayValue, formulaValueText } from '../../core/database';
import type { DateRangeControlValue, FormulaReferenceBinding, NamedControlDef, NamedControlType, PropDef, PropValue, PropertyFormat } from '../../core/model';
import { COLORS, displayTitle, TEXT_HEX } from '../../core/model';
import {
  boundedNumericControlFormatError,
  controlConfigurationError,
  controlValueError,
  controlValueErrorInState,
  defaultBoundedNumericControlFormat,
  normalizeControlFormat,
} from '../../core/controls';
import { isValidDateKey, scalarValueError } from '../../core/typedValues';
import { dateRangeForPreset } from '../../core/dateRanges';
import type { DateRangePreset } from '../../core/dateRanges';
import { childrenOf, isEffectivelyTrashed } from '../../core/tree';
import { newId } from '../platform/files';
import { commitEditors } from '../editor/commits';
import { getState, run, runAll, useWorkspace } from '../workspace';
import { getLocale, t } from '../i18n';
import { Menu } from './Menu';
import type { MenuEntry } from './Menu';
import { NamedMultiSelectPicker } from './NamedMultiSelectPicker';
import { documentFormulaContext, FormulaEditor } from './database/FormulaEditor';
import type { DocumentFormulaFormattedResult, DocumentFormulaReference } from './database/FormulaEditor';
import { presentFormulaDiagnostic } from './database/formulaEditorModel';
import type { FormulaRuntimeValue } from '../../core/formula';
import {
  captureCalculatedResultEditTarget,
  closeCalculatedResultConfigurationHistory,
  createCalculatedResultConfigurationTransaction,
  isCurrentCalculatedResultEditTarget,
} from '../editor/calculatedResultSupport';
import type { CalculatedResultEditTarget } from '../editor/calculatedResultSupport';
import {
  calculatedResultFormulaDraftSeed,
  clearCalculatedResultDraft,
  readCalculatedResultDraft,
  writeCalculatedResultDraft,
} from '../editor/calculatedResultDrafts';
import type {
  CalculatedResultConfigurationDraft,
  CalculatedResultDraftSnapshot,
} from '../editor/calculatedResultDrafts';
import {
  cancelCalculatedResultConfigurationRequest,
  listenForCalculatedResultConfiguration,
} from '../editor/calculatedResultRequests';
import { calculateResultPopoverPlacement } from '../editor/calculatedResultPopover';
import {
  cancelNamedControlConfigurationRequest,
  listenForNamedControlConfiguration,
} from '../editor/namedControlRequests';
import type { NamedControlConfigRequest } from '../editor/namedControlRequests';
import { captureNamedControlEdit, namedControlEditConflict } from '../editor/controlEditGuard';
import type { NamedControlEditConflict, NamedControlEditSnapshot } from '../editor/controlEditGuard';
import { calculatedResultFormatError } from '../editor/calculatedResultFormat';
import {
  dateRangeDraftInput,
  dateRangeValueSignature,
  reconcileDateRangeDraft,
} from './dateRangeDraft';
import type { DateRangeDraftInput } from './dateRangeDraft';

const CONTROL_TYPES: NamedControlType[] = ['text', 'number', 'slider', 'scale', 'progress', 'select', 'multiSelect', 'checkbox', 'date', 'dateRange', 'relation'];
const OUTPUT_TYPES = ['auto', 'text', 'number', 'currency', 'percent', 'scale', 'progress', 'date', 'checkbox'] as const;
type OutputType = (typeof OUTPUT_TYPES)[number];
const controlTimestamp = (): number => Date.now();

function stop(event: React.MouseEvent | React.KeyboardEvent) {
  event.stopPropagation();
}


function defaultFor(type: NamedControlType, options: NamedControlDef['options'], multiple = false, format?: PropertyFormat): PropValue {
  switch (type) {
    case 'text': return '';
    case 'number':
    case 'slider': return 0;
    case 'scale':
    case 'progress': return format?.min ?? null;
    case 'checkbox': return false;
    case 'date': return '';
    case 'select': return options[0]?.id ?? null;
    case 'multiSelect': return [];
    case 'relation': return multiple ? [] : null;
    case 'dateRange': return null;
  }
}

function DateRangeInputs({
  identity,
  label,
  value,
  disabled,
  onChange,
  onIncompleteChange,
  showIncompleteMessage = true,
}: {
  identity: string;
  label: string;
  value: PropValue;
  disabled: boolean;
  onChange: (value: DateRangeControlValue) => void;
  onIncompleteChange?: (incomplete: boolean) => void;
  showIncompleteMessage?: boolean;
}) {
  const valueSignature = dateRangeValueSignature(value);
  const [dates, setDates] = useState(() => dateRangeDraftInput(value));
  const previousProps = useRef({ identity, valueSignature });
  useEffect(() => {
    const previous = previousProps.current;
    if (previous.identity === identity && previous.valueSignature === valueSignature) return;
    previousProps.current = { identity, valueSignature };
    setDates((current) => reconcileDateRangeDraft(
      previous.identity,
      identity,
      previous.valueSignature,
      valueSignature,
      current,
      value,
    ));
    onIncompleteChange?.(false);
  }, [identity, value, valueSignature, onIncompleteChange]);
  const complete = dates.start !== '' && dates.end !== '' &&
    isValidDateKey(dates.start) && isValidDateKey(dates.end) && dates.start <= dates.end;
  const blank = dates.start === '' && dates.end === '';
  const incomplete = !complete && !blank;
  const update = (field: keyof DateRangeDraftInput, date: string) => {
    const next = { ...dates, [field]: date };
    const nextBlank = next.start === '' && next.end === '';
    const nextComplete = next.start !== '' && next.end !== '' &&
      isValidDateKey(next.start) && isValidDateKey(next.end) && next.start <= next.end;
    setDates(next);
    onIncompleteChange?.(!nextBlank && !nextComplete);
    if (nextBlank) onChange(null);
    else if (nextComplete) onChange([next.start, next.end]);
  };

  return <>
    <div className="named-control-date-range-inputs" role="group" aria-label={label}>
      <label>{t('controls.startDate')}<input
        disabled={disabled}
        type="date"
        aria-label={t('controls.startDate')}
        aria-invalid={incomplete}
        value={dates.start}
        onChange={(event) => update('start', event.target.value)}
      /></label>
      <label>{t('controls.endDate')}<input
        disabled={disabled}
        type="date"
        aria-label={t('controls.endDate')}
        aria-invalid={incomplete}
        value={dates.end}
        onChange={(event) => update('end', event.target.value)}
      /></label>
    </div>
    {showIncompleteMessage && incomplete && <span className="named-control-date-range-error" role="status">
      {t('controls.incompleteDateRange')}
    </span>}
  </>;
}

function scaleFilledSteps(value: number, min: number, max: number): number {
  return Math.max(0, Math.min(5, Math.round(((value - min) / (max - min)) * 5)));
}

function boundedValueText(value: number | null, min: number, max: number): string {
  return value === null
    ? t('controls.blank')
    : t('controls.valueOfRange', { value: String(value), min: String(min), max: String(max) });
}

function parseNumberDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function controlErrorLabel(error: string | null): string | null {
  if (!error) return null;
  if (error.toLowerCase().includes('email')) return t('controls.invalidEmail');
  if (error.toLowerCase().includes('multi-select')) return t('controls.invalidMultiSelect');
  if (error.toLowerCase().includes('date range')) return t('controls.invalidDateRange');
  if (/explicit finite|maximum must be greater|step must divide|minimum, maximum, and step must be whole numbers/i.test(error))
    return t('controls.invalidControlFormat');
  if (/number|finite|step|at least|at most|whole number/i.test(error)) return t('controls.invalidNumber');
  if (error.toLowerCase().includes('text controls')) return t('controls.invalidText');
  return t('controls.invalidDefaultValue');
}

function editConflictLabel(conflict: NamedControlEditConflict, name: string): string {
  return conflict === 'removed'
    ? t('controls.missingControl', { name })
    : t('controls.configurationChanged');
}

function clearValueIntentSignature(current: NamedControlDef, configured: NamedControlDef): string {
  const format = Object.entries(configured.format ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([
    current.id,
    current.value,
    configured.type,
    configured.textFormat ?? null,
    configured.options.map(({ id, name, color }) => [id, name, color]),
    format,
    configured.relation ? [configured.relation.targetDatabaseId, configured.relation.multiple] : null,
  ]);
}

function unavailableOptionResolutionSignature(
  current: NamedControlDef,
  configured: NamedControlDef,
  value: PropValue,
): string {
  return JSON.stringify([
    clearValueIntentSignature(current, configured),
    value,
  ]);
}

export function NamedControlNode(props: NodeViewProps) {
  const state = useWorkspace();
  const { node, updateAttributes, deleteNode, editor } = props;
  const extensionPageId = (editor.extensionManager.extensions.find((item) => item.name === 'namedControl')?.options as { hostPageId?: string } | undefined)?.hostPageId;
  const pageId = String(node.attrs.pageId || extensionPageId || '');
  const controlId = String(node.attrs.controlId ?? '');
  const page = state.pages[pageId];
  const control = page?.controls.find((item) => item.id === controlId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NamedControlDef | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [clearCurrentValueFor, setClearCurrentValueFor] = useState<string | null>(null);
  const [resolveCurrentOptionsFor, setResolveCurrentOptionsFor] = useState<string | null>(null);
  const [resolveDefaultOptionsFor, setResolveDefaultOptionsFor] = useState<string | null>(null);
  const [creatingFromSlash, setCreatingFromSlash] = useState(false);
  const [editSnapshot, setEditSnapshot] = useState<NamedControlEditSnapshot | null>(null);
  const [draftDefaultNumber, setDraftDefaultNumber] = useState<string | null>(null);
  const [draftDefaultDateRangeInvalid, setDraftDefaultDateRangeInvalid] = useState(false);
  const [valueDraft, setValueDraft] = useState<{ controlId: string; value: string; sourceValue: PropValue } | null>(null);
  const controlAnchorRef = useRef<HTMLSpanElement>(null);
  const configPopoverRef = useRef<HTMLSpanElement>(null);
  const target = control?.relation?.targetDatabaseId ? state.pages[control.relation.targetDatabaseId] : null;
  const boundedRange = control && (control.type === 'scale' || control.type === 'progress')
    ? {
        min: control.format?.min ?? (control.type === 'scale' ? 1 : 0),
        max: control.format?.max ?? (control.type === 'scale' ? 5 : 100),
        step: control.format?.step ?? 1,
      }
    : null;
  const relatedRows = target?.kind === 'database' && target.database && !isEffectivelyTrashed(state.pages, target.id)
    ? childrenOf(state.pages, target.id)
    : [];
  const valueError = control ? controlValueError(control, control.value) : null;
  const relationStateError = control && !valueError && controlValueErrorInState(control, control.value, state);
  const activeValueDraft = valueDraft && control && control.id === valueDraft.controlId &&
    JSON.stringify(control.value) === JSON.stringify(valueDraft.sourceValue) ? valueDraft : null;
  const valueDraftError = activeValueDraft && control
    ? (() => {
        const error = controlValueError(control, activeValueDraft.value);
        if (!error) return null;
        if (error.includes('email')) return t('controls.invalidEmail');
        if (/explicit finite|maximum must be greater|step must divide|minimum, maximum, and step must be whole numbers/i.test(error)) return t('controls.invalidControlFormat');
        if (error.includes('number') || error.includes('step') || error.includes('at least') || error.includes('at most') || error.includes('whole number')) return t('controls.invalidNumber');
        return t('controls.invalidText');
      })()
    : null;
  const draftControl = draft;
  const parsedDefaultNumber = draftDefaultNumber === null ? null : parseNumberDraft(draftDefaultNumber);
  const draftDefaultValue = draftDefaultNumber === null ? draft?.defaultValue : parsedDefaultNumber;
  const unavailableCurrentIds = control?.type === 'multiSelect' && draftControl?.type === 'multiSelect' && Array.isArray(control.value)
    ? control.value.filter((id) => !draftControl.options.some((option) => option.id === id))
    : [];
  const unavailableDefaultIds = draftControl?.type === 'multiSelect' && Array.isArray(draftDefaultValue)
    ? draftDefaultValue.filter((id) => !draftControl.options.some((option) => option.id === id))
    : [];
  const resolutionSignature = control && draftControl
    ? unavailableOptionResolutionSignature(control, draftControl, draftDefaultValue ?? null)
    : null;
  const resolveCurrentOptions = resolutionSignature !== null && resolveCurrentOptionsFor === resolutionSignature;
  const resolveDefaultOptions = resolutionSignature !== null && resolveDefaultOptionsFor === resolutionSignature;
  const liveValueForDraft = resolveCurrentOptions && Array.isArray(control?.value) && draftControl
    ? control.value.filter((id) => draftControl.options.some((option) => option.id === id))
    : control?.value;
  const defaultValueForDraft = resolveDefaultOptions && Array.isArray(draftDefaultValue) && draftControl
    ? draftDefaultValue.filter((id) => draftControl.options.some((option) => option.id === id))
    : draftDefaultValue;
  const draftFormatError = draftControl ? controlConfigurationError(draftControl) : null;
  const currentDraftError = control && draftControl && !draftFormatError
    ? controlValueErrorInState(draftControl, liveValueForDraft ?? null, state)
    : null;
  const clearCurrentValueSignature = currentDraftError && control && draftControl
    ? clearValueIntentSignature(control, draftControl)
    : null;
  const clearCurrentValue = clearCurrentValueSignature !== null && clearCurrentValueFor === clearCurrentValueSignature;
  const draftDefaultError = draft && draftControl
    ? draftFormatError
      ? t('controls.invalidControlFormat')
      : draft.type === 'relation' && !draft.relation?.targetDatabaseId
      ? t('controls.chooseTable')
      : draftDefaultNumber !== null && draftDefaultNumber.trim() !== '' && parsedDefaultNumber === null
      ? t('controls.invalidNumber')
      : draft.type === 'dateRange' && draftDefaultDateRangeInvalid
      ? t('controls.incompleteDateRange')
      : controlErrorLabel(controlValueErrorInState(draftControl, defaultValueForDraft ?? null, state))
    : null;
  const optionNames = draftControl?.type === 'select' || draftControl?.type === 'multiSelect'
    ? draftControl.options.map((item) => item.name.trim().toLocaleLowerCase())
    : [];
  const optionError = (draftControl?.type === 'select' || draftControl?.type === 'multiSelect') && (
    draftControl.options.length > 100 ||
    new Set(optionNames).size !== optionNames.length ||
    draftControl.options.some((item) => item.name.length > 100)
  ) ? t('controls.invalidOptions') : null;

  const setValue = (value: PropValue) => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    run({ type: 'page.control.setValue', id: page.id, controlId: control.id, value, now: controlTimestamp() });
  };
  const resetToDefault = () => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    run({ type: 'page.control.reset', id: page.id, controlId: control.id, now: controlTimestamp() });
  };
  const clearCurrentValueNow = () => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    run({ type: 'page.control.setValue', id: page.id, controlId: control.id, value: null, now: controlTimestamp() });
  };
  const startEdit = (request?: NamedControlConfigRequest) => {
    if (!editor.isEditable) return;
    setSaveError(null);
    setClearCurrentValueFor(null);
    setResolveCurrentOptionsFor(null);
    setResolveDefaultOptionsFor(null);
    setDraftDefaultNumber(null);
    setDraftDefaultDateRangeInvalid(false);
    setEditSnapshot(captureNamedControlEdit(pageId, controlId, control));
    if (!control) {
      const type = request?.type ?? 'text';
      const options = type === 'select' || type === 'multiSelect'
        ? [{ id: newId(), name: t('controls.defaultOptionName', { count: 1 }), color: 'gray' as const }]
        : [];
      const relation = type === 'relation'
        ? { targetDatabaseId: request?.targetDatabaseId ?? null, multiple: false }
        : undefined;
      const format = type === 'scale' || type === 'progress' ? defaultBoundedNumericControlFormat(type) : undefined;
      const initial = defaultFor(type, options, relation?.multiple ?? false, format);
      setDraft({
        id: controlId,
        name: String(node.attrs.label ?? 'Control'),
        type,
        ...(type === 'text' ? { textFormat: 'plain' as const } : {}),
        value: initial,
        defaultValue: initial,
        options,
        ...(format ? { format } : {}),
        ...(relation ? { relation } : {}),
      });
      setCreatingFromSlash(request?.createOnSave === true);
    } else {
      setDraft({ ...control, options: control.options.map((item) => ({ ...item })), relation: control.relation ? { ...control.relation } : undefined });
      setCreatingFromSlash(false);
    }
    setEditing(true);
  };
  const startEditRef = useRef(startEdit);
  useLayoutEffect(() => {
    startEditRef.current = startEdit;
  });
  useEffect(
    () => {
      const dispose = listenForNamedControlConfiguration(editor, pageId, controlId, (request) => startEditRef.current(request));
      return () => {
        dispose();
        cancelNamedControlConfigurationRequest(editor, pageId, controlId);
      };
    },
    [editor, pageId, controlId],
  );
  useLayoutEffect(() => {
    if (!editing) return;
    const place = () => {
      const anchor = controlAnchorRef.current?.getBoundingClientRect();
      const popover = configPopoverRef.current;
      if (!anchor || !popover) return;
      const margin = 12;
      const width = Math.min(popover.offsetWidth, Math.max(180, window.innerWidth - margin * 2));
      const height = Math.min(popover.offsetHeight, Math.max(120, window.innerHeight - margin * 2));
      const maxLeft = Math.max(margin, window.innerWidth - width - margin);
      const left = Math.min(Math.max(anchor.left, margin), maxLeft);
      const below = anchor.bottom + 6;
      const above = anchor.top - height - 6;
      const top = below + height <= window.innerHeight - margin
        ? below
        : Math.max(margin, above);
      popover.style.left = `${left}px`;
      popover.style.top = `${Math.min(top, Math.max(margin, window.innerHeight - height - margin))}px`;
    };
    place();
    window.addEventListener('resize', place);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (configPopoverRef.current) observer?.observe(configPopoverRef.current);
    return () => {
      window.removeEventListener('resize', place);
      observer?.disconnect();
    };
  }, [editing, draft, saveError]);
  const cancelEdit = () => {
    if (creatingFromSlash && !control && editor.isEditable) deleteNode();
    setCreatingFromSlash(false);
    setEditSnapshot(null);
    setClearCurrentValueFor(null);
    setResolveCurrentOptionsFor(null);
    setResolveDefaultOptionsFor(null);
    setDraftDefaultDateRangeInvalid(false);
    setEditing(false);
  };
  const patchDraft = (change: Partial<NamedControlDef>) => {
    setClearCurrentValueFor(null);
    setResolveCurrentOptionsFor(null);
    setResolveDefaultOptionsFor(null);
    setDraft((current) => current ? { ...current, ...change } : current);
  };
  const renameOption = (optionId: string, name: string) => {
    if (!editor.isEditable || !draft) return;
    patchDraft({ options: draft.options.map((option) => option.id === optionId ? { ...option, name } : option) });
  };
  const removeOption = (optionId: string) => {
    if (!editor.isEditable || !draft) return;
    patchDraft({ options: draft.options.filter((option) => option.id !== optionId) });
  };
  const addOption = () => {
    if (!editor.isEditable || !draft || draft.options.length >= 100) return;
    let count = draft.options.length + 1;
    let name = t('controls.defaultOptionName', { count });
    while (draft.options.some((option) => option.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()))
      name = t('controls.defaultOptionName', { count: ++count });
    patchDraft({ options: [...draft.options, { id: newId(), name, color: 'gray' }] });
  };
  const save = () => {
    if (!editor.isEditable || !draft) return;
    setSaveError(null);
    const initialState = getState();
    const initialPage = initialState.pages[pageId];
    const initialControl = initialPage?.controls.find((item) => item.id === controlId);
    const initialConflict = namedControlEditConflict(editSnapshot, pageId, controlId, initialControl);
    if (!initialPage || initialConflict) {
      setSaveError(initialConflict
        ? editConflictLabel(initialConflict, String(node.attrs.label ?? controlId))
        : t('controls.missingControl', { name: String(node.attrs.label ?? controlId) }));
      return;
    }
    const options = draft.options;
    const optionNames = options.map((item) => item.name.trim().toLocaleLowerCase());
    if ((draft.type === 'select' || draft.type === 'multiSelect') && (options.length > 100 || new Set(optionNames).size !== optionNames.length || options.some((item) => item.name.length > 100))) {
      setSaveError(t('controls.invalidOptions'));
      return;
    }
    if (draftDefaultError || optionError) {
      setSaveError(draftDefaultError ?? optionError);
      return;
    }
    if (!draft.name.trim() || draft.name.trim().length > 100) {
      setSaveError(t('controls.invalidName'));
      return;
    }
    let defaultValue = defaultValueForDraft ?? null;
    if ((draft.type === 'number' || draft.type === 'slider' || draft.type === 'scale' || draft.type === 'progress') && draftDefaultNumber !== null) {
      if (draftDefaultNumber.trim() === '') defaultValue = null;
      else if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(draftDefaultNumber.trim()) && Number.isFinite(Number(draftDefaultNumber)))
        defaultValue = Number(draftDefaultNumber);
      else {
        setSaveError(t('controls.invalidNumber'));
        return;
      }
    }
    const normalizedFormat = draft.format === undefined ? undefined : normalizeControlFormat(draft.format);
    if (draft.format !== undefined && !normalizedFormat) {
      setSaveError(t('controls.invalidControlFormat'));
      return;
    }
    const nextDraft: NamedControlDef = {
      ...draft,
      value: editSnapshot?.mode === 'existing' ? null : defaultValue,
      defaultValue,
      options,
      ...(normalizedFormat ? { format: normalizedFormat } : {}),
      ...(draft.type === 'text' ? {} : { textFormat: undefined }),
    };
    commitEditors();
    const currentState = getState();
    const currentPage = currentState.pages[pageId];
    const currentControl = currentPage?.controls.find((item) => item.id === controlId);
    const conflict = namedControlEditConflict(editSnapshot, pageId, controlId, currentControl);
    if (!currentPage || conflict) {
      setSaveError(conflict
        ? editConflictLabel(conflict, String(node.attrs.label ?? controlId))
        : t('controls.missingControl', { name: String(node.attrs.label ?? controlId) }));
      return;
    }
    if (draft.type === 'relation' && !nextDraft.relation?.targetDatabaseId) {
      setSaveError(t('controls.chooseTable'));
      return;
    }
    const defaultError = controlValueErrorInState(nextDraft, defaultValue, currentState);
    if (defaultError) {
      setSaveError(controlErrorLabel(defaultError));
      return;
    }
    const liveUnavailableIds = currentControl?.type === 'multiSelect' && nextDraft.type === 'multiSelect' && Array.isArray(currentControl.value)
      ? currentControl.value.filter((id) => !options.some((option) => option.id === id))
      : [];
    const currentResolution = currentControl && unavailableOptionResolutionSignature(currentControl, nextDraft, draftDefaultValue ?? null);
    const resolveLiveUnavailable = liveUnavailableIds.length > 0 && currentResolution !== undefined &&
      resolveCurrentOptionsFor === currentResolution;
    const valueAfterOptionResolution = resolveLiveUnavailable && Array.isArray(currentControl?.value)
      ? currentControl.value.filter((id) => options.some((option) => option.id === id))
      : currentControl?.value;
    const liveError = currentControl ? controlValueErrorInState(nextDraft, valueAfterOptionResolution ?? null, currentState) : null;
    const canClearCurrentValue = currentControl && clearCurrentValueFor === clearValueIntentSignature(currentControl, nextDraft);
    if (liveError && !canClearCurrentValue) {
      setSaveError(t('controls.currentValueInvalid'));
      return;
    }
    const now = controlTimestamp();
    const commands = [
      ...(currentControl && liveError === null && resolveLiveUnavailable && Array.isArray(valueAfterOptionResolution)
        ? [{ type: 'page.control.setValue' as const, id: pageId, controlId, value: valueAfterOptionResolution, now }]
        : []),
      ...(currentControl && liveError && canClearCurrentValue ? [{ type: 'page.control.setValue' as const, id: pageId, controlId, value: null, now }] : []),
      { type: 'page.control.configure' as const, id: pageId, control: nextDraft, now },
    ];
    const saved = runAll(commands);
    if (!saved.ok) {
      const error = saved.error.toLowerCase();
      setSaveError(error.includes('current value is incompatible')
        ? t('controls.currentValueInvalid')
        : error.includes('invalid default value')
          ? t('controls.invalidDefaultValue')
          : error.includes('email')
            ? t('controls.invalidEmail')
            : error.includes('numeric') || error.includes('number')
              ? t('controls.invalidNumber')
              : saved.error);
      return;
    }
    updateAttributes({ pageId, controlId, label: nextDraft.name });
    setEditing(false);
    setCreatingFromSlash(false);
    setEditSnapshot(null);
    setClearCurrentValueFor(null);
    setResolveCurrentOptionsFor(null);
    setResolveDefaultOptionsFor(null);
    setDraftDefaultNumber(null);
    setDraftDefaultDateRangeInvalid(false);
  };
  const removeDefinition = () => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    const removed = run({ type: 'page.control.delete', id: page.id, controlId, now: controlTimestamp() });
    if (removed.ok) {
      setEditing(false);
      setEditSnapshot(null);
    }
  };
  const controlMenuEntries: MenuEntry[] = [
    { label: t('controls.configureControl'), disabled: !editor.isEditable, onSelect: startEdit },
    { label: t('controls.clearValue'), disabled: !editor.isEditable, onSelect: clearCurrentValueNow },
    { label: t('controls.resetValue'), disabled: !editor.isEditable, onSelect: resetToDefault },
  ];

  return (
    <NodeViewWrapper ref={controlAnchorRef} as="span" className="named-data-control" contentEditable={false} onMouseDown={stop}>
      {editing && draft ? (
        <span ref={configPopoverRef} className="named-data-popover named-control-popover" role="group" aria-label={t('controls.configureControl')} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            cancelEdit();
          }
        }}>
          <label>{t('controls.name')}<input autoFocus disabled={!editor.isEditable} aria-invalid={!draft.name.trim() || draft.name.trim().length > 100} value={draft.name} maxLength={100} onChange={(event) => patchDraft({ name: event.target.value })} /></label>
          <label>{t('controls.type')}
            <select disabled={!editor.isEditable} value={draft.type} onChange={(event) => {
              const type = event.target.value as NamedControlType;
      const options = type === 'select' || type === 'multiSelect' ? (draft.options.length ? draft.options : [{ id: newId(), name: t('controls.defaultOptionName', { count: 1 }), color: 'gray' as const }]) : draft.options;
              const relation = type === 'relation' ? (draft.relation ?? { targetDatabaseId: null, multiple: false }) : draft.relation;
              const multiple = relation?.multiple ?? false;
              const format = type === 'scale' || type === 'progress' ? defaultBoundedNumericControlFormat(type) : draft.format;
              const initial = defaultFor(type, options, multiple, format);
              setDraftDefaultNumber(null);
              setDraftDefaultDateRangeInvalid(false);
              patchDraft({
                type,
                options,
                relation,
                format,
                textFormat: type === 'text' ? draft.textFormat ?? 'plain' : undefined,
                ...(!control ? { value: initial, defaultValue: initial } : {}),
              });
            }}>
              {CONTROL_TYPES.map((type) => <option value={type} key={type}>{t(`controls.types.${type}` as never)}</option>)}
            </select>
          </label>
          {draft.type === 'text' && <label>{t('controls.textFormat')}
            <select disabled={!editor.isEditable} value={draft.textFormat ?? 'plain'} onChange={(event) => patchDraft({ textFormat: event.target.value as 'plain' | 'email' })}>
              <option value="plain">{t('controls.textFormats.plain')}</option>
              <option value="email">{t('controls.textFormats.email')}</option>
            </select>
          </label>}
          {(draft.type === 'select' || draft.type === 'multiSelect') && <div className="named-control-options-editor" role="group" aria-label={t('controls.options')}>
            <span className="named-data-field-label">{t('controls.options')}</span>
            {draft.options.map((option, index) => {
              const duplicate = draft.options.some((other) => other.id !== option.id &&
                other.name.trim().toLocaleLowerCase() === option.name.trim().toLocaleLowerCase());
              const name = option.name || t('controls.defaultOptionName', { count: index + 1 });
              return <div className="named-control-option-row" key={option.id}>
                <label>{t('controls.optionName', { count: index + 1 })}
                  <input
                    disabled={!editor.isEditable}
                    aria-label={t('controls.optionName', { count: index + 1 })}
                    aria-invalid={!option.name.trim() || option.name.trim().length > 100 || duplicate}
                    maxLength={100}
                    value={option.name}
                    onChange={(event) => renameOption(option.id, event.target.value)}
                  />
                </label>
                <button type="button" disabled={!editor.isEditable} aria-label={t('controls.removeOption', { name })} onClick={() => removeOption(option.id)}>×</button>
              </div>;
            })}
            <button type="button" disabled={!editor.isEditable || draft.options.length >= 100} onClick={addOption}>{t('controls.addOption')}</button>
          </div>}
          {draft.type === 'relation' && <>
            <label>{t('controls.targetTable')}
              <select disabled={!editor.isEditable} aria-invalid={!draft.relation?.targetDatabaseId} value={draft.relation?.targetDatabaseId ?? ''} onChange={(event) => patchDraft({ relation: { targetDatabaseId: event.target.value || null, multiple: draft.relation?.multiple ?? false } })}>
                <option value="">{t('controls.chooseTable')}</option>
                {Object.values(state.pages).filter((item) => item.kind === 'database' && item.database && !isEffectivelyTrashed(state.pages, item.id)).map((item) => <option key={item.id} value={item.id}>{displayTitle(item)}</option>)}
              </select>
            </label>
            <label className="named-data-check"><input disabled={!editor.isEditable} type="checkbox" checked={draft.relation?.multiple === true} onChange={(event) => patchDraft({ relation: { targetDatabaseId: draft.relation?.targetDatabaseId ?? null, multiple: event.target.checked } })} />{t('controls.allowMultiple')}</label>
          </>}
          {draft.type === 'dateRange' ? <div className="named-data-default-value">
            <span className="named-data-field-label">{t('controls.defaultValue')}</span>
            <DateRangeInputs
              identity={`${pageId}:${draft.id}`}
              label={t('controls.defaultValue')}
              value={draftDefaultValue ?? null}
              disabled={!editor.isEditable}
              onChange={(value) => patchDraft({ defaultValue: value })}
              onIncompleteChange={setDraftDefaultDateRangeInvalid}
              showIncompleteMessage={false}
            />
          </div> : draft.type === 'multiSelect' ? <div className="named-data-default-value">
            <span className="named-data-field-label">{t('controls.defaultValue')}</span>
            <NamedMultiSelectPicker
              label={t('controls.defaultValue')}
              options={draftControl?.options ?? draft.options}
              value={draftDefaultValue ?? null}
              onChange={(value) => patchDraft({ defaultValue: value })}
              disabled={!editor.isEditable}
              invalid={Boolean(draftDefaultError)}
              previousOptions={control?.options}
              showBlankActions
            />
          </div> : <label>{t('controls.defaultValue')}
            {draft.type === 'checkbox' ? <input disabled={!editor.isEditable} aria-invalid={Boolean(draftDefaultError)} type="checkbox" checked={draft.defaultValue === true} onChange={(event) => patchDraft({ defaultValue: event.target.checked })} /> :
              draft.type === 'select' ? <select disabled={!editor.isEditable} aria-invalid={Boolean(draftDefaultError)} value={typeof draft.defaultValue === 'string' ? draft.defaultValue : ''} onChange={(event) => patchDraft({ defaultValue: event.target.value || null })}><option value="">{t('controls.blank')}</option>{draft.options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> :
                draft.type === 'relation' ? <select
                  disabled={!editor.isEditable}
                  aria-invalid={Boolean(draftDefaultError)}
                  multiple={draft.relation?.multiple === true}
                  value={Array.isArray(draft.defaultValue) ? draft.defaultValue : typeof draft.defaultValue === 'string' ? [draft.defaultValue] : []}
                  onChange={(event) => {
                    const value = draft.relation?.multiple
                      ? Array.from(event.target.selectedOptions).map((item) => item.value)
                      : event.target.value || null;
                    patchDraft({ defaultValue: value });
                  }}
                >
                  {!draft.relation?.multiple && <option value="">{t('controls.blank')}</option>}
                  {Object.values(state.pages).filter((item) => item.id === draft.relation?.targetDatabaseId && item.kind === 'database' && item.database && !isEffectivelyTrashed(state.pages, item.id)).flatMap((item) => childrenOf(state.pages, item.id)).map((row) => <option key={row.id} value={row.id}>{displayTitle(row)}</option>)}
                </select> :
                  <input
                    disabled={!editor.isEditable}
                    type={draft.type === 'date' ? 'date' : draft.type === 'text' && draft.textFormat === 'email' ? 'email' : 'text'}
                    inputMode={draft.type === 'number' || draft.type === 'slider' || draft.type === 'scale' || draft.type === 'progress' ? 'decimal' : undefined}
                    aria-label={draft.type === 'text' && draft.textFormat === 'email' ? t('controls.textFormats.email') : undefined}
                    aria-invalid={Boolean(draftDefaultError)}
                    value={draft.type === 'number' || draft.type === 'slider' || draft.type === 'scale' || draft.type === 'progress'
                      ? draftDefaultNumber ?? (draft.defaultValue === null ? '' : String(draft.defaultValue))
                      : draft.defaultValue === null ? '' : String(draft.defaultValue)}
                    onChange={(event) => {
                      if (draft.type === 'number' || draft.type === 'slider' || draft.type === 'scale' || draft.type === 'progress') {
                        const raw = event.target.value;
                        setDraftDefaultNumber(raw);
                        if (raw.trim() === '') patchDraft({ defaultValue: null });
                        else {
                          const parsed = parseNumberDraft(raw);
                          if (parsed !== null) patchDraft({ defaultValue: parsed });
                        }
                      } else patchDraft({ defaultValue: event.target.value });
                    }}
                  />}
          </label>}
          {(draft.type === 'number' || draft.type === 'slider' || draft.type === 'scale' || draft.type === 'progress') && <div className="named-data-format">
            <label>{t('controls.minimum')}<input disabled={!editor.isEditable} type="number" step={draft.type === 'scale' ? 1 : 'any'} value={draft.format?.min ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, min: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
            <label>{t('controls.maximum')}<input disabled={!editor.isEditable} type="number" step={draft.type === 'scale' ? 1 : 'any'} value={draft.format?.max ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, max: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
            <label>{t('controls.step')}<input disabled={!editor.isEditable} type="number" min="0.000000001" step={draft.type === 'scale' ? 1 : 'any'} value={draft.format?.step ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, step: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
            {(draft.type === 'scale' || draft.type === 'progress') && <>
              {draft.type === 'scale' && <label>{t('controls.scaleIcon')}
                <select disabled={!editor.isEditable} value={draft.format?.scaleIcon ?? 'star'} onChange={(event) => patchDraft({ format: { ...draft.format, scaleIcon: event.target.value as NonNullable<PropertyFormat['scaleIcon']> } })}>
                  <option value="star">{t('controls.scaleIcons.star')}</option>
                  <option value="number">{t('controls.scaleIcons.number')}</option>
                </select>
              </label>}
              <label>{t('controls.color')}
                <select disabled={!editor.isEditable} value={draft.format?.color ?? 'blue'} onChange={(event) => patchDraft({ format: { ...draft.format, color: event.target.value as NonNullable<PropertyFormat['color']> } })}>
                  {COLORS.map((color) => <option key={color} value={color}>{t(`colors.${color}` as never)}</option>)}
                </select>
              </label>
              <label className="named-data-check"><input disabled={!editor.isEditable} type="checkbox" checked={draft.format?.showValue !== false} onChange={(event) => patchDraft({ format: { ...draft.format, showValue: event.target.checked } })} />{t('controls.showValue')}</label>
            </>}
          </div>}
          {currentDraftError && <div className="named-data-diagnostic" role="status">{unavailableCurrentIds.length > 0 ? t('controls.unavailableSelection') : t('controls.currentValueInvalid')}</div>}
          {currentDraftError && <label className="named-data-check">
            <input disabled={!editor.isEditable} type="checkbox" checked={clearCurrentValue} onChange={(event) => setClearCurrentValueFor(event.target.checked ? clearCurrentValueSignature : null)} />
            {t('controls.clearCurrentValue')}
          </label>}
          {unavailableCurrentIds.length > 0 && resolutionSignature && <label className="named-data-check">
            <input disabled={!editor.isEditable} type="checkbox" checked={resolveCurrentOptions} onChange={(event) => setResolveCurrentOptionsFor(event.target.checked ? resolutionSignature : null)} />
            {t('controls.removeUnavailableCurrentOptions', { options: unavailableCurrentIds.map((id) => draftControl?.options.find((option) => option.id === id)?.name ?? control?.options.find((option) => option.id === id)?.name ?? t('controls.unavailableOption', { id })).join(', ') })}
          </label>}
          {unavailableDefaultIds.length > 0 && resolutionSignature && <label className="named-data-check">
            <input disabled={!editor.isEditable} type="checkbox" checked={resolveDefaultOptions} onChange={(event) => setResolveDefaultOptionsFor(event.target.checked ? resolutionSignature : null)} />
            {t('controls.removeUnavailableDefaultOptions', { options: unavailableDefaultIds.map((id) => draftControl?.options.find((option) => option.id === id)?.name ?? control?.options.find((option) => option.id === id)?.name ?? t('controls.unavailableOption', { id })).join(', ') })}
          </label>}
          {(draftDefaultError || optionError) && <div className="named-data-diagnostic" role="status">{optionError ?? (unavailableDefaultIds.length > 0 ? t('controls.unavailableSelection') : draftDefaultError)}</div>}
          {saveError && <div className="named-data-diagnostic" role="alert">{saveError}</div>}
          <div className="named-data-actions">
            <button type="button" disabled={!editor.isEditable} onClick={save}>{t('controls.save')}</button>
            {control && <button type="button" disabled={!editor.isEditable} onClick={removeDefinition}>{t('controls.deleteControl')}</button>}
            <button type="button" onClick={cancelEdit}>{t('controls.cancel')}</button>
          </div>
        </span>
      ) : !control ? (
        <span className="named-data-missing" title={t('controls.deletedDiagnostic')}>{t('controls.missingControl', { name: String(node.attrs.label ?? controlId) })}
          {editor.isEditable && <button type="button" onClick={() => startEdit()}>{t('controls.recreate')}</button>}
        </span>
      ) : (
        <span className="named-data-control-line">
          <span className="named-data-label">{control.name}</span>
          {control.type === 'text' && <input
            disabled={!editor.isEditable}
            aria-label={control.name}
            aria-invalid={Boolean(valueDraftError || valueError)}
            type={control.textFormat === 'email' ? 'email' : 'text'}
            value={activeValueDraft?.controlId === control.id ? activeValueDraft.value : typeof control.value === 'string' ? control.value : ''}
            onChange={(event) => {
              const value = event.target.value;
              const error = controlValueError(control, value);
              if (error) setValueDraft({ controlId: control.id, value, sourceValue: control.value });
              else { setValueDraft(null); setValue(value); }
            }}
          />}
          {control.type === 'number' && <input
            disabled={!editor.isEditable}
            aria-label={control.name}
            aria-invalid={Boolean(valueDraftError || valueError)}
            type="text"
            inputMode="decimal"
            value={activeValueDraft?.controlId === control.id ? activeValueDraft.value : typeof control.value === 'number' ? String(control.value) : ''}
            onChange={(event) => {
              const raw = event.target.value;
              if (raw === '') { setValueDraft(null); setValue(null); return; }
              const value = parseNumberDraft(raw);
              if (value === null || controlValueError(control, value)) setValueDraft({ controlId: control.id, value: raw, sourceValue: control.value });
              else { setValueDraft(null); setValue(value); }
            }}
          />}
          {control.type === 'slider' && <input disabled={!editor.isEditable} aria-label={control.name} type="range" value={typeof control.value === 'number' ? control.value : (control.format?.min ?? 0)} min={control.format?.min ?? 0} max={control.format?.max ?? 100} step={control.format?.step ?? 1} onChange={(event) => setValue(Number(event.target.value))} />}
          {boundedRange && (control.type === 'scale' || control.type === 'progress') && <span className={`named-control-bounded named-control-${control.type}`}>
            {control.type === 'progress' && <progress
              className="named-control-progress-display"
              max={boundedRange.max - boundedRange.min}
              value={typeof control.value === 'number' ? control.value - boundedRange.min : undefined}
              aria-hidden="true"
              style={{ accentColor: TEXT_HEX[control.format?.color ?? 'blue'] }}
            />}
            {control.type === 'scale' && <span
              className={`named-control-scale-display icon-${control.format?.scaleIcon ?? 'star'}`}
              aria-label={boundedValueText(typeof control.value === 'number' ? control.value : null, boundedRange.min, boundedRange.max)}
              title={boundedValueText(typeof control.value === 'number' ? control.value : null, boundedRange.min, boundedRange.max)}
              style={{ color: TEXT_HEX[control.format?.color ?? 'blue'] }}
            >
              {control.format?.scaleIcon === 'number'
                ? <span aria-hidden="true">{typeof control.value === 'number' ? String(control.value) : '—'}</span>
                : <span aria-hidden="true">{'★'.repeat(typeof control.value === 'number' ? scaleFilledSteps(control.value, boundedRange.min, boundedRange.max) : 0)}{'☆'.repeat(typeof control.value === 'number' ? 5 - scaleFilledSteps(control.value, boundedRange.min, boundedRange.max) : 5)}</span>}
              {control.format?.showValue !== false && <small aria-hidden="true">{typeof control.value === 'number' ? String(control.value) : t('controls.blank')}</small>}
            </span>}
            <input
              disabled={!editor.isEditable}
              aria-label={control.name}
              aria-valuetext={boundedValueText(typeof control.value === 'number' ? control.value : null, boundedRange.min, boundedRange.max)}
              type="range"
              min={boundedRange.min}
              max={boundedRange.max}
              step={boundedRange.step}
              value={typeof control.value === 'number' ? control.value : boundedRange.min}
              style={{ accentColor: TEXT_HEX[control.format?.color ?? 'blue'] }}
              onChange={(event) => setValue(Number(event.target.value))}
            />
            <span className="named-control-range-legend" aria-hidden="true"><small>{boundedRange.min}</small><small>{boundedRange.max}</small></span>
          </span>}
          {control.type === 'select' && <select disabled={!editor.isEditable} aria-label={control.name} value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value || null)}><option value="">{t('controls.blank')}</option>{control.options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
          {control.type === 'multiSelect' && <NamedMultiSelectPicker
            label={control.name}
            options={control.options}
            value={control.value}
            onChange={setValue}
            disabled={!editor.isEditable}
          />}
          {control.type === 'checkbox' && <input disabled={!editor.isEditable} aria-label={control.name} type="checkbox" checked={control.value === true} onChange={(event) => setValue(event.target.checked)} />}
          {control.type === 'date' && <input disabled={!editor.isEditable} aria-label={control.name} type="date" value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value)} />}
          {control.type === 'dateRange' && <span className="named-control-date-range">
            <label className="named-control-date-range-preset">{t('controls.quickPeriod')}<select
              disabled={!editor.isEditable}
              aria-label={t('controls.quickPeriod')}
              defaultValue="custom"
              onChange={(event) => {
                const selected = event.currentTarget.value;
                if (selected === 'custom') return;
                const range = dateRangeForPreset(selected as DateRangePreset, new Date());
                if (range) setValue(range);
                event.currentTarget.value = 'custom';
              }}
            >
              <option value="custom">{t('controls.customDateRange')}</option>
              <option value="today">{t('controls.dateRangePresets.today')}</option>
              <option value="lastSevenDays">{t('controls.dateRangePresets.lastSevenDays')}</option>
              <option value="currentMonth">{t('controls.dateRangePresets.currentMonth')}</option>
              <option value="nextSevenDays">{t('controls.dateRangePresets.nextSevenDays')}</option>
            </select></label>
            <DateRangeInputs
              identity={`${pageId}:${control.id}`}
              label={control.name}
              value={control.value}
              disabled={!editor.isEditable}
              onChange={setValue}
            />
          </span>}
          {control.type === 'relation' && control.relation?.multiple && <select disabled={!editor.isEditable} aria-label={control.name} multiple value={Array.isArray(control.value) ? control.value : []} onChange={(event) => setValue(Array.from(event.target.selectedOptions).map((item) => item.value))}>{relatedRows.map((row) => <option key={row.id} value={row.id}>{displayTitle(row)}</option>)}</select>}
          {control.type === 'relation' && !control.relation?.multiple && <select disabled={!editor.isEditable} aria-label={control.name} value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value || null)}><option value="">{t('controls.blank')}</option>{relatedRows.map((row) => <option key={row.id} value={row.id}>{displayTitle(row)}</option>)}</select>}
          {editor.isEditable && <button
            type="button"
            className="named-data-configure"
            aria-label={t('controls.controlActions')}
            aria-haspopup="menu"
            aria-expanded={menuAnchor !== null}
            onClick={(event) => {
              if (editor.isEditable) setMenuAnchor(event.currentTarget);
            }}
          >⚙</button>}
          {menuAnchor && control && editor.isEditable && <Menu
            anchor={menuAnchor}
            entries={controlMenuEntries}
            label={t('controls.controlActions')}
            onClose={() => setMenuAnchor(null)}
          />}
          {(valueDraftError || valueError || relationStateError) && <span className="named-data-diagnostic" role="status">{valueDraftError ?? (valueError ? t('controls.invalidDefaultValue') : t('controls.relationUnavailable'))}</span>}
        </span>
      )}
    </NodeViewWrapper>
  );
}

function collectResultNodes(document: { descendants?: (visitor: (node: { type: { name: string }; attrs: Record<string, unknown> }) => void) => void }) {
  const results: Array<{ resultId: string; name: string }> = [];
  document.descendants?.((node) => {
    if (node.type.name === 'calculatedResult' && typeof node.attrs.resultId === 'string')
      results.push({ resultId: node.attrs.resultId, name: String(node.attrs.name ?? 'Result') });
  });
  return results;
}

function outputProperty(type: OutputType, format: PropertyFormat): PropDef & { format: PropertyFormat } {
  const propType = type === 'auto' || type === 'text' ? 'formula' : type;
  const defaults: PropertyFormat = type === 'currency'
    ? { locale: 'pt-BR', currency: 'BRL', precision: 2 }
    : type === 'scale'
      ? defaultBoundedNumericControlFormat(type)
      : type === 'progress'
        ? { max: 100 }
        : ['number', 'percent'].includes(type)
          ? { locale: 'pt-BR', precision: 2 }
          : {};
  return { id: 'document-result', name: 'Result', type: propType, options: [], format: { ...defaults, ...format } };
}

export function calculatedResultPresentation(
  value: FormulaRuntimeValue,
  outputType: OutputType,
  format: PropertyFormat,
  state: ReturnType<typeof getState>,
): { display: string; diagnostic: string | null; progress: number | null } {
  if (value === null || value === '' || (Array.isArray(value) && value.length === 0))
    return { display: '[]', diagnostic: null, progress: null };
  const property = outputProperty(outputType, format);
  let display: string | null = null;
  let diagnostic: string | null = null;
  if (outputType === 'scale') {
    const formatError = boundedNumericControlFormatError('scale', property.format);
    if (formatError) diagnostic = t('controls.invalidControlFormat');
    else if (typeof value !== 'number') diagnostic = t('controls.expectedNumber');
    else if (scalarValueError(property, value)) diagnostic = t('controls.resultOutsideRange');
    else display = formatDisplayValue(property, value, getLocale());
  } else if (outputType === 'progress') {
    if (calculatedResultFormatError('progress', property.format)) diagnostic = t('controls.invalidFormat');
    else if (typeof value !== 'number') diagnostic = t('controls.expectedNumber');
    else if (scalarValueError(property, value)) diagnostic = t('controls.resultOutsideRange');
    else display = formatDisplayValue(property, value, getLocale());
  } else if (outputType === 'currency' || outputType === 'number' || outputType === 'percent') {
    if (typeof value !== 'number') diagnostic = t('controls.expectedNumber');
    else display = formatDisplayValue(property, value, getLocale());
  } else if (outputType === 'checkbox') {
    if (typeof value !== 'boolean') diagnostic = t('controls.expectedCheckbox');
    else display = value ? t('controls.checked') : t('controls.unchecked');
  } else if (outputType === 'date') {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) diagnostic = t('controls.expectedDate');
    else display = formatDisplayValue(property, value, getLocale());
  } else {
    const present = (item: FormulaRuntimeValue): string => {
      if (Array.isArray(item)) return item.map(present).join(', ');
      if (typeof item === 'boolean') return formatDisplayValue(property, item, getLocale());
      return formulaValueText(property, item, state);
    };
    display = present(value);
  }
  return {
    display: display === null || display === '' ? '[]' : display,
    diagnostic,
    progress: outputType === 'progress' && diagnostic === null && typeof value === 'number' ? value : null,
  };
}

export function CalculatedResultNode(props: NodeViewProps) {
  const state = useWorkspace();
  const { node, deleteNode, editor, getPos } = props;
  const extensionPageId = (editor.extensionManager.extensions.find((item) => item.name === 'calculatedResult')?.options as { hostPageId?: string } | undefined)?.hostPageId;
  const pageId = String(node.attrs.pageId || extensionPageId || '');
  const resultId = String(node.attrs.resultId ?? '');
  const formula = String(node.attrs.formula ?? '');
  const bindings = (Array.isArray(node.attrs.bindings) ? node.attrs.bindings : []) as FormulaReferenceBinding[];
  const outputType = (OUTPUT_TYPES.includes(node.attrs.outputType as OutputType) ? node.attrs.outputType : 'auto') as OutputType;
  const format = (node.attrs.format && typeof node.attrs.format === 'object' ? node.attrs.format : {}) as PropertyFormat;
  const name = String(node.attrs.name ?? '');
  const [activeDraftSession, setActiveDraftSession] = useState(() => readCalculatedResultDraft(editor, pageId, resultId));
  const [editing, setEditing] = useState(() => activeDraftSession !== null);
  const [autoFocusFormula, setAutoFocusFormula] = useState(() => activeDraftSession === null);
  const [draft, setDraft] = useState(() =>
    activeDraftSession
      ? { ...activeDraftSession.config, formula: activeDraftSession.formula, bindings: activeDraftSession.bindings }
      : { name, formula, bindings, outputType, format },
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const editTargetRef = useRef<CalculatedResultEditTarget | null>(activeDraftSession?.target ?? null);
  const draftSnapshotRef = useRef<CalculatedResultDraftSnapshot | null>(activeDraftSession);
  const resultAnchorRef = useRef<HTMLSpanElement>(null);
  const resultPopoverRef = useRef<HTMLSpanElement>(null);
  const unconfigured = !formula.trim();
  const result = unconfigured
    ? { value: null, error: null }
    : pageId && resultId
      ? documentFormulaResult(pageId, resultId, formula, bindings, state)
      : { value: null, error: t('controls.pageMissing') };
  const valuePresentation = !unconfigured && !result.error
    ? calculatedResultPresentation(result.value, outputType, format, state)
    : { display: '[]', diagnostic: null, progress: null };
  const diagnostic = result.error ?? valuePresentation.diagnostic;
  const formulaDiagnostic = result.error
    ? presentFormulaDiagnostic(result.error, {
        memberAfterDot: (token) => t('formulaUx.memberAfterDot', { token }),
        unexpectedToken: (token) => t('formulaUx.unexpectedToken', { token }),
        invalidSummary: t('formulaUx.invalidSummary'),
      })
    : null;
  const display = valuePresentation.display;
  const progress = valuePresentation.progress;
  const boundedOutputRange = outputType === 'scale' || outputType === 'progress'
    ? {
        min: format.min ?? (outputType === 'scale' ? 1 : 0),
        max: format.max ?? (outputType === 'scale' ? 5 : 100),
      }
    : null;
  const scale = outputType === 'scale' && !diagnostic && typeof result.value === 'number' ? result.value : null;
  const scaleUsesStars = scale !== null && (format.scaleIcon ?? 'star') === 'star';
  const hideBoundedValue = !unconfigured && !diagnostic && format.showValue === false && scaleUsesStars;
  const editorDoc = editor.state.doc;
  const referenceChoices = useMemo<DocumentFormulaReference[]>(() => {
    const page = state.pages[pageId];
    const raw = [
      ...(page?.controls.map((control) => ({ key: `control:${control.id}`, name: control.name, kind: 'control' as const, id: control.id })) ?? []),
      ...collectResultNodes(editorDoc).filter((item) => item.resultId !== resultId).map((item) => ({ key: `result:${item.resultId}`, name: item.name, kind: 'result' as const, id: item.resultId })),
    ];
    return raw.map((item) => {
      const displayName = item.name.trim() || t('controls.unnamedResult');
      const sameNameCount = raw.filter((candidate) =>
        (candidate.name.trim() || t('controls.unnamedResult')).toLocaleLowerCase() === displayName.toLocaleLowerCase(),
      ).length;
      const uniqueName = sameNameCount > 1 || !item.name.trim()
        ? `${displayName} · ${item.id.slice(-6)}`
        : displayName;
      return {
        ...item,
        name: displayName,
        formulaName: uniqueName,
        label: `${t(item.kind === 'control' ? 'controls.referenceControl' : 'controls.referenceResult', { name: displayName })}${uniqueName === displayName ? '' : ` · ${item.id.slice(-6)}`}`,
      };
    });
  }, [editorDoc, pageId, resultId, state]);

  const persistDraftPatch = (
    patch: Partial<Pick<CalculatedResultDraftSnapshot, 'config' | 'formula' | 'bindings'>>,
  ) => {
    if (!editor.isEditable || editor.isDestroyed) return;
    const current = draftSnapshotRef.current;
    if (!current) return;
    const next = { ...current, ...patch };
    draftSnapshotRef.current = next;
    writeCalculatedResultDraft(next);
  };
  const updateDraft = (next: typeof draft) => {
    setDraft(next);
    const config: CalculatedResultConfigurationDraft = {
      name: next.name,
      outputType: next.outputType,
      format: next.format,
    };
    persistDraftPatch({ config });
  };
  const clearEditSession = () => {
    clearCalculatedResultDraft(editor, pageId, resultId);
    draftSnapshotRef.current = null;
    editTargetRef.current = null;
    setActiveDraftSession(null);
  };

  const startEdit = () => {
    if (!editor.isEditable || editor.isDestroyed) return;
    if (draftSnapshotRef.current) {
      setActiveDraftSession(draftSnapshotRef.current);
      setEditing(true);
      return;
    }
    setMenuAnchor(null);
    setSaveError(null);
    const target = captureCalculatedResultEditTarget(editor, pageId, resultId, node.attrs);
    if (!isCurrentCalculatedResultEditTarget(editor, getPos, target)) {
      editTargetRef.current = null;
      return;
    }
    const initialSession: CalculatedResultDraftSnapshot = {
      target,
      config: { name, outputType, format: { ...format } },
      formula,
      bindings: bindings.map((binding) => ({ ...binding })),
    };
    editTargetRef.current = target;
    draftSnapshotRef.current = initialSession;
    writeCalculatedResultDraft(initialSession);
    setActiveDraftSession(initialSession);
    setDraft({ ...initialSession.config, formula, bindings: initialSession.bindings });
    setAutoFocusFormula(true);
    setEditing(true);
  };
  const startEditRef = useRef(startEdit);
  useLayoutEffect(() => {
    startEditRef.current = startEdit;
  });
  useLayoutEffect(() => {
    const dispose = listenForCalculatedResultConfiguration(editor, pageId, resultId, () => startEditRef.current());
    return () => {
      dispose();
      cancelCalculatedResultConfigurationRequest(editor, pageId, resultId);
    };
  }, [editor, pageId, resultId]);
  useLayoutEffect(() => {
    if (!editing) return;
    const place = () => {
      const anchor = resultAnchorRef.current;
      const popover = resultPopoverRef.current;
      if (!anchor || !popover) return;
      const pane = anchor.closest<HTMLElement>('.pane');
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const paneRect = pane?.getBoundingClientRect() ?? {
        left: 0, top: 0, right: viewport.width, bottom: viewport.height,
      };
      const anchorRect = anchor.getBoundingClientRect();
      popover.style.visibility = 'hidden';
      const initial = calculateResultPopoverPlacement(
        anchorRect,
        paneRect,
        viewport,
        popover.getBoundingClientRect(),
      );
      if (!initial) return;
      popover.style.width = `${initial.width}px`;
      popover.style.maxWidth = `${initial.width}px`;
      popover.style.maxHeight = `${initial.maxHeight}px`;
      const placement = calculateResultPopoverPlacement(
        anchorRect,
        paneRect,
        viewport,
        popover.getBoundingClientRect(),
      );
      if (!placement) return;
      popover.style.left = `${placement.left}px`;
      popover.style.top = `${placement.top}px`;
      popover.style.visibility = 'visible';
    };
    let frame: number | null = null;
    const schedulePlace = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        place();
      });
    };
    place();
    window.addEventListener('resize', schedulePlace);
    window.addEventListener('scroll', schedulePlace, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedulePlace);
    const anchor = resultAnchorRef.current;
    const popover = resultPopoverRef.current;
    const pane = anchor?.closest<HTMLElement>('.pane');
    const paneHost = pane?.parentElement;
    if (anchor) observer?.observe(anchor);
    if (popover) observer?.observe(popover);
    if (pane) observer?.observe(pane);
    if (paneHost) observer?.observe(paneHost);
    const mutationObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedulePlace);
    if (pane) mutationObserver?.observe(pane, { attributes: true, attributeFilter: ['class', 'data-size', 'style'] });
    if (paneHost) mutationObserver?.observe(paneHost, { attributes: true, attributeFilter: ['class', 'style'] });
    return () => {
      window.removeEventListener('resize', schedulePlace);
      window.removeEventListener('scroll', schedulePlace, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [editing, draft, saveError]);
  const save = (source: string, nextBindingsInput: FormulaReferenceBinding[]): boolean => {
    if (!editor.isEditable || editor.isDestroyed) return false;
    setSaveError(null);
    const target = editTargetRef.current;
    if (!target || !isCurrentCalculatedResultEditTarget(editor, getPos, target)) {
      setSaveError(t('controls.resultChanged'));
      return false;
    }
    commitEditors();
    if (!isCurrentCalculatedResultEditTarget(editor, getPos, target)) {
      setSaveError(t('controls.resultChanged'));
      return false;
    }
    const currentState = getState();
    const freshBindings = bindPageFormulaReferences(
      source,
      pageId,
      currentState,
      currentState.pages[pageId]?.parentId,
      nextBindingsInput,
    );
    const nextFormat = normalizeControlFormat(outputProperty(draft.outputType, draft.format).format);
    const formatError = nextFormat && (draft.outputType === 'scale' || draft.outputType === 'progress')
      ? calculatedResultFormatError(draft.outputType, nextFormat)
      : null;
    if (!nextFormat || formatError) {
      setSaveError(t('controls.invalidFormat'));
      return false;
    }
    const nextDraft = { ...draft, name: draft.name.trim(), formula: source, bindings: freshBindings, format: nextFormat };
    const position = getPos();
    const currentNode = typeof position === 'number' ? editor.state.doc.nodeAt(position) : null;
    if (!currentNode || currentNode.type.name !== 'calculatedResult' || currentNode.attrs.resultId !== resultId) {
      setSaveError(t('controls.resultChanged'));
      return false;
    }
    editor.view.dispatch(createCalculatedResultConfigurationTransaction(
      editor.state.tr,
      position as number,
      currentNode,
      { ...nextDraft, pageId },
    ));
    editor.view.dispatch(closeCalculatedResultConfigurationHistory(editor.state.tr));
    clearEditSession();
    setDraft(nextDraft);
    setEditing(false);
    return true;
  };
  const removeResult = () => {
    const target = editTargetRef.current;
    if (!editor.isEditable || editor.isDestroyed || !target || !isCurrentCalculatedResultEditTarget(editor, getPos, target)) {
      setSaveError(t('controls.resultChanged'));
      return;
    }
    commitEditors();
    if (!isCurrentCalculatedResultEditTarget(editor, getPos, target)) {
      setSaveError(t('controls.resultChanged'));
      return;
    }
    deleteNode();
    clearEditSession();
  };
  const updateFormat = (change: Partial<PropertyFormat>) =>
    updateDraft({ ...draft, format: { ...draft.format, ...change } });
  const { ownerDatabaseId, database: formulaDatabase } = documentFormulaContext(state, pageId);
  const editError = saveError;
  const resultActions: MenuEntry[] = [{ label: t('controls.configureResult'), onSelect: startEdit }];

  return (
    <NodeViewWrapper
      ref={resultAnchorRef}
      as="span"
      className={`named-data-result${diagnostic ? ' has-error' : ''}${unconfigured ? ' is-unconfigured' : ''}`}
      contentEditable={false}
      onMouseDown={stop}
      onContextMenu={(event: React.MouseEvent<HTMLElement>) => {
        if (!editor.isEditable) return;
        event.preventDefault();
        event.stopPropagation();
        setMenuAnchor(event.currentTarget);
      }}
      title={formulaDiagnostic?.primary ?? diagnostic ?? (unconfigured ? t('controls.resultNotConfigured') : undefined)}
    >
      {editing ? <span ref={resultPopoverRef} className="named-data-popover named-data-result-editor" role="group" aria-label={t('controls.configureResult')}>
        <label>{t('controls.name')}<input disabled={!editor.isEditable} value={draft.name} maxLength={100} onChange={(event) => updateDraft({ ...draft, name: event.target.value })} /></label>
        <label>{t('controls.outputType')}<select disabled={!editor.isEditable} value={draft.outputType} onChange={(event) => updateDraft({ ...draft, outputType: event.target.value as OutputType })}>{OUTPUT_TYPES.map((item) => <option key={item} value={item}>{t(`controls.outputTypes.${item}` as never)}</option>)}</select></label>
        {(draft.outputType === 'currency' || draft.outputType === 'percent' || draft.outputType === 'number' || draft.outputType === 'scale' || draft.outputType === 'progress') && <div className="named-data-format">
          {draft.outputType === 'currency' && <label>{t('controls.currency')}<input disabled={!editor.isEditable} value={draft.format.currency ?? 'BRL'} maxLength={3} onChange={(event) => updateDraft({ ...draft, format: { ...draft.format, currency: event.target.value.toUpperCase() } })} /></label>}
          <label>{t('controls.locale')}<input disabled={!editor.isEditable} value={draft.format.locale ?? 'pt-BR'} onChange={(event) => updateFormat({ locale: event.target.value })} /></label>
          {draft.outputType !== 'progress' && draft.outputType !== 'scale' && <label>{t('controls.precision')}<input disabled={!editor.isEditable} type="number" min="0" max="8" value={draft.format.precision ?? 2} onChange={(event) => updateFormat({ precision: Number(event.target.value) })} /></label>}
          {draft.outputType === 'progress' && <label>{t('controls.maximum')}<input disabled={!editor.isEditable} type="number" min="0.000000001" value={draft.format.max ?? 100} onChange={(event) => updateFormat({ max: Number(event.target.value) })} /></label>}
          {draft.outputType === 'scale' && (() => {
            const defaults = defaultBoundedNumericControlFormat('scale');
            return <>
              <label>{t('controls.minimum')}<input disabled={!editor.isEditable} type="number" step="1" value={draft.format.min ?? defaults.min ?? ''} onChange={(event) => updateFormat({ min: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
              <label>{t('controls.maximum')}<input disabled={!editor.isEditable} type="number" step="1" value={draft.format.max ?? defaults.max ?? ''} onChange={(event) => updateFormat({ max: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
              <label>{t('controls.step')}<input disabled={!editor.isEditable} type="number" min="1" step="1" value={draft.format.step ?? defaults.step ?? ''} onChange={(event) => updateFormat({ step: event.target.value === '' ? undefined : Number(event.target.value) })} /></label>
              <label>{t('controls.scaleIcon')}
                <select disabled={!editor.isEditable} value={draft.format.scaleIcon ?? defaults.scaleIcon} onChange={(event) => updateFormat({ scaleIcon: event.target.value as NonNullable<PropertyFormat['scaleIcon']> })}>
                  <option value="star">{t('controls.scaleIcons.star')}</option>
                  <option value="number">{t('controls.scaleIcons.number')}</option>
                </select>
              </label>
              <label>{t('controls.color')}
                <select disabled={!editor.isEditable} value={draft.format.color ?? defaults.color} onChange={(event) => updateFormat({ color: event.target.value as NonNullable<PropertyFormat['color']> })}>
                  {COLORS.map((color) => <option key={color} value={color}>{t(`colors.${color}` as never)}</option>)}
                </select>
              </label>
              <label className="named-data-check"><input disabled={!editor.isEditable} type="checkbox" checked={draft.format.showValue ?? true} onChange={(event) => updateFormat({ showValue: event.target.checked })} />{t('controls.showValue')}</label>
            </>;
          })()}
        </div>}
        {editError && <div className="named-data-diagnostic" role="alert">{editError}</div>}
        <FormulaEditor
          mode="document"
          id={`result-${resultId}-formula`}
          pageId={pageId}
          ownerDatabaseId={ownerDatabaseId}
          database={formulaDatabase}
          formula={formula}
          bindings={bindings}
          initialDraft={calculatedResultFormulaDraftSeed(activeDraftSession, formula, bindings)}
          onDraftChange={(source, nextBindings) => persistDraftPatch({ formula: source, bindings: nextBindings })}
          references={referenceChoices}
          editable={editor.isEditable}
          label={t('controls.formula')}
          applyLabel={t('controls.save')}
          autoFocus={autoFocusFormula}
          bindReferences={(source, nextBindings) => bindPageFormulaReferences(
            source,
            pageId,
            getState(),
            getState().pages[pageId]?.parentId,
            nextBindings,
          )}
          evaluate={(source, nextBindings) => documentFormulaResult(pageId, resultId, source, nextBindings, getState())}
          formatResult={(value): DocumentFormulaFormattedResult => {
            const preview = calculatedResultPresentation(value, draft.outputType, draft.format, getState());
            return { text: preview.display, error: preview.diagnostic };
          }}
          onApply={save}
          onCancel={() => { clearEditSession(); setEditing(false); setSaveError(null); }}
        />
        <div className="named-data-actions"><button type="button" disabled={!editor.isEditable} onClick={removeResult}>{t('controls.deleteResult')}</button></div>
      </span> : <span className="named-data-result-line">
        {name.trim() && <span className="named-data-result-name">{name}</span>}
        <span className={`named-data-result-value${!diagnostic && !unconfigured && display === '[]' ? ' is-empty' : ''}`} aria-live="polite" aria-hidden={hideBoundedValue}>
          {unconfigured ? t('controls.resultNotConfigured') : diagnostic ? formulaDiagnostic?.primary ?? diagnostic : hideBoundedValue ? '' : display}
        </span>
        {scale !== null && boundedOutputRange && scaleUsesStars && <span
          className="named-data-result-scale"
          aria-label={hideBoundedValue ? boundedValueText(scale, boundedOutputRange.min, boundedOutputRange.max) : undefined}
          aria-hidden={!hideBoundedValue}
          style={{ color: TEXT_HEX[format.color ?? 'blue'] }}
        >
          <span aria-hidden="true">{'★'.repeat(scaleFilledSteps(scale, boundedOutputRange.min, boundedOutputRange.max))}{'☆'.repeat(5 - scaleFilledSteps(scale, boundedOutputRange.min, boundedOutputRange.max))}</span>
          {format.showValue !== false && <small aria-hidden="true">{` ${display}`}</small>}
        </span>}
        {progress !== null && boundedOutputRange && !diagnostic && <progress
          max={boundedOutputRange.max - boundedOutputRange.min}
          value={progress - boundedOutputRange.min}
          aria-label={name.trim() || t('controls.unnamedResult')}
          aria-valuetext={boundedValueText(progress, boundedOutputRange.min, boundedOutputRange.max)}
          aria-live="polite"
          style={format.color ? { accentColor: TEXT_HEX[format.color] } : undefined}
        />}
        {formulaDiagnostic?.technicalDetail && <details className="named-data-diagnostic">
          <summary>{t('formulaUx.technicalDetails')}</summary>
          <code dir="auto">{formulaDiagnostic.technicalDetail}</code>
        </details>}
        {diagnostic && !result.error && <span className="named-data-diagnostic">{diagnostic}</span>}
        {editor.isEditable && <button type="button" className="named-data-configure" aria-label={t('controls.configureResult')} onClick={startEdit}>⚙</button>}
        {menuAnchor && editor.isEditable && <Menu anchor={menuAnchor} entries={resultActions} label={t('controls.configureResult')} onClose={() => setMenuAnchor(null)} />}
      </span>}
    </NodeViewWrapper>
  );
}
