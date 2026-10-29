import { dirname, extension, isHiddenPath, isInTrash, isPageFile } from './paths';

export interface VaultResource {
  path: string;
  extension: string;
  size: number | null;
  mtime: number;
}

export interface FileCatalogSnapshot {
  files: VaultResource[];
  folders: string[];
}

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
  return [...result];
}

export function normalizeFileCatalogPreferences(value: unknown): FileCatalogPreferences {
  const input = value && typeof value === 'object' ? (value as Partial<FileCatalogPreferences>) : {};
  return {
    mode: input.mode === 'all' ? 'all' : 'selected',
    selectedExtensions: normalizedList(input.selectedExtensions).slice(0, 256),
    hiddenExtensions: normalizedList(input.hiddenExtensions).slice(0, 256),
    customExtensions: normalizedList(input.customExtensions).slice(0, 256),
    includeExtensionless: input.includeExtensionless === true,
    showAttachments: input.showAttachments === true,
  };
}

export function isFileCatalogExtensionVisible(value: unknown, preferences: FileCatalogPreferences): boolean {
  const ext = normalizeFileExtension(value);
  if (!ext) return preferences.includeExtensionless;
  if (preferences.hiddenExtensions.includes(ext)) return false;
  return preferences.mode === 'all' || preferences.selectedExtensions.includes(ext);
}

// Markdown and canvas files keep their normal page parsing and reference behavior;
// this preference only controls whether their page rows appear in the sidebar tree.
export function isPageTreeFileVisible(path: string | null, preferences: FileCatalogPreferences): boolean {
  if (!path || !isPageFile(path)) return true;
  return isFileCatalogExtensionVisible(extension(path), preferences);
}

export function nextFileCatalogBatchSize(remaining: number, batchSize: number): number {
  if (!Number.isFinite(remaining) || !Number.isFinite(batchSize)) return 0;
  return Math.min(Math.max(0, Math.floor(remaining)), Math.max(0, Math.floor(batchSize)));
}

function catalogable(path: string): boolean {
  const segments = path.split('/');
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !path.startsWith('/') &&
    !/^[a-z]:/i.test(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !segments.some((part) => !part || part === '.' || part === '..') &&
    !isHiddenPath(path) &&
    !isInTrash(path) &&
    !isPageFile(path) &&
    !path.split('/').some((part) => part.includes('.morrow-tmp-'))
  );
}

export function createFileCatalog(resources: readonly VaultResource[]): FileCatalogSnapshot {
  const files = resources
    .filter((resource) => catalogable(resource.path))
    .map((resource) => ({
      path: resource.path,
      extension: extension(resource.path),
      size: Number.isFinite(resource.size) && resource.size! >= 0 ? resource.size : null,
      mtime: Number.isFinite(resource.mtime) ? resource.mtime : 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
  const folders = new Set<string>();
  for (const file of files) {
    for (let folder = dirname(file.path); folder; folder = dirname(folder)) {
      if (catalogable(folder) || folder.toLowerCase() === 'attachments') folders.add(folder);
    }
  }
  return {
    files,
    folders: [...folders].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
    ),
  };
}

function inAttachments(path: string): boolean {
  const lower = path.toLowerCase();
  return lower === 'attachments' || lower.startsWith('attachments/');
}

export function filterFileCatalog(
  catalog: FileCatalogSnapshot,
  preferences: FileCatalogPreferences,
): FileCatalogSnapshot {
  const files = catalog.files.filter((file) => {
    if (!preferences.showAttachments && inAttachments(file.path)) return false;
    return isFileCatalogExtensionVisible(file.extension, preferences);
  });
  const visibleFolders = new Set<string>();
  for (const file of files)
    for (let folder = dirname(file.path); folder; folder = dirname(folder))
      visibleFolders.add(folder.toLowerCase());
  const folders = catalog.folders.filter((folder) => visibleFolders.has(folder.toLowerCase()));
  return { files, folders };
}

export function fileCatalogExtensions(
  catalog: FileCatalogSnapshot,
  preferences: FileCatalogPreferences,
): string[] {
  return [
    ...new Set([
      ...KNOWN_FILE_EXTENSIONS,
      ...catalog.files
        .map((file) => normalizeFileExtension(file.extension))
        .filter((ext): ext is string => !!ext),
      ...preferences.customExtensions,
    ]),
  ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}
