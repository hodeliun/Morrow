import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { bindPageFormulaReferences, documentFormulaResult, formatDisplayValue, formulaValueText } from '../../core/database';
import type { FormulaReferenceBinding, NamedControlDef, NamedControlType, PropDef, PropValue, PropertyFormat } from '../../core/model';
import { displayTitle } from '../../core/model';
import { controlValueError, controlValueErrorInState, normalizeControlFormat } from '../../core/controls';
import { childrenOf, isEffectivelyTrashed } from '../../core/tree';
import { newId } from '../platform/files';
import { commitEditors } from '../editor/commits';
import { getState, run, runAll, useWorkspace } from '../workspace';
import { getLocale, t } from '../i18n';
import { Menu } from './Menu';
import type { MenuEntry } from './Menu';
import {
  cancelNamedControlConfigurationRequest,
  listenForNamedControlConfiguration,
} from '../editor/namedControlRequests';
import type { NamedControlConfigRequest } from '../editor/namedControlRequests';
import { captureNamedControlEdit, namedControlEditConflict } from '../editor/controlEditGuard';
import type { NamedControlEditConflict, NamedControlEditSnapshot } from '../editor/controlEditGuard';

const CONTROL_TYPES: NamedControlType[] = ['text', 'number', 'slider', 'select', 'checkbox', 'date', 'relation'];
const OUTPUT_TYPES = ['auto', 'text', 'number', 'currency', 'percent', 'progress', 'date', 'checkbox'] as const;
type OutputType = (typeof OUTPUT_TYPES)[number];

function stop(event: React.MouseEvent | React.KeyboardEvent) {
  event.stopPropagation();
}

function defaultFor(type: NamedControlType, options: NamedControlDef['options'], multiple = false): PropValue {
  switch (type) {
    case 'text': return '';
    case 'number':
    case 'slider': return 0;
    case 'checkbox': return false;
    case 'date': return '';
    case 'select': return options[0]?.id ?? null;
    case 'relation': return multiple ? [] : null;
    // Format13 metadata can be preserved before these creation widgets are exposed.
    case 'scale':
    case 'progress':
    case 'multiSelect':
    case 'dateRange': return null;
  }
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
  if (/number|finite|step|at least|at most/i.test(error)) return t('controls.invalidNumber');
  if (error.toLowerCase().includes('text controls')) return t('controls.invalidText');
  return t('controls.invalidDefaultValue');
}

function editConflictLabel(conflict: NamedControlEditConflict, name: string): string {
  return conflict === 'removed'
    ? t('controls.missingControl', { name })
    : t('controls.configurationChanged');
}

function optionsFromText(text: string, existing: NamedControlDef['options']): NamedControlDef['options'] {
  const used = new Set<string>();
  return text.split('\n').map((name) => name.trim()).filter(Boolean).map((name, index) => {
    const old = existing.find((option) => option.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const samePosition = existing[index];
    const preserved = old ?? (samePosition && !used.has(samePosition.id) ? samePosition : null);
    const option = preserved ? { ...preserved, name } : { id: newId(), name, color: 'gray' as const };
    used.add(option.id);
    return option;
  });
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
  const [optionsText, setOptionsText] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<HTMLButtonElement | null>(null);
  const [clearCurrentValueFor, setClearCurrentValueFor] = useState<string | null>(null);
  const [creatingFromSlash, setCreatingFromSlash] = useState(false);
  const [editSnapshot, setEditSnapshot] = useState<NamedControlEditSnapshot | null>(null);
  const [draftDefaultNumber, setDraftDefaultNumber] = useState<string | null>(null);
  const [valueDraft, setValueDraft] = useState<{ controlId: string; value: string; sourceValue: PropValue } | null>(null);
  const controlAnchorRef = useRef<HTMLSpanElement>(null);
  const configPopoverRef = useRef<HTMLSpanElement>(null);
  const target = control?.relation?.targetDatabaseId ? state.pages[control.relation.targetDatabaseId] : null;
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
        if (error.includes('number') || error.includes('step') || error.includes('at least') || error.includes('at most')) return t('controls.invalidNumber');
        return t('controls.invalidText');
      })()
    : null;
  const draftControl = draft
    ? { ...draft, options: draft.type === 'select' ? optionsFromText(optionsText, draft.options) : draft.options }
    : null;
  const currentDraftError = control && draftControl
    ? controlValueErrorInState(draftControl, control.value, state)
    : null;
  const clearCurrentValueSignature = currentDraftError && control && draftControl
    ? clearValueIntentSignature(control, draftControl)
    : null;
  const clearCurrentValue = clearCurrentValueSignature !== null && clearCurrentValueFor === clearCurrentValueSignature;
  const parsedDefaultNumber = draftDefaultNumber === null ? null : parseNumberDraft(draftDefaultNumber);
  const draftDefaultValue = draftDefaultNumber === null ? draft?.defaultValue : parsedDefaultNumber;
  const draftDefaultError = draft && draftControl
    ? draft.type === 'relation' && !draft.relation?.targetDatabaseId
      ? t('controls.chooseTable')
      : draftDefaultNumber !== null && draftDefaultNumber.trim() !== '' && parsedDefaultNumber === null
      ? t('controls.invalidNumber')
      : controlErrorLabel(controlValueErrorInState(draftControl, draftDefaultValue ?? null, state))
    : null;
  const optionNames = draftControl?.type === 'select'
    ? draftControl.options.map((item) => item.name.trim().toLocaleLowerCase())
    : [];
  const optionError = draftControl?.type === 'select' && (
    draftControl.options.length > 100 ||
    new Set(optionNames).size !== optionNames.length ||
    draftControl.options.some((item) => item.name.length > 100)
  ) ? t('controls.invalidOptions') : null;

  const setValue = (value: PropValue) => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    run({ type: 'page.control.setValue', id: page.id, controlId: control.id, value, now: Date.now() });
  };
  const resetToDefault = () => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    run({ type: 'page.control.reset', id: page.id, controlId: control.id, now: Date.now() });
  };
  const clearCurrentValueNow = () => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    run({ type: 'page.control.setValue', id: page.id, controlId: control.id, value: null, now: Date.now() });
  };
  const startEdit = (request?: NamedControlConfigRequest) => {
    if (!editor.isEditable) return;
    setSaveError(null);
    setClearCurrentValueFor(null);
    setDraftDefaultNumber(null);
    setEditSnapshot(captureNamedControlEdit(pageId, controlId, control));
    if (!control) {
      const type = request?.type ?? 'text';
      const options = type === 'select'
        ? [{ id: newId(), name: t('controls.defaultOptionName', { count: 1 }), color: 'gray' as const }]
        : [];
      const relation = type === 'relation'
        ? { targetDatabaseId: request?.targetDatabaseId ?? null, multiple: false }
        : undefined;
      const initial = defaultFor(type, options, relation?.multiple ?? false);
      setDraft({
        id: controlId,
        name: String(node.attrs.label ?? 'Control'),
        type,
        ...(type === 'text' ? { textFormat: 'plain' as const } : {}),
        value: initial,
        defaultValue: initial,
        options,
        ...(relation ? { relation } : {}),
      });
      setCreatingFromSlash(request?.createOnSave === true);
      setOptionsText(options.map((item) => item.name).join('\n'));
    } else {
      setDraft({ ...control, options: control.options.map((item) => ({ ...item })), relation: control.relation ? { ...control.relation } : undefined });
      setCreatingFromSlash(false);
      setOptionsText(control.options.map((item) => item.name).join('\n'));
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
  }, [editing, draft, optionsText, saveError]);
  const cancelEdit = () => {
    if (creatingFromSlash && !control && editor.isEditable) deleteNode();
    setCreatingFromSlash(false);
    setEditSnapshot(null);
    setClearCurrentValueFor(null);
    setEditing(false);
  };
  const patchDraft = (change: Partial<NamedControlDef>) => {
    setClearCurrentValueFor(null);
    setDraft((current) => current ? { ...current, ...change } : current);
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
    const options = draft.type === 'select' ? optionsFromText(optionsText, draft.options) : draft.options;
    const optionNames = options.map((item) => item.name.trim().toLocaleLowerCase());
    if (draft.type === 'select' && (options.length > 100 || new Set(optionNames).size !== optionNames.length || options.some((item) => item.name.length > 100))) {
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
    let defaultValue = draft.defaultValue;
    if ((draft.type === 'number' || draft.type === 'slider') && draftDefaultNumber !== null) {
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
    const liveError = currentControl ? controlValueErrorInState(nextDraft, currentControl.value, currentState) : null;
    const canClearCurrentValue = currentControl && clearCurrentValueFor === clearValueIntentSignature(currentControl, nextDraft);
    if (liveError && !canClearCurrentValue) {
      setSaveError(t('controls.currentValueInvalid'));
      return;
    }
    const now = Date.now();
    const commands = [
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
    setDraftDefaultNumber(null);
  };
  const removeDefinition = () => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    const removed = run({ type: 'page.control.delete', id: page.id, controlId, now: Date.now() });
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
              const options = type === 'select' ? (draft.options.length ? draft.options : [{ id: newId(), name: t('controls.defaultOptionName', { count: 1 }), color: 'gray' as const }]) : draft.options;
              setOptionsText(options.map((item) => item.name).join('\n'));
              const relation = type === 'relation' ? (draft.relation ?? { targetDatabaseId: null, multiple: false }) : draft.relation;
              const multiple = relation?.multiple ?? false;
              const initial = defaultFor(type, options, multiple);
              setDraftDefaultNumber(null);
              patchDraft({
                type,
                options,
                relation,
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
          {draft.type === 'select' && <label>{t('controls.options')}
            <textarea disabled={!editor.isEditable} aria-invalid={Boolean(optionError)} rows={3} value={optionsText} onChange={(event) => {
              setOptionsText(event.target.value);
              patchDraft({ options: optionsFromText(event.target.value, draft.options) });
            }} />
          </label>}
          {draft.type === 'relation' && <>
            <label>{t('controls.targetTable')}
              <select disabled={!editor.isEditable} aria-invalid={!draft.relation?.targetDatabaseId} value={draft.relation?.targetDatabaseId ?? ''} onChange={(event) => patchDraft({ relation: { targetDatabaseId: event.target.value || null, multiple: draft.relation?.multiple ?? false } })}>
                <option value="">{t('controls.chooseTable')}</option>
                {Object.values(state.pages).filter((item) => item.kind === 'database' && item.database && !isEffectivelyTrashed(state.pages, item.id)).map((item) => <option key={item.id} value={item.id}>{displayTitle(item)}</option>)}
              </select>
            </label>
            <label className="named-data-check"><input disabled={!editor.isEditable} type="checkbox" checked={draft.relation?.multiple === true} onChange={(event) => patchDraft({ relation: { targetDatabaseId: draft.relation?.targetDatabaseId ?? null, multiple: event.target.checked } })} />{t('controls.allowMultiple')}</label>
          </>}
          <label>{t('controls.defaultValue')}
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
                    inputMode={draft.type === 'number' || draft.type === 'slider' ? 'decimal' : undefined}
                    aria-label={draft.type === 'text' && draft.textFormat === 'email' ? t('controls.textFormats.email') : undefined}
                    aria-invalid={Boolean(draftDefaultError)}
                    value={draft.type === 'number' || draft.type === 'slider'
                      ? draftDefaultNumber ?? (draft.defaultValue === null ? '' : String(draft.defaultValue))
                      : draft.defaultValue === null ? '' : String(draft.defaultValue)}
                    onChange={(event) => {
                      if (draft.type === 'number' || draft.type === 'slider') {
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
          </label>
          {(draft.type === 'number' || draft.type === 'slider') && <div className="named-data-format">
            <label>{t('controls.minimum')}<input disabled={!editor.isEditable} type="number" value={draft.format?.min ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, min: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
            <label>{t('controls.maximum')}<input disabled={!editor.isEditable} type="number" value={draft.format?.max ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, max: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
            <label>{t('controls.step')}<input disabled={!editor.isEditable} type="number" min="0.000000001" value={draft.format?.step ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, step: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
          </div>}
          {currentDraftError && <div className="named-data-diagnostic" role="status">{t('controls.currentValueInvalid')}</div>}
          {currentDraftError && <label className="named-data-check">
            <input disabled={!editor.isEditable} type="checkbox" checked={clearCurrentValue} onChange={(event) => setClearCurrentValueFor(event.target.checked ? clearCurrentValueSignature : null)} />
            {t('controls.clearCurrentValue')}
          </label>}
          {(draftDefaultError || optionError) && <div className="named-data-diagnostic" role="status">{draftDefaultError ?? optionError}</div>}
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
          {control.type === 'select' && <select disabled={!editor.isEditable} aria-label={control.name} value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value || null)}><option value="">{t('controls.blank')}</option>{control.options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
          {control.type === 'checkbox' && <input disabled={!editor.isEditable} aria-label={control.name} type="checkbox" checked={control.value === true} onChange={(event) => setValue(event.target.checked)} />}
          {control.type === 'date' && <input disabled={!editor.isEditable} aria-label={control.name} type="date" value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value)} />}
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

function outputProperty(type: OutputType, format: PropertyFormat): PropDef {
  const propType = type === 'auto' || type === 'text' ? 'formula' : type;
  const defaults: PropertyFormat = type === 'currency'
    ? { locale: 'pt-BR', currency: 'BRL', precision: 2 }
    : type === 'progress'
      ? { max: 100 }
      : ['number', 'percent'].includes(type)
        ? { locale: 'pt-BR', precision: 2 }
        : {};
  return { id: 'document-result', name: 'Result', type: propType, options: [], format: { ...defaults, ...format } };
}

export function CalculatedResultNode(props: NodeViewProps) {
  const state = useWorkspace();
  const { node, updateAttributes, deleteNode, editor } = props;
  const extensionPageId = (editor.extensionManager.extensions.find((item) => item.name === 'calculatedResult')?.options as { hostPageId?: string } | undefined)?.hostPageId;
  const pageId = String(node.attrs.pageId || extensionPageId || '');
  const resultId = String(node.attrs.resultId ?? '');
  const formula = String(node.attrs.formula ?? '');
  const bindings = (Array.isArray(node.attrs.bindings) ? node.attrs.bindings : []) as FormulaReferenceBinding[];
  const outputType = (OUTPUT_TYPES.includes(node.attrs.outputType as OutputType) ? node.attrs.outputType : 'auto') as OutputType;
  const format = (node.attrs.format && typeof node.attrs.format === 'object' ? node.attrs.format : {}) as PropertyFormat;
  const name = String(node.attrs.name ?? 'Result');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ name, formula, bindings, outputType, format });
  const [saveError, setSaveError] = useState<string | null>(null);
  const result = pageId && resultId && formula
    ? documentFormulaResult(pageId, resultId, formula, bindings, state)
    : { value: null, error: formula ? t('controls.pageMissing') : t('controls.formulaRequired') };
  let display: string | null = null;
  let diagnostic = result.error;
  const property = outputProperty(outputType, format);
  if (!diagnostic) {
    if (outputType === 'currency' || outputType === 'number' || outputType === 'percent' || outputType === 'progress') {
      if (typeof result.value !== 'number') diagnostic = t('controls.expectedNumber');
      else display = formatDisplayValue(property, result.value, getLocale());
    } else if (outputType === 'checkbox') {
      if (typeof result.value !== 'boolean') diagnostic = t('controls.expectedCheckbox');
      else display = result.value ? t('controls.checked') : t('controls.unchecked');
    } else if (outputType === 'date') {
      if (typeof result.value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(result.value)) diagnostic = t('controls.expectedDate');
      else display = formatDisplayValue(property, result.value, getLocale());
    } else {
      display = formulaValueText(property, result.value, state);
    }
  }
  const progress = outputType === 'progress' && typeof result.value === 'number' ? result.value : null;
  const referenceChoices = useMemo(() => {
    const page = state.pages[pageId];
    return [
      ...(page?.controls.map((control) => ({ key: `control:${control.id}`, name: control.name, kind: 'control' as const, id: control.id })) ?? []),
      ...collectResultNodes(editor.state.doc).filter((item) => item.resultId !== resultId).map((item) => ({ key: `result:${item.resultId}`, name: item.name, kind: 'result' as const, id: item.resultId })),
    ];
  }, [editor, pageId, resultId, state]);
  const referenceChoiceLabel = (item: (typeof referenceChoices)[number]) => {
    const foldedName = item.name.trim().toLocaleLowerCase();
    const duplicate = referenceChoices.filter((candidate) => candidate.name.trim().toLocaleLowerCase() === foldedName).length > 1;
    const label = item.kind === 'control'
      ? t('controls.referenceControl', { name: item.name })
      : t('controls.referenceResult', { name: item.name });
    return duplicate ? `${label} · ${item.id.slice(-6)}` : label;
  };

  const startEdit = () => {
    if (!editor.isEditable) return;
    setSaveError(null);
    setDraft({ name, formula, bindings, outputType, format });
    setEditing(true);
  };
  const save = () => {
    if (!editor.isEditable) return;
    setSaveError(null);
    const currentState = getState();
    const freshBindings = bindPageFormulaReferences(
      draft.formula,
      pageId,
      currentState,
      currentState.pages[pageId]?.parentId,
      draft.bindings,
    );
    const nextFormat = normalizeControlFormat(outputProperty(draft.outputType, draft.format).format);
    if (!nextFormat) {
      setSaveError(t('controls.invalidFormat'));
      return;
    }
    const nextDraft = { ...draft, bindings: freshBindings, format: nextFormat };
    updateAttributes({ ...nextDraft, pageId });
    setDraft(nextDraft);
    setEditing(false);
  };
  const insertReference = (key: string) => {
    const choice = referenceChoices.find((item) => item.key === key);
    if (!choice) return;
    const source = `\`${choice.name.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``;
    const start = draft.formula.length + (draft.formula.trim() ? 1 : 0);
    const nextFormula = `${draft.formula}${draft.formula.trim() ? ' ' : ''}${source}`;
    const binding: FormulaReferenceBinding = choice.kind === 'control'
      ? { kind: 'control', pageId, controlId: choice.id, start, end: start + source.length, source }
      : { kind: 'result', pageId, resultId: choice.id, start, end: start + source.length, source };
    setDraft({ ...draft, formula: nextFormula, bindings: [...draft.bindings, binding] });
  };
  const updateFormat = (change: Partial<PropertyFormat>) => setDraft({ ...draft, format: { ...draft.format, ...change } });

  return (
    <NodeViewWrapper as="span" className={`named-data-result${diagnostic ? ' has-error' : ''}`} contentEditable={false} onMouseDown={stop} title={diagnostic ?? undefined}>
      {editing ? <span className="named-data-popover named-data-result-editor" role="group" aria-label={t('controls.configureResult')}>
        <label>{t('controls.name')}<input value={draft.name} maxLength={100} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>{t('controls.formula')}<textarea maxLength={2000} rows={3} value={draft.formula} placeholder={t('controls.formulaPlaceholder')} onChange={(event) => setDraft({ ...draft, formula: event.target.value, bindings: draft.bindings.filter((binding) => event.target.value.slice(binding.start, binding.end) === binding.source) })} /></label>
        <label>{t('controls.insertReference')}<select defaultValue="" onChange={(event) => { insertReference(event.target.value); event.target.value = ''; }}><option value="">{t('controls.chooseReference')}</option>{referenceChoices.map((item) => <option key={item.key} value={item.key}>{referenceChoiceLabel(item)}</option>)}</select></label>
        <label>{t('controls.outputType')}<select value={draft.outputType} onChange={(event) => setDraft({ ...draft, outputType: event.target.value as OutputType })}>{OUTPUT_TYPES.map((item) => <option key={item} value={item}>{t(`controls.outputTypes.${item}` as never)}</option>)}</select></label>
        {(draft.outputType === 'currency' || draft.outputType === 'percent' || draft.outputType === 'number' || draft.outputType === 'progress') && <div className="named-data-format">
          {draft.outputType === 'currency' && <label>{t('controls.currency')}<input value={draft.format.currency ?? 'BRL'} maxLength={3} onChange={(event) => updateFormat({ currency: event.target.value.toUpperCase() })} /></label>}
          <label>{t('controls.locale')}<input value={draft.format.locale ?? 'pt-BR'} onChange={(event) => updateFormat({ locale: event.target.value })} /></label>
          {draft.outputType !== 'progress' && <label>{t('controls.precision')}<input type="number" min="0" max="8" value={draft.format.precision ?? 2} onChange={(event) => updateFormat({ precision: Number(event.target.value) })} /></label>}
          {draft.outputType === 'progress' && <label>{t('controls.maximum')}<input type="number" min="0.000000001" value={draft.format.max ?? 100} onChange={(event) => updateFormat({ max: Number(event.target.value) })} /></label>}
        </div>}
        {(saveError || diagnostic) && <div className="named-data-diagnostic">{saveError ?? diagnostic}</div>}
        <div className="named-data-actions"><button type="button" onClick={save}>{t('controls.save')}</button><button type="button" onClick={() => setEditing(false)}>{t('controls.cancel')}</button><button type="button" onClick={() => editor.isEditable && deleteNode()}>{t('controls.deleteResult')}</button></div>
      </span> : <span className="named-data-result-line">
        <span className="named-data-result-name">{name}</span>
        <span className="named-data-result-value" aria-live="polite">{diagnostic ? t('controls.calculationError') : display === '' || display === null ? '—' : display}</span>
        {progress !== null && !diagnostic && <progress max={typeof format.max === 'number' && format.max > 0 ? format.max : 100} value={progress} aria-label={name} />}
        {diagnostic && <span className="named-data-diagnostic">{diagnostic}</span>}
        {editor.isEditable && <button type="button" className="named-data-configure" aria-label={t('controls.configureResult')} onClick={startEdit}>⚙</button>}
      </span>}
    </NodeViewWrapper>
  );
}
