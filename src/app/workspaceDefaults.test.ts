import { afterEach, describe, expect, it } from 'vitest';
import type { NoteStyle } from '../core/noteStyle';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { getPreferences, setPreferences } from './platform/preferences';
import { run, runAll, setSession } from './workspace';

describe('new page style defaults', () => {
  const preferencesBeforeTest = getPreferences();

  afterEach(() => {
    setPreferences({
      font: preferencesBeforeTest.font,
      width: preferencesBeforeTest.width,
      defaultNoteStyle: preferencesBeforeTest.defaultNoteStyle,
    });
  });

  it('applies the profile default only to new public creations and preserves legacy cases', async () => {
    const vault = new MemoryVault();
    let nextId = 0;
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `defaultStyle${++nextId}`), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);

    const defaultStyle: NoteStyle = {
      font: 'serif',
      fontSize: 19,
      lineHeight: 1.74,
      blockSpacing: 12,
      width: 'wide',
    };
    const explicitStyle: NoteStyle = { ...defaultStyle, width: 'comfortable' };

    try {
      setPreferences({ font: 'sans', width: 'comfortable', defaultNoteStyle: undefined });
      const legacyCreated = run({
        type: 'page.create',
        id: 'legacy-created',
        parentId: null,
        title: 'Legacy default page',
        now: 1,
      });
      expect(legacyCreated.ok).toBe(true);
      expect(session.getState().pages['legacy-created']?.extra.morrowNoteStyle).toBeUndefined();
      await session.flush();
      const legacyPath = session.pathOf('legacy-created');
      if (!legacyPath) throw new Error('The legacy page path was not created.');
      const legacySource = vault.text(legacyPath);
      expect(legacySource).toBeDefined();
      expect(legacySource).not.toContain('morrowNoteStyle');

      const existingStyle: NoteStyle = {
        font: 'mono',
        fontSize: 14.5,
        lineHeight: 1.75,
        blockSpacing: 8,
        width: 'comfortable',
      };
      const existingStyled = run({
        type: 'page.create',
        id: 'existing-styled-page',
        parentId: null,
        title: 'Existing styled page',
        noteStyle: existingStyle,
        now: 2,
      });
      expect(existingStyled.ok).toBe(true);
      await session.flush();
      const existingStyledPath = session.pathOf('existing-styled-page');
      if (!existingStyledPath) throw new Error('The existing styled page path was not created.');
      const existingStyledSource = vault.text(existingStyledPath);
      expect(existingStyledSource).toContain('morrowNoteStyle');

      setPreferences({ defaultNoteStyle: defaultStyle });
      const created = run({
        type: 'page.create',
        id: 'profile-default-page',
        parentId: null,
        title: 'Profile default page',
        now: 2,
      });
      expect(created.ok).toBe(true);
      expect(session.getState().pages['profile-default-page']?.extra.morrowNoteStyle).toEqual(defaultStyle);

      const batch = runAll([
        {
          type: 'page.create',
          id: 'profile-default-database',
          parentId: null,
          title: 'Profile default database',
          kind: 'database',
          database: { properties: [], views: [] },
          now: 3,
        },
        {
          type: 'page.create',
          id: 'explicit-database',
          parentId: null,
          title: 'Explicit database style',
          kind: 'database',
          database: { properties: [], views: [] },
          noteStyle: explicitStyle,
          now: 4,
        },
      ]);
      expect(batch.ok).toBe(true);
      expect(session.getState().pages['profile-default-database']?.extra.morrowNoteStyle).toEqual({
        ...defaultStyle,
        width: 'full',
      });
      expect(session.getState().pages['explicit-database']?.extra.morrowNoteStyle).toEqual(explicitStyle);

      const explicitNote = run({
        type: 'page.create',
        id: 'explicit-note',
        parentId: null,
        title: 'Explicit note style',
        noteStyle: explicitStyle,
        now: 5,
      });
      expect(explicitNote.ok).toBe(true);
      expect(session.getState().pages['explicit-note']?.extra.morrowNoteStyle).toEqual(explicitStyle);

      const canvas = run({
        type: 'page.create',
        id: 'canvas',
        parentId: null,
        title: 'Canvas exception',
        kind: 'canvas',
        now: 6,
      });
      expect(canvas.ok).toBe(true);
      expect(session.getState().pages.canvas?.extra.morrowNoteStyle).toBeUndefined();

      await session.flush();
      expect(vault.text(legacyPath)).toBe(legacySource);
      expect(vault.text(existingStyledPath)).toBe(existingStyledSource);
      expect(session.getState().pages['existing-styled-page']?.extra.morrowNoteStyle).toEqual(existingStyle);
      expect(session.getState().pages['legacy-created']?.extra.morrowNoteStyle).toBeUndefined();
      expect(vault.text(session.pathOf('profile-default-page')!)).toContain('morrowNoteStyle');
    } finally {
      await session.close();
    }
  });
});
