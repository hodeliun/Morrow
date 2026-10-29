import { describe, expect, it } from 'vitest';
import type { DocNode } from '../model';
import { markdownToDoc } from './parse';
import { docToMarkdown } from './serialize';

function linkedViewMarker(envelope: Record<string, unknown>): string {
  return `<!-- morrow:linked-view:v1:${encodeURIComponent(JSON.stringify(envelope))} -->`;
}

function linkedViewEnvelope(markdown: string): Record<string, unknown> {
  const marker = /<!--\s*morrow:linked-view:v1:([^\s]+)\s*-->/.exec(markdown);
  if (!marker) throw new Error('Serialized linked view marker was not found.');
  return JSON.parse(decodeURIComponent(marker[1]!)) as Record<string, unknown>;
}

describe('reversible toggle persistence', () => {
  it('round trips open and closed details state', () => {
    const open: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { open: true },
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'Expanded section' }] },
            { type: 'detailsContent', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
          ],
        },
      ],
    };
    const closed: DocNode = {
      ...open,
      content: open.content?.map((node) => ({ ...node, attrs: { open: false } })),
    };

    const openMarkdown = docToMarkdown(open);
    const closedMarkdown = docToMarkdown(closed);

    expect(openMarkdown).toContain('<details open>');
    expect(markdownToDoc(openMarkdown)).toEqual(open);
    expect(closedMarkdown).toContain('<details>');
    expect(closedMarkdown).not.toContain('<details open>');
    expect(markdownToDoc(closedMarkdown)).toEqual(closed);
  });

  it('keeps legacy details without an open attribute closed', () => {
    const reopened = markdownToDoc(
      '<details>\n<summary>**Legacy** &lt;u&gt;</summary>\n\nContent\n\n</details>',
    );

    expect(reopened.content?.[0]?.attrs?.open).toBe(false);
    expect(reopened.content?.[0]?.content?.[0]?.content).toEqual([
      { type: 'text', text: '**Legacy** <u>' },
    ]);
    expect(docToMarkdown(reopened)).toContain('<details>');
    expect(docToMarkdown(reopened)).not.toContain('<details open>');
  });

  it('validates detail block IDs before writing or restoring HTML attributes', () => {
    const safe: DocNode = {
      type: 'doc',
      content: [
        {
          type: 'details',
          attrs: { blockId: 'stable-block-id' },
          content: [
            { type: 'detailsSummary', content: [{ type: 'text', text: 'Section' }] },
            { type: 'detailsContent', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }] },
          ],
        },
      ],
    };
    const invalid: DocNode = {
      ...safe,
      content: safe.content?.map((node) => ({ ...node, attrs: { blockId: 'x" onmouseover=alert(1)' } })),
    };
    const invalidTableMarker: DocNode = {
      ...safe,
      content: safe.content?.map((node, index) =>
        index === 0 ? { ...node, attrs: { tableToggleTitle: 'attacker-title' } } : node,
      ),
    };

    const safeMarkdown = docToMarkdown(safe);
    const invalidMarkdown = docToMarkdown(invalid);
    const invalidTableMarkerMarkdown = docToMarkdown(invalidTableMarker);

    expect(safeMarkdown).toContain('data-block-id="stable-block-id"');
    expect(markdownToDoc(safeMarkdown).content?.[0]?.attrs?.blockId).toBe('stable-block-id');
    expect(invalidMarkdown).not.toContain('data-block-id=');
    expect(invalidTableMarkerMarkdown).not.toContain('data-morrow-table-toggle=');
    expect(
      markdownToDoc(
        '<details data-morrow-table-toggle="attacker-title">\n<summary>Section</summary>\n\nBody\n\n</details>',
      ).content?.[0]?.attrs?.tableToggleTitle,
    ).toBeUndefined();
    expect(
      markdownToDoc(
        '<details data-block-id="invalid id">\n<summary>Section</summary>\n\nBody\n\n</details>',
      ).content?.[0]?.attrs?.blockId,
    ).toBeUndefined();
  });

  it.each([true, false])(
    'preserves linked view collapse state and IDs in the Markdown marker (collapsed %s)',
    (collapsed) => {
      const doc: DocNode = {
        type: 'doc',
        content: [
          {
            type: 'linkedDatabaseView',
            attrs: {
              sourceDatabaseId: 'synthetic-database',
              blockId: 'synthetic-linked-view-block',
              view: {
                id: 'synthetic-linked-view',
                name: 'Synthetic view',
                type: 'table',
                filters: [],
                sorts: [],
                groupBy: null,
                dateProp: null,
                hidden: [],
                collapsed,
                collapseEnabled: false,
              },
            },
          },
        ],
      };

      const reopened = markdownToDoc(docToMarkdown(doc));

      const linkedView = reopened.content?.[0];
      const view = linkedView?.attrs?.view as Record<string, unknown> | null | undefined;
      expect(linkedView).toMatchObject({
        type: 'linkedDatabaseView',
        attrs: {
          sourceDatabaseId: 'synthetic-database',
          blockId: 'synthetic-linked-view-block',
          view: { id: 'synthetic-linked-view', collapseEnabled: false },
        },
      });
      expect(view?.collapsed ?? false).toBe(collapsed);
    },
  );

  it('retains opaque envelope/view data and untouched invalid known fields while changing collapse state', () => {
    const raw = {
      sourceDatabaseId: 'synthetic-database',
      blockId: 'synthetic-linked-view-block',
      futureEnvelope: { nested: { keep: ['value', 2] } },
      view: {
        id: 'synthetic-linked-view',
        name: 'Synthetic view',
        type: 'table',
        filters: [],
        sorts: [],
        groupBy: null,
        dateProp: null,
        hidden: [],
        collapsed: true,
        collapseEnabled: false,
        rowHeight: 9999,
        futureViewKey: { nested: { keep: true } },
      },
    };
    const parsed = markdownToDoc(linkedViewMarker(raw));
    const linked = parsed.content?.[0];
    expect(linked?.attrs?.view).not.toHaveProperty('rowHeight');
    expect(linked?.attrs?.view).not.toHaveProperty('futureViewKey');

    const changed = {
      ...parsed,
      content: parsed.content?.map((node) =>
        node.type === 'linkedDatabaseView'
          ? { ...node, attrs: { ...node.attrs, view: { ...(node.attrs?.view as object), collapsed: false } } }
          : node,
      ),
    };
    const reopened = linkedViewEnvelope(docToMarkdown(changed));
    const reopenedView = reopened.view as Record<string, unknown>;

    expect(reopened.futureEnvelope).toEqual(raw.futureEnvelope);
    expect(reopenedView.futureViewKey).toEqual(raw.view.futureViewKey);
    expect(reopenedView.rowHeight).toBe(9999);
    expect(reopenedView.collapseEnabled).toBe(false);
    expect(reopenedView).not.toHaveProperty('collapsed');
    expect(reopenedView).not.toHaveProperty('unsupportedConditionalFormats');
  });

  it('keeps opaque conditional rules ordered when supported rules are edited or removed', () => {
    const first = {
      id: 'first-rule',
      prop: 'score',
      op: 'gt',
      value: 10,
      scope: 'row',
      color: 'red',
    };
    const opaque = { id: 'future-rule', prop: 'score', futureStyle: { glow: true } };
    const removed = {
      id: 'removed-rule',
      prop: 'score',
      op: 'lt',
      value: 0,
      scope: 'cell',
      color: 'blue',
    };
    const parsed = markdownToDoc(
      linkedViewMarker({
        sourceDatabaseId: 'synthetic-database',
        blockId: 'synthetic-linked-view-block',
        view: {
          id: 'synthetic-linked-view',
          name: 'Synthetic view',
          type: 'table',
          filters: [],
          sorts: [],
          groupBy: null,
          dateProp: null,
          hidden: [],
          conditionalFormats: [first, opaque, removed],
        },
      }),
    );
    const linked = parsed.content?.[0];
    const view = linked?.attrs?.view as Record<string, unknown>;
    const rules = view.conditionalFormats as Array<Record<string, unknown>>;
    expect(rules.map((rule) => rule.id)).toEqual(['first-rule', 'removed-rule']);

    const collapseOnly = {
      ...parsed,
      content: parsed.content?.map((node) =>
        node.type === 'linkedDatabaseView'
          ? { ...node, attrs: { ...node.attrs, view: { ...(node.attrs?.view as object), collapsed: true } } }
          : node,
      ),
    };
    const collapseOnlyView = linkedViewEnvelope(docToMarkdown(collapseOnly)).view as Record<string, unknown>;
    expect(collapseOnlyView.conditionalFormats).toEqual([first, opaque, removed]);

    const edited = {
      ...parsed,
      content: parsed.content?.map((node) =>
        node.type === 'linkedDatabaseView'
          ? {
              ...node,
              attrs: {
                ...node.attrs,
                view: { ...(node.attrs?.view as object), conditionalFormats: [{ ...rules[0], color: 'green' }] },
              },
            }
          : node,
      ),
    };
    const serialized = linkedViewEnvelope(docToMarkdown(edited));
    const serializedView = serialized.view as Record<string, unknown>;

    expect(serializedView.conditionalFormats).toEqual([{ ...rules[0], color: 'green' }, opaque]);
    expect(serializedView).not.toHaveProperty('unsupportedConditionalFormats');
    expect(JSON.stringify(serialized)).not.toContain('unsupportedConditionalFormats');
    const reopened = markdownToDoc(linkedViewMarker(serialized));
    const reopenedRules = (reopened.content?.[0]?.attrs?.view as Record<string, unknown>)
      .conditionalFormats as Array<Record<string, unknown>>;
    expect(reopenedRules.map((rule) => rule.id)).toEqual(['first-rule']);
  });
});
