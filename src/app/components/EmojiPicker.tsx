import { icons, Palette } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { encodeFileIcon, encodeLucideIcon, parsePageIcon, sanitizeSvg } from '../../core/icons';
import { displayTitle } from '../../core/model';
import type { PageId } from '../../core/model';
import { closeDialog } from '../ui';
import { useWorkspace } from '../workspace';
import { LUCIDE_ICON_NAMES, Emoji, PageGlyph, emojiSrc } from './Emoji';
import { Dialog } from './primitives';
import { t } from '../i18n';
import type { TranslationKey } from '../i18n';
import { pickFiles } from '../platform/files';
import { storeFiles } from '../platform/attachments';
import { toast } from '../ui';

interface EmojiEntry {
  unicode: string;
  label: string;
  group: number;
  order: number;
  tags: string[];
}

type PickerMode = 'emoji' | 'lucide';

const GROUPS: Array<{ id: number; label: TranslationKey; icon: string }> = [
  { id: 0, label: 'emoji.smileys', icon: '😀' },
  { id: 1, label: 'emoji.people', icon: '👋' },
  { id: 3, label: 'emoji.nature', icon: '🌿' },
  { id: 4, label: 'emoji.food', icon: '🍎' },
  { id: 5, label: 'emoji.travel', icon: '✈️' },
  { id: 6, label: 'emoji.activities', icon: '⚽' },
  { id: 7, label: 'emoji.objects', icon: '💡' },
  { id: 8, label: 'emoji.symbols', icon: '❤️' },
  { id: 9, label: 'emoji.flags', icon: '🏳️' },
];

const RECENT_KEY = 'morrow.recentEmoji';
const MAX_ICON_UPLOAD_BYTES = 2 * 1024 * 1024;
const ICON_BATCH_SIZE = 240;
const ICON_COLORS: Array<{ color: string; label: TranslationKey }> = [
  { color: '#FFFFFF', label: 'emoji.white' },
  { color: '#EF4444', label: 'emoji.red' },
  { color: '#F97316', label: 'emoji.orange' },
  { color: '#EAB308', label: 'emoji.yellow' },
  { color: '#22C55E', label: 'emoji.green' },
  { color: '#06B6D4', label: 'emoji.cyan' },
  { color: '#3B82F6', label: 'emoji.blue' },
  { color: '#8B5CF6', label: 'emoji.purple' },
  { color: '#EC4899', label: 'emoji.pink' },
];

const LUCIDE_ICONS = icons as Record<string, LucideIcon>;

let cache: Promise<EmojiEntry[]> | null = null;
function loadEmoji(): Promise<EmojiEntry[]> {
  cache ??= import('emojibase-data/en/compact.json').then((module) =>
    (module.default as Array<Partial<EmojiEntry> & { unicode: string; label: string }>)
      .filter((item) => typeof item.group === 'number' && item.group !== 2 && emojiSrc(item.unicode) !== null)
      .map((item) => ({
        unicode: item.unicode,
        label: item.label,
        group: item.group!,
        order: item.order ?? 0,
        tags: item.tags ?? [],
      }))
      .sort((a, b) => a.order - b.order),
  );
  return cache;
}

function readRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw)
      ? raw.filter((item): item is string => typeof item === 'string').slice(0, 24)
      : [];
  } catch {
    return [];
  }
}

function iconLabel(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2');
}

// checks the file contents and sanitizes SVG before it can be stored in the vault
export async function preparePageIconFile(file: File): Promise<File | null> {
  if (file.size === 0 || file.size > MAX_ICON_UPLOAD_BYTES) return null;
  const name = file.name.split(/[\\/]/).pop() ?? '';
  const base =
    name
      .replace(/\.[^.]*$/, '')
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72) || 'page-icon';
  const isSvg = file.type.toLowerCase() === 'image/svg+xml' || /\.svg$/i.test(name);
  if (isSvg) {
    const cleaned = sanitizeSvg(await file.text());
    return cleaned ? new File([cleaned], `${base}.svg`, { type: 'image/svg+xml' }) : null;
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const webp =
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  if (png) return new File([bytes], `${base}.png`, { type: 'image/png' });
  if (jpeg) return new File([bytes], `${base}.jpg`, { type: 'image/jpeg' });
  if (webp) return new File([bytes], `${base}.webp`, { type: 'image/webp' });
  return null;
}

export function EmojiPicker({ pageId, onPick }: { pageId: PageId; onPick: (icon: string | null) => void }) {
  const state = useWorkspace();
  const page = state.pages[pageId];
  const currentIcon = parsePageIcon(page?.icon);
  const [emoji, setEmoji] = useState<EmojiEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState<number | null>(null);
  const [recent] = useState(readRecent);
  const [mode, setMode] = useState<PickerMode>(currentIcon?.kind === 'lucide' ? 'lucide' : 'emoji');
  const [color, setColor] = useState<string | null>(
    currentIcon?.kind === 'lucide' || (currentIcon?.kind === 'file' && /\.svg$/i.test(currentIcon.id))
      ? currentIcon.color
      : null,
  );
  const [visibleIcons, setVisibleIcons] = useState(ICON_BATCH_SIZE);

  useEffect(() => {
    let live = true;
    void loadEmoji().then((list) => live && setEmoji(list));
    return () => {
      live = false;
    };
  }, []);

  const shownEmoji = useMemo(() => {
    if (!emoji) return [];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      return emoji.filter((item) =>
        words.every(
          (word) => item.label.toLowerCase().includes(word) || item.tags.some((tag) => tag.startsWith(word)),
        ),
      );
    }
    return group === null ? emoji : emoji.filter((item) => item.group === group);
  }, [emoji, query, group]);

  const shownIcons = useMemo(() => {
    const folded = query.trim().toLowerCase();
    return LUCIDE_ICON_NAMES.filter((name) => {
      if (!folded) return true;
      const label = iconLabel(name).toLowerCase();
      return label.includes(folded) || name.toLowerCase().includes(folded);
    });
  }, [query]);

  if (!page) return null;
  const pick = (icon: string | null) => {
    const selected = parsePageIcon(icon);
    if (selected?.kind === 'emoji') {
      try {
        localStorage.setItem(
          RECENT_KEY,
          JSON.stringify([selected.value, ...recent.filter((item) => item !== selected.value)].slice(0, 24)),
        );
      } catch {
        // recent picks are a convenience only
      }
    }
    onPick(icon);
    closeDialog();
  };

  const updateColor = (next: string | null) => {
    setColor(next);
    if (currentIcon?.kind === 'lucide') {
      const value = encodeLucideIcon(currentIcon.name, next);
      if (value) onPick(value);
    } else if (currentIcon?.kind === 'file' && /\.svg$/i.test(currentIcon.id)) {
      const value = encodeFileIcon(currentIcon.id, next);
      if (value) onPick(value);
    }
  };

  const upload = async () => {
    try {
      const [selected] = await pickFiles(
        '.png,.jpg,.jpeg,.webp,.svg,image/png,image/jpeg,image/webp,image/svg+xml',
        false,
      );
      if (!selected) return;
      const safe = await preparePageIconFile(selected);
      if (!safe) {
        toast(t('emoji.invalidFile'), { tone: 'error' });
        return;
      }
      const [stored] = await storeFiles([safe]);
      if (!stored) return;
      const value = encodeFileIcon(stored.id);
      if (value) pick(value);
    } catch {
      toast(t('emoji.invalidFile'), { tone: 'error' });
    }
  };

  const colorable =
    mode === 'lucide' ||
    currentIcon?.kind === 'lucide' ||
    (currentIcon?.kind === 'file' && /\.svg$/i.test(currentIcon.id));
  const selectedLucide = currentIcon?.kind === 'lucide' ? currentIcon.name : null;
  const canLoadMore = visibleIcons < shownIcons.length;
  const loadMore = () => setVisibleIcons((count) => count + ICON_BATCH_SIZE);

  return (
    <Dialog
      title={t('emoji.title', { title: displayTitle(page) })}
      onClose={closeDialog}
      className="emoji-dialog"
    >
      <div className="icon-tabs" role="tablist" aria-label={t('emoji.iconTypes')}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'emoji'}
          className={mode === 'emoji' ? 'is-active' : ''}
          onClick={() => setMode('emoji')}
        >
          {t('emoji.emoji')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'lucide'}
          className={mode === 'lucide' ? 'is-active' : ''}
          onClick={() => setMode('lucide')}
        >
          {t('emoji.lucide')}
        </button>
        <button type="button" className="button small icon-upload" onClick={() => void upload()}>
          {t('emoji.uploadIcon')}
        </button>
      </div>
      <div className="emoji-top">
        <input
          className="text-input"
          data-autofocus
          placeholder={t(mode === 'emoji' ? 'emoji.searchPlaceholder' : 'emoji.searchIcons')}
          aria-label={t(mode === 'emoji' ? 'emoji.searchEmoji' : 'emoji.searchIcons')}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setVisibleIcons(ICON_BATCH_SIZE);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && mode === 'emoji' && shownEmoji[0]) pick(shownEmoji[0].unicode);
            if (event.key === 'Enter' && mode === 'lucide' && shownIcons[0]) {
              const value = encodeLucideIcon(shownIcons[0]!, color);
              if (value) pick(value);
            }
          }}
        />
        {mode === 'emoji' && (
          <button
            type="button"
            className="button"
            title={t('emoji.random')}
            disabled={!emoji?.length}
            onClick={() => emoji && pick(emoji[Math.floor(Math.random() * emoji.length)]!.unicode)}
          >
            {t('emoji.random')}
          </button>
        )}
        {page.icon && (
          <button type="button" className="button" onClick={() => pick(null)}>
            {t('common.remove')}
          </button>
        )}
      </div>
      {colorable && (
        <section className="icon-color-section" aria-label={t('emoji.iconColor')}>
          <span>{t('emoji.iconColor')}</span>
          <div className="icon-color-options">
            <button
              type="button"
              className={`icon-color-choice icon-color-auto${color === null ? ' is-active' : ''}`}
              aria-label={t('emoji.automaticColor')}
              aria-pressed={color === null}
              title={t('emoji.automaticColor')}
              onClick={() => updateColor(null)}
            />
            {ICON_COLORS.map((item) => (
              <button
                key={item.color}
                type="button"
                className={`icon-color-choice${color === item.color ? ' is-active' : ''}`}
                aria-label={t(item.label)}
                aria-pressed={color === item.color}
                title={t(item.label)}
                style={{ backgroundColor: item.color }}
                onClick={() => updateColor(item.color)}
              />
            ))}
            <label className="icon-color-picker" title={t('emoji.customColor')}>
              <Palette size={13} aria-hidden="true" />
              {color && (
                <span
                  className="icon-color-custom-sample"
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
              )}
              <input
                type="color"
                className="icon-color-custom-input"
                aria-label={t('emoji.customColor')}
                value={color ?? '#FFFFFF'}
                onChange={(event) => updateColor(event.target.value)}
              />
            </label>
          </div>
        </section>
      )}
      {mode === 'lucide' && (
        <p className="icon-license-note">
          {t('emoji.licenseNotice')}{' '}
          <a href="https://lucide.dev/license" target="_blank" rel="noreferrer">
            {t('emoji.licenseDetails')}
          </a>
        </p>
      )}
      {mode === 'emoji' && !query && (
        <div className="emoji-groups" role="tablist" aria-label={t('emoji.categories')}>
          <button
            type="button"
            role="tab"
            aria-selected={group === null}
            className={group === null ? 'is-active' : ''}
            onClick={() => setGroup(null)}
          >
            {t('emoji.all')}
          </button>
          {GROUPS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={group === item.id}
              title={t(item.label)}
              aria-label={t(item.label)}
              className={group === item.id ? 'is-active' : ''}
              onClick={() => setGroup(item.id)}
            >
              <Emoji emoji={item.icon} />
            </button>
          ))}
        </div>
      )}
      {mode === 'emoji' && !query && group === null && recent.length > 0 && (
        <>
          <p className="emoji-section">{t('actions.groups.recent')}</p>
          <div className="emoji-grid">
            {recent.map((icon) => (
              <button key={icon} type="button" className="emoji-choice" onClick={() => pick(icon)}>
                <Emoji emoji={icon} />
              </button>
            ))}
          </div>
        </>
      )}
      <div
        className={`emoji-grid emoji-all${mode === 'lucide' ? ' icon-catalog-grid' : ''}`}
        role="listbox"
        aria-label={t(mode === 'emoji' ? 'emoji.emoji' : 'emoji.lucide')}
      >
        {mode === 'emoji' && emoji === null && <p className="muted">{t('emoji.loading')}</p>}
        {mode === 'emoji' &&
          shownEmoji.map((item) => (
            <button
              key={item.unicode}
              type="button"
              role="option"
              aria-selected={page.icon === item.unicode}
              title={item.label}
              aria-label={item.label}
              className={`emoji-choice${page.icon === item.unicode ? ' is-active' : ''}`}
              onClick={() => pick(item.unicode)}
            >
              <Emoji emoji={item.unicode} />
            </button>
          ))}
        {mode === 'lucide' &&
          shownIcons.slice(0, visibleIcons).map((name) => {
            const Icon = LUCIDE_ICONS[name]!;
            const value = encodeLucideIcon(name, color);
            const label = iconLabel(name);
            return (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={selectedLucide === name}
                title={label}
                aria-label={t('emoji.iconNamed', { name: label })}
                className={`emoji-choice${selectedLucide === name ? ' is-active' : ''}`}
                onClick={() => value && pick(value)}
              >
                <Icon size={22} strokeWidth={1.75} style={color ? { color } : undefined} aria-hidden="true" />
              </button>
            );
          })}
        {mode === 'emoji' && emoji && shownEmoji.length === 0 && (
          <p className="muted">{t('emoji.noMatch', { query })}</p>
        )}
        {mode === 'lucide' && shownIcons.length === 0 && (
          <p className="muted">{t('emoji.noIconMatch', { query })}</p>
        )}
      </div>
      {mode === 'lucide' && canLoadMore && (
        <button type="button" className="button small load-icon-more" onClick={loadMore}>
          {t('emoji.loadMore', {
            shown: Math.min(visibleIcons, shownIcons.length),
            total: shownIcons.length,
          })}
        </button>
      )}
      {currentIcon?.kind === 'file' && (
        <span className="icon-picker-preview">
          <PageGlyph icon={page.icon!} />
        </span>
      )}
    </Dialog>
  );
}
