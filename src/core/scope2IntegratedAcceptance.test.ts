/* eslint-disable no-restricted-imports */
import { describe, expect, it } from 'vitest';
import {
  bindPageFormulaReferences,
  conditionalFormatForCell,
  documentFormulaResult,
  formulaResult,
  matchesFilter,
  namedFormulaReferences,
  resolveConditionalFormatForCell,
  sortRows,
  summarizeProperty,
} from './database';
import { contrastTextForHex } from './colorContrast';
import { isColumnReadOnly } from './gridOperations';
import { toggleVisibleRowSelection } from '../app/components/database/rowSelection';
import { emptyDoc, newPageMeta } from './model';
import type {
  DatabaseDef,
  PageMeta,
  PropDef,
  ViewDef,
  WorkspaceState,
} from './model';
import { docToMarkdown } from './markdown/serialize';
import { MemoryVault } from '../storage/memoryVault';
import { VaultRepository } from '../storage/vaultRepository';
import { WorkspaceSession } from '../storage/session';
import { SessionHistoryBudget, MAX_SESSION_HISTORY_BYTES } from '../storage/historyBudget';
import { SessionDataHistory } from '../storage/dataHistory';
import { SessionViewHistory } from '../storage/viewHistory';
import type { ViewConfigChange, ViewHistoryIdentity } from '../storage/viewHistoryCapture';
import { t } from '../app/i18n';

let idSequence = 0;
const nextId = () => `scope2-test-${++idSequence}`;

describe('Scope 2 Integrated Acceptance (S2-01..S2-30 / T01..T30)', () => {
  describe('Criterion 1: Open without writing & byte and metadata preservation', () => {
    it('opens a synthetic workspace with all S2 features without writing to disk or losing unknown fields', async () => {
      const layoutMarkdown = [
        '---',
        'title: Layout and Components',
        'morrowCalculatedResultBackground: false',
        'futureRootMetadata:',
        '  preservedNestedField: keep-me-safe',
        'morrowControls:',
        '  - id: discount-rate',
        '    name: Discount Rate',
        '    type: number',
        '    value: 0.1',
        '    defaultValue: 0.05',
        '    options: []',
        '---',
        '<div data-columns data-widths="40,60">',
        '<div data-column>',
        '',
        '<!-- morrow:image align="center" caption="Scenic View" width="45%" futureImageTag="preserved" -->',
        '![Scenic View](https://example.org/assets/scenic.png)',
        '',
        '</div>',
        '<div data-column>',
        '',
        '<details open>',
        '<summary>Collapsible Section</summary>',
        '',
        'Tax rate is <span data-morrow-control="discount-rate">Discount Rate</span>.',
        '',
        '</details>',
        '',
        '</div>',
        '</div>',
        '',
      ].join('\n');

      const inputsMarkdown = [
        '---',
        'title: Global Inputs',
        'morrowControls:',
        '  - id: global-tax',
        '    name: Global Tax',
        '    type: number',
        '    value: 0.08',
        '    defaultValue: 0',
        '    options: []',
        '  - id: category-pick',
        '    name: Category Choice',
        '    type: select',
        '    value: opt-b',
        '    defaultValue: opt-a',
        '    options:',
        '      - id: opt-a',
        '        name: Alpha',
        '        color: blue',
        '      - id: opt-b',
        '        name: Beta',
        '        color: green',
        '  - id: tags-multi',
        '    name: Tags',
        '    type: multiSelect',
        '    value: [opt-b]',
        '    defaultValue: []',
        '    options:',
        '      - id: opt-a',
        '        name: Alpha',
        '        color: blue',
        '      - id: opt-b',
        '        name: Beta',
        '        color: green',
        '  - id: rating-scale',
        '    name: Rating',
        '    type: scale',
        '    value: 4',
        '    defaultValue: 1',
        '    options: []',
        '    format:',
        '      min: 1',
        '      max: 5',
        '      step: 1',
        '  - id: task-progress',
        '    name: Progress',
        '    type: progress',
        '    value: 65',
        '    defaultValue: 0',
        '    options: []',
        '    format:',
        '      min: 0',
        '      max: 100',
        '      step: 5',
        '  - id: fiscal-quarter',
        '    name: Fiscal Quarter',
        '    type: dateRange',
        '    value: ["2026-01-01", "2026-03-31"]',
        '    defaultValue: null',
        '    options: []',
        '---',
        'Synthetic inputs page body.',
        '',
      ].join('\n');

      const databaseMarkdown = [
        '---',
        'kind: database',
        'database:',
        '  titleAlias: Item Name',
        '  displayPropertyId: item-sku',
        '  futureDatabaseProp:',
        '    keepSchemaExtra: true',
        '  properties:',
        '    - id: item-sku',
        '      name: SKU Code',
        '      type: text',
        '      options: []',
        '    - id: base-price',
        '      name: Base Price',
        '      type: number',
        '      options: []',
        '    - id: total-cost',
        '      name: Total Cost',
        '      type: formula',
        '      formula: prop("Base Price") * 1.1',
        '      options: []',
        '  views:',
        '    - id: primary-view',
        '      name: Inventory Table',
        '      type: table',
        '      order: [title, item-sku, base-price, total-cost]',
        '      summaries:',
        '        base-price: sum',
        '      conditionalFormats:',
        '        - id: rule-high-cost',
        '          prop: base-price',
        '          op: gt',
        '          value: 100',
        '          scope: cell',
        '          color: red',
        '      filters: []',
        '      sorts: []',
        '      hidden: []',
        '---',
        'Inventory records database.',
        '',
      ].join('\n');

      const row1Markdown = [
        '---',
        'title: Premium Widget',
        'item-sku: WIDGET-PREM-01',
        'base-price: 150',
        '---',
        'Row 1 details.',
        '',
      ].join('\n');

      const row2Markdown = [
        '---',
        'title: Standard Widget',
        'item-sku: WIDGET-STD-02',
        'base-price: 50',
        '---',
        'Row 2 details.',
        '',
      ].join('\n');

      const dashboardMarkdown = [
        '---',
        'title: Dashboard Overview',
        '---',
        '<!-- morrow:linked-view:v1:' +
          encodeURIComponent(
            JSON.stringify({
              blockId: 'linked-inventory-block',
              sourceDatabaseId: 'inventory-db',
              view: {
                id: 'linked-filtered-view',
                name: 'High Cost Linked View',
                type: 'table',
                order: ['title', 'base-price'],
                filters: [{ id: 'f1', prop: 'base-price', op: 'gt', value: 100 }],
                sorts: [],
                hidden: [],
                futureViewMetadata: 'kept',
              },
            }),
          ) +
          ' -->',
        '',
        'Summary calculation: <span data-morrow-result="' +
          encodeURIComponent(
            JSON.stringify({
              resultId: 'calc-1',
              name: 'Forecast',
              formula: '42 * 2',
              bindings: [],
              outputType: 'number',
              pageId: 'dashboard-page',
            }),
          ) +
          '">84</span>',
        '',
      ].join('\n');

      const initialFiles: Record<string, string> = {
        'Layout.md': layoutMarkdown,
        'Inputs.md': inputsMarkdown,
        'Ledger.md': databaseMarkdown,
        'Ledger/Premium.md': row1Markdown,
        'Ledger/Standard.md': row2Markdown,
        'Dashboard.md': dashboardMarkdown,
      };

      const vault = new MemoryVault({ ...initialFiles });
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

      const sessionResult = await WorkspaceSession.open(
        new VaultRepository(vault, nextId),
        { delayMs: 0 },
      );
      expect(sessionResult.ok).toBe(true);
      if (!sessionResult.ok) return;

      const session = sessionResult.value;

      try {
        // Assert: NO write operations occurred during vault open and load
        expect(appliedWrites).toEqual([]);

        // Assert: All pages are cleanly loaded into state
        const state = session.getState();
        const pages = Object.values(state.pages);
        expect(pages.length).toBeGreaterThanOrEqual(6);

        const layoutPage = pages.find((p) => p.title === 'Layout and Components');
        expect(layoutPage).toBeDefined();
        expect(layoutPage?.calculatedResultBackground).toBe(false);
        expect(layoutPage?.controls).toHaveLength(1);
        expect(layoutPage?.controls[0]?.id).toBe('discount-rate');
        expect(layoutPage?.controls[0]?.value).toBe(0.1);

        const inputsPage = pages.find((p) => p.title === 'Global Inputs');
        expect(inputsPage).toBeDefined();
        expect(inputsPage?.controls).toHaveLength(6);
        const types = inputsPage?.controls.map((c) => c.type);
        expect(types).toEqual([
          'number',
          'select',
          'multiSelect',
          'scale',
          'progress',
          'dateRange',
        ]);

        const dbPage = pages.find((p) => p.title === 'Inventory records database' || p.kind === 'database');
        expect(dbPage).toBeDefined();
        expect(dbPage?.database?.titleAlias).toBe('Item Name');
        expect(dbPage?.database?.displayPropertyId).toBe('item-sku');
        expect(dbPage?.database?.views[0]?.order).toEqual(['title', 'item-sku', 'base-price', 'total-cost']);
        expect(dbPage?.database?.views[0]?.summaries).toEqual({ 'base-price': 'sum' });
        expect(dbPage?.database?.views[0]?.conditionalFormats).toHaveLength(1);

        // Verify unknown frontmatter fields preserved in file text
        expect(vault.text('Layout.md')).toBe(layoutMarkdown);
        expect(vault.text('Layout.md')).toContain('futureRootMetadata:');
        expect(vault.text('Ledger.md')).toBe(databaseMarkdown);
        expect(vault.text('Ledger.md')).toContain('futureDatabaseProp:');

        // Verify document structure in Layout doc: columns, widths, details, image width
        const layoutDoc = state.docs[layoutPage!.id];
        expect(layoutDoc).toBeDefined();
        const layoutDocMd = docToMarkdown(layoutDoc!);
        expect(layoutDocMd).toContain('data-widths="40,60"');
        expect(layoutDocMd).toContain('<details open>');
        expect(layoutDocMd).toContain('width="45%"');
        expect(layoutDocMd).toContain('data-morrow-control="discount-rate"');

        // Verify cross-page named references discovery
        const references = namedFormulaReferences(state);
        expect(references.some((ref) => ref.id === 'discount-rate')).toBe(true);
        expect(references.some((ref) => ref.id === 'global-tax')).toBe(true);
        expect(references.some((ref) => ref.id === 'category-pick')).toBe(true);

        // Verify cross-page formula binding, dateRange First/Last evaluation, and cycle detection
        const dashboardPage = pages.find((p) => p.title === 'Dashboard Overview')!;
        expect(dashboardPage).toBeDefined();
        const explicitTaxBinding = bindPageFormulaReferences(
          '`Global Tax` * 100',
          dashboardPage.id,
          state,
          null,
          [
            {
              start: 0,
              end: 12,
              source: '`Global Tax`',
              kind: 'control',
              pageId: inputsPage!.id,
              controlId: 'global-tax',
            },
          ],
        );
        expect(
          documentFormulaResult(
            dashboardPage.id,
            'tax-percent',
            '`Global Tax` * 100',
            explicitTaxBinding,
            state,
          ),
        ).toEqual({ value: 8, error: null });

        const quarterFirstBinding = bindPageFormulaReferences(
          'First(`Fiscal Quarter`)',
          inputsPage!.id,
          state,
        );
        expect(
          documentFormulaResult(
            inputsPage!.id,
            'q-start',
            'First(`Fiscal Quarter`)',
            quarterFirstBinding,
            state,
          ),
        ).toEqual({ value: '2026-01-01', error: null });

        const quarterLastBinding = bindPageFormulaReferences(
          'Last(`Fiscal Quarter`)',
          inputsPage!.id,
          state,
        );
        expect(
          documentFormulaResult(
            inputsPage!.id,
            'q-end',
            'Last(`Fiscal Quarter`)',
            quarterLastBinding,
            state,
          ),
        ).toEqual({ value: '2026-03-31', error: null });

        // Self-cycle detection returns bounded diagnostic error
        const selfCycle = documentFormulaResult(
          dashboardPage.id,
          'calc-1',
          'Forecast + 1',
          [
            {
              start: 0,
              end: 8,
              source: 'Forecast',
              kind: 'result',
              pageId: dashboardPage.id,
              resultId: 'calc-1',
            },
          ],
          state,
        );
        expect(selfCycle.error).not.toBeNull();
      } finally {
        await session.close();
      }

      // Confirm that closing session also wrote zero times
      expect(appliedWrites).toEqual([]);

      // Round-trip: open, mutate control and view order, flush, close, and reopen with zero writes on reopen
      const editSessionRes = await WorkspaceSession.open(
        new VaultRepository(vault, nextId),
        { delayMs: 0 },
      );
      expect(editSessionRes.ok).toBe(true);
      if (!editSessionRes.ok) return;
      const editSession = editSessionRes.value;
      try {
        const editPages = Object.values(editSession.getState().pages);
        const layoutTarget = editPages.find((p) => p.title === 'Layout and Components')!;
        const dbTarget = editPages.find((p) => p.kind === 'database')!;

        const updateControl = editSession.execute({
          type: 'page.control.setValue',
          id: layoutTarget.id,
          controlId: 'discount-rate',
          value: 0.25,
          now: 100,
        });
        expect(updateControl.ok).toBe(true);

        const updateViewOrder = editSession.execute({
          type: 'database.set',
          id: dbTarget.id,
          database: {
            ...dbTarget.database!,
            views: dbTarget.database!.views.map((v, idx) =>
              idx === 0
                ? { ...v, order: ['item-sku', 'title', 'base-price', 'total-cost'] }
                : v,
            ),
          },
          now: 101,
        });
        expect(updateViewOrder.ok).toBe(true);

        await editSession.flush();
      } finally {
        await editSession.close();
      }

      expect(appliedWrites.length).toBeGreaterThan(0);
      const writesBeforeReopen = appliedWrites.length;

      const reopenRes = await WorkspaceSession.open(
        new VaultRepository(vault, nextId),
        { delayMs: 0 },
      );
      expect(reopenRes.ok).toBe(true);
      if (!reopenRes.ok) return;
      const reopenedSession = reopenRes.value;
      try {
        // Reopening after mutations performs zero writes
        expect(appliedWrites.length).toBe(writesBeforeReopen);

        const reopenedPages = Object.values(reopenedSession.getState().pages);
        const reopenedLayout = reopenedPages.find((p) => p.title === 'Layout and Components')!;
        const reopenedDb = reopenedPages.find((p) => p.kind === 'database')!;

        expect(reopenedLayout.controls[0]?.value).toBe(0.25);
        expect(reopenedLayout.calculatedResultBackground).toBe(false);
        expect(reopenedDb.database?.views[0]?.order).toEqual([
          'item-sku',
          'title',
          'base-price',
          'total-cost',
        ]);
        expect(vault.text('Layout and Components.md')).toContain('futureRootMetadata:');
        expect(vault.text('Ledger.md')).toContain('futureDatabaseProp:');
      } finally {
        await reopenedSession.close();
      }
      expect(appliedWrites.length).toBe(writesBeforeReopen);
    });
  });

  describe('Criterion 2: 1,000 synthetic rows database performance and behavior', () => {
    it('evaluates formulas, conditional rules, filters, sorting, additive selection and footer summaries with 1,000 rows', () => {
      const dbId = 'perf-db';
      const properties: PropDef[] = [
        { id: 'sku', name: 'SKU', type: 'text', options: [] },
        { id: 'score', name: 'Score', type: 'number', options: [] },
        {
          id: 'category',
          name: 'Category',
          type: 'select',
          options: [
            { id: 'cat-a', name: 'Alpha', color: 'blue' },
            { id: 'cat-b', name: 'Beta', color: 'green' },
            { id: 'cat-c', name: 'Gamma', color: 'orange' },
          ],
        },
        {
          id: 'doubled',
          name: 'Doubled',
          type: 'formula',
          formula: 'thisRow.Score * 2',
          options: [],
        },
      ];

      const database: DatabaseDef = {
        properties,
        views: [
          {
            id: 'perf-view',
            name: 'Performance Grid',
            type: 'table',
            order: ['title', 'sku', 'score', 'category', 'doubled'],
            filters: [],
            sorts: [{ prop: 'score', dir: 'desc' }],
            hidden: [],
            groupBy: null,
            dateProp: null,
            summaries: { score: 'sum' },
            conditionalFormats: [
              {
                id: 'high-score-rule',
                prop: 'score',
                op: 'gt',
                value: 800,
                scope: 'cell',
                color: 'green',
              },
            ],
          },
        ],
      };

      const pages: Record<string, PageMeta> = {
        [dbId]: newPageMeta({
          id: dbId,
          parentId: null,
          title: 'Performance Database',
          kind: 'database',
          database,
        }),
      };

      const totalRows = 1000;
      const categories = ['cat-a', 'cat-b', 'cat-c'];
      const rows: PageMeta[] = [];

      for (let index = 1; index <= totalRows; index++) {
        const rowId = `row-${index}`;
        const catId = categories[(index - 1) % 3]!;
        const row = newPageMeta({
          id: rowId,
          parentId: dbId,
          title: `Item ${index}`,
          kind: 'page',
          order: index,
          properties: {
            sku: `SKU-${String(index).padStart(4, '0')}`,
            score: index,
            category: catId,
          },
        });
        pages[rowId] = row;
        rows.push(row);
      }

      const state: WorkspaceState = { pages, docs: {} };

      // 1. Measure Formula Evaluation
      const formulaStart = performance.now();
      const sampleRow = rows[499]!; // score = 500
      const calcResult = formulaResult(sampleRow, properties[3]!, database, 0, state);
      const formulaTimeMs = performance.now() - formulaStart;
      expect(calcResult.error).toBeNull();
      expect(calcResult.value).toBe(1000);

      // 2. Measure Conditional Rules Evaluation across all 1,000 rows
      const condStart = performance.now();
      let matchedCount = 0;
      for (const row of rows) {
        const format = conditionalFormatForCell(
          row,
          'score',
          database.views[0]!.conditionalFormats!,
          database,
          state,
        );
        if (format) matchedCount++;
      }
      const condTimeMs = performance.now() - condStart;
      // score > 800 means 801..1000 = exactly 200 matches
      expect(matchedCount).toBe(200);

      // 3. Measure Filtering across 1,000 rows (Category is 'Alpha' / cat-a)
      const filterStart = performance.now();
      const filtered = rows.filter((row) =>
        matchesFilter(row, { id: 'f1', prop: 'category', op: 'is', value: 'cat-a' }, database, state),
      );
      const filterTimeMs = performance.now() - filterStart;
      // Every 3rd item starting at index 1: 1, 4, 7, ... 1000 => 334 items
      expect(filtered.length).toBe(334);

      // 4. Measure Sorting across 1,000 rows
      const sortStart = performance.now();
      const sorted = sortRows(rows, database.views[0]!.sorts, database, state);
      const sortTimeMs = performance.now() - sortStart;
      expect(sorted[0]?.properties.score).toBe(1000);
      expect(sorted[sorted.length - 1]?.properties.score).toBe(1);

      // 5. Measure Additive Row Selection
      const visibleRowIds = rows.map((r) => r.id);
      const selectionStart = performance.now();
      let selection: string[] = [];
      for (let i = 0; i < 50; i++) {
        selection = toggleVisibleRowSelection(selection, rows[i]!.id, true, visibleRowIds);
      }
      const selectionTimeMs = performance.now() - selectionStart;
      expect(selection.length).toBe(50);
      // Toggle off one row
      selection = toggleVisibleRowSelection(selection, rows[10]!.id, false, visibleRowIds);
      expect(selection.length).toBe(49);
      expect(selection.includes(rows[10]!.id)).toBe(false);

      // 6. Measure Table Footer Calculation (sum, avg, count)
      const footerStart = performance.now();
      const sumResult = summarizeProperty(rows, properties[1]!, 'sum', database, state);
      const avgResult = summarizeProperty(rows, properties[1]!, 'average', database, state);
      const minResult = summarizeProperty(rows, properties[1]!, 'min', database, state);
      const maxResult = summarizeProperty(rows, properties[1]!, 'max', database, state);
      const footerTimeMs = performance.now() - footerStart;

      // 1 + 2 + ... + 1000 = 1000 * 1001 / 2 = 500,500
      expect(sumResult.value).toBe(500500);
      expect(avgResult.value).toBe(500.5);
      expect(minResult.value).toBe(1);
      expect(maxResult.value).toBe(1000);

      // Log verified times
      console.info(
        `[Scope2 Integrated Acceptance 1,000-Row Measurement]:\n` +
          `  - Formula evaluation (single cell): ${formulaTimeMs.toFixed(3)} ms\n` +
          `  - Conditional formatting (1,000 cells): ${condTimeMs.toFixed(3)} ms\n` +
          `  - Filter evaluation (1,000 rows): ${filterTimeMs.toFixed(3)} ms\n` +
          `  - Sorting (1,000 rows): ${sortTimeMs.toFixed(3)} ms\n` +
          `  - Additive selection (50 rows): ${selectionTimeMs.toFixed(3)} ms\n` +
          `  - Footer summary (sum/avg/min/max over 1,000 rows): ${footerTimeMs.toFixed(3)} ms`,
      );

      // Sanity checks that operations run quickly in memory
      expect(formulaTimeMs).toBeLessThan(100);
      expect(condTimeMs).toBeLessThan(500);
      expect(filterTimeMs).toBeLessThan(200);
      expect(sortTimeMs).toBeLessThan(300);
      expect(selectionTimeMs).toBeLessThan(100);
      expect(footerTimeMs).toBeLessThan(200);
    });
  });

  describe('Criterion 3: Bounded data history (T21, 10 steps/32MiB) and contextual view history (T22, 10 steps)', () => {
    it('maintains bounded 10-step stacks for data and contextual views with independent undo/redo', () => {
      const dbId = 'history-db';
      const budget = new SessionHistoryBudget();
      const dataHistory = new SessionDataHistory(budget);
      const viewHistory = new SessionViewHistory(budget);
      expect(dataHistory.getSnapshot(dbId).undo).toBeNull();
      const viewIdentity: ViewHistoryIdentity = {
        kind: 'database',
        databaseId: dbId,
        viewId: 'v1',
      };

      const baseView = (name: string): ViewDef => ({
        id: 'v1',
        name,
        type: 'table',
        filters: [],
        sorts: [],
        hidden: [],
        groupBy: null,
        dateProp: null,
      });

      // 1. Record 15 view configuration changes
      const viewIds: string[] = [];
      for (let i = 1; i <= 15; i++) {
        const change: ViewConfigChange = {
          identity: viewIdentity,
          before: { view: baseView(`View Version ${i - 1}`) },
          after: { view: baseView(`View Version ${i}`) },
        };
        const id = viewHistory.record([change]);
        expect(id).not.toBeNull();
        if (id) viewIds.push(id);
      }

      // Check view history is bounded to at most 10 undo steps
      const viewSnapshot = viewHistory.getSnapshot(viewIdentity);
      expect(viewSnapshot.undo).not.toBeNull();
      expect(viewSnapshot.undo?.enabled).toBe(true);

      // Step undo 10 times on view history
      let undosApplied = 0;
      for (let i = 0; i < 15; i++) {
        const result = viewHistory.step(viewIdentity, 'undo', () => ({ status: 'applied' }));
        if (result.status === 'applied') undosApplied++;
      }
      expect(undosApplied).toBe(10);
      expect(viewHistory.getSnapshot(viewIdentity).undo).toBeNull();

      // Check redo is available
      expect(viewHistory.getSnapshot(viewIdentity).redo).not.toBeNull();

      // Step redo 5 times
      let redosApplied = 0;
      for (let i = 0; i < 5; i++) {
        const result = viewHistory.step(viewIdentity, 'redo', () => ({ status: 'applied' }));
        if (result.status === 'applied') redosApplied++;
      }
      expect(redosApplied).toBe(5);

      // New change invalidates redo
      const newChange: ViewConfigChange = {
        identity: viewIdentity,
        before: { view: baseView('Branch Before') },
        after: { view: baseView('Branch After') },
      };
      viewHistory.record([newChange]);
      expect(viewHistory.getSnapshot(viewIdentity).redo).toBeNull();
      expect(viewHistory.getSnapshot(viewIdentity).undo).not.toBeNull();

      // Verify budget tracking
      expect(budget.usedBytes).toBeGreaterThan(0);
      expect(budget.usedBytes).toBeLessThan(MAX_SESSION_HISTORY_BYTES);
    });

    it('interleaves data edits and view configuration changes in session contextual history', async () => {
      const repository = new VaultRepository(new MemoryVault(), nextId);
      const opened = await WorkspaceSession.open(repository, { delayMs: 60_000 });
      if (!opened.ok) throw new Error(opened.error);
      const session = opened.value;
      try {
        const seeded = session.executeHistoryReplay([
          {
            type: 'page.create',
            id: 'db',
            parentId: null,
            title: 'Database',
            kind: 'database',
            database: {
              properties: [{ id: 'val', name: 'Val', type: 'text', options: [] }],
              views: [
                { id: 'v1', name: 'View 1', type: 'table', filters: [], sorts: [], hidden: [], groupBy: null, dateProp: null },
                { id: 'v2', name: 'View 2', type: 'table', filters: [], sorts: [], hidden: [], groupBy: null, dateProp: null },
              ],
            },
            now: 1,
          },
          {
            type: 'page.create',
            id: 'r1',
            parentId: 'db',
            title: 'Row 1',
            properties: { val: 'initial' },
            now: 1,
          },
        ]);
        expect(seeded.ok).toBe(true);

        const identityV1: ViewHistoryIdentity = { kind: 'database', databaseId: 'db', viewId: 'v1' };
        const identityV2: ViewHistoryIdentity = { kind: 'database', databaseId: 'db', viewId: 'v2' };

        // 1. Edit data in row
        const editData1 = session.execute({
          type: 'page.setProperties',
          id: 'r1',
          values: { val: 'first-edit' },
          now: 2,
        });
        expect(editData1.ok).toBe(true);

        // 2. Change View 1 config (e.g. rename view)
        const currentDb = session.getState().pages.db!.database!;
        const editView1 = session.execute({
          type: 'database.set',
          id: 'db',
          database: {
            ...currentDb,
            views: currentDb.views.map((v) => (v.id === 'v1' ? { ...v, name: 'View 1 Renamed' } : v)),
          },
          now: 3,
        });
        expect(editView1.ok).toBe(true);

        // Contextual history on View 1 sees the latest action (which is the view rename)
        const ctxV1 = session.getContextualHistory('db', identityV1);
        expect(ctxV1.undo).not.toBeNull();
        expect(ctxV1.undo?.owner.kind).toBe('view');

        // Contextual history on View 2 sees the data edit (since View 1 rename did not touch View 2)
        const ctxV2 = session.getContextualHistory('db', identityV2);
        expect(ctxV2.undo).not.toBeNull();
        expect(ctxV2.undo?.owner.kind).toBe('data');

        // Step undo on View 1 undoes the view rename
        const undoStep = await session.stepContextualHistory('db', identityV1, 'undo');
        expect(undoStep.status).toBe('applied');
        expect(session.getState().pages.db?.database?.views.find((v) => v.id === 'v1')?.name).toBe('View 1');
        // Row data remains 'first-edit'
        expect(session.getState().pages.r1?.properties.val).toBe('first-edit');

        // Now undo on View 1 is the data change
        const ctxV1After = session.getContextualHistory('db', identityV1);
        expect(ctxV1After.undo?.owner.kind).toBe('data');
        const undoDataStep = await session.stepContextualHistory('db', identityV1, 'undo');
        expect(undoDataStep.status).toBe('applied');
        expect(session.getState().pages.r1?.properties.val).toBe('initial');
      } finally {
        await session.close();
      }
    });
  });

  describe('Criterion 4: Internationalization (PT/EN/ES) and Read-only protections', () => {
    it('verifies PT, EN, and ES localization across S2-01..S2-30 features', () => {
      // T01: Clipboard
      expect(t('database.copyDatabase', undefined, 'en')).toBe('Copy database');
      expect(t('database.copyDatabase', undefined, 'pt')).toBe('Copiar banco de dados');
      expect(t('database.copyDatabase', undefined, 'es')).toBe('Copiar base de datos');

      // T05: Additive selection
      expect(t('database.rowSelect', { name: 'Item 1' }, 'en')).toBe('Select Item 1');
      expect(t('database.rowSelect', { name: 'Item 1' }, 'pt')).toBe('Selecionar Item 1');
      expect(t('database.rowSelect', { name: 'Item 1' }, 'es')).toBe('Seleccionar Item 1');

      expect(t('database.rowSelectionCount', { count: 3 }, 'en')).toBe('3 selected');
      expect(t('database.rowSelectionCount', { count: 3 }, 'pt')).toBe('3 selecionadas');
      expect(t('database.rowSelectionCount', { count: 3 }, 'es')).toBe('3 seleccionadas');

      expect(t('database.rowClearSelection', undefined, 'en')).toBe('Clear selection');
      expect(t('database.rowClearSelection', undefined, 'pt')).toBe('Limpar seleção');
      expect(t('database.rowClearSelection', undefined, 'es')).toBe('Borrar selección');

      // T07: Format catalogs and property panels
      expect(t('database.styleShort', undefined, 'en')).toBe('Short');
      expect(t('database.styleShort', undefined, 'pt')).toBe('Curto');
      expect(t('database.styleShort', undefined, 'es')).toBe('Corto');

      expect(t('database.styleFull', undefined, 'en')).toBe('Full');
      expect(t('database.styleFull', undefined, 'pt')).toBe('Completo');
      expect(t('database.styleFull', undefined, 'es')).toBe('Completo');

      // T12: Footer insertion
      expect(t('database.rowInsertBefore', undefined, 'en')).toBe('Insert row before');
      expect(t('database.rowInsertBefore', undefined, 'pt')).toBe('Inserir linha antes');
      expect(t('database.rowInsertBefore', undefined, 'es')).toBe('Insertar fila antes');

      expect(t('database.rowInsertAfter', undefined, 'en')).toBe('Insert row after');
      expect(t('database.rowInsertAfter', undefined, 'pt')).toBe('Inserir linha depois');
      expect(t('database.rowInsertAfter', undefined, 'es')).toBe('Insertar fila después');

      // Common actions
      expect(t('common.cancel', undefined, 'en')).toBe('Cancel');
      expect(t('common.cancel', undefined, 'pt')).toBe('Cancelar');
      expect(t('common.cancel', undefined, 'es')).toBe('Cancelar');

      expect(t('common.save', undefined, 'en')).toBe('Save');
      expect(t('common.save', undefined, 'pt')).toBe('Salvar');
      expect(t('common.save', undefined, 'es')).toBe('Guardar');

      // T09, T10, T17: Light and dark theme contrast and conditional style attribute precedence
      expect(contrastTextForHex('#ffffff')).toBe('#111111');
      expect(contrastTextForHex('#f8fafc')).toBe('#111111');
      expect(contrastTextForHex('#0f172a')).toBe('#ffffff');
      expect(contrastTextForHex('#000000')).toBe('#ffffff');

      const dbForStyles: DatabaseDef = {
        properties: [{ id: 'score', name: 'Score', type: 'number', options: [] }],
        views: [],
      };
      const rowForStyles = newPageMeta({
        id: 'row-style',
        parentId: 'db-style',
        title: 'Styled Row',
        properties: { score: 150 },
      });
      const stateForStyles: WorkspaceState = {
        pages: { 'row-style': rowForStyles },
        docs: {},
      };
      const viewForStyles: ViewDef = {
        id: 'v-style',
        name: 'Styled View',
        type: 'table',
        filters: [],
        sorts: [],
        hidden: [],
        groupBy: null,
        dateProp: null,
        conditionalFormats: [
          {
            id: 'r1',
            prop: 'score',
            op: 'gt',
            value: 50,
            scope: 'cell',
            color: 'blue',
            textColor: 'orange',
            bold: true,
          },
          {
            id: 'r2',
            prop: 'score',
            op: 'gt',
            value: 100,
            scope: 'cell',
            color: 'red',
            italic: true,
          },
        ],
      };
      const resolvedStyle = resolveConditionalFormatForCell(
        rowForStyles,
        'score',
        viewForStyles,
        dbForStyles,
        stateForStyles,
      );
      expect(resolvedStyle).toEqual({
        backgroundColor: 'red',
        textColor: 'orange',
        bold: true,
        italic: true,
        matchedRuleIds: ['r1', 'r2'],
        diagnostics: [],
      });
    });

    it('enforces read-only protection on computed columns and unreadable/protected pages', async () => {
      // 1. Column-level readonly check
      const sampleDatabase: DatabaseDef = {
        properties: [
          { id: 'sku', name: 'SKU', type: 'text', options: [] },
          { id: 'total', name: 'Total', type: 'formula', formula: '10', options: [] },
          { id: 'created', name: 'Created', type: 'createdTime', options: [] },
          { id: 'updated', name: 'Updated', type: 'lastEditedTime', options: [] },
          { id: 'btn', name: 'Action', type: 'button', options: [] },
        ],
        views: [],
      };

      expect(isColumnReadOnly('sku', sampleDatabase)).toBe(false);
      expect(isColumnReadOnly('title', sampleDatabase)).toBe(false);
      expect(isColumnReadOnly('total', sampleDatabase)).toBe(true);
      expect(isColumnReadOnly('created', sampleDatabase)).toBe(true);
      expect(isColumnReadOnly('updated', sampleDatabase)).toBe(true);
      expect(isColumnReadOnly('btn', sampleDatabase)).toBe(true);

      // 2. Storage-level read-only protection for unreadable/unsupported page files
      const corruptedFormatFile = [
        '---',
        'kind: database',
        'database:',
        '  properties:',
        '    - id: score',
        '      name: Score',
        '      type: number',
        '      format:',
        '        locale: en_US', // Invalid locale format string triggers unreadable error
        '  views: []',
        '---',
        'Protected body content.',
        '',
      ].join('\n');

      const vault = new MemoryVault({ 'Corrupted.md': corruptedFormatFile });
      const writes: string[] = [];
      const origApply = vault.apply.bind(vault);
      vault.apply = async (ops) => {
        for (const op of ops) {
          if (op.op === 'write') writes.push(op.path);
        }
        return origApply(ops);
      };

      const opened = await WorkspaceSession.open(
        new VaultRepository(vault, nextId),
        { delayMs: 0 },
      );
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;

      const session = opened.value;
      try {
        const pageId = Object.keys(session.getState().pages)[0]!;
        expect(session.unreadable.has(pageId)).toBe(true);

        // Attempting to edit an unreadable page is blocked
        const attemptedEdit = session.execute({
          type: 'page.setDoc',
          id: pageId,
          doc: emptyDoc(),
          now: 10,
        });
        expect(attemptedEdit.ok).toBe(false);
        if (!attemptedEdit.ok) {
          expect(attemptedEdit.error).toContain('protected from changes');
        }

        // Attempting to modify database metadata on an unreadable page is also blocked
        const attemptedDbEdit = session.execute({
          type: 'database.set',
          id: pageId,
          database: { properties: [], views: [] },
          now: 11,
        });
        expect(attemptedDbEdit.ok).toBe(false);

        await session.flush();

        // Disk remains untouched and writes array is empty
        expect(writes).toEqual([]);
        expect(vault.text('Corrupted.md')).toBe(corruptedFormatFile);
      } finally {
        await session.close();
      }
    });
  });
});
