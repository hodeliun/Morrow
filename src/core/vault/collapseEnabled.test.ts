import { describe, expect, it } from 'vitest';
import type { DatabaseDef, ViewDef } from '../model';
import { newPageMeta } from '../model';
import { normalizeDatabase } from '../migrations';
import { composeFrontmatter, managedFrontmatter, readPageText, renderPageText } from './pageFile';

const view = (changes: Partial<ViewDef> = {}): ViewDef => ({
  id: 'synthetic-view',
  name: 'Synthetic view',
  type: 'table',
  filters: [],
  sorts: [],
  groupBy: null,
  dateProp: null,
  hidden: [],
  ...changes,
});

function roundTripView(current: ViewDef): { text: string; view: ViewDef } {
  const database: DatabaseDef = { properties: [], views: [current] };
  const page = newPageMeta({
    id: 'synthetic-database',
    parentId: null,
    title: 'Records',
    kind: 'database',
    database,
  });
  const frontmatter = managedFrontmatter(page, 'Records', null);
  const text = renderPageText(composeFrontmatter(frontmatter, {}, null), null, '');
  const reopened = readPageText(text);
  expect(reopened.error).toBeNull();
  return { text, view: reopened.database!.views[0]! };
}

describe('linked view collapse option persistence', () => {
  it.each([true, false])('round trips the explicit opt-out with collapsed=%s through YAML reopen', (collapsed) => {
    const result = roundTripView(
      view({ collapseEnabled: false, collapsed, search: 'preserve unrelated view options' }),
    );

    expect(result.text).toContain('collapseEnabled: false');
    expect(result.view.collapseEnabled).toBe(false);
    expect(result.view.collapsed ?? false).toBe(collapsed);
    expect(result.view.search).toBe('preserve unrelated view options');
  });

  it('leaves a legacy view without collapseEnabled unchanged and enabled by default', () => {
    const reopened = roundTripView(view({ id: 'legacy-view', name: 'Legacy', collapsed: true }));
    const legacy = normalizeDatabase({
      properties: [],
      views: [{ ...view({ id: 'legacy-view', name: 'Legacy', collapsed: true }) }],
    });

    expect(reopened.text).not.toContain('collapseEnabled:');
    expect(reopened.view.collapseEnabled).toBeUndefined();
    expect(reopened.view.collapsed).toBe(true);
    expect(legacy?.views[0]?.collapseEnabled).toBeUndefined();
    expect(legacy?.views[0]?.collapsed).toBe(true);
  });
});
