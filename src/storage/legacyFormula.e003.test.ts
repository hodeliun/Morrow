import { afterEach, describe, expect, it } from 'vitest';
import { docToMarkdown } from '../core/markdown/serialize';
import type { DocNode } from '../core/model';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let repositoryId = 0;
const nextRepositoryId = () => `legacy-formula-test-${++repositoryId}`;

function registry(path: string, id: string): string {
  return JSON.stringify({ version: 1, pages: { [path]: { id } } });
}

function resultMarker(id = 'legacy-total'): string {
  const payload = {
    resultId: id,
    pageId: 'finance-note',
    name: 'Projected total',
    formula: 'Amount.Sum()',
    bindings: [{ kind: 'property', propertyId: 'amount' }],
    outputType: 'currency',
    format: { currency: 'BRL', precision: 2 },
  };
  return `<span data-morrow-result="${encodeURIComponent(JSON.stringify(payload))}" data-future="opaque">Projected total</span>`;
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(new VaultRepository(vault, nextRepositoryId), { delayMs: 0 });
  if (!opened.ok) throw new Error(opened.error);
  return opened.value;
}

describe('legacy inline formula storage compatibility', () => {
  afterEach(() => {
    repositoryId = 0;
  });

  it.each(['', '<!-- morrow:block-background:#2f80ed -->\n'])(
    'keeps formula identity and neighboring text through an edit and reopen with background %j',
    async (background) => {
      const marker = resultMarker();
      const source = `${background}Before **bold neighbor** ${marker} after and *italic neighbor*.`;
      const vault = new MemoryVault({
        'Notes.md': source,
        '.morrow/workspace.json': registry('Notes.md', 'note-page'),
      });
      let first: WorkspaceSession | undefined;
      let reopened: WorkspaceSession | undefined;
      try {
        // MemoryVault exercises the native core parser and repository without activating a plugin.
        first = await open(vault);
        expect(first.protectedReasons.has('note-page')).toBe(false);
        const current = first.getState().docs['note-page']!;
        const edited: DocNode = {
          ...current,
          content: [
            ...(current.content ?? []),
            { type: 'paragraph', content: [{ type: 'text', text: 'Edited after the saved result.' }] },
          ],
        };
        expect(first.execute({ type: 'page.setDoc', id: 'note-page', doc: edited, now: 30 }).ok).toBe(true);
        expect(await first.flush()).toBe(true);
        await first.close();
        first = undefined;

        const saved = vault.text('Notes.md')!;
        expect(saved).toContain(marker);
        if (background) expect(saved).toContain(background);
        expect(saved).toContain('**bold neighbor**');
        expect(saved).toContain('Edited after the saved result.');
        reopened = await open(vault);
        expect(reopened.protectedReasons.has('note-page')).toBe(false);
        if (background) {
          expect(reopened.getState().docs['note-page']!.content?.[0]?.attrs?.backgroundColor).toBe('#2f80ed');
        }
        expect(docToMarkdown(reopened.getState().docs['note-page']!)).toContain(marker);
        expect(docToMarkdown(reopened.getState().docs['note-page']!)).toContain('**bold neighbor**');
        expect(docToMarkdown(reopened.getState().docs['note-page']!)).toContain('italic neighbor');
        expect(docToMarkdown(reopened.getState().docs['note-page']!)).toContain(
          'Edited after the saved result.',
        );
      } finally {
        if (first && !first.isClosed) await first.close();
        if (reopened && !reopened.isClosed) await reopened.close();
      }
    },
  );

  it.each([
    ['bold', '**'],
    ['italic', '*'],
  ])('keeps a %s-marked result atom byte-exact and read-only through reopen', async (_name, delimiter) => {
    const marker = resultMarker(`marked-${_name}`);
    const source = `Before ${delimiter}${marker}${delimiter} after`;
    const vault = new MemoryVault({
      'Notes.md': source,
      '.morrow/workspace.json': registry('Notes.md', 'note-page'),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.get('note-page')).toMatch(/legacy formula result.*formatting/i);
      expect(session.unreadable.has('note-page')).toBe(true);
      expect(session.getState().docs['note-page']).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(
        session.execute({
          type: 'page.setDoc',
          id: 'note-page',
          doc: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'overwrite' }] }],
          },
          now: 50,
        }).ok,
      ).toBe(false);
      expect(await session.flush()).toBe(true);
      expect(vault.text('Notes.md')).toBe(source);
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.get('note-page')).toMatch(/legacy formula result.*formatting/i);
      expect(reopened.getState().docs['note-page']).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(await reopened.flush()).toBe(true);
      expect(vault.text('Notes.md')).toBe(source);
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('keeps duplicate result IDs raw and refuses a write instead of changing identity', async () => {
    const source = `${resultMarker('same-id')} and ${resultMarker('same-id')}`;
    const vault = new MemoryVault({
      'Notes.md': source,
      '.morrow/workspace.json': registry('Notes.md', 'note-page'),
    });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.get('note-page')).toMatch(/duplicate legacy formula result IDs/i);
      expect(session.unreadable.has('note-page')).toBe(true);
      expect(session.getState().docs['note-page']).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(
        session.execute({
          type: 'page.setDoc',
          id: 'note-page',
          doc: {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'overwrite' }] }],
          },
          now: 40,
        }).ok,
      ).toBe(false);
      expect(await session.flush()).toBe(true);
      expect(vault.text('Notes.md')).toBe(source);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
  });

  it('protects a formula marker when the final page resolver would turn its link into a pageLink', async () => {
    const marker = resultMarker('linked-result');
    const source = `[${marker}](Other.md)`;
    const vault = new MemoryVault({
      'Notes.md': source,
      'Other.md': '# Other\n',
      '.morrow/workspace.json': JSON.stringify({
        version: 1,
        pages: { 'Notes.md': { id: 'note-page' }, 'Other.md': { id: 'other-page' } },
      }),
    });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.get('note-page')).toMatch(/legacy formula result/i);
      expect(session.unreadable.has('note-page')).toBe(true);
      expect(session.getState().docs['note-page']).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(await session.flush()).toBe(true);
      expect(vault.text('Notes.md')).toBe(source);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
  });

  it('keeps a CRLF formula marker byte-for-byte by opening it as protected source', async () => {
    const marker = resultMarker('crlf-result').replace(' data-future=', '\r\n data-future=');
    const source = `Before ${marker} after`;
    const vault = new MemoryVault({
      'Notes.md': source,
      '.morrow/workspace.json': registry('Notes.md', 'note-page'),
    });
    let session: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.has('note-page')).toBe(true);
      expect(session.getState().docs['note-page']).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(await session.flush()).toBe(true);
      expect(vault.text('Notes.md')).toBe(source);
    } finally {
      if (session && !session.isClosed) await session.close();
    }
  });

  it('keeps a formula span with an internal highlight delimiter protected byte-for-byte', async () => {
    const marker = resultMarker('highlight-boundary').replace('Projected total</span>', 'Sa==fe</span>');
    const source = `==A ${marker} B==`;
    const vault = new MemoryVault({
      'Notes.md': source,
      '.morrow/workspace.json': registry('Notes.md', 'note-page'),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.get('note-page')).toMatch(/legacy formula result/i);
      expect(session.unreadable.has('note-page')).toBe(true);
      expect(session.getState().docs['note-page']).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(await session.flush()).toBe(true);
      expect(vault.text('Notes.md')).toBe(source);
      await session.close();
      session = undefined;

      reopened = await open(vault);
      expect(reopened.protectedReasons.get('note-page')).toMatch(/legacy formula result/i);
      expect(reopened.getState().docs['note-page']).toEqual({
        type: 'doc',
        content: [{ type: 'rawBlock', attrs: { text: source } }],
      });
      expect(await reopened.flush()).toBe(true);
      expect(vault.text('Notes.md')).toBe(source);
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });
});
