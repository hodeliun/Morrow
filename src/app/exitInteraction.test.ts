// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryVault } from '../storage/memoryVault';
import { WorkspaceSession } from '../storage/session';
import { VaultRepository } from '../storage/vaultRepository';
import { run } from './workspace';
import { runAction } from './actions';
import { undoRedo } from './editor/commits';
import { acquireExitInteractionGate, isExitInteractionBlocked } from './exitInteraction';
import { getSession, setSession, stepProperties } from './workspace';

const releases: Array<() => void> = [];

function acquire(): () => void {
  const release = acquireExitInteractionGate();
  releases.push(release);
  return release;
}

function hostCloseButton(): { controls: HTMLDivElement; close: HTMLButtonElement } {
  const controls = document.createElement('div');
  controls.className = 'window-controls';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'window-control is-close';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  icon.append(path);
  close.append(icon);
  controls.append(close);
  document.body.append(controls);
  return { controls, close };
}

async function openSyntheticSession(): Promise<WorkspaceSession> {
  let nextId = 0;
  const opened = await WorkspaceSession.open(
    new VaultRepository(
      new MemoryVault({ 'Note.md': 'A local synthetic note.\n' }),
      () => `exit-${++nextId}`,
    ),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  setSession(opened.value);
  return opened.value;
}

afterEach(() => {
  for (const release of releases.splice(0)) release();
  document.body.replaceChildren();
});

describe('exit interaction gate', () => {
  it('inerts existing and newly appended body children without changing their DOM or value', async () => {
    const root = document.createElement('div');
    const input = document.createElement('input');
    input.value = 'unsaved draft';
    root.append(input);
    document.body.append(root);
    const host = hostCloseButton();

    acquire();

    const picker = document.createElement('div');
    const pickerInput = document.createElement('input');
    pickerInput.value = 'picker draft';
    let inputEventReached = false;
    pickerInput.addEventListener('beforeinput', () => {
      inputEventReached = true;
    });
    picker.append(pickerInput);
    document.body.append(picker);
    await Promise.resolve();

    expect(isExitInteractionBlocked()).toBe(true);
    expect(root.inert).toBe(true);
    expect(picker.inert).toBe(true);
    expect(host.controls.inert).toBe(false);
    const beforeInput = new InputEvent('beforeinput', { bubbles: true, cancelable: true, data: 'x' });
    pickerInput.dispatchEvent(beforeInput);

    expect(beforeInput.defaultPrevented).toBe(true);
    expect(inputEventReached).toBe(false);
    expect(pickerInput.value).toBe('picker draft');
    expect(root.firstChild).toBe(input);
    expect(picker.firstChild).toBe(pickerInput);
  });

  it('keeps overlapping leases closed, makes releases idempotent, and restores prior inert state', () => {
    const originallyInert = document.createElement('div');
    originallyInert.inert = true;
    const originallyInteractive = document.createElement('div');
    document.body.append(originallyInert, originallyInteractive);

    const releaseFirst = acquire();
    const releaseSecond = acquire();
    releaseFirst();
    releaseFirst();

    expect(isExitInteractionBlocked()).toBe(true);
    expect(originallyInert.inert).toBe(true);
    expect(originallyInteractive.inert).toBe(true);

    releaseSecond();

    expect(isExitInteractionBlocked()).toBe(false);
    expect(originallyInert.inert).toBe(true);
    expect(originallyInteractive.inert).toBe(false);
  });

  it('allows only host Close activation while rejecting other window actions and shortcuts', () => {
    const root = document.createElement('main');
    const ordinaryButton = document.createElement('button');
    root.append(ordinaryButton);
    document.body.append(root);
    const host = hostCloseButton();
    const minimize = document.createElement('button');
    minimize.className = 'window-control';
    host.controls.append(minimize);
    let ordinaryClick = 0;
    let closeClick = 0;
    let minimizeClick = 0;
    let closeEnter = 0;
    ordinaryButton.addEventListener('click', () => ordinaryClick++);
    host.close.addEventListener('click', () => closeClick++);
    minimize.addEventListener('click', () => minimizeClick++);
    host.close.addEventListener('keydown', () => closeEnter++);

    acquire();

    const ordinaryEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    ordinaryButton.dispatchEvent(ordinaryEvent);
    const shortcut = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ordinaryButton.dispatchEvent(shortcut);
    const windowShortcutKeys: string[] = [];
    const onWindowShortcut = (event: KeyboardEvent) => {
      windowShortcutKeys.push(event.key);
    };
    window.addEventListener('keydown', onWindowShortcut, true);
    const ctrlTab = new KeyboardEvent('keydown', {
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    ordinaryButton.dispatchEvent(ctrlTab);
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    ordinaryButton.dispatchEvent(tab);
    window.removeEventListener('keydown', onWindowShortcut, true);
    const minimizeEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    minimize.dispatchEvent(minimizeEvent);
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    host.close.querySelector('path')!.dispatchEvent(enter);
    const closeEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
    host.close.querySelector('path')!.dispatchEvent(closeEvent);

    expect(ordinaryEvent.defaultPrevented).toBe(true);
    expect(shortcut.defaultPrevented).toBe(true);
    expect(ctrlTab.defaultPrevented).toBe(true);
    expect(windowShortcutKeys).toEqual(['Tab']);
    expect(tab.defaultPrevented).toBe(false);
    expect(minimizeEvent.defaultPrevented).toBe(true);
    expect(enter.defaultPrevented).toBe(false);
    expect(closeEvent.defaultPrevented).toBe(false);
    expect(ordinaryClick).toBe(0);
    expect(closeEnter).toBe(1);
    expect(closeClick).toBe(1);
    expect(minimizeClick).toBe(0);
  });

  it('restores a still-relevant input focus and selection, but does not steal focus from Close', () => {
    const root = document.createElement('div');
    const input = document.createElement('input');
    input.value = 'draft text';
    root.append(input);
    document.body.append(root);
    const { close } = hostCloseButton();
    input.focus();
    input.setSelectionRange(2, 6);

    const release = acquire();
    input.blur();
    release();

    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('draft text');
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(6);

    acquire();
    close.focus();
    releases.at(-1)!();

    expect(document.activeElement).toBe(close);
  });

  it('does not consume an action or property undo while gated; both work after release', async () => {
    const session = await openSyntheticSession();
    const noteId = Object.keys(session.getState().pages)[0]!;
    run({ type: 'page.setFields', id: noteId, extra: { state: 'before' }, now: 1 });
    run({ type: 'page.setFields', id: noteId, extra: { state: 'after' }, now: 2 });
    const pageCount = Object.keys(session.getState().pages).length;
    const release = acquire();

    runAction('page.new');
    expect(Object.keys(getSession().getState().pages)).toHaveLength(pageCount);
    expect(stepProperties('undo')).toBe(false);
    expect(session.getState().pages[noteId]!.extra).toEqual({ state: 'after' });

    release();

    runAction('page.new');
    expect(Object.keys(getSession().getState().pages)).toHaveLength(pageCount + 1);
    expect(stepProperties('undo')).toBe(true);
    expect(session.getState().pages[noteId]!.extra).toEqual({ state: 'before' });
    await session.close();
  });

  it('does not dispatch ordinary undo from a focused text input until the gate is released', () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const originalExecCommand = document.execCommand;
    const calls: string[] = [];
    document.execCommand = ((command: string) => {
      calls.push(command);
      return true;
    }) as typeof document.execCommand;

    const release = acquire();
    undoRedo('undo');
    expect(calls).toEqual([]);

    release();
    undoRedo('undo');
    expect(calls).toEqual(['undo']);

    document.execCommand = originalExecCommand;
  });
});
