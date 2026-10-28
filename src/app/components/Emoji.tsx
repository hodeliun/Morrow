import { icons } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { parsePageIcon, sanitizeSvg } from '../../core/icons';
import { fileUrl } from '../platform/attachments';
import { getSession } from '../workspace';
import { EMOJI_FILES } from 'virtual:morrow-emoji';

const LUCIDE_ICONS = icons as Record<string, LucideIcon>;
export const LUCIDE_ICON_NAMES = Object.keys(LUCIDE_ICONS).sort((a, b) => a.localeCompare(b));

// the image for an emoji, trying the spellings the image set uses for variation selectors and keycaps
export function emojiSrc(emoji: string): string | null {
  const points = [...emoji].map((char) => char.codePointAt(0)!.toString(16));
  const plain = points.filter((point) => point !== 'fe0f');
  const candidates = [
    points.join('-'),
    plain.join('-'),
    [...plain, 'fe0f'].join('-'),
    points.map((point) => point.padStart(4, '0')).join('-'),
  ];
  for (const name of candidates) if (EMOJI_FILES.has(name)) return `./emoji/${name}.webp`;
  return null;
}

// page icons and other emoji in the interface, drawn the same on every system
export function Emoji({ emoji, className, size }: { emoji: string; className?: string; size?: number }) {
  const src = emojiSrc(emoji);
  if (!src)
    return (
      <span
        className={`emoji-text${className ? ` ${className}` : ''}`}
        style={
          size === undefined
            ? undefined
            : {
                width: size,
                height: size,
                fontSize: size,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }
        }
      >
        {emoji}
      </span>
    );
  return (
    <img
      className={`emoji-img${className ? ` ${className}` : ''}`}
      src={src}
      alt={emoji}
      draggable={false}
      loading="lazy"
      decoding="async"
      style={size === undefined ? undefined : { width: size, height: size, objectFit: 'contain' }}
    />
  );
}

// one renderer for emoji, the bundled Lucide catalog, and sanitized local icon uploads
export function PageGlyph({ icon, className, size }: { icon: string; className?: string; size?: number }) {
  const parsed = parsePageIcon(icon);
  const fileId = parsed?.kind === 'file' ? parsed.id : null;
  const fileColor = parsed?.kind === 'file' ? parsed.color : null;
  const [asset, setAsset] = useState<{ id: string; url?: string; svg?: string } | null>(null);

  useEffect(() => {
    if (!fileId) return;
    let live = true;
    if (/\.svg$/i.test(fileId)) {
      void getSession()
        .getFile(fileId)
        .then((file) => {
          if (!live) return;
          if (!file) {
            setAsset({ id: fileId });
            return;
          }
          const source = new TextDecoder().decode(file.data);
          setAsset({ id: fileId, svg: sanitizeSvg(source, fileColor) ?? undefined });
        })
        .catch(() => live && setAsset({ id: fileId }));
    } else {
      void fileUrl(fileId).then((url) => live && setAsset({ id: fileId, url: url ?? undefined }));
    }
    return () => {
      live = false;
    };
  }, [fileId, fileColor]);

  const sized =
    size === undefined ? undefined : { width: size, height: size, objectFit: 'contain' as const };
  if (!parsed)
    return (
      <span
        className={`page-glyph icon-unavailable${className ? ` ${className}` : ''}`}
        style={sized}
      />
    );
  if (parsed.kind === 'emoji') return <Emoji emoji={parsed.value} className={className} size={size} />;
  if (parsed.kind === 'lucide') {
    const Icon = LUCIDE_ICONS[parsed.name];
    return Icon ? (
      <Icon
        className={`page-glyph${className ? ` ${className}` : ''}`}
        size={size ?? '1.2em'}
        strokeWidth={1.75}
        style={parsed.color ? { color: parsed.color } : undefined}
        aria-hidden="true"
      />
    ) : (
      <span
        className={`page-glyph icon-unavailable${className ? ` ${className}` : ''}`}
        style={sized}
      />
    );
  }

  if (!asset || asset.id !== parsed.id)
    return <span className={`page-glyph icon-loading${className ? ` ${className}` : ''}`} style={sized} />;
  if (asset.svg)
    return (
      <span
        className={`page-glyph custom-svg-icon${className ? ` ${className}` : ''}`}
        style={{ ...sized, ...(parsed.color ? { color: parsed.color } : {}) }}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: asset.svg }}
      />
    );
  if (asset.url)
    return (
      <img
        className={`page-glyph icon-image${className ? ` ${className}` : ''}`}
        src={asset.url}
        alt=""
        draggable={false}
        aria-hidden="true"
        style={sized}
      />
    );
  return (
    <span
      className={`page-glyph icon-unavailable${className ? ` ${className}` : ''}`}
      style={sized}
    />
  );
}

// the same for code that builds dom by hand, such as editor node views
export function emojiElement(emoji: string): HTMLElement {
  const src = emojiSrc(emoji);
  if (!src) {
    const span = document.createElement('span');
    span.className = 'emoji-text';
    span.textContent = emoji;
    return span;
  }
  const img = document.createElement('img');
  img.className = 'emoji-img';
  img.src = src;
  img.alt = emoji;
  img.draggable = false;
  return img;
}
