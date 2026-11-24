// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocNode, PageId } from '../../core/model';
import { docToMarkdown } from '../../core/markdown/serialize';
import { addPluginInlineColorControl } from '../plugins/registry';
import type { PluginInlineColorControlHost } from '../plugins/registry';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { mountInlineColorControl } from '../../../plugins/polaris-documento/src/inlineColorControl';
import { getSession, setSession } from '../workspace';
import { getWorkspaceSessionGeneration } from '../workspace';
import { activateTab, closeTab, getTabs, openTab, paneIdForTabId, startTabs } from '../tabs';
import { t } from '../i18n';
import { BlockMenu } from './EditorMenus';
import { createExtensions } from './extensions';
import { selectBlockRange, selectedBlocks } from './BlockSelect';
import { representableBlockBackgroundOwners } from './inlineColorControlHost';
import { captureBlockMenuOrigin, isBlockMenuRequestCurrent } from './blockMenuOrigin';
import type { BlockMenuOrigin } from './blockMenuOrigin';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const testSession = {
  isClosed: false,
  isMutationFenced: false,
  subscribeMutationFence: () => () => {},
  onClose: () => () => {},
} as unknown as WorkspaceSession;

let editor: Editor | null = null;
let editorHost: HTMLElement | null = null;
let menuHost: HTMLElement | null = null;
let menuRoot: Root | null = null;
let unregisterControl: (() => void) | null = null;
let stopTabs: (() => void) | null = null;
let activeWorkspace: WorkspaceSession | null = null;
const testTabIds = new Set<string>();

function make(content: DocNode): Editor {
  editorHost = document.createElement('div');
  document.body.append(editorHost);
  editor = new Editor({
    element: editorHost,
    extensions: createExtensions({
      onBlockMenu: () => {},
      resolvePage: () => null,
      openTag: () => {},
      createChild: () => null,
      openDate: () => {},
      pages: () => [],
      findPages: () => [],
      createPage: () => null,
      renderEmbed: () => {},
    } as never),
    content: content as never,
  });
  return editor;
}

async function mountMenu(target: Editor, position = 0, origin?: BlockMenuOrigin | null): Promise<void> {
  menuHost = document.createElement('div');
  document.body.append(menuHost);
  menuRoot = createRoot(menuHost);
  await renderMenu(target, position, origin);
}

function menuElement(target: Editor, position: number, origin?: BlockMenuOrigin | null) {
  return createElement(BlockMenu, {
    editor: target,
    request: { pos: position, rect: new DOMRect(0, 0, 0, 0), ...(origin ? { origin } : {}) },
    pageTitle: 'Block background test',
    onClose: () => menuRoot?.render(null),
  });
}

async function renderMenu(target: Editor, position = 0, origin?: BlockMenuOrigin | null): Promise<void> {
  await act(async () => menuRoot?.render(menuElement(target, position, origin)));
}

function openTestTab(hash: string): { id: string } {
  const before = new Set(getTabs().layout.tabs.map((tab) => tab.id));
  openTab(hash);
  const tab = getTabs().layout.tabs.find((candidate) => !before.has(candidate.id));
  if (!tab) throw new Error(`Could not create test tab for ${hash}.`);
  testTabIds.add(tab.id);
  return tab;
}

async function openTestWorkspace(pageId: PageId): Promise<WorkspaceSession> {
  const doc: DocNode = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain' }] }],
  };
  const path = 'Block background.md';
  const opened = await WorkspaceSession.open(
    new VaultRepository(
      new MemoryVault({
        '.morrow/workspace.json': JSON.stringify({
          version: 1,
          pages: { [path]: { id: pageId, created: 1, order: 0 } },
        }),
        '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
        [path]: docToMarkdown(doc),
      }),
      () => 'unused-block-background-id',
    ),
    { delayMs: 60_000 },
  );
  if (!opened.ok) throw new Error(opened.error);
  activeWorkspace = opened.value;
  setSession(activeWorkspace);
  return activeWorkspace;
}

function menu(label: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('[role="menu"]')].find(
      (element) => element.getAttribute('aria-label') === label,
    ) ?? null
  );
}

function buttonWithin(container: ParentNode, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === label,
    ) ?? null
  );
}

async function openBackgroundSubmenu(): Promise<HTMLElement> {
  const blockMenu = menu(t('editor.blockOptions'));
  const colour = blockMenu && buttonWithin(blockMenu, t('editor.colour'));
  if (!colour) throw new Error('The block colour menu entry was not rendered.');
  await act(async () => colour.click());
  const submenu = menu(t('editor.colour'));
  if (!submenu) throw new Error('The block colour submenu was not rendered.');
  return submenu;
}

function inputEvent(input: HTMLInputElement): void {
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(async () => {
  if (menuRoot) await act(async () => menuRoot?.unmount());
  menuRoot = null;
  menuHost?.remove();
  menuHost = null;
  unregisterControl?.();
  unregisterControl = null;
  stopTabs?.();
  stopTabs = null;
  for (const id of testTabIds) {
    if (getTabs().layout.tabs.length > 1 && getTabs().layout.tabs.some((tab) => tab.id === id)) closeTab(id);
  }
  testTabIds.clear();
  if (activeWorkspace && !activeWorkspace.isClosed) await activeWorkspace.close();
  activeWorkspace = null;
  editor?.destroy();
  editor = null;
  editorHost?.remove();
  editorHost = null;
});

describe('Documento block background control', () => {
  it('is reachable in the real block menu, rejects invalid HEX, applies, reopens, undoes and clears without changing marks', async () => {
    setSession(testSession);
    unregisterControl = addPluginInlineColorControl('polaris-documento', mountInlineColorControl);
    const content: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Marked text',
              marks: [
                { type: 'highlight', attrs: { color: 'yellow' } },
                { type: 'textColor', attrs: { color: 'blue' } },
              ],
            },
          ],
        },
      ],
    };
    const target = make(content);
    const originalMarks = target.getJSON().content?.[0]?.content?.[0]?.marks;
    target.commands.setTextSelection({ from: 1, to: 7 });
    await mountMenu(target);

    let submenu = await openBackgroundSubmenu();
    const firstPaletteItem = submenu.querySelector<HTMLButtonElement>('button');
    const picker = submenu.querySelector<HTMLInputElement>('input[type="color"]');
    expect(picker, submenu.innerHTML).not.toBeNull();
    firstPaletteItem?.focus();
    for (let step = 0; document.activeElement !== picker && step < 16; step++) {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      );
    }
    expect(document.activeElement).toBe(picker);
    picker?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const hex = submenu.querySelector<HTMLInputElement>('.color-hex-input');
    expect(document.activeElement).toBe(hex);
    expect(hex?.getAttribute('aria-label')).toBe('HEX colour for block background');

    hex!.value = '#12zzzz';
    await act(async () => inputEvent(hex!));
    expect(hex?.getAttribute('aria-invalid')).toBe('true');
    expect(target.state.doc.firstChild?.attrs.backgroundColor).toBeNull();

    hex!.value = '#123ABC';
    await act(async () => inputEvent(hex!));
    expect(target.state.doc.firstChild?.attrs.backgroundColor).toBe('#123abc');
    expect(target.getJSON().content?.[0]?.content?.[0]?.marks).toEqual(originalMarks);
    expect(document.activeElement).toBe(target.view.dom);
    expect(menu(t('editor.blockOptions'))).toBeNull();

    expect(target.commands.undo()).toBe(true);
    expect(target.state.doc.firstChild?.attrs.backgroundColor).toBeNull();
    await renderMenu(target);
    submenu = await openBackgroundSubmenu();
    expect(submenu.querySelector<HTMLInputElement>('.color-hex-input')?.value).toBe('#fbf3db');

    const reapply = submenu.querySelector<HTMLInputElement>('.color-hex-input')!;
    reapply.value = '#abcdef';
    await act(async () => inputEvent(reapply));
    await renderMenu(target);
    submenu = await openBackgroundSubmenu();
    expect(submenu.querySelector<HTMLInputElement>('.color-hex-input')?.value).toBe('#abcdef');
    const clear = buttonWithin(submenu, t('editor.defaultBackground'));
    expect(clear).not.toBeNull();
    await act(async () => clear?.click());
    expect(target.state.doc.firstChild?.attrs.backgroundColor).toBeNull();
    expect(target.getJSON().content?.[0]?.content?.[0]?.marks).toEqual(originalMarks);
  });

  it('resolves a direct collapsible title and column paragraph only when the codec supports their owner chains', () => {
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'details',
          content: [
            {
              type: 'detailsSummary',
              attrs: { backgroundColor: '#112233' },
              content: [{ type: 'text', text: 'Folded title' }],
            },
            {
              type: 'detailsContent',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
            },
          ],
        },
        {
          type: 'columns',
          content: [
            {
              type: 'column',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Column block' }] }],
            },
          ],
        },
      ],
    });
    let detailsPosition = -1;
    let summaryPosition = -1;
    let columnParagraphPosition = -1;
    target.state.doc.descendants((node, position) => {
      if (node.type.name === 'details') detailsPosition = position;
      if (node.type.name === 'detailsSummary') summaryPosition = position;
      if (node.type.name === 'paragraph' && node.textContent === 'Column block')
        columnParagraphPosition = position;
    });

    expect(representableBlockBackgroundOwners(target, [detailsPosition])).toEqual([
      { position: summaryPosition, color: '#112233' },
    ]);
    expect(representableBlockBackgroundOwners(target, [columnParagraphPosition])).toEqual([
      { position: columnParagraphPosition, color: null },
    ]);
  });

  it('applies and clears HEX on the directly requested collapsible title through the real menu', async () => {
    setSession(testSession);
    unregisterControl = addPluginInlineColorControl('polaris-documento', mountInlineColorControl);
    const target = make({
      type: 'doc',
      content: [
        {
          type: 'details',
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'Folded title' }] },
            {
              type: 'detailsContent',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
            },
          ],
        },
      ],
    });
    let summaryPosition = -1;
    target.state.doc.descendants((node, position) => {
      if (node.type.name === 'detailsSummary') summaryPosition = position;
    });
    await mountMenu(target, 0);
    let submenu = await openBackgroundSubmenu();
    const hex = submenu.querySelector<HTMLInputElement>('.color-hex-input');
    expect(hex).not.toBeNull();
    hex!.value = '#345678';
    await act(async () => inputEvent(hex!));
    expect(target.state.doc.nodeAt(summaryPosition)?.attrs.backgroundColor).toBe('#345678');

    await renderMenu(target, 0);
    submenu = await openBackgroundSubmenu();
    expect(submenu.querySelector<HTMLInputElement>('.color-hex-input')?.value).toBe('#345678');
    const clear = buttonWithin(submenu, t('editor.defaultBackground'));
    await act(async () => clear?.click());
    expect(target.state.doc.nodeAt(summaryPosition)?.attrs.backgroundColor).toBeNull();
  });

  it('removes the control and invalidates its callback when Documento is disabled', async () => {
    setSession(testSession);
    unregisterControl = addPluginInlineColorControl('polaris-documento', mountInlineColorControl);
    const target = make({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain' }] }],
    });
    await mountMenu(target);
    const submenu = await openBackgroundSubmenu();
    const input = submenu.querySelector<HTMLInputElement>('.color-hex-input');
    expect(input, submenu.innerHTML).not.toBeNull();

    await act(async () => unregisterControl?.());
    unregisterControl = null;
    expect(submenu.querySelector('.documento-block-background-control-slot')).toBeNull();
    input!.value = '#123456';
    await act(async () => inputEvent(input!));
    expect(target.state.doc.firstChild?.attrs.backgroundColor).toBeNull();
  });

  it('revokes a mounted menu when its tab becomes hidden while the old editor remains alive', async () => {
    const session = await openTestWorkspace('block-menu-origin-a' as PageId);
    stopTabs = startTabs();
    const tabA = openTestTab('#/page/block-menu-origin-a');
    const tabB = openTestTab('#/page/block-menu-origin-b');
    activateTab(tabA.id);
    const paneId = paneIdForTabId(tabA.id);
    const target = make({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Plain' }] }],
    });
    const origin = captureBlockMenuOrigin(target, 'block-menu-origin-a' as PageId, paneId, tabA.id);
    expect(origin).not.toBeNull();
    expect(isBlockMenuRequestCurrent(origin!)).toBe(true);
    const originalSelection = target.state.selection;
    const originalGeneration = getWorkspaceSessionGeneration();

    let mountedHost: PluginInlineColorControlHost | null = null;
    unregisterControl = addPluginInlineColorControl('polaris-documento', (container, host) => {
      mountedHost = host;
      return mountInlineColorControl(container, host);
    });
    await mountMenu(target, 0, origin);
    const submenu = await openBackgroundSubmenu();
    const input = submenu.querySelector<HTMLInputElement>('.color-hex-input');
    expect(input).not.toBeNull();
    expect(mountedHost).not.toBeNull();
    input!.focus();
    const originalDoc = target.state.doc;

    await act(async () => {
      activateTab(tabB.id);
      expect(isBlockMenuRequestCurrent(origin!)).toBe(false);
      expect(mountedHost!.apply('#123456')).toBe(false);
      mountedHost!.finish();
    });

    expect(getTabs().layout.tabs.some((tab) => tab.id === tabA.id)).toBe(true);
    expect(target.isDestroyed).toBe(false);
    expect(getSession()).toBe(session);
    expect(getWorkspaceSessionGeneration()).toBe(originalGeneration);
    expect(target.state.selection).toBe(originalSelection);
    expect(menu(t('editor.blockOptions'))).toBeNull();
    expect(target.state.doc).toBe(originalDoc);
    expect(target.state.doc.firstChild?.attrs.backgroundColor).toBeNull();
    expect(document.activeElement).not.toBe(target.view.dom);
  });

  it('closes the original request when selection changes before opening the HEX submenu', async () => {
    await openTestWorkspace('block-menu-selection-a' as PageId);
    stopTabs = startTabs();
    const tabA = openTestTab('#/page/block-menu-selection-a');
    const paneId = paneIdForTabId(tabA.id);
    const target = make({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original target' }] }],
    });
    const origin = captureBlockMenuOrigin(target, 'block-menu-selection-a' as PageId, paneId, tabA.id);
    expect(origin).not.toBeNull();
    expect(isBlockMenuRequestCurrent(origin!)).toBe(true);

    unregisterControl = addPluginInlineColorControl('polaris-documento', mountInlineColorControl);
    await mountMenu(target, 0, origin);
    expect(menu(t('editor.blockOptions'))).not.toBeNull();
    await act(async () => {
      target.commands.setTextSelection({ from: 4, to: 4 });
    });

    expect(isBlockMenuRequestCurrent(origin!)).toBe(false);
    expect(menu(t('editor.blockOptions'))).toBeNull();
    expect(menu(t('editor.colour'))).toBeNull();
    expect(document.querySelector('.documento-block-background-control-slot')).toBeNull();
  });

  it('revokes the old HEX callback when a block range is cleared by metadata alone', async () => {
    await openTestWorkspace('block-menu-range-a' as PageId);
    stopTabs = startTabs();
    const tab = openTestTab('#/page/block-menu-range-a');
    const paneId = paneIdForTabId(tab.id);
    const target = make({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Picked block' }] }],
    });
    selectBlockRange(target.view, { from: 0, to: target.state.doc.content.size });
    const originalDoc = target.state.doc;
    const originalSelection = target.state.selection;
    const originalRange = selectedBlocks(target.state);
    expect(originalRange).toEqual({ from: 0, to: target.state.doc.content.size });

    const origin = captureBlockMenuOrigin(target, 'block-menu-range-a' as PageId, paneId, tab.id);
    expect(origin?.blockSelection).toEqual(originalRange);
    expect(isBlockMenuRequestCurrent(origin!)).toBe(true);
    let mountedHost: PluginInlineColorControlHost | null = null;
    unregisterControl = addPluginInlineColorControl('polaris-documento', (container, host) => {
      mountedHost = host;
      return mountInlineColorControl(container, host);
    });
    await mountMenu(target, 0, origin);
    const submenu = await openBackgroundSubmenu();
    const input = submenu.querySelector<HTMLInputElement>('.color-hex-input');
    expect(input).not.toBeNull();
    expect(mountedHost).not.toBeNull();
    const oldApply = mountedHost!.apply;

    await act(async () => {
      selectBlockRange(target.view, null);
    });

    expect(target.state.doc).toBe(originalDoc);
    expect(target.state.selection).toBe(originalSelection);
    expect(selectedBlocks(target.state)).toBeNull();
    expect(isBlockMenuRequestCurrent(origin!)).toBe(false);
    expect(menu(t('editor.blockOptions'))).toBeNull();
    expect(menu(t('editor.colour'))).toBeNull();
    expect(oldApply('#123456')).toBe(false);
    expect(target.state.doc.firstChild?.attrs.backgroundColor).toBeNull();
    expect(document.activeElement).not.toBe(target.view.dom);
  });
});
