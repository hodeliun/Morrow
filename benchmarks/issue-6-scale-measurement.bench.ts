import { cpus, release } from 'node:os';
import { expect, test } from 'vitest';
import { newPageMeta as importedNewPageMeta } from '../src/core/model.ts';
import type {
  bindFormulaReferences as bindFormulaReferencesType,
  valueOf as valueOfType,
  visibleRows as visibleRowsType,
} from '../src/core/database';
import type {
  DatabaseDef,
  FilterRule,
  PageMeta,
  PropDef,
  PropValue,
  ViewDef,
  WorkspaceState,
} from '../src/core/model.ts';

const createPageMeta = importedNewPageMeta;
let bindFormulaReferences: typeof bindFormulaReferencesType;
let valueOf: typeof valueOfType;
let visibleRows: typeof visibleRowsType;

const TRANSACTIONS_ID = 'synthetic-transactions';
const CATEGORIES_ID = 'synthetic-categories';
const TRANSACTION_COUNT = 1_000;
const CATEGORY_COUNT = 50;
const VIEW_A_FORMULA = 'thisRow.Status = "Paid" and thisRow.Adjusted >= 180';
const VIEW_B_FORMULA = 'thisRow.Category.Zone = "West" and thisRow.Final >= 160';
const BENCH_OPTIONS = {
  throws: true,
};
const BENCH_RUN_OPTIONS = {
  iterations: 100,
  time: 0,
  warmupIterations: 10,
  warmupTime: 0,
};

interface Scenario {
  state: WorkspaceState;
  transactions: PageMeta;
  categories: PageMeta;
  rows: PageMeta[];
  categoryRows: PageMeta[];
  viewA: ViewDef;
  viewB: ViewDef;
}

function property(id: string, name: string, type: PropDef['type'], extra: Partial<PropDef> = {}): PropDef {
  return { id, name, type, options: [], ...extra };
}

function row(id: string, parentId: string, properties: Record<string, PropValue>): PageMeta {
  return createPageMeta({ id, parentId, title: id, properties });
}

function formulaView(id: string, name: string, formula: string): ViewDef {
  const filter: FilterRule = {
    id: `${id}-filter`,
    prop: 'title',
    op: 'is',
    value: null,
    formula,
    formulaBindings: [],
  };
  return {
    id,
    name,
    type: 'table',
    filters: [filter],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
  };
}

function createScenario(transactionCount: number): Scenario {
  const categoryCount = Math.max(5, Math.min(CATEGORY_COUNT, Math.ceil(transactionCount / 20)));
  const categoryProperties = [
    property('category-name', 'Name', 'text'),
    property('category-multiplier', 'Multiplier', 'number'),
    property('category-offset', 'Offset', 'number'),
    property('category-zone', 'Zone', 'text'),
  ];
  const categorySchema: DatabaseDef = { properties: categoryProperties, views: [] };
  const categories = createPageMeta({
    id: CATEGORIES_ID,
    parentId: null,
    title: 'Synthetic categories',
    kind: 'database',
    database: categorySchema,
  });
  const categoryRows = Array.from({ length: categoryCount }, (_, index) =>
    row(`category-${String(index).padStart(2, '0')}`, CATEGORIES_ID, {
      'category-name': `Category ${index}`,
      'category-multiplier': 1 + (index % 5) * 0.25,
      'category-offset': (index % 9) * 10,
      'category-zone': ['North', 'South', 'East', 'West'][index % 4]!,
    }),
  );

  const relation = property('category', 'Category', 'relation', {
    relation: {
      targetDatabaseId: CATEGORIES_ID,
      multiple: false,
      isInverse: false,
      displayPropertyId: 'category-name',
      inversePropertyId: null,
      filters: [],
    },
  });
  const formulaProperties = [
    property('adjusted', 'Adjusted', 'formula', {
      formula: 'thisRow.Amount * thisRow.Category.Multiplier',
    }),
    property('final', 'Final', 'formula', {
      formula: 'thisRow.Adjusted + thisRow.Category.Offset',
    }),
  ];
  const transactionSchema: DatabaseDef = {
    properties: [
      property('amount', 'Amount', 'number'),
      property('status', 'Status', 'text'),
      relation,
      ...formulaProperties,
    ],
    views: [
      formulaView('paid-high-value', 'Paid high value', VIEW_A_FORMULA),
      formulaView('west-zone', 'West zone', VIEW_B_FORMULA),
    ],
  };
  let transactions = createPageMeta({
    id: TRANSACTIONS_ID,
    parentId: null,
    title: 'Synthetic transactions',
    kind: 'database',
    database: transactionSchema,
  });
  const rows = Array.from({ length: transactionCount }, (_, index) => {
    const categoryIndex = index % categoryCount;
    return row(`transaction-${String(index).padStart(4, '0')}`, TRANSACTIONS_ID, {
      amount: 50 + (index % 101),
      status: index % 4 === 0 ? 'Paid' : 'Open',
      category: categoryRows[categoryIndex]!.id,
    });
  });

  let state: WorkspaceState = {
    pages: Object.fromEntries(
      [categories, transactions, ...categoryRows, ...rows].map((page) => [page.id, page]),
    ),
    docs: {},
  };
  const properties = transactions.database!.properties.map((prop) =>
    prop.formula
      ? {
          ...prop,
          formulaBindings: bindFormulaReferences(prop.formula, TRANSACTIONS_ID, state),
        }
      : prop,
  );
  const views = transactions.database!.views.map((view) => ({
    ...view,
    filters: view.filters.map((filter) => ({
      ...filter,
      formulaBindings: bindFormulaReferences(filter.formula!, TRANSACTIONS_ID, state),
    })),
  }));
  transactions = {
    ...transactions,
    database: { ...transactions.database!, properties, views },
  };
  state = { ...state, pages: { ...state.pages, [TRANSACTIONS_ID]: transactions } };

  return {
    state,
    transactions,
    categories,
    rows,
    categoryRows,
    viewA: transactions.database!.views[0]!,
    viewB: transactions.database!.views[1]!,
  };
}

function calculateAll(scenario: Scenario, state = scenario.state): Array<[PropValue, PropValue]> {
  const database = scenario.transactions.database!;
  return scenario.rows.map((item) => [
    valueOf(item, 'adjusted', database, state),
    valueOf(item, 'final', database, state),
  ]);
}

function stateAfterCategoryEdit(scenario: Scenario): WorkspaceState {
  const category = scenario.categoryRows[0]!;
  const editedCategory = {
    ...category,
    properties: {
      ...category.properties,
      'category-multiplier': (category.properties['category-multiplier'] as number) * 2,
    },
  };
  return {
    ...scenario.state,
    pages: { ...scenario.state.pages, [editedCategory.id]: editedCategory },
  };
}

function editedViewA(scenario: Scenario): ViewDef {
  const filter = scenario.viewA.filters[0]!;
  const formula = filter.formula!.replace('>= 180', '>= 220');
  return {
    ...scenario.viewA,
    filters: [
      {
        ...filter,
        formula,
        formulaBindings: bindFormulaReferences(formula, TRANSACTIONS_ID, scenario.state),
      },
    ],
  };
}

function filteredRows(scenario: Scenario, view: ViewDef, state = scenario.state): PageMeta[] {
  return visibleRows(scenario.rows, view, scenario.transactions.database!, state);
}

test('issue #6 synthetic scale measurements', async ({ bench }) => {
  const core = await import('../node_modules/.cache/issue-6-core-benchmark/database.js');
  bindFormulaReferences = core.bindFormulaReferences;
  valueOf = core.valueOf;
  visibleRows = core.visibleRows;

  const validationScenario = createScenario(TRANSACTION_COUNT);
  const values = calculateAll(validationScenario);
  const expectedValues = validationScenario.rows.map((item) => {
    const relatedCategory = validationScenario.state.pages[item.properties.category as string]!;
    const adjusted =
      (item.properties.amount as number) * (relatedCategory.properties['category-multiplier'] as number);
    return [adjusted, adjusted + (relatedCategory.properties['category-offset'] as number)];
  });
  expect(values).toHaveLength(TRANSACTION_COUNT);
  expect(values).toEqual(expectedValues);

  const rowsA = filteredRows(validationScenario, validationScenario.viewA);
  const rowsB = filteredRows(validationScenario, validationScenario.viewB);
  const expectedRowsA = validationScenario.rows.filter(
    (item, index) => item.properties.status === 'Paid' && (values[index]![0] as number) >= 180,
  );
  const expectedRowsB = validationScenario.rows.filter((item, index) => {
    const relatedCategory = validationScenario.state.pages[item.properties.category as string]!;
    return relatedCategory.properties['category-zone'] === 'West' && (values[index]![1] as number) >= 160;
  });
  expect(rowsA.length).toBeGreaterThan(0);
  expect(rowsB.length).toBeGreaterThan(0);
  expect(rowsA.map((item) => item.id)).toEqual(expectedRowsA.map((item) => item.id));
  expect(rowsB.map((item) => item.id)).toEqual(expectedRowsB.map((item) => item.id));
  const changedRowsA = filteredRows(validationScenario, editedViewA(validationScenario));
  const expectedChangedRowsA = validationScenario.rows.filter(
    (item, index) => item.properties.status === 'Paid' && (values[index]![0] as number) >= 220,
  );
  expect(changedRowsA.map((item) => item.id)).toEqual(expectedChangedRowsA.map((item) => item.id));
  expect(filteredRows(validationScenario, validationScenario.viewB).map((item) => item.id)).toEqual(
    rowsB.map((item) => item.id),
  );

  const validationEditedState = stateAfterCategoryEdit(validationScenario);
  const editedValues = calculateAll(validationScenario, validationEditedState);
  const expectedEditedValues = validationScenario.rows.map((item) => {
    const relatedCategory = validationEditedState.pages[item.properties.category as string]!;
    const adjusted =
      (item.properties.amount as number) * (relatedCategory.properties['category-multiplier'] as number);
    return [adjusted, adjusted + (relatedCategory.properties['category-offset'] as number)];
  });
  expect(editedValues).toEqual(expectedEditedValues);

  const measurements: Array<{
    name: string;
    iterations: number;
    medianMs: number;
    meanMs: number;
    p99Ms: number;
  }> = [];
  const measure = async (name: string, beforeEach: () => void, execute: () => unknown) => {
    const result = await bench(name, { ...BENCH_OPTIONS, beforeEach }, execute).run(BENCH_RUN_OPTIONS);
    measurements.push({
      name,
      iterations: result.latency.df + 1,
      medianMs: result.latency.p50,
      meanMs: result.latency.mean,
      p99Ms: result.latency.p99,
    });
  };

  let scenario: Scenario;
  for (const count of [250, 500, 1_000, 2_000]) {
    const template = createScenario(count);
    await measure(
      `First formula calculation with empty cache (${count} rows)`,
      () => {
        scenario = { ...template, state: { ...template.state } };
      },
      () => calculateAll(scenario),
    );
  }

  const warmTemplate = createScenario(TRANSACTION_COUNT);
  await measure(
    'Warmed formula calculation (1,000 rows)',
    () => {
      scenario = { ...warmTemplate, state: { ...warmTemplate.state } };
      calculateAll(scenario);
    },
    () => calculateAll(scenario),
  );

  const editTemplate = createScenario(TRANSACTION_COUNT);
  await measure(
    'Related record edit and dependent recalculation (1,000 rows)',
    () => {
      scenario = { ...editTemplate, state: { ...editTemplate.state } };
      calculateAll(scenario);
      scenario = { ...scenario, state: stateAfterCategoryEdit(scenario) };
    },
    () => calculateAll(scenario),
  );

  const viewATemplate = createScenario(TRANSACTION_COUNT);
  await measure(
    'Apply view A filter (1,000 rows)',
    () => {
      scenario = { ...viewATemplate, state: { ...viewATemplate.state } };
      calculateAll(scenario);
    },
    () => filteredRows(scenario, scenario.viewA),
  );

  const viewBTemplate = createScenario(TRANSACTION_COUNT);
  await measure(
    'Apply view B filter (1,000 rows)',
    () => {
      scenario = { ...viewBTemplate, state: { ...viewBTemplate.state } };
      calculateAll(scenario);
    },
    () => filteredRows(scenario, scenario.viewB),
  );

  const filterTemplate = createScenario(TRANSACTION_COUNT);
  let changedFilterView: ViewDef;
  await measure(
    'Change view A filter (1,000 rows)',
    () => {
      scenario = { ...filterTemplate, state: { ...filterTemplate.state } };
      calculateAll(scenario);
      filteredRows(scenario, scenario.viewA);
      filteredRows(scenario, scenario.viewB);
      changedFilterView = editedViewA(scenario);
    },
    () => filteredRows(scenario, changedFilterView),
  );

  const cpu = cpus()[0]?.model ?? 'unknown CPU';
  console.info(
    `ISSUE_6_MEASUREMENTS ${JSON.stringify({
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        osRelease: release(),
        cpu,
        logicalCores: cpus().length,
      },
      fixture: {
        transactionRows: TRANSACTION_COUNT,
        relatedCategoryRows: CATEGORY_COUNT,
        formulasPerRow: 2,
        independentlyFilteredViews: 2,
      },
      settings: BENCH_RUN_OPTIONS,
      measurements,
    })}`,
  );
}, 60_000);
