import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '../core/model';
import { openRepository } from './repository';

const names: string[] = [];
let sequence = 0;

afterEach(async () => {
  while (names.length) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(names.pop()!);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
});

describe('format 13 IndexedDB upgrade preservation', () => {
  it('keeps unknown fields and unsupported raw records through upgrade and reopen', async () => {
    const name = `morrow-schema13-preservation-${sequence++}`;
    names.push(name);
    const knownPage = {
      id: 'known',
      title: 'Synthetic legacy page',
      extra: { futureMetadata: { nested: ['keep', 1] } },
      futurePageField: { keep: 'opaque page metadata' },
    };
    const knownDocument = {
      id: 'known',
      doc: {
        type: 'doc',
        attrs: { futureDocumentAttribute: 'keep' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Kept text' }] }],
      },
      futureRecordField: { keep: ['opaque document metadata'] },
    };
    const unsupportedPage = {
      id: 'future-control',
      title: 'Synthetic future control',
      controls: [{
        id: 'future', name: 'Future', type: 'text', value: '', defaultValue: '', options: [],
        futureSetting: { keep: true },
      }],
      futurePageField: { keep: 'unsupported record' },
    };
    const unsupportedDocument = {
      id: 'unsupported-doc',
      doc: { type: 'doc', content: 'opaque future document representation' },
      futureRecordField: { keep: 'unsupported document record' },
    };
    const old = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore('pages', { keyPath: 'id' });
        database.createObjectStore('docs', { keyPath: 'id' });
        database.createObjectStore('meta');
      },
    });
    await old.put('pages', knownPage);
    await old.put('pages', unsupportedPage);
    await old.put('pages', { id: 'unsupported-doc', title: 'Synthetic unsupported document' });
    await old.put('docs', knownDocument);
    await old.put('docs', unsupportedDocument);
    await old.put('meta', 12, 'schemaVersion');
    old.close();

    for (let opening = 0; opening < 2; opening++) {
      const repository = await openRepository(name);
      try {
        const loaded = await repository.load();
        if (!loaded.ok) throw new Error(loaded.error);
        expect(loaded.value.pages.find((page) => page.id === 'known')?.extra)
          .toEqual(knownPage.extra);
        expect(loaded.value.unreadable).toContain('unsupported-doc');
      } finally {
        repository.close();
      }
      const raw = await openDB(name);
      try {
        expect(await raw.get('meta', 'schemaVersion')).toBe(SCHEMA_VERSION);
        expect(await raw.get('pages', 'future-control')).toEqual(unsupportedPage);
        expect(await raw.get('docs', 'unsupported-doc')).toEqual(unsupportedDocument);
        expect.soft((await raw.get('pages', 'known')).futurePageField).toEqual(knownPage.futurePageField);
        expect.soft(await raw.get('docs', 'known')).toEqual(knownDocument);
      } finally {
        raw.close();
      }
    }
  });

  it('keeps record rewrites for paths containing older migration steps', async () => {
    const name = `morrow-schema13-old-upgrade-${sequence++}`;
    names.push(name);
    const old = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore('pages', { keyPath: 'id' });
        database.createObjectStore('docs', { keyPath: 'id' });
        database.createObjectStore('meta');
      },
    });
    await old.put('pages', { id: 'old', title: 'Synthetic older page' });
    await old.put('meta', 1, 'schemaVersion');
    old.close();

    for (let opening = 0; opening < 2; opening++) {
      const repository = await openRepository(name);
      try {
        const loaded = await repository.load();
        if (!loaded.ok) throw new Error(loaded.error);
        expect(loaded.value.pages.find((page) => page.id === 'old')?.kind).toBe('page');
      } finally {
        repository.close();
      }
      const raw = await openDB(name);
      try {
        expect(await raw.get('meta', 'schemaVersion')).toBe(SCHEMA_VERSION);
        expect(await raw.get('pages', 'old')).toMatchObject({ kind: 'page', controls: [] });
      } finally {
        raw.close();
      }
    }
  });

  it('rejects future formats without rewriting their version or raw records', async () => {
    const name = `morrow-schema13-future-${sequence++}`;
    names.push(name);
    const page = { id: 'future', title: 'Synthetic future page', futureMetadata: { keep: true } };
    const old = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore('pages', { keyPath: 'id' });
        database.createObjectStore('docs', { keyPath: 'id' });
        database.createObjectStore('meta');
      },
    });
    await old.put('pages', page);
    await old.put('meta', 14, 'schemaVersion');
    old.close();

    const repository = await openRepository(name);
    try {
      const loaded = await repository.load();
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error).toContain('newer version');
    } finally {
      repository.close();
    }
    const raw = await openDB(name);
    try {
      expect(await raw.get('meta', 'schemaVersion')).toBe(14);
      expect(await raw.get('pages', 'future')).toEqual(page);
    } finally {
      raw.close();
    }
  });
});
