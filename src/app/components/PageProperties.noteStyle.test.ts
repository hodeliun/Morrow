// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { PageId } from '../../core/model';
import { readPageText } from '../../core/vault/pageFile';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { setSession } from '../workspace';
import { PageProperties } from './PageProperties';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOTE_STYLE = `morrowNoteStyle:\n  font: serif\n  fontSize: 19\n  lineHeight: 1.8\n  blockSpacing: 12\n  width: wide\n  futureSetting:\n    mode: retain\n`;
let nextId = 0;
let activeSession: WorkspaceSession | null = null;
let mounted: { container: HTMLElement; root: ReturnType<typeof createRoot> } | null = null;

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(
    new VaultRepository(vault, () => `page-properties-${++nextId}`),
    { delayMs: 0 },
  );
  if (!result.ok) throw new Error(result.error);
  activeSession = result.value;
  setSession(result.value);
  return result.value;
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate as PageId) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id as PageId;
}

function mountPanel(): HTMLElement {
  const container = document.createElement('div');
  document.body.append(container);
  mounted = { container, root: createRoot(container) };
  return container;
}

async function renderPanel(session: WorkspaceSession, pageId: PageId): Promise<void> {
  const page = session.getState().pages[pageId]!;
  const parent = page.parentId ? session.getState().pages[page.parentId] : undefined;
  const database = parent?.database ? { id: parent.id, database: parent.database } : null;
  await act(async () => {
    mounted!.root.render(
      createElement(PageProperties, {
        page,
        database,
        editable: true,
        adding: false,
        onAdded: () => {},
      }),
    );
  });
}

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) throw new Error('HTML input value setter is unavailable.');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.container.remove();
    mounted = null;
  }
  if (activeSession && !activeSession.isClosed) await activeSession.close();
  activeSession = null;
  document.body.replaceChildren();
});

describe('base page properties and saved note styles', () => {
  it('hides the style extra on a page and daily note, edits neighbors, and round-trips both styles', async () => {
    const pageText = `---\n${NOTE_STYLE}status: draft\n---\nPage body\n`;
    const dailyText = `---\n${NOTE_STYLE}status: focused\n---\nDaily body\n`;
    const vault = new MemoryVault({
      'Page.md': pageText,
      'Journal.md': '---\nkind: journal\n---\n# Journal\n',
      'Journal/2026-11-24.md': dailyText,
    });
    let session = await open(vault);
    const pageId = pageIdAt(session, 'Page.md');
    const dailyId = pageIdAt(session, 'Journal/2026-11-24.md');
    expect(session.getState().pages[dailyId]?.dailyDate).toBe('2026-11-24');

    const container = mountPanel();
    for (const [id, nextStatus] of [
      [pageId, 'reviewed'],
      [dailyId, 'ready'],
    ] as const) {
      await renderPanel(session, id);
      const extraNames = [...container.querySelectorAll<HTMLElement>('.row-prop.is-extra .row-prop-name')].map(
        (element) => element.textContent,
      );
      expect(extraNames).toContain('status');
      expect(extraNames).not.toContain('morrowNoteStyle');

      const statusRow = [...container.querySelectorAll<HTMLElement>('.row-prop.is-extra')].find(
        (element) => element.querySelector('.row-prop-name')?.textContent === 'status',
      );
      const statusInput = statusRow?.querySelector('input');
      expect(statusInput).not.toBeNull();
      await act(async () => {
        changeInput(statusInput!, nextStatus);
        pressEnter(statusInput!);
        expect(await session.flush()).toBe(true);
      });
      expect(session.getState().pages[id]?.extra.status).toBe(nextStatus);
    }

    const savedPage = vault.text('Page.md')!;
    const savedDaily = vault.text('Journal/2026-11-24.md')!;
    expect(readPageText(savedPage).extra.morrowNoteStyle).toEqual(readPageText(pageText).extra.morrowNoteStyle);
    expect(readPageText(savedDaily).extra.morrowNoteStyle).toEqual(readPageText(dailyText).extra.morrowNoteStyle);
    expect(readPageText(savedPage).extra.status).toBe('reviewed');
    expect(readPageText(savedDaily).extra.status).toBe('ready');

    await session.close();
    session = await open(vault);
    expect(session.getState().pages[pageIdAt(session, 'Page.md')]?.extra.morrowNoteStyle).toEqual(
      readPageText(pageText).extra.morrowNoteStyle,
    );
    expect(session.getState().pages[pageIdAt(session, 'Journal/2026-11-24.md')]?.extra.morrowNoteStyle).toEqual(
      readPageText(dailyText).extra.morrowNoteStyle,
    );
  });

  it('blocks creating a generic extra named morrowNoteStyle while allowing other extras', async () => {
    const vault = new MemoryVault({ 'Page.md': '---\nstatus: draft\n---\nPage body\n' });
    const session = await open(vault);
    const pageId = pageIdAt(session, 'Page.md');
    const container = mountPanel();

    await renderPanel(session, pageId);
    await act(async () => container.querySelector<HTMLButtonElement>('.row-prop-add')!.click());
    let input = container.querySelector<HTMLInputElement>('.row-prop-new input[name="name"]')!;
    await act(async () => {
      changeInput(input, 'category');
      container.querySelector<HTMLFormElement>('.row-prop-new')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(session.getState().pages[pageId]?.extra.category).toBe('');

    await renderPanel(session, pageId);
    await act(async () => container.querySelector<HTMLButtonElement>('.row-prop-add')!.click());
    input = container.querySelector<HTMLInputElement>('.row-prop-new input[name="name"]')!;
    await act(async () => {
      changeInput(input, 'morrowNoteStyle');
      container.querySelector<HTMLFormElement>('.row-prop-new')!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(Object.hasOwn(session.getState().pages[pageId]!.extra, 'morrowNoteStyle')).toBe(false);
    expect(Object.hasOwn(session.getState().pages[pageId]!.extra, 'category')).toBe(true);
  });

  it('keeps an existing structured database column with the same name visible and editable', async () => {
    const vault = new MemoryVault({
      'Inventory.md': `---\nkind: database\ndatabase:\n  properties:\n    - id: style\n      name: morrowNoteStyle\n      type: text\n    - id: status\n      name: Status\n      type: text\n  views: []\n---\n# Inventory\n`,
      'Inventory/Widget.md': `---\nmorrowNoteStyle: column value\nStatus: active\n---\nWidget body\n`,
    });
    let session = await open(vault);
    const rowId = pageIdAt(session, 'Inventory/Widget.md');
    const container = mountPanel();

    await renderPanel(session, rowId);
    const styleRow = [...container.querySelectorAll<HTMLElement>('.row-prop')].find(
      (element) => element.querySelector('.row-prop-name')?.textContent === 'morrowNoteStyle',
    );
    const styleInput = styleRow?.querySelector<HTMLInputElement>('input');
    expect(styleInput?.value).toBe('column value');
    await act(async () => {
      changeInput(styleInput!, 'updated column value');
      pressEnter(styleInput!);
      expect(await session.flush()).toBe(true);
    });
    expect(vault.text('Inventory/Widget.md')).toContain('morrowNoteStyle: updated column value');

    const databaseId = pageIdAt(session, 'Inventory.md');
    expect(session.getState().pages[databaseId]?.database?.properties.map((prop) => prop.name)).toEqual([
      'morrowNoteStyle',
      'Status',
    ]);
    await session.close();
    session = await open(vault);
    const reopenedDatabaseId = pageIdAt(session, 'Inventory.md');
    const reopenedRowId = pageIdAt(session, 'Inventory/Widget.md');
    expect(session.getState().pages[reopenedDatabaseId]?.database?.properties[0]?.name).toBe('morrowNoteStyle');
    expect(session.getState().pages[reopenedRowId]?.properties.style).toBe('updated column value');
  });
});
