import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import type { Command } from './commands';
import { emptyWorkspace, SCHEMA_VERSION } from './model';
import type { ActionFormulaDef, DatabaseDef, NamedControlDef, PropDef, WorkspaceState } from './model';
import { formulaResult, valueOf } from './database';
import { readWorkspace } from './migrations';
import { planTableAction, tableActionAvailability } from './tableActions';

const formula = (source: string): ActionFormulaDef => ({ source, bindings: [] });

function run(state: WorkspaceState, ...commands: Command[]): WorkspaceState {
  return commands.reduce((current, command) => {
    const result = applyCommand(current, command);
    if (!result.ok) throw new Error(result.error);
    return result.value.state;
  }, state);
}

function createFinanceState(startDate: string): WorkspaceState {
  const action = {
    label: 'Generate installments',
    icon: 'play' as const,
    color: 'blue' as const,
    steps: [
      {
        id: 'create-installments',
        type: 'addRows' as const,
        count: formula('prop("Installments")'),
        title: formula('concat("Installment ", CurrentValue)'),
        values: {
          date: formula('DateAdd(prop("Start Date"), CurrentValue - 1, "months")'),
          amount: formula(
            'If(CurrentValue < prop("Installments"), Round(prop("Total") / prop("Installments"), 2), Round(prop("Total") - Round(prop("Total") / prop("Installments"), 2) * (prop("Installments") - 1), 2))',
          ),
        },
      },
    ],
  };
  const properties: PropDef[] = [
    { id: 'installments', name: 'Installments', type: 'number', options: [] },
    { id: 'total', name: 'Total', type: 'currency', options: [] },
    { id: 'start-date', name: 'Start Date', type: 'date', options: [] },
    { id: 'date', name: 'Date', type: 'date', options: [] },
    { id: 'amount', name: 'Amount', type: 'currency', options: [] },
    { id: 'generate', name: 'Generate installments', type: 'button', options: [], action },
  ];
  const database: DatabaseDef = { properties, views: [] };
  return run(
    emptyWorkspace(),
    {
      type: 'page.create',
      id: 'finance',
      parentId: null,
      title: 'Finance',
      kind: 'database',
      database,
      now: 1,
    },
    {
      type: 'page.create',
      id: 'purchase',
      parentId: 'finance',
      title: 'Purchase',
      properties: { installments: 3, total: 100, 'start-date': startDate },
      now: 2,
    },
  );
}

function testControl(): NamedControlDef {
  return {
    id: 'month',
    name: 'Month',
    type: 'number',
    value: 12,
    defaultValue: 1,
    options: [],
  };
}

describe('table actions', () => {
  it('adds safe defaults for old button columns and preserves malformed configurations as unsupported data', () => {
    const loaded = readWorkspace(SCHEMA_VERSION, {
      pages: [
        {
          id: 'actions',
          title: 'Actions',
          kind: 'database',
          database: {
            properties: [
              { id: 'old-button', name: 'Old action', type: 'button' },
              {
                id: 'broken-button',
                name: 'Broken action',
                type: 'button',
                action: { label: '', steps: 'unsafe' },
              },
            ],
            views: [],
          },
        },
      ],
      docs: {},
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const database = loaded.value.pages[0]?.database;
    expect(database?.properties[0]?.action).toMatchObject({ label: 'Old action', steps: [] });
    expect(database?.unsupportedProperties).toEqual([
      { id: 'broken-button', name: 'Broken action', type: 'button', action: { label: '', steps: 'unsafe' } },
    ]);
  });

  it('previews a pure three-installment action with exact cents across a year boundary and month ends', () => {
    for (const [startDate, dates] of [
      ['2026-12-31', ['2026-12-31', '2027-01-31', '2027-02-28']],
      ['2027-01-31', ['2027-01-31', '2027-02-28', '2027-03-31']],
    ] as const) {
      const state = createFinanceState(startDate);
      const result = planTableAction(
        state,
        'finance',
        'purchase',
        'generate',
        (() => {
          let next = 0;
          return () => `installment-${++next}`;
        })(),
        100,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;

      expect(state.pages).not.toHaveProperty('installment-1');
      expect(valueOf(state.pages.purchase!, 'generate', state.pages.finance!.database!, state)).toBeNull();
      expect(
        formulaResult(
          state.pages.purchase!,
          {
            id: 'action-reference',
            name: 'Action reference',
            type: 'formula',
            options: [],
            formula: 'prop("Generate installments")',
          },
          state.pages.finance!.database!,
          0,
          state,
        ),
      ).toMatchObject({ value: null, error: null });
      expect(result.value.commands.filter((command) => command.type === 'page.create')).toHaveLength(3);
      expect(result.value.steps[0]?.rows.map((row) => row.title)).toEqual([
        'Installment 1',
        'Installment 2',
        'Installment 3',
      ]);
      expect(result.value.steps[0]?.rows.map((row) => row.properties.date)).toEqual(dates);
      expect(result.value.steps[0]?.rows.map((row) => row.properties.amount)).toEqual([33.33, 33.33, 33.34]);

      const saved = run(state, ...result.value.commands);
      expect(
        ['installment-1', 'installment-2', 'installment-3'].map((id) => saved.pages[id]?.properties.amount),
      ).toEqual([33.33, 33.33, 33.34]);
    }
  });

  it('stores currency action results at their configured precision', () => {
    const state = createFinanceState('2026-12-31');
    const button = state.pages.finance?.database?.properties.find((prop) => prop.id === 'generate');
    const step = button?.action?.steps[0];
    if (!step || step.type !== 'addRows') throw new Error('Missing installment action');
    step.values.amount = formula(
      'Floor(prop("Total") * 100 / prop("Installments")) / 100 + If(CurrentValue <= Mod(prop("Total") * 100, prop("Installments")), 0.01, 0)',
    );
    const planned = planTableAction(state, 'finance', 'purchase', 'generate', (() => {
      let index = 0;
      return () => `rounded-${++index}`;
    })(), 100);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const amounts = planned.value.steps[0]?.rows.map((row) => row.properties.amount);
    expect(amounts).toEqual([33.34, 33.33, 33.33]);
    expect(amounts?.reduce<number>((sum, value) => sum + Math.round(Number(value) * 100), 0)).toBe(10000);
  });

  it('simulates row modifications and control resets while matching conditions', () => {
    const properties: PropDef[] = [
      { id: 'status', name: 'Status', type: 'text', options: [] },
      { id: 'value', name: 'Value', type: 'number', options: [] },
      {
        id: 'action',
        name: 'Complete open rows',
        type: 'button',
        options: [],
        action: {
          label: 'Complete',
          icon: 'check',
          color: 'green',
          steps: [
            {
              id: 'complete-open',
              type: 'modifyRows',
              target: 'matchingRows',
              where: formula('prop("Status") = "Open"'),
              values: { status: formula('"Done"'), value: formula('prop("Value") + 1') },
            },
            { id: 'reset-month', type: 'resetControls', controlIds: ['month'] },
          ],
        },
      },
    ];
    const database: DatabaseDef = { properties, views: [] };
    let state = run(
      emptyWorkspace(),
      {
        type: 'page.create',
        id: 'tasks',
        parentId: null,
        title: 'Tasks',
        kind: 'database',
        database,
        now: 1,
      },
      {
        type: 'page.create',
        id: 'one',
        parentId: 'tasks',
        title: 'One',
        properties: { status: 'Open', value: 4 },
        now: 1,
      },
      {
        type: 'page.create',
        id: 'two',
        parentId: 'tasks',
        title: 'Two',
        properties: { status: 'Done', value: 8 },
        now: 1,
      },
      { type: 'page.control.configure', id: 'tasks', control: testControl(), now: 1 },
    );
    const before = state;
    const result = planTableAction(state, 'tasks', 'one', 'action', () => 'unused', 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(state).toBe(before);
    expect(result.value.steps.map((step) => step.rows.map((row) => row.id))).toEqual([['one'], []]);
    expect(result.value.steps[1]?.controlNames).toEqual(['Month']);

    state = run(state, ...result.value.commands);
    expect(state.pages.one?.properties).toMatchObject({ status: 'Done', value: 5 });
    expect(state.pages.two?.properties).toMatchObject({ status: 'Done', value: 8 });
    expect(state.pages.tasks?.controls[0]?.value).toBe(1);
  });

  it('disables a button when its formula is true and rejects invalid disabled results', () => {
    const trueState = createFinanceState('2026-12-01');
    const database = trueState.pages.finance!.database!;
    const button = database.properties.find((prop) => prop.id === 'generate')!;
    button.action = { ...button.action!, disabled: formula('true') };
    expect(tableActionAvailability(trueState, 'finance', 'purchase', button).disabled).toBe(true);
    expect(planTableAction(trueState, 'finance', 'purchase', 'generate', () => 'never', 3).ok).toBe(false);

    button.action = { ...button.action!, disabled: formula('1') };
    expect(tableActionAvailability(trueState, 'finance', 'purchase', button)).toMatchObject({
      disabled: true,
      reason: 'The disabled condition must return true or false.',
    });
  });
});
