import { describe, expect, it } from 'vitest';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { getPreferences, setPreferences } from './platform/preferences';
import { run as runWorkspace, setSession } from './workspace';

describe('page creation note defaults', () => {
  it('uses full width for new databases while preserving explicit styles and note defaults', async () => {
    let nextId = 0;
    const opened = await WorkspaceSession.open(
      new VaultRepository(new MemoryVault(), () => `databaseWidth${++nextId}`),
      { delayMs: 0 },
    );
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);

    const originalStyle = getPreferences().defaultNoteStyle;
    const defaultStyle = {
      font: 'serif' as const,
      fontSize: 19,
      lineHeight: 1.74,
      blockSpacing: 12,
      width: 'wide' as const,
    };
    setPreferences({ defaultNoteStyle: defaultStyle });

    try {
      const database = runWorkspace({
        type: 'page.create',
        id: 'new-database',
        parentId: null,
        title: 'New synthetic database',
        kind: 'database',
        database: { properties: [], views: [] },
        now: 1,
      });
      expect(database.ok).toBe(true);
      expect(session.getState().pages['new-database']?.noteStyle).toEqual({
        ...defaultStyle,
        width: 'full',
      });

      const explicitStyle = { ...defaultStyle, width: 'comfortable' as const };
      const explicitDatabase = runWorkspace({
        type: 'page.create',
        id: 'explicit-database',
        parentId: null,
        title: 'Explicit synthetic database',
        kind: 'database',
        database: { properties: [], views: [] },
        noteStyle: explicitStyle,
        now: 2,
      });
      expect(explicitDatabase.ok).toBe(true);
      expect(session.getState().pages['explicit-database']?.noteStyle).toEqual(explicitStyle);

      const note = runWorkspace({
        type: 'page.create',
        id: 'new-note',
        parentId: null,
        title: 'New synthetic note',
        now: 3,
      });
      expect(note.ok).toBe(true);
      expect(session.getState().pages['new-note']?.noteStyle).toEqual(defaultStyle);
    } finally {
      setPreferences({ defaultNoteStyle: originalStyle });
      await session.close();
    }
  });
});
