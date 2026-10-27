import { useState } from 'react';
import { bindFormulaReferences } from '../../../core/database';
import { COLORS } from '../../../core/model';
import type {
  ActionFormulaDef,
  TableActionDef,
  DatabaseDef,
  PageId,
  PropDef,
  TableActionIcon,
  TableActionStep,
} from '../../../core/model';
import { isComputedProperty } from '../../../core/typedValues';
import { newId } from '../../platform/files';
import { t } from '../../i18n';
import { colorLabel } from '../../i18n/labels';
import { updateProp } from './data';
import { useWorkspace } from '../../workspace';

const icons: TableActionIcon[] = ['play', 'plus', 'check', 'refresh'];

export function ButtonActionSettings({
  dbId,
  prop,
  database,
}: {
  dbId: PageId;
  prop: PropDef;
  database: DatabaseDef;
}) {
  const state = useWorkspace();
  const action = prop.action ?? defaultAction(prop.name);
  const editableProperties = database.properties.filter(
    (item) => item.type !== 'button' && !isComputedProperty(item) && !item.relation?.isInverse,
  );

  const updateAction = (change: (current: TableActionDef) => TableActionDef) => {
    updateProp(dbId, prop.id, (current) => ({
      ...current,
      action: change(current.action ?? defaultAction(current.name)),
    }));
  };
  const saveFormula = (formula: ActionFormulaDef, source: string): ActionFormulaDef => ({
    source,
    bindings: bindFormulaReferences(source, dbId, state, formula.bindings),
  });
  const updateFormula = (
    current: ActionFormulaDef | undefined,
    source: string,
    set: (action: TableActionDef, formula: ActionFormulaDef | undefined) => TableActionDef,
  ) =>
    updateAction((currentAction) =>
      set(currentAction, source.trim() ? saveFormula(current ?? emptyFormula(), source) : undefined),
    );

  const updateStep = (stepId: string, change: (step: TableActionStep) => TableActionStep) =>
    updateAction((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === stepId ? change(step) : step)),
    }));
  const setStepFormula = (step: TableActionStep, key: 'count' | 'title' | 'where', source: string) => {
    if (step.type === 'resetControls') return;
    if (key === 'where' && step.type !== 'modifyRows') return;
    if (key !== 'where' && step.type !== 'addRows') return;
    const existing =
      step.type === 'addRows'
        ? key === 'count'
          ? step.count
          : key === 'title'
            ? step.title
            : undefined
        : key === 'where'
          ? step.where
          : undefined;
    const next = source.trim() ? saveFormula(existing ?? emptyFormula(), source) : undefined;
    updateStep(step.id, (current) => {
      if (current.type === 'addRows' && (key === 'count' || key === 'title'))
        return { ...current, [key]: next ?? emptyFormula() };
      if (current.type === 'modifyRows' && key === 'where') {
        const { where: _old, ...rest } = current;
        return next ? { ...rest, where: next } : rest;
      }
      return current;
    });
  };
  const setValueFormula = (stepId: string, propertyId: string, source: string) => {
    updateStep(stepId, (step) => {
      if (step.type === 'resetControls') return step;
      const values = { ...step.values };
      const current = values[propertyId];
      if (source.trim()) values[propertyId] = saveFormula(current ?? emptyFormula(), source);
      else delete values[propertyId];
      return { ...step, values };
    });
  };

  const addStep = (type: TableActionStep['type']) => {
    if (action.steps.length >= 12) return;
    const id = newId();
    const step: TableActionStep =
      type === 'addRows'
        ? { id, type, count: { source: '1', bindings: [] }, title: emptyFormula(), values: {} }
        : type === 'modifyRows'
          ? { id, type, target: 'currentRow', values: {} }
          : { id, type, controlIds: [] };
    updateAction((current) => ({ ...current, steps: [...current.steps, step] }));
  };
  const moveStep = (index: number, direction: -1 | 1) =>
    updateAction((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target]!, steps[index]!];
      return { ...current, steps };
    });
  const removeStep = (stepId: string) =>
    updateAction((current) => ({ ...current, steps: current.steps.filter((step) => step.id !== stepId) }));

  return (
    <section className="table-action-settings" aria-label={t('database.actionSettings')}>
      <p className="db-panel-heading">{t('database.actionSettings')}</p>
      <label className="field">
        <span>{t('database.actionLabel')}</span>
        <input
          className="text-input small"
          aria-label={t('database.actionLabel')}
          value={action.label}
          maxLength={100}
          onChange={(event) =>
            updateAction((current) => ({
              ...current,
              label: event.target.value.trim() ? event.target.value : prop.name,
            }))
          }
        />
      </label>
      <div className="field-inline">
        <label className="field">
          <span>{t('database.actionIcon')}</span>
          <select
            className="text-input small"
            aria-label={t('database.actionIcon')}
            value={action.icon}
            onChange={(event) =>
              updateAction((current) => ({ ...current, icon: event.target.value as TableActionIcon }))
            }
          >
            {icons.map((icon) => (
              <option key={icon} value={icon}>
                {icon}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('database.actionColor')}</span>
          <select
            className="text-input small"
            aria-label={t('database.actionColor')}
            value={action.color}
            onChange={(event) =>
              updateAction((current) => ({
                ...current,
                color: event.target.value as TableActionDef['color'],
              }))
            }
          >
            {COLORS.map((color) => (
              <option key={color} value={color}>
                {colorLabel(color)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FormulaEditor
        label={t('database.actionDisabledCondition')}
        help={t('database.actionFormulaHint')}
        formula={action.disabled ?? emptyFormula()}
        onCommit={(source) =>
          updateFormula(action.disabled, source, (current, formula) => {
            const { disabled: _old, ...rest } = current;
            return formula ? { ...rest, disabled: formula } : rest;
          })
        }
      />

      <div className="table-action-step-heading">
        <span>{t('database.actionSteps')}</span>
        <div>
          <button
            type="button"
            className="button small"
            disabled={action.steps.length >= 12}
            onClick={() => addStep('addRows')}
          >
            {t('database.actionAddRowStep')}
          </button>
          <button
            type="button"
            className="button small"
            disabled={action.steps.length >= 12}
            onClick={() => addStep('modifyRows')}
          >
            {t('database.actionModifyRowsStep')}
          </button>
          <button
            type="button"
            className="button small"
            disabled={action.steps.length >= 12}
            onClick={() => addStep('resetControls')}
          >
            {t('database.actionResetControlsStep')}
          </button>
        </div>
      </div>
      {action.steps.length === 0 && <p className="muted small">{t('database.actionNoSteps')}</p>}
      <ol className="table-action-steps">
        {action.steps.map((step, index) => (
          <li key={step.id} className="table-action-step">
            <div className="table-action-step-title">
              <strong>{t('database.actionStepName', { index: index + 1 })}</strong>
              <div>
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t('database.actionMoveStepUp')}
                  disabled={index === 0}
                  onClick={() => moveStep(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t('database.actionMoveStepDown')}
                  disabled={index === action.steps.length - 1}
                  onClick={() => moveStep(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="icon-button tiny"
                  aria-label={t('database.actionRemoveStep')}
                  onClick={() => removeStep(step.id)}
                >
                  ×
                </button>
              </div>
            </div>
            {step.type === 'addRows' && (
              <>
                <FormulaEditor
                  label={t('database.actionRowsCount')}
                  help={t('database.actionFormulaHint')}
                  formula={step.count}
                  onCommit={(source) => setStepFormula(step, 'count', source)}
                />
                <FormulaEditor
                  label={t('database.actionTitleFormula')}
                  help={t('database.actionFormulaHint')}
                  formula={step.title}
                  onCommit={(source) => setStepFormula(step, 'title', source)}
                />
                <p className="db-panel-heading">{t('database.actionValues')}</p>
                {editableProperties.map((property) => (
                  <FormulaEditor
                    key={property.id}
                    label={property.name}
                    help={t('database.actionFormulaHint')}
                    formula={step.values[property.id] ?? emptyFormula()}
                    onCommit={(source) => setValueFormula(step.id, property.id, source)}
                  />
                ))}
                {Object.entries(step.values)
                  .filter(
                    ([propertyId]) => !editableProperties.some((property) => property.id === propertyId),
                  )
                  .map(([propertyId, value]) => (
                    <FormulaEditor
                      key={propertyId}
                      label={t('database.actionUnavailableColumn', { id: propertyId })}
                      help={t('database.actionFormulaHint')}
                      formula={value}
                      onCommit={(source) => setValueFormula(step.id, propertyId, source)}
                    />
                  ))}
              </>
            )}
            {step.type === 'modifyRows' && (
              <>
                <label className="field">
                  <span>{t('database.actionModifyTarget')}</span>
                  <select
                    className="text-input small"
                    aria-label={t('database.actionModifyTarget')}
                    value={step.target}
                    onChange={(event) =>
                      updateStep(step.id, (current) =>
                        current.type === 'modifyRows'
                          ? { ...current, target: event.target.value as 'currentRow' | 'matchingRows' }
                          : current,
                      )
                    }
                  >
                    <option value="currentRow">{t('database.actionCurrentRow')}</option>
                    <option value="matchingRows">{t('database.actionMatchingRows')}</option>
                  </select>
                </label>
                {step.target === 'matchingRows' && (
                  <FormulaEditor
                    label={t('database.actionMatchingFormula')}
                    help={t('database.actionFormulaHint')}
                    formula={step.where ?? emptyFormula()}
                    onCommit={(source) => setStepFormula(step, 'where', source)}
                  />
                )}
                <p className="db-panel-heading">{t('database.actionValues')}</p>
                {editableProperties.map((property) => (
                  <FormulaEditor
                    key={property.id}
                    label={property.name}
                    help={t('database.actionFormulaHint')}
                    formula={step.values[property.id] ?? emptyFormula()}
                    onCommit={(source) => setValueFormula(step.id, property.id, source)}
                  />
                ))}
                {Object.entries(step.values)
                  .filter(
                    ([propertyId]) => !editableProperties.some((property) => property.id === propertyId),
                  )
                  .map(([propertyId, value]) => (
                    <FormulaEditor
                      key={propertyId}
                      label={t('database.actionUnavailableColumn', { id: propertyId })}
                      help={t('database.actionFormulaHint')}
                      formula={value}
                      onCommit={(source) => setValueFormula(step.id, propertyId, source)}
                    />
                  ))}
              </>
            )}
            {step.type === 'resetControls' && (
              <fieldset className="table-action-control-list">
                <legend>{t('database.actionControls')}</legend>
                {state.pages[dbId]?.controls.length ? (
                  state.pages[dbId]!.controls.map((control) => (
                    <label key={control.id}>
                      <input
                        type="checkbox"
                        checked={step.controlIds.includes(control.id)}
                        onChange={(event) =>
                          updateStep(step.id, (current) =>
                            current.type === 'resetControls'
                              ? {
                                  ...current,
                                  controlIds: event.target.checked
                                    ? [...current.controlIds, control.id]
                                    : current.controlIds.filter((id) => id !== control.id),
                                }
                              : current,
                          )
                        }
                      />
                      {control.name}
                    </label>
                  ))
                ) : (
                  <span className="muted small">{t('database.actionNoControls')}</span>
                )}
              </fieldset>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function FormulaEditor({
  label,
  help,
  formula,
  onCommit,
}: {
  label: string;
  help: string;
  formula: ActionFormulaDef;
  onCommit: (source: string) => void;
}) {
  const [draftState, setDraftState] = useState({ source: formula.source, propSource: formula.source });
  const draft = draftState.propSource === formula.source ? draftState.source : formula.source;
  return (
    <label className="field table-action-formula">
      <span>{label}</span>
      <textarea
        className="text-input small"
        aria-label={label}
        rows={2}
        value={draft}
        onChange={(event) => setDraftState({ source: event.target.value, propSource: formula.source })}
        onBlur={() => draft !== formula.source && onCommit(draft)}
      />
      <small className="muted">{help}</small>
    </label>
  );
}

function defaultAction(label: string): TableActionDef {
  return { label: label || t('database.typeButton'), icon: 'play', color: 'blue', steps: [] };
}

function emptyFormula(): ActionFormulaDef {
  return { source: '', bindings: [] };
}
