import { useRef, useState } from 'react';
import type { NamedControlDef, PropValue } from '../../core/model';
import { t } from '../i18n';

interface NamedMultiSelectPickerProps {
  label: string;
  options: NamedControlDef['options'];
  value: PropValue;
  onChange: (value: string[] | null) => void;
  disabled?: boolean;
  invalid?: boolean;
  previousOptions?: NamedControlDef['options'];
  showBlankActions?: boolean;
}

export function NamedMultiSelectPicker({
  label,
  options,
  value,
  onChange,
  disabled = false,
  invalid = false,
  previousOptions = [],
  showBlankActions = false,
}: NamedMultiSelectPickerProps) {
  const [query, setQuery] = useState('');
  const optionIds = new Set(options.map((option) => option.id));
  const selected = Array.isArray(value) ? value : [];
  const labels = new Map([...previousOptions, ...options].map((option) => [option.id, option.name]));
  const filtered = options.filter((option) => option.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const checkboxRefs = useRef<Array<HTMLInputElement | null>>([]);
  const updateValue = (next: string[] | null) => {
    if (!disabled) onChange(next);
  };
  const changeSelection = (id: string, checked: boolean) => {
    if (disabled) return;
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    updateValue([
      ...options.filter((option) => next.has(option.id)).map((option) => option.id),
      ...selected.filter((item) => !optionIds.has(item) && next.has(item)),
    ]);
  };
  const unavailable = selected.filter((id) => !optionIds.has(id));
  const status = value === null
    ? t('controls.blank')
    : Array.isArray(value)
      ? value.length === 0 ? t('controls.emptySelection') : ''
      : t('controls.chooseMultipleValues');

  return <span className="named-control-multi-select" role="group" aria-label={label} aria-invalid={invalid}>
    {selected.length > 0 && <span className="named-control-chips" role="group" aria-label={t('controls.selectedOptions')}>
      {selected.map((id, index) => {
        const name = labels.get(id) ?? t('controls.unavailableOption', { id });
        return <span className={`named-control-chip${optionIds.has(id) ? '' : ' is-unavailable'}`} key={`${id}-${index}`}>
          <span>{name}</span>
          <button type="button" disabled={disabled} aria-label={t('controls.removeOption', { name })} onClick={() => updateValue(selected.filter((item) => item !== id))}>×</button>
        </span>;
      })}
    </span>}
    {unavailable.length > 0 && <span className="named-data-diagnostic" role="status">{t('controls.unavailableSelection')}</span>}
    {status && <span className="named-control-selection-status" aria-live="polite">{status}</span>}
    {showBlankActions && <span className="named-control-empty-actions">
      <button type="button" disabled={disabled} aria-pressed={value === null} onClick={() => updateValue(null)}>{t('controls.blank')}</button>
      <button type="button" disabled={disabled} aria-pressed={Array.isArray(value) && value.length === 0} onClick={() => updateValue([])}>{t('controls.emptySelection')}</button>
    </span>}
    <label className="named-control-search">{t('controls.searchOptions')}
      <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
        if (event.key === 'ArrowDown' && filtered.length > 0) {
          event.preventDefault();
          checkboxRefs.current[0]?.focus();
        }
      }} />
    </label>
    <span className="named-control-option-list" role="group" aria-label={t('controls.options')}>
      {filtered.map((option, index) => <label className="named-control-option" key={option.id}>
        <input
          ref={(element) => { checkboxRefs.current[index] = element; }}
          type="checkbox"
          value={option.id}
          checked={selected.includes(option.id)}
          disabled={disabled}
          onChange={(event) => changeSelection(option.id, event.target.checked)}
        />
        <span>{option.name}</span>
      </label>)}
      {filtered.length === 0 && <span className="named-control-no-options">{t('controls.noMatchingOptions')}</span>}
    </span>
  </span>;
}
