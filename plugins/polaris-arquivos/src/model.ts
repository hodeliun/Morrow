import { ATTACHMENTS_DIR } from '../../../src/core/vault/paths';

export type FileCatalogMode = 'selected' | 'all';

export interface FileCatalogPreferences {
  mode: FileCatalogMode;
  selectedExtensions: string[];
  hiddenExtensions: string[];
  customExtensions: string[];
  includeExtensionless: boolean;
  showAttachments: boolean;
}

export const KNOWN_FILE_EXTENSIONS = [
  '7z',
  'aac',
  'ai',
  'aiff',
  'avif',
  'avi',
  'bmp',
  'canvas',
  'csv',
  'doc',
  'docx',
  'flac',
  'gif',
  'heic',
  'ico',
  'jpeg',
  'jpg',
  'm4a',
  'm4v',
  'mkv',
  'mov',
  'mp3',
  'mp4',
  'odp',
  'ods',
  'odt',
  'ogg',
  'md',
  'opus',
  'pdf',
  'png',
  'ppt',
  'pptx',
  'psd',
  'rar',
  'rtf',
  'svg',
  'tif',
  'tiff',
  'txt',
  'wav',
  'webm',
  'webp',
  'xls',
  'xlsx',
  'zip',
] as const;

export const DEFAULT_FILE_CATALOG_PREFERENCES: FileCatalogPreferences = {
  mode: 'selected',
  selectedExtensions: [...KNOWN_FILE_EXTENSIONS],
  hiddenExtensions: [],
  customExtensions: [],
  includeExtensionless: false,
  showAttachments: false,
};

const extensionPattern = /^[a-z0-9][a-z0-9+_-]{0,31}$/;

export function normalizeFileExtension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/^\./, '').toLowerCase();
  return normalized && extensionPattern.test(normalized) ? normalized : null;
}

function normalizedList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  for (const item of value.slice(0, 512)) {
    const normalized = normalizeFileExtension(item);
    if (normalized) result.add(normalized);
  }
  return [...result].slice(0, 256);
}

export function normalizeFileCatalogPreferences(value: unknown): FileCatalogPreferences {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Partial<FileCatalogPreferences>)
    : {};
  return {
    mode: input.mode === 'all' ? 'all' : 'selected',
    selectedExtensions: normalizedList(input.selectedExtensions),
    hiddenExtensions: normalizedList(input.hiddenExtensions),
    customExtensions: normalizedList(input.customExtensions),
    includeExtensionless: input.includeExtensionless === true,
    showAttachments: input.showAttachments === true,
  };
}

export function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isFileCatalogExtensionVisible(value: unknown, preferences: FileCatalogPreferences): boolean {
  const extension = normalizeFileExtension(value);
  if (!extension) return preferences.includeExtensionless;
  if (preferences.hiddenExtensions.includes(extension)) return false;
  return preferences.mode === 'all' || preferences.selectedExtensions.includes(extension);
}

export function isFileCatalogAttachmentsPath(path: string): boolean {
  const lowerPath = path.toLowerCase();
  return lowerPath === ATTACHMENTS_DIR || lowerPath.startsWith(`${ATTACHMENTS_DIR}/`);
}

export function isFileCatalogFolderPathVisible(path: string, preferences: FileCatalogPreferences): boolean {
  return preferences.showAttachments || !isFileCatalogAttachmentsPath(path);
}

export function isFileCatalogPathVisible(path: string, preferences: FileCatalogPreferences): boolean {
  if (!preferences.showAttachments && isFileCatalogAttachmentsPath(path)) return false;
  return isFileCatalogExtensionVisible(fileExtension(path), preferences);
}

export function fileCatalogExtensions(
  discoveredExtensions: readonly string[],
  preferences: FileCatalogPreferences,
): string[] {
  return [
    ...new Set([
      ...KNOWN_FILE_EXTENSIONS,
      ...discoveredExtensions
        .map((extension) => normalizeFileExtension(extension))
        .filter((extension): extension is string => !!extension),
      ...preferences.customExtensions,
    ]),
  ].sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));
}

export function fileCatalogExtensionPatch(
  preferences: FileCatalogPreferences,
  extension: string,
  checked: boolean,
): Partial<FileCatalogPreferences> {
  const field = preferences.mode === 'all' ? 'hiddenExtensions' : 'selectedExtensions';
  const next = new Set(preferences[field]);
  if (checked) next.add(extension);
  else next.delete(extension);
  return { [field]: [...next] };
}

export function fileCatalogPreferencesAreDefault(preferences: FileCatalogPreferences): boolean {
  return JSON.stringify(preferences) === JSON.stringify(DEFAULT_FILE_CATALOG_PREFERENCES);
}

export function hasVisibleDescendant(sortedVisibleFiles: readonly string[], folder: string): boolean {
  const prefix = `${folder.toLowerCase()}/`;
  let low = 0;
  let high = sortedVisibleFiles.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedVisibleFiles[middle]! < prefix) low = middle + 1;
    else high = middle;
  }
  return sortedVisibleFiles[low]?.startsWith(prefix) ?? false;
}
