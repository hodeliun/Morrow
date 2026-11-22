import { describe, expect, it } from 'vitest';
import { validateDoc } from './doc';
import { legacyFormulaDocIssue, LEGACY_FORMULA_NODE } from './legacyFormula';
import type { DocNode } from './model';
import { markdownToDoc } from './markdown/parse';
import { docToClipboardMarkdown, docToMarkdown } from './markdown/serialize';

function legacyResult(resultId: string, name: string): string {
  const payload = {
    resultId,
    pageId: 'finance-note',
    name,
    formula: '1 + 2',
    bindings: [{ kind: 'property', propertyId: 'amount', source: 'Amount', start: 0, end: 6 }],
    outputType: 'currency',
    format: { currency: 'BRL', locale: 'pt-BR', precision: 2 },
    futureField: { keep: true },
  };
  const encoded = encodeURIComponent(JSON.stringify(payload)).replaceAll("'", '%27');
  return `<span data-morrow-result="${encoded}" data-vendor="opaque" title="kept">${name.replaceAll('&', '&amp;')}</span>`;
}

function formulaNodes(doc: DocNode): DocNode[] {
  const found: DocNode[] = [];
  const visit = (node: DocNode) => {
    if (node.type === LEGACY_FORMULA_NODE) found.push(node);
    node.content?.forEach(visit);
  };
  visit(doc);
  return found;
}

describe('legacy inline formula results', () => {
  it('round trips the exact legacy span, fallback and neighboring marks as inert atoms', () => {
    const first = legacyResult('result-a', 'Revenue & tax');
    const second = legacyResult('result-b', 'Expenses');
    const source = `**Before ${first} after** and *${second}*`;
    const doc = markdownToDoc(source);
    const results = formulaNodes(doc);

    expect(results).toHaveLength(2);
    expect(results[0]?.attrs).toMatchObject({ raw: first, fallback: 'Revenue & tax' });
    expect(results[0]?.marks?.map((mark) => mark.type)).toEqual(['bold']);
    expect(results[1]?.attrs).toMatchObject({ raw: second, fallback: 'Expenses' });
    expect(results[1]?.marks?.map((mark) => mark.type)).toEqual(['italic']);
    expect(validateDoc(doc).ok).toBe(true);
    expect(docToMarkdown(doc)).toBe(`${source}\n`);
    expect(legacyFormulaDocIssue(doc)).toBeNull();
  });

  it('copies readable fallbacks instead of duplicating formula IDs', () => {
    const marker = legacyResult('result-copy', 'Projected total');
    const doc = markdownToDoc(`${marker}\n\nCopied paragraph`);
    const clipboard = docToClipboardMarkdown(doc);

    expect(clipboard).toContain('Projected total');
    expect(clipboard).not.toContain('data-morrow-result');
    expect(clipboard).not.toContain('result-copy');
  });

  it('keeps repeated IDs protected instead of silently remapping the legacy source', () => {
    const source = `${legacyResult('duplicate', 'First')} and ${legacyResult('duplicate', 'Second')}`;
    const doc = markdownToDoc(source);

    expect(formulaNodes(doc)).toHaveLength(2);
    expect(validateDoc(doc).ok).toBe(false);
    expect(() => docToMarkdown(doc)).toThrow(/duplicate legacy formula result ID/i);
  });

  it('refuses to attach a link mark to an atom whose legacy source cannot survive link resolution', () => {
    const doc = markdownToDoc(legacyResult('linked', 'Linked result'));
    const paragraph = doc.content![0]!;
    const atom = paragraph.content![0]!;
    const linked: DocNode = {
      ...doc,
      content: [
        {
          ...paragraph,
          content: [{ ...atom, marks: [{ type: 'link', attrs: { href: 'Other.md' } }] }],
        },
      ],
    };

    expect(validateDoc(linked).ok).toBe(false);
    expect(() => docToMarkdown(linked)).toThrow(/unsupported mark/i);
  });

  it('does not turn inline or fenced code into formula atoms', () => {
    const marker = legacyResult('literal', 'Literal result');
    const source = `Use \`${marker}\` as text.\n\n\`\`\`html\n${marker}\n\`\`\``;
    const doc = markdownToDoc(source);

    expect(formulaNodes(doc)).toHaveLength(0);
    expect(docToMarkdown(doc)).toContain(marker);
  });
});
