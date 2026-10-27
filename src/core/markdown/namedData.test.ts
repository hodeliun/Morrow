import { describe, expect, it } from 'vitest';
import type { DocNode } from '../model';
import { markdownToDoc } from './parse';
import { docToMarkdown } from './serialize';

describe('named data markdown', () => {
  it('round trips named controls and calculated results in readable inline spans', () => {
    const doc: DocNode = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Year: ' },
          { type: 'namedControl', attrs: { controlId: 'year', label: 'Year' } },
          { type: 'text', text: ' total ' },
          {
            type: 'calculatedResult',
            attrs: {
              resultId: 'total',
              name: 'Grand total',
              formula: "Expenses.filter(Year(CurrentValue.Date) = `Selected Year`).Amount.sum()",
              bindings: [{ kind: 'control', pageId: 'summary', controlId: 'year-control', start: 48, end: 63, source: '`Selected Year`' }],
              outputType: 'currency',
              format: { currency: 'BRL', locale: 'pt-BR', precision: 2 },
              pageId: 'summary',
            },
          },
        ],
      }],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toContain('<span data-morrow-control="year">Year</span>');
    expect(markdown).toContain('data-morrow-result=');
    expect(markdownToDoc(markdown)).toEqual(doc);
  });
});
