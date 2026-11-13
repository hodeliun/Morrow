// @vitest-environment happy-dom
import type { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { runAction } from './actions';
import { setFocusedEditor, undoRedo } from './editor/commits';
import { acquireExitInteractionGate, isExitInteractionBlocked } from './exitInteraction';
import { clearPropertyHistory, getSession, run, setSession, stepProperties } from './workspace';

const releases: Array<() => void> = [];

function acquire(): () => void {
  const release = acquireExitInteractionGate();
  releases.push(release);
  return release;
}

function addHostControls(): { controls: HTMLDivElement; close: HTMLButtonElement } {
  const controls = document.createElement('div');
  controls.className = 'window-controls';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'window-control is-close';
  const icon = document.createElement('span');
  close.append(icon);
  controls.append(close);
  document.body.append(controls);
  return { controls, close };
}

async function openSession(): Promise<WorkspaceSession> {
  let nextId = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(
      new MemoryVault({ 'Synthetic note.md': 'An isolated note for this test.\n' }),
      () => `independent-exit-${++nextId}`,
    ),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  setSession(opened.value);
  return opened.value;
}

afterEach(() => {
  setFocusedEditor(null);
  clearPropertyHistory();
  for (const release of releases.splice(0)) release();
  document.body.replaceChildren();
});

describe('independent exit interaction checks', () => {
  it('blocks an appended picker before the observer runs, then inerts it without replacing its nodes', async () => {
    const appRoot = document.createElement('main');
    const existingInput = document.createElement('input');
    existingInput.value = 'unsaved text';
    appRoot.append(existingInput);
    document.body.append(appRoot);
    const host = addHostControls();
    existingInput.focus();
    existingInput.setSelectionRange(3, 8);

    const release = acquire();
    const picker = document.createElement('div');
    const pickerInput = document.createElement('input');
    pickerInput.value = 'picker draft';
    const pickerButton = document.createElement('button');
    picker.append(pickerInput, pickerButton);
    let pickerActivated = 0;
    pickerButton.addEventListener('click', () => pickerActivated++);
    document.body.append(picker);

    const earlyClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    pickerButton.dispatchEvent(earlyClick);
    expect(earlyClick.defaultPrevented).toBe(true);
    expect(pickerActivated).toBe(0);

    await Promise.resolve();
    expect(appRoot.inert).toBe(true);
    expect(picker.inert).toBe(true);
    expect(host.controls.inert).toBe(false);
    expect(appRoot.firstChild).toBe(existingInput);
    expect(picker.firstChild).toBe(pickerInput);
    expect(pickerInput.value).toBe('picker draft');

    existingInput.blur();
    release();
    expect(isExitInteractionBlocked()).toBe(false);
    expect(document.activeElement).toBe(existingInput);
    expect(existingInput.selectionStart).toBe(3);
    expect(existingInput.selectionEnd).toBe(8);
    expect(picker.inert).toBe(false);
  });

  it('keeps the body inert until the last lease releases and restores each prior inert value', () => {
    const alreadyInert = document.createElement('div');
    alreadyInert.inert = true;
    const initiallyActive = document.createElement('div');
    document.body.append(alreadyInert, initiallyActive);

    const releaseOld = acquire();
    const releaseCurrent = acquire();
    releaseOld();
    releaseOld();

    expect(isExitInteractionBlocked()).toBe(true);
    expect(alreadyInert.inert).toBe(true);
    expect(initiallyActive.inert).toBe(true);

    releaseCurrent();
    expect(isExitInteractionBlocked()).toBe(false);
    expect(alreadyInert.inert).toBe(true);
    expect(initiallyActive.inert).toBe(false);

    const nextCycle = acquire();
    releaseOld();
    expect(isExitInteractionBlocked()).toBe(true);
    expect(initiallyActive.inert).toBe(true);
    nextCycle();
    expect(isExitInteractionBlocked()).toBe(false);
    expect(initiallyActive.inert).toBe(false);
  });

  it('allows Close in the host controls while blocking lookalike controls inside app content', () => {
    const appRoot = document.createElement('main');
    const nestedControls = document.createElement('div');
    nestedControls.className = 'window-controls';
    const fakeClose = document.createElement('button');
    fakeClose.className = 'window-control is-close';
    nestedControls.append(fakeClose);
    appRoot.append(nestedControls);
    document.body.append(appRoot);
    const host = addHostControls();
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    icon.append(path);
    host.close.replaceChildren(icon);
    const minimize = document.createElement('button');
    minimize.className = 'window-control is-minimize';
    host.controls.append(minimize);
    let hostCloseCalls = 0;
    let fakeCloseCalls = 0;
    let minimizeCalls = 0;
    host.close.addEventListener('click', () => hostCloseCalls++);
    fakeClose.addEventListener('click', () => fakeCloseCalls++);
    minimize.addEventListener('click', () => minimizeCalls++);

    acquire();
    const closeClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    path.dispatchEvent(closeClick);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    host.close.dispatchEvent(enter);
    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    host.close.dispatchEvent(space);
    const controlEnter = new KeyboardEvent('keydown', {
      key: 'Enter',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    host.close.dispatchEvent(controlEnter);
    const controlTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    host.close.dispatchEvent(controlTab);
    const nestedClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    fakeClose.dispatchEvent(nestedClick);
    const minimizeClick = new MouseEvent('click', { bubbles: true, cancelable: true });
    minimize.dispatchEvent(minimizeClick);

    expect(closeClick.defaultPrevented).toBe(false);
    expect(enter.defaultPrevented).toBe(false);
    expect(space.defaultPrevented).toBe(false);
    expect(controlEnter.defaultPrevented).toBe(true);
    expect(controlTab.defaultPrevented).toBe(true);
    expect(nestedClick.defaultPrevented).toBe(true);
    expect(minimizeClick.defaultPrevented).toBe(true);
    expect(hostCloseCalls).toBe(1);
    expect(fakeCloseCalls).toBe(0);
    expect(minimizeCalls).toBe(0);
  });

  it('does not reattach a removed child or steal focus from a host control on release', () => {
    const removedRoot = document.createElement('main');
    const input = document.createElement('input');
    removedRoot.append(input);
    document.body.append(removedRoot);
    const { close } = addHostControls();
    input.focus();
    removedRoot.inert = true;

    const release = acquire();
    removedRoot.remove();
    close.focus();
    release();

    expect(removedRoot.isConnected).toBe(false);
    expect(removedRoot.inert).toBe(true);
    expect(document.activeElement).toBe(close);
  });

  it('does not run actions or consume property history while gated', async () => {
    clearPropertyHistory();
    let session: WorkspaceSession | undefined;
    try {
      session = await openSession();
      const noteId = Object.keys(session.getState().pages)[0]!;
      const first = run({ type: 'page.setFields', id: noteId, extra: { phase: 'before' }, now: Date.now() });
      if (!first.ok) throw new Error(first.error);
      const second = run({
        type: 'page.setFields',
        id: noteId,
        extra: { phase: 'after' },
        now: Date.now() + 1,
      });
      if (!second.ok) throw new Error(second.error);
      const count = Object.keys(session.getState().pages).length;

      const release = acquire();
      runAction('page.new');
      undoRedo('undo');
      expect(stepProperties('undo')).toBe(false);
      expect(Object.keys(getSession().getState().pages)).toHaveLength(count);
      expect(session.getState().pages[noteId]!.extra).toEqual({ phase: 'after' });

      release();
      expect(stepProperties('undo')).toBe(true);
      expect(session.getState().pages[noteId]!.extra).toEqual({ phase: 'before' });
      runAction('page.new');
      expect(Object.keys(getSession().getState().pages)).toHaveLength(count + 1);
    } finally {
      if (session) await session.close();
    }
  });

  it('does not dispatch editor undo through the focused editor while gated', () => {
    const editorRoot = document.createElement('div');
    editorRoot.tabIndex = 0;
    document.body.append(editorRoot);
    editorRoot.focus();
    const undo = vi.fn();
    setFocusedEditor({
      isDestroyed: false,
      view: { dom: editorRoot },
      commands: { undo, redo: vi.fn() },
    } as unknown as Editor);

    const release = acquire();
    undoRedo('undo');
    expect(undo).not.toHaveBeenCalled();

    release();
    undoRedo('undo');
    expect(undo).toHaveBeenCalledOnce();
  });
});
