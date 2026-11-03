import { describe, expect, it } from 'vitest';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

describe('calculated result background storage', () => {
  it('refreshes the per-note choice without writing a legacy file on open', async () => {
    const original = '---\ntitle: Synthetic legacy note\nfutureField: keep\n---\nSynthetic body.\n';
    const vault = new MemoryVault({ 'Legacy.md': original });
    let nextId = 0;
    const opened = await WorkspaceSession.open(
      new VaultRepository(vault, () => `page-${++nextId}`),
      { delayMs: 0 },
    );
    if (!opened.ok) throw new Error(opened.error);

    const session = opened.value;
    try {
      const page = Object.values(session.getState().pages)[0];
      expect(page?.calculatedResultBackground).toBeNull();
      expect(vault.text('Legacy.md')).toBe(original);

      const updated = '---\ntitle: Synthetic legacy note\nmorrowCalculatedResultBackground: false\nfutureField: keep\n---\nSynthetic body.\n';
      await vault.apply([{ op: 'write', path: 'Legacy.md', text: updated }]);
      vault.report(['Legacy.md']);

      expect(session.getState().pages[page!.id]?.calculatedResultBackground).toBe(false);
      expect(vault.text('Legacy.md')).toBe(updated);
    } finally {
      await session.close();
    }
  });

  it('persists a note override across save and reopen while retaining unknown frontmatter', async () => {
    const original = '---\ntitle: Legacy\nfutureField: keep-me\n---\nSynthetic body.\n';
    const vault = new MemoryVault({ 'Legacy.md': original });
    let nextId = 0;
    const repository = () => new VaultRepository(vault, () => `page-${++nextId}`);
    const opened = await WorkspaceSession.open(repository(), { delayMs: 0 });
    if (!opened.ok) throw new Error(opened.error);

    const firstSession = opened.value;
    try {
      const page = Object.values(firstSession.getState().pages)[0];
      expect(page?.calculatedResultBackground).toBeNull();
      if (!page) throw new Error('Synthetic note was not loaded.');
      const changed = firstSession.execute({
        type: 'page.setCalculatedResultBackground', id: page.id, enabled: false, now: 5,
      });
      expect(changed.ok).toBe(true);
      await firstSession.flush();
      expect(vault.text('Legacy.md')).toContain('morrowCalculatedResultBackground: false');
      expect(vault.text('Legacy.md')).toContain('futureField: keep-me');
    } finally {
      await firstSession.close();
    }

    const reopened = await WorkspaceSession.open(repository(), { delayMs: 0 });
    if (!reopened.ok) throw new Error(reopened.error);
    try {
      const page = Object.values(reopened.value.getState().pages)[0];
      expect(page?.calculatedResultBackground).toBe(false);
      expect(vault.text('Legacy.md')).toContain('futureField: keep-me');
    } finally {
      await reopened.value.close();
    }
  });
});
