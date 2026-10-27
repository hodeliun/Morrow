import { ArrowDown, ArrowUp, EyeOff, Trash2, X } from 'lucide-react';
import { useContext, useState } from 'react';
import type { Command } from '../../../core/commands';
import {
  filterOpsFor,
  formatValue,
  moveSelectOption,
  optionsFromValues,
  rowsOf,
  tryConvertValue,
} from '../../../core/database';
import { COLORS, PROP_TYPES } from '../../../core/model';
import { isMediaProperty } from '../../../core/propertyMedia';
import type {
  ColorName,
  DatabaseDef,
  FilterOp,
  FilterRule,
  PageId,
  PageMeta,
  PropDef,
  PropType,
  PropValue,
  PropertyFormat,
  RelationConfig,
  ViewDef,
} from '../../../core/model';
import { displayTitle } from '../../../core/model';
import {
  relationDiagnostics,
  relationConfig,
  relationDisplayLabel,
  resolveRelationReference,
} from '../../../core/relations';
import { isEffectivelyTrashed } from '../../../core/tree';
import { reservedPropertyName } from '../../../core/vault/pageFile';
import { newId } from '../../platform/files';
import { toast } from '../../ui';
import { run, runAll, useWorkspace } from '../../workspace';
import { Popover } from '../Popover';
import { Select } from '../Select';
import { updateDatabase, updateProp, updateView } from './data';
import { DraftInput, RelationPicker } from './PropertyValue';
import { t } from '../../i18n';
import { colorLabel, filterLabel, propLabel } from '../../i18n/labels';
import { durationUnitFactor, isNumericPropertyType } from '../../../core/typedValues';
import { MediaPropertyDefault, MediaPropertyOptions } from './MediaProperty';
import { ViewChangeContext } from './viewContext';
import { linkedViewReferences, viewUsesProperty } from '../../../core/linkedViews';
import { ButtonActionSettings } from './ButtonActionSettings';
import { FormulaEditor } from './FormulaEditor';

// rename a property, change its type, options or how it shows. opened from a column, or from a page's
// properties, where there is no view to sort or hide in
export function PropertySettings({
  dbId,
  database,
  prop: opened,
  view,
  anchor,
  onClose,
  focusSection,
}: {
  dbId: PageId;
  database: DatabaseDef;
  prop: PropDef;
  view?: ViewDef;
  anchor: HTMLElement;
  onClose: () => void;
  focusSection?: 'formula';
}) {
  const state = useWorkspace();
  const linkedUpdate = useContext(ViewChangeContext);
  const saveView = (change: (current: ViewDef) => ViewDef) =>
    linkedUpdate ? linkedUpdate(change) : view && updateView(dbId, view.id, change);
  const removeProperty = () => {
    const linkedUse = linkedViewReferences(state, dbId).find(
      (reference) => reference.view && viewUsesProperty(reference.view, prop.id),
    );
    if (linkedUse) {
      toast(
        t('database.columnUsedByLinkedView', { name: linkedUse.view?.name || t('database.linkedView') }),
        { tone: 'error' },
      );
      return;
    }
    const dependentFormula = Object.values(state.pages)
      .flatMap(
        (owner) => owner.database?.properties.map((candidate) => ({ ownerId: owner.id, candidate })) ?? [],
      )
      .find(
        ({ ownerId, candidate }) =>
          (ownerId !== dbId || candidate.id !== prop.id) &&
          [...(candidate.formulaBindings ?? []), ...(candidate.defaultFormulaBindings ?? [])].some(
            (binding) => binding.kind === 'property' && binding.databaseId === dbId && binding.propertyId === prop.id,
          ),
      )?.candidate;
    if (dependentFormula) {
      toast(t('database.columnUsedByFormula', { name: dependentFormula.name }), { tone: 'error' });
      return;
    }
    const removed = updateDatabase(dbId, (current) => ({
      ...current,
      properties: current.properties.filter((item) => item.id !== prop.id),
      views: current.views.map((item) => removePropertyFromView(item, prop.id)),
    }));
    if (removed) onClose();
  };
  // the panel stays open while the property changes, so it reads the latest version of it
  const prop = database.properties.find((item) => item.id === opened.id) ?? opened;
  const changeType = (type: PropType, now: number) => {
    if (type === prop.type) return;
    const rows = rowsOf(state, dbId);
    const options =
      type === 'select' || type === 'multiSelect'
        ? prop.type === 'select' || prop.type === 'multiSelect'
          ? prop.options
          : optionsFromValues(
              prop,
              rows.map((row) => row.properties[prop.id] ?? null),
              newId,
            )
        : [];
    let next: PropDef = { ...prop, type, options };
    if (type === 'button') {
      const {
        formula: _formula,
        formulaBindings: _formulaBindings,
        defaultFormula: _defaultFormula,
        defaultFormulaBindings: _defaultFormulaBindings,
        defaultValue: _defaultValue,
        display: _display,
        max: _max,
        media: _media,
        ...rest
      } = prop;
      next = {
        ...rest,
        type,
        options: [],
        fillMode: 'manual',
        action: { label: prop.name, icon: 'play', color: 'blue', steps: [] },
      };
    } else if (prop.type === 'button') {
      const { action: _action, ...rest } = next;
      next = {
        ...rest,
        ...(type === 'image' || type === 'file' ? { media: { multiple: false } } : {}),
      };
    } else if (isMediaProperty(type)) {
      const { formula: _formula, defaultFormula: _defaultFormula, media: _media, ...rest } = next;
      next = {
        ...rest,
        type,
        options: [],
        fillMode: prop.fillMode === 'default' ? 'default' : 'manual',
        ...(type === 'image' || type === 'file'
          ? { media: { multiple: prop.media?.multiple === true } }
          : {}),
      };
    } else if (prop.type === 'image' || prop.type === 'file') {
      const { media: _media, ...rest } = next;
      next = rest;
    }
    if (!isNumericPropertyType(type) && next.defaultSequence) {
      const { defaultSequence: _defaultSequence, ...rest } = next;
      next = rest;
    }
    const conversions = rows.map((row) => ({
      row,
      result:
        type === 'button'
          ? { ok: true as const, value: null }
          : tryConvertValue(prop, next, row.properties[prop.id] ?? null),
    }));
    const failed = conversions.find((item) => !item.result.ok);
    if (failed && !failed.result.ok) {
      toast(`${displayTitle(failed.row)}: ${failed.result.error}`, { tone: 'error' });
      return;
    }
    if (type !== 'button' && Object.prototype.hasOwnProperty.call(prop, 'defaultValue')) {
      const converted = tryConvertValue(prop, next, prop.defaultValue ?? null);
      if (!converted.ok) {
        toast(`${t('database.defaultValue')}: ${converted.error}`, { tone: 'error' });
        return;
      }
      next.defaultValue = converted.value;
    }
    const commands: Command[] = [
      {
        type: 'database.set',
        id: dbId,
        now,
        database: {
          ...database,
          properties: database.properties.map((item) => (item.id === prop.id ? next : item)),
        },
      },
      ...conversions.map<Command>(({ row, result }) => ({
        type: 'page.setProperties',
        id: row.id,
        now,
        values: { [prop.id]: result.ok ? result.value : null },
      })),
    ];
    runAll(commands);
  };
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      label={t('database.propertyAria', { name: prop.name })}
      className={`db-panel${prop.type === 'formula' || prop.type === 'relation' || prop.type === 'button' ? ' is-wide' : ''}`}
    >
      <label className="field">
        <span>{t('database.name')}</span>
        <DraftInput
          type="text"
          label={t('page.propertyNamePlaceholder')}
          className="text-input small"
          value={prop.name}
          editable
          onCommit={(name) => {
            const clean = name.trim();
            if (
              !clean ||
              reservedPropertyName(clean) ||
              database.properties.some(
                (item) => item.id !== prop.id && item.name.toLowerCase() === clean.toLowerCase(),
              )
            ) {
              toast(t('toasts.propNameEmptyOrUsed'), { tone: 'error' });
              return;
            }
            updateProp(dbId, prop.id, (current) => ({ ...current, name: clean }));
          }}
        />
      </label>
      <div className="field">
        <span>{t('database.type')}</span>
        <Select<PropType>
          label={t('database.type')}
          value={prop.type}
          options={PROP_TYPES.map((item) => ({ value: item, label: propLabel(item) }))}
          onChange={(type) => changeType(type, Date.now())}
        />
      </div>
      {focusSection === 'formula' && prop.type !== 'formula' && prop.fillMode !== 'calculated' &&
        prop.type !== 'button' && prop.type !== 'createdTime' && prop.type !== 'lastEditedTime' &&
        !isMediaProperty(prop.type) && (
          <button type="button" className="button small" data-autofocus
            onClick={() => setFillMode(dbId, prop, 'calculated')}>
            {t('database.enableColumnFormula')}
          </button>
        )}
      <label className="field">
        <span>{t('database.description')}</span>
        <DraftInput
          type="text"
          label={t('database.description')}
          className="text-input small"
          value={prop.description ?? ''}
          editable
          onCommit={(description) =>
            updateProp(dbId, prop.id, (current) => ({ ...current, description: description || undefined }))
          }
        />
      </label>
      {prop.type === 'button' && <ButtonActionSettings dbId={dbId} prop={prop} database={database} />}
      {prop.type !== 'button' && prop.type !== 'formula' && prop.type !== 'createdTime' && prop.type !== 'lastEditedTime' && (
        <div className="field">
          <span>{t('database.fillMode')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('database.fillMode')}>
            {(['manual', 'default', 'calculated'] as const)
              .filter((mode) => !isMediaProperty(prop.type) || mode !== 'calculated')
              .map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={(prop.fillMode ?? 'manual') === mode}
                  className={(prop.fillMode ?? 'manual') === mode ? 'is-active' : ''}
                  onClick={() => setFillMode(dbId, prop, mode)}
                >
                  {t(mode === 'default' ? 'database.defaultMode' : `database.${mode}`)}
                </button>
              ))}
          </div>
        </div>
      )}
      {prop.fillMode === 'default' && (
        <div className="field">
          {isMediaProperty(prop.type) ? (
            <MediaPropertyDefault prop={prop} dbId={dbId} />
          ) : (
            <>
              <span>{t('database.defaultSource')}</span>
              <div className="segmented" role="radiogroup" aria-label={t('database.defaultSource')}>
                {(['literal', 'formula', ...(isNumericPropertyType(prop.type) ? ['sequence' as const] : [])] as const).map((source) => {
                  const selected =
                    source === 'formula'
                      ? prop.defaultFormula !== undefined
                      : source === 'sequence'
                        ? prop.defaultSequence !== undefined
                        : prop.defaultFormula === undefined && prop.defaultSequence === undefined;
                  return (
                    <button
                      key={source}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={selected ? 'is-active' : ''}
                      onClick={() => setDefaultSource(dbId, prop, source)}
                    >
                      {t(source === 'formula' ? 'database.typeFormula' : source === 'sequence' ? 'database.sequence' : 'database.literal')}
                    </button>
                  );
                })}
              </div>
              {prop.defaultSequence ? (
                <DefaultSequenceFields dbId={dbId} prop={prop} />
              ) : prop.defaultFormula === undefined ? (
                <DefaultValueField dbId={dbId} prop={prop} />
              ) : (
                <FormulaEditor dbId={dbId} prop={prop} database={database} defaultFormula />
              )}
            </>
          )}
        </div>
      )}
      {(prop.fillMode === 'calculated' || prop.type === 'formula') && (
        <FormulaEditor dbId={dbId} prop={prop} database={database} autoFocus={focusSection === 'formula'} />
      )}
      {prop.type !== 'button' && <PropertyFormatSettings key={`${prop.id}:${prop.type}`} dbId={dbId} prop={prop} />}
      {isMediaProperty(prop.type) && <MediaPropertyOptions prop={prop} dbId={dbId} rows={rowsOf(state, dbId)} />}
      {(
        ['number', 'currency', 'percent', 'slider', 'progress', 'scale', 'duration', 'formula'] as PropType[]
      ).includes(prop.type) && (
        <div className="field">
          <span>{t('database.showAs')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('database.showAs')}>
            {(
              [
                [undefined, t('database.typeNumber')],
                ['bar', t('database.progressBar')],
              ] as const
            ).map(([display, label]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={prop.display === display}
                className={prop.display === display ? 'is-active' : ''}
                onClick={() =>
                  updateProp(dbId, prop.id, (current) => {
                    const { display: _old, ...rest } = current;
                    return display ? { ...rest, display } : rest;
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
          {prop.display === 'bar' && (
            <label className="field-inline">
              <span>{t('database.outOf')}</span>
              <DraftInput
                type="number"
                label={t('database.outOf')}
                className="text-input small"
                value={String(prop.max ?? 100)}
                editable
                onCommit={(text) => {
                  const max = Number(text);
                  if (Number.isFinite(max) && max > 0)
                    updateProp(dbId, prop.id, (current) => ({ ...current, max }));
                }}
              />
            </label>
          )}
        </div>
      )}
      {prop.type === 'relation' && <RelationSettings dbId={dbId} prop={prop} />}
      {(prop.type === 'select' || prop.type === 'multiSelect') && (
        <ul className="db-prop-list">
          {prop.options.map((option, index) => (
            <li key={option.id}>
              <button
                type="button"
                className="icon-button tiny"
                aria-label={t('database.moveOptionUp', { name: option.name })}
                title={t('database.moveOptionUp', { name: option.name })}
                disabled={index === 0}
                onClick={() => moveOption(dbId, prop.id, index, -1)}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                className="icon-button tiny"
                aria-label={t('database.moveOptionDown', { name: option.name })}
                title={t('database.moveOptionDown', { name: option.name })}
                disabled={index === prop.options.length - 1}
                onClick={() => moveOption(dbId, prop.id, index, 1)}
              >
                <ArrowDown size={13} />
              </button>
              <DraftInput
                type="text"
                label={t('database.optionName')}
                className="text-input small"
                value={option.name}
                editable
                onCommit={(name) =>
                  name.trim() &&
                  updateProp(dbId, prop.id, (current) => ({
                    ...current,
                    options: current.options.map((item) =>
                      item.id === option.id ? { ...item, name: name.trim() } : item,
                    ),
                  }))
                }
              />
              <Select<ColorName>
                label={t('editor.colour')}
                value={option.color}
                options={COLORS.map((color) => ({ value: color, label: colorLabel(color) }))}
                onChange={(color) =>
                  updateProp(dbId, prop.id, (current) => ({
                    ...current,
                    options: current.options.map((item) =>
                      item.id === option.id ? { ...item, color } : item,
                    ),
                  }))
                }
              />
              <button
                type="button"
                className="icon-button tiny"
                aria-label={t('database.deleteOptionAria', { name: option.name })}
                onClick={() =>
                  updateProp(dbId, prop.id, (current) => ({
                    ...current,
                    options: current.options.filter((item) => item.id !== option.id),
                  }))
                }
              >
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="popover-actions">
        {view && (
          <>
            <button
              type="button"
              className="button small"
              onClick={() => {
                saveView((current) => ({
                  ...current,
                  sorts: [{ prop: prop.id, dir: 'asc' }],
                }));
                onClose();
              }}
            >
              {t('database.sortAscending')}
            </button>
            <button
              type="button"
              className="button small"
              onClick={() => {
                saveView((current) => ({
                  ...current,
                  hidden: [...current.hidden, prop.id],
                }));
                onClose();
              }}
            >
              <EyeOff size={13} /> {t('database.hide')}
            </button>
          </>
        )}
        <button type="button" className="button small danger" onClick={removeProperty}>
          <Trash2 size={13} /> {t('common.delete')}
        </button>
      </div>
    </Popover>
  );
}

function removePropertyFromView(view: ViewDef, propertyId: string): ViewDef {
  const widths = { ...view.widths };
  const align = { ...view.align };
  const summaries = { ...view.summaries };
  delete widths[propertyId];
  delete align[propertyId];
  delete summaries[propertyId];
  return {
    ...view,
    filters: view.filters.filter((rule) => rule.prop !== propertyId),
    filterGroups: view.filterGroups
      ?.map((group) => ({
        ...group,
        filters: group.filters.filter((rule) => rule.prop !== propertyId),
      }))
      .filter((group) => group.filters.length > 0),
    sorts: view.sorts.filter((sort) => sort.prop !== propertyId),
    hidden: view.hidden.filter((id) => id !== propertyId),
    groupBy: view.groupBy === propertyId ? null : view.groupBy,
    dateProp: view.dateProp === propertyId ? null : view.dateProp,
    widths,
    frozenThrough: view.frozenThrough === propertyId ? undefined : view.frozenThrough,
    order: view.order?.filter((id) => id !== propertyId),
    wrap: view.wrap?.filter((id) => id !== propertyId),
    align,
    summaries,
    conditionalFormats: view.conditionalFormats?.filter((rule) => rule.prop !== propertyId),
    cardProperties: view.cardProperties?.filter((id) => id !== propertyId),
    cardImageProp: view.cardImageProp === propertyId ? null : view.cardImageProp,
  };
}

function setFillMode(dbId: PageId, prop: PropDef, mode: 'manual' | 'default' | 'calculated') {
  updateProp(dbId, prop.id, (current) => {
    if (mode === 'manual') {
      const {
        fillMode: _fillMode,
        defaultValue: _defaultValue,
        defaultFormula: _defaultFormula,
        ...rest
      } = current;
      return rest;
    }
    return { ...current, fillMode: mode };
  });
}

function setDefaultSource(dbId: PageId, prop: PropDef, source: 'literal' | 'formula' | 'sequence') {
  if (source === 'sequence') {
    updateProp(dbId, prop.id, (current) => {
      const {
        defaultValue: _defaultValue,
        defaultFormula: _defaultFormula,
        defaultFormulaBindings: _defaultFormulaBindings,
        ...rest
      } = current;
      return {
        ...rest,
        fillMode: 'default',
        defaultSequence: current.defaultSequence ?? {
          start: current.sequenceNext ?? 0,
          increment: 1,
        },
      };
    });
    return;
  }
  updateProp(dbId, prop.id, (current) => {
    if (source === 'formula') {
      const { defaultValue: _defaultValue, defaultSequence: _defaultSequence, ...rest } = current;
      return { ...rest, fillMode: 'default', defaultFormula: current.defaultFormula ?? '' };
    }
    const {
      defaultFormula: _defaultFormula,
      defaultFormulaBindings: _defaultFormulaBindings,
      defaultSequence: _defaultSequence,
      ...rest
    } = current;
    return { ...rest, fillMode: 'default' };
  });
}

function moveOption(dbId: PageId, propId: string, index: number, delta: -1 | 1) {
  updateProp(dbId, propId, (current) => {
    const options = moveSelectOption(current.options, index, delta);
    return options === current.options ? current : { ...current, options };
  });
}

function DefaultValueField({ dbId, prop }: { dbId: PageId; prop: PropDef }) {
  const state = useWorkspace();
  const [picker, setPicker] = useState<HTMLButtonElement | null>(null);
  const value = prop.defaultValue ?? null;
  const set = (next: PropValue | undefined) =>
    updateProp(dbId, prop.id, (current) => {
      if (next === undefined) {
        const { defaultValue: _defaultValue, ...rest } = current;
        return rest;
      }
      return { ...current, defaultValue: next };
    });
  const label = t('database.defaultValue');
  if (prop.type === 'checkbox')
    return (
      <label className="field-inline">
        <input type="checkbox" checked={value === true} onChange={(event) => set(event.target.checked)} />
        <span>{label}</span>
      </label>
    );
  if (prop.type === 'select')
    return (
      <label className="field">
        <span>{label}</span>
        <select
          className="text-input small"
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => set(event.target.value || undefined)}
        >
          <option value="">{t('database.empty')}</option>
          {prop.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
    );
  if (prop.type === 'multiSelect')
    return (
      <label className="field">
        <span>{label}</span>
        <select
          className="text-input small"
          aria-label={label}
          multiple
          value={Array.isArray(value) ? value : []}
          onChange={(event) => set([...event.currentTarget.selectedOptions].map((option) => option.value))}
        >
          {prop.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
      </label>
    );
  if (prop.type === 'date' || prop.type === 'time' || prop.type === 'datetime') {
    const inputType = prop.type === 'datetime' ? 'datetime-local' : prop.type;
    const inputValue =
      prop.type === 'datetime' && typeof value === 'string'
        ? toDateTimeLocal(value)
        : typeof value === 'string'
          ? value
          : '';
    return (
      <label className="field">
        <span>{label}</span>
        <input
          type={inputType}
          className="text-input small"
          aria-label={label}
          value={inputValue}
          onChange={(event) => {
            const raw = event.target.value;
            set(!raw ? undefined : prop.type === 'datetime' ? new Date(raw).toISOString() : raw);
          }}
        />
      </label>
    );
  }
  if (prop.type === 'relation') {
    const targets = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
    const setTargets = (next: string[]) =>
      set(next.length === 0 ? undefined : prop.relation?.multiple ? next : next[0]!);
    return (
      <div className="field">
        <span>{label}</span>
        <div className="default-relation">
          {targets.map((target) => {
            const resolved = resolveRelationReference(state, prop, target);
            const title = resolved?.page ? relationDisplayLabel(state, prop, resolved.page) : target;
            return (
              <button
                type="button"
                key={target}
                className={`relation-chip${resolved?.page ? '' : ' is-missing'}`}
                aria-label={`${title} ${t('common.delete')}`}
                title={resolved?.page ? undefined : t('database.doesNotExist', { target })}
                onClick={() => setTargets(targets.filter((item) => item !== target))}
              >
                {title}
                <X size={11} />
              </button>
            );
          })}
          <button
            type="button"
            className="link-button small"
            aria-label={label}
            disabled={!prop.relation?.targetDatabaseId}
            onClick={(event) => setPicker(event.currentTarget)}
          >
            {targets.length
              ? t('common.add')
              : prop.relation?.targetDatabaseId
                ? t('database.choose')
                : t('database.relationChooseTable')}
          </button>
        </div>
        {picker && (
          <RelationPicker
            prop={prop}
            targets={targets}
            anchor={picker}
            onClose={() => setPicker(null)}
            onChange={setTargets}
          />
        )}
      </div>
    );
  }

  const numeric = ['number', 'currency', 'percent', 'slider', 'progress', 'scale', 'duration'].includes(
    prop.type,
  );
  const multiplier =
    prop.type === 'percent'
      ? 100
      : prop.type === 'duration'
        ? 1 / durationUnitFactor(prop.format?.durationUnit ?? 'minutes')
        : 1;
  const shown =
    typeof value === 'number' ? String(value * multiplier) : typeof value === 'string' ? value : '';
  return (
    <label className="field">
      <span>{label}</span>
      <DraftInput
        type={numeric ? 'number' : 'text'}
        label={label}
        className="text-input small"
        value={shown}
        editable
        min={prop.format?.min === undefined ? undefined : prop.format.min * multiplier}
        max={prop.format?.max === undefined ? undefined : prop.format.max * multiplier}
        step={prop.format?.step === undefined ? undefined : prop.format.step * multiplier}
        onCommit={(text) => {
          if (!text.trim()) {
            set(numeric ? undefined : '');
            return;
          }
          if (!numeric) {
            set(text);
            return;
          }
          const number = Number(text);
          if (!Number.isFinite(number)) return;
          set(number / multiplier);
        }}
      />
    </label>
  );
}

function DefaultSequenceFields({ dbId, prop }: { dbId: PageId; prop: PropDef }) {
  const sequence = prop.defaultSequence ?? { start: 0, increment: 1 };
  const multiplier =
    prop.type === 'percent'
      ? 100
      : prop.type === 'duration'
        ? 1 / durationUnitFactor(prop.format?.durationUnit ?? 'minutes')
        : 1;
  const set = (key: 'start' | 'increment', value: number) =>
    updateProp(dbId, prop.id, (current) => ({
      ...current,
      fillMode: 'default',
      defaultSequence: {
        ...(current.defaultSequence ?? { start: current.sequenceNext ?? 0, increment: 1 }),
        [key]: value / multiplier,
      },
    }));
  return (
    <div className="field-grid">
      <SequenceNumberField
        label={t('database.sequenceStart')}
        value={sequence.start * multiplier}
        help={t('database.sequenceHelp')}
        onCommit={(value) => set('start', value)}
      />
      <SequenceNumberField
        label={t('database.sequenceIncrement')}
        value={sequence.increment * multiplier}
        min={Number.MIN_VALUE}
        help={t('database.sequenceHelp')}
        onCommit={(value) => set('increment', value)}
      />
    </div>
  );
}

function SequenceNumberField({
  label,
  value,
  min,
  help,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  help: string;
  onCommit: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{label} <span title={help} aria-label={help} tabIndex={0}>ⓘ</span></span>
      <DraftInput
        type="number"
        label={label}
        className="text-input small"
        value={String(value)}
        editable
        onCommit={(text) => {
          const number = Number(text);
          if (!text.trim() || !Number.isFinite(number) || (min !== undefined && number < min)) {
            toast(t('database.invalidSequence'), { tone: 'error' });
            return;
          }
          onCommit(number);
        }}
      />
    </label>
  );
}

function PropertyFormatSettings({ dbId, prop }: { dbId: PageId; prop: PropDef }) {
  const numeric = ['number', 'currency', 'percent', 'slider', 'progress', 'scale', 'duration'].includes(
    prop.type,
  );
  const [draftFormat, setDraftFormat] = useState<PropertyFormat>(prop.format ?? {});
  const format = numeric ? draftFormat : (prop.format ?? {});
  const setFormat = (key: keyof PropertyFormat, value: PropertyFormat[keyof PropertyFormat] | undefined) => {
    if (numeric) {
      setDraftFormat((current) => {
        const next: PropertyFormat = { ...current };
        if (value === undefined || value === '') delete next[key];
        else Object.assign(next, { [key]: value });
        return next;
      });
      return;
    }
    updateProp(dbId, prop.id, (current) => {
      const next: PropertyFormat = { ...current.format };
      if (value === undefined || value === '') delete next[key];
      else Object.assign(next, { [key]: value });
      const { format: _old, ...rest } = current;
      return Object.keys(next).length ? { ...rest, format: next } : rest;
    });
  };
  const dirty = numeric && JSON.stringify(draftFormat) !== JSON.stringify(prop.format ?? {});
  const saveNumericFormat = () => {
    if ((format.min !== undefined && format.max !== undefined && format.min > format.max) ||
        (format.step !== undefined && format.step <= 0)) {
      toast(t('database.invalidNumericFormat'), { tone: 'error' });
      return;
    }
    updateProp(dbId, prop.id, (current) => {
      const { format: _old, ...rest } = current;
      return Object.keys(draftFormat).length ? { ...rest, format: draftFormat } : rest;
    });
  };
  const constraintMultiplier =
    prop.type === 'percent'
      ? 100
      : prop.type === 'duration'
        ? 1 / durationUnitFactor(format.durationUnit ?? 'minutes')
        : 1;
  const setDisplayConstraint = (key: 'min' | 'max' | 'step', value: number | undefined) =>
    setFormat(key, value === undefined ? undefined : value / constraintMultiplier);
  const dateLike = ['date', 'time', 'datetime', 'createdTime', 'lastEditedTime'].includes(prop.type);
  const linkLike = ['email', 'url', 'phone'].includes(prop.type);
  const localeField = (dateOrNumber: boolean) => (
    <label className="field">
      <span>{t('database.locale')} {numeric && <span title={t('database.localeHelp')} aria-label={t('database.localeHelp')} tabIndex={0}>ⓘ</span>}</span>
      <DraftInput
        type="text"
        label={t('database.locale')}
        className="text-input small"
        value={format.locale ?? ''}
        editable
        onCommit={(text) => {
          if (!text.trim()) return setFormat('locale', undefined);
          try {
            if (dateOrNumber) new Intl.NumberFormat(text.trim());
            else new Intl.DateTimeFormat(text.trim());
            setFormat('locale', text.trim());
          } catch {
            toast(t('database.locale') + ': invalid value', { tone: 'error' });
          }
        }}
      />
    </label>
  );
  if (!numeric && !dateLike && !linkLike) return null;
  return (
    <>
      {linkLike && (
        <FormatTextField
          label={t('database.linkLabel')}
          value={format.linkLabel ?? ''}
          onCommit={(text) => setFormat('linkLabel', text.trim() || undefined)}
        />
      )}
      {localeField(numeric)}
      {numeric && (
        <div className="field-grid">
          {prop.type === 'currency' && (
            <FormatTextField
              label={t('database.currencyCode')}
              value={format.currency ?? 'BRL'}
              onCommit={(text) => {
                const currency = text.trim().toUpperCase();
                try {
                  new Intl.NumberFormat(format.locale ?? 'en-US', { style: 'currency', currency });
                  setFormat('currency', currency);
                } catch {
                  toast(t('database.currencyCode') + ': invalid value', { tone: 'error' });
                }
              }}
            />
          )}
          <FormatNumberField
            label={t('database.precision')}
            help={t('database.precisionHelp')}
            value={format.precision}
            min={0}
            max={8}
            onCommit={(value) => setFormat('precision', value)}
          />
          <FormatNumberField
            label={t('database.minimum')}
            help={t('database.boundsHelp')}
            value={format.min === undefined ? undefined : format.min * constraintMultiplier}
            onCommit={(value) => setDisplayConstraint('min', value)}
          />
          <FormatNumberField
            label={t('database.maximum')}
            help={t('database.boundsHelp')}
            value={format.max === undefined ? undefined : format.max * constraintMultiplier}
            onCommit={(value) => setDisplayConstraint('max', value)}
          />
          <FormatNumberField
            label={t('database.step')}
            help={t('database.stepHelp')}
            value={format.step === undefined ? undefined : format.step * constraintMultiplier}
            onCommit={(value) => setDisplayConstraint('step', value)}
          />
          {(prop.type === 'number' || prop.type === 'currency') && (
            <label className="field">
              <span>{t('database.negativeFormat')}</span>
              <select
                className="text-input small"
                aria-label={t('database.negativeFormat')}
                value={format.negativeFormat ?? 'minus'}
                onChange={(event) =>
                  setFormat('negativeFormat', event.target.value as PropertyFormat['negativeFormat'])
                }
              >
                <option value="minus">{t('database.minusSign')}</option>
                <option value="parentheses">{t('database.parentheses')}</option>
              </select>
            </label>
          )}
          {prop.type === 'duration' && (
            <label className="field">
              <span>{t('database.durationUnit')}</span>
              <select
                className="text-input small"
                aria-label={t('database.durationUnit')}
                value={format.durationUnit ?? 'minutes'}
                onChange={(event) =>
                  setFormat('durationUnit', event.target.value as PropertyFormat['durationUnit'])
                }
              >
                <option value="seconds">{t('database.unitSeconds')}</option>
                <option value="minutes">{t('database.unitMinutes')}</option>
                <option value="hours">{t('database.unitHours')}</option>
                <option value="days">{t('database.unitDays')}</option>
              </select>
            </label>
          )}
          {prop.type === 'scale' && (
            <label className="field">
              <span>{t('database.scaleDisplay')}</span>
              <select
                className="text-input small"
                aria-label={t('database.scaleDisplay')}
                value={format.scaleIcon ?? 'star'}
                onChange={(event) =>
                  setFormat('scaleIcon', event.target.value as PropertyFormat['scaleIcon'])
                }
              >
                <option value="star">{t('database.scaleStars')}</option>
                <option value="number">{t('database.scaleNumbers')}</option>
              </select>
            </label>
          )}
          {['slider', 'progress', 'scale'].includes(prop.type) && (
            <>
              <label className="field">
                <span>{t('editor.colour')}</span>
                <Select<ColorName>
                  label={t('editor.colour')}
                  value={format.color ?? 'blue'}
                  options={COLORS.map((color) => ({ value: color, label: colorLabel(color) }))}
                  onChange={(color) => setFormat('color', color)}
                />
              </label>
              <label className="field-inline">
                <input
                  type="checkbox"
                  checked={format.showValue ?? (prop.type === 'slider' || prop.type === 'scale')}
                  onChange={(event) => setFormat('showValue', event.target.checked)}
                />
                <span>{t('database.showValue')}</span>
              </label>
            </>
          )}
        </div>
      )}
      {dateLike && (
        <div className="field-grid">
          {(prop.type === 'date' || prop.type === 'datetime' || prop.type.endsWith('Time')) && (
            <FormatChoice
              label={t('database.dateFormat')}
              value={format.dateStyle}
              values={['short', 'medium', 'long', 'full']}
              onChange={(value) => setFormat('dateStyle', value)}
            />
          )}
          {(prop.type === 'time' || prop.type === 'datetime' || prop.type.endsWith('Time')) && (
            <FormatChoice
              label={t('database.timeFormat')}
              value={format.timeStyle}
              values={['short', 'medium', 'long', 'full']}
              onChange={(value) => setFormat('timeStyle', value)}
            />
          )}
          {(prop.type === 'datetime' || prop.type.endsWith('Time')) && (
            <label className="field">
              <span>{t('database.timeZone')}</span>
              <DraftInput
                type="text"
                label={t('database.timeZone')}
                className="text-input small"
                value={format.timeZone ?? ''}
                editable
                onCommit={(text) => {
                  if (!text.trim()) return setFormat('timeZone', undefined);
                  try {
                    new Intl.DateTimeFormat('en', { timeZone: text.trim() });
                    setFormat('timeZone', text.trim());
                  } catch {
                    toast(t('database.timeZone') + ': invalid value', { tone: 'error' });
                  }
                }}
              />
            </label>
          )}
        </div>
      )}
      {numeric && (
        <div className="field">
          <span>{t('database.numberPreview')}</span>
          <output>{formatValue({ ...prop, format }, prop.type === 'percent' ? 0.25 : 1234.5)}</output>
          <div className="field-inline">
            <button type="button" className="button small" disabled={!dirty} onClick={saveNumericFormat}>{t('common.save')}</button>
            <button type="button" className="button small" disabled={!dirty} onClick={() => setDraftFormat(prop.format ?? {})}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </>
  );
}

function FormatTextField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <DraftInput
        type="text"
        label={label}
        className="text-input small"
        value={value}
        editable
        onCommit={onCommit}
      />
    </label>
  );
}

function FormatNumberField({
  label,
  help,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  help?: string;
  value?: number;
  min?: number;
  max?: number;
  onCommit: (value: number | undefined) => void;
}) {
  return (
    <label className="field">
      <span>{label} {help && <span title={help} aria-label={help} tabIndex={0}>ⓘ</span>}</span>
      <DraftInput
        type="number"
        label={label}
        className="text-input small"
        value={value === undefined ? '' : String(value)}
        editable
        onCommit={(text) => {
          if (!text.trim()) return onCommit(undefined);
          const number = Number(text);
          if (
            Number.isFinite(number) &&
            (min === undefined || number >= min) &&
            (max === undefined || number <= max)
          )
            onCommit(number);
        }}
      />
    </label>
  );
}

function FormatChoice({
  label,
  value,
  values,
  onChange,
}: {
  label: string;
  value?: string;
  values: string[];
  onChange: (value: PropertyFormat['dateStyle']) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        className="text-input small"
        aria-label={label}
        value={value ?? ''}
        onChange={(event) =>
          onChange(event.target.value ? (event.target.value as PropertyFormat['dateStyle']) : undefined)
        }
      >
        <option value="">{t('database.empty')}</option>
        {values.map((item) => (
          <option key={item} value={item}>
            {t(`database.style${item[0]!.toUpperCase()}${item.slice(1)}` as 'database.styleShort')}
          </option>
        ))}
      </select>
    </label>
  );
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// the formula language's functions, by their names in formulas, which stay the same in every language
function RelationSettings({ dbId, prop }: { dbId: PageId; prop: PropDef }) {
  const state = useWorkspace();
  const relation = relationConfig(prop);
  const target = relation.targetDatabaseId ? state.pages[relation.targetDatabaseId] : undefined;
  const databases = Object.values(state.pages)
    .filter(
      (page) =>
        page.kind === 'database' && page.database !== null && !isEffectivelyTrashed(state.pages, page.id),
    )
    .sort((a, b) => displayTitle(a).localeCompare(displayTitle(b)));
  const owner =
    relation.isInverse && target?.database
      ? target.database.properties.find((candidate) => candidate.id === relation.inversePropertyId)
      : undefined;
  const rowsWithIssues = rowsOf(state, dbId).filter(
    (row) => relationDiagnostics(state, row, prop).length > 0,
  ).length;
  const save = (change: Partial<RelationConfig>) =>
    run({
      type: 'relation.configure',
      databaseId: dbId,
      propertyId: prop.id,
      relation: { ...relation, ...change, isInverse: false },
      now: Date.now(),
    });

  if (relation.isInverse) {
    return (
      <div className="db-relation-settings">
        <p className="muted small">
          {t('database.relationInverseHelp', { name: owner?.name ?? t('database.relationSourceMissing') })}
        </p>
        {rowsWithIssues > 0 && (
          <p className="db-relation-warning" role="status">
            {t('database.relationMigrationWarning', { count: rowsWithIssues })}
          </p>
        )}
      </div>
    );
  }

  const inverseOptions = (target?.database?.properties ?? [])
    .filter(
      (candidate) => candidate.type === 'relation' && !(target?.id === dbId && candidate.id === prop.id),
    )
    .map((candidate) => ({ value: candidate.id, label: candidate.name }));
  const displayOptions = (target?.database?.properties ?? []).map((candidate) => ({
    value: candidate.id,
    label: candidate.name,
  }));

  return (
    <div className="db-relation-settings">
      <label className="field">
        <span>{t('database.relationTarget')}</span>
        <Select<string>
          label={t('database.relationTarget')}
          value={relation.targetDatabaseId}
          placeholder={t('database.relationChooseTable')}
          options={databases.map((page) => ({ value: page.id, label: displayTitle(page) }))}
          footer={
            relation.targetDatabaseId
              ? {
                  label: t('database.clearRelationTarget'),
                  onSelect: () =>
                    save({
                      targetDatabaseId: null,
                      displayPropertyId: null,
                      inversePropertyId: null,
                      filters: [],
                    }),
                }
              : undefined
          }
          onChange={(targetDatabaseId) =>
            save({
              targetDatabaseId,
              displayPropertyId: null,
              inversePropertyId: null,
              filters: [],
            })
          }
        />
      </label>
      {target?.database && (
        <>
          <div className="field">
            <span>{t('database.relationCardinality')}</span>
            <div className="segmented" role="group" aria-label={t('database.relationCardinality')}>
              <button
                type="button"
                aria-pressed={!relation.multiple}
                className={!relation.multiple ? 'is-active' : ''}
                onClick={() => save({ multiple: false })}
              >
                {t('database.relationSingle')}
              </button>
              <button
                type="button"
                aria-pressed={relation.multiple}
                className={relation.multiple ? 'is-active' : ''}
                onClick={() => save({ multiple: true })}
              >
                {t('database.relationMultiple')}
              </button>
            </div>
          </div>
          <label className="field">
            <span>{t('database.relationDisplay')}</span>
            <Select<string>
              label={t('database.relationDisplay')}
              value={relation.displayPropertyId}
              placeholder={t('database.relationUseTitle')}
              options={displayOptions}
              footer={
                relation.displayPropertyId
                  ? {
                      label: t('database.relationUseTitle'),
                      onSelect: () => save({ displayPropertyId: null }),
                    }
                  : undefined
              }
              onChange={(displayPropertyId) => save({ displayPropertyId })}
            />
          </label>
          <label className="field">
            <span>{t('database.relationInverse')}</span>
            <Select<string>
              label={t('database.relationInverse')}
              value={relation.inversePropertyId}
              placeholder={t('database.none')}
              options={inverseOptions}
              footer={
                relation.inversePropertyId
                  ? { label: t('database.none'), onSelect: () => save({ inversePropertyId: null }) }
                  : undefined
              }
              onChange={(inversePropertyId) => save({ inversePropertyId })}
            />
          </label>
          <RelationFilterSettings
            target={target}
            filters={relation.filters}
            onChange={(filters) => save({ filters })}
          />
        </>
      )}
      {rowsWithIssues > 0 && (
        <p className="db-relation-warning" role="status">
          {t('database.relationMigrationWarning', { count: rowsWithIssues })}
        </p>
      )}
    </div>
  );
}

function RelationFilterSettings({
  target,
  filters,
  onChange,
}: {
  target: PageMeta;
  filters: FilterRule[];
  onChange: (filters: FilterRule[]) => void;
}) {
  const properties = target.database?.properties ?? [];
  const add = () => {
    const prop = properties.find((candidate) => filterOpsFor(candidate.type).length > 0);
    if (!prop) return;
    const ops = filterOpsFor(prop.type);
    onChange([
      ...filters,
      {
        id: newId(),
        prop: prop.id,
        op: ops[0] ?? 'is',
        value: defaultRelationFilterValue(prop),
      },
    ]);
  };
  const change = (id: string, next: FilterRule) =>
    onChange(filters.map((filter) => (filter.id === id ? next : filter)));

  return (
    <div className="db-relation-filters">
      <div className="db-relation-filter-heading">
        <span>{t('database.relationOptionFilters')}</span>
        <button type="button" className="link-button" onClick={add} disabled={properties.length === 0}>
          {t('database.addAFilter')}
        </button>
      </div>
      {filters.map((filter) => {
        const prop = properties.find((candidate) => candidate.id === filter.prop);
        if (!prop) return null;
        const ops = filterOpsFor(prop.type);
        const needsValue = !['empty', 'notEmpty', 'checked', 'unchecked'].includes(filter.op);
        const optionValue = typeof filter.value === 'string' ? filter.value : null;
        return (
          <div className="db-relation-filter" key={filter.id}>
            <Select<string>
              label={t('database.property')}
              value={prop.id}
              options={properties.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
              onChange={(propId) => {
                const nextProp = properties.find((candidate) => candidate.id === propId);
                if (!nextProp) return;
                change(filter.id, {
                  ...filter,
                  prop: propId,
                  op: filterOpsFor(nextProp.type)[0] ?? 'is',
                  value: defaultRelationFilterValue(nextProp),
                });
              }}
            />
            <select
              className="text-input small"
              aria-label={t('database.condition')}
              value={filter.op}
              onChange={(event) => {
                const op = event.target.value as FilterOp;
                change(filter.id, { ...filter, op, value: needsFilterValue(op) ? filter.value : null });
              }}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {filterLabel(op)}
                </option>
              ))}
            </select>
            {needsValue && prop.options.length > 0 && ['select', 'multiSelect'].includes(prop.type) ? (
              <Select<string>
                label={t('database.value')}
                value={optionValue}
                options={prop.options.map((option) => ({ value: option.id, label: option.name }))}
                onChange={(value) => change(filter.id, { ...filter, value })}
              />
            ) : needsValue ? (
              <DraftInput
                type={prop.type === 'number' ? 'number' : 'text'}
                label={t('database.value')}
                className="text-input small"
                value={
                  typeof filter.value === 'string' || typeof filter.value === 'number'
                    ? String(filter.value)
                    : ''
                }
                editable
                onCommit={(value) => {
                  const parsed: PropValue = prop.type === 'number' && value.trim() ? Number(value) : value;
                  change(filter.id, { ...filter, value: parsed });
                }}
              />
            ) : null}
            <button
              type="button"
              className="icon-button tiny"
              aria-label={t('database.removeFilter')}
              onClick={() => onChange(filters.filter((candidate) => candidate.id !== filter.id))}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function defaultRelationFilterValue(prop: PropDef): PropValue {
  if (prop.type === 'select' || prop.type === 'multiSelect') return prop.options[0]?.id ?? null;
  return null;
}

function needsFilterValue(op: FilterOp): boolean {
  return !['empty', 'notEmpty', 'checked', 'unchecked'].includes(op);
}
