// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { NoteStyle } from '../../core/noteStyle';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import type { VaultOp, VaultOpResult } from '../../core/vault/plan';
import { addPluginNoteStyleDefaultsPanel } from '../plugins/registry';
import type { PluginNoteStyleDefaultsPanelHost } from '../plugins/registry';
import { getPreferences, setPreferences } from '../platform/preferences';
import { run, setSession } from '../workspace';
import { DocumentoNoteStyleDefaultsSettings } from './DocumentoNoteStyleDefaultsSettings';
import { mountNoteStylePanel } from '../../../plugins/polaris-documento/src/noteStylePanel';
import { mountNoteStyleDefaultsPanel } from '../../../plugins/polaris-documento/src/noteStyleDefaultsPanel';
import { createNoteStyleBatchPreviewHost } from './noteStyleBatchPreview';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

class ConflictOnSecondStyleWriteVault extends MemoryVault {
  private conflicted = false;

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    if (
      !this.conflicted &&
      ops.some((op) => op.op === 'write' && op.path === 'Two.md' && op.text.includes('morrowNoteStyle:'))
    ) {
      this.conflicted = true;
      this.external({
        'Two.md': '---\ntitle: Two\nexternal: changed\n---\nExternal edit.\n',
      });
    }
    return super.apply(ops);
  }
}

class HeldFirstStyleWriteVault extends MemoryVault {
  private held = false;
  private enteredResolve!: () => void;
  private releaseResolve!: () => void;
  private readonly gate = new Promise<void>((resolve) => {
    this.releaseResolve = resolve;
  });
  readonly styleWriteStarted = new Promise<void>((resolve) => {
    this.enteredResolve = resolve;
  });

  release(): void {
    this.releaseResolve();
  }

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    if (
      !this.held &&
      ops.some((op) => op.op === 'write' && op.path === 'One.md' && op.text.includes('morrowNoteStyle:'))
    ) {
      this.held = true;
      this.enteredResolve();
      await this.gate;
    }
    return super.apply(ops);
  }
}

const noteSource = (title: string) => `---\ntitle: ${title}\n---\n${title} body.\n`;

async function settleAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Documento default note-style settings', () => {
  const preferencesBeforeTest = getPreferences();
  let disposePanel: (() => void) | null = null;
  let retainedHost: PluginNoteStyleDefaultsPanelHost | null = null;
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

  it('binds the confirmation port to the active mount and preserves unknown YAML', async () => {
    const defaultStyle: NoteStyle = {
      font: 'serif',
      fontSize: 20,
      lineHeight: 1.8,
      blockSpacing: 10,
      width: 'wide',
    };
    const savedStyle = {
      font: 'sans',
      fontSize: 16,
      lineHeight: 1.68,
      blockSpacing: 9,
      width: 'comfortable',
    };
    const source = (title: string) => [
      '---',
      `title: ${title}`,
      'futureSetting:',
      '  mode: retained',
      'morrowNoteStyle:',
      `  font: ${savedStyle.font}`,
      `  fontSize: ${savedStyle.fontSize}`,
      `  lineHeight: ${savedStyle.lineHeight}`,
      `  blockSpacing: ${savedStyle.blockSpacing}`,
      `  width: ${savedStyle.width}`,
      '  futureStyleSetting:',
      '    mode: retained',
      '---',
      `${title} original body.`,
      '',
    ].join('\n');
    const vault = new MemoryVault({ 'One.md': source('One'), 'Two.md': source('Two') });
    let id = 0;
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `confirmation-${++id}`), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    setPreferences({ locale: 'en', font: 'serif', width: 'wide', defaultNoteStyle: defaultStyle });
    disposePanel = addPluginNoteStyleDefaultsPanel('polaris-documento', (panelRoot, host) => {
      retainedHost = host;
      return mountNoteStyleDefaultsPanel(panelRoot, host);
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    const foreignHost = createNoteStyleBatchPreviewHost(() => true, () => true);
    try {
      await act(async () => root?.render(createElement(DocumentoNoteStyleDefaultsSettings)));
      const host = retainedHost;
      if (!host?.batchPreviewConfirmation)
        throw new Error('The active Documento mount did not receive the optional confirmation port.');
      const lease = host.batchPreview.create('overwrite');
      if (!lease) throw new Error('The active Documento mount could not create a preview.');
      const foreignLease = foreignHost.create('overwrite');
      if (!foreignLease) throw new Error('The isolated foreign host could not create its preview.');

      await expect(host.batchPreviewConfirmation.confirm(foreignLease)).resolves.toBeNull();
      expect(lease.isCurrent()).toBe(true);
      const result = await host.batchPreviewConfirmation.confirm(lease);
      expect(result).toMatchObject({
        mode: 'overwrite',
        confirmedCount: 2,
        refusedCount: 0,
        unattemptedCount: 0,
      });
      expect(JSON.stringify(result)).not.toContain('confirmation-');
      expect(await host.batchPreviewConfirmation.confirm(lease)).toBeNull();
      expect(vault.text('One.md')).toContain('futureSetting:\n  mode: retained');
      expect(vault.text('One.md')).toContain('futureStyleSetting:\n    mode: retained');
      expect(vault.text('Two.md')).toContain('futureSetting:\n  mode: retained');
      expect(vault.text('Two.md')).toContain('futureStyleSetting:\n    mode: retained');
      expect(vault.text('One.md')).toContain('One original body.');
      expect(vault.text('Two.md')).toContain('Two original body.');
    } finally {
      foreignHost.invalidate();
      await session.close();
    }
  });

  it('rejects a lease through a confirmation port after its Documento registration closes', async () => {
    const source = '---\ntitle: One\n---\nOriginal body.\n';
    const vault = new MemoryVault({ 'One.md': source });
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => 'closed-port-note'), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    setPreferences({ locale: 'en', font: 'serif', width: 'wide', defaultNoteStyle: undefined });
    disposePanel = addPluginNoteStyleDefaultsPanel('polaris-documento', (panelRoot, host) => {
      retainedHost = host;
      return mountNoteStyleDefaultsPanel(panelRoot, host);
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    try {
      await act(async () => root?.render(createElement(DocumentoNoteStyleDefaultsSettings)));
      const host = retainedHost;
      if (!host?.batchPreviewConfirmation)
        throw new Error('The active Documento mount did not receive the confirmation port.');
      const lease = host.batchPreview.create('preserve');
      if (!lease) throw new Error('The preview lease was not created.');

      await act(async () => {
        disposePanel?.();
        disposePanel = null;
        await Promise.resolve();
      });

      await expect(host.batchPreviewConfirmation.confirm(lease)).resolves.toBeNull();
      expect(vault.text('One.md')).toBe(source);
    } finally {
      await session.close();
    }
  });

  it('retains the old remount refresh for a defaults bundle without live profile updates', async () => {
    setPreferences({ locale: 'en', font: 'serif', width: 'wide', defaultNoteStyle: undefined });
    const capturedDefaults: string[] = [];
    disposePanel = addPluginNoteStyleDefaultsPanel('polaris-documento', (panelRoot, host) => {
      capturedDefaults.push(`${host.initial.font}/${host.initial.width}`);
      const label = document.createElement('p');
      label.dataset.legacyDefaultsMount = 'true';
      label.textContent = capturedDefaults.at(-1)!;
      panelRoot.append(label);
      return () => label.remove();
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root?.render(createElement(DocumentoNoteStyleDefaultsSettings)));
    expect(capturedDefaults).toEqual(['serif/wide']);
    await act(async () => {
      setPreferences({ font: 'mono', width: 'full' });
      await Promise.resolve();
    });

    expect(capturedDefaults).toEqual(['serif/wide', 'mono/full']);
    expect(container.querySelector('[data-legacy-defaults-mount="true"]')?.textContent).toBe(
      'mono/full',
    );
  });

  it('keeps a partial confirmation receipt when base font and width change', async () => {
    const conflictSource = '---\ntitle: Two\nexternal: changed\n---\nExternal edit.\n';
    const vault = new ConflictOnSecondStyleWriteVault({
      'One.md': noteSource('One'),
      'Two.md': noteSource('Two'),
    });
    let id = 0;
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `partial-refresh-${++id}`), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    setPreferences({ locale: 'en', font: 'serif', width: 'wide', defaultNoteStyle: undefined });
    disposePanel = addPluginNoteStyleDefaultsPanel(
      'polaris-documento',
      mountNoteStyleDefaultsPanel,
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    try {
      await act(async () => root?.render(createElement(DocumentoNoteStyleDefaultsSettings)));
      const click = (action: string) => {
        const button = container?.querySelector<HTMLButtonElement>(
          `[data-note-style-batch-action="${action}"]`,
        );
        if (!button) throw new Error(`The ${action} control is missing.`);
        button.click();
      };
      await act(async () => {
        click('preview');
        click('begin-apply');
        click('confirm');
        await settleAsyncWork();
      });

      const receipt = container.querySelector('.note-style-batch-result-counts');
      if (!receipt) throw new Error('The partial confirmation receipt did not render.');
      expect(container.querySelector('[data-note-style-batch-result-count="confirmed"]')?.textContent).toBe(
        'Confirmed: 1',
      );
      expect(container.querySelector('[data-note-style-batch-result-count="refused"]')?.textContent).toBe(
        'Refused: 1',
      );
      expect(container.querySelector('[data-note-style-batch-result-count="unattempted"]')?.textContent).toBe(
        'Not attempted: 0',
      );
      expect(vault.text('One.md')).toContain('morrowNoteStyle:');
      expect(vault.text('Two.md')).toBe(conflictSource);

      const panel = container.querySelector('.note-style-batch-preview');
      await act(async () => {
        setPreferences({ font: 'mono', width: 'full' });
        await Promise.resolve();
      });

      expect(container.querySelector('.note-style-batch-preview')).toBe(panel);
      expect(container.querySelector('.note-style-batch-result-counts')).toBe(receipt);
      expect(container.querySelector('[data-note-style-batch-result-count="confirmed"]')?.textContent).toBe(
        'Confirmed: 1',
      );
      expect(container.querySelector('[data-note-style-batch-result-count="refused"]')?.textContent).toBe(
        'Refused: 1',
      );
      expect(container.querySelector<HTMLSelectElement>('[data-note-style-field="font"]')?.value).toBe(
        'mono',
      );
      expect(container.querySelector<HTMLSelectElement>('[data-note-style-field="width"]')?.value).toBe(
        'full',
      );
    } finally {
      await session.close();
    }
  });

  it('keeps the confirmed partial result when base font and width change during a write', async () => {
    const originals = { 'One.md': noteSource('One'), 'Two.md': noteSource('Two') };
    const vault = new HeldFirstStyleWriteVault(originals);
    let id = 0;
    const opened = await WorkspaceSession.open(new VaultRepository(vault, () => `io-refresh-${++id}`), {
      delayMs: 0,
    });
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    setPreferences({ locale: 'en', font: 'serif', width: 'wide', defaultNoteStyle: undefined });
    disposePanel = addPluginNoteStyleDefaultsPanel(
      'polaris-documento',
      mountNoteStyleDefaultsPanel,
    );
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    try {
      await act(async () => root?.render(createElement(DocumentoNoteStyleDefaultsSettings)));
      const click = (action: string) => {
        const button = container?.querySelector<HTMLButtonElement>(
          `[data-note-style-batch-action="${action}"]`,
        );
        if (!button) throw new Error(`The ${action} control is missing.`);
        button.click();
      };
      await act(async () => {
        click('preview');
        click('begin-apply');
        click('confirm');
        await Promise.resolve();
      });
      await vault.styleWriteStarted;
      const panel = container.querySelector('.note-style-batch-preview');

      await act(async () => {
        setPreferences({ font: 'mono', width: 'full' });
        await Promise.resolve();
      });
      expect(container.querySelector('.note-style-batch-preview')).toBe(panel);
      vault.release();
      await act(async () => settleAsyncWork());

      expect(container.querySelector('[data-note-style-batch-result-count="confirmed"]')?.textContent).toBe(
        'Confirmed: 1',
      );
      expect(container.querySelector('[data-note-style-batch-result-count="refused"]')?.textContent).toBe(
        'Refused: 0',
      );
      expect(container.querySelector('[data-note-style-batch-result-count="unattempted"]')?.textContent).toBe(
        'Not attempted: 1',
      );
      expect(container.querySelector('[data-note-style-batch-outcome="confirmed"]')?.textContent).toBe(
        'One: Applied',
      );
      expect(container.querySelector('[data-note-style-batch-outcome="unattempted"]')?.textContent).toBe(
        'Two: Not attempted',
      );
      expect(vault.text('One.md')).toContain('morrowNoteStyle:');
      expect(vault.text('Two.md')).toBe(originals['Two.md']);
      expect(container.querySelector<HTMLSelectElement>('[data-note-style-field="font"]')?.value).toBe(
        'mono',
      );
      expect(container.querySelector<HTMLSelectElement>('[data-note-style-field="width"]')?.value).toBe(
        'full',
      );
    } finally {
      vault.release();
      await session.close();
    }
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
      let result!: Awaited<ReturnType<typeof host.save>>;
      await act(async () => {
        result = await host.save(expected);
      });
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
