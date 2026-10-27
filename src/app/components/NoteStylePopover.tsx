import { useState } from 'react';
import type { NoteStyle, PageMeta } from '../../core/model';
import { run } from '../workspace';
import { Popover } from './Popover';
import { NoteStyleControls } from './NoteStyleControls';
import { t } from '../i18n';

export function NoteStylePopover({
  page,
  style,
  defaults,
  anchor,
  onClose,
}: {
  page: PageMeta;
  style: NoteStyle;
  defaults: NoteStyle;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(style);
  const sampleStyle = {
    '--note-font-size': `${draft.fontSize}px`,
    '--note-line-height': draft.lineHeight,
    '--note-block-spacing': `${draft.blockSpacing}px`,
  } as React.CSSProperties;
  const previewWidths = { comfortable: '68%', wide: '84%', full: '100%' } as const;
  const save = (next: NoteStyle) => {
    const result = run({ type: 'page.setNoteStyle', id: page.id, style: next, now: Date.now() });
    if (result.ok) onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} label={t('page.style.title')} className="note-style-popover">
      <NoteStyleControls style={draft} onChange={setDraft} />
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
        <button type="button" className="button small" onClick={() => save(defaults)}>
          {t('page.style.reset')}
        </button>
      </div>
    </Popover>
  );
}
