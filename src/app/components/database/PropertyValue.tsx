import { AlertTriangle, Check, Pencil, Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
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
import { PROP_TYPES } from '../../../core/model';
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
import { propLabel } from '../../i18n/labels';
import { durationUnitFactor } from '../../../core/typedValues';
import { scalarValueError } from '../../../core/typedValues';
import { isMediaProperty } from '../../../core/propertyMedia';
import { MediaPropertyDisplay, MediaPropertyInput } from './MediaProperty';
import { ButtonActionCell } from './TableActionCell';

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
  if (value === null || value === undefined || value === '' || value === false) return null;
  if (isMediaProperty(prop.type)) return <MediaPropertyDisplay prop={prop} value={value} />;
  if ((prop.display === 'bar' || prop.type === 'progress') && typeof value === 'number')
    return (
      <ProgressBar
        value={value}
        min={prop.format?.min}
        max={prop.format?.max ?? prop.max}
        color={prop.format?.color}
        label={prop.format?.showValue ? formatValue(prop, value) : undefined}
        showPercent={prop.format?.showValue === undefined && prop.display === 'bar'}
      />
    );
  if (prop.type === 'scale' && typeof value === 'number' && (prop.format?.scaleIcon ?? 'star') === 'star') {
    const min = prop.format?.min ?? 1;
    const max = prop.format?.max ?? 5;
    const total = Math.max(1, Math.round(max - min + 1));
    const filled = Math.min(total, Math.max(0, Math.round(value - min + 1)));
    return (
      <span
        className="prop-scale-stars"
        aria-label={formatValue(prop, value)}
        title={formatValue(prop, value)}
        style={prop.format?.color ? { color: TEXT_HEX[prop.format.color] } : undefined}
      >
        {'★'.repeat(filled)}
        <span>{'☆'.repeat(total - filled)}</span>
        {prop.format?.showValue && <small>{` ${formatValue(prop, value)}`}</small>}
      </span>
    );
  }
  switch (prop.type) {
    case 'select': {
      const option = prop.options.find((candidate) => candidate.id === value);
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
        <span className="prop-check">
          <Check size={12} /> {prop.name}
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
}: {
  dbId: PageId;
  prop: PropDef;
  row: PageMeta;
  editable: boolean;
}) {
  const state = useWorkspace();
  const database = state.pages[dbId]?.database;
  const value = database ? valueOf(row, prop.id, database, state) : (row.properties[prop.id] ?? null);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  const [editing, setEditing] = useState(false);
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
  const stopEditing = () => setEditing(false);

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
  if (scalarInput && !editable) return <PropertyDisplay prop={prop} value={value} />;
  if (scalarInput && !editing && ['email', 'url', 'phone'].includes(prop.type))
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
  if (scalarInput && !editing)
    return (
      <button type="button" className="prop-cell-value" aria-label={label} onClick={() => setEditing(true)}>
        {value === null || value === '' ? (
          <span className="prop-empty">{t('database.empty')}</span>
        ) : (
          <PropertyDisplay prop={prop} value={value} />
        )}
      </button>
    );
  const cellEditable = editable && (!scalarInput || editing);

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
              onClose={() => setPicker(null)}
            />
          )}
        </>
      );
    }
    case 'checkbox':
      return (
        <input
          type="checkbox"
          className="prop-checkbox"
          aria-label={label}
          checked={value === true}
          disabled={!editable}
          onChange={(event) => setValue(row.id, prop.id, event.target.checked)}
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
      const input = (
        <DraftInput
          type="number"
          label={label}
          value={typeof value === 'number' ? String(value * multiplier) : ''}
          editable={cellEditable}
          autoFocus={editing}
          onDone={stopEditing}
          min={prop.format?.min === undefined ? undefined : prop.format.min * multiplier}
          max={prop.format?.max === undefined ? undefined : prop.format.max * multiplier}
          step={prop.format?.step === undefined ? undefined : prop.format.step * multiplier}
          onCommit={(text) => {
            const number = Number(text);
            setValue(row.id, prop.id, text.trim() && Number.isFinite(number) ? number / multiplier : null);
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
      return (
        <span className="prop-range-edit">
          <input
            type="range"
            className="prop-range"
            aria-label={label}
            aria-valuetext={typeof value === 'number' ? formatValue(prop, value) : undefined}
            min={min}
            max={max}
            step={step}
            value={typeof value === 'number' ? value : min}
            disabled={!cellEditable}
            autoFocus={editing}
            style={prop.format?.color ? { accentColor: TEXT_HEX[prop.format.color] } : undefined}
            onChange={(event) => setValue(row.id, prop.id, Number(event.target.value))}
            onBlur={stopEditing}
          />
          {prop.format?.showValue !== false && (
            <span className="prop-range-value">
              {typeof value === 'number' ? formatValue(prop, value) : '—'}
            </span>
          )}
        </span>
      );
    }
    case 'date':
      return (
        <input
          type="date"
          className="prop-input"
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          disabled={!cellEditable}
          autoFocus={editing}
          onChange={(event) => setValue(row.id, prop.id, event.target.value || null)}
          onBlur={stopEditing}
        />
      );
    case 'time':
      return (
        <input
          type="time"
          className="prop-input"
          aria-label={label}
          value={typeof value === 'string' ? value : ''}
          disabled={!cellEditable}
          autoFocus={editing}
          onChange={(event) => setValue(row.id, prop.id, event.target.value || null)}
          onBlur={stopEditing}
        />
      );
    case 'datetime': {
      const local = typeof value === 'string' ? toDateTimeLocal(value) : '';
      return (
        <input
          type="datetime-local"
          className="prop-input"
          aria-label={label}
          value={local}
          disabled={!cellEditable}
          autoFocus={editing}
          onChange={(event) => {
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
            autoFocus={editing}
            onDone={stopEditing}
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
              onClose={() => setPicker(null)}
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
          autoFocus={editing}
          onDone={stopEditing}
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
          autoFocus={editing}
          onDone={stopEditing}
          onCommit={(text) => setValue(row.id, prop.id, text)}
        />
      );
  }
}

// keeps typing local and saves on blur or enter, so every keystroke is not a separate change
export function DraftInput({
  type,
  label,
  value,
  editable,
  onCommit,
  placeholder,
  className,
  autoFocus,
  min,
  max,
  step,
  onDone,
}: {
  type: 'text' | 'number' | 'url';
  label: string;
  value: string;
  editable: boolean;
  onCommit: (text: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  min?: number;
  max?: number;
  step?: number;
  // called when the input loses focus, changed or not
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const canceling = useRef(false);
  const commit = () => {
    if (canceling.current) {
      canceling.current = false;
      setDraft(null);
      onDone?.();
      return;
    }
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
    onDone?.();
  };
  return (
    <input
      type={type}
      autoFocus={autoFocus}
      min={min}
      max={max}
      step={step}
      className={className ?? 'prop-input'}
      aria-label={label}
      placeholder={placeholder ?? (editable ? t('database.empty') : '')}
      value={draft ?? value}
      readOnly={!editable}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          canceling.current = true;
          setDraft(null);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function DraftTextarea({
  label,
  value,
  editable,
  autoFocus,
  onCommit,
  onDone,
}: {
  label: string;
  value: string;
  editable: boolean;
  autoFocus?: boolean;
  onCommit: (text: string) => void;
  onDone?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const canceling = useRef(false);
  const commit = () => {
    if (canceling.current) {
      canceling.current = false;
      setDraft(null);
      onDone?.();
      return;
    }
    if (draft !== null && draft !== value) onCommit(draft);
    setDraft(null);
    onDone?.();
  };
  return (
    <textarea
      className="prop-input prop-textarea"
      aria-label={label}
      value={draft ?? value}
      readOnly={!editable}
      autoFocus={autoFocus}
      rows={2}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          canceling.current = true;
          setDraft(null);
          event.currentTarget.blur();
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
  onClose,
}: {
  dbId: PageId;
  prop: PropDef;
  row: PageMeta;
  selected: string[];
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const multi = prop.type === 'multiSelect';
  const shown = prop.options.filter((option) =>
    option.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const exact = prop.options.some((option) => option.name.toLowerCase() === query.trim().toLowerCase());
  const choose = (id: string) => {
    if (multi) {
      const next = selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id];
      setValue(row.id, prop.id, next.length ? next : null);
    } else {
      setValue(row.id, prop.id, selected[0] === id ? null : id);
      onClose();
    }
  };
  const create = () => {
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
            >
              <Chip option={option} />
              {selected.includes(option.id) && <Check size={14} className="option-check" />}
            </button>
          </li>
        ))}
        {query.trim() && !exact && (
          <li>
            <button type="button" className="option-row" onClick={create}>
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
              onClick={() => {
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
      <select
        className="text-input small"
        aria-label={t('database.type')}
        value={type}
        onChange={(event) => setType(event.target.value as PropType)}
      >
        {PROP_TYPES.map((item) => (
          <option key={item} value={item}>
            {propLabel(item)}
          </option>
        ))}
      </select>
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
  if (isMediaProperty(prop.type)) return <MediaPropertyDisplay prop={prop} value={value} />;
  if ((prop.display === 'bar' || prop.type === 'progress') && typeof value === 'number')
    return (
      <ProgressBar
        value={value}
        min={prop.format?.min}
        max={prop.format?.max ?? prop.max}
        color={prop.format?.color}
        label={prop.format?.showValue ? formatValue(prop, value) : undefined}
        showPercent={prop.format?.showValue === undefined && prop.display === 'bar'}
      />
    );
  return <span className="prop-text formula-value">{formulaValueText(prop, result.value, state)}</span>;
}

// pick pages to relate a row to, searching every page by title
export function RelationPicker({
  row,
  prop,
  targets,
  anchor,
  onClose,
  onChange,
}: {
  row?: PageMeta;
  prop: PropDef;
  targets: string[];
  anchor: HTMLElement;
  onClose: () => void;
  onChange?: (targets: string[]) => void;
}) {
  const state = useWorkspace();
  const [query, setQuery] = useState('');
  const chosen = new Set(targets);
  const found = relationOptions(state, prop, query).slice(0, 100);
  const multi = prop.relation?.multiple === true;
  const toggle = (targetId: string) => {
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
