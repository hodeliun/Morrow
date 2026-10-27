import { describe, expect, it } from 'vitest';
import { formatValue, filterOpsFor, tryConvertValue } from './database';
import { emptyWorkspace, newPageMeta } from './model';
import type { DatabaseDef, DocNode, PropDef, PropValue } from './model';
import { encodeFileIcon, parsePageIcon } from './icons';
import {
  allowsMultipleAttachments,
  attachmentValueError,
  encodeAttachmentValue,
  fileIdsInPageProperties,
  parseRichCanvas,
  readAttachmentValue,
  richCanvasValueError,
  validPropertyFileId,
} from './propertyMedia';
import { createBackup, parseBackup, planRestore, referencedFileIds, remapPageMediaFiles, workspaceMarkdownFiles } from './portability';
import { propertyValueError } from './typedValues';

const ref = {
  id: 'asset-1',
  name: 'portrait.png',
  type: 'image/png',
  size: 1024,
  createdAt: 10,
};

describe('local media property values', () => {
  it('keeps local attachment metadata in a checked, round-trippable value', () => {
    const value = encodeAttachmentValue([ref]);
    const image: PropDef = { id: 'image', name: 'Portrait', type: 'image', options: [] };
    expect(value).toContain('morrow-property-attachments');
    expect(readAttachmentValue(value)).toEqual([ref]);
    expect(attachmentValueError(image, value)).toBeNull();
    expect(attachmentValueError(image, 'not-json')).toMatch(/valid local file references/);
    expect(attachmentValueError(image, encodeAttachmentValue([{ ...ref, type: 'application/pdf' }]))).toMatch(
      /image files only/,
    );
    expect(attachmentValueError(image, encodeAttachmentValue([ref, { ...ref, id: 'asset-2' }]))).toMatch(
      /accepts one attachment/,
    );
    expect(allowsMultipleAttachments({ ...image, media: { multiple: true } })).toBe(true);
  });

  it('accepts safe vault paths with spaces and Unicode, and rejects absolute or traversing paths', () => {
    expect(validPropertyFileId('attachments/foto da família.png')).toBe(true);
    expect(validPropertyFileId('../fora.png')).toBe(false);
    expect(validPropertyFileId('/attachments/foto.png')).toBe(false);
    expect(validPropertyFileId('C:/attachments/foto.png')).toBe(false);
    expect(readAttachmentValue(encodeAttachmentValue([{ ...ref, id: 'attachments/foto da família.png' }]))).not.toBeNull();
  });

  it('validates structured paragraphs, lists, local images and safe links', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A useful note', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'First' }] }] }] },
        { type: 'image', attrs: { fileId: 'asset-1', alt: 'Portrait' } },
      ],
    };
    const value = JSON.stringify(doc);
    const canvas: PropDef = { id: 'rich', name: 'Details', type: 'richCanvas', options: [] };
    expect(parseRichCanvas(value)).toEqual(doc);
    expect(richCanvasValueError(canvas, value)).toBeNull();
    expect(richCanvasValueError(canvas, '{"type":"doc","content":[{"type":"script"}]}')).toMatch(
      /supported rich document/,
    );
    const unsafe = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'bad', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }],
    });
    expect(parseRichCanvas(unsafe)).toBeNull();
    expect(propertyValueError(canvas, value)).toBeNull();
    expect(formatValue(canvas, value)).toContain('A useful note');
  });

  it('supports plain-text filters and refuses lossy conversions into rich media', () => {
    const image: PropDef = { id: 'image', name: 'Image', type: 'image', options: [], media: { multiple: true } };
    const rich: PropDef = { id: 'rich', name: 'Details', type: 'richCanvas', options: [] };
    const attachment = encodeAttachmentValue([ref]);
    expect(filterOpsFor('image')).toContain('contains');
    expect(formatValue(image, attachment)).toBe('portrait.png');
    expect(tryConvertValue({ ...image, type: 'file' }, image, encodeAttachmentValue([{ ...ref, type: 'application/pdf' }]))).toEqual({
      ok: false,
      error: 'Image accepts image files only.',
    });
    expect(tryConvertValue({ ...rich, type: 'text' }, rich, 'plain text').ok).toBe(false);
  });

  it('finds attachment references in row values and database defaults', () => {
    const value = encodeAttachmentValue([ref])!;
    const row = newPageMeta({ id: 'row', parentId: 'db', title: 'Row' });
    const databasePage = newPageMeta({ id: 'db', parentId: null, title: 'Database', kind: 'database' });
    const database: DatabaseDef = {
      properties: [
        {
          id: 'image',
          name: 'Portrait',
          type: 'image',
          options: [],
          fillMode: 'default',
          defaultValue: value,
        },
      ],
      views: [],
    };
    const pages = {
      db: { ...databasePage, database },
      row: { ...row, properties: { image: value } satisfies Record<string, PropValue> },
    };
    expect(fileIdsInPageProperties(pages.db!, pages)).toEqual(['asset-1']);
    expect(fileIdsInPageProperties(pages.row!, pages)).toEqual(['asset-1']);
    expect([...referencedFileIds({ pages, docs: {} })]).toEqual(['asset-1']);
    expect(workspaceMarkdownFiles({ pages, docs: {} }, { 'asset-1': ref }).attachments.has('asset-1')).toBe(true);
    expect(emptyWorkspace().pages).toEqual({});
  });

  it('backs up cover and icon files and remaps them with a shared attachment during restore', () => {
    const shared = {
      ...ref,
      id: 'attachments/arquivo compartilhado.png',
      name: 'arquivo compartilhado.png',
    };
    const sharedValue = encodeAttachmentValue([shared])!;
    const prop: PropDef = {
      id: 'attachments',
      name: 'Attachments',
      type: 'file',
      options: [],
      media: { multiple: true },
    };
    const databasePage = {
      ...newPageMeta({ id: 'db', parentId: null, title: 'Database', kind: 'database' }),
      database: { properties: [prop], views: [] } satisfies DatabaseDef,
    };
    const firstRow = {
      ...newPageMeta({ id: 'row-a', parentId: 'db', title: 'First row' }),
      properties: { attachments: sharedValue } satisfies Record<string, PropValue>,
    };
    const secondRow = {
      ...newPageMeta({ id: 'row-b', parentId: 'db', title: 'Second row' }),
      properties: { attachments: sharedValue } satisfies Record<string, PropValue>,
    };
    const coverPage = {
      ...newPageMeta({ id: 'cover', parentId: null, title: 'Cover only' }),
      cover: 'attachments/capa verão.png',
    };
    const iconPage = {
      ...newPageMeta({ id: 'icon', parentId: null, title: 'Icon only' }),
      icon: encodeFileIcon('attachments/icone.svg', '#AABBCC'),
    };
    const pages = {
      db: databasePage,
      'row-a': firstRow,
      'row-b': secondRow,
      cover: coverPage,
      icon: iconPage,
    };
    const state = { pages, docs: {} };
    const references = [...referencedFileIds(state)].sort();
    expect(references).toEqual([
      'attachments/arquivo compartilhado.png',
      'attachments/capa verão.png',
      'attachments/icone.svg',
    ]);

    const backup = createBackup(
      state,
      new Date(0),
      references.map((id) => ({ id, name: id.split('/').pop()!, type: 'image/png', size: 1, createdAt: 1, data: 'AA==' })),
    );
    expect(backup.files.map((file) => file.id).sort()).toEqual(references);
    const parsed = parseBackup(JSON.stringify(backup));
    if (!parsed.ok) throw new Error(parsed.error);
    const plan = planRestore(emptyWorkspace(), parsed.value, () => 'restored');
    const ids = new Map([
      ['attachments/arquivo compartilhado.png', 'attachments/arquivo compartilhado 2.png'],
      ['attachments/capa verão.png', 'attachments/capa restaurada.png'],
      ['attachments/icone.svg', 'attachments/icone-restaurado.svg'],
    ]);
    const restored = remapPageMediaFiles(plan.pages, emptyWorkspace().pages, ids);
    const restoredPages = Object.fromEntries(restored.map((page) => [page.id, page]));
    expect(restoredPages.cover!.cover).toBe('attachments/capa restaurada.png');
    expect(parsePageIcon(restoredPages.icon!.icon)).toEqual({
      kind: 'file',
      id: 'attachments/icone-restaurado.svg',
      color: '#AABBCC',
    });
    expect(readAttachmentValue(restoredPages['row-a']!.properties.attachments)).toMatchObject([
      { id: 'attachments/arquivo compartilhado 2.png' },
    ]);
    expect(readAttachmentValue(restoredPages['row-b']!.properties.attachments)).toMatchObject([
      { id: 'attachments/arquivo compartilhado 2.png' },
    ]);
    expect([...referencedFileIds({ pages: restoredPages, docs: {} })].sort()).toEqual([
      'attachments/arquivo compartilhado 2.png',
      'attachments/capa restaurada.png',
      'attachments/icone-restaurado.svg',
    ]);
  });
});
