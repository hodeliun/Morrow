import { describe, expect, it, vi } from 'vitest';
import type { VaultOp } from '../core/vault/plan';
import { createDataApi } from '../app/plugins/dataApi';
import type { DataApi, DataApiSnapshot } from '../app/plugins/dataApi';
import { newPageMeta } from '../core/model';
import { composeFrontmatter, managedFrontmatter, readPageText, renderPageText } from '../core/vault/pageFile';
import { createFormulaEvaluationScope, evaluateCell } from '../../plugins/polaris-dados/src/ui/formulas';
import { E003_POLARIS_DADOS_FIXTURE } from './fixtures/e003-polaris-dados';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let nextId = 0;
const newId = () => `pilot-${++nextId}`;

class CountingMemoryVault extends MemoryVault {
  applyCount = 0;

  override async apply(ops: VaultOp[]) {
    this.applyCount += 1;
    return super.apply(ops);
  }
}

function fixture(): Record<string, string> {
  return {
    ...E003_POLARIS_DADOS_FIXTURE,
    'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace(
      'Price: 10',
      'Price: null',
    ),
    'Inventory/Missing price.md': `---
Name: Missing price
Quantity: 1
---
Missing price is different from an explicit null.
`,
  };
}

async function open(vault: MemoryVault, delayMs = 0): Promise<WorkspaceSession> {
  const result = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function idAt(session: WorkspaceSession, path: string): string {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function apiFor(
  session: WorkspaceSession,
  options: {
    ownerIsActive?: () => boolean;
    isProviderActive?: () => boolean;
    isHostReadonly?: () => boolean;
  } = {},
): { api: DataApi; cleanup: () => void } {
  let cleanup = () => {};
  const api = createDataApi({
    session,
    ownerIsActive: options.ownerIsActive ?? (() => true),
    isProviderActive: options.isProviderActive ?? (() => true),
    isHostReadonly: options.isHostReadonly ?? (() => false),
    registerCleanup: (onCleanup) => {
      cleanup = onCleanup;
    },
  });
  return { api, cleanup: () => cleanup() };
}

function ready(snapshot: DataApiSnapshot) {
  if (snapshot.status !== 'ready') throw new Error(`Expected ready snapshot, received ${snapshot.status}.`);
  return snapshot;
}

describe('Polaris Dados snapshot and cell API', () => {
  it('roundtrips opted-in numeric result declarations, raw formulas, and edited input', async () => {
    const files = fixture();
    const typedFormulaProperties = `    - id: optional
      name: Optional
      type: number
    - id: completion
      name: Completion
      type: formula
      formula: Quantity / 4
      formulaResultType: percent
      format:
        locale: en-US
        precision: 1.5
        negativeFormat: parentheses
    - id: completion-raw-check
      name: Completion raw check
      type: formula
      formula: If(Completion > 0.74, 42, 17)
    - id: optional-completion
      name: Optional completion
      type: formula
      formula: thisRow.Optional
      formulaResultType: percent
      format:
        locale: de-DE
    - id: decimal-locale-only
      name: Decimal locale only
      type: formula
      formula: 7 / 3
      formulaResultType: number
      format:
        locale: fr-FR
    - id: decimal-zero-precision
      name: Decimal zero precision
      type: formula
      formula: 7 / 3
      formulaResultType: number
      format:
        precision: 0
    - id: decimal-bounded
      name: Decimal bounded
      type: formula
      formula: Quantity / 4
      formulaResultType: number
      format:
        min: 0
        max: 1
        step: 0.25
    - id: decimal-bounded-raw-check
      name: Decimal bounded raw check
      type: formula
      formula: prop("Decimal bounded") * 4
    - id: currency-total
      name: Currency total
      type: formula
      formula: 7 / 3
      formulaResultType: currency
    - id: currency-raw-check
      name: Currency raw check
      type: formula
      formula: prop("Currency total") * 3
    - id: bounded-currency
      name: Bounded currency
      type: formula
      formula: "9.996"
      formulaResultType: currency
      format:
        currency: BRL
        locale: fr-FR
        precision: 2
        negativeFormat: parentheses
        min: 0
        max: 10
        step: 0.002
    - id: bounded-currency-raw-check
      name: Bounded currency raw check
      type: formula
      formula: If(prop("Bounded currency") == 9.996, 1, 0)
    - id: over-max-currency
      name: Over max currency
      type: formula
      formula: "10.004"
      formulaResultType: currency
      format:
        currency: BRL
        min: 0
        max: 10
        step: 0.002
    - id: over-max-currency-dependent
      name: Over max currency dependent
      type: formula
      formula: prop("Over max currency") + 1
    - id: negative-currency
      name: Negative currency
      type: formula
      formula: "-1.996"
      formulaResultType: currency
      format:
        min: -2
        max: -1
        step: 0.002
    - id: null-bounded-currency
      name: Null bounded currency
      type: formula
      formula: thisRow.Optional
      formulaResultType: currency
      format:
        min: 5
        max: 0
        step: 0.002
    - id: currency-jpy
      name: JPY total
      type: formula
      formula: "12.5"
      formulaResultType: currency
      format:
        currency: JPY
    - id: currency-locale-only
      name: Currency locale only
      type: formula
      formula: 7 / 3
      formulaResultType: currency
      format:
        locale: fr-FR
    - id: currency-zero-precision
      name: Currency zero precision
      type: formula
      formula: 7 / 3
      formulaResultType: currency
      format:
        currency: USD
        precision: 0
    - id: optional-currency
      name: Optional currency
      type: formula
      formula: thisRow.Optional
      formulaResultType: currency
      format:
        locale: de-DE
    - id: invalid-currency
      name: Invalid currency
      type: formula
      formula: '"done"'
      formulaResultType: currency
    - id: invalid-currency-dependent
      name: Invalid currency dependent
      type: formula
      formula: prop("Invalid currency") + 1
    - id: invalid-completion
      name: Invalid completion
      type: formula
      formula: '"done"'
      formulaResultType: percent
    - id: invalid-dependent
      name: Invalid dependent
      type: formula
      formula: prop("Invalid completion") + 1
    - id: message
      name: Message
      type: text
    - id: text-result
      name: Text result
      type: formula
      formula: Concat(thisRow.Message, "!")
      formulaResultType: text
    - id: text-raw-check
      name: Text raw check
      type: formula
      formula: Concat(prop("Text result"), "?")
    - id: availability
      name: Availability
      type: formula
      formula: Quantity > 2
      formulaResultType: checkbox
    - id: availability-label
      name: Availability label
      type: formula
      formula: If(prop("Availability"), "Available", "Unavailable")
    - id: optional-availability
      name: Optional availability
      type: formula
      formula: thisRow.Optional
      formulaResultType: checkbox
    - id: optional-availability-is-false
      name: Optional availability is false
      type: formula
      formula: If(prop("Optional availability") == false, "false", "not false")
`;
    files['Inventory.md'] = files['Inventory.md']!.replace('  views:', `${typedFormulaProperties}  views:`);
    files['Inventory/Widget.md'] = files['Inventory/Widget.md']!.replace(
      'Price: null',
      'Price: null\nOptional: null\nMessage: "  Keep Case  "',
    );

    const parsed = readPageText(files['Inventory.md']!);
    if (!parsed.database) throw new Error('Expected a parsed Polaris Dados database.');
    const editedSchema = structuredClone(parsed.database);
    const completion = editedSchema.properties.find((property) => property.id === 'completion');
    if (!completion) throw new Error('Expected an explicit percentage formula.');
    completion.format = {
      locale: 'fr-FR',
      precision: 2.25,
      negativeFormat: 'parentheses',
      min: 0,
      max: 1,
      step: 0.25,
    };
    const databasePage = newPageMeta({
      id: 'inventory',
      parentId: null,
      title: 'Inventory',
      kind: 'database',
      database: editedSchema,
      extra: parsed.extra,
    });
    files['Inventory.md'] = renderPageText(
      composeFrontmatter(
        managedFrontmatter(databasePage, 'Inventory', null),
        parsed.extra,
        parsed.source,
        databasePage,
      ),
      parsed.source,
      parsed.body,
    );
    expect(files['Inventory.md']).toContain('formulaResultType: percent');
    expect(files['Inventory.md']).toContain('precision: 2.25');
    expect(files['Inventory.md']).toContain('negativeFormat: parentheses');
    expect(files['Inventory.md']).toContain('step: 0.25');

    const vault = new MemoryVault(files);
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const missingPriceId = idAt(session, 'Inventory/Missing price.md');
    const initial = ready(api.snapshot(databaseId));
    const widget = initial.rows.find((row) => row.id === widgetId)!;
    const missingPrice = initial.rows.find((row) => row.id === missingPriceId)!;
    const completionProperty = initial.schema.properties.find((property) => property.id === 'completion')!;
    const rawCheckProperty = initial.schema.properties.find((property) => property.id === 'completion-raw-check')!;
    const optionalProperty = initial.schema.properties.find((property) => property.id === 'optional-completion')!;
    const localeOnlyDecimal = initial.schema.properties.find((property) => property.id === 'decimal-locale-only')!;
    const zeroPrecisionDecimal = initial.schema.properties.find((property) => property.id === 'decimal-zero-precision')!;
    const boundedDecimal = initial.schema.properties.find((property) => property.id === 'decimal-bounded')!;
    const boundedDecimalRawCheck = initial.schema.properties.find(
      (property) => property.id === 'decimal-bounded-raw-check',
    )!;
    const currencyTotalProperty = initial.schema.properties.find((property) => property.id === 'currency-total')!;
    const currencyRawCheckProperty = initial.schema.properties.find((property) => property.id === 'currency-raw-check')!;
    const boundedCurrencyProperty = initial.schema.properties.find((property) => property.id === 'bounded-currency')!;
    const boundedCurrencyRawCheckProperty = initial.schema.properties.find(
      (property) => property.id === 'bounded-currency-raw-check',
    )!;
    const overMaxCurrencyProperty = initial.schema.properties.find((property) => property.id === 'over-max-currency')!;
    const overMaxCurrencyDependentProperty = initial.schema.properties.find(
      (property) => property.id === 'over-max-currency-dependent',
    )!;
    const negativeCurrencyProperty = initial.schema.properties.find((property) => property.id === 'negative-currency')!;
    const nullBoundedCurrencyProperty = initial.schema.properties.find(
      (property) => property.id === 'null-bounded-currency',
    )!;
    const currencyJpyProperty = initial.schema.properties.find((property) => property.id === 'currency-jpy')!;
    const currencyLocaleProperty = initial.schema.properties.find((property) => property.id === 'currency-locale-only')!;
    const currencyZeroProperty = initial.schema.properties.find((property) => property.id === 'currency-zero-precision')!;
    const optionalCurrencyProperty = initial.schema.properties.find((property) => property.id === 'optional-currency')!;
    const invalidCurrencyProperty = initial.schema.properties.find((property) => property.id === 'invalid-currency')!;
    const invalidCurrencyDependentProperty = initial.schema.properties.find(
      (property) => property.id === 'invalid-currency-dependent',
    )!;
    const textResultProperty = initial.schema.properties.find((property) => property.id === 'text-result')!;
    const textRawCheckProperty = initial.schema.properties.find((property) => property.id === 'text-raw-check')!;
    const availabilityProperty = initial.schema.properties.find((property) => property.id === 'availability')!;
    const availabilityLabelProperty = initial.schema.properties.find((property) => property.id === 'availability-label')!;
    const optionalAvailabilityProperty = initial.schema.properties.find(
      (property) => property.id === 'optional-availability',
    )!;
    const optionalAvailabilityFalseCheckProperty = initial.schema.properties.find(
      (property) => property.id === 'optional-availability-is-false',
    )!;
    const invalidProperty = initial.schema.properties.find((property) => property.id === 'invalid-completion')!;
    const dependentProperty = initial.schema.properties.find((property) => property.id === 'invalid-dependent')!;

    expect(initial.readonly).toBe(false);
    expect(completionProperty).toMatchObject({
      type: 'formula',
      formulaResultType: 'percent',
      format: {
        locale: 'fr-FR',
        precision: 2.25,
        negativeFormat: 'parentheses',
        min: 0,
        max: 1,
        step: 0.25,
      },
    });
    expect(optionalProperty).toMatchObject({ formulaResultType: 'percent', format: { locale: 'de-DE' } });
    expect(optionalProperty.format).not.toHaveProperty('precision');
    expect(localeOnlyDecimal).toMatchObject({
      formulaResultType: 'number',
      format: { locale: 'fr-FR' },
    });
    expect(localeOnlyDecimal.format).not.toHaveProperty('precision');
    expect(zeroPrecisionDecimal).toMatchObject({ formulaResultType: 'number', format: { precision: 0 } });
    expect(boundedDecimal).toMatchObject({
      formulaResultType: 'number',
      format: { min: 0, max: 1, step: 0.25 },
    });
    expect(currencyTotalProperty).toMatchObject({ type: 'formula', formulaResultType: 'currency' });
    expect(currencyTotalProperty).not.toHaveProperty('format');
    expect(boundedCurrencyProperty).toMatchObject({
      formulaResultType: 'currency',
      format: {
        currency: 'BRL',
        locale: 'fr-FR',
        precision: 2,
        negativeFormat: 'parentheses',
        min: 0,
        max: 10,
        step: 0.002,
      },
    });
    expect(currencyJpyProperty).toMatchObject({ formulaResultType: 'currency', format: { currency: 'JPY' } });
    expect(currencyLocaleProperty).toMatchObject({ formulaResultType: 'currency', format: { locale: 'fr-FR' } });
    expect(currencyZeroProperty).toMatchObject({
      formulaResultType: 'currency',
      format: { currency: 'USD', precision: 0 },
    });
    expect(textResultProperty).toMatchObject({ type: 'formula', formulaResultType: 'text' });
    expect(textResultProperty).not.toHaveProperty('format');
    expect(availabilityProperty).toMatchObject({ type: 'formula', formulaResultType: 'checkbox' });
    expect(availabilityProperty).not.toHaveProperty('format');
    expect(widget.properties.optional).toBeNull();
    expect(Object.hasOwn(missingPrice.properties, 'optional')).toBe(false);

    const evaluation = createFormulaEvaluationScope(initial);
    expect(evaluateCell(widget, initial.schema.properties, completionProperty, evaluation)).toEqual({
      kind: 'number',
      value: 0.5,
    });
    expect(evaluateCell(widget, initial.schema.properties, rawCheckProperty, evaluation)).toEqual({
      kind: 'number',
      value: 17,
    });
    expect(evaluateCell(widget, initial.schema.properties, optionalProperty, evaluation)).toEqual({ kind: 'null' });
    expect(evaluateCell(widget, initial.schema.properties, currencyTotalProperty, evaluation)).toEqual({
      kind: 'number',
      value: 7 / 3,
    });
    expect(evaluateCell(widget, initial.schema.properties, currencyRawCheckProperty, evaluation)).toEqual({
      kind: 'number',
      value: 7,
    });
    expect(evaluateCell(widget, initial.schema.properties, boundedCurrencyProperty, evaluation)).toEqual({
      kind: 'number',
      value: 9.996,
    });
    expect(evaluateCell(widget, initial.schema.properties, boundedCurrencyRawCheckProperty, evaluation)).toEqual({
      kind: 'number',
      value: 1,
    });
    expect(evaluateCell(widget, initial.schema.properties, overMaxCurrencyProperty, evaluation)).toEqual({
      kind: 'error',
      message: 'Over max currency must be at most 10.',
    });
    expect(evaluateCell(widget, initial.schema.properties, overMaxCurrencyDependentProperty, evaluation)).toEqual({
      kind: 'error',
      message: 'Over max currency must be at most 10.',
    });
    expect(evaluateCell(widget, initial.schema.properties, negativeCurrencyProperty, evaluation)).toEqual({
      kind: 'number',
      value: -1.996,
    });
    expect(evaluateCell(widget, initial.schema.properties, nullBoundedCurrencyProperty, evaluation)).toEqual({
      kind: 'null',
    });
    expect(evaluateCell(widget, initial.schema.properties, boundedDecimal, evaluation)).toEqual({
      kind: 'number',
      value: 0.5,
    });
    expect(evaluateCell(widget, initial.schema.properties, boundedDecimalRawCheck, evaluation)).toEqual({
      kind: 'number',
      value: 2,
    });
    expect(evaluateCell(widget, initial.schema.properties, currencyJpyProperty, evaluation)).toEqual({
      kind: 'number',
      value: 12.5,
    });
    expect(evaluateCell(widget, initial.schema.properties, currencyLocaleProperty, evaluation)).toEqual({
      kind: 'number',
      value: 7 / 3,
    });
    expect(evaluateCell(widget, initial.schema.properties, currencyZeroProperty, evaluation)).toEqual({
      kind: 'number',
      value: 7 / 3,
    });
    expect(evaluateCell(widget, initial.schema.properties, textResultProperty, evaluation)).toEqual({
      kind: 'text',
      value: '  Keep Case  !',
    });
    expect(evaluateCell(widget, initial.schema.properties, textRawCheckProperty, evaluation)).toEqual({
      kind: 'text',
      value: '  Keep Case  !?',
    });
    expect(evaluateCell(widget, initial.schema.properties, availabilityProperty, evaluation)).toEqual({
      kind: 'boolean',
      value: false,
    });
    expect(evaluateCell(widget, initial.schema.properties, availabilityLabelProperty, evaluation)).toEqual({
      kind: 'text',
      value: 'Unavailable',
    });
    expect(evaluateCell(widget, initial.schema.properties, optionalAvailabilityProperty, evaluation)).toEqual({
      kind: 'null',
    });
    expect(
      evaluateCell(widget, initial.schema.properties, optionalAvailabilityFalseCheckProperty, evaluation),
    ).toEqual({ kind: 'text', value: 'not false' });
    expect(evaluateCell(widget, initial.schema.properties, optionalCurrencyProperty, evaluation)).toEqual({
      kind: 'null',
    });
    expect(evaluateCell(widget, initial.schema.properties, invalidCurrencyProperty, evaluation)).toMatchObject({
      kind: 'error',
      message: 'Formula “Invalid currency” declared as currency must return a finite number or null.',
    });
    expect(
      evaluateCell(widget, initial.schema.properties, invalidCurrencyDependentProperty, evaluation),
    ).toMatchObject({
      kind: 'error',
      message: 'Formula “Invalid currency” declared as currency must return a finite number or null.',
    });
    expect(evaluateCell(missingPrice, initial.schema.properties, optionalProperty, evaluation)).toEqual({ kind: 'null' });
    expect(evaluateCell(widget, initial.schema.properties, invalidProperty, evaluation)).toMatchObject({
      kind: 'error',
      message: 'Formula “Invalid completion” declared as percent must return a finite number or null.',
    });
    expect(evaluateCell(widget, initial.schema.properties, dependentProperty, evaluation)).toMatchObject({
      kind: 'error',
      message: 'Formula “Invalid completion” declared as percent must return a finite number or null.',
    });
    expect(widget.properties).not.toHaveProperty('completion');
    expect(widget.properties).not.toHaveProperty('completion-raw-check');
    expect(widget.properties).not.toHaveProperty('decimal-bounded');
    expect(widget.properties).not.toHaveProperty('decimal-bounded-raw-check');
    expect(widget.properties).not.toHaveProperty('bounded-currency');
    expect(widget.properties).not.toHaveProperty('bounded-currency-raw-check');

    expect(api.patchCell({
      databaseId,
      rowId: widgetId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    })).toMatchObject({ status: 'staged' });
    const edited = ready(api.snapshot(databaseId));
    const editedWidget = edited.rows.find((row) => row.id === widgetId)!;
    const editedCompletion = edited.schema.properties.find((property) => property.id === 'completion')!;
    const editedRawCheck = edited.schema.properties.find((property) => property.id === 'completion-raw-check')!;
    const editedAvailability = edited.schema.properties.find((property) => property.id === 'availability')!;
    const editedAvailabilityLabel = edited.schema.properties.find((property) => property.id === 'availability-label')!;
    const editedEvaluation = createFormulaEvaluationScope(edited);
    expect(evaluateCell(editedWidget, edited.schema.properties, editedCompletion, editedEvaluation)).toEqual({
      kind: 'number',
      value: 0.75,
    });
    expect(evaluateCell(editedWidget, edited.schema.properties, editedRawCheck, editedEvaluation)).toEqual({
      kind: 'number',
      value: 42,
    });
    expect(evaluateCell(editedWidget, edited.schema.properties, editedAvailability, editedEvaluation)).toEqual({
      kind: 'boolean',
      value: true,
    });
    expect(evaluateCell(editedWidget, edited.schema.properties, editedAvailabilityLabel, editedEvaluation)).toEqual({
      kind: 'text',
      value: 'Available',
    });
    expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
    expect(vault.text('Inventory/Widget.md')).toMatch(/^Quantity: 3$/m);
    expect(vault.text('Inventory/Widget.md')).not.toMatch(/^(Completion|Optional completion|Invalid completion):/m);
    expect(vault.text('Inventory/Widget.md')).not.toMatch(/^Text result:/m);
    expect(vault.text('Inventory/Widget.md')).not.toMatch(/^Text raw check:/m);
    expect(vault.text('Inventory.md')).toBe(files['Inventory.md']);

    cleanup();
    await session.close();
    const reopened = await open(vault);
    const reopenedApi = apiFor(reopened);
    const afterRestart = ready(reopenedApi.api.snapshot(idAt(reopened, 'Inventory.md')));
    const reopenedWidget = afterRestart.rows.find((row) => row.id === widgetId)!;
    expect(reopenedWidget.properties.quantity).toBe(3);
    expect(afterRestart.schema.properties.find((property) => property.id === 'completion')).toMatchObject({
      formulaResultType: 'percent',
      format: { locale: 'fr-FR', precision: 2.25, negativeFormat: 'parentheses', min: 0, max: 1, step: 0.25 },
    });
    expect(
      afterRestart.schema.properties.find((property) => property.id === 'decimal-locale-only'),
    ).toMatchObject({
      formulaResultType: 'number',
      format: { locale: 'fr-FR' },
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'decimal-locale-only')?.format).not.toHaveProperty(
      'precision',
    );
    expect(afterRestart.schema.properties.find((property) => property.id === 'decimal-zero-precision')).toMatchObject({
      formulaResultType: 'number',
      format: { precision: 0 },
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'decimal-bounded')).toMatchObject({
      formulaResultType: 'number',
      format: { min: 0, max: 1, step: 0.25 },
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'currency-total')).toMatchObject({
      formulaResultType: 'currency',
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'currency-total')).not.toHaveProperty(
      'format',
    );
    expect(afterRestart.schema.properties.find((property) => property.id === 'bounded-currency')).toMatchObject({
      formulaResultType: 'currency',
      format: { currency: 'BRL', min: 0, max: 10, step: 0.002 },
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'currency-jpy')).toMatchObject({
      formulaResultType: 'currency',
      format: { currency: 'JPY' },
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'currency-locale-only')).toMatchObject({
      formulaResultType: 'currency',
      format: { locale: 'fr-FR' },
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'currency-zero-precision')).toMatchObject({
      formulaResultType: 'currency',
      format: { currency: 'USD', precision: 0 },
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'text-result')).toMatchObject({
      formulaResultType: 'text',
    });
    expect(afterRestart.schema.properties.find((property) => property.id === 'text-result')).not.toHaveProperty(
      'format',
    );
    expect(afterRestart.schema.properties.find((property) => property.id === 'availability')).toMatchObject({
      formulaResultType: 'checkbox',
    });
    expect(reopenedWidget.properties).not.toHaveProperty('completion');
    expect(reopenedWidget.properties).not.toHaveProperty('completion-raw-check');
    expect(reopenedWidget.properties).not.toHaveProperty('decimal-bounded');
    expect(reopenedWidget.properties).not.toHaveProperty('decimal-bounded-raw-check');
    expect(reopenedWidget.properties).not.toHaveProperty('currency-total');
    expect(reopenedWidget.properties).not.toHaveProperty('currency-raw-check');
    expect(reopenedWidget.properties).not.toHaveProperty('bounded-currency');
    expect(reopenedWidget.properties).not.toHaveProperty('bounded-currency-raw-check');
    expect(reopenedWidget.properties).not.toHaveProperty('text-result');
    expect(reopenedWidget.properties).not.toHaveProperty('text-raw-check');
    expect(reopenedWidget.properties).not.toHaveProperty('availability');
    expect(reopenedWidget.properties).not.toHaveProperty('availability-label');
    reopenedApi.cleanup();
    await reopened.close();
  });

  it('keeps a duplicated percentage declaration read only and refuses child row patches', async () => {
    const files = fixture();
    files['Inventory.md'] = files['Inventory.md']!.replace(
      '      formula: Quantity * Price\n',
      '      formula: Quantity * Price\n' +
        '      formulaResultType: currency\n' +
        '      formulaResultType: percent\n' +
        '      format:\n' +
        '        locale: de-DE\n' +
        '        precision: 1.5\n' +
        '        negativeFormat: parentheses\n',
    );
    const originalDatabase = files['Inventory.md']!;
    const originalRow = files['Inventory/Widget.md']!;
    const vault = new CountingMemoryVault(files);
    const session = await open(vault, 60_000);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const snapshot = api.snapshot(databaseId);

    expect(snapshot).toMatchObject({ status: 'unsupported', diagnostic: { code: 'database-unreadable' } });
    expect('rows' in snapshot).toBe(false);
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: snapshot.revision,
    })).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(session.queue.isDirty(rowId)).toBe(false);
    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(vault.applyCount).toBe(0);
    expect(vault.text('Inventory.md')).toBe(originalDatabase);
    expect(vault.text('Inventory/Widget.md')).toBe(originalRow);

    cleanup();
    await session.close();
  });

  it('keeps snapshots immutable, distinguishes null from missing, and persists a staged 2-to-3 edit', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const missingPriceId = idAt(session, 'Inventory/Missing price.md');
    const first = ready(api.snapshot(databaseId));
    const widget = first.rows.find((row) => row.id === widgetId)!;
    const missingPrice = first.rows.find((row) => row.id === missingPriceId)!;

    expect(api.version).toBe(1);
    expect(first.readonly).toBe(false);
    expect(widget.properties.price).toBeNull();
    expect(Object.hasOwn(missingPrice.properties, 'price')).toBe(false);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.schema.properties)).toBe(true);
    expect(Object.isFrozen(first.schema.properties[0])).toBe(true);
    expect(Object.isFrozen(widget.properties)).toBe(true);

    const result = api.patchCell({
      databaseId,
      rowId: widgetId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: first.revision,
    });
    expect(result).toMatchObject({ status: 'staged', revision: expect.not.stringMatching(first.revision) });
    expect(session.queue.isDirty(databaseId)).toBe(true);
    expect(ready(api.snapshot(databaseId)).rows.find((row) => row.id === widgetId)?.properties.quantity).toBe(3);
    expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
    expect(vault.text('Inventory/Widget.md')).toContain('Quantity: 3');
    expect(vault.text('Inventory/Widget.md')).toContain('Price: null');
    expect(vault.text('Inventory/Widget.md')).toContain('vendorRecord:');

    cleanup();
    await session.close();
    const reopened = await open(vault);
    const reopenedApi = apiFor(reopened);
    const afterRestart = ready(reopenedApi.api.snapshot(idAt(reopened, 'Inventory.md')));
    const reopenedWidget = afterRestart.rows.find((row) => row.id === widgetId)!;
    const reopenedMissing = afterRestart.rows.find((row) => row.id === missingPriceId)!;
    expect(reopenedWidget.properties.quantity).toBe(3);
    expect(reopenedWidget.properties.price).toBeNull();
    expect(Object.hasOwn(reopenedMissing.properties, 'price')).toBe(false);
    expect(afterRestart.revision).not.toBe(first.revision);
    reopenedApi.cleanup();
    await reopened.close();
  });

  it('accepts zero but rejects stale, wrong-row, non-number, formula, and non-finite patches', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    let currentRevision = initial.revision;
    const patch = (input: Partial<Parameters<DataApi['patchCell']>[0]>) =>
      api.patchCell({
        databaseId,
        rowId: widgetId,
        propertyId: 'quantity',
        value: 0,
        expectedRevision: currentRevision,
        ...input,
      });

    expect(patch({}).status).toBe('staged');
    const afterZero = ready(api.snapshot(databaseId));
    currentRevision = afterZero.revision;
    expect(afterZero.rows.find((row) => row.id === widgetId)?.properties.quantity).toBe(0);
    expect(patch({ value: 4, expectedRevision: initial.revision })).toMatchObject({
      status: 'error',
      code: 'stale-revision',
    });
    expect(patch({ rowId: 'not-a-row' })).toMatchObject({ status: 'error', code: 'row-not-found' });
    expect(patch({ propertyId: 'name' })).toMatchObject({ status: 'error', code: 'read-only' });
    expect(patch({ propertyId: 'total' })).toMatchObject({ status: 'error', code: 'read-only' });
    expect(patch({ value: Number.NaN })).toMatchObject({ status: 'error', code: 'invalid-value' });
    expect(patch({ value: Number.POSITIVE_INFINITY })).toMatchObject({ status: 'error', code: 'invalid-value' });
    expect(patch({ value: null as unknown as number })).toMatchObject({ status: 'error', code: 'invalid-value' });

    cleanup();
    await session.close();
  });

  it('marks missing, malformed, ambiguous, trashed, and unreadable databases without exposing normalized payloads', async () => {
    const malformed = {
      ...fixture(),
      'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace(
        'Quantity: 2',
        'Quantity: many',
      ),
    };
    const vault = new MemoryVault(malformed);
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const unsupported = api.snapshot(databaseId);
    expect(unsupported.status).toBe('unsupported');
    expect(unsupported).toHaveProperty('diagnostic.code', 'unrepresentable-cell');
    expect(Object.keys(unsupported).sort()).toEqual(['databaseId', 'diagnostic', 'revision', 'status', 'version']);
    expect(api.snapshot('not-opted-in').status).toBe('missing');
    expect(api.patchCell({
      databaseId,
      rowId: idAt(session, 'Inventory/Widget.md'),
      propertyId: 'quantity',
      value: 3,
      expectedRevision: unsupported.revision,
    })).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(vault.text('Inventory/Widget.md')).toBe(malformed['Inventory/Widget.md']);
    cleanup();
    await session.close();

    const unreadableFixture = fixture();
    unreadableFixture['Inventory/Widget.md'] += '<span data-morrow-control="opaque-control">Unsupported row.</span>\n';
    const unreadableVault = new MemoryVault(unreadableFixture);
    const unreadableSession = await open(unreadableVault);
    const unreadableApi = apiFor(unreadableSession);
    const unreadableSnapshot = unreadableApi.api.snapshot(idAt(unreadableSession, 'Inventory.md'));
    expect(unreadableSnapshot.status).toBe('unsupported');
    expect(unreadableSnapshot).toHaveProperty('diagnostic.code', 'row-unreadable');
    expect(Object.keys(unreadableSnapshot).sort()).toEqual([
      'databaseId',
      'diagnostic',
      'revision',
      'status',
      'version',
    ]);
    unreadableApi.cleanup();
    await unreadableSession.close();

    const allFiles = fixture();
    const trashedFiles: Record<string, string> = {};
    for (const [path, text] of Object.entries(allFiles)) {
      if (path === 'Inventory.md') trashedFiles['.trash/Inventory.md'] = text;
      else if (path.startsWith('Inventory/')) trashedFiles[`.trash/${path}`] = text;
    }
    const trashedVault = new MemoryVault(trashedFiles);
    const trashedSession = await open(trashedVault);
    const trashedApi = apiFor(trashedSession);
    const trashedSnapshot = trashedApi.api.snapshot(idAt(trashedSession, '.trash/Inventory.md'));
    expect(trashedSnapshot.status).toBe('unsupported');
    expect(trashedSnapshot).toHaveProperty('diagnostic.code', 'database-trashed');
    trashedApi.cleanup();
    await trashedSession.close();

    const ambiguous = fixture();
    ambiguous['Inventory.md'] = ambiguous['Inventory.md']!.replace(
      '    - id: price\n      name: Price',
      '    - id: quantity\n      name: Price',
    );
    const ambiguousVault = new MemoryVault(ambiguous);
    const ambiguousSession = await open(ambiguousVault);
    const ambiguousApi = apiFor(ambiguousSession);
    const ambiguousSnapshot = ambiguousApi.api.snapshot(idAt(ambiguousSession, 'Inventory.md'));
    expect(ambiguousSnapshot.status).toBe('unsupported');
    expect(ambiguousSnapshot).toHaveProperty('diagnostic.code', 'ambiguous-schema');
    ambiguousApi.cleanup();
    await ambiguousSession.close();
  });

  it('keeps number format metadata and numeric YAML values through patch, undo, redo, and reopen', async () => {
    const format = { locale: 'de-DE', precision: 1.5, negativeFormat: 'parentheses' } as const;
    const files = fixture();
    files['Inventory.md'] = files['Inventory.md']!.replace(
      '    - id: quantity\n      name: Quantity\n      type: number\n',
      '    - id: quantity\n      name: Quantity\n      type: number\n      format:\n        locale: de-DE\n        precision: 1.5\n        negativeFormat: parentheses\n',
    );
    files['Inventory/Widget.md'] = files['Inventory/Widget.md']!.replace('Quantity: 2', 'Quantity: 2.75');

    const vault = new MemoryVault(files);
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    const quantity = initial.schema.properties.find((property) => property.id === 'quantity')!;
    expect(quantity.format).toEqual(format);
    expect(initial.rows.find((row) => row.id === rowId)?.properties.quantity).toBe(2.75);
    expect(typeof initial.rows.find((row) => row.id === rowId)?.properties.quantity).toBe('number');

    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3.25,
      expectedRevision: initial.revision,
    })).toMatchObject({ status: 'staged' });
    const edited = ready(api.snapshot(databaseId));
    expect(edited.rows.find((row) => row.id === rowId)?.properties.quantity).toBe(3.25);
    expect(api.history({ databaseId, direction: 'undo', expectedRevision: edited.revision })).toMatchObject({
      status: 'staged',
      direction: 'undo',
    });
    const undone = ready(api.snapshot(databaseId));
    expect(undone.rows.find((row) => row.id === rowId)?.properties.quantity).toBe(2.75);
    expect(api.history({ databaseId, direction: 'redo', expectedRevision: undone.revision })).toMatchObject({
      status: 'staged',
      direction: 'redo',
    });
    expect(ready(api.snapshot(databaseId)).rows.find((row) => row.id === rowId)?.properties.quantity).toBe(3.25);
    expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
    expect(vault.text('Inventory/Widget.md')).toMatch(/^Quantity: 3\.25$/m);
    expect(vault.text('Inventory.md')).toBe(files['Inventory.md']);

    cleanup();
    await session.close();
    const reopened = await open(vault);
    const reopenedApi = apiFor(reopened);
    const afterRestart = ready(reopenedApi.api.snapshot(idAt(reopened, 'Inventory.md')));
    const reopenedQuantity = afterRestart.rows.find((row) => row.id === rowId)?.properties.quantity;
    expect(afterRestart.schema.properties.find((property) => property.id === 'quantity')?.format).toEqual(format);
    expect(reopenedQuantity).toBe(3.25);
    expect(typeof reopenedQuantity).toBe('number');
    reopenedApi.cleanup();
    await reopened.close();
  });

  it('protects the original schema bytes when a number format is unsupported', async () => {
    const files = fixture();
    files['Inventory.md'] = files['Inventory.md']!.replace(
      '    - id: quantity\n      name: Quantity\n      type: number\n',
      '    - id: quantity\n      name: Quantity\n      type: number\n      format:\n        precision: 9\n',
    );
    const originalSchema = files['Inventory.md']!;
    const vault = new MemoryVault(files);
    const session = await open(vault);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const snapshot = api.snapshot(databaseId);

    expect(snapshot).toMatchObject({ status: 'unsupported', diagnostic: { code: 'database-unreadable' } });
    expect(api.patchCell({
      databaseId,
      rowId: idAt(session, 'Inventory/Widget.md'),
      propertyId: 'quantity',
      value: 3,
      expectedRevision: snapshot.revision,
    })).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(vault.text('Inventory.md')).toBe(originalSchema);
    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(vault.text('Inventory.md')).toBe(originalSchema);

    cleanup();
    await session.close();
  });

  it('rejects generic commands that change opted-in data/schema/identity while allowing navigation metadata', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const databaseId = idAt(session, 'Inventory.md');
    const widgetId = idAt(session, 'Inventory/Widget.md');
    const { api, cleanup } = apiFor(session);
    const database = session.getState().pages[databaseId]!.database!;
    const originalQuantity = session.getState().pages[widgetId]!.properties.quantity;
    const revisionBeforeNavigation = ready(api.snapshot(databaseId)).revision;

    expect(
      session.execute({ type: 'page.setProperties', id: widgetId, values: { quantity: 9 }, now: 5 }).ok,
    ).toBe(false);
    expect(session.execute({ type: 'page.rename', id: widgetId, title: 'Renamed', now: 5 }).ok).toBe(false);
    expect(session.execute({ type: 'page.move', id: widgetId, parentId: null }).ok).toBe(false);
    expect(
      session.execute({
        type: 'database.set',
        id: databaseId,
        database: { ...database, properties: database.properties.slice(1) },
        now: 5,
      }).ok,
    ).toBe(false);
    const ordinaryId = idAt(session, 'Archive.md');
    const all = session.executeAll([
      { type: 'page.setFavorite', id: ordinaryId, favorite: true },
      { type: 'page.setProperties', id: widgetId, values: { quantity: 9 }, now: 6 },
    ]);
    expect(all.ok).toBe(false);
    expect(session.getState().pages[ordinaryId]!.favorite).toBe(false);
    expect(session.getState().pages[widgetId]!.properties.quantity).toBe(originalQuantity);

    expect(session.execute({ type: 'page.markOpened', id: databaseId, now: 123 }).ok).toBe(true);
    expect(ready(api.snapshot(databaseId)).revision).toBe(revisionBeforeNavigation);
    await session.flush();
    cleanup();
    await session.close();
  });

  it('revisions follow external row changes and subscriber cleanup survives owner reload', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    let generation = 1;
    const oldHandle = apiFor(session, {
      ownerIsActive: () => generation === 1,
    });
    const oldEvents: DataApiSnapshot[] = [];
    oldHandle.api.subscribe(databaseId, (snapshot) => oldEvents.push(snapshot));
    expect(oldEvents).toHaveLength(1);
    const oldRevision = ready(oldEvents[0]!).revision;

    vault.external({
      'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace('Quantity: 2', 'Quantity: 4'),
    });
    expect(oldEvents).toHaveLength(2);
    expect(ready(oldEvents[1]!).revision).not.toBe(oldRevision);
    expect(ready(oldEvents[1]!).rows.find((row) => row.id === rowId)?.properties.quantity).toBe(4);

    generation = 2;
    oldHandle.cleanup();
    expect(oldHandle.api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 5,
      expectedRevision: oldRevision,
    })).toMatchObject({ status: 'error', code: 'owner-inactive' });
    expect(() => oldHandle.api.snapshot(databaseId)).toThrow(/no longer active/i);

    const newHandle = apiFor(session, { ownerIsActive: () => generation === 2 });
    expect(newHandle.api.snapshot(databaseId).status).toBe('ready');
    const countBefore = oldEvents.length;
    vault.external({
      'Inventory/Widget.md': E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace('Quantity: 2', 'Quantity: 6'),
    });
    expect(oldEvents).toHaveLength(countBefore);
    expect(ready(newHandle.api.snapshot(databaseId)).rows.find((row) => row.id === rowId)?.properties.quantity).toBe(6);

    newHandle.cleanup();
    await session.close();
  });

  it('rechecks provider and host read-only state for every cell patch', async () => {
    const vault = new MemoryVault(fixture());
    const session = await open(vault);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    let providerActive = false;
    let hostReadonly = false;
    const { api, cleanup } = apiFor(session, {
      isProviderActive: () => providerActive,
      isHostReadonly: () => hostReadonly,
    });
    const snapshot = ready(api.snapshot(databaseId));
    expect(snapshot).toMatchObject({ readonly: true, diagnostic: { code: 'provider-inactive' } });
    const patch = {
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: snapshot.revision,
    };
    expect(api.patchCell(patch)).toMatchObject({ status: 'error', code: 'provider-inactive' });
    providerActive = true;
    hostReadonly = true;
    expect(api.snapshot(databaseId)).toMatchObject({ readonly: true, diagnostic: { code: 'host-readonly' } });
    expect(api.patchCell(patch)).toMatchObject({ status: 'error', code: 'host-readonly' });
    hostReadonly = false;
    expect(api.patchCell(patch)).toMatchObject({ status: 'staged' });
    cleanup();
    await session.close();
  });

  it('removes both subscription listeners when the initial callback unloads the owner', async () => {
    const session = await open(new MemoryVault(fixture()));
    const databaseId = idAt(session, 'Inventory.md');
    const { api, cleanup } = apiFor(session);
    const ordinaryId = idAt(session, 'Archive.md');
    let notifications = 0;

    api.subscribe(databaseId, () => {
      notifications += 1;
      cleanup();
    });
    expect(notifications).toBe(1);

    expect(session.execute({ type: 'page.setIcon', id: ordinaryId, icon: '📌', now: 99 }).ok).toBe(true);
    await session.flush();
    expect(notifications).toBe(1);
    await session.close();
  });
});

describe('Polaris Dados source and row conflicts', () => {
  it.each([
    {
      change: 'property removal',
      mutate: (schema: string) =>
        schema.replace('    - id: quantity\n      name: Quantity\n      type: number\n', ''),
      diagnostic: 'unrepresentable-cell',
    },
    {
      change: 'property type change',
      mutate: (schema: string) =>
        schema.replace(
          '    - id: quantity\n      name: Quantity\n      type: number\n',
          '    - id: quantity\n      name: Quantity\n      type: text\n',
        ),
      diagnostic: 'unrepresentable-cell',
    },
    {
      change: 'reserved property name',
      mutate: (schema: string) => schema.replace('name: Quantity', 'name: TITLE'),
      diagnostic: 'ambiguous-schema',
    },
  ])('refuses to write rows after external $change would lose or reinterpret a cell', async ({ mutate, diagnostic }) => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const originalRow = vault.text('Inventory/Widget.md');
    const externalSchema = mutate(E003_POLARIS_DADOS_FIXTURE['Inventory.md']!);
    vault.external({ 'Inventory.md': externalSchema });

    const snapshot = api.snapshot(databaseId);
    expect(snapshot).toMatchObject({ status: 'unsupported', diagnostic: { code: diagnostic } });
    expect('rows' in snapshot).toBe(false);
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'price',
      value: 33,
      expectedRevision: snapshot.revision,
    })).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(session.queue.isDirty(rowId)).toBe(false);
    expect(vault.text('Inventory.md')).toBe(externalSchema);
    expect(vault.text('Inventory/Widget.md')).toBe(originalRow);
    expect(vault.applyCount).toBe(0);

    cleanup();
    await session.close();
  });

  it('marks a database read only on save conflict and emits queue changes until a flush succeeds', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    vi.useFakeTimers();
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const originalRow = vault.text('Inventory/Widget.md');
    const events: DataApiSnapshot[] = [];
    const unsubscribe = api.subscribe(databaseId, (snapshot) => events.push(snapshot));
    const initial = ready(api.snapshot(databaseId));
    const patch = api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    });
    expect(patch.status).toBe('staged');

    const externalRow = originalRow!.replace('Quantity: 2', 'Quantity: 4');
    vault.external({ 'Inventory/Widget.md': externalRow });
    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
    expect(ready(api.snapshot(databaseId))).toMatchObject({
      readonly: true,
      diagnostic: { code: 'save-conflict' },
    });
    expect(events.filter((snapshot) => snapshot.status === 'ready' && snapshot.readonly)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ readonly: true, diagnostic: { code: 'save-conflict' } });
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 4,
      expectedRevision: ready(api.snapshot(databaseId)).revision,
    })).toMatchObject({ status: 'error', code: 'save-conflict' });

    vault.external({ 'Inventory/Widget.md': originalRow! });
    expect(await api.flush(databaseId)).toMatchObject({ status: 'persisted' });
    expect(ready(api.snapshot(databaseId))).toMatchObject({ readonly: false, diagnostic: null });
    expect(events.filter((snapshot) => snapshot.status === 'ready' && snapshot.readonly)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ readonly: false, diagnostic: null });
    expect(vault.text('Inventory/Widget.md')).toContain('Quantity: 3');

    unsubscribe();
    cleanup();
    await session.close();
    vi.useRealTimers();
  });

  it('keeps the row draft and external schema bytes when its opted-in source schema changes', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    vi.useFakeTimers();
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    const result = api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    });
    expect(result.status).toBe('staged');
    const rowText = vault.text('Inventory/Widget.md');
    const rowMtime = vault.modifiedTime('Inventory/Widget.md');
    const externalSchema = E003_POLARIS_DADOS_FIXTURE['Inventory.md']!.replace(
      '    - id: quantity\n      name: Quantity\n      type: number\n',
      '',
    );
    vault.external({ 'Inventory.md': externalSchema });

    const flush = await api.flush(databaseId);
    expect(flush).toMatchObject({ status: 'error', code: 'save-conflict' });
    expect(vault.text('Inventory.md')).toBe(externalSchema);
    expect(vault.text('Inventory/Widget.md')).toBe(rowText);
    expect(vault.modifiedTime('Inventory/Widget.md')).toBe(rowMtime);
    expect(session.getState().pages[rowId]!.properties.quantity).toBe(3);
    expect(session.saveStatus.errorCode).toBe('save-conflict');
    const appliesAfterConflict = vault.applyCount;
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 4,
      expectedRevision: ready(api.snapshot(databaseId)).revision,
    })).toMatchObject({ status: 'error', code: 'save-conflict' });
    const ordinaryId = idAt(session, 'Archive.md');
    expect(session.execute({ type: 'page.setIcon', id: ordinaryId, icon: '📌', now: 99 }).ok).toBe(true);
    expect(session.queue.isDirty(ordinaryId)).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vault.applyCount).toBe(appliesAfterConflict);

    cleanup();
    await session.close();
    vi.useRealTimers();
  });

  it('refuses to write a staged row after its opted-in database file is deleted', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    vi.useFakeTimers();
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    });
    const rowText = vault.text('Inventory/Widget.md');
    const rowMtime = vault.modifiedTime('Inventory/Widget.md');
    vault.external({ 'Inventory.md': null });

    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
    expect(vault.text('Inventory.md')).toBeUndefined();
    expect(vault.text('Inventory/Widget.md')).toBe(rowText);
    expect(vault.modifiedTime('Inventory/Widget.md')).toBe(rowMtime);
    expect(session.getState().pages[rowId]!.properties.quantity).toBe(3);
    cleanup();
    await session.close();
    vi.useRealTimers();
  });

  it('preserves an external row version and stops automatic retry after a row-file conflict', async () => {
    const vault = new CountingMemoryVault(fixture());
    const session = await open(vault, 60_000);
    vi.useFakeTimers();
    const { api, cleanup } = apiFor(session);
    const databaseId = idAt(session, 'Inventory.md');
    const rowId = idAt(session, 'Inventory/Widget.md');
    const initial = ready(api.snapshot(databaseId));
    api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: initial.revision,
    });
    const externalRow = E003_POLARIS_DADOS_FIXTURE['Inventory/Widget.md']!.replace('Quantity: 2', 'Quantity: 4');
    vault.external({ 'Inventory/Widget.md': externalRow });

    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'save-conflict' });
    expect(vault.text('Inventory/Widget.md')).toBe(externalRow);
    expect(session.getState().pages[rowId]!.properties.quantity).toBe(3);
    expect(session.saveStatus.errorCode).toBe('save-conflict');
    const appliesAfterConflict = vault.applyCount;
    expect(api.patchCell({
      databaseId,
      rowId,
      propertyId: 'quantity',
      value: 4,
      expectedRevision: ready(api.snapshot(databaseId)).revision,
    })).toMatchObject({ status: 'error', code: 'save-conflict' });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vault.applyCount).toBe(appliesAfterConflict);

    cleanup();
    await session.close();
    vi.useRealTimers();
  });
});

describe('Polaris Dados canvas row boundary', () => {
  it('rejects canvas rows before exposing payload or staging edits and preserves the canvas file', async () => {
    const canvasText = JSON.stringify({ nodes: [], edges: [] });
    const vault = new CountingMemoryVault({
      ...fixture(),
      'Inventory/Board.canvas': canvasText,
    });
    const session = await open(vault, 60_000);
    const databaseId = idAt(session, 'Inventory.md');
    const canvasId = idAt(session, 'Inventory/Board.canvas');
    const canvasMtime = vault.modifiedTime('Inventory/Board.canvas');
    const writesBefore = vault.applyCount;
    const { api, cleanup } = apiFor(session);

    expect(session.getState().pages[canvasId]?.kind).toBe('canvas');
    expect(session.getState().pages[canvasId]?.parentId).toBe(databaseId);

    const snapshot = api.snapshot(databaseId);
    expect(snapshot).toMatchObject({ status: 'unsupported', diagnostic: { code: 'unrepresentable-cell' } });
    expect('schema' in snapshot).toBe(false);
    expect('rows' in snapshot).toBe(false);
    expect('history' in snapshot).toBe(false);
    expect(api.patchCell({
      databaseId,
      rowId: canvasId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: snapshot.revision,
    })).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(session.patchPilotDataCell({
      databaseId,
      rowId: canvasId,
      propertyId: 'quantity',
      value: 3,
      expectedRevision: snapshot.revision,
    })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(session.pilotDataHistoryChange({
      databaseId,
      direction: 'undo',
      expectedRevision: snapshot.revision,
    })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(session.queue.hasPending()).toBe(false);
    expect(session.queue.isDirty(databaseId)).toBe(false);
    expect(session.queue.isDirty(canvasId)).toBe(false);
    expect(await api.flush(databaseId)).toMatchObject({ status: 'error', code: 'unsupported' });
    expect(vault.text('Inventory/Board.canvas')).toBe(canvasText);
    expect(vault.modifiedTime('Inventory/Board.canvas')).toBe(canvasMtime);
    expect(vault.applyCount).toBe(writesBefore);

    cleanup();
    await session.close();
    const reopened = await open(vault, 60_000);
    const reopenedApi = apiFor(reopened);
    expect(reopenedApi.api.snapshot(idAt(reopened, 'Inventory.md'))).toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'unrepresentable-cell' },
    });
    expect(vault.text('Inventory/Board.canvas')).toBe(canvasText);
    expect(vault.modifiedTime('Inventory/Board.canvas')).toBe(canvasMtime);
    expect(vault.applyCount).toBe(writesBefore);
    reopenedApi.cleanup();
    await reopened.close();
  });
});
