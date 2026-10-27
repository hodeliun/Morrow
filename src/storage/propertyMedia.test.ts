import { describe, expect, it } from 'vitest';
import type { DatabaseDef, DocNode } from '../core/model';
import {
  encodeAttachmentValue,
  fileIdsInPageProperties,
  parseRichCanvas,
  readAttachmentValue,
} from '../core/propertyMedia';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let counter = 0;
const nextId = () => `media${++counter}`;

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(new VaultRepository(vault, nextId), { delayMs: 0 });
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

describe('media property persistence', () => {
  it('reopens attachment references and rich documents larger than 10 KB', async () => {
    const vault = new MemoryVault();
    const session = await open(vault);
    const bytes = new Uint8Array([1, 2, 3]);
    const stored = await session.addFiles([
      {
        meta: {
          id: 'asset-original',
          name: 'arquivo.png',
          type: 'image/png',
          size: bytes.byteLength,
          createdAt: 5,
        },
        data: bytes.buffer,
      },
    ]);
    if (!stored.ok) throw new Error(stored.error);
    expect(stored.value[0]!.id).toBe('attachments/arquivo.png');
    const attachment = encodeAttachmentValue([stored.value[0]!])!;
    expect(readAttachmentValue(attachment)).toEqual([stored.value[0]]);
    const longText = 'Rich content is preserved. '.repeat(500);
    const richDoc: DocNode = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: longText, marks: [{ type: 'bold' }] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'List item' }] }] }] },
        { type: 'image', attrs: { fileId: stored.value[0]!.id, alt: 'Cover' } },
      ],
    };
    const richValue = JSON.stringify(richDoc);
    expect(richValue.length).toBeGreaterThan(10_000);
    expect(parseRichCanvas(richValue)).toEqual(richDoc);
    const database: DatabaseDef = {
      properties: [
        {
          id: 'attachments',
          name: 'Attachments',
          type: 'file',
          options: [],
          media: { multiple: true },
          fillMode: 'default',
          defaultValue: attachment,
        },
        { id: 'details', name: 'Details', type: 'richCanvas', options: [] },
      ],
      views: [],
    };
    const createDatabase = session.execute({
      type: 'page.create',
      id: 'database',
      parentId: null,
      now: 1,
      title: 'Media',
      kind: 'database',
    });
    if (!createDatabase.ok) throw new Error(createDatabase.error);
    const configure = session.execute({ type: 'database.set', id: 'database', database, now: 2 });
    if (!configure.ok) throw new Error(configure.error);
    const createRow = session.execute({
      type: 'page.create',
      id: 'row',
      parentId: 'database',
      now: 3,
      title: 'Record',
      properties: { details: richValue },
    });
    if (!createRow.ok) throw new Error(createRow.error);
    await session.flush();
    expect(fileIdsInPageProperties(session.getState().pages.row!, session.getState().pages)).toContain(
      stored.value[0]!.id,
    );
    await session.close();

    const reopened = await open(vault);
    const row = reopened.getState().pages.row!;
    expect(row.properties.attachments).toBe(attachment);
    expect(row.properties.details).toBe(richValue);
    expect(JSON.parse(String(row.properties.details))).toEqual(richDoc);
    expect((await reopened.getFile(stored.value[0]!.id))?.meta.name).toBe('arquivo.png');
    await reopened.close();
  });
});
