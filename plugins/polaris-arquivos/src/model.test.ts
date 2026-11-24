import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILE_CATALOG_PREFERENCES,
  fileCatalogExtensionPatch,
  fileCatalogExtensions,
  fileCatalogPreferencesAreDefault,
  hasVisibleDescendant,
  isFileCatalogFolderPathVisible,
  isFileCatalogPathVisible,
  normalizeFileCatalogPreferences,
  normalizeFileExtension,
} from './model';

describe('Polaris Arquivos filter model', () => {
  it('normalizes extensions and reuses the published selection rules', () => {
    expect(normalizeFileExtension(' .PDF ')).toBe('pdf');
    expect(normalizeFileExtension('bad/type')).toBeNull();
    expect(normalizeFileCatalogPreferences({
      mode: 'selected',
      selectedExtensions: ['.PDF', 'jpg', 'PDF', 'bad/type'],
      hiddenExtensions: ['PNG'],
      customExtensions: ['.QZX', 'qzx'],
      includeExtensionless: true,
      showAttachments: true,
    })).toEqual({
      mode: 'selected',
      selectedExtensions: ['pdf', 'jpg'],
      hiddenExtensions: ['png'],
      customExtensions: ['qzx'],
      includeExtensionless: true,
      showAttachments: true,
    });
  });

  it('filters selected/all, explicitly hidden, extensionless, and canonical vault attachments', () => {
    const selected = normalizeFileCatalogPreferences({ mode: 'selected', selectedExtensions: ['.PDF'] });
    expect(isFileCatalogPathVisible('Docs/Manual.PDF', selected)).toBe(true);
    expect(isFileCatalogPathVisible('Docs/Manual.png', selected)).toBe(false);
    expect(isFileCatalogPathVisible('Docs/README', selected)).toBe(false);
    expect(isFileCatalogPathVisible('attachments/Manual.pdf', selected)).toBe(false);
    expect(isFileCatalogFolderPathVisible('attachments', selected)).toBe(false);
    expect(isFileCatalogFolderPathVisible('Attachments/nested', selected)).toBe(false);
    expect(isFileCatalogFolderPathVisible('Docs/attachments', selected)).toBe(true);
    expect(isFileCatalogPathVisible('Attachments/Manual.pdf', { ...selected, showAttachments: true })).toBe(true);
    expect(isFileCatalogFolderPathVisible('attachments', { ...selected, showAttachments: true })).toBe(true);

    const all = normalizeFileCatalogPreferences({
      mode: 'all',
      hiddenExtensions: ['.pNg'],
      includeExtensionless: true,
      showAttachments: true,
    });
    expect(isFileCatalogPathVisible('Docs/Manual.png', all)).toBe(false);
    expect(isFileCatalogPathVisible('Docs/Manual.PDF', all)).toBe(true);
    expect(isFileCatalogPathVisible('Docs/README', all)).toBe(true);
    expect(fileCatalogExtensionPatch(all, 'pdf', true)).toEqual({ hiddenExtensions: ['png', 'pdf'] });
    expect(fileCatalogExtensionPatch(selected, 'pdf', false)).toEqual({ selectedExtensions: [] });
  });

  it('combines known, discovered, and custom types and recognizes a custom type before discovery', () => {
    const preferences = normalizeFileCatalogPreferences({ customExtensions: ['qzx'], selectedExtensions: ['qzx'] });
    expect(fileCatalogExtensions(['XYZ', '.pdf', 'bad/type'], preferences)).toEqual(
      expect.arrayContaining(['pdf', 'xyz', 'qzx']),
    );
    expect(isFileCatalogPathVisible('new/asset.qzx', preferences)).toBe(true);
    expect(fileCatalogPreferencesAreDefault(normalizeFileCatalogPreferences(DEFAULT_FILE_CATALOG_PREFERENCES))).toBe(true);
    expect(fileCatalogPreferencesAreDefault(preferences)).toBe(false);
  });

  it('matches folders to visible descendant files case-insensitively without expanding the cache', () => {
    const visible = ['docs/deep/manual.pdf', 'media/photo.png'].sort();
    expect(hasVisibleDescendant(visible, 'Docs')).toBe(true);
    expect(hasVisibleDescendant(visible, 'docs/deep')).toBe(true);
    expect(hasVisibleDescendant(visible, 'empty')).toBe(false);
  });
});
