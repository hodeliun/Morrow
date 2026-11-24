// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoteStyle } from '../../core/noteStyle';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { addPluginNoteStyleDefaultsPanel } from '../plugins/registry';
import type { PluginNoteStylePanelHost } from '../plugins/registry';
import { getPreferences, setPreferences } from '../platform/preferences';
import { run, setSession } from '../workspace';
import { DocumentoNoteStyleDefaultsSettings } from './DocumentoNoteStyleDefaultsSettings';
import { mountNoteStylePanel } from '../../../plugins/polaris-documento/src/noteStylePanel';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('Documento default note-style settings', () => {
  const preferencesBeforeTest = getPreferences();
  let disposePanel: (() => void) | null = null;
  let retainedHost: PluginNoteStylePanelHost | null = null;
  let root: ReturnType<typeof createRoot> | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    disposePanel?.();
    disposePanel = null;
    retainedHost = null;
    setPreferences({
      locale: preferencesBeforeTest.locale,
      font: preferencesBeforeTest.font,
      width: preferencesBeforeTest.width,
      defaultNoteStyle: preferencesBeforeTest.defaultNoteStyle,
    });
  });

  it('shows the Documento-owned defaults form in Appearance and saves separately from a note', async () => {
    setPreferences({ locale: 'en', font: 'sans', width: 'comfortable', defaultNoteStyle: undefined });
    disposePanel = addPluginNoteStyleDefaultsPanel('polaris-documento', (root, host) => {
      retainedHost = host;
      return mountNoteStylePanel(root, host);
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(createElement(DocumentoNoteStyleDefaultsSettings)));

    expect(container.textContent).toContain('Default for new pages');
    const form = container.querySelector('form.note-style-panel');
    expect(form?.getAttribute('aria-label')).toBe('Default for new pages');
    const save = container.querySelector<HTMLButtonElement>('[data-note-style-action="save"]');
    const restore = container.querySelector<HTMLButtonElement>('[data-note-style-action="restore"]');
    expect(save?.textContent).toBe('Save default');
    expect(restore?.textContent).toBe('Restore profile default');
    const host = retainedHost;
    if (!host) throw new Error('The Documento default settings host did not mount.');
    await expect(
      host.save({
        font: 'serif',
        fontSize: 50,
        lineHeight: 1.68,
        blockSpacing: 9,
        width: 'wide',
      } as NoteStyle),
    ).resolves.toMatchObject({ ok: false });
    expect(getPreferences().defaultNoteStyle).toBeUndefined();

    const font = container.querySelector<HTMLSelectElement>('[data-note-style-field="font"]');
    const fontSize = container.querySelector<HTMLInputElement>('[data-note-style-field="fontSize"]');
    if (!font || !fontSize || !form || !save || !restore) throw new Error('Style controls did not mount.');
    font.value = 'serif';
    font.dispatchEvent(new Event('change', { bubbles: true }));
    fontSize.value = '21';
    fontSize.dispatchEvent(new Event('input', { bubbles: true }));

    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(getPreferences().defaultNoteStyle).toEqual({
      font: 'serif',
      fontSize: 21,
      lineHeight: 1.68,
      blockSpacing: 9,
      width: 'comfortable',
    });
    expect(getPreferences().font).toBe('sans');
    expect(getPreferences().width).toBe('comfortable');
    expect(JSON.parse(localStorage.getItem('morrow.preferences') ?? '{}').defaultNoteStyle).toEqual(
      getPreferences().defaultNoteStyle,
    );
    expect(container.querySelector('.note-style-status')?.textContent).toBe(
      'Default style for new pages saved.',
    );

    await act(async () => {
      restore.click();
      await Promise.resolve();
    });
    expect(getPreferences().defaultNoteStyle).toBeUndefined();
    expect(container.querySelector('.note-style-status')?.textContent).toBe(
      'New pages now use the profile font and width.',
    );

    act(() => {
      root?.unmount();
      root = null;
    });
    const retainedStyle: NoteStyle = {
      font: 'mono',
      fontSize: 14.5,
      lineHeight: 1.75,
      blockSpacing: 8,
      width: 'full',
    };
    setPreferences({ defaultNoteStyle: retainedStyle });
    await expect(host.save(retainedStyle)).resolves.toMatchObject({ ok: false });
    await expect(host.restore()).resolves.toMatchObject({ ok: false });
    expect(getPreferences().defaultNoteStyle).toEqual(retainedStyle);
  });

  it('does not show a host-only controls block when Documento is not active', async () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(createElement(DocumentoNoteStyleDefaultsSettings)));

    expect(container.querySelector('.settings-group-wrap')).toBeNull();
  });

  it('returns a saved snapshot that cannot mutate the profile or the next page default', async () => {
    setPreferences({ locale: 'en', font: 'sans', width: 'comfortable', defaultNoteStyle: undefined });
    disposePanel = addPluginNoteStyleDefaultsPanel('polaris-documento', (panelRoot, host) => {
      retainedHost = host;
      return mountNoteStylePanel(panelRoot, host);
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(DocumentoNoteStyleDefaultsSettings)));

    const host = retainedHost;
    if (!host) throw new Error('The Documento default settings host did not mount.');
    const opened = await WorkspaceSession.open(new VaultRepository(new MemoryVault(), () => 'snapshot-id'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    try {
      const expected: NoteStyle = {
        font: 'serif',
        fontSize: 20,
        lineHeight: 1.8,
        blockSpacing: 11,
        width: 'wide',
      };
      const result = await host.save(expected);
      if (!result.ok) throw new Error('The profile default could not be saved.');
      result.style.font = 'mono';

      expect(getPreferences().defaultNoteStyle).toEqual(expected);
      const created = run({
        type: 'page.create',
        id: 'after-mutated-save-result',
        parentId: null,
        title: 'Created from saved preference',
        now: 1,
      });
      expect(created.ok).toBe(true);
      expect(session.getState().pages['after-mutated-save-result']?.extra.morrowNoteStyle).toEqual(expected);
    } finally {
      await session.close();
    }
  });
});
