import { useState } from 'react';
import type { NoteStyle, PageMeta } from '../../core/model';
import { runAll } from '../workspace';
import { Popover } from './Popover';
import { NoteStyleControls } from './NoteStyleControls';
import { t } from '../i18n';
import { Switch } from './primitives';

export function NoteStylePopover({
  page,
  style,
  defaults,
  resultBackgroundDefault,
  anchor,
  onClose,
}: {
  page: PageMeta;
  style: NoteStyle;
  defaults: NoteStyle;
  resultBackgroundDefault: boolean;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(style);
  const [resultBackground, setResultBackground] = useState(page.calculatedResultBackground ?? true);
  const [resultBackgroundTouched, setResultBackgroundTouched] = useState(false);
  const sampleStyle = {
    '--note-font-size': `${draft.fontSize}px`,
    '--note-line-height': draft.lineHeight,
    '--note-block-spacing': `${draft.blockSpacing}px`,
  } as React.CSSProperties;
  const previewWidths = { comfortable: '68%', wide: '84%', full: '100%' } as const;
  const save = (next: NoteStyle, background = resultBackgroundTouched ? resultBackground : undefined) => {
    const now = Date.now();
    const commands = [
      { type: 'page.setNoteStyle' as const, id: page.id, style: next, now },
      ...(background !== undefined
        ? [{ type: 'page.setCalculatedResultBackground' as const, id: page.id, enabled: background, now }]
        : []),
    ];
    const result = runAll(commands);
    if (result.ok) onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} label={t('page.style.title')} className="note-style-popover">
      <NoteStyleControls style={draft} onChange={setDraft} />
      <div className="note-style-result-background">
        <span>{t('page.style.resultBackground')}</span>
        <Switch
          label={t('page.style.resultBackground')}
          checked={resultBackground}
          onChange={(enabled) => {
            setResultBackground(enabled);
            setResultBackgroundTouched(true);
          }}
        />
        <small>{t('page.style.resultBackgroundHelp')}</small>
      </div>
      <div className="note-style-preview-frame">
        <span className="note-style-preview-label">{t('page.style.previewWidth')}</span>
        <div
          className={`note-style-preview font-${draft.font}`}
          style={{ ...sampleStyle, width: previewWidths[draft.width] }}
        >
          <strong>{t('page.style.previewHeading')}</strong>
          <span>{t('page.style.previewBody')}</span>
        </div>
      </div>
      <div className="popover-actions">
        <button type="button" className="button small" onClick={() => save(draft)}>
          {t('common.save')}
        </button>
        <button type="button" className="button small" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button type="button" className="button small" onClick={() => save(defaults, resultBackgroundDefault)}>
          {t('page.style.reset')}
        </button>
      </div>
    </Popover>
  );
}
