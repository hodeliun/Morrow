import type { NoteFont, NoteStyle, NoteWidth } from '../../core/model';
import { t } from '../i18n';

export function NoteStyleControls({
  style,
  onChange,
}: {
  style: NoteStyle;
  onChange: (style: NoteStyle) => void;
}) {
  const update = <K extends keyof NoteStyle>(key: K, value: NoteStyle[K]) =>
    onChange({ ...style, [key]: value });
  return (
    <div className="note-style-controls">
      <label className="note-style-field">
        <span>{t('page.style.font')}</span>
        <select
          className="text-input small"
          aria-label={t('page.style.font')}
          value={style.font}
          onChange={(event) => update('font', event.target.value as NoteFont)}
        >
          <option value="sans">{t('settings.appearance.fonts.sans')}</option>
          <option value="serif">{t('settings.appearance.fonts.serif')}</option>
          <option value="mono">{t('settings.appearance.fonts.mono')}</option>
        </select>
      </label>
      <label className="note-style-field">
        <span>{t('page.style.fontSize')}</span>
        <input
          type="range"
          min="12"
          max="32"
          step="0.5"
          value={style.fontSize}
          aria-label={t('page.style.fontSize')}
          onChange={(event) => update('fontSize', Number(event.target.value))}
        />
        <output>{t('page.style.pixels', { value: style.fontSize })}</output>
      </label>
      <label className="note-style-field">
        <span>{t('page.style.lineHeight')}</span>
        <input
          type="range"
          min="1.2"
          max="2.4"
          step="0.01"
          value={style.lineHeight}
          aria-label={t('page.style.lineHeight')}
          onChange={(event) => update('lineHeight', Number(event.target.value))}
        />
        <output>{style.lineHeight.toFixed(2)}</output>
      </label>
      <label className="note-style-field">
        <span>{t('page.style.blockSpacing')}</span>
        <input
          type="range"
          min="0"
          max="40"
          step="1"
          value={style.blockSpacing}
          aria-label={t('page.style.blockSpacing')}
          onChange={(event) => update('blockSpacing', Number(event.target.value))}
        />
        <output>{t('page.style.pixels', { value: style.blockSpacing })}</output>
      </label>
      <label className="note-style-field">
        <span>{t('page.style.width')}</span>
        <select
          className="text-input small"
          aria-label={t('page.style.width')}
          value={style.width}
          onChange={(event) => update('width', event.target.value as NoteWidth)}
        >
          <option value="comfortable">{t('settings.appearance.widths.comfortable')}</option>
          <option value="wide">{t('settings.appearance.widths.wide')}</option>
          <option value="full">{t('settings.appearance.widths.full')}</option>
        </select>
      </label>
    </div>
  );
}
