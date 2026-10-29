import { AlertTriangle, Check, Pencil, Plus, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { formatDisplayValue, formulaResult, formulaValueText, valueOf } from '../../../core/database';
import { displayTitle, TEXT_HEX } from '../../../core/model';
import { resolveLinkTarget } from '../../../core/search';
import {
  relationDiagnostics,
  relationDisplayLabel,
  relationOptions,
  resolveRelationReference,
} from '../../../core/relations';
import { openPage } from '../../router';
import { useWorkspace } from '../../workspace';
import { PageIcon } from '../Sidebar';
import { reservedPropertyName } from '../../../core/vault/pageFile';
import { newId } from '../../platform/files';
import { getLocale, t } from '../../i18n';
import { toast } from '../../ui';
import type {
  ColorName,
  DatabaseDef,
  PageId,
  PageMeta,
  PropDef,
  PropType,
  PropValue,
  SelectOption,
} from '../../../core/model';
import { openExternal } from '../../platform/desktop';
import { Popover } from '../Popover';
import { ensureOption, setValue, updateDatabase } from './data';
import { durationUnitFactor } from '../../../core/typedValues';
import { scalarValueError } from '../../../core/typedValues';
import { isMediaProperty } from '../../../core/propertyMedia';
import {
  attemptCellDraftCommit,
  isCellEditableNow,
  parseCellNumberDraft,
  placeInitialCellDraftCaret,
} from './cellEditing';
import { MediaPropertyDisplay, MediaPropertyInput } from './MediaProperty';
import { ButtonActionCell } from './TableActionCell';
import { PropertyTypeSelect } from './PropertyTypeSelect';

export function Chip({ option }: { option: Pick<SelectOption, 'name' | 'color'> }) {
  return <span className={`chip color-${option.color}`}>{option.name}</span>;
}

const formatValue = (prop: PropDef | undefined, value: PropValue) =>
  formatDisplayValue(prop, value, getLocale());

// a value shown on a card or in a list, never editable
// a number shown as how far along it is, out of the property's maximum
export function ProgressBar({
  value,
  min = 0,
  max = 100,
  color,
  label,
  showPercent = true,
}: {
  value: number;
  min?: number;
  max?: number | undefined;
  color?: ColorName;
  label?: string;
  showPercent?: boolean;
}) {
  const share = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return (
    <span className="prop-progress" title={`${value.toLocaleString()} / ${max.toLocaleString()}`}>
      <span className="prop-progress-track">
        <span
          className="prop-progress-fill"
          style={{ width: `${share * 100}%`, ...(color ? { backgroundColor: TEXT_HEX[color] } : {}) }}
        />
      </span>
      {(label !== undefined || showPercent) && (
        <span className="prop-progress-label">{label ?? `${Math.round(share * 100)}%`}</span>
      )}
    </span>
  );
}

export function PropertyDisplay({ prop, value }: { prop: PropDef; value: PropValue }) {
  const effectiveProp =
    prop.type === 'formula' && prop.formulaResultType ? { ...prop, type: prop.formulaResultType } : prop;
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    (value === false && effectiveProp.type !== 'checkbox')
  )
    return null;
  if (isMediaProperty(effectiveProp.type)) return <MediaPropertyDisplay prop={effectiveProp} value={value} />;
  if ((effectiveProp.display === 'bar' || effectiveProp.type === 'progress') && typeof value === 'number')
    return (
      <ProgressBar
        value={value}
        min={effectiveProp.format?.min}
        max={effectiveProp.format?.max ?? effectiveProp.max}
        color={effectiveProp.format?.color}
        label={effectiveProp.format?.showValue ? formatValue(effectiveProp, value) : undefined}
        showPercent={effectiveProp.format?.showValue === undefined && effectiveProp.display === 'bar'}
      />
    );
  if (effectiveProp.type === 'scale' && typeof value === 'number' && (effectiveProp.format?.scaleIcon ?? 'star') === 'star') {
    const min = effectiveProp.format?.min ?? 1;
    const max = effectiveProp.format?.max ?? 5;
    const total = Math.max(1, Math.round(max - min + 1));
    const filled = Math.min(total, Math.max(0, Math.round(value - min + 1)));
    return (
      <span
        className="prop-scale-stars"
        aria-label={formatValue(effectiveProp, value)}
        title={formatValue(effectiveProp, value)}
        style={effectiveProp.format?.color ? { color: TEXT_HEX[effectiveProp.format.color] } : undefined}
      >
        {'★'.repeat(filled)}
        <span>{'☆'.repeat(total - filled)}</span>
        {effectiveProp.format?.showValue && <small>{` ${formatValue(effectiveProp, value)}`}</small>}
      </span>
    );
  }
  switch (effectiveProp.type) {
    case 'select': {
      const option = effectiveProp.options.find((candidate) => candidate.id === value);
      return option ? <Chip option={option} /> : null;
    }
    case 'multiSelect':
      return (
        <>
          {(Array.isArray(value) ? value : []).map((id) => {
            const option = prop.options.find((candidate) => candidate.id === id);
            return option ? <Chip key={id} option={option} /> : null;
          })}
        </>
      );
    case 'checkbox':
      return (
        <span className="prop-check" role="checkbox" aria-checked={value === true} aria-label={prop.name}>
          {value === true ? <Check size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
          {prop.name}
        </span>
      );
    case 'date':
    case 'time':
    case 'datetime':
    case 'createdTime':
    case 'lastEditedTime':
      return <span className="prop-text">{formatValue(prop, value)}</span>;
    case 'url':
    case 'email':
    case 'phone':
      return <PropertyLink prop={prop} value={value} />;
    case 'relation':
      return <RelationChips prop={prop} targets={Array.isArray(value) ? value : [String(value)]} />;
    default:
      return <span className="prop-text">{formatValue(prop, value)}</span>;
  }
}

function PropertyLink({ prop, value }: { prop: PropDef; value: PropValue }) {
  if (typeof value !== 'string' || scalarValueError(prop, value) !== null)
    return <span className="prop-text">{formatValue(prop, value)}</span>;
  const href =
    prop.type === 'email'
      ? `mailto:${value}`
      : prop.type === 'phone'
        ? `tel:${value.replace(/[^\d+]/g, '')}`
        : value;
  const label = prop.format?.linkLabel?.trim() || value;
  return (
    <a
      className="prop-link"
      href={href}
      aria-label={`${prop.name}: ${label}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openExternal(href);
      }}
    >
      {label}
    </a>
  );
}

// related pages as small links, a name that no longer matches a page is shown faded
export function RelationChips({ targets, prop }: { targets: string[]; prop?: PropDef }) {
  const state = useWorkspace();
  return (
    <>
      {targets.map((target) => {
        const resolved = prop ? resolveRelationReference(state, prop, target) : null;
        const id = resolved?.page?.id ?? resolveLinkTarget(state, target);
        const page = resolved?.page ?? (id ? state.pages[id] : undefined);
        const label = resolved?.label ?? (page ? displayTitle(page) : target);
        const warning = resolved?.diagnostic ? relationDiagnosticLabel(resolved.diagnostic) : null;
        return (
          <span
            key={target}
            role={page ? 'link' : undefined}
            tabIndex={page ? 0 : undefined}
            className={`relation-chip${page ? '' : ' is-missing'}`}
            data-page-id={page?.id}
            title={[
              page ? t('database.openTitle', { title: label }) : t('database.doesNotExist', { target }),
              warning,
            ]
              .filter(Boolean)
              .join('. ')}
            aria-label={warning ? `${label}. ${warning}` : label}
            onClick={(event) => {
              if (!page) return;
              event.stopPropagation();
              openPage(page.id);
            }}
            onKeyDown={(event) => event.key === 'Enter' && page && openPage(page.id)}
          >
            {page && <PageIcon page={page} />}
            {label}
            {warning && <AlertTriangle size={12} aria-hidden="true" />}
          </span>
        );
      })}
    </>
  );
}

function toDateTimeLocal(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// the editor for one value of one row, used in table cells and on row pages
export function PropertyInput({
  dbId,
  prop,
  row,
  editable,
  gridMode,
  isEditing,
  initialText,
  openPickerOnEdit,
  canEditNow,
  onCommitAndMove,
  onCancelEdit,
  onDoneEdit,
  onInvalidDraftChange,
}: {
  dbId: PageId;
  prop: PropDef;
  row: PageMeta;
  editable: boolean;
  gridMode?: boolean;
  isEditing?: boolean;
  initialText?: string;
  openPickerOnEdit?: boolean;
  canEditNow?: () => boolean;
  onCommitAndMove?: (direction: 'down' | 'up' | 'next' | 'prev' | 'stay') => void;
  onCancelEdit?: () => void;
  onDoneEdit?: () => void;
  onInvalidDraftChange?: (invalid: boolean) => void;
}) {
  const state = useWorkspace();
  const database = state.pages[dbId]?.database;
  const value = database ? valueOf(row, prop.id, database, state) : (row.properties[prop.id] ?? null);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [checkboxDraft, setCheckboxDraft] = useState<boolean | null>(null);
  const checkboxDraftRef = useRef<boolean | null>(null);
  const checkboxCanceling = useRef(false);
  const checkboxFinished = useRef(false);
  const [rangeDraft, setRangeDraft] = useState<number | null>(null);
  const rangeDraftRef = useRef<number | null>(null);
  const rangeCanceling = useRef(false);
  const rangeFinished = useRef(false);
  const effectiveEditing = gridMode ? Boolean(isEditing) : editing;
  const canCommitNow = () => isCellEditableNow(editable, canEditNow);
  const label = t('properties.valueOf', { key: prop.name, title: displayTitle(row) });
  const unsupportedRelationValue =
    prop.type === 'relation' &&
    Object.keys(row.extra).some((key) => key.toLocaleLowerCase() === prop.name.toLocaleLowerCase());
  const scalarInput = [
    'email',
    'url',
    'phone',
    'number',
    'currency',
    'percent',
    'slider',
    'progress',
    'scale',
    'date',
    'time',
    'datetime',
    'duration',
  ].includes(prop.type);
  const stopEditing = () => {
    if (gridMode) (onDoneEdit ?? onCancelEdit)?.();
    else setEditing(false);
  };
  useEffect(() => {
    if (!gridMode || !effectiveEditing || !openPickerOnEdit || picker || !pickerTrigger.current) return;
    if (prop.type === 'relation' && (!prop.relation?.targetDatabaseId || unsupportedRelationValue)) return;
    setPicker(pickerTrigger.current);
  }, [
    effectiveEditing,
    gridMode,
    openPickerOnEdit,
    picker,
    prop.relation?.targetDatabaseId,
    prop.type,
    unsupportedRelationValue,
  ]);
  const handlePickerTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!gridMode || picker) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onCancelEdit?.();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onCommitAndMove?.(event.shiftKey ? 'prev' : 'next');
    }
  };
  const handlePickerGridTab = gridMode
    ? (direction: 'next' | 'prev') => {
        setPicker(null);
        onCommitAndMove?.(direction);
      }
    : undefined;

  if (prop.type === 'button')
    return <ButtonActionCell dbId={dbId} prop={prop} row={row} editable={editable} />;

  if (isMediaProperty(prop.type)) {
    if (prop.fillMode === 'calculated') return <FormulaCell dbId={dbId} prop={prop} row={row} />;
    return <MediaPropertyInput prop={prop} row={row} value={value} editable={editable} />;
  }

  if (prop.type === 'createdTime' || prop.type === 'lastEditedTime')
    return <span className="prop-text">{formatValue(prop, value)}</span>;
  if (prop.fillMode === 'calculated' && prop.type !== 'formula')
    return <FormulaCell dbId={dbId} prop={prop} row={row} />;

  if (gridMode && !effectiveEditing) {
    if (prop.type === 'checkbox') {
      return (
        <span className="prop-checkbox-display" role="checkbox" aria-checked={value === true} aria-label={label}>
          {value === true ? <Check size={14} aria-hidden="true" /> : <span aria-hidden="true" />}
        </span>
      );
    }
    return (
      <span className="db-cell-content" style={{ width: '100%', minHeight: '20px', pointerEvents: 'none' }}>
        {value === null || value === '' || (Array.isArray(value) && value.length === 0) ? (
          <span className="prop-empty">{t('database.empty')}</span>
        ) : (
          <PropertyDisplay prop={prop} value={value} />
        )}
      </span>
    );
  }

  if (scalarInput && !editable) return <PropertyDisplay prop={prop} value={value} />;
  if (scalarInput && !effectiveEditing && ['email', 'url', 'phone'].includes(prop.type))
    return (
      <span className="prop-cell-link">
        {value === null || value === '' ? (
          <span className="prop-empty">{t('database.empty')}</span>
        ) : (
          <PropertyDisplay prop={prop} value={value} />
        )}
        {editable && (
          <button
            type="button"
            className="icon-button tiny"
            aria-label={label}
            title={label}
            onClick={() => setEditing(true)}
          >
            <Pencil size={12} />
          </button>
        )}
      </span>
    );
  if (scalarInput && !effectiveEditing)
    return (
      <button type="button" className="prop-cell-value" aria-label={label} onClick={() => setEditing(true)}>
        {value === null || value === '' ? (
          <span className="prop-empty">{t('database.empty')}</span>
        ) : (
          <PropertyDisplay prop={prop} value={value} />
        )}
      </button>
    );
  const cellEditable = editable && (!scalarInput || effectiveEditing);

  switch (prop.type) {
    case 'formula':
      return <FormulaCell dbId={dbId} prop={prop} row={row} />;
    case 'relation': {
      const targets = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      return (
        <>
          <button
            type="button"
            className="prop-select"
            aria-label={label}
            disabled={!editable || !prop.relation?.targetDatabaseId || unsupportedRelationValue}
            autoFocus={effectiveEditing}
            ref={pickerTrigger}
            onKeyDown={handlePickerTriggerKeyDown}
            onBlur={() => {
              if (!picker) stopEditing();
            }}
            title={unsupportedRelationValue ? t('database.relationDiagnosticUnsupported') : undefined}
            onClick={(event) => setPicker(event.currentTarget)}
          >
            {targets.length === 0 && editable && (
              <span className="prop-empty">
                {prop.relation?.targetDatabaseId ? t('database.empty') : t('database.relationChooseTable')}
              </span>
            )}
            <RelationChips prop={prop} targets={targets} />
          </button>
          {unsupportedRelationValue && (
            <span className="db-relation-warning" role="status">
              {t('database.relationDiagnosticUnsupported')}
            </span>
          )}
          {picker && (
            <RelationPicker
              row={row}
              prop={prop}
              targets={targets}
              anchor={picker}
              initialQuery={initialText}
            editable={editable}
            canEditNow={canEditNow}
              onGridTab={handlePickerGridTab}
              onClose={() => {
                setPicker(null);
                if (gridMode) onCommitAndMove?.('stay');
              }}
            />
          )}
        </>
      );
    }
    case 'checkbox':
      if (gridMode) {
        const checkboxValue = checkboxDraft ?? value === true;
        const commitCheckbox = () => {
          if (checkboxFinished.current) return;
          checkboxFinished.current = true;
          if (checkboxCanceling.current) {
            checkboxCanceling.current = false;
            return;
          }
          if (
            canCommitNow() &&
            checkboxDraftRef.current !== null &&
            checkboxDraftRef.current !== (value === true)
          ) {
            setValue(row.id, prop.id, checkboxDraftRef.current);
          }
          checkboxDraftRef.current = null;
          setCheckboxDraft(null);
          stopEditing();
        };
        return (
          <input
            type="checkbox"
            className="prop-checkbox"
            aria-label={label}
            checked={checkboxValue}
            disabled={!cellEditable}
            autoFocus={effectiveEditing}
            onChange={(event) => {
              if (!canCommitNow()) return;
              checkboxFinished.current = false;
              checkboxDraftRef.current = event.target.checked;
              setCheckboxDraft(event.target.checked);
            }}
            onBlur={commitCheckbox}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                checkboxCanceling.current = true;
                checkboxFinished.current = false;
                checkboxDraftRef.current = null;
                setCheckboxDraft(value === true);
                event.currentTarget.blur();
                onCancelEdit?.();
              } else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                commitCheckbox();
                event.currentTarget.blur();
                onCommitAndMove?.(event.key === 'Tab' ? (event.shiftKey ? 'prev' : 'next') : event.shiftKey ? 'up' : 'down');
              }
            }}
          />
        );
      }
      return (
        <input
          type="checkbox"
          className="prop-checkbox"
          aria-label={label}
          checked={value === true}
          disabled={!editable}
          onChange={(event) => {
            if (canCommitNow()) setValue(row.id, prop.id, event.target.checked);
          }}
        />
      );
    case 'number':
    case 'currency':
    case 'percent':
    case 'duration':
    case 'progress': {
      const multiplier =
        prop.type === 'percent'
          ? 100
          : prop.type === 'duration'
            ? 1 / durationUnitFactor(prop.format?.durationUnit ?? 'minutes')
            : 1;
      const numberLocale =
        prop.format?.locale || (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
      const parseNumber = (text: string) => parseCellNumberDraft(text, numberLocale);
      const input = (
        <DraftInput
          type="text"
          inputMode="decimal"
          label={label}
          value={typeof value === 'number' ? String(value * multiplier) : ''}
          editable={cellEditable}
          canEditNow={canEditNow}
          autoFocus={effectiveEditing}
          initialDraft={initialText}
          validateInAllModes
          onDone={stopEditing}
          gridMode={gridMode}
          onCommitAndMove={onCommitAndMove}
          onCancelEdit={onCancelEdit}
          onInvalidDraftChange={onInvalidDraftChange}
          validateDraft={(text) => {
            if (!text.trim()) return null;
            const number = parseNumber(text);
            return number === null ? t('cellUx.invalidNumber') : scalarValueError(prop, number / multiplier);
          }}
          onCommit={(text) => {
            if (!text.trim()) return setValue(row.id, prop.id, null);
            const number = parseNumber(text);
            if (number === null) return false;
            return setValue(row.id, prop.id, number / multiplier);
          }}
        />
      );
      if (prop.display !== 'bar' && prop.type !== 'progress') return input;
      return (
        <span className="prop-progress-edit">
          {typeof value === 'number' && (
            <ProgressBar
              value={value}
              min={prop.format?.min}
              max={prop.format?.max ?? prop.max}
              color={prop.format?.color}
              label={prop.format?.showValue ? formatValue(prop, value) : undefined}
              showPercent={prop.format?.showValue === undefined && prop.display === 'bar'}
            />
          )}
          {input}
        </span>
      );
    }
    case 'slider':
    case 'scale': {
      const min = prop.format?.min ?? (prop.type === 'scale' ? 1 : 0);
      const max = prop.format?.max ?? (prop.type === 'scale' ? 5 : 100);
      const step = prop.format?.step ?? 1;
      const currentValue = rangeDraft ?? (typeof value === 'number' ? value : min);
      const commitRangeDraft = () => {
        if (rangeFinished.current) return;
        rangeFinished.current = true;
        if (rangeCanceling.current) {
          rangeCanceling.current = false;
          rangeDraftRef.current = null;
          setRangeDraft(null);
          return;
        }
        if (rangeDraftRef.current !== null && rangeDraftRef.current !== value) {
          if (canCommitNow()) setValue(row.id, prop.id, rangeDraftRef.current);
        }
        rangeDraftRef.current = null;
        setRangeDraft(null);
        stopEditing();
      };
      return (
        <span className="prop-range-edit">
          <input
            type="range"
            className="prop-range"
            aria-label={label}
            aria-valuetext={formatValue(prop, currentValue)}
            min={min}
            max={max}
            step={step}
            value={currentValue}
            disabled={!cellEditable}
            autoFocus={effectiveEditing}
            style={prop.format?.color ? { accentColor: TEXT_HEX[prop.format.color] } : undefined}
            onChange={(event) => {
              if (!canCommitNow()) return;
              const next = Number(event.target.value);
              if (gridMode) {
                rangeFinished.current = false;
                rangeDraftRef.current = next;
                setRangeDraft(next);
              } else setValue(row.id, prop.id, next);
            }}
            onBlur={gridMode ? commitRangeDraft : stopEditing}
            onKeyDown={(event) => {
              if (!gridMode) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                rangeCanceling.current = true;
                rangeFinished.current = false;
                rangeDraftRef.current = null;
                setRangeDraft(null);
                event.currentTarget.blur();
                onCancelEdit?.();
              } else if (event.key === 'Enter' || event.key === 'Tab') {
                event.preventDefault();
                const direction = event.key === 'Tab'
                  ? (event.shiftKey ? 'prev' : 'next')
                  : (event.shiftKey ? 'up' : 'down');
                commitRangeDraft();
                event.currentTarget.blur();
                onCommitAndMove?.(direction);
              }
            }}
          />
          {prop.format?.showValue !== false && (
            <span className="prop-range-value">
              {rangeDraft !== null || typeof value === 'number' ? formatValue(prop, currentValue) : '—'}
            </span>
          )}
        </span>
      );
    }
    case 'date':
      if (gridMode) {
        return (
          <DraftTemporalInput
            type="date"
            label={label}
            value={typeof value === 'string' ? value : ''}
            editable={cellEditable}
            canEditNow={canEditNow}
            autoFocus={effectiveEditing}
            onDone={stopEditing}
            onInvalidDraftChange={onInvalidDraftChange}
            onCommit={(raw) => setValue(row.id, prop.id, raw || null)}
            onCommitAndMove={onCommitAndMove}
            onCancelEdit={onCancelEdit}
          />
        );
      }
      return (
        <input
          type="date"
          className="prop-input"
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          disabled={!cellEditable}
          autoFocus={effectiveEditing}
          onChange={(event) => {
            if (canCommitNow()) setValue(row.id, prop.id, event.target.value || null);
          }}
          onBlur={stopEditing}
        />
      );
    case 'time':
      if (gridMode) {
        return (
          <DraftTemporalInput
            type="time"
            label={label}
            value={typeof value === 'string' ? value : ''}
            editable={cellEditable}
            canEditNow={canEditNow}
            autoFocus={effectiveEditing}
            onDone={stopEditing}
            onInvalidDraftChange={onInvalidDraftChange}
            onCommit={(raw) => setValue(row.id, prop.id, raw || null)}
            onCommitAndMove={onCommitAndMove}
            onCancelEdit={onCancelEdit}
          />
        );
      }
      return (
        <input
          type="time"
          className="prop-input"
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          disabled={!cellEditable}
          autoFocus={effectiveEditing}
          onChange={(event) => {
            if (canCommitNow()) setValue(row.id, prop.id, event.target.value || null);
          }}
          onBlur={stopEditing}
        />
      );
    case 'datetime': {
      const local = typeof value === 'string' ? toDateTimeLocal(value) : '';
      if (gridMode) {
        return (
          <DraftTemporalInput
            type="datetime-local"
            label={label}
            value={local}
            editable={cellEditable}
            canEditNow={canEditNow}
            autoFocus={effectiveEditing}
            onDone={stopEditing}
            onInvalidDraftChange={onInvalidDraftChange}
            onCommit={(raw) => setValue(row.id, prop.id, raw ? new Date(raw).toISOString() : null)}
            onCommitAndMove={onCommitAndMove}
            onCancelEdit={onCancelEdit}
          />
        );
      }
      return (
        <input
          type="datetime-local"
          className="prop-input"
          aria-label={label}
          value={local}
          disabled={!cellEditable}
          autoFocus={effectiveEditing}
          onChange={(event) => {
            if (!canCommitNow()) return;
            const raw = event.target.value;
            setValue(row.id, prop.id, raw ? new Date(raw).toISOString() : null);
          }}
          onBlur={stopEditing}
        />
      );
    }
    case 'url':
    case 'email':
    case 'phone':
      return (
        <span className={prop.type === 'url' ? 'prop-url' : undefined}>
          <DraftInput
            type={prop.type === 'url' ? 'url' : 'text'}
            label={label}
            value={typeof value === 'string' ? value : ''}
            editable={cellEditable}
            canEditNow={canEditNow}
            autoFocus={effectiveEditing}
            initialDraft={initialText}
            onDone={stopEditing}
            gridMode={gridMode}
            onCommitAndMove={onCommitAndMove}
            onCancelEdit={onCancelEdit}
            onInvalidDraftChange={onInvalidDraftChange}
            validateDraft={(text) => scalarValueError(prop, text.trim() || null)}
            onCommit={(text) => setValue(row.id, prop.id, text.trim() || null)}
          />
        </span>
      );
    case 'select':
    case 'multiSelect': {
      const ids = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      return (
        <>
          <button
            type="button"
            className="prop-select"
            aria-label={label}
            disabled={!editable}
            autoFocus={effectiveEditing}
            ref={pickerTrigger}
            onKeyDown={handlePickerTriggerKeyDown}
            onBlur={() => {
              if (!picker) stopEditing();
            }}
            onClick={(event) => setPicker(event.currentTarget)}
          >
            {ids.length === 0 && editable && <span className="prop-empty">{t('database.empty')}</span>}
            {ids.map((id) => {
              const option = prop.options.find((candidate) => candidate.id === id);
              return option ? <Chip key={id} option={option} /> : null;
            })}
          </button>
          {picker && (
            <OptionPicker
              dbId={dbId}
              prop={prop}
              selected={ids}
              anchor={picker}
              initialQuery={initialText}
              editable={editable}
              canEditNow={canEditNow}
              onGridTab={handlePickerGridTab}
              onClose={() => {
                setPicker(null);
                if (gridMode) onCommitAndMove?.('stay');
              }}
              row={row}
            />
          )}
        </>
      );
    }
    case 'text':
      return (
        <DraftTextarea
          label={label}
          value={typeof value === 'string' ? value : ''}
          editable={cellEditable}
          canEditNow={canEditNow}
          autoFocus={effectiveEditing}
          initialDraft={initialText}
          onDone={stopEditing}
          gridMode={gridMode}
          onCommitAndMove={onCommitAndMove}
          onCancelEdit={onCancelEdit}
          onInvalidDraftChange={onInvalidDraftChange}
          onCommit={(text) => setValue(row.id, prop.id, text)}
        />
      );
    default:
      return (
        <DraftInput
          type="text"
          label={label}
          value={typeof value === 'string' ? value : value === null ? '' : String(value)}
          editable={cellEditable}
          canEditNow={canEditNow}
          autoFocus={effectiveEditing}
          initialDraft={initialText}
          onDone={stopEditing}
          gridMode={gridMode}
          onCommitAndMove={onCommitAndMove}
          onCancelEdit={onCancelEdit}
          onInvalidDraftChange={onInvalidDraftChange}
          onCommit={(text) => setValue(row.id, prop.id, text)}
        />
      );
  }
}

type DraftCommitResult = unknown;

function draftCommitFailure(result: DraftCommitResult): string | null {
  if (result === false) return t('topBar.saveFailed');
  if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
    return 'error' in result && typeof result.error === 'string' ? result.error : t('topBar.saveFailed');
  }
  return null;
}

function DraftTemporalInput({
  type,
  label,
  value,
  editable,
  canEditNow,
  autoFocus,
  onCommit,
  onDone,
  onCommitAndMove,
  onCancelEdit,
  onInvalidDraftChange,
}: {
  type: 'date' | 'time' | 'datetime-local';
  label: string;
  value: string;
  editable: boolean;
  canEditNow?: () => boolean;
  autoFocus?: boolean;
  onCommit: (value: string) => DraftCommitResult;
  onDone?: () => void;
  onCommitAndMove?: (direction: 'down' | 'up' | 'next' | 'prev' | 'stay') => void;
  onCancelEdit?: () => void;
  onInvalidDraftChange?: (invalid: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const canceling = useRef(false);
  const finished = useRef(false);
  const commitFailed = useRef(false);
  const commit = (): boolean => {
    if (finished.current) return true;
    finished.current = true;
    if (canceling.current) {
      canceling.current = false;
      setDraft(null);
      setValidationError(null);
      commitFailed.current = false;
      onInvalidDraftChange?.(false);
      onDone?.();
      return true;
    }
    const attempt = attemptCellDraftCommit({ editable, canEditNow, draft, value, onCommit });
    if (attempt.kind === 'readonly') {
      canceling.current = false;
      setDraft(null);
      setValidationError(null);
      commitFailed.current = false;
      onInvalidDraftChange?.(false);
      onDone?.();
      return true;
    }
    if (attempt.kind === 'committed') {
      const error = draftCommitFailure(attempt.result);
      if (error) {
        finished.current = false;
        commitFailed.current = true;
        setValidationError(error);
        onInvalidDraftChange?.(true);
        return false;
      }
    }
    commitFailed.current = false;
    setValidationError(null);
    onInvalidDraftChange?.(false);
    setDraft(null);
    onDone?.();
    return true;
  };
  return (
    <input
      type={type}
      className="prop-input"
      aria-label={label}
      aria-invalid={validationError ? true : undefined}
      title={validationError ?? undefined}
      value={draft ?? value}
      autoFocus={autoFocus}
      onChange={(event) => {
        finished.current = false;
        if (!commitFailed.current) {
          setValidationError(null);
          onInvalidDraftChange?.(false);
        }
        setDraft(event.target.value);
      }}
      onBlur={(event) => {
        if (!commit()) {
          const element = event.currentTarget;
          const pane = element.closest<HTMLElement>('.pane[data-pane]');
          const nextTarget = event.relatedTarget;
          if (!pane || !(nextTarget instanceof Element) || !pane.contains(nextTarget)) return;
          requestAnimationFrame(() => {
            const activeElement = pane.ownerDocument.activeElement;
            if (
              !element.isConnected ||
              !pane.isConnected ||
              pane.classList.contains('is-cached') ||
              pane.getAttribute('aria-hidden') === 'true' ||
              pane.getClientRects().length === 0 ||
              !pane.ownerDocument.hasFocus() ||
              !pane.classList.contains('is-active') ||
              activeElement?.closest('[data-pane]') !== pane
            ) return;
            element.focus({ preventScroll: true });
          });
        }
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          canceling.current = true;
          setDraft(null);
          setValidationError(null);
          commitFailed.current = false;
          onInvalidDraftChange?.(false);
          event.currentTarget.blur();
          onCancelEdit?.();
        } else if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault();
          if (!commit()) return;
          event.currentTarget.blur();
          onCommitAndMove?.(
            event.key === 'Tab' ? (event.shiftKey ? 'prev' : 'next') : event.shiftKey ? 'up' : 'down',
          );
        }
      }}
    />
  );
}

// keeps typing local and saves on blur or enter, so every keystroke is not a separate change
export function DraftInput({
  type,
  inputMode,
  label,
  value,
  editable,
  canEditNow,
  onCommit,
  placeholder,
  className,
  autoFocus,
  min,
  max,
  step,
  onDone,
  gridMode,
  onCommitAndMove,
  onCancelEdit,
  initialDraft,
  validateDraft,
  validateInAllModes,
  onInvalidDraftChange,
}: {
  type: 'text' | 'number' | 'url';
  inputMode?: InputHTMLAttributes<HTMLInputElement>['inputMode'];
  label: string;
  value: string;
  editable: boolean;
  canEditNow?: () => boolean;
  onCommit: (text: string) => DraftCommitResult;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  min?: number;
  max?: number;
  step?: number;
  // called when the input loses focus, changed or not
  onDone?: () => void;
  gridMode?: boolean;
  onCommitAndMove?: (direction: 'down' | 'up' | 'next' | 'prev' | 'stay') => void;
  onCancelEdit?: () => void;
  initialDraft?: string;
  validateDraft?: (text: string) => string | null;
  validateInAllModes?: boolean;
  onInvalidDraftChange?: (invalid: boolean) => void;
}) {
  const shouldValidateDraft = Boolean(gridMode || validateInAllModes);
  const [draft, setDraft] = useState<string | null>(() => initialDraft ?? null);
  const [validationError, setValidationError] = useState<string | null>(() =>
    shouldValidateDraft && initialDraft !== undefined ? (validateDraft?.(initialDraft) ?? null) : null,
  );
  const canceling = useRef(false);
  const finished = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const commitFailed = useRef(false);
  const initialCaretPending = useRef(initialDraft !== undefined);
  const wasEditable = useRef(editable);
  // the values this field saved, so undo inside it steps back through them. the browser's own undo knows
  // nothing of values set from outside the field and can empty it instead
  const undone = useRef<Array<{ before: string; after: string }>>([]);
  const redone = useRef<Array<{ before: string; after: string }>>([]);
  const commit = (): boolean => {
    if (finished.current) return true;
    finished.current = true;
    if (canceling.current) {
      canceling.current = false;
      setDraft(null);
      setValidationError(null);
      commitFailed.current = false;
      onInvalidDraftChange?.(false);
      onDone?.();
      return true;
    }
    const attempt = attemptCellDraftCommit({
      editable,
      canEditNow,
      draft,
      value,
      validate: shouldValidateDraft ? validateDraft : undefined,
      onCommit,
    });
    if (attempt.kind === 'readonly') {
      canceling.current = false;
      setDraft(null);
      setValidationError(null);
      commitFailed.current = false;
      onInvalidDraftChange?.(false);
      onDone?.();
      return true;
    }
    if (attempt.kind === 'invalid') {
      finished.current = false;
      setValidationError(attempt.error);
      onInvalidDraftChange?.(true);
      return false;
    }
    if (attempt.kind === 'committed') {
      const error = gridMode ? draftCommitFailure(attempt.result) : null;
      if (error) {
        finished.current = false;
        commitFailed.current = true;
        setValidationError(error);
        onInvalidDraftChange?.(true);
        return false;
      }
      undone.current.push({ before: value, after: attempt.draft });
      redone.current = [];
    }
    commitFailed.current = false;
    setValidationError(null);
    onInvalidDraftChange?.(false);
    setDraft(null);
    onDone?.();
    return true;
  };
  useEffect(() => {
    const lostPermission = wasEditable.current && !editable;
    wasEditable.current = editable;
    if (!lostPermission) return;
    finished.current = true;
    canceling.current = false;
    setDraft(null);
    setValidationError(null);
    commitFailed.current = false;
    onInvalidDraftChange?.(false);
    onDone?.();
  }, [editable, onDone, onInvalidDraftChange]);
  const stepHistory = (direction: 'undo' | 'redo') => {
    // typing that is not saved yet goes first
    if (direction === 'undo' && draft !== null && draft !== value) {
      setDraft(null);
      setValidationError(null);
      commitFailed.current = false;
      onInvalidDraftChange?.(false);
      return;
    }
    if (!isCellEditableNow(editable, canEditNow)) return;
    const [from, to] = direction === 'undo' ? [undone, redone] : [redone, undone];
    const change = from.current.pop();
    if (!change) return;
    to.current.push(change);
    setDraft(null);
    onCommit(direction === 'undo' ? change.before : change.after);
  };
  const stepRef = useRef(stepHistory);
  useEffect(() => {
    stepRef.current = stepHistory;
  });
  useEffect(() => {
    if (validationError) onInvalidDraftChange?.(true);
  }, [onInvalidDraftChange, validationError]);
  // undo and redo from the edit menu arrive as input events rather than keys
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return;
      event.preventDefault();
      stepRef.current(event.inputType === 'historyUndo' ? 'undo' : 'redo');
    };
    element.addEventListener('beforeinput', onBeforeInput);
    return () => element.removeEventListener('beforeinput', onBeforeInput);
  }, []);
  return (
    <input
      ref={input}
      type={type}
      inputMode={inputMode}
      autoFocus={autoFocus}
      min={min}
      max={max}
      step={step}
      className={className ?? 'prop-input'}
      aria-label={label}
      aria-invalid={validationError ? true : undefined}
      title={validationError ?? undefined}
      placeholder={placeholder ?? (editable ? t('database.empty') : '')}
      value={draft ?? value}
      readOnly={!editable}
      onFocus={(event) => placeInitialCellDraftCaret(event.currentTarget, initialCaretPending)}
      onChange={(event) => {
        finished.current = false;
        const next = event.target.value;
        const nextError = shouldValidateDraft ? (validateDraft?.(next) ?? null) : null;
        const visibleError = nextError ?? (commitFailed.current ? validationError : null);
        setValidationError(visibleError);
        onInvalidDraftChange?.(Boolean(visibleError));
        setDraft(next);
      }}
      onBlur={(event) => {
        if (!commit()) {
          const element = event.currentTarget;
          const pane = element.closest<HTMLElement>('.pane[data-pane]');
          const nextTarget = event.relatedTarget;
          if (!pane || !(nextTarget instanceof Element) || !pane.contains(nextTarget)) return;
          requestAnimationFrame(() => {
            const activeElement = pane.ownerDocument.activeElement;
            if (
              !element.isConnected ||
              !pane.isConnected ||
              pane.classList.contains('is-cached') ||
              pane.getAttribute('aria-hidden') === 'true' ||
              pane.getClientRects().length === 0 ||
              !pane.ownerDocument.hasFocus() ||
              !pane.classList.contains('is-active') ||
              activeElement?.closest('[data-pane]') !== pane
            ) return;
            element.focus({ preventScroll: true });
          });
        }
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!commit()) return;
          event.currentTarget.blur();
          if (gridMode && onCommitAndMove) {
            onCommitAndMove(event.shiftKey ? 'up' : 'down');
          }
        }
        if (event.key === 'Tab' && gridMode && onCommitAndMove) {
          event.preventDefault();
          if (!commit()) return;
          event.currentTarget.blur();
          onCommitAndMove(event.shiftKey ? 'prev' : 'next');
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          canceling.current = true;
          setDraft(null);
          setValidationError(null);
          commitFailed.current = false;
          onInvalidDraftChange?.(false);
          event.currentTarget.blur();
          if (gridMode && onCancelEdit) {
            onCancelEdit();
          }
        }
        const key = event.key.toLowerCase();
        if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
          event.preventDefault();
          stepHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo');
        }
      }}
    />
  );
}

function DraftTextarea({
  label,
  value,
  editable,
  canEditNow,
  autoFocus,
  onCommit,
  onDone,
  gridMode,
  onCommitAndMove,
  onCancelEdit,
  initialDraft,
  onInvalidDraftChange,
}: {
  label: string;
  value: string;
  editable: boolean;
  canEditNow?: () => boolean;
  autoFocus?: boolean;
  onCommit: (text: string) => DraftCommitResult;
  onDone?: () => void;
  gridMode?: boolean;
  onCommitAndMove?: (direction: 'down' | 'up' | 'next' | 'prev' | 'stay') => void;
  onCancelEdit?: () => void;
  initialDraft?: string;
  onInvalidDraftChange?: (invalid: boolean) => void;
}) {
  const [draft, setDraft] = useState<string | null>(() => initialDraft ?? null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const canceling = useRef(false);
  const finished = useRef(false);
  const commitFailed = useRef(false);
  const initialCaretPending = useRef(initialDraft !== undefined);
  const wasEditable = useRef(editable);
  const commit = (): boolean => {
    if (finished.current) return true;
    finished.current = true;
    if (canceling.current) {
      canceling.current = false;
      setDraft(null);
      setValidationError(null);
      commitFailed.current = false;
      onInvalidDraftChange?.(false);
      onDone?.();
      return true;
    }
    const attempt = attemptCellDraftCommit({ editable, canEditNow, draft, value, onCommit });
    if (attempt.kind === 'readonly') {
      canceling.current = false;
      setDraft(null);
      setValidationError(null);
      commitFailed.current = false;
      onInvalidDraftChange?.(false);
      onDone?.();
      return true;
    }
    if (attempt.kind === 'committed') {
      const error = gridMode ? draftCommitFailure(attempt.result) : null;
      if (error) {
        finished.current = false;
        commitFailed.current = true;
        setValidationError(error);
        onInvalidDraftChange?.(true);
        return false;
      }
    }
    commitFailed.current = false;
    setValidationError(null);
    onInvalidDraftChange?.(false);
    setDraft(null);
    onDone?.();
    return true;
  };
  useEffect(() => {
    const lostPermission = wasEditable.current && !editable;
    wasEditable.current = editable;
    if (!lostPermission) return;
    finished.current = true;
    canceling.current = false;
    setDraft(null);
    setValidationError(null);
    commitFailed.current = false;
    onInvalidDraftChange?.(false);
    onDone?.();
  }, [editable, onDone, onInvalidDraftChange]);
  return (
    <textarea
      className="prop-input prop-textarea"
      aria-label={label}
      aria-invalid={validationError ? true : undefined}
      title={validationError ?? undefined}
      value={draft ?? value}
      readOnly={!editable}
      autoFocus={autoFocus}
      rows={2}
      onFocus={(event) => placeInitialCellDraftCaret(event.currentTarget, initialCaretPending)}
      onChange={(event) => {
        finished.current = false;
        if (!commitFailed.current) {
          setValidationError(null);
          onInvalidDraftChange?.(false);
        }
        setDraft(event.target.value);
      }}
      onBlur={(event) => {
        if (!commit()) {
          const element = event.currentTarget;
          requestAnimationFrame(() => element.isConnected && element.focus({ preventScroll: true }));
        }
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          if (!commit()) return;
          event.currentTarget.blur();
          if (gridMode && onCommitAndMove) {
            onCommitAndMove('stay');
          }
          return;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          canceling.current = true;
          setDraft(null);
          setValidationError(null);
          commitFailed.current = false;
          onInvalidDraftChange?.(false);
          event.currentTarget.blur();
          if (gridMode && onCancelEdit) {
            onCancelEdit();
          }
          return;
        }
        if (event.key === 'Tab' && gridMode && onCommitAndMove) {
          event.preventDefault();
          if (!commit()) return;
          event.currentTarget.blur();
          onCommitAndMove(event.shiftKey ? 'prev' : 'next');
          return;
        }
        if (event.key === 'Enter' && gridMode && !event.shiftKey) {
          event.preventDefault();
          if (!commit()) return;
          event.currentTarget.blur();
          onCommitAndMove?.('down');
        }
      }}
    />
  );
}

function OptionPicker({
  dbId,
  prop,
  row,
  selected,
  anchor,
  initialQuery,
  editable,
  canEditNow,
  onGridTab,
  onClose,
}: {
  dbId: PageId;
  prop: PropDef;
  row: PageMeta;
  selected: string[];
  anchor: HTMLElement;
  initialQuery?: string;
  editable: boolean;
  canEditNow?: () => boolean;
  onGridTab?: (direction: 'next' | 'prev') => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(() => initialQuery ?? '');
  const multi = prop.type === 'multiSelect';
  const shown = prop.options.filter((option) =>
    option.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const exact = prop.options.some((option) => option.name.toLowerCase() === query.trim().toLowerCase());
  const choose = (id: string) => {
    if (!isCellEditableNow(editable, canEditNow)) return;
    if (multi) {
      const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
      setValue(row.id, prop.id, next.length ? next : null);
    } else {
      setValue(row.id, prop.id, selected[0] === id ? null : id);
      onClose();
    }
  };
  const handleGridTab = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !onGridTab) return;
    event.preventDefault();
    event.stopPropagation();
    onGridTab(event.shiftKey ? 'prev' : 'next');
  };
  const create = () => {
    if (!isCellEditableNow(editable, canEditNow)) return;
    const option = ensureOption(dbId, prop.id, query);
    if (!option) return;
    setQuery('');
    if (multi) setValue(row.id, prop.id, [...selected.filter((id) => id !== option.id), option.id]);
    else {
      setValue(row.id, prop.id, option.id);
      onClose();
    }
  };
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      label={t('database.chooseAria', { name: prop.name })}
      className="option-picker"
    >
      <input
        className="text-input small"
        data-autofocus
        placeholder={prop.options.length ? t('database.findOrCreateOption') : t('database.createOption')}
        aria-label={t('database.option')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          handleGridTab(event);
          if (event.defaultPrevented) return;
          if (event.key !== 'Enter') return;
          event.preventDefault();
          if (query.trim() && !exact) create();
          else if (shown[0]) choose(shown[0].id);
        }}
      />
      <ul className="option-list" role="listbox" aria-multiselectable={multi}>
        {shown.map((option) => (
          <li key={option.id}>
            <button
              type="button"
              role="option"
              aria-selected={selected.includes(option.id)}
              className="option-row"
              onClick={() => choose(option.id)}
              onKeyDown={handleGridTab}
            >
              <Chip option={option} />
              {selected.includes(option.id) && <Check size={14} className="option-check" />}
            </button>
          </li>
        ))}
        {query.trim() && !exact && (
          <li>
            <button type="button" className="option-row" onClick={create} onKeyDown={handleGridTab}>
              <Plus size={14} /> {t('database.create')}
              <Chip option={{ name: query.trim(), color: 'gray' }} />
            </button>
          </li>
        )}
        {selected.length > 0 && (
          <li>
            <button
              type="button"
              className="option-row muted"
              onKeyDown={handleGridTab}
              onClick={() => {
                if (!isCellEditableNow(editable, canEditNow)) return;
                setValue(row.id, prop.id, null);
                onClose();
              }}
            >
              <X size={14} /> {t('database.clear')}
            </button>
          </li>
        )}
      </ul>
    </Popover>
  );
}

export function NewProperty({
  dbId,
  database,
  onDone,
}: {
  dbId: PageId;
  database: DatabaseDef;
  onDone?: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<PropType>('text');
  const add = () => {
    const clean = name.trim();
    if (!clean) return;
    if (
      reservedPropertyName(clean) ||
      database.properties.some((prop) => prop.name.toLowerCase() === clean.toLowerCase())
    ) {
      toast(t('toasts.propNameDuplicate', { name: clean }), { tone: 'error' });
      return;
    }
    updateDatabase(dbId, (current) => ({
      ...current,
      properties: [
        ...current.properties,
        {
          id: newId(),
          name: clean,
          type,
          options: [],
          ...(type === 'button'
            ? { action: { label: clean, icon: 'play' as const, color: 'blue' as const, steps: [] } }
            : {}),
          ...(type === 'image' || type === 'file' ? { media: { multiple: false } } : {}),
        },
      ],
    }));
    setName('');
    onDone?.();
  };
  return (
    <form
      className="db-rule"
      onSubmit={(event) => {
        event.preventDefault();
        add();
      }}
    >
      <input
        className="text-input small"
        placeholder={t('database.newProperty')}
        aria-label={t('page.newPropertyNameAria')}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <PropertyTypeSelect value={type} onChange={setType} />
      <button type="submit" className="button small" disabled={!name.trim()}>
        {t('common.add')}
      </button>
    </form>
  );
}

function FormulaCell({ dbId, prop, row }: { dbId: PageId; prop: PropDef; row: PageMeta }) {
  const state = useWorkspace();
  const database = state.pages[dbId]?.database;
  if (!database) return null;
  const result = formulaResult(row, prop, database, 0, state);
  if (result.error)
    return (
      <span className="formula-error" title={result.error}>
        {t('database.error')}
      </span>
    );
  const value = valueOf(row, prop.id, database, state);
  const effectiveProp =
    prop.type === 'formula' && prop.formulaResultType ? { ...prop, type: prop.formulaResultType } : prop;
  if (isMediaProperty(effectiveProp.type)) return <MediaPropertyDisplay prop={effectiveProp} value={value} />;
  if ((effectiveProp.display === 'bar' || effectiveProp.type === 'progress') && typeof value === 'number')
    return (
      <ProgressBar
        value={value}
        min={effectiveProp.format?.min}
        max={effectiveProp.format?.max ?? effectiveProp.max}
        color={effectiveProp.format?.color}
        label={effectiveProp.format?.showValue ? formatValue(effectiveProp, value) : undefined}
        showPercent={effectiveProp.format?.showValue === undefined && effectiveProp.display === 'bar'}
      />
    );
  if (effectiveProp.type === 'scale' && typeof value === 'number') {
    return <PropertyDisplay prop={effectiveProp} value={value} />;
  }
  return <span className="prop-text formula-value">{formulaValueText(prop, result.value, state)}</span>;
}

// pick pages to relate a row to, searching every page by title
export function RelationPicker({
  row,
  prop,
  targets,
  anchor,
  initialQuery,
  editable = true,
  canEditNow,
  onGridTab,
  onClose,
  onChange,
}: {
  row?: PageMeta;
  prop: PropDef;
  targets: string[];
  anchor: HTMLElement;
  initialQuery?: string;
  editable?: boolean;
  canEditNow?: () => boolean;
  onGridTab?: (direction: 'next' | 'prev') => void;
  onClose: () => void;
  onChange?: (targets: string[]) => void;
}) {
  const state = useWorkspace();
  const [query, setQuery] = useState(() => initialQuery ?? '');
  const chosen = new Set(targets);
  const found = relationOptions(state, prop, query).slice(0, 100);
  const multi = prop.relation?.multiple === true;
  const handleGridTab = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab' || !onGridTab) return;
    event.preventDefault();
    event.stopPropagation();
    onGridTab(event.shiftKey ? 'prev' : 'next');
  };
  const toggle = (targetId: string) => {
    if (!isCellEditableNow(editable, canEditNow)) return;
    if (!multi) {
      if (onChange) onChange(chosen.has(targetId) ? [] : [targetId]);
      else if (row) setValue(row.id, prop.id, chosen.has(targetId) ? null : targetId);
      onClose();
      return;
    }
    const next = chosen.has(targetId)
      ? targets.filter((target) => target !== targetId)
      : [...targets, targetId];
    if (onChange) onChange(next);
    else if (row) setValue(row.id, prop.id, next.length ? next : null);
  };
  return (
    <Popover
      anchor={anchor}
      onClose={onClose}
      label={t('database.relate', { title: row ? displayTitle(row) : prop.name })}
      className="db-panel relation-picker"
    >
      {!prop.relation?.targetDatabaseId ? (
        <p className="muted small">{t('database.relationChooseTable')}</p>
      ) : (
        <>
          <input
            className="text-input small"
            data-autofocus
            placeholder={t('database.searchPages')}
            aria-label={t('database.searchPages')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleGridTab}
          />
          <ul className="relation-list" role="listbox" aria-multiselectable={multi}>
            {found.map((page) => {
              const label = relationDisplayLabel(state, prop, page);
              const on = chosen.has(page.id);
              return (
                <li key={page.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`relation-option${on ? ' is-on' : ''}`}
                    onClick={() => toggle(page.id)}
                    onKeyDown={handleGridTab}
                  >
                    <PageIcon page={page} />
                    <span>{label}</span>
                    {on && <Check size={13} />}
                  </button>
                </li>
              );
            })}
            {found.length === 0 && <li className="muted small">{t('database.noPagesMatch')}</li>}
          </ul>
          {row && prop.relation && relationDiagnostics(state, row, prop).length > 0 && (
            <p className="db-relation-warning" role="status">
              {t('database.relationMigrationWarning', {
                count: relationDiagnostics(state, row, prop).length,
              })}
            </p>
          )}
        </>
      )}
    </Popover>
  );
}

function relationDiagnosticLabel(
  diagnostic: NonNullable<ReturnType<typeof resolveRelationReference>['diagnostic']>,
): string {
  switch (diagnostic.code) {
    case 'unconfigured':
      return t('database.relationDiagnosticUnconfigured');
    case 'target-database-missing':
      return t('database.relationDiagnosticDatabaseMissing');
    case 'target-outside-database':
      return t('database.relationDiagnosticOutsideTable');
    case 'target-trashed':
      return t('database.relationDiagnosticTrashed');
    case 'legacy-title':
      return t('database.relationDiagnosticLegacy');
    case 'legacy-ambiguous':
      return t('database.relationDiagnosticAmbiguous', { count: diagnostic.count ?? 0 });
    case 'target-missing':
      return t('database.relationDiagnosticMissing');
    case 'inverse-missing':
      return t('database.relationDiagnosticInverseMissing');
    case 'inverse-mismatch':
      return t('database.relationDiagnosticInverseMismatch');
    case 'cardinality-mismatch':
      return t('database.relationDiagnosticCardinality');
    case 'invalid-filter':
      return t('database.relationDiagnosticFilter');
    case 'unsupported-value':
      return t('database.relationDiagnosticUnsupported');
  }
}
