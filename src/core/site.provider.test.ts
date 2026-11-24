import { describe, expect, it, vi } from 'vitest';
import { newPageMeta } from './model';
import type { PageId, WorkspaceState } from './model';
import * as database from './database';
import { databaseHtml } from './site';

describe('static site database output for provider-owned banks', () => {
  it('shows stored values and formula source without calling the native evaluator', () => {
    const schema = {
      properties: [
        { id: 'quantity', name: 'Quantity', type: 'number' as const, options: [] },
        {
          id: 'total',
          name: 'Total',
          type: 'formula' as const,
          options: [],
          formula: "prop('Quantity') + 1",
        },
      ],
      views: [],
    };
    const bank = newPageMeta({
      id: 'bank' as PageId,
      parentId: null,
      kind: 'database',
      database: schema,
      extra: { polarisDados: { version: 1, provider: 'polaris-dados' } },
    });
    const row = newPageMeta({
      id: 'row' as PageId,
      parentId: bank.id,
      title: 'Widget',
      properties: { quantity: 4 },
    });
    const state: WorkspaceState = { pages: { [bank.id]: bank, [row.id]: row }, docs: {} };
    const evaluate = vi.spyOn(database, 'valueOf');

    const html = databaseHtml(state, bank, {
      href: (id) => `${id}.html`,
      assetPath: (id) => `${id}.bin`,
      titleOf: () => null,
      renderMath: undefined,
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(html).toContain('provider-fallback');
    expect(html).toContain('This export is read only.');
    expect(html).toContain('<details>');
    expect(html).toContain('4');
    expect(html).toContain("prop('Quantity') + 1");
    evaluate.mockRestore();
  });
});
