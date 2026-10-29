import { ChevronDown, ChevronRight, File, FolderClosed, FolderOpen, Settings2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { basename, dirname, extension as fileExtension } from '../../core/vault/paths';
import { filterFileCatalog, nextFileCatalogBatchSize } from '../../core/vault/fileCatalog';
import type { FileCatalogSnapshot, VaultResource } from '../../core/vault/fileCatalog';
import { useTranslation } from '../i18n';
import { desktop } from '../platform/desktop';
import type { DesktopFileHandlerResult } from '../platform/desktop';
import { fileHandlerErrorKey } from '../platform/fileHandlerMessages';
import { useFileCatalogPreferences } from '../platform/fileCatalogPreferences';
import { getSession, useFileCatalog } from '../workspace';
import { openDialog } from '../ui';
import './fileCatalog.css';

const INITIAL_FILE_COUNT = 200;
const FILES_PER_STEP = 200;

function visibleRows(catalog: FileCatalogSnapshot, files: VaultResource[]) {
  const visibleFolders = new Set<string>();
  for (const file of files)
    for (let folder = dirname(file.path); folder; folder = dirname(folder)) visibleFolders.add(folder);

  const folderPaths = catalog.folders.filter((folder) => visibleFolders.has(folder));
  const foldersByParent = new Map<string, string[]>();
  const filesByParent = new Map<string, VaultResource[]>();
  for (const folder of folderPaths) {
    const parent = dirname(folder);
    foldersByParent.set(parent, [...(foldersByParent.get(parent) ?? []), folder]);
  }
  for (const file of files) {
    const parent = dirname(file.path);
    filesByParent.set(parent, [...(filesByParent.get(parent) ?? []), file]);
  }
  const sort = <T extends string | VaultResource>(a: T, b: T) => {
    const left = typeof a === 'string' ? basename(a) : basename(a.path);
    const right = typeof b === 'string' ? basename(b) : basename(b.path);
    return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  };
  for (const folders of foldersByParent.values()) folders.sort(sort);
  for (const children of filesByParent.values()) children.sort(sort);

  const rows: Array<{ kind: 'folder' | 'file'; path: string; depth: number }> = [];
  const visit = (parent: string, depth: number) => {
    const folders = foldersByParent.get(parent) ?? [];
    const children = filesByParent.get(parent) ?? [];
    const entries = [
      ...folders.map((path) => ({ kind: 'folder' as const, path })),
      ...children.map((file) => ({ kind: 'file' as const, path: file.path })),
    ].sort((a, b) => sort(a.path, b.path));
    for (const entry of entries) {
      rows.push({ ...entry, depth });
      if (entry.kind === 'folder') visit(entry.path, depth + 1);
    }
  };
  visit('', 0);
  return rows;
}

export function FileCatalog() {
  const { t, locale } = useTranslation();
  const catalog = useFileCatalog();
  const location = getSession().location ?? '';
  const preferences = useFileCatalogPreferences(location);
  const [limit, setLimit] = useState(INITIAL_FILE_COUNT);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [openFailure, setOpenFailure] = useState<{
    path: string;
    result: Extract<DesktopFileHandlerResult, { ok: false }>;
  } | null>(null);
  const filtered = useMemo(() => filterFileCatalog(catalog, preferences), [catalog, preferences]);
  const shownFiles = useMemo(() => filtered.files.slice(0, limit), [filtered.files, limit]);
  const rows = useMemo(() => visibleRows(filtered, shownFiles), [filtered, shownFiles]);

  const toggleFolder = (path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const openFile = async (path: string, chooseOnce = false) => {
    setOpenFailure(null);
    const fileHandlers = desktop?.fileHandlers;
    if (!fileHandlers) {
      setOpenFailure({
        path,
        result: {
          ok: false,
          code: 'open-failed',
          message: 'Desktop file opening is unavailable.',
        },
      });
      return;
    }
    try {
      const result = await fileHandlers.openFile(path, chooseOnce ? { chooseOnce: true, locale } : undefined);
      if (result.ok) setOpenFailure(null);
      else if (result.code !== 'cancelled') setOpenFailure({ path, result });
    } catch {
      setOpenFailure({
        path,
        result: { ok: false, code: 'open-failed', message: 'The file could not be opened.' },
      });
    }
  };

  const openContainingFolder = async () => {
    if (!openFailure || !desktop?.fileHandlers) return;
    try {
      const result = await desktop.fileHandlers.openContainingFolder(openFailure.path);
      if (result.ok) setOpenFailure(null);
      else setOpenFailure({ ...openFailure, result });
    } catch {
      setOpenFailure({
        ...openFailure,
        result: {
          ok: false,
          code: 'open-folder-failed',
          message: 'The containing folder could not be opened.',
        },
      });
    }
  };

  return (
    <section className="sidebar-section file-catalog-section" aria-label={t('fileCatalog.sectionTitle')}>
      <div className="sidebar-heading-row file-catalog-heading-row">
        <h2 className="sidebar-heading">
          {t('fileCatalog.sectionTitle')} <span className="nav-count">{filtered.files.length}</span>
        </h2>
        <button
          type="button"
          className="icon-button small"
          aria-label={t('fileCatalog.openSettings')}
          title={t('fileCatalog.openSettings')}
          onClick={() => openDialog({ kind: 'settings', section: 'vault' })}
        >
          <Settings2 size={14} />
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="file-catalog-empty">{t('fileCatalog.noFiles')}</p>
      ) : (
        <ul className="file-catalog-list">
          {rows.map((row) => {
            if ([...collapsed].some((folder) => row.path.startsWith(`${folder}/`))) return null;
            if (row.kind === 'folder') {
              const isCollapsed = collapsed.has(row.path);
              const FolderIcon = isCollapsed ? FolderClosed : FolderOpen;
              const Chevron = isCollapsed ? ChevronRight : ChevronDown;
              return (
                <li key={`folder:${row.path}`}>
                  <button
                    type="button"
                    className="file-catalog-row"
                    style={{ paddingInlineStart: `${6 + row.depth * 12}px` }}
                    aria-expanded={!isCollapsed}
                    aria-label={t('fileCatalog.toggleFolder', { path: row.path })}
                    title={row.path}
                    onClick={() => toggleFolder(row.path)}
                  >
                    <Chevron size={12} />
                    <FolderIcon size={14} />
                    <span>{basename(row.path)}</span>
                  </button>
                </li>
              );
            }
            const extension = fileExtension(row.path);
            return (
              <li key={`file:${row.path}`}>
                <button
                  type="button"
                  className="file-catalog-row"
                  style={{ paddingInlineStart: `${22 + row.depth * 12}px` }}
                  aria-label={t('fileCatalog.openFile', { path: row.path })}
                  title={row.path}
                  onClick={() => void openFile(row.path)}
                >
                  <File size={14} />
                  <span>{basename(row.path)}</span>
                  {extension && <small className="file-catalog-file-extension">.{extension}</small>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {openFailure && (
        <div className="file-catalog-error" role="alert">
          <p>{t(fileHandlerErrorKey(openFailure.result.code))}</p>
          <div className="file-catalog-error-actions">
            {openFailure.result.recovery?.includes('choose-application') && (
              <button
                type="button"
                className="button small"
                onClick={() => void openFile(openFailure.path, true)}
              >
                {t('fileCatalog.chooseAnotherApplication')}
              </button>
            )}
            {openFailure.result.recovery?.includes('open-folder') && (
              <button type="button" className="button small" onClick={() => void openContainingFolder()}>
                {t('fileCatalog.openContainingFolder')}
              </button>
            )}
          </div>
        </div>
      )}
      {filtered.files.length > shownFiles.length && (
        <button
          type="button"
          className="link-button file-catalog-more"
          onClick={() => setLimit((current) => Math.min(filtered.files.length, current + FILES_PER_STEP))}
        >
          {t('fileCatalog.showMore', {
            count: nextFileCatalogBatchSize(filtered.files.length - shownFiles.length, FILES_PER_STEP),
          })}
        </button>
      )}
    </section>
  );
}
