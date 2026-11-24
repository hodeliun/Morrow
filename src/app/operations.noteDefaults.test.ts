import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../core/commands';
import type { NoteStyle } from '../core/noteStyle';
import { readPageText } from '../core/vault/pageFile';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { applyTemplateTo, createFromTemplate, ensureToday, saveAsTemplate } from './operations';
import { getPreferences, setPreferences } from './platform/preferences';
import { setSession } from './workspace';

vi.mock('./router', () => ({ navigate: vi.fn(), openPage: vi.fn(), parseRoute: vi.fn() }));

describe('template note styles with profile defaults', () => {
  const preferencesBeforeTest = getPreferences();
  let session: WorkspaceSession | null = null;

  afterEach(async () => {
    await session?.close();
    session = null;
    setPreferences({
      font: preferencesBeforeTest.font,
      width: preferencesBeforeTest.width,
      defaultNoteStyle: preferencesBeforeTest.defaultNoteStyle,
    });
  });

  it('keeps a new template page style over the profile default through save and reload', async () => {
    const vault = new MemoryVault();
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'template-reload-id'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    session = opened.value;
    setSession(session);

    const templateStyle = {
      font: 'serif',
      fontSize: 19,
      lineHeight: 1.74,
      blockSpacing: 12,
      width: 'wide',
      futureStyle: { version: 7, token: '{{date}}' },
    };
    const profileStyle: NoteStyle = {
      font: 'mono',
      fontSize: 14.5,
      lineHeight: 1.75,
      blockSpacing: 8,
      width: 'comfortable',
    };
    const execute = (command: Command) => {
      const result = session!.execute(command);
      if (!result.ok) throw new Error(result.error);
    };

    execute({
      type: 'page.create',
      id: 'templates-root',
      parentId: null,
      title: 'Templates',
      kind: 'templates',
      now: 1,
    });
    execute({
      type: 'page.create',
      id: 'daily-template',
      parentId: 'templates-root',
      title: 'Daily note',
      now: 2,
    });
    execute({
      type: 'page.setFields',
      id: 'daily-template',
      extra: { morrowNoteStyle: templateStyle },
      now: 3,
    });
    execute({
      type: 'page.create',
      id: 'existing-note',
      parentId: null,
      title: 'Existing note',
      now: 4,
    });
    const existingStyle: NoteStyle = {
      font: 'sans',
      fontSize: 18,
      lineHeight: 1.7,
      blockSpacing: 10,
      width: 'full',
    };
    execute({
      type: 'page.setFields',
      id: 'existing-note',
      extra: { morrowNoteStyle: existingStyle },
      now: 5,
    });
    expect(Object.keys(session.getState().pages['daily-template']!.extra)).toEqual(['morrowNoteStyle']);

    setPreferences({ defaultNoteStyle: profileStyle });
    const dailyId = ensureToday(new Date(2026, 3, 8, 12));
    const copiedId = createFromTemplate('daily-template', null);
    if (!dailyId || !copiedId) throw new Error('Expected both template-based pages to be created.');
    expect(applyTemplateTo('existing-note', 'daily-template')).toBe(true);
    expect(session.getState().pages['existing-note']?.extra.morrowNoteStyle).toEqual(existingStyle);
    expect(session.getState().pages[dailyId]?.extra.morrowNoteStyle).toEqual(templateStyle);
    expect(session.getState().pages[copiedId]?.extra.morrowNoteStyle).toEqual(templateStyle);

    await session.flush();
    for (const id of [dailyId, copiedId]) {
      const path = session.pathOf(id);
      if (!path) throw new Error(`Missing file path for created page ${id}.`);
      const source = vault.text(path);
      if (source === undefined) throw new Error(`Missing saved source for created page ${id}.`);
      expect(readPageText(source).extra.morrowNoteStyle).toEqual(templateStyle);
    }

    await session.close();
    session = null;
    const reloaded = await WorkspaceSession.open(new VaultRepository(vault, () => 'unexpected-new-id'), {
      delayMs: 0,
    });
    if (!reloaded.ok) throw new Error(reloaded.error);
    session = reloaded.value;
    for (const id of [dailyId, copiedId])
      expect(session.getState().pages[id]?.extra.morrowNoteStyle).toEqual(templateStyle);
  });

  it('keeps the new-page default when a template is saved from empty or metadata-only notes', async () => {
    const vault = new MemoryVault();
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'template-copy-id'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    session = opened.value;
    setSession(session);

    const defaultAtSave: NoteStyle = {
      font: 'mono',
      fontSize: 14.5,
      lineHeight: 1.75,
      blockSpacing: 8,
      width: 'comfortable',
    };
    const changedDefault: NoteStyle = {
      font: 'sans',
      fontSize: 21,
      lineHeight: 1.82,
      blockSpacing: 13,
      width: 'full',
    };
    const explicitRawStyle = {
      font: 'serif',
      fontSize: 19,
      lineHeight: 1.74,
      blockSpacing: 12,
      width: 'wide',
      futureStyle: { mode: 'keep', token: '{{title}}' },
    };
    const metadata = { owner: 'original author', custom: { source: 'external' } };
    const execute = (command: Command) => {
      const result = session!.execute(command);
      if (!result.ok) throw new Error(result.error);
    };

    execute({
      type: 'page.create',
      id: 'templates-root',
      parentId: null,
      title: 'Templates',
      kind: 'templates',
      now: 1,
    });
    const sources = [
      { id: 'empty-source', title: 'Empty source', extra: {} },
      { id: 'metadata-source', title: 'Metadata source', extra: metadata },
      {
        id: 'explicit-style-source',
        title: 'Explicit style source',
        extra: { owner: 'style author', morrowNoteStyle: explicitRawStyle },
      },
    ] as const;
    sources.forEach((source, index) => {
      execute({
        type: 'page.create',
        id: source.id,
        parentId: null,
        title: source.title,
        now: index + 2,
      });
      if (Object.keys(source.extra).length)
        execute({ type: 'page.setFields', id: source.id, extra: source.extra, now: index + 5 });
    });

    setPreferences({ defaultNoteStyle: defaultAtSave });
    for (const source of sources) saveAsTemplate(source.id);
    const sourceTemplates = Object.fromEntries(
      sources.map((source) => {
        const template = Object.values(session!.getState().pages).find(
          (page) => page.parentId === 'templates-root' && page.title === source.title,
        );
        if (!template) throw new Error(`No template copy was saved for ${source.id}.`);
        return [source.id, template.id];
      }),
    ) as Record<(typeof sources)[number]['id'], string>;

    expect(session.getState().pages['empty-source']?.extra).toEqual({});
    expect(session.getState().pages['metadata-source']?.extra).toEqual(metadata);
    expect(session.getState().pages['explicit-style-source']?.extra).toEqual({
      owner: 'style author',
      morrowNoteStyle: explicitRawStyle,
    });
    expect(session.getState().pages[sourceTemplates['empty-source']]?.extra).toEqual({
      morrowNoteStyle: defaultAtSave,
    });
    expect(session.getState().pages[sourceTemplates['metadata-source']]?.extra).toEqual({
      morrowNoteStyle: defaultAtSave,
      ...metadata,
    });
    expect(session.getState().pages[sourceTemplates['explicit-style-source']]?.extra).toEqual({
      owner: 'style author',
      morrowNoteStyle: explicitRawStyle,
    });

    await session.flush();
    await session.close();
    session = null;
    const reloaded = await WorkspaceSession.open(new VaultRepository(vault, () => 'unexpected-copy-id'), {
      delayMs: 0,
    });
    if (!reloaded.ok) throw new Error(reloaded.error);
    session = reloaded.value;
    setSession(session);

    setPreferences({ defaultNoteStyle: changedDefault });
    const createdPages = Object.fromEntries(
      sources.map((source) => {
        const id = createFromTemplate(sourceTemplates[source.id]!, null);
        if (!id) throw new Error(`No page was created from ${source.id}'s template.`);
        return [source.id, id];
      }),
    ) as Record<(typeof sources)[number]['id'], string>;

    expect(session.getState().pages[createdPages['empty-source']]?.extra).toEqual({
      morrowNoteStyle: defaultAtSave,
    });
    expect(session.getState().pages[createdPages['metadata-source']]?.extra).toEqual({
      morrowNoteStyle: defaultAtSave,
      ...metadata,
    });
    expect(session.getState().pages[createdPages['explicit-style-source']]?.extra).toEqual({
      owner: 'style author',
      morrowNoteStyle: explicitRawStyle,
    });
  });

  it('keeps all 200 source extras when the default style cannot fit', async () => {
    const vault = new MemoryVault();
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'max-extra-id'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    session = opened.value;
    setSession(session);

    const keys = Array.from({ length: 200 }, (_, index) => `sourceField${String(index).padStart(3, '0')}`);
    const originalExtra = Object.fromEntries(keys.map((key, index) => [key, `source value ${index}`]));
    const execute = (command: Command) => {
      const result = session!.execute(command);
      if (!result.ok) throw new Error(result.error);
    };
    execute({
      type: 'page.create',
      id: 'templates-root',
      parentId: null,
      title: 'Templates',
      kind: 'templates',
      now: 1,
    });
    execute({
      type: 'page.create',
      id: 'max-extra-source',
      parentId: null,
      title: 'Maximum metadata source',
      now: 2,
    });
    execute({
      type: 'page.setFields',
      id: 'max-extra-source',
      extra: originalExtra,
      now: 3,
    });

    setPreferences({
      defaultNoteStyle: {
        font: 'serif',
        fontSize: 18,
        lineHeight: 1.7,
        blockSpacing: 10,
        width: 'wide',
      },
    });
    saveAsTemplate('max-extra-source');
    const template = Object.values(session.getState().pages).find(
      (page) => page.parentId === 'templates-root' && page.title === 'Maximum metadata source',
    );
    if (!template) throw new Error('The maximum metadata template was not created.');

    expect(session.getState().pages['max-extra-source']?.extra).toEqual(originalExtra);
    expect(Object.keys(template.extra)).toEqual(keys);
    expect(template.extra).toEqual(originalExtra);
    expect(template.extra.morrowNoteStyle).toBeUndefined();
    await session.flush();

    const sourcePath = session.pathOf('max-extra-source');
    const templatePath = session.pathOf(template.id);
    if (!sourcePath || !templatePath) throw new Error('The source or template file was not saved.');
    expect(readPageText(vault.text(sourcePath)!).extra).toEqual(originalExtra);
    expect(readPageText(vault.text(templatePath)!).extra).toEqual(originalExtra);

    await session.close();
    session = null;
    const reloaded = await WorkspaceSession.open(new VaultRepository(vault, () => 'unexpected-max-extra-id'), {
      delayMs: 0,
    });
    if (!reloaded.ok) throw new Error(reloaded.error);
    session = reloaded.value;
    expect(session.getState().pages['max-extra-source']?.extra).toEqual(originalExtra);
    expect(Object.keys(session.getState().pages[template.id]!.extra)).toEqual(keys);
    expect(session.getState().pages[template.id]?.extra).toEqual(originalExtra);
  });
});
