// @vitest-environment happy-dom
import { act, createElement, Fragment, StrictMode } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteStyle } from '../../core/noteStyle';
import type { PageId } from '../../core/model';
import { MemoryVault } from '../../storage/memoryVault';
import type { VaultOp, VaultOpResult } from '../../core/vault/plan';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { addPluginNoteStylePanel } from '../plugins/registry';
import type { PluginNoteStylePanelHost, PluginNoteStylePanelResult } from '../plugins/registry';
import { setPreferences } from '../platform/preferences';
import { PaneContext } from '../tabs';
import { setSession } from '../workspace';
import { NoteStyleAction } from './NoteStyleAction';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PROFILE_STYLE: NoteStyle = {
  font: 'serif',
  fontSize: 20,
  lineHeight: 1.7,
  blockSpacing: 10,
  width: 'full',
};
const SAVED_STYLE: NoteStyle = {
  font: 'mono',
  fontSize: 15.5,
  lineHeight: 1.82,
  blockSpacing: 13,
  width: 'wide',
};

interface MountedPanel {
  host: PluginNoteStylePanelHost;
  draft: HTMLInputElement;
  save: HTMLButtonElement;
  restore: HTMLButtonElement;
  cancel: HTMLButtonElement;
  result: Promise<PluginNoteStylePanelResult> | null;
  disposed: boolean;
}

function registerRenderer(mounted: MountedPanel[]) {
  return addPluginNoteStylePanel('polaris-documento', (container, host) => {
    const entry: MountedPanel = {
      host,
      draft: container.ownerDocument.createElement('input'),
      save: container.ownerDocument.createElement('button'),
      restore: container.ownerDocument.createElement('button'),
      cancel: container.ownerDocument.createElement('button'),
      result: null,
      disposed: false,
    };
    entry.draft.type = 'text';
    entry.draft.setAttribute('aria-label', 'Uncommitted style draft');
    entry.save.type = entry.restore.type = entry.cancel.type = 'button';
    entry.save.textContent = host.labels.save;
    entry.restore.textContent = host.labels.restore;
    entry.cancel.textContent = host.labels.cancel;
    entry.save.addEventListener('click', () => {
      entry.save.focus();
      entry.result = host.save(SAVED_STYLE);
    });
    entry.restore.addEventListener('click', () => {
      entry.restore.focus();
      entry.result = host.restore();
    });
    entry.cancel.addEventListener('click', () => {
      entry.cancel.focus();
      host.cancel();
    });
    container.append(entry.draft, entry.save, entry.restore, entry.cancel);
    mounted.push(entry);
    return () => {
      entry.disposed = true;
      container.replaceChildren();
    };
  });
}

class DelayedStyleVault extends MemoryVault {
  private started!: () => void;
  private release!: () => void;
  readonly styleWriteStarted = new Promise<void>((resolve) => {
    this.started = resolve;
  });
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private delayed = false;

  releaseStyleWrite(): void {
    this.release();
  }

  override async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    if (
      !this.delayed &&
      ops.some((op) => op.op === 'write' && op.path === 'Note.md' && op.text.includes('morrowNoteStyle:'))
    ) {
      this.delayed = true;
      this.started();
      await this.gate;
    }
    return super.apply(ops);
  }
}

let nextDatabase = 0;
let cleanupRegistration: (() => void) | null = null;
let activeSession: WorkspaceSession | null = null;

async function open(files: Record<string, string>, vault?: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(
    new VaultRepository(vault ?? new MemoryVault(files), () => `style-action-${nextDatabase++}`),
    { delayMs: 0 },
  );
  if (!opened.ok) throw new Error(opened.error);
  activeSession = opened.value;
  setSession(opened.value);
  return opened.value;
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function action(pageId: PageId, pane: 'main' | 'side' = 'main') {
  return createElement(
    'section',
    { className: 'pane is-active', 'data-pane': pane },
    createElement(PaneContext.Provider, { value: pane }, createElement(NoteStyleAction, { pageId })),
  );
}

function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  return {
    container,
    root,
    render: async (next: ReactNode) => act(async () => root.render(next)),
    unmount: async () => act(async () => root.unmount()),
  };
}

function installUiStubs(frames: FrameRequestCallback[]) {
  class ResizeObserverStub {
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
}

async function clickAndSettle(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    const pane = button.closest<HTMLElement>('.pane[data-pane]');
    if (pane) {
      for (const sibling of pane.ownerDocument.querySelectorAll<HTMLElement>('.pane[data-pane]'))
        sibling.classList.toggle('is-active', sibling === pane);
    }
    button.focus();
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(async () => {
  cleanupRegistration?.();
  cleanupRegistration = null;
  if (activeSession && !activeSession.isClosed) await activeSession.close();
  activeSession = null;
  document.body.replaceChildren();
  window.localStorage.clear();
  setPreferences({ locale: 'en', readingMode: false, defaultNoteStyle: undefined, pageWidths: {} });
  vi.unstubAllGlobals();
});

describe('host note-style action', () => {
  it('stays absent until Documento registers, then binds two panes to separate confirmed writes', async () => {
    const session = await open({ 'Note.md': 'First note.\n', 'Other.md': 'Second note.\n' });
    const firstId = pageIdAt(session, 'Note.md');
    const secondId = pageIdAt(session, 'Other.md');
    setPreferences({ defaultNoteStyle: PROFILE_STYLE, font: 'sans', width: 'wide', readingMode: false });
    const frames: FrameRequestCallback[] = [];
    installUiStubs(frames);
    const app = mount();
    const mounted: MountedPanel[] = [];

    try {
      expect(app.container.querySelectorAll('[aria-label="Page style"]')).toHaveLength(0);
      cleanupRegistration = registerRenderer(mounted);
      await app.render(createElement(Fragment, null, action(firstId, 'main'), action(secondId, 'side')));
      const triggers = [...app.container.querySelectorAll<HTMLButtonElement>('[aria-label="Page style"]')];
      expect(triggers).toHaveLength(2);

      await clickAndSettle(triggers[0]!);
      const firstMount = mounted[0]!;
      firstMount.draft.value = 'Keep this draft';
      await clickAndSettle(triggers[0]!);
      expect(mounted).toHaveLength(1);
      expect(firstMount.disposed).toBe(false);
      expect(firstMount.draft.value).toBe('Keep this draft');
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(1);

      await clickAndSettle(triggers[1]!);
      expect(mounted).toHaveLength(2);
      expect(mounted.map((entry) => entry.host.initial)).toEqual([PROFILE_STYLE, PROFILE_STYLE]);
      expect(firstMount.disposed).toBe(true);
      expect(mounted[1]!.disposed).toBe(false);
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(1);

      const escapeTarget = document.querySelector<HTMLButtonElement>(
        '.note-style-popover button',
      )!;
      escapeTarget.focus();
      await act(async () => {
        escapeTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(mounted[1]!.disposed).toBe(true);
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(0);
      const escapeFocus = frames.shift();
      expect(escapeFocus).toBeTypeOf('function');
      await act(async () => escapeFocus?.(0));
      expect(document.activeElement).toBe(triggers[1]);

      await clickAndSettle(triggers[0]!);

      await act(async () => {
        mounted[2]!.save.click();
        await mounted[2]!.result;
      });
      expect(await mounted[2]!.result).toMatchObject({ ok: true, style: SAVED_STYLE });
      expect(mounted[2]!.disposed).toBe(true);
      expect(session.readNoteStyle(firstId)).toMatchObject({ ok: true, value: { style: SAVED_STYLE } });
      expect(document.activeElement).toBe(document.body);
      expect(triggers[0]!.closest('.pane[data-pane]')?.classList.contains('is-active')).toBe(true);
      const confirmationFocus = frames.shift();
      expect(confirmationFocus).toBeTypeOf('function');
      await act(async () => confirmationFocus?.(0));
      expect(document.activeElement).toBe(triggers[0]);

      await clickAndSettle(triggers[1]!);
      await act(async () => {
        mounted[3]!.restore.click();
        await mounted[3]!.result;
      });
      expect(await mounted[3]!.result).toMatchObject({ ok: true, style: PROFILE_STYLE });
      expect(session.readNoteStyle(secondId)).toMatchObject({ ok: true, value: { style: PROFILE_STYLE } });
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(0);

      const firstText = session.pathOf(firstId)!;
      const secondText = session.pathOf(secondId)!;
      expect(session.hasWritableNoteStyleSource(firstId)).toBe(true);
      expect(session.hasWritableNoteStyleSource(secondId)).toBe(true);
      expect(firstText).toBe('Note.md');
      expect(secondText).toBe('Other.md');
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('passes the release sample labels through to Documento in English and Portuguese', async () => {
    const session = await open({ 'Note.md': 'A note.\n' });
    const noteId = pageIdAt(session, 'Note.md');
    setPreferences({ readingMode: false, locale: 'en' });
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const app = mount();

    try {
      await app.render(action(noteId));
      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);
      expect(mounted[0]!.host.labels.previewWidth).toBe('Page width preview');
      expect(mounted[0]!.host.labels.previewHeading).toBe('Preview heading');
      expect(mounted[0]!.host.labels.previewBody).toBe('This is a preview of your text.');

      await act(async () => mounted[0]!.cancel.click());
      await act(async () => setPreferences({ locale: 'pt' }));
      await app.render(action(noteId));
      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Estilo da página"]')!);

      expect(mounted[1]!.host.labels.previewWidth).toBe('Prévia da largura da página');
      expect(mounted[1]!.host.labels.previewHeading).toBe('Prévia do título');
      expect(mounted[1]!.host.labels.previewBody).toBe('Esta é uma prévia do texto.');
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('invalidates a panel across A to B to A and across Documento unregister/reload', async () => {
    const session = await open({ 'Note.md': 'First note.\n', 'Other.md': 'Second note.\n' });
    const noteId = pageIdAt(session, 'Note.md');
    const otherId = pageIdAt(session, 'Other.md');
    setPreferences({ readingMode: false });
    installUiStubs([]);
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const app = mount();

    try {
      await app.render(action(noteId));
      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);
      const first = mounted[0]!;
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(1);

      await app.render(action(otherId));
      expect(first.disposed).toBe(true);
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(0);

      await app.render(action(noteId));
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(0);
      let staleResult: PluginNoteStylePanelResult | null = null;
      await act(async () => {
        staleResult = await first.host.save(SAVED_STYLE);
      });
      expect(staleResult).toMatchObject({ ok: false });
      expect(session.readNoteStyle(noteId)).toMatchObject({ ok: true, value: { style: null } });

      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);
      const second = mounted[1]!;
      await app.render(action(noteId, 'side'));
      expect(second.disposed).toBe(true);
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(0);

      await app.render(action(noteId, 'main'));
      staleResult = null;
      await act(async () => {
        staleResult = await second.host.save(SAVED_STYLE);
      });
      expect(staleResult).toMatchObject({ ok: false });
      expect(session.readNoteStyle(noteId)).toMatchObject({ ok: true, value: { style: null } });

      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);
      const third = mounted[2]!;
      const unregister = cleanupRegistration!;
      cleanupRegistration = null;
      await act(async () => {
        unregister();
        await Promise.resolve();
      });
      expect(third.disposed).toBe(true);
      expect(app.container.querySelector('[aria-label="Page style"]')).toBeNull();

      await act(async () => {
        cleanupRegistration = registerRenderer(mounted);
        await Promise.resolve();
      });
      await app.render(action(noteId));
      expect(document.querySelectorAll('[role="dialog"][aria-label="Page style"]')).toHaveLength(0);
      staleResult = null;
      await act(async () => {
        staleResult = await third.host.save(SAVED_STYLE);
      });
      expect(staleResult).toMatchObject({ ok: false });
      expect(session.readNoteStyle(noteId)).toMatchObject({ ok: true, value: { style: null } });

      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);
      expect(mounted).toHaveLength(4);
      expect(mounted[3]!.disposed).toBe(false);
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('does not restore focus after an outside click', async () => {
    const session = await open({ 'Note.md': 'A note.\n' });
    const noteId = pageIdAt(session, 'Note.md');
    setPreferences({ readingMode: false });
    const frames: FrameRequestCallback[] = [];
    installUiStubs(frames);
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const marker = document.createElement('button');
    marker.textContent = 'Outside target';
    document.body.append(marker);
    const app = mount();

    try {
      await app.render(action(noteId));
      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);
      expect(document.querySelector('[role="dialog"][aria-label="Page style"]')).not.toBeNull();

      await act(async () => {
        marker.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        marker.focus();
      });

      expect(document.querySelector('[role="dialog"][aria-label="Page style"]')).toBeNull();
      expect(document.activeElement).toBe(marker);
      expect(frames).toHaveLength(0);
      expect(mounted[0]!.disposed).toBe(true);
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('invalidates callbacks from a renderer mount replayed by StrictMode', async () => {
    const vault = new MemoryVault({ 'Note.md': 'A note.\n' });
    const session = await open({}, vault);
    const noteId = pageIdAt(session, 'Note.md');
    setPreferences({ readingMode: false });
    const frames: FrameRequestCallback[] = [];
    installUiStubs(frames);
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const app = mount();

    try {
      await app.render(createElement(StrictMode, null, action(noteId)));
      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);

      expect(mounted.length).toBeGreaterThanOrEqual(2);
      const staleMount = mounted[0]!;
      const activeMount = mounted.at(-1)!;
      expect(staleMount.disposed).toBe(true);
      expect(activeMount.disposed).toBe(false);

      let staleSave: PluginNoteStylePanelResult | null = null;
      let staleRestore: PluginNoteStylePanelResult | null = null;
      await act(async () => {
        staleSave = await staleMount.host.save(SAVED_STYLE);
        staleRestore = await staleMount.host.restore();
        staleMount.host.cancel();
      });
      expect(staleSave).toMatchObject({ ok: false });
      expect(staleRestore).toMatchObject({ ok: false });
      expect(vault.text('Note.md')).toBe('A note.\n');
      expect(frames).toHaveLength(0);

      await act(async () => {
        activeMount.save.click();
        await activeMount.result;
      });
      expect(await activeMount.result).toMatchObject({ ok: true, style: SAVED_STYLE });
      expect(session.readNoteStyle(noteId)).toMatchObject({ ok: true, value: { style: SAVED_STYLE } });
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('invalidates a retained host callback when the renderer mount throws', async () => {
    const vault = new MemoryVault({ 'Note.md': 'A note.\n' });
    await open({}, vault);
    const noteId = pageIdAt(activeSession!, 'Note.md');
    setPreferences({ readingMode: false });
    let retainedHost: PluginNoteStylePanelHost | null = null;
    cleanupRegistration = addPluginNoteStylePanel('polaris-documento', (_container, host) => {
      retainedHost = host;
      throw new Error('synthetic mount failure');
    });
    const app = mount();

    try {
      await app.render(action(noteId));
      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);
      expect(document.querySelector('[role="alert"]')).not.toBeNull();

      let save: PluginNoteStylePanelResult | null = null;
      let restore: PluginNoteStylePanelResult | null = null;
      await act(async () => {
        save = await retainedHost!.save(SAVED_STYLE);
        restore = await retainedHost!.restore();
        retainedHost!.cancel();
      });
      expect(save).toMatchObject({ ok: false });
      expect(restore).toMatchObject({ ok: false });
      expect(vault.text('Note.md')).toBe('A note.\n');
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('checks live reading mode before opening and dispatching a retained host callback', async () => {
    const vault = new MemoryVault({ 'Note.md': 'A note.\n' });
    const session = await open({}, vault);
    const noteId = pageIdAt(session, 'Note.md');
    setPreferences({ readingMode: false });
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const app = mount();

    try {
      await app.render(action(noteId));
      const initialTrigger = app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!;
      await act(async () => {
        setPreferences({ readingMode: true });
        initialTrigger.click();
      });
      expect(mounted).toHaveLength(0);
      expect(document.querySelector('[role="dialog"][aria-label="Page style"]')).toBeNull();

      await act(async () => setPreferences({ readingMode: false }));
      await app.render(action(noteId));
      await clickAndSettle(app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!);
      const opened = mounted.at(-1)!;
      let result: PluginNoteStylePanelResult | null = null;
      await act(async () => {
        setPreferences({ readingMode: true });
        result = await opened.host.save(SAVED_STYLE);
      });

      expect(result).toMatchObject({ ok: false });
      expect(vault.text('Note.md')).toBe('A note.\n');
      expect(session.readNoteStyle(noteId)).toMatchObject({ ok: true, value: { style: null } });
      expect(document.querySelector('[role="dialog"][aria-label="Page style"]')).toBeNull();
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('keeps side-pane keyboard focus when a pending main-pane style save confirms', async () => {
    const vault = new DelayedStyleVault({ 'Note.md': 'Body stays exact.\n' });
    const session = await open({}, vault);
    const noteId = pageIdAt(session, 'Note.md');
    setPreferences({ readingMode: false });
    const frames: FrameRequestCallback[] = [];
    installUiStubs(frames);
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const app = mount();
    const sideControl = createElement('button', { type: 'button', 'aria-label': 'Side pane control' }, 'Side');

    try {
      await app.render(
        createElement(
          Fragment,
          null,
          action(noteId, 'main'),
          createElement('section', { className: 'pane', 'data-pane': 'side' }, sideControl),
        ),
      );
      const trigger = app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!;
      await clickAndSettle(trigger);

      let pending: Promise<PluginNoteStylePanelResult> | null = null;
      await act(async () => {
        pending = mounted[0]!.host.save(SAVED_STYLE);
        await vault.styleWriteStarted;
      });

      const mainPane = trigger.closest<HTMLElement>('.pane[data-pane]')!;
      const sidePane = document.querySelector<HTMLElement>('.pane[data-pane="side"]')!;
      mainPane.classList.remove('is-active');
      sidePane.classList.add('is-active');
      const sideButton = document.querySelector<HTMLButtonElement>('[aria-label="Side pane control"]')!;
      sideButton.focus();
      expect(document.activeElement).toBe(sideButton);

      let result: PluginNoteStylePanelResult | null = null;
      await act(async () => {
        vault.releaseStyleWrite();
        result = await pending!;
      });

      expect(result).toMatchObject({ ok: true, style: SAVED_STYLE });
      expect(session.readNoteStyle(noteId)).toMatchObject({ ok: true, value: { style: SAVED_STYLE } });
      expect(document.querySelector('[role="dialog"][aria-label="Page style"]')).toBeNull();
      expect(document.activeElement).toBe(sideButton);
      expect(frames).toHaveLength(0);
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('closes on Escape from the other pane without restoring focus to the style trigger', async () => {
    const session = await open({ 'Note.md': 'A note.\n' });
    const noteId = pageIdAt(session, 'Note.md');
    setPreferences({ readingMode: false });
    const frames: FrameRequestCallback[] = [];
    installUiStubs(frames);
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const app = mount();

    try {
      await app.render(
        createElement(
          Fragment,
          null,
          action(noteId, 'main'),
          createElement(
            'section',
            { className: 'pane', 'data-pane': 'side' },
            createElement('button', { type: 'button', 'aria-label': 'Side pane control' }, 'Side'),
          ),
        ),
      );
      const trigger = app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!;
      await clickAndSettle(trigger);
      const sidePane = document.querySelector<HTMLElement>('.pane[data-pane="side"]')!;
      const sideButton = document.querySelector<HTMLButtonElement>('[aria-label="Side pane control"]')!;
      trigger.closest<HTMLElement>('.pane[data-pane]')!.classList.remove('is-active');
      sidePane.classList.add('is-active');
      sideButton.focus();

      await act(async () => {
        sideButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });

      expect(mounted[0]!.disposed).toBe(true);
      expect(document.querySelector('[role="dialog"][aria-label="Page style"]')).toBeNull();
      expect(document.activeElement).toBe(sideButton);
      expect(frames).toHaveLength(0);
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('rechecks focus at the scheduled return frame after a pending save closes the panel', async () => {
    const vault = new DelayedStyleVault({ 'Note.md': 'A note.\n' });
    const session = await open({}, vault);
    const noteId = pageIdAt(session, 'Note.md');
    setPreferences({ readingMode: false });
    const frames: FrameRequestCallback[] = [];
    installUiStubs(frames);
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const app = mount();

    try {
      await app.render(
        createElement(
          Fragment,
          null,
          action(noteId, 'main'),
          createElement(
            'section',
            { className: 'pane', 'data-pane': 'side' },
            createElement('button', { type: 'button', 'aria-label': 'Side pane control' }, 'Side'),
          ),
        ),
      );
      const trigger = app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!;
      await clickAndSettle(trigger);
      mounted[0]!.save.focus();

      let pending: Promise<PluginNoteStylePanelResult> | null = null;
      await act(async () => {
        pending = mounted[0]!.host.save(SAVED_STYLE);
        await vault.styleWriteStarted;
      });

      let result: PluginNoteStylePanelResult | null = null;
      await act(async () => {
        vault.releaseStyleWrite();
        result = await pending!;
      });
      expect(result).toMatchObject({ ok: true, style: SAVED_STYLE });
      expect(frames).toHaveLength(1);
      expect(document.activeElement).toBe(document.body);

      const mainPane = trigger.closest<HTMLElement>('.pane[data-pane]')!;
      const sidePane = document.querySelector<HTMLElement>('.pane[data-pane="side"]')!;
      mainPane.classList.remove('is-active');
      sidePane.classList.add('is-active');
      expect(document.activeElement).toBe(document.body);
      const returnFocus = frames.shift();
      await act(async () => returnFocus?.(0));

      expect(session.readNoteStyle(noteId)).toMatchObject({ ok: true, value: { style: SAVED_STYLE } });
      expect(document.activeElement).toBe(document.body);
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });

  it('keeps a confirmed pending save on its captured note but does not steal focus after a route change', async () => {
    const vault = new DelayedStyleVault({ 'Note.md': 'Body stays exact.  \n', 'Other.md': 'Other.\n' });
    const session = await open({}, vault);
    const noteId = pageIdAt(session, 'Note.md');
    const otherId = pageIdAt(session, 'Other.md');
    setPreferences({ defaultNoteStyle: PROFILE_STYLE, readingMode: false });
    const frames: FrameRequestCallback[] = [];
    installUiStubs(frames);
    const mounted: MountedPanel[] = [];
    cleanupRegistration = registerRenderer(mounted);
    const marker = document.createElement('button');
    marker.textContent = 'Focus stays here';
    document.body.append(marker);
    const app = mount();

    try {
      await app.render(action(noteId));
      const trigger = app.container.querySelector<HTMLButtonElement>('[aria-label="Page style"]')!;
      await clickAndSettle(trigger);
      expect(mounted).toHaveLength(1);
      let pending: Promise<PluginNoteStylePanelResult> | null = null;
      await act(async () => {
        pending = mounted[0]!.host.save(SAVED_STYLE);
        await vault.styleWriteStarted;
      });

      await app.render(action(otherId));
      expect(mounted[0]!.disposed).toBe(true);
      marker.focus();
      let result: PluginNoteStylePanelResult | null = null;
      await act(async () => {
        vault.releaseStyleWrite();
        result = await pending!;
      });

      expect(result).toMatchObject({ ok: true, style: SAVED_STYLE });
      expect(session.readNoteStyle(noteId)).toMatchObject({ ok: true, value: { style: SAVED_STYLE } });
      expect(session.readNoteStyle(otherId)).toMatchObject({ ok: true, value: { style: null } });
      expect(document.activeElement).toBe(marker);
      expect(vault.text('Note.md')).toBe(
        `---\nmorrowNoteStyle:\n  font: mono\n  fontSize: 15.5\n  lineHeight: 1.82\n  blockSpacing: 13\n  width: wide\n---\nBody stays exact.  \n`,
      );
      expect(frames).toHaveLength(0);
    } finally {
      await app.unmount();
      app.container.remove();
    }
  });
});
