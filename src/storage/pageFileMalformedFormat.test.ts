import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { emptyDoc } from '../core/model';
import type { DatabaseDef, PageId } from '../core/model';
import { readPageText } from '../core/vault/pageFile';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let generatedId = 0;

function databaseFile(format: Record<string, unknown>): string {
  const yaml = stringify({
    kind: 'database',
    database: {
      properties: [{ id: 'amount', name: 'Amount', type: 'number', format }],
      views: [],
    },
  });
  return `---\n${yaml}---\n`;
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault, () => `generated-${++generatedId}`),
    { delayMs: 0 },
  );
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

function pageId(session: WorkspaceSession, title: string): PageId {
  const page = Object.values(session.getState().pages).find((candidate) => candidate.title === title);
  if (!page) throw new Error(`Expected the ${title} page to be loaded.`);
  return page.id;
}

describe('database format metadata that cannot be normalized', () => {
  it('keeps unsupported known format values read only and moves their original bytes unchanged', async () => {
    const original = databaseFile({ locale: 'en_US' });
    const loaded = readPageText(original);

    expect(loaded.error).toContain('Database metadata could not be preserved');
    expect(loaded.error).toContain('read only');

    const vault = new MemoryVault({ 'Ledger.md': original });
    const session = await open(vault);
    try {
      const id = pageId(session, 'Ledger');
      expect(session.unreadable.has(id)).toBe(true);

      const rejectedEdit = session.execute({ type: 'page.setDoc', id, doc: emptyDoc(), now: 2 });
      expect(rejectedEdit.ok).toBe(false);
      if (!rejectedEdit.ok) expect(rejectedEdit.error).toContain('protected from changes');

      const renamed = session.execute({ type: 'page.rename', id, title: 'Renamed Ledger', now: 3 });
      expect(renamed.ok).toBe(true);
      expect(await session.flush()).toBe(true);
      expect(session.pathOf(id)).toBe('Renamed Ledger.md');
      expect(vault.text('Ledger.md')).toBeUndefined();
      expect(vault.text('Renamed Ledger.md')).toBe(original);
      expect(session.unreadable.has(id)).toBe(true);
    } finally {
      await session.close();
    }
  });

  it('round trips valid locale and opaque format fields while allowing a supported field removal', async () => {
    const vault = new MemoryVault({
      'Ledger.md': databaseFile({ locale: 'fr-CA', precision: 2, futureFormat: { keep: true } }),
    });
    const session = await open(vault);
    try {
      const id = pageId(session, 'Ledger');
      expect(session.unreadable.has(id)).toBe(false);

      const originalDatabase = session.getState().pages[id]!.database!;
      const changedDatabase: DatabaseDef = {
        ...originalDatabase,
        properties: originalDatabase.properties.map((property) =>
          property.id === 'amount'
            ? { ...property, format: { ...property.format, precision: 3 } }
            : property,
        ),
      };
      const changed = session.execute({ type: 'database.set', id, database: changedDatabase, now: 4 });
      expect(changed.ok).toBe(true);
      expect(await session.flush()).toBe(true);

      let saved = vault.text('Ledger.md');
      expect(saved).toBeDefined();
      let parsed = readPageText(saved!);
      expect(parsed.error).toBeNull();
      expect(parsed.database?.properties[0]?.format).toMatchObject({ locale: 'fr-CA', precision: 3 });
      expect((parsed.data.database as { properties: Array<{ format: Record<string, unknown> }> })
        .properties[0]!.format.futureFormat).toEqual({ keep: true });

      const currentDatabase = session.getState().pages[id]!.database!;
      const withoutLocale: DatabaseDef = {
        ...currentDatabase,
        properties: currentDatabase.properties.map((property) => {
          if (property.id !== 'amount') return property;
          const { locale: _locale, ...format } = property.format ?? {};
          return { ...property, format };
        }),
      };
      const removed = session.execute({ type: 'database.set', id, database: withoutLocale, now: 5 });
      expect(removed.ok).toBe(true);
      expect(await session.flush()).toBe(true);

      saved = vault.text('Ledger.md');
      expect(saved).toBeDefined();
      parsed = readPageText(saved!);
      expect(parsed.error).toBeNull();
      expect(parsed.database?.properties[0]?.format).toEqual({ precision: 3 });
      expect((parsed.data.database as { properties: Array<{ format: Record<string, unknown> }> })
        .properties[0]!.format.futureFormat).toEqual({ keep: true });
    } finally {
      await session.close();
    }
  });
});


describe('legacy null database display target', () => {
  it('opens the existing null Name default without writing the original Markdown', async () => {
    const original = `---\n${stringify({ kind: 'database', database: {
      displayPropertyId: null,
      properties: [{ id: 'amount', name: 'Amount', type: 'number', options: [] }],
      views: [], futureDatabaseFlag: { keep: false },
    }, futureRoot: 'keep' })}---\nIndependent body.\n`;
    const read = readPageText(original);
    expect(read.error).toBeNull();
    expect(read.database?.displayPropertyId).toBeUndefined();
    const vault = new MemoryVault({ 'Legacy.md': original });
    const applied: Parameters<MemoryVault['apply']>[0] = [];
    const apply = vault.apply.bind(vault);
    vault.apply = async (ops) => { applied.push(...ops); return apply(ops); };
    const session = await open(vault);
    try {
      const id = pageId(session, 'Legacy');
      expect(session.unreadable.has(id)).toBe(false);
      expect(session.getState().pages[id]?.database?.displayPropertyId).toBeUndefined();
    } finally {
      await session.close();
    }
    expect(vault.text('Legacy.md')).toBe(original);
    expect(applied.filter((op) => 'path' in op && op.path === 'Legacy.md')).toEqual([]);
  });

  it('still protects non-null malformed or unresolved display targets', () => {
    for (const target of ['missing-property', 42, false]) {
      const text = `---\n${stringify({ kind: 'database', database: {
        displayPropertyId: target, properties: [], views: [],
      } })}---\nKeep the body.\n`;
      expect(readPageText(text).error).toContain('displayPropertyId does not identify a supported property');
    }
  });
});
