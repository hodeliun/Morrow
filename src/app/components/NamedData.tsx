import { useMemo, useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { bindPageFormulaReferences, documentFormulaResult, formatDisplayValue, formulaValueText } from '../../core/database';
import type { FormulaReferenceBinding, NamedControlDef, NamedControlType, PropDef, PropValue, PropertyFormat } from '../../core/model';
import { displayTitle } from '../../core/model';
import { controlValueError, controlValueErrorInState, normalizeControlFormat } from '../../core/controls';
import { childrenOf, isEffectivelyTrashed } from '../../core/tree';
import { newId } from '../platform/files';
import { commitEditors } from '../editor/commits';
import { getState, run, useWorkspace } from '../workspace';
import { getLocale, t } from '../i18n';

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
  }
}

function optionsFromText(text: string, existing: NamedControlDef['options']): NamedControlDef['options'] {
  const used = new Set<string>();
  return text.split('\n').map((name) => name.trim()).filter(Boolean).slice(0, 100).map((name, index) => {
    const old = existing.find((option) => option.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    const samePosition = existing[index];
    const preserved = old ?? (samePosition && !used.has(samePosition.id) ? samePosition : null);
    const option = preserved ? { ...preserved, name } : { id: newId(), name, color: 'gray' as const };
    used.add(option.id);
    return option;
  });
}

export function NamedControlNode(props: NodeViewProps) {
  const state = useWorkspace();
  const { node, updateAttributes, editor } = props;
  const extensionPageId = (editor.extensionManager.extensions.find((item) => item.name === 'namedControl')?.options as { hostPageId?: string } | undefined)?.hostPageId;
  const pageId = String(node.attrs.pageId || extensionPageId || '');
  const controlId = String(node.attrs.controlId ?? '');
  const page = state.pages[pageId];
  const control = page?.controls.find((item) => item.id === controlId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<NamedControlDef | null>(null);
  const [optionsText, setOptionsText] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const target = control?.relation?.targetDatabaseId ? state.pages[control.relation.targetDatabaseId] : null;
  const relatedRows = target?.kind === 'database' && target.database && !isEffectivelyTrashed(state.pages, target.id)
    ? childrenOf(state.pages, target.id)
    : [];
  const valueError = control ? controlValueError(control, control.value) : null;
  const relationStateError = control && !valueError && controlValueErrorInState(control, control.value, state);

  const setValue = (value: PropValue) => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    run({ type: 'page.control.setValue', id: page.id, controlId: control.id, value, now: Date.now() });
  };
  const startEdit = () => {
    if (!editor.isEditable) return;
    setSaveError(null);
    if (!control) {
      setDraft({
        id: controlId,
        name: String(node.attrs.label ?? 'Control'),
        type: 'text',
        value: '',
        defaultValue: '',
        options: [],
      });
    } else setDraft({ ...control, options: control.options.map((item) => ({ ...item })), relation: control.relation ? { ...control.relation } : undefined });
    setOptionsText(control?.options.map((item) => item.name).join('\n') ?? '');
    setEditing(true);
  };
  const patchDraft = (change: Partial<NamedControlDef>) => setDraft((current) => current ? { ...current, ...change } : current);
  const save = () => {
    if (!editor.isEditable || !page || !draft) return;
    setSaveError(null);
    commitEditors();
    const options = draft.type === 'select' ? optionsFromText(optionsText, draft.options) : draft.options;
    const currentValue = options.some((item) => item.id === draft.value) ? draft.value : (options[0]?.id ?? null);
    const defaultValue = options.some((item) => item.id === draft.defaultValue) ? draft.defaultValue : (options[0]?.id ?? null);
    const nextDraft = { ...draft, options, ...(draft.type === 'select' ? { value: currentValue, defaultValue } : {}) };
    const saved = run({ type: 'page.control.configure', id: page.id, control: nextDraft, now: Date.now() });
    if (!saved.ok) {
      setSaveError(saved.error);
      return;
    }
    updateAttributes({ pageId, controlId, label: nextDraft.name });
    setEditing(false);
  };
  const removeDefinition = () => {
    if (!editor.isEditable || !page || !control) return;
    commitEditors();
    const removed = run({ type: 'page.control.delete', id: page.id, controlId, now: Date.now() });
    if (removed.ok) setEditing(false);
  };

  return (
    <NodeViewWrapper as="span" className="named-data-control" contentEditable={false} onMouseDown={stop}>
      {editing && draft ? (
        <span className="named-data-popover" role="group" aria-label={t('controls.configureControl')}>
          <label>{t('controls.name')}<input value={draft.name} maxLength={100} onChange={(event) => patchDraft({ name: event.target.value })} /></label>
          <label>{t('controls.type')}
            <select value={draft.type} onChange={(event) => {
              const type = event.target.value as NamedControlType;
              const options = type === 'select' ? (draft.options.length ? draft.options : [{ id: newId(), name: 'Option 1', color: 'gray' as const }]) : draft.options;
              setOptionsText(options.map((item) => item.name).join('\n'));
              const relation = type === 'relation' ? (draft.relation ?? { targetDatabaseId: null, multiple: false }) : draft.relation;
              const multiple = relation?.multiple ?? false;
              const value = defaultFor(type, options, multiple);
              patchDraft({ type, options, relation, value, defaultValue: value });
            }}>
              {CONTROL_TYPES.map((type) => <option value={type} key={type}>{t(`controls.types.${type}` as never)}</option>)}
            </select>
          </label>
          {draft.type === 'select' && <label>{t('controls.options')}
            <textarea rows={3} value={optionsText} onChange={(event) => setOptionsText(event.target.value)} />
          </label>}
          {draft.type === 'relation' && <>
            <label>{t('controls.targetTable')}
              <select value={draft.relation?.targetDatabaseId ?? ''} onChange={(event) => patchDraft({ relation: { targetDatabaseId: event.target.value || null, multiple: draft.relation?.multiple ?? false } })}>
                <option value="">{t('controls.chooseTable')}</option>
                {Object.values(state.pages).filter((item) => item.kind === 'database' && item.database && !isEffectivelyTrashed(state.pages, item.id)).map((item) => <option key={item.id} value={item.id}>{displayTitle(item)}</option>)}
              </select>
            </label>
            <label className="named-data-check"><input type="checkbox" checked={draft.relation?.multiple === true} onChange={(event) => patchDraft({ relation: { targetDatabaseId: draft.relation?.targetDatabaseId ?? null, multiple: event.target.checked } })} />{t('controls.allowMultiple')}</label>
          </>}
          <label>{t('controls.defaultValue')}
            {draft.type === 'checkbox' ? <input type="checkbox" checked={draft.defaultValue === true} onChange={(event) => patchDraft({ defaultValue: event.target.checked, value: draft.value })} /> :
              draft.type === 'select' ? <select value={typeof draft.defaultValue === 'string' ? draft.defaultValue : ''} onChange={(event) => patchDraft({ defaultValue: event.target.value || null })}><option value="">{t('controls.blank')}</option>{draft.options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select> :
                draft.type === 'relation' ? <span className="named-data-muted">{t('controls.setDefaultInValue')}</span> :
                  <input type={draft.type === 'date' ? 'date' : draft.type === 'number' || draft.type === 'slider' ? 'number' : 'text'} value={draft.defaultValue === null ? '' : String(draft.defaultValue)} onChange={(event) => {
                    const value = draft.type === 'number' || draft.type === 'slider' ? (event.target.value === '' ? null : Number(event.target.value)) : event.target.value;
                    patchDraft({ defaultValue: value });
                  }} />}
          </label>
          {(draft.type === 'number' || draft.type === 'slider') && <div className="named-data-format">
            <label>{t('controls.minimum')}<input type="number" value={draft.format?.min ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, min: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
            <label>{t('controls.maximum')}<input type="number" value={draft.format?.max ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, max: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
            <label>{t('controls.step')}<input type="number" min="0.000000001" value={draft.format?.step ?? ''} onChange={(event) => patchDraft({ format: { ...draft.format, step: event.target.value === '' ? undefined : Number(event.target.value) } })} /></label>
          </div>}
          {saveError && <div className="named-data-diagnostic">{saveError}</div>}
          <div className="named-data-actions">
            <button type="button" onClick={save}>{t('controls.save')}</button>
            {control && <button type="button" onClick={removeDefinition}>{t('controls.deleteControl')}</button>}
            <button type="button" onClick={() => setEditing(false)}>{t('controls.cancel')}</button>
          </div>
        </span>
      ) : !control ? (
        <span className="named-data-missing" title={t('controls.deletedDiagnostic')}>{t('controls.missingControl', { name: String(node.attrs.label ?? controlId) })}
          <button type="button" onClick={startEdit}>{t('controls.recreate')}</button>
        </span>
      ) : (
        <span className="named-data-control-line">
          <span className="named-data-label">{control.name}</span>
          {control.type === 'text' && <input disabled={!editor.isEditable} aria-label={control.name} type="text" value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value)} />}
          {control.type === 'number' && <input disabled={!editor.isEditable} aria-label={control.name} type="number" value={typeof control.value === 'number' ? control.value : ''} min={control.format?.min} max={control.format?.max} step={control.format?.step ?? 'any'} onChange={(event) => setValue(event.target.value === '' ? null : Number(event.target.value))} />}
          {control.type === 'slider' && <input disabled={!editor.isEditable} aria-label={control.name} type="range" value={typeof control.value === 'number' ? control.value : (control.format?.min ?? 0)} min={control.format?.min ?? 0} max={control.format?.max ?? 100} step={control.format?.step ?? 1} onChange={(event) => setValue(Number(event.target.value))} />}
          {control.type === 'select' && <select disabled={!editor.isEditable} aria-label={control.name} value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value || null)}><option value="">{t('controls.blank')}</option>{control.options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>}
          {control.type === 'checkbox' && <input disabled={!editor.isEditable} aria-label={control.name} type="checkbox" checked={control.value === true} onChange={(event) => setValue(event.target.checked)} />}
          {control.type === 'date' && <input disabled={!editor.isEditable} aria-label={control.name} type="date" value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value)} />}
          {control.type === 'relation' && control.relation?.multiple && <select disabled={!editor.isEditable} aria-label={control.name} multiple value={Array.isArray(control.value) ? control.value : []} onChange={(event) => setValue(Array.from(event.target.selectedOptions).map((item) => item.value))}>{relatedRows.map((row) => <option key={row.id} value={row.id}>{displayTitle(row)}</option>)}</select>}
          {control.type === 'relation' && !control.relation?.multiple && <select disabled={!editor.isEditable} aria-label={control.name} value={typeof control.value === 'string' ? control.value : ''} onChange={(event) => setValue(event.target.value || null)}><option value="">{t('controls.blank')}</option>{relatedRows.map((row) => <option key={row.id} value={row.id}>{displayTitle(row)}</option>)}</select>}
          {editor.isEditable && <button type="button" className="named-data-configure" aria-label={t('controls.configureControl')} onClick={startEdit}>⚙</button>}
          {(valueError || relationStateError) && <span className="named-data-diagnostic">{valueError ?? t('controls.relationUnavailable')}</span>}
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
