import { afterEach, describe, expect, it } from 'vitest';
import type { DocNode, PageId } from '../core/model';
import { docToMarkdown } from '../core/markdown/serialize';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let repositoryCounter = 0;
const nextRepositoryId = () => `toggle-codec-${++repositoryCounter}`;

function registry(): string {
  return JSON.stringify({ version: 1, pages: { 'Notes.md': { id: 'note-page' } } });
}

function formulaMarker(): string {
  const payload = {
    resultId: 'toggle-neighbor',
    pageId: 'note-page',
    name: 'Five',
    formula: '2 + 3',
    bindings: [],
    outputType: 'number',
    format: { precision: 0 },
  };
  return `<span data-morrow-result="${encodeURIComponent(JSON.stringify(payload))}">5</span>`;
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(new VaultRepository(vault, nextRepositoryId), { delayMs: 0 });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

afterEach(() => {
  repositoryCounter = 0;
});

describe('reversible toggle summary codec through MemoryVault', () => {
  it('keeps a styled toggle, column list, block background and formula neighbor through edit and reopen', async () => {
    const marker = formulaMarker();
    const original = `<div data-columns>
<div data-column>

<details open>
<summary data-block-background="#1a2b3c" data-morrow-summary-format="markdown"><h2>Plan **bold** [[Other|internal]] plain \\</summary> after and \\</details> after; code \`</summary>\` and \`</details>\` and \`&lt; &amp;\` <u>underlined</u> <mark style="background: #abcdef">highlighted</mark> <span style="color: #fedcba">colored</span></h2></summary>

- First
  - Nested

</details>

</div>
<div data-column>

Unchanged peer.

</div>
</div>

<!-- morrow:block-background:#2f80ed -->
Before ${marker} after.
`;
    const vault = new MemoryVault({
      'Notes.md': original,
      'Other.md': 'Other page.\n',
      '.morrow/workspace.json': registry(),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.get('note-page') ?? null, `protected reason: ${session.protectedReasons.get('note-page')}`).toBeNull();
      const originalDoc = session.getState().docs['note-page']!;
      const toggle = originalDoc.content?.[0]?.content?.[0]?.content?.[0];
      const summary = toggle?.content?.[0];
      expect(toggle?.type).toBe('details');
      expect(toggle?.attrs?.open).toBe(true);
      expect(summary?.attrs).toMatchObject({ level: 2, backgroundColor: '#1a2b3c' });
      expect(summary?.content?.some((node) => node.type === 'pageLink')).toBe(true);
      expect(summary?.content?.some((node) => node.text === '</summary>')).toBe(true);
      expect(summary?.content?.some((node) => node.marks?.some((mark) => mark.type === 'underline'))).toBe(true);
      expect(summary?.content?.some((node) => node.marks?.some((mark) => mark.type === 'highlight'))).toBe(true);
      expect(summary?.content?.some((node) => node.marks?.some((mark) => mark.type === 'textColor'))).toBe(true);

      const edited: DocNode = {
        ...originalDoc,
        content: [
          ...(originalDoc.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Neighbor edit.' }] },
        ],
      };
      const saved = session.execute({ type: 'page.setDoc', id: 'note-page' as PageId, doc: edited, now: 30 });
      expect(saved.ok).toBe(true);
      expect(await session.flush()).toBe(true);
      await session.close();
      session = undefined;

      const markdown = vault.text('Notes.md')!;
      expect(markdown).toContain(
        '<summary data-block-background="#1a2b3c" data-morrow-summary-format="markdown"><h2>',
      );
      expect(markdown).toContain('plain \\</summary> after and \\</details> after');
      expect(markdown).toContain('`</summary>` and `</details>` and `&lt; &amp;`');
      expect(markdown).toContain('<u>underlined</u>');
      expect(markdown).toContain('<mark style="background: #abcdef">highlighted</mark>');
      expect(markdown).toContain('<span style="color: #fedcba">colored</span>');
      expect(markdown).toContain('<!-- morrow:block-background:#2f80ed -->');
      expect(markdown).toContain(marker);
      expect(markdown).toContain('Neighbor edit.');
      expect(markdown).toContain('Unchanged peer.');

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('note-page')).toBe(false);
      const after = reopened.getState().docs['note-page']!;
      expect(after.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.attrs?.backgroundColor).toBe('#1a2b3c');
      expect(after.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]).toEqual(summary);
      expect(docToMarkdown(after)).toContain(marker);
      expect(docToMarkdown(after)).toContain('Neighbor edit.');
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });

  it('keeps raw-text close-tag literals inside a styled toggle through MemoryVault save and reopen', async () => {
    const original = `<details open>\n<summary data-block-background="#1a2b3c"><h2>Toggle</h2></summary>\n\n<textarea>literal </details></textarea>\n\nInside toggle.\n\n</details>\n\nOutside\n`;
    const vault = new MemoryVault({
      'Notes.md': original,
      '.morrow/workspace.json': registry(),
    });
    let session: WorkspaceSession | undefined;
    let reopened: WorkspaceSession | undefined;
    try {
      session = await open(vault);
      expect(session.protectedReasons.get('note-page') ?? null).toBeNull();
      const originalDoc = session.getState().docs['note-page']!;
      expect(originalDoc.content?.[0]?.type).toBe('details');
      expect(originalDoc.content?.[0]?.content?.[1]?.content?.[0]).toEqual({
        type: 'rawBlock',
        attrs: { text: '<textarea>literal </details></textarea>' },
      });
      expect(originalDoc.content?.[0]?.content?.[1]?.content?.[1]?.content?.[0]?.text).toBe('Inside toggle.');
      expect(originalDoc.content?.[1]?.content?.[0]?.text).toBe('Outside');

      const edited: DocNode = {
        ...originalDoc,
        content: [
          ...(originalDoc.content ?? []),
          { type: 'paragraph', content: [{ type: 'text', text: 'Neighbor edit.' }] },
        ],
      };
      expect(session.execute({ type: 'page.setDoc', id: 'note-page' as PageId, doc: edited, now: 40 }).ok).toBe(true);
      expect(await session.flush()).toBe(true);
      await session.close();
      session = undefined;

      const saved = vault.text('Notes.md')!;
      expect(saved).toContain('<textarea>literal </details></textarea>');
      expect(saved).toContain('Inside toggle.');
      expect(saved).toContain('Outside');
      expect(saved.indexOf('Inside toggle.')).toBeGreaterThan(saved.indexOf('</textarea>'));
      expect(saved.indexOf('Inside toggle.')).toBeLessThan(saved.lastIndexOf('</details>'));
      expect(saved.indexOf('Outside')).toBeGreaterThan(saved.lastIndexOf('</details>'));

      reopened = await open(vault);
      expect(reopened.protectedReasons.has('note-page')).toBe(false);
      const after = reopened.getState().docs['note-page']!;
      expect(after.content?.[0]?.type).toBe('details');
      expect(after.content?.[0]?.content?.[1]?.content?.[0]?.attrs?.text).toBe(
        '<textarea>literal </details></textarea>',
      );
      expect(after.content?.[0]?.content?.[1]?.content?.[1]?.content?.[0]?.text).toBe('Inside toggle.');
      expect(after.content?.[1]?.content?.[0]?.text).toBe('Outside');
    } finally {
      if (session && !session.isClosed) await session.close();
      if (reopened && !reopened.isClosed) await reopened.close();
    }
  });
});
