import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILE_CATALOG_PREFERENCES,
  createFileCatalog,
  filterFileCatalog,
  isPageTreeFileVisible,
  nextFileCatalogBatchSize,
  normalizeFileCatalogPreferences,
} from './fileCatalog';
import type { VaultResource } from './fileCatalog';

function resource(path: string, size = 1): VaultResource {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return { path, extension: dot > 0 ? name.slice(dot + 1).toLowerCase() : '', size, mtime: 10 };
}

describe('file catalog', () => {
  it('keeps common binary folders outside the page tree and excludes technical paths', () => {
    const catalog = createFileCatalog([
      resource('Research/Papers/Study.PDF'),
      resource('Research/Media/Clip.Mp4'),
      resource('Research/Notes.md'),
      resource('attachments/Diagram.PnG'),
      resource('.morrow/workspace.json'),
      resource('.git/config'),
      resource('.hidden/secret.pdf'),
      resource('.trash/removed.pdf'),
      resource('Research/.morrow-tmp-upload.bin'),
      resource('../outside.pdf'),
      resource('C:/outside.pdf'),
    ]);

    expect(catalog.files.map((file) => file.path)).toHaveLength(3);
    expect(catalog.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        'Research/Media/Clip.Mp4',
        'Research/Papers/Study.PDF',
        'attachments/Diagram.PnG',
      ]),
    );
    expect(catalog.folders).toHaveLength(4);
    expect(catalog.folders).toEqual(
      expect.arrayContaining(['Research', 'Research/Media', 'Research/Papers', 'attachments']),
    );
  });

  it('filters by normalized extension, explicit exclusion, extensionless and attachments settings', () => {
    const catalog = createFileCatalog([
      resource('Docs/Manual.PDF'),
      resource('Images/Portrait.JpG'),
      resource('Images/README'),
      resource('attachments/Inline.PDF'),
      resource('Exports/Unknown.qzx'),
    ]);
    const selected = normalizeFileCatalogPreferences({
      mode: 'selected',
      selectedExtensions: ['.PDF', 'jpg'],
    });
    expect(filterFileCatalog(catalog, selected).files.map((file) => file.path)).toEqual([
      'Docs/Manual.PDF',
      'Images/Portrait.JpG',
    ]);

    const all = normalizeFileCatalogPreferences({
      mode: 'all',
      hiddenExtensions: ['.pDf'],
      includeExtensionless: true,
      showAttachments: true,
    });
    expect(filterFileCatalog(catalog, all).files.map((file) => file.path)).toEqual([
      'Exports/Unknown.qzx',
      'Images/Portrait.JpG',
      'Images/README',
    ]);
  });

  it('applies Markdown and canvas extensions only to page-tree visibility', () => {
    const defaults = normalizeFileCatalogPreferences(DEFAULT_FILE_CATALOG_PREFERENCES);
    expect(isPageTreeFileVisible('Notes/Journal.MD', defaults)).toBe(true);
    expect(isPageTreeFileVisible('Boards/Planning.CANVAS', defaults)).toBe(true);

    const selected = normalizeFileCatalogPreferences({ mode: 'selected', selectedExtensions: ['pdf'] });
    expect(isPageTreeFileVisible('Notes/Journal.md', selected)).toBe(false);
    expect(isPageTreeFileVisible('Boards/Planning.canvas', selected)).toBe(false);
    expect(isPageTreeFileVisible('Folders/Loose', selected)).toBe(true);
    expect(isPageTreeFileVisible(null, selected)).toBe(true);

    const allExceptMarkdown = normalizeFileCatalogPreferences({ mode: 'all', hiddenExtensions: ['MD'] });
    expect(isPageTreeFileVisible('Notes/Journal.Md', allExceptMarkdown)).toBe(false);
    expect(isPageTreeFileVisible('Boards/Planning.canvas', allExceptMarkdown)).toBe(true);
  });

  it('reports the next file-catalog batch size rather than every remaining file', () => {
    expect(nextFileCatalogBatchSize(450, 200)).toBe(200);
    expect(nextFileCatalogBatchSize(50, 200)).toBe(50);
    expect(nextFileCatalogBatchSize(-1, 200)).toBe(0);
  });

  it('sanitizes custom types and unknown preference data without changing the source', () => {
    const prefs = normalizeFileCatalogPreferences({
      mode: 'all',
      selectedExtensions: ['.Xyz', 'bad/type', 'XYZ'],
      hiddenExtensions: ['PDF', '..', 'bad/type'],
      customExtensions: ['.Xyz', 'ok_2'],
      includeExtensionless: true,
      showAttachments: true,
      unexpected: 'ignored',
    });
    expect(prefs).toEqual({
      mode: 'all',
      selectedExtensions: ['xyz'],
      hiddenExtensions: ['pdf'],
      customExtensions: ['xyz', 'ok_2'],
      includeExtensionless: true,
      showAttachments: true,
    });
  });

  it('handles ten thousand resource metadata records without reading their contents', () => {
    const resources = Array.from({ length: 10_000 }, (_, index) =>
      resource(`Media/${String(index).padStart(5, '0')}.bin`),
    );
    const catalog = createFileCatalog(resources);
    const filtered = filterFileCatalog(catalog, normalizeFileCatalogPreferences({ mode: 'all' }));

    expect(catalog.files).toHaveLength(10_000);
    expect(filtered.files).toHaveLength(10_000);
    expect(filtered.folders).toEqual(['Media']);
  });
});
