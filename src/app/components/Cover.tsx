import { ImageIcon, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { COVER_GRADIENTS, DEFAULT_COVER_POSITION } from '../../core/model';
import type { PageMeta } from '../../core/model';
import { fileUrl, storeFiles } from '../platform/attachments';
import { pickFiles } from '../platform/files';
import { run } from '../workspace';
import { Popover } from './Popover';
import { t } from '../i18n';

export function setCover(page: PageMeta, cover: string | null, coverPosition = DEFAULT_COVER_POSITION) {
  return run({ type: 'page.setCover', id: page.id, cover, coverPosition, now: Date.now() });
}

// a gradient is a css class, an image cover is a file in the vault
export function useCover(cover: string | null): { className: string; image: string | null } {
  const [image, setImage] = useState<string | null>(null);
  const isGradient = cover?.startsWith('gradient-') ?? false;
  useEffect(() => {
    let live = true;
    if (cover && !isGradient) void fileUrl(cover).then((url) => live && setImage(url));
    return () => {
      live = false;
    };
  }, [cover, isGradient]);
  if (!cover) return { className: '', image: null };
  return isGradient ? { className: `cover-${cover}`, image: null } : { className: 'cover-image', image };
}

export function CoverBanner({ page, editable }: { page: PageMeta; editable: boolean }) {
  const { className, image } = useCover(page.cover);
  const [picker, setPicker] = useState<HTMLElement | null>(null);
  if (!page.cover) return null;
  return (
    <div
      className={`page-cover ${className}`}
      style={
        image
          ? { backgroundImage: `url("${image}")`, backgroundPosition: `center ${page.coverPosition}%` }
          : undefined
      }
    >
      {editable && (
        <div className="page-cover-actions">
          <button type="button" className="button small" onClick={(event) => setPicker(event.currentTarget)}>
            {t('page.changeCover')}
          </button>
        </div>
      )}
      {picker && <CoverPicker page={page} anchor={picker} onClose={() => setPicker(null)} />}
    </div>
  );
}

export function CoverPicker({
  page,
  anchor,
  onClose,
}: {
  page: PageMeta;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const [draftCover, setDraftCover] = useState<string | null>(page.cover);
  const [draftPosition, setDraftPosition] = useState(page.coverPosition);
  const [draftFile, setDraftFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const pointer = useRef<number | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const { className: coverClass, image: coverImage } = useCover(draftFile ? null : draftCover);
  const fileImage = useMemo(() => (draftFile ? URL.createObjectURL(draftFile) : null), [draftFile]);
  useEffect(
    () => () => {
      if (fileImage) URL.revokeObjectURL(fileImage);
    },
    [fileImage],
  );
  const backgroundImage = fileImage ?? coverImage;
  const hasImage = Boolean(draftFile || (draftCover && !draftCover.startsWith('gradient-')));
  const close = () => {
    if (!saving) onClose();
  };
  const place = (clientY: number) => {
    const rect = preview.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    setDraftPosition(Math.round(Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100))));
  };
  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      let cover = draftCover;
      if (draftFile) {
        const [stored] = await storeFiles([draftFile]);
        if (!stored) return;
        cover = stored.id;
      }
      const result = setCover(page, cover, cover ? draftPosition : DEFAULT_COVER_POSITION);
      if (result.ok) onClose();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Popover anchor={anchor} onClose={close} label={t('page.cover')} className="cover-picker">
      <div
        ref={preview}
        className={`cover-draft-preview${backgroundImage ? ' cover-image' : ''} ${coverClass}`}
        role="group"
        style={{
          ...(backgroundImage ? { backgroundImage: `url("${backgroundImage}")` } : {}),
          ...(draftCover?.startsWith('gradient-') ? {} : { backgroundPosition: `center ${draftPosition}%` }),
        }}
        aria-label={t('page.coverPreview')}
        onPointerDown={(event) => {
          if (!hasImage) return;
          pointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          place(event.clientY);
        }}
        onPointerMove={(event) => pointer.current === event.pointerId && place(event.clientY)}
        onPointerUp={(event) => {
          if (pointer.current === event.pointerId) pointer.current = null;
        }}
        onPointerCancel={() => {
          pointer.current = null;
        }}
      >
        {!draftCover && !draftFile && <span>{t('page.chooseCoverPreview')}</span>}
      </div>
      <div className="cover-grid">
        {Array.from({ length: COVER_GRADIENTS }, (_, index) => `gradient-${index + 1}`).map((cover) => (
          <button
            key={cover}
            type="button"
            className={`cover-choice cover-${cover}${draftCover === cover && !draftFile ? ' is-active' : ''}`}
            aria-label={t('page.gradient', { number: cover.slice(9) })}
            onClick={() => {
              setDraftFile(null);
              setDraftCover(cover);
            }}
          />
        ))}
      </div>
      <label className="cover-position-control">
        <span>{t('page.coverPosition')}</span>
        <input
          type="range"
          min="0"
          max="100"
          value={draftPosition}
          disabled={!hasImage}
          aria-label={t('page.coverPosition')}
          onChange={(event) => setDraftPosition(Number(event.target.value))}
        />
        <output>{draftPosition}%</output>
      </label>
      <div className="popover-actions">
        <button
          type="button"
          className="button small"
          onClick={() =>
            void pickFiles('image/*', false).then((files) => {
              if (!files[0]) return;
              setDraftFile(files[0]);
              setDraftCover(null);
            })
          }
        >
          <ImageIcon size={13} /> {t('page.useAnImage')}
        </button>
        {(draftCover || draftFile) && (
          <button
            type="button"
            className="button small danger"
            onClick={() => {
              setDraftCover(null);
              setDraftFile(null);
            }}
          >
            <Trash2 size={13} /> {t('common.remove')}
          </button>
        )}
      </div>
      <div className="popover-actions cover-save-actions">
        <button type="button" className="button small" disabled={saving} onClick={() => void save()}>
          {t('common.save')}
        </button>
        <button type="button" className="button small" disabled={saving} onClick={close}>
          {t('common.cancel')}
        </button>
      </div>
    </Popover>
  );
}
