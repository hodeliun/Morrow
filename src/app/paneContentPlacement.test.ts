import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageMeta, WorkspaceState } from '../core/model';
import type { TranslationKey, TranslationParams } from './i18n';
import {
  FILE_DRAG_TYPE,
  PAGE_DRAG_TYPES,
  TAB_DRAG_TYPE,
  shouldIgnorePaneContentDragStart,
} from './paneLayout';
import { describeTabForChooser } from './components/PaneEmptyChooser';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setupTestEnvironment(raw?: string) {
  vi.resetModules();
  const values = new Map<string, string>();
  if (raw) values.set('morrow.tabs', raw);
  const location = { hash: '#/' };
  const listeners = new Map<string, () => void>();

  vi.stubGlobal('window', {
    location,
    history: {
      replaceState: (_state: unknown, _title: string, target: string) => {
        location.hash = target;
      },
    },
    addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
    removeItem: (name: string) => values.delete(name),
  });

  return { location, values };
}

function makePageMeta(id: string, title: string, partial: Partial<PageMeta> = {}): PageMeta {
  return {
    id,
    parentId: null,
    title,
    icon: null,
    kind: 'page',
    order: 0,
    createdAt: 0,
    updatedAt: 0,
    trashedAt: null,
    archivedAt: null,
    favorite: false,
    dailyDate: null,
    lastOpenedAt: null,
    tags: [],
    controls: [],
    properties: {},
    extra: {},
    database: null,
    cover: null,
    coverPosition: 50,
    noteStyle: null,
    calculatedResultBackground: null,
    encrypted: false,
    ...partial,
  };
}

describe('T38 — pane content placement and empty chooser', () => {
  describe('describeTabForChooser', () => {
    const mockState: WorkspaceState = {
      pages: {
        'page-1': makePageMeta('page-1', 'Project Roadmap'),
        'daily-1': makePageMeta('daily-1', 'Today', { dailyDate: '2026-11-05', kind: 'journal' }),
      },
      docs: {},
    };

    const mockTranslate = (key: TranslationKey, params?: TranslationParams): string => {
      if (key === 'paneLayout.paneNumber') return `Painel ${params?.number}`;
      if (key === 'paneLayout.tabAvailable') return 'Disponível';
      if (key === 'paneLayout.tabTypeNote') return 'Nota';
      if (key === 'paneLayout.tabTypeHome') return 'Início';
      if (key === 'paneLayout.tabTypeImage') return 'Imagem';
      if (key === 'paneLayout.tabTypePdf') return 'PDF';
      if (key === 'paneLayout.tabTypeMedia') return 'Mídia';
      if (key === 'paneLayout.tabTypeUrl') return 'Site';
      if (key === 'paneLayout.tabTypeFile') return 'Arquivo';
      if (key === 'paneLayout.tabTypeTasks') return 'Tarefas';
      return key;
    };

    it('identifies note tab with title, note type, and assigned pane origin', () => {
      const tab = {
        id: 't-note',
        groupId: 'g-note',
        target: '#/page/page-1',
        back: [],
        forward: [],
      };
      const visibleLeaves = [
        { id: 'pane-1', tabId: 't-note' },
        { id: 'pane-2', tabId: null },
      ];

      const info = describeTabForChooser(tab, mockState, visibleLeaves, mockTranslate);
      expect(info.title).toBe('Project Roadmap');
      expect(info.typeLabelKey).toBe('paneLayout.tabTypeNote');
      expect(info.originLabel).toBe('Painel 1');
      expect(info.isVisible).toBe(true);
      expect(info.assignedPaneNumber).toBe(1);
      expect(info.isNote).toBe(true);
    });

    it('identifies unassigned note tab as Available', () => {
      const tab = {
        id: 't-unassigned',
        groupId: 'g-unassigned',
        target: '#/page/page-1',
        back: [],
        forward: [],
      };
      const visibleLeaves = [
        { id: 'pane-1', tabId: 'other-tab' },
        { id: 'pane-2', tabId: null },
      ];

      const info = describeTabForChooser(tab, mockState, visibleLeaves, mockTranslate);
      expect(info.originLabel).toBe('Disponível');
      expect(info.isVisible).toBe(false);
      expect(info.assignedPaneNumber).toBeNull();
    });

    it('identifies image, pdf, and media file tabs with path subtitle', () => {
      const visibleLeaves = [{ id: 'pane-1', tabId: null }];

      const validVaultId = '11111111-1111-4111-8111-111111111111';
      const imgTab = { id: 't-img', groupId: 'g1', target: `#/file/${validVaultId}/Photos/Diagram.png`, back: [], forward: [] };
      const imgInfo = describeTabForChooser(imgTab, mockState, visibleLeaves, mockTranslate);
      expect(imgInfo.title).toBe('Diagram.png');
      expect(imgInfo.subtitle).toBe('Photos/Diagram.png');
      expect(imgInfo.typeLabelKey).toBe('paneLayout.tabTypeImage');
      expect(imgInfo.isNote).toBe(false);

      const pdfTab = { id: 't-pdf', groupId: 'g2', target: `#/file/${validVaultId}/Docs/Report.pdf`, back: [], forward: [] };
      const pdfInfo = describeTabForChooser(pdfTab, mockState, visibleLeaves, mockTranslate);
      expect(pdfInfo.title).toBe('Report.pdf');
      expect(pdfInfo.typeLabelKey).toBe('paneLayout.tabTypePdf');

      const mediaTab = { id: 't-media', groupId: 'g3', target: `#/file/${validVaultId}/Audio/Voice.mp3`, back: [], forward: [] };
      const mediaInfo = describeTabForChooser(mediaTab, mockState, visibleLeaves, mockTranslate);
      expect(mediaInfo.title).toBe('Voice.mp3');
      expect(mediaInfo.typeLabelKey).toBe('paneLayout.tabTypeMedia');
    });

    it('identifies URL and home tabs with correct hosts and view titles', () => {
      const visibleLeaves = [{ id: 'pane-1', tabId: null }];

      const urlTab = { id: 't-url', groupId: 'g1', target: '#/url/https%3A%2F%2Fgithub.com%2Ftrending', back: [], forward: [] };
      const urlInfo = describeTabForChooser(urlTab, mockState, visibleLeaves, mockTranslate);
      expect(urlInfo.title).toBe('github.com');
      expect(urlInfo.subtitle).toBe('https://github.com/trending');
      expect(urlInfo.typeLabelKey).toBe('paneLayout.tabTypeUrl');

      const homeTab = { id: 't-home', groupId: 'g2', target: '#/', back: [], forward: [] };
      const homeInfo = describeTabForChooser(homeTab, mockState, visibleLeaves, mockTranslate);
      expect(homeInfo.typeLabelKey).toBe('paneLayout.tabTypeHome');
    });
  });

  describe('tabs placement actions in runtime store', () => {
    beforeEach(() => {
      setupTestEnvironment();
    });

    it('opens the same note in two panes simultaneously with distinct tabIds without emptying the first pane', async () => {
      const tabs = await import('./tabs');
      tabs.setPanePreset('two-columns');
      const leaves = tabs.getVisiblePanes();
      expect(leaves).toHaveLength(2);
      const pane1 = leaves[0]!.id;
      const pane2 = leaves[1]!.id;

      // Pane 1 opens page-alpha
      tabs.showInPane('#/page/page-alpha', pane1);
      const tabPane1 = tabs.getTabForPane(pane1);
      expect(tabPane1?.target).toBe('#/page/page-alpha');

      // Now open page-alpha in Pane 2 via openRouteInPane
      const res = tabs.openRouteInPane('#/page/page-alpha', pane2);
      expect(res.success).toBe(true);

      const tabPane1After = tabs.getTabForPane(pane1);
      const tabPane2 = tabs.getTabForPane(pane2);

      // CRITICAL ASSERTION: Pane 1 is NOT emptied, still shows page-alpha!
      expect(tabPane1After?.target).toBe('#/page/page-alpha');
      expect(tabPane2?.target).toBe('#/page/page-alpha');

      // Ambas as instâncias têm IDs distintos
      expect(tabPane1After?.id).not.toBe(tabPane2?.id);

      // Foco independente: alternar foco para pane1
      tabs.setActivePane(pane1);
      expect(tabs.targetPane()).toBe(pane1);
      tabs.setActivePane(pane2);
      expect(tabs.targetPane()).toBe(pane2);
    });

    it('moves a tab from one pane to another, leaving the displaced tab available', async () => {
      const tabs = await import('./tabs');
      tabs.setPanePreset('two-columns');
      const leaves = tabs.getVisiblePanes();
      const pane1 = leaves[0]!.id;
      const pane2 = leaves[1]!.id;

      tabs.showInPane('#/page/doc-1', pane1);
      tabs.showInPane('#/page/doc-2', pane2);

      const tab1Id = tabs.getTabForPane(pane1)!.id;
      const tab2Id = tabs.getTabForPane(pane2)!.id;

      // Move tab1 into pane2 (displacing tab2):
      tabs.moveTabToPane(tab1Id, pane2);

      // pane1 is now empty:
      expect(tabs.getTabForPane(pane1)).toBeNull();
      // pane2 now has tab1:
      expect(tabs.getTabForPane(pane2)?.id).toBe(tab1Id);

      // tab2 is NOT closed or lost: it remains available in layout.tabs
      expect(tabs.getTabs().layout.tabs.some((t) => t.id === tab2Id)).toBe(true);
      expect(tabs.getAvailableTabs().map((t) => t.id)).toContain(tab2Id);
    });

    it('splits pane when dropping on border if under four panes', async () => {
      const tabs = await import('./tabs');
      tabs.setPanePreset('single');
      expect(tabs.getVisiblePanes()).toHaveLength(1);
      const initialPane = tabs.getVisiblePanes()[0]!.id;

      // Split right with note
      const split1 = tabs.openRouteInPane('#/page/note-2', initialPane, { splitEdge: 'right' });
      expect(split1.success).toBe(true);
      expect(tabs.getVisiblePanes()).toHaveLength(2);

      // Split bottom on second pane
      const pane2 = tabs.getVisiblePanes()[1]!.id;
      const split2 = tabs.openRouteInPane('#/page/note-3', pane2, { splitEdge: 'bottom' });
      expect(split2.success).toBe(true);
      expect(tabs.getVisiblePanes()).toHaveLength(3);

      // Split left on first pane
      const split3 = tabs.openRouteInPane('#/page/note-4', initialPane, { splitEdge: 'left' });
      expect(split3.success).toBe(true);
      expect(tabs.getVisiblePanes()).toHaveLength(4);

      // Attempt to split 5th pane must be rejected and announce status
      let announcedMessage = '';
      const unsubscribe = tabs.subscribePaneAnnouncements((msg) => {
        announcedMessage = msg;
      });

      const split4 = tabs.openRouteInPane('#/page/note-5', initialPane, { splitEdge: 'right' });
      expect(split4.success).toBe(false);
      expect(split4.reason).toBe('too-many-panes');
      expect(tabs.getVisiblePanes()).toHaveLength(4);
      expect(announcedMessage).toContain('4');

      unsubscribe();
    });

    it('openSide splits when all visible panes are occupied and under 4, rejecting when 4', async () => {
      const tabs = await import('./tabs');
      tabs.setPanePreset('two-columns');
      const leaves = tabs.getVisiblePanes();
      tabs.showInPane('#/page/note-a', leaves[0]!.id);
      tabs.showInPane('#/page/note-b', leaves[1]!.id);

      // openSide with both occupied should split into a 3rd pane
      tabs.openSide('#/page/note-c');
      expect(tabs.getVisiblePanes()).toHaveLength(3);

      // 4th pane
      tabs.openSide('#/page/note-d');
      expect(tabs.getVisiblePanes()).toHaveLength(4);

      // 5th pane rejection
      let rejectionAnnounced = false;
      const unsubscribe = tabs.subscribePaneAnnouncements((msg) => {
        if (msg) rejectionAnnounced = true;
      });

      tabs.openSide('#/page/note-e');
      expect(tabs.getVisiblePanes()).toHaveLength(4);
      expect(rejectionAnnounced).toBe(true);

      unsubscribe();
    });

    it('duplicates note tab into target pane via duplicateTabToPane', async () => {
      const tabs = await import('./tabs');
      tabs.setPanePreset('two-columns');
      const leaves = tabs.getVisiblePanes();
      tabs.showInPane('#/page/source-note', leaves[0]!.id);
      const sourceTabId = tabs.getTabForPane(leaves[0]!.id)!.id;

      tabs.duplicateTabToPane(sourceTabId, leaves[1]!.id);

      const targetTab = tabs.getTabForPane(leaves[1]!.id);
      expect(targetTab).not.toBeNull();
      expect(targetTab?.id).not.toBe(sourceTabId);
      expect(targetTab?.target).toBe('#/page/source-note');
      expect(tabs.getTabForPane(leaves[0]!.id)?.id).toBe(sourceTabId);
    });

    it('preserves the displaced tab in layout.tabs when openRouteInPane places a note or file into an occupied pane', async () => {
      const tabs = await import('./tabs');
      tabs.setPanePreset('two-columns');
      const leaves = tabs.getVisiblePanes();
      const pane1 = leaves[0]!.id;
      const pane2 = leaves[1]!.id;

      tabs.showInPane('#/page/note-1', pane1);
      tabs.showInPane('#/page/note-2', pane2);
      const displacedTabId = tabs.getTabForPane(pane2)!.id;

      const validVaultId = '11111111-1111-4111-8111-111111111111';
      const fileRoute = `#/file/${validVaultId}/Docs/Spec.pdf`;
      const result = tabs.openRouteInPane(fileRoute, pane2);
      expect(result.success).toBe(true);

      expect(tabs.getTabForPane(pane2)?.target).toBe(fileRoute);
      expect(tabs.getTabs().layout.tabs.some((tab) => tab.id === displacedTabId)).toBe(true);
      expect(tabs.getAvailableTabs().map((tab) => tab.id)).toContain(displacedTabId);
    });

    it('splits a pane when moving a tab to an edge up to 4 panes and rejects the 5th while preserving history', async () => {
      const tabs = await import('./tabs');
      tabs.setPanePreset('single');
      const initialPane = tabs.getVisiblePanes()[0]!.id;
      tabs.showInPane('#/page/step-1', initialPane);
      tabs.showInPane('#/page/step-2', initialPane);
      const movedTabId = tabs.getTabForPane(initialPane)!.id;
      expect(tabs.getTabForPane(initialPane)?.back).toEqual(['#/', '#/page/step-1']);

      tabs.openTab('#/page/stay-in-first');
      const splitRes = tabs.moveTabToPaneWithSplit(movedTabId, initialPane, 'right');
      expect(splitRes.success).toBe(true);
      expect(tabs.getVisiblePanes()).toHaveLength(2);
      const secondPane = tabs.getVisiblePanes()[1]!.id;
      expect(tabs.getTabForPane(secondPane)?.id).toBe(movedTabId);
      expect(tabs.getTabForPane(secondPane)?.back).toEqual(['#/', '#/page/step-1']);
    });
  });

  describe('MIME types and gesture protection', () => {
    it('declares recognized drag MIME types', () => {
      expect(TAB_DRAG_TYPE).toBe('text/x-morrow-tab');
      expect(FILE_DRAG_TYPE).toBe('application/x-morrow-vault-file');
      expect(PAGE_DRAG_TYPES).toContain('application/x-morrow-page');
      expect(PAGE_DRAG_TYPES).toContain('application/x-morrow-page-id');
    });

    it('blocks pane content drag start on media, pdfs, and database cells', () => {
      expect(shouldIgnorePaneContentDragStart({ tagName: 'IMG' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'VIDEO' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'AUDIO' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ role: 'gridcell' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'database' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'pdf-file-view' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'ProseMirror' })).toBe(true);

      // Allowed drag sources
      expect(shouldIgnorePaneContentDragStart({ tagName: 'div', className: 'tab-item' })).toBe(false);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'button', className: 'file-catalog-row' })).toBe(false);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'span', className: 'nav-title' })).toBe(false);
    });
  });
});
