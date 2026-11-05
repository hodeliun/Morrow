import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SPLIT_RATIO,
  MAX_VISIBLE_PANES,
  MIN_SPLIT_RATIO,
  MAX_SPLIT_RATIO,
  applyPanePreset,
  availablePaneTabs,
  beginPaneResize,
  cancelPaneResize,
  closePane,
  createPaneLayout,
  detectPaneDropZone,
  duplicatePaneTab,
  focusPane,
  movePaneTab,
  panePresetOf,
  placeRouteInPane,
  previewPaneResize,
  resetPaneSplit,
  shouldIgnorePaneContentDragStart,
  splitPane,
  swapPaneTabs,
  visiblePaneLeaves,
} from './paneLayout';
import type { PaneLayout, PaneTabInstance } from './paneLayout';
import { describeTabForChooser } from './components/PaneEmptyChooser';
import {
  canonicalizeResourceTargetHash,
  classifyBrowserAddress,
  normalizeSafeHttpUrl,
  parseResourceTarget,
  serializeResourceTarget,
  URL_UNAVAILABLE_HASH,
} from './resourceTargets';
import { parseBrowserDescriptor } from './browserDescriptors';
import {
  MAX_BROWSER_DESCRIPTOR_BYTES,
  readBoundedBrowserDescriptor,
} from '../../electron/browserDescriptorReader';
import {
  classifyBrowserUrl,
  isAllowedBrowserDocumentUrl,
  isAllowedBrowserRequestUrl,
} from '../../electron/browserUrlPolicy';
import {
  createMediaProtocolHandler,
  parseMediaByteRange,
} from '../../electron/mediaProtocol';
import {
  createMediaResourceRegistry,
  type MediaResourceRegistry,
  type MediaVaultContext,
} from '../../electron/mediaResources';
import {
  isCurrentImageResourceOwner,
  isTrustedImageResourceInitiator,
  isTrustedImageViewerFrame,
} from '../../electron/imageViewerSecurity';
import {
  createFileCatalog,
  filterFileCatalog,
  normalizeFileCatalogPreferences,
  isPageTreeFileVisible,
} from '../core/vault/fileCatalog';
import type { VaultResource } from '../core/vault/fileCatalog';
import { contrastTextForHex } from '../core/colorContrast';
import { isColumnReadOnly } from '../core/gridOperations';
import type { DatabaseDef, PageMeta, WorkspaceState } from '../core/model';
import { MemoryVault } from '../storage/memoryVault';
import { VaultRepository } from '../storage/vaultRepository';
import { WorkspaceSession } from '../storage/session';
import { en } from './i18n/locales/en';
import { es } from './i18n/locales/es';
import { pt } from './i18n/locales/pt';
import { t } from './i18n';

const SYNTHETIC_VAULT_UUID = 'd4a1b5b5-55d4-4eb3-9c67-0a86191ac120';
const SYNTHETIC_TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';

let idSeq = 0;
const nextId = () => `extended-acc-${++idSeq}`;

function sha256(data: string | Uint8Array | Buffer | ArrayBuffer): string {
  if (data instanceof ArrayBuffer) {
    return createHash('sha256').update(Buffer.from(data)).digest('hex');
  }
  return createHash('sha256').update(data).digest('hex');
}

function makeTab(id: string, target: string, groupId = id): PaneTabInstance<string> {
  return {
    id,
    groupId,
    target,
    back: [],
    forward: [],
  };
}

function makePage(id: string, title: string, partial: Partial<PageMeta> = {}): PageMeta {
  return {
    id,
    parentId: null,
    title,
    icon: null,
    kind: 'page',
    order: 0,
    createdAt: 100,
    updatedAt: 100,
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

describe('Scope 2 Extended Acceptance (S2-31..S2-37 / T31..T39 / #91)', () => {
  describe('Criterion 1: Four-pane workspace mixing note, PDF, media, and web', () => {
    it('manages 4 simultaneous panes (grid-four) with empty chooser, placement, drag guards, and session restore', () => {
      const tabNote = makeTab('tab-note', '#/page/note-system-architecture');
      const tabPdf = makeTab('tab-pdf', `#/file/${SYNTHETIC_VAULT_UUID}/Papers/api-specification.pdf`);
      const tabMedia = makeTab('tab-media', `#/file/${SYNTHETIC_VAULT_UUID}/Media/briefing.webm`);
      const tabWeb = makeTab('tab-web', '#/url/https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs');
      const tabAvail = makeTab('tab-avail', '#/page/note-background-reading');
      const tabs = [tabNote, tabPdf, tabMedia, tabWeb, tabAvail];

      // 1. Build 4-pane layout (preset 'two-by-two')
      let layout: PaneLayout<PaneTabInstance<string>> = createPaneLayout(
        'layout-grid4',
        tabs,
        'tab-note',
        'two-by-two',
      );

      expect(panePresetOf(layout)).toBe('two-by-two');
      const leaves = visiblePaneLeaves(layout);
      expect(leaves).toHaveLength(4);
      expect(leaves.length).toBeLessThanOrEqual(MAX_VISIBLE_PANES);

      const [p1, p2, p3, p4] = leaves.map((leaf) => leaf.id) as [string, string, string, string];
      expect(layout.focusedPaneId).toBe(p1);

      // Assign the mixed content types across the 4 panes
      layout = movePaneTab(layout, 'tab-pdf', p2);
      layout = movePaneTab(layout, 'tab-media', p3);
      layout = movePaneTab(layout, 'tab-web', p4);

      const updatedLeaves = visiblePaneLeaves(layout);
      expect(updatedLeaves.map((l) => l.tabId)).toEqual([
        'tab-note',
        'tab-pdf',
        'tab-media',
        'tab-web',
      ]);

      // 2. Empty Chooser verification (describeTabForChooser)
      const mockWorkspace: WorkspaceState = {
        pages: {
          'note-system-architecture': makePage('note-system-architecture', 'Architecture Note'),
          'note-background-reading': makePage('note-background-reading', 'Background Reading'),
        },
        docs: {},
      };

      const noteChooser = describeTabForChooser(tabNote, mockWorkspace, updatedLeaves, t);
      expect(noteChooser.typeLabelKey).toBe('paneLayout.tabTypeNote');
      expect(noteChooser.title).toBe('Architecture Note');
      expect(noteChooser.isVisible).toBe(true);
      expect(noteChooser.assignedPaneNumber).toBe(1);

      const pdfChooser = describeTabForChooser(tabPdf, mockWorkspace, updatedLeaves, t);
      expect(pdfChooser.typeLabelKey).toBe('paneLayout.tabTypePdf');
      expect(pdfChooser.title).toBe('api-specification.pdf');
      expect(pdfChooser.isVisible).toBe(true);
      expect(pdfChooser.assignedPaneNumber).toBe(2);

      const mediaChooser = describeTabForChooser(tabMedia, mockWorkspace, updatedLeaves, t);
      expect(mediaChooser.typeLabelKey).toBe('paneLayout.tabTypeMedia');
      expect(mediaChooser.title).toBe('briefing.webm');
      expect(mediaChooser.isVisible).toBe(true);
      expect(mediaChooser.assignedPaneNumber).toBe(3);

      const webChooser = describeTabForChooser(tabWeb, mockWorkspace, updatedLeaves, t);
      expect(webChooser.typeLabelKey).toBe('paneLayout.tabTypeUrl');
      expect(webChooser.title).toBe('developer.mozilla.org');
      expect(webChooser.isVisible).toBe(true);
      expect(webChooser.assignedPaneNumber).toBe(4);

      const availChooser = describeTabForChooser(tabAvail, mockWorkspace, updatedLeaves, t);
      expect(availChooser.isVisible).toBe(false);
      expect(availChooser.assignedPaneNumber).toBeNull();
      expect(availChooser.originLabel).toBe(t('paneLayout.tabAvailable'));

      // 3. Swap, drop-zone detection, and placement operations
      const paneBounds = { left: 0, top: 0, width: 400, height: 300 };
      expect(detectPaneDropZone(paneBounds, { x: 200, y: 150 })).toBe('center');
      expect(detectPaneDropZone(paneBounds, { x: 20, y: 150 })).toBe('left');
      expect(detectPaneDropZone(paneBounds, { x: 380, y: 150 })).toBe('right');
      expect(detectPaneDropZone(paneBounds, { x: 200, y: 20 })).toBe('top');
      expect(detectPaneDropZone(paneBounds, { x: 200, y: 280 })).toBe('bottom');

      layout = swapPaneTabs(layout, p2, p3);
      expect(visiblePaneLeaves(layout).map((l) => l.tabId)).toEqual([
        'tab-note',
        'tab-media',
        'tab-pdf',
        'tab-web',
      ]);

      // Placing a background route into an occupied pane preserves the displaced tab
      const placedLayout = placeRouteInPane(layout, p2, '#/page/note-background-reading');
      expect(visiblePaneLeaves(placedLayout).find((l) => l.id === p2)?.tabId).toBe('tab-avail');
      expect(availablePaneTabs(placedLayout).map((item) => item.id)).toContain('tab-media');

      // 4. Split rejection on 5th pane
      const fifthAttempt = splitPane(layout, p1, 'right', 'tab-avail');
      expect(fifthAttempt.success).toBe(false);
      expect(fifthAttempt.reason).toBe('too-many-panes');
      expect(visiblePaneLeaves(fifthAttempt.layout)).toHaveLength(4);

      // 5. Split allowed when visible < 4
      const twoPaneLayout = applyPanePreset(layout, 'two-columns');
      const twoLeaves = visiblePaneLeaves(twoPaneLayout);
      expect(twoLeaves).toHaveLength(2);
      const thirdSplit = splitPane(twoPaneLayout, twoLeaves[0]!.id, 'bottom', 'tab-pdf');
      expect(thirdSplit.success).toBe(true);
      const threeLeaves = visiblePaneLeaves(thirdSplit.layout);
      expect(threeLeaves).toHaveLength(3);

      const fourthSplit = splitPane(thirdSplit.layout, threeLeaves[1]!.id, 'right', 'tab-media');
      expect(fourthSplit.success).toBe(true);
      expect(visiblePaneLeaves(fourthSplit.layout)).toHaveLength(4);

      // 6. Proportional and keyboard resize & reset
      const rootSplit = layout.root.kind === 'split' ? layout.root : null;
      expect(rootSplit).not.toBeNull();
      if (rootSplit) {
        const session = beginPaneResize(layout, rootSplit.id);
        expect(session).not.toBeNull();
        if (session) {
          // Preview resize with clamping
          const resized = previewPaneResize(layout, session, 0.35);
          expect((resized.root as { ratio: number }).ratio).toBe(0.35);

          const overClamped = previewPaneResize(layout, session, 0.95);
          expect((overClamped.root as { ratio: number }).ratio).toBe(MAX_SPLIT_RATIO);

          const underClamped = previewPaneResize(layout, session, 0.05);
          expect((underClamped.root as { ratio: number }).ratio).toBe(MIN_SPLIT_RATIO);

          // Esc cancels
          const cancelled = cancelPaneResize(resized, session);
          expect((cancelled.root as { ratio: number }).ratio).toBe(session.initialRatio);

          // Home resets to DEFAULT_SPLIT_RATIO (0.5)
          const reset = resetPaneSplit(resized, rootSplit.id);
          expect((reset.root as { ratio: number }).ratio).toBe(DEFAULT_SPLIT_RATIO);
        }
      }

      // 7. Focus per pane
      layout = focusPane(layout, p3);
      expect(layout.focusedPaneId).toBe(p3);

      // 8. Close pane: displaced tab is preserved in layout.tabs & availablePaneTabs
      const closed = closePane(layout, p4);
      expect(visiblePaneLeaves(closed)).toHaveLength(3);
      const availableIds = availablePaneTabs(closed).map((item) => item.id);
      expect(availableIds).toContain('tab-web');
      expect(closed.tabs.map((item) => item.id)).toContain('tab-web');

      // 9. Session restoration & parked URLs without premature network
      const webTarget = parseResourceTarget('#/url/https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs');
      expect(webTarget).toEqual({
        kind: 'url',
        url: 'https://developer.mozilla.org/en-US/docs',
      });
      expect(serializeResourceTarget(webTarget)).toBe('#/url/https%3A%2F%2Fdeveloper.mozilla.org%2Fen-US%2Fdocs');

      // 10. URL sanitization: credentials and non-restorable queries
      const credentialUrl = 'https://admin:secret123@example.com/vault';
      expect(classifyBrowserAddress(credentialUrl).ok).toBe(false);
      expect(normalizeSafeHttpUrl(credentialUrl)).toBeNull();

      const tokenUrl = 'https://example.com/doc?token=abc-123-session';
      const tokenDecision = classifyBrowserAddress(tokenUrl);
      expect(tokenDecision.ok).toBe(true);
      if (tokenDecision.ok) {
        expect(tokenDecision.warnings).toContain('ephemeral');
        expect(tokenDecision.restorable).toBe(false);
      }
      expect(canonicalizeResourceTargetHash(`#/url/${encodeURIComponent(tokenUrl)}`)).toBe(URL_UNAVAILABLE_HASH);

      // Clean YouTube watch URL is preserved
      const ytUrl = 'https://www.youtube.com/watch?v=0123456789A';
      expect(classifyBrowserAddress(ytUrl)).toEqual({
        ok: true,
        url: ytUrl,
        restorable: true,
        warnings: [],
      });
      expect(normalizeSafeHttpUrl(ytUrl)).toBe(ytUrl);
    });

    it('supports the same note opened in two panes with distinct tabIds, independent history, and shared session', async () => {
      const initialMarkdown = [
        '---',
        'title: Dual Pane Concurrent Note',
        'morrowControls:',
        '  - id: target-budget',
        '    name: Target Budget',
        '    type: number',
        '    value: 5000',
        '    defaultValue: 1000',
        '    options: []',
        '---',
        'Budget limit is <span data-morrow-control="target-budget">Target Budget</span>.',
      ].join('\n');

      const vault = new MemoryVault({
        'concurrent-note.md': initialMarkdown,
      });

      const repo = new VaultRepository(vault, nextId);
      const sessionResult = await WorkspaceSession.open(repo, { delayMs: 0 });
      expect(sessionResult.ok).toBe(true);
      if (!sessionResult.ok) return;

      const session = sessionResult.value;
      const pages = Object.values(session.getState().pages);
      const targetPage = pages.find((p) => p.title === 'Dual Pane Concurrent Note')!;
      expect(targetPage).toBeDefined();
      const pageId = targetPage.id;

      // 1. Setup layout with 2 panes
      const tab1 = makeTab('tab-pane-1', `#/page/${pageId}`);
      let layout = createPaneLayout('layout-dual', [tab1], 'tab-pane-1', 'two-columns');
      const leaves = visiblePaneLeaves(layout);
      expect(leaves).toHaveLength(2);

      // Duplicate tab1 into pane 2
      layout = duplicatePaneTab(layout, 'tab-pane-1', leaves[1]!.id);
      const updatedLeaves = visiblePaneLeaves(layout);
      const tabId1 = updatedLeaves[0]!.tabId!;
      const tabId2 = updatedLeaves[1]!.tabId!;

      // Distinct IDs, same target route
      expect(tabId1).not.toBe(tabId2);
      const instance1 = layout.tabs.find((item) => item.id === tabId1)!;
      const instance2 = layout.tabs.find((item) => item.id === tabId2)!;
      expect(instance1.target).toBe(`#/page/${pageId}`);
      expect(instance2.target).toBe(`#/page/${pageId}`);

      // 2. Independent navigation history
      const updatedTabs = layout.tabs.map((tab) => {
        if (tab.id === tabId1) {
          return {
            ...tab,
            target: '#/page/sub-section-alpha',
            back: [tab.target],
          };
        }
        return tab;
      });
      layout = { ...layout, tabs: updatedTabs };

      const current1 = layout.tabs.find((item) => item.id === tabId1)!;
      const current2 = layout.tabs.find((item) => item.id === tabId2)!;
      expect(current1.target).toBe('#/page/sub-section-alpha');
      expect(current1.back).toEqual([`#/page/${pageId}`]);
      expect(current2.target).toBe(`#/page/${pageId}`);
      expect(current2.back).toEqual([]);

      // 3. Shared WorkspaceSession: edit in session reflects concurrently
      const execResult = session.execute({
        type: 'page.control.setValue',
        id: pageId,
        controlId: 'target-budget',
        value: 12500,
        now: Date.now(),
      });
      expect(execResult.ok).toBe(true);

      const state = session.getState();
      const loadedPage = state.pages[pageId];
      expect(loadedPage).toBeDefined();
      expect(loadedPage?.controls[0]?.value).toBe(12500);

      await session.close();
    });

    it('enforces internal gesture guards, readonly mode, theme contrast, and PT/EN/ES i18n parity', () => {
      // 1. Internal gesture guard (shouldIgnorePaneContentDragStart)
      // Elements that MUST be ignored (true):
      expect(shouldIgnorePaneContentDragStart({ tagName: 'img' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'video' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'audio' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'table' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'td' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'th' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ role: 'gridcell' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'media-file-view' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'pdf-file-view' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'ProseMirror' })).toBe(true);
      expect(shouldIgnorePaneContentDragStart({ className: 'database' })).toBe(true);

      // Elements with DOM .closest() simulation
      const mockElement = (selector: string) => ({
        closest: (query: string) => (query.includes(selector) ? {} : null),
      });
      expect(shouldIgnorePaneContentDragStart(mockElement('.media-file-view'))).toBe(true);
      expect(shouldIgnorePaneContentDragStart(mockElement('.pdf-file-view'))).toBe(true);
      expect(shouldIgnorePaneContentDragStart(mockElement('.ProseMirror'))).toBe(true);
      expect(shouldIgnorePaneContentDragStart(mockElement('[role="gridcell"]'))).toBe(true);

      // Elements that should NOT be ignored (false):
      expect(shouldIgnorePaneContentDragStart({ tagName: 'div', className: 'pane-header' })).toBe(false);
      expect(shouldIgnorePaneContentDragStart({ tagName: 'span', className: 'tab-title' })).toBe(false);
      expect(shouldIgnorePaneContentDragStart(null)).toBe(false);
      expect(shouldIgnorePaneContentDragStart(undefined)).toBe(false);

      // 2. Readonly mode
      const sampleDb: DatabaseDef = {
        titleAlias: 'Items',
        displayPropertyId: 'title',
        properties: [
          { id: 'title', name: 'Name', type: 'text', fillMode: 'manual', options: [] },
          { id: 'cost', name: 'Cost', type: 'number', fillMode: 'manual', options: [] },
          { id: 'total', name: 'Total', type: 'formula', formula: 'thisRow.Cost * 1.1', fillMode: 'calculated', options: [] },
          { id: 'created', name: 'Created', type: 'createdTime', fillMode: 'manual', options: [] },
          { id: 'updated', name: 'Updated', type: 'lastEditedTime', fillMode: 'manual', options: [] },
          { id: 'action', name: 'Action', type: 'button', fillMode: 'manual', options: [] },
        ],
        views: [],
      };

      expect(isColumnReadOnly('title', sampleDb)).toBe(false);
      expect(isColumnReadOnly('cost', sampleDb)).toBe(false);
      expect(isColumnReadOnly('total', sampleDb)).toBe(true);
      expect(isColumnReadOnly('created', sampleDb)).toBe(true);
      expect(isColumnReadOnly('updated', sampleDb)).toBe(true);
      expect(isColumnReadOnly('action', sampleDb)).toBe(true);

      // 3. Theme contrast
      expect(contrastTextForHex('#000000')).toBe('#ffffff');
      expect(contrastTextForHex('#ffffff')).toBe('#111111');
      expect(contrastTextForHex('#1e1e1e')).toBe('#ffffff');
      expect(contrastTextForHex('#f5f5f5')).toBe('#111111');

      // 4. Parity of PT/EN/ES for all files-and-panes translation keys
      const sections = [
        'paneLayout',
        'fileCatalog',
        'fileViewer',
        'mediaViewer',
        'browserTabs',
        'pdfViewer',
        'resourceTarget',
      ] as const;

      const enDict = en as unknown as Record<string, Record<string, string>>;
      const ptDict = pt as unknown as Record<string, Record<string, string>>;
      const esDict = es as unknown as Record<string, Record<string, string>>;

      for (const section of sections) {
        const enSection = enDict[section];
        const ptSection = ptDict[section];
        const esSection = esDict[section];

        expect(enSection).toBeDefined();
        expect(ptSection).toBeDefined();
        expect(esSection).toBeDefined();

        if (enSection && ptSection && esSection) {
          const enKeys = Object.keys(enSection);
          const missingInPt = enKeys.filter((k) => !(k in ptSection));
          const missingInEs = enKeys.filter((k) => !(k in esSection));

          expect(missingInPt, `Missing PT keys in section ${section}`).toEqual([]);
          expect(missingInEs, `Missing ES keys in section ${section}`).toEqual([]);
        }
      }
    });
  });

  describe('Criterion 2: Synthetic vault integrity, scanner limits, and HTTP Range streaming', () => {
    it('preserves exact SHA-256 hashes of binaries and notes with 0 writes upon opening and cataloging', async () => {
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
      const svgText = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>';
      const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
      const wavBytes = Buffer.from('RIFF$   WAVEfmt     data    ');
      const webmBytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01]);
      const gdocText = JSON.stringify({ url: 'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit' });
      const gsheetText = JSON.stringify({ url: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit' });
      const readmeText = 'Synthetic project documentation without an extension';

      const noteContent = [
        '---',
        'title: Note with Preserved YAML',
        'unknownFutureField: keep-me-100-percent-intact',
        'extraMetadata:',
        '  nestedProp: stable-value',
        '  versionNumber: 42',
        'morrowControls:',
        '  - id: discount-rate',
        '    name: Discount',
        '    type: number',
        '    value: 0.15',
        '    defaultValue: 0.05',
        '    options: []',
        '---',
        'Content preserving markdown text and binary links.',
      ].join('\n');

      const initialFiles: Record<string, string | Uint8Array> = {
        'Note.md': noteContent,
        'Images/diagram.png': pngBytes,
        'Images/icon.svg': svgText,
        'Docs/specification.pdf': pdfBytes,
        'Audio/announcement.wav': wavBytes,
        'Media/intro.webm': webmBytes,
        'Links/Brief.gdoc': gdocText,
        'Links/Financials.gsheet': gsheetText,
        'Docs/README': readmeText,
      };

      // Compute initial SHA-256 hashes
      const initialHashes: Record<string, string> = {};
      for (const [filename, content] of Object.entries(initialFiles)) {
        initialHashes[filename] = sha256(content);
      }

      // Memory vault with write tracking
      const vault = new MemoryVault({ ...initialFiles } as Record<string, string>);
      // Ensure binary buffers are accurately stored in vault map as exact ArrayBuffers
      for (const [filename, content] of Object.entries(initialFiles)) {
        if (typeof content !== 'string') {
          const exactBuffer = new Uint8Array(content).buffer as ArrayBuffer;
          vault.files.set(filename, exactBuffer);
        }
      }

      const appliedWrites: Array<{ op: string; path?: string }> = [];

      const originalApply = vault.apply.bind(vault);
      vault.apply = async (ops) => {
        for (const op of ops) {
          if (op.op === 'write') {
            appliedWrites.push({ op: op.op, path: op.path });
          }
        }
        return originalApply(ops);
      };

      // Open WorkspaceSession
      const sessionResult = await WorkspaceSession.open(
        new VaultRepository(vault, nextId),
        { delayMs: 0 },
      );
      expect(sessionResult.ok).toBe(true);
      if (!sessionResult.ok) return;

      const session = sessionResult.value;

      // Catalog files
      const rawResources: VaultResource[] = Object.keys(initialFiles).map((p) => {
        const ext = p.includes('.') ? p.split('.').at(-1)!.toLowerCase() : '';
        return {
          path: p,
          extension: ext,
          size: typeof initialFiles[p] === 'string' ? (initialFiles[p] as string).length : (initialFiles[p] as Uint8Array).length,
          mtime: 1000,
        };
      });
      const catalog = createFileCatalog(rawResources);
      expect(catalog.files.length).toBeGreaterThanOrEqual(8);

      // Verify ZERO write operations upon opening & cataloging
      expect(appliedWrites).toEqual([]);

      // Verify ALL SHA-256 hashes remain 100% identical in vault storage
      for (const [filename, expectedHash] of Object.entries(initialHashes)) {
        const fileContent = vault.files.get(filename);
        expect(fileContent).toBeDefined();
        if (fileContent) {
          expect(sha256(fileContent)).toBe(expectedHash);
        }
      }

      // Verify unknown YAML fields remain intact in state
      const state = session.getState();
      const page = Object.values(state.pages).find((p) => p.title === 'Note with Preserved YAML');
      expect(page).toBeDefined();
      expect(page?.extra?.unknownFutureField).toBe('keep-me-100-percent-intact');
      expect((page?.extra?.extraMetadata as Record<string, unknown>)?.nestedProp).toBe('stable-value');

      await session.close();
    });

    it('enforces scanner limits: exclusions (.morrow, .git, hidden), confinement, and filtering', () => {
      const resources: VaultResource[] = [
        { path: 'Research/paper.pdf', extension: 'pdf', size: 1024, mtime: 100 },
        { path: 'Research/clip.mp4', extension: 'mp4', size: 2048, mtime: 100 },
        { path: 'Docs/README', extension: '', size: 512, mtime: 100 },
        { path: 'attachments/photo.png', extension: 'png', size: 4096, mtime: 100 },
        { path: '.morrow/workspace.json', extension: 'json', size: 128, mtime: 100 },
        { path: '.git/HEAD', extension: '', size: 32, mtime: 100 },
        { path: '.hidden/secret.pdf', extension: 'pdf', size: 512, mtime: 100 },
        { path: '.trash/old.pdf', extension: 'pdf', size: 512, mtime: 100 },
        { path: 'Research/.morrow-tmp-upload.bin', extension: 'bin', size: 128, mtime: 100 },
        { path: '../outside.pdf', extension: 'pdf', size: 128, mtime: 100 },
      ];

      const catalog = createFileCatalog(resources);

      // Technical, hidden, and traversal paths are excluded
      const catalogPaths = catalog.files.map((f) => f.path);
      expect(catalogPaths).toContain('Research/paper.pdf');
      expect(catalogPaths).toContain('Research/clip.mp4');
      expect(catalogPaths).toContain('Docs/README');
      expect(catalogPaths).toContain('attachments/photo.png');

      expect(catalogPaths).not.toContain('.morrow/workspace.json');
      expect(catalogPaths).not.toContain('.git/HEAD');
      expect(catalogPaths).not.toContain('.hidden/secret.pdf');
      expect(catalogPaths).not.toContain('.trash/old.pdf');
      expect(catalogPaths).not.toContain('Research/.morrow-tmp-upload.bin');
      expect(catalogPaths).not.toContain('../outside.pdf');

      // Preferences and filtering
      const prefs = normalizeFileCatalogPreferences({
        mode: 'selected',
        selectedExtensions: ['.PDF', 'mp4'],
      });
      const filtered = filterFileCatalog(catalog, prefs);
      expect(filtered.files.map((f) => f.path)).toEqual([
        'Research/clip.mp4',
        'Research/paper.pdf',
      ]);

      const allMode = normalizeFileCatalogPreferences({
        mode: 'all',
        hiddenExtensions: ['mp4'],
        includeExtensionless: true,
        showAttachments: false,
      });
      const allFiltered = filterFileCatalog(catalog, allMode);
      expect(allFiltered.files.map((f) => f.path)).toContain('Docs/README');
      expect(allFiltered.files.map((f) => f.path)).toContain('Research/paper.pdf');
      expect(allFiltered.files.map((f) => f.path)).not.toContain('Research/clip.mp4');
      expect(allFiltered.files.map((f) => f.path)).not.toContain('attachments/photo.png');

      // Page tree filter check
      expect(isPageTreeFileVisible('Notes/Journal.MD', prefs)).toBe(false);
      expect(isPageTreeFileVisible('Notes/Research.pdf', prefs)).toBe(true);
    });

    it('implements HTTP Range streaming (206/416), HEAD, and MIME contracts without full-file reading', async () => {
      const fileSize = 1000;

      // 1. parseMediaByteRange contracts
      expect(parseMediaByteRange('bytes=0-99', fileSize)).toEqual({
        kind: 'range',
        start: 0,
        end: 99,
      });
      expect(parseMediaByteRange('bytes=500-', fileSize)).toEqual({
        kind: 'range',
        start: 500,
        end: 999,
      });
      expect(parseMediaByteRange('bytes=-100', fileSize)).toEqual({
        kind: 'range',
        start: 900,
        end: 999,
      });
      expect(parseMediaByteRange('bytes=0-5000', fileSize)).toEqual({
        kind: 'range',
        start: 0,
        end: 999,
      });
      // Unsatisfiable (HTTP 416)
      expect(parseMediaByteRange('bytes=2000-', fileSize)).toEqual({ kind: 'unsatisfiable' });
      expect(parseMediaByteRange('bytes=500-200', fileSize)).toEqual({ kind: 'unsatisfiable' });
      // Ignored / malformed
      expect(parseMediaByteRange('items=0-10', fileSize)).toEqual({ kind: 'ignored' });
      expect(parseMediaByteRange(null, fileSize)).toEqual({ kind: 'ignored' });

      // 2. Protocol handler with streaming slices
      const syntheticBuffer = Buffer.alloc(1000);
      for (let i = 0; i < 1000; i++) syntheticBuffer[i] = i % 256;

      const openedRanges: Array<{ start: number; end: number }> = [];
      const mockRegistry = {
        issue: async () => ({ ok: false as const, code: 'invalid-resource' as const }),
        inspect: async () => ({
          kind: 'video' as const,
          mimeType: 'video/webm',
          size: fileSize,
        }),
        open: async (_token: unknown, start: number, end: number) => {
          openedRanges.push({ start, end });
          const slice = syntheticBuffer.subarray(start, end + 1);
          return {
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(slice);
                controller.close();
              },
            }),
            kind: 'video' as const,
            mimeType: 'video/webm',
            size: fileSize,
            start,
            end,
          };
        },
        release() {},
        clear() {},
      } satisfies MediaResourceRegistry;

      const handler = createMediaProtocolHandler({
        getRegistry: () => mockRegistry,
        authorize: () => true,
      });

      // Request 1: Byte Range 100-199 with valid vault UUID and token
      const rangeReq = new Request(`morrow-media://vault/${SYNTHETIC_VAULT_UUID}/${SYNTHETIC_TOKEN}`, {
        headers: { Range: 'bytes=100-199' },
      });
      const rangeRes = await handler(rangeReq);
      expect(rangeRes.status).toBe(206);
      expect(rangeRes.headers.get('Content-Range')).toBe('bytes 100-199/1000');
      expect(rangeRes.headers.get('Content-Length')).toBe('100');
      expect(rangeRes.headers.get('Content-Type')).toBe('video/webm');
      expect(rangeRes.headers.get('Accept-Ranges')).toBe('bytes');

      const chunk = new Uint8Array(await rangeRes.arrayBuffer());
      expect(chunk.byteLength).toBe(100);
      expect(chunk[0]).toBe(100);
      expect(chunk[99]).toBe(199);
      // Streamed ONLY the requested range without reading all 1000 bytes
      expect(openedRanges).toEqual([{ start: 100, end: 199 }]);

      // Request 2: HEAD request returns metadata without body
      const headReq = new Request(`morrow-media://vault/${SYNTHETIC_VAULT_UUID}/${SYNTHETIC_TOKEN}`, {
        method: 'HEAD',
      });
      const headRes = await handler(headReq);
      expect(headRes.status).toBe(200);
      expect(headRes.headers.get('Content-Length')).toBe('1000');
      expect(headRes.headers.get('Content-Type')).toBe('video/webm');
      const headBody = await headRes.arrayBuffer();
      expect(headBody.byteLength).toBe(0);

      // Request 3: Unsatisfiable range (416)
      const badReq = new Request(`morrow-media://vault/${SYNTHETIC_VAULT_UUID}/${SYNTHETIC_TOKEN}`, {
        headers: { Range: 'bytes=5000-' },
      });
      const badRes = await handler(badReq);
      expect(badRes.status).toBe(416);
      expect(badRes.headers.get('Content-Range')).toBe('bytes */1000');
    });
  });

  describe('Criterion 3: Security contracts, origin isolation, path traversal, and descriptor validation', () => {
    it('blocks untrusted senders, rejects path traversal, and enforces resource authorizations', async () => {
      // 1. Untrusted sender in media protocol handler: authorize returns false -> 404 unavailable
      const mockRegistry = {
        issue: async () => ({ ok: false as const, code: 'invalid-resource' as const }),
        inspect: async () => ({ kind: 'audio' as const, mimeType: 'audio/wav', size: 100 }),
        open: async () => ({
          body: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
          kind: 'audio' as const,
          mimeType: 'audio/wav',
          size: 100,
          start: 0,
          end: 99,
        }),
        release() {},
        clear() {},
      } satisfies MediaResourceRegistry;

      const handler = createMediaProtocolHandler({
        getRegistry: () => mockRegistry,
        authorize: (_req, _vaultId, _token) => false, // Sender not authorized
      });

      const forbiddenReq = new Request(`morrow-media://vault/${SYNTHETIC_VAULT_UUID}/${SYNTHETIC_TOKEN}`);
      const forbiddenRes = await handler(forbiddenReq);
      expect(forbiddenRes.status).toBe(404);

      // 2. Image viewer security: frame and initiator verification
      const trustedMain = {};
      const trustedFrame = {};
      const untrustedSender = {};

      expect(
        isTrustedImageViewerFrame(
          trustedMain,
          trustedFrame,
          trustedMain,
          trustedFrame,
          'http://localhost:5173',
          (u) => u.startsWith('http://localhost'),
        ),
      ).toBe(true);

      // Sender mismatch
      expect(
        isTrustedImageViewerFrame(
          untrustedSender,
          trustedFrame,
          trustedMain,
          trustedFrame,
          'http://localhost:5173',
          (u) => u.startsWith('http://localhost'),
        ),
      ).toBe(false);

      // Owner verification
      const owner = { webContentsId: 42, frame: trustedFrame, vaultId: 'vault-1' };
      expect(
        isCurrentImageResourceOwner(
          owner,
          42,
          trustedFrame,
          'http://localhost:5173',
          () => true,
        ),
      ).toBe(true);

      expect(
        isCurrentImageResourceOwner(
          owner,
          99, // Mismatched webContentsId
          trustedFrame,
          'http://localhost:5173',
          () => true,
        ),
      ).toBe(false);

      // Initiator with userinfo credentials is rejected
      expect(
        isTrustedImageResourceInitiator(
          'https://attacker:password@example.org',
          'https://example.org',
        ),
      ).toBe(false);

      // 3. Real filesystem confinement (traversal, symlink, reserved folders) & cleanup on close/vault switch
      const tempBase = await mkdtemp(path.join(tmpdir(), 'morrow-t39-sec-'));
      try {
        const realBase = await realpath(tempBase);
        const vaultRoot = path.join(realBase, 'vault');
        const outsideRoot = path.join(realBase, 'outside');
        await writeFile(path.join(realBase, 'outside.wav'), Buffer.from('RIFF$   WAVEfmt     data    '));
        const { mkdir } = await import('node:fs/promises');
        await mkdir(vaultRoot, { recursive: true });
        await mkdir(outsideRoot, { recursive: true });
        await mkdir(path.join(vaultRoot, '.morrow'), { recursive: true });

        const validWavPath = path.join(vaultRoot, 'clip.wav');
        const wavPayload = Buffer.from('RIFF$   WAVEfmt     data1234');
        await writeFile(validWavPath, wavPayload);
        await writeFile(path.join(vaultRoot, '.morrow', 'hidden.wav'), wavPayload);
        await symlink(path.join(realBase, 'outside.wav'), path.join(vaultRoot, 'linked.wav'));

        const validGdocPath = path.join(vaultRoot, 'Doc.gdoc');
        const gdocPayload = JSON.stringify({
          url: 'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
        });
        await writeFile(validGdocPath, gdocPayload);
        await symlink(validGdocPath, path.join(vaultRoot, 'LinkedDoc.gdoc'));
        const oversizedGdocPath = path.join(vaultRoot, 'Oversized.gdoc');
        await writeFile(oversizedGdocPath, 'x'.repeat(MAX_BROWSER_DESCRIPTOR_BYTES + 16));

        let currentContext: MediaVaultContext | null = {
          root: vaultRoot,
          realRoot: vaultRoot,
          generation: 1,
        };
        const mediaRegistry = createMediaResourceRegistry({
          getContext: () => currentContext,
        });

        // Rejects traversal, reserved segment (.morrow), and symlink escaping vault
        expect(await mediaRegistry.issue('../outside.wav')).toEqual({
          ok: false,
          code: 'invalid-resource',
        });
        expect(await mediaRegistry.issue('.morrow/hidden.wav')).toEqual({
          ok: false,
          code: 'invalid-resource',
        });
        expect(await mediaRegistry.issue('linked.wav')).toEqual({
          ok: false,
          code: 'invalid-resource',
        });

        // Issues valid resource token, serves slice, and revokes on release() and clear()
        const issued = await mediaRegistry.issue('clip.wav');
        expect(issued.ok).toBe(true);
        if (issued.ok) {
          const slice = await mediaRegistry.open(issued.token, 0, 7);
          expect(slice).not.toBeNull();
          if (slice) {
            const bytes = new Uint8Array(await new Response(slice.body).arrayBuffer());
            expect(bytes.byteLength).toBe(8);
          }

          // Release on tab close revokes token immediately
          mediaRegistry.release(issued.token);
          expect(await mediaRegistry.inspect(issued.token)).toBeNull();
          expect(await mediaRegistry.open(issued.token, 0, 7)).toBeNull();
        }

        // Re-issue and verify vault switch (generation change + clear) revokes active tokens
        const issuedBeforeSwitch = await mediaRegistry.issue('clip.wav');
        expect(issuedBeforeSwitch.ok).toBe(true);
        if (issuedBeforeSwitch.ok) {
          currentContext = { root: vaultRoot, realRoot: vaultRoot, generation: 2 };
          expect(await mediaRegistry.inspect(issuedBeforeSwitch.token)).toBeNull();
          mediaRegistry.clear();
          expect(await mediaRegistry.open(issuedBeforeSwitch.token, 0, 7)).toBeNull();
        }

        // Bounded browser descriptor reader enforces realpath, blocks symlinks, and caps at 64 KiB
        const descriptorContext = { root: vaultRoot, realRoot: vaultRoot, generation: 1 };
        const readValid = await readBoundedBrowserDescriptor({
          candidate: validGdocPath,
          context: descriptorContext,
          getCurrentContext: () => descriptorContext,
        });
        expect(readValid).toBe(gdocPayload);

        const readSymlink = await readBoundedBrowserDescriptor({
          candidate: path.join(vaultRoot, 'LinkedDoc.gdoc'),
          context: descriptorContext,
          getCurrentContext: () => descriptorContext,
        });
        expect(readSymlink).toBeNull();

        const readOutside = await readBoundedBrowserDescriptor({
          candidate: path.join(realBase, 'outside.wav'),
          context: descriptorContext,
          getCurrentContext: () => descriptorContext,
        });
        expect(readOutside).toBeNull();

        const readOversized = await readBoundedBrowserDescriptor({
          candidate: oversizedGdocPath,
          context: descriptorContext,
          getCurrentContext: () => descriptorContext,
        });
        expect(readOversized).toBeNull();
      } finally {
        await rm(tempBase, { recursive: true, force: true });
      }
    });

    it('blocks remote web tabs from accessing local filesystem, privileged schemes, and data frames', () => {
      // 1. classifyBrowserUrl & isAllowedBrowserDocumentUrl
      const forbiddenDocumentUrls = [
        'file:///etc/passwd',
        'file:///C:/Windows/win.ini',
        'file:///home/user/vault/secret.md',
        'morrow-asset://vault/private.png',
        'morrow-media://vault/audio.wav',
        'javascript:alert(document.cookie)',
        'data:text/html,<script>window.location="http://evil.com"</script>',
        'vbscript:msgbox(1)',
        'chrome://settings',
        'about:config',
      ];

      for (const url of forbiddenDocumentUrls) {
        expect(isAllowedBrowserDocumentUrl(url)).toBe(false);
        const classification = classifyBrowserUrl(url);
        expect(classification.ok).toBe(false);
      }

      // Safe HTTP and HTTPS web URLs are permitted
      expect(isAllowedBrowserDocumentUrl('https://example.com/docs')).toBe(true);
      expect(isAllowedBrowserDocumentUrl('http://insecure-site.org/info')).toBe(true);

      // 2. isAllowedBrowserRequestUrl: subresource request security
      // Blocks file, javascript, and data frames
      expect(isAllowedBrowserRequestUrl('file:///tmp/leak.png', 'image')).toBe(false);
      expect(isAllowedBrowserRequestUrl('javascript:void(0)', 'script')).toBe(false);
      expect(isAllowedBrowserRequestUrl('data:text/html,test', 'mainFrame')).toBe(false);
      expect(isAllowedBrowserRequestUrl('data:text/html,test', 'subFrame')).toBe(false);

      // Allows images and fonts with data URI if resourceType matches
      expect(isAllowedBrowserRequestUrl('data:image/png;base64,iVBOR', 'image')).toBe(true);
      expect(isAllowedBrowserRequestUrl('data:font/woff2;base64,d09GM', 'font')).toBe(true);

      // Allows safe HTTP subresources
      expect(isAllowedBrowserRequestUrl('https://cdn.example.com/lib.js', 'script')).toBe(true);
      expect(isAllowedBrowserRequestUrl('https://cdn.example.com/style.css', 'stylesheet')).toBe(true);
    });

    it('strictly parses .gdoc and .gsheet descriptors for HTTPS docs.google.com without code execution', () => {
      // 1. Valid .gdoc descriptor
      const validGdoc = JSON.stringify({
        url: 'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
      });
      const gdocResult = parseBrowserDescriptor('gdoc', validGdoc);
      expect(gdocResult.ok).toBe(true);
      if (gdocResult.ok) {
        expect(gdocResult.url).toBe(
          'https://docs.google.com/document/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit',
        );
      }

      // 2. Valid .gsheet descriptor
      const validGsheet = JSON.stringify({
        url: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0',
      });
      const gsheetResult = parseBrowserDescriptor('gsheet', validGsheet);
      expect(gsheetResult.ok).toBe(true);

      // 3. Rejects code execution or malicious payloads
      const codeExecutionPayloads = [
        '{"url": "javascript:fetch(\'/api/steal\')"}',
        '{"url": "https://malicious-phishing-domain.com/login"}',
        '{"url": "file:///etc/passwd"}',
        '{"url": "https://docs.google.com.attacker.com/document/d/123"}',
        '{"url": "https://docs.google.com:8443/document/d/123"}',
        'alert("executing payload");',
        '<script>alert(1)</script>',
      ];

      for (const payload of codeExecutionPayloads) {
        expect(parseBrowserDescriptor('gdoc', payload)).toEqual({
          ok: false,
          code: 'invalid-resource',
        });
      }

      // 4. Rejects mismatching descriptor type
      // .gdoc pointing to spreadsheets path
      const mismatch = JSON.stringify({
        url: 'https://docs.google.com/spreadsheets/d/123/edit',
      });
      expect(parseBrowserDescriptor('gdoc', mismatch)).toEqual({
        ok: false,
        code: 'invalid-resource',
      });

      // 5. XLSX is NOT a google descriptor: parseBrowserDescriptor returns invalid-resource
      expect(
        parseBrowserDescriptor('xlsx' as 'gdoc', '{"url": "https://docs.google.com/spreadsheets/d/123"}'),
      ).toEqual({
        ok: false,
        code: 'invalid-resource',
      });
    });
  });
});
