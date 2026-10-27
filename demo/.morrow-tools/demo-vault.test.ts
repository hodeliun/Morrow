import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../../src/core/commands';
import {
  bindPageFormulaReferences,
  documentFormulaResult,
  groupRows,
  rowsOf,
  valueOf,
  visibleRows,
} from '../../src/core/database';
import { parseRichCanvas, readAttachmentValue } from '../../src/core/propertyMedia';
import { planTableAction } from '../../src/core/tableActions';
import { loadVault } from '../../src/core/vault/load';
import type { ScannedFile, VaultScan } from '../../src/core/vault/load';
import type { DocNode, PageMeta, WorkspaceState } from '../../src/core/model';

const demoRoot = resolve(fileURLToPath(new URL('../vault/', import.meta.url)));
const syntheticNow = Date.UTC(2026, 9, 26, 12);

function scanDemo(): VaultScan {
  const files: ScannedFile[] = [];
  const others: string[] = [];
  const walk = (folder: string) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.name.startsWith('.')) continue;
      const absolute = join(folder, item.name);
      const path = relative(demoRoot, absolute).replaceAll('\\', '/');
      if (item.isDirectory()) {
        walk(absolute);
      } else if (/\.(md|canvas)$/i.test(item.name)) {
        files.push({ path, text: readFileSync(absolute, 'utf8'), mtime: syntheticNow, birthtime: syntheticNow });
      } else {
        others.push(path);
      }
    }
  };
  walk(demoRoot);
  return {
    files,
    folders: [],
    others,
    registry: JSON.parse(readFileSync(join(demoRoot, '.morrow/workspace.json'), 'utf8')) as unknown,
    recent: JSON.parse(readFileSync(join(demoRoot, '.morrow/recent.json'), 'utf8')) as unknown,
  };
}

function findByTitle(pages: Readonly<Record<string, PageMeta>>, title: string): PageMeta {
  const page = Object.values(pages).find((candidate) => candidate.title === title);
  if (!page) throw new Error(`Demo page not found: ${title}`);
  return page;
}

function descendants(node: DocNode | undefined, type: string): DocNode[] {
  if (!node) return [];
  return [
    ...(node.type === type ? [node] : []),
    ...(node.content ?? []).flatMap((child) => descendants(child, type)),
  ];
}

function loadedDemo() {
  let generatedId = 0;
  const loaded = loadVault(scanDemo(), () => `generated-${++generatedId}`, syntheticNow);
  return {
    ...loaded,
    state: { pages: Object.fromEntries(loaded.pages.map((page) => [page.id, page])), docs: loaded.docs } satisfies WorkspaceState,
  };
}

describe('synthetic demo vault', () => {
  it('loads the local files without unreadable pages or migration diagnostics', () => {
    const loaded = loadedDemo();
    expect(loaded.unreadable).toEqual([]);
    expect(loaded.problems).toEqual([]);
    expect(loaded.registryChanged).toBe(false);
    expect(Object.keys(loaded.state.docs).length).toBeGreaterThan(20);
    expect(scanDemo().others).toContain('attachments/asha-cover.svg');
  });

  it('keeps Asha editable, with child pages and two independent linked views of one source', () => {
    const { state } = loadedDemo();
    const asha = findByTitle(state.pages, 'Asha — demonstração');
    const mystic = findByTitle(state.pages, 'Místico');
    const relics = findByTitle(state.pages, 'Artefatos');
    expect(mystic.parentId).toBe(asha.id);
    expect(relics.parentId).toBe(asha.id);
    expect(asha.icon).toContain('morrow-icon:file:');
    expect(asha.cover).toBe('attachments/asha-cover.svg');

    const columns = descendants(state.docs[asha.id], 'columns');
    expect(columns).toHaveLength(1);
    expect(columns[0]?.content).toHaveLength(3);
    const linked = [
      ...descendants(state.docs[asha.id], 'linkedDatabaseView'),
      ...descendants(state.docs[findByTitle(state.pages, 'Ateliê de Asha').id], 'linkedDatabaseView'),
    ];
    expect(linked).toHaveLength(2);
    expect(new Set(linked.map((node) => node.attrs?.blockId)).size).toBe(2);
    expect(linked.map((node) => node.attrs?.sourceDatabaseId)).toEqual(['artifact-table', 'artifact-table']);

    const artifacts = findByTitle(state.pages, 'Artefatos de demonstração');
    const sourceRows = rowsOf(state, artifacts.id);
    const activeView = linked[0]?.attrs?.view;
    const allView = linked[1]?.attrs?.view;
    expect(activeView).toBeTruthy();
    expect(allView).toBeTruthy();
    expect(visibleRows(sourceRows, activeView as never, artifacts.database!, state).map((row) => row.title)).toEqual([
      'Anel de Vidro',
    ]);
    expect(visibleRows(sourceRows, allView as never, artifacts.database!, state)).toHaveLength(2);
  });

  it('projects the artifact relation live and reuses one local image in multiple records and a rich cell', () => {
    const { state } = loadedDemo();
    const artifacts = findByTitle(state.pages, 'Artefatos de demonstração');
    const resources = findByTitle(state.pages, 'Recursos de demonstração');
    const ring = findByTitle(state.pages, 'Anel de Vidro');
    const resource = findByTitle(state.pages, 'Mana de Asha');
    const resourceDb = resources.database!;
    expect(resource.properties['resource-artifact']).toBe(ring.id);
    expect(valueOf(resource, 'resource-projected-cost', resourceDb, state)).toBe(3);

    const changed = applyCommand(state, {
      type: 'page.setProperties',
      id: ring.id,
      values: { 'artifact-cost': 4 },
      now: syntheticNow + 1,
    });
    expect(changed.ok).toBe(true);
    if (changed.ok) {
      const nextResource = changed.value.state.pages[resource.id]!;
      const nextDb = changed.value.state.pages[resources.id]!.database!;
      expect(valueOf(nextResource, 'resource-projected-cost', nextDb, changed.value.state)).toBe(4);
    }

    const rows = rowsOf(state, artifacts.id);
    const imageValues = rows.map((row) => row.properties['artifact-image']);
    const sharedImages = imageValues.map((value) => readAttachmentValue(value)?.[0]?.id);
    expect(sharedImages).toEqual(['attachments/constellation.svg', 'attachments/constellation.svg']);
    expect(scanDemo().others).toContain(sharedImages[0]);
    const notes = parseRichCanvas(rows[0]?.properties['artifact-notes']);
    expect(notes).toBeTruthy();
    expect(descendants(notes ?? undefined, 'bulletList')).toHaveLength(1);
    expect(descendants(notes ?? undefined, 'image')).toHaveLength(1);
    expect(descendants(notes ?? undefined, 'text').some((node) => node.marks?.some((mark) => mark.type === 'link'))).toBe(true);

    const expenses = findByTitle(state.pages, 'Despesas de demonstração');
    const expenseRows = rowsOf(state, expenses.id);
    expect(
      expenseRows.slice(0, 2).map((row) => readAttachmentValue(row.properties['expense-receipt'])?.[0]?.id),
    ).toEqual(['attachments/aurora-receipt.svg', 'attachments/aurora-receipt.svg']);
  });

  it('shows entertainment defaults, ordered groups, independent filtering and calculated progress', () => {
    const { state } = loadedDemo();
    const databasePage = findByTitle(state.pages, 'Entretenimento de demonstração');
    const database = databasePage.database!;
    const rows = rowsOf(state, databasePage.id);
    const progress = rows.map((row) => valueOf(row, 'media-progress', database, state));
    expect(progress).toEqual([0.25, 0, 1]);
    expect(valueOf(rows[1]!, 'media-rating', database, state)).toBeNull();
    expect(valueOf(rows[2]!, 'media-rating', database, state)).toBe(5);
    expect(database.properties.find((prop) => prop.id === 'media-status')?.options.map((item) => item.name)).toEqual([
      'Planejado',
      'Em andamento',
      'Concluído',
    ]);
    expect(database.properties.find((prop) => prop.id === 'media-favorite')).toMatchObject({
      fillMode: 'default',
      defaultValue: false,
    });
    expect(database.properties.find((prop) => prop.id === 'media-status')).toMatchObject({
      fillMode: 'default',
      defaultValue: 'planned-option',
    });

    const gallery = database.views.find((item) => item.id === 'media-gallery')!;
    const board = database.views.find((item) => item.id === 'media-board')!;
    const filteredTable = database.views.find((item) => item.id === 'media-anime')!;
    expect(groupRows(rows, gallery.groupBy, database, state).map((group) => group.label)).toEqual([
      'No status',
      'Planejado',
      'Em andamento',
      'Concluído',
    ]);
    expect(groupRows(rows, gallery.groupBy, database, state)[0]?.rows).toEqual([]);
    expect(groupRows(rows, board.groupBy, database, state).map((group) => group.label)).toEqual([
      'No status',
      'Planejado',
      'Em andamento',
      'Concluído',
    ]);
    expect(groupRows(rows, board.groupBy, database, state)[0]?.rows).toEqual([]);
    expect(visibleRows(rows, filteredTable, database, state).map((row) => row.title)).toEqual([
      'Jardim das Nuvens',
    ]);
  });

  it('updates BRL monthly totals from controls and previews exact installments across the year boundary', () => {
    const { state } = loadedDemo();
    const finance = findByTitle(state.pages, 'Painel financeiro');
    const expenses = findByTitle(state.pages, 'Despesas de demonstração');
    const expenseRows = rowsOf(state, expenses.id);
    const financeViewNode = descendants(state.docs[finance.id], 'linkedDatabaseView')[0]!;
    const financeView = financeViewNode.attrs?.view as NonNullable<typeof expenses.database>['views'][number];
    const monthlyFilter = financeView.filters[0]!;
    expect(monthlyFilter.formulaBindings).toEqual(
      bindPageFormulaReferences(monthlyFilter.formula!, finance.id, state, expenses.id),
    );
    const results = descendants(state.docs[finance.id], 'calculatedResult');
    for (const result of results) {
      expect(result.attrs?.bindings).toEqual(
        bindPageFormulaReferences(String(result.attrs?.formula ?? ''), finance.id, state, expenses.id),
      );
    }
    const initialRows = visibleRows(expenseRows, financeView, expenses.database!, state);
    expect(initialRows.map((row) => row.title)).toEqual(['Livro demonstrativo', 'Ingresso demonstrativo']);

    const formulaValue = (resultId: string, currentState: WorkspaceState) => {
      const result = results.find((node) => node.attrs?.resultId === resultId)!;
      return documentFormulaResult(
        finance.id,
        resultId,
        String(result.attrs?.formula ?? ''),
        Array.isArray(result.attrs?.bindings) ? result.attrs.bindings as never : [],
        currentState,
      );
    };
    expect(formulaValue('monthly-total', state)).toEqual({ value: 100, error: null });
    expect(formulaValue('pending-total', state)).toEqual({ value: 60, error: null });
    expect(formulaValue('annual-total', state)).toEqual({ value: 100, error: null });
    const invoicePage = findByTitle(state.pages, 'Faturas de demonstração');
    const invoiceRows = rowsOf(state, invoicePage.id);
    expect(invoiceRows.map((row) => valueOf(row, 'invoice-total', invoicePage.database!, state))).toEqual([100, 25]);
    expect(expenseRows.map((row) => valueOf(row, 'expense-bank-label', expenses.database!, state))).toEqual([
      'Banco Aurora',
      'Banco Aurora',
      'Banco Aurora',
    ]);
    expect(finance.controls.map((control) => control.value)).toEqual([2026, 12]);
    expect(expenses.database?.properties.find((prop) => prop.id === 'expense-amount')?.format).toMatchObject({
      locale: 'pt-BR',
      currency: 'BRL',
      precision: 2,
    });

    let changed = applyCommand(state, {
      type: 'page.control.setValue',
      id: finance.id,
      controlId: 'year-control',
      value: 2027,
      now: syntheticNow + 2,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    changed = applyCommand(changed.value.state, {
      type: 'page.control.setValue',
      id: finance.id,
      controlId: 'month-control',
      value: 1,
      now: syntheticNow + 3,
    });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(visibleRows(expenseRows, financeView, expenses.database!, changed.value.state).map((row) => row.title)).toEqual([
      'Renovação demonstrativa',
    ]);
    expect(formulaValue('monthly-total', changed.value.state)).toEqual({ value: 25, error: null });

    const planner = findByTitle(state.pages, 'Planejador de parcelas');
    const purchase = findByTitle(state.pages, 'Compra demonstrativa');
    const planned = planTableAction(
      state,
      planner.id,
      purchase.id,
      'installment-button',
      (() => { let next = 0; return () => `demo-installment-${++next}`; })(),
      syntheticNow + 4,
    );
    expect(planned.ok).toBe(true);
    if (planned.ok) {
      const rows = planned.value.steps[0]?.rows ?? [];
      expect(rows.map((row) => row.properties['installment-date'])).toEqual([
        '2026-12-05',
        '2027-01-05',
        '2027-02-05',
      ]);
      expect(rows.map((row) => row.properties['installment-amount'])).toEqual([33.34, 33.33, 33.33]);
      expect(rows.reduce((sum, row) => sum + Math.round(Number(row.properties['installment-amount']) * 100), 0)).toBe(10000);
    }
  });
});
