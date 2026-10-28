import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DatabaseDef, PropDef } from '../../../core/model';
import { encodeAttachmentValue } from '../../../core/propertyMedia';
import { MemoryVault } from '../../../storage/memoryVault';
import { WorkspaceSession } from '../../../storage/session';
import { VaultRepository } from '../../../storage/vaultRepository';
import { setSession } from '../../workspace';
import { PropertyDisplay, PropertyInput } from './PropertyValue';

describe('database property cell rendering', () => {
  it('renders a false checkbox formula result distinctly from an empty result', () => {
    const prop: PropDef = {
      id: 'is-published',
      name: 'Published',
      type: 'formula',
      options: [],
      formula: 'false',
      formulaResultType: 'checkbox',
    };
    const falseValue = renderToStaticMarkup(createElement(PropertyDisplay, { prop, value: false }));
    const emptyValue = renderToStaticMarkup(createElement(PropertyDisplay, { prop, value: null }));
    const trueValue = renderToStaticMarkup(createElement(PropertyDisplay, { prop, value: true }));

    expect(falseValue).toContain('role="checkbox"');
    expect(falseValue).toContain('aria-checked="false"');
    expect(falseValue).toContain('aria-label="Published"');
    expect(falseValue).toContain('<svg');
    expect(emptyValue).toBe('');
    expect(trueValue).toContain('aria-checked="true"');
  });

  it('renders an action as a disabled button cell when its formula says so', async () => {
    let nextId = 0;
    const opened = await WorkspaceSession.open(
      new VaultRepository(new MemoryVault(), () => `button${++nextId}`),
      { delayMs: 0 },
    );
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    const action: PropDef = {
      id: 'run',
      name: 'Run action',
      type: 'button',
      options: [],
      action: {
        label: 'Generate',
        icon: 'play',
        color: 'blue',
        disabled: { source: 'true', bindings: [] },
        steps: [{ id: 'step', type: 'resetControls', controlIds: ['month'] }],
      },
    };
    const database: DatabaseDef = { properties: [action], views: [] };
    const created = session.executeAll([
      { type: 'page.create', id: 'button-table', parentId: null, title: 'Actions', kind: 'database', database, now: 1 },
      { type: 'page.create', id: 'button-row', parentId: 'button-table', title: 'Row', now: 2 },
    ]);
    if (!created.ok) throw new Error(created.error);
    const html = renderToStaticMarkup(createElement(PropertyInput, {
      dbId: 'button-table', prop: action, row: session.getState().pages['button-row']!, editable: true,
    }));
    expect(html).toContain('class="button small table-action-button"');
    expect(html).toContain('aria-label="Generate: Row"');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('role="dialog"');
    await session.close();
  });

  it('shows formatted currency, percent, time, duration, progress and scale before edit', async () => {
    let nextId = 0;
    const opened = await WorkspaceSession.open(
      new VaultRepository(new MemoryVault(), () => `cell${++nextId}`),
      {
        delayMs: 0,
      },
    );
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    const imageBytes = new Uint8Array([1, 2, 3]);
    const savedFiles = await session.addFiles([
      {
        meta: { id: 'cover-image', name: 'portrait.png', type: 'image/png', size: imageBytes.byteLength, createdAt: 1 },
        data: imageBytes.buffer,
      },
      {
        meta: { id: 'reference-pdf', name: 'reference.pdf', type: 'application/pdf', size: imageBytes.byteLength, createdAt: 1 },
        data: imageBytes.buffer,
      },
    ]);
    if (!savedFiles.ok) throw new Error(savedFiles.error);
    const photo = encodeAttachmentValue([savedFiles.value[0]!])!;
    const files = encodeAttachmentValue([savedFiles.value[1]!])!;
    const richCanvas = JSON.stringify({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'A rich note' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One item' }] }] }] },
      ],
    });
    const properties: PropDef[] = [
      {
        id: 'cost',
        name: 'Cost',
        type: 'currency',
        options: [],
        format: { locale: 'pt-BR', currency: 'BRL', precision: 2 },
      },
      { id: 'share', name: 'Share', type: 'percent', options: [], format: { locale: 'pt-BR', precision: 0 } },
      {
        id: 'meeting',
        name: 'Meeting',
        type: 'datetime',
        options: [],
        format: { locale: 'en-US', timeZone: 'America/Sao_Paulo', dateStyle: 'short' },
      },
      {
        id: 'elapsed',
        name: 'Elapsed',
        type: 'duration',
        options: [],
        format: { locale: 'en-US', durationUnit: 'minutes' },
      },
      {
        id: 'progress',
        name: 'Progress',
        type: 'progress',
        options: [],
        format: { min: 0, max: 100, color: 'green', showValue: true },
      },
      {
        id: 'rating',
        name: 'Rating',
        type: 'scale',
        options: [],
        format: { min: 1, max: 5, scaleIcon: 'star', color: 'yellow' },
      },
      { id: 'note', name: 'Note', type: 'text', options: [] },
      { id: 'email', name: 'Email', type: 'email', options: [] },
      { id: 'phone', name: 'Phone', type: 'phone', options: [] },
      { id: 'website', name: 'Website', type: 'url', options: [], format: { linkLabel: 'Documentation' } },
      { id: 'photo', name: 'Photo', type: 'image', options: [] },
      { id: 'files', name: 'Files', type: 'file', options: [], media: { multiple: true } },
      { id: 'details', name: 'Details', type: 'richCanvas', options: [] },
      { id: 'source', name: 'Rich source', type: 'text', options: [] },
      {
        id: 'computedDetails',
        name: 'Computed details',
        type: 'richCanvas',
        options: [],
        fillMode: 'calculated',
        formula: 'prop("Rich source")',
      },
    ];
    const database: DatabaseDef = { properties, views: [] };
    const created = session.executeAll([
      { type: 'page.create', id: 'finance', parentId: null, now: 1, title: 'Finance', kind: 'database' },
      { type: 'database.set', id: 'finance', database, now: 1 },
      {
        type: 'page.create',
        id: 'row',
        parentId: 'finance',
        now: Date.parse('2026-01-01T03:00:00Z'),
        title: 'Payment',
        properties: {
          cost: 1234.5,
          share: 0.25,
          meeting: '2026-01-01T03:00:00Z',
          elapsed: 5400,
          progress: 60,
          rating: 3,
          note: 'first line\nsecond line',
          email: 'person@example.com',
          phone: '(11) 99999-0000',
          website: 'https://example.com',
          photo,
          files,
          details: richCanvas,
          source: richCanvas,
        },
      },
    ]);
    if (!created.ok) throw new Error(created.error);

    const html = properties.map((prop) =>
      renderToStaticMarkup(
        createElement(PropertyInput, {
          dbId: 'finance',
          prop,
          row: session.getState().pages.row!,
          editable: true,
        }),
      ),
    );
    expect(html[0]).toContain('R$');
    expect(html[0]).toContain('1.234,50');
    expect(html[1]).toContain('25%');
    expect(html[2]).toContain('12:00 AM');
    expect(html[3]).toContain('90 min');
    expect(html[4]).toContain('60');
    expect(html[5]).toContain('★★★');
    expect(html[6]).toContain('second line');
    expect(html[7]).toContain('person@example.com');
    expect(html[7]).toContain('href="mailto:person@example.com"');
    expect(html[8]).toContain('(11) 99999-0000');
    expect(html[8]).toContain('href="tel:11999990000"');
    expect(html[9]).toContain('https://example.com');
    expect(html[9]).toContain('Documentation');
    expect(html[10]).toContain('portrait.png');
    expect(html[10]).toContain('3 B');
    expect(html[10]).toContain('icon-button tiny danger');
    expect(html[11]).toContain('reference.pdf');
    expect(html[12]).toContain('A rich note');
    expect(html[12]).toContain('rich-canvas-preview');
    expect(html[14]).toContain('rich-canvas-preview is-readonly');
    expect(html[14]).toContain('A rich note');
    expect(html[14]).not.toContain('rich-canvas-toolbar');
    expect(html.slice(7, 10).every((cell) => !cell.includes('prop-cell-value'))).toBe(true);
    expect(html.slice(0, 6).every((cell) => cell.includes('prop-cell-value'))).toBe(true);
    expect(html.slice(7, 10).every((cell) => cell.includes('prop-cell-link') && cell.includes('<button'))).toBe(true);
    expect(html[6]).toContain('prop-textarea');
    expect(html.some((cell) => cell.includes('type="number"'))).toBe(false);
    await session.close();
  });

  it('renders typed formula lists, calculated relation labels, and formula errors', async () => {
    let nextId = 0;
    const opened = await WorkspaceSession.open(
      new VaultRepository(new MemoryVault(), () => `formula${++nextId}`),
      { delayMs: 0 },
    );
    if (!opened.ok) throw new Error(opened.error);
    const session = opened.value;
    setSession(session);
    const targetDatabase: DatabaseDef = {
      properties: [{ id: 'amount', name: 'Amount', type: 'number', options: [] }],
      views: [],
    };
    const ownerDatabase: DatabaseDef = {
      properties: [
        { id: 'related', name: 'Related', type: 'relation', options: [], relation: {
          targetDatabaseId: 'targets', multiple: true, isInverse: false,
          displayPropertyId: null, inversePropertyId: null, filters: [],
        } },
        { id: 'typed-list', name: 'Typed list', type: 'formula', options: [], formula: 'List(0, false, null, 1.5)' },
        { id: 'calculated-relation', name: 'Calculated relation', type: 'relation', options: [], fillMode: 'calculated', formula: 'thisRow.Related', relation: {
          targetDatabaseId: 'targets', multiple: true, isInverse: false,
          displayPropertyId: null, inversePropertyId: null, filters: [],
        } },
        { id: 'broken', name: 'Broken formula', type: 'formula', options: [], formula: '1 / 0' },
      ],
      views: [],
    };
    const created = session.executeAll([
      { type: 'page.create', id: 'targets', parentId: null, now: 1, title: 'Targets', kind: 'database' },
      { type: 'database.set', id: 'targets', database: targetDatabase, now: 1 },
      { type: 'page.create', id: 'target-row', parentId: 'targets', now: 2, title: 'Target title', properties: { amount: 4 } },
      { type: 'page.create', id: 'formulas', parentId: null, now: 3, title: 'Formulas', kind: 'database' },
      { type: 'database.set', id: 'formulas', database: ownerDatabase, now: 3 },
      { type: 'page.create', id: 'formula-row', parentId: 'formulas', now: 4, title: 'Formula row', properties: { related: ['target-row'] } },
    ]);
    if (!created.ok) throw new Error(created.error);
    const row = session.getState().pages['formula-row']!;
    const properties = session.getState().pages.formulas!.database!.properties;
    const html = properties.map((prop) => renderToStaticMarkup(createElement(PropertyInput, {
      dbId: 'formulas', prop, row, editable: true,
    })));
    expect(html[1]).toContain('0, No, , 1.5');
    expect(html[2]).toContain('Target title');
    expect(html[3]).toContain('formula-error');
    expect(html[3]).not.toContain('>0<');
    await session.close();
  });
});
