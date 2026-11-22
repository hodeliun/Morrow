import { describe, expect, it } from 'vitest';
import { findUnrepresentablePageContent } from './compatibility';

function legacyResult(resultId = 'result-1', name = 'Total & tax', formula = 'Amount.Sum()'): string {
  const payload = {
    resultId,
    pageId: 'finance-note',
    name,
    formula,
    bindings: [{ kind: 'property', propertyId: 'amount' }],
    outputType: 'currency',
    format: { currency: 'BRL', precision: 2 },
  };
  const encoded = encodeURIComponent(JSON.stringify(payload));
  return `<span data-morrow-result="${encoded}" data-morrow-future="opaque">Total &amp; tax</span>`;
}

describe('legacy inline formula representability guard', () => {
  it('allows complete results only in ordinary root paragraphs with opaque attributes', () => {
    expect(findUnrepresentablePageContent(legacyResult())).toBeNull();
    expect(findUnrepresentablePageContent(`Before ${legacyResult()} after`)).toBeNull();
    expect(findUnrepresentablePageContent(`**Before** ${legacyResult()} *after*`)).toBeNull();
  });

  it.each([
    ['bold', '**'],
    ['italic', '*'],
  ])('protects a result atom that carries source %s formatting', (_name, delimiter) => {
    const source = `Before ${delimiter}${legacyResult()}${delimiter} after`;

    expect(findUnrepresentablePageContent(source)).toMatch(/legacy formula result.*formatting/i);
  });

  it.each([
    ['heading', (marker: string) => `# ${marker}`],
    ['list item', (marker: string) => `- ${marker}`],
    ['blockquote', (marker: string) => `> ${marker}`],
    ['table cell', (marker: string) => `| value |\n| --- |\n| ${marker} |`],
    ['HTML wrapper', (marker: string) => `<details><summary>Result</summary>\n\n${marker}\n\n</details>`],
    ['mixed media paragraph', (marker: string) => `Before ${marker} ![photo](photo.png)`],
    ['embedded file paragraph', (marker: string) => `Before ${marker} ![[scan.pdf]]`],
  ])('protects results in a %s context', (_name, build) => {
    expect(findUnrepresentablePageContent(build(legacyResult()))).not.toBeNull();
  });

  it('protects duplicate IDs and mixed, malformed or escaped marker source', () => {
    const duplicate = `${legacyResult('same')}\n\n${legacyResult('same')}`;
    const malformed = '<span data-morrow-result="%7Bbad-json%7D">fallback</span>';
    const unclosed = '<span data-morrow-result="%7Bbad-json%7D">fallback';
    const escaped = `\\${legacyResult('escaped')}`;
    const mixed = `${legacyResult('good')}\n\n# ${legacyResult('unsupported')}`;

    for (const source of [duplicate, malformed, unclosed, escaped, mixed]) {
      expect(findUnrepresentablePageContent(source), source).not.toBeNull();
    }
  });

  it('keeps the previous lexical guard for data-morrow attributes outside a recognized span', () => {
    expect(findUnrepresentablePageContent('[hidden]: https://example.invalid/data-morrow-control')).not.toBeNull();
    expect(findUnrepresentablePageContent('`<span data-morrow-control="opaque">`')).not.toBeNull();
  });

  it('protects result spans with line breaks instead of normalizing their raw bytes', () => {
    const marker = legacyResult();
    const crlfInTag = marker.replace(' data-morrow-future=', '\r\n data-morrow-future=');
    const crlfInFallback = marker.replace('Total &amp; tax</span>', 'Total\r\n&amp; tax</span>');

    expect(findUnrepresentablePageContent(crlfInTag)).not.toBeNull();
    expect(findUnrepresentablePageContent(crlfInFallback)).not.toBeNull();
  });

  it('enforces the published result ID, name, and formula length limits', () => {
    for (const marker of [
      legacyResult('x'.repeat(65)),
      legacyResult('bad/id'),
      legacyResult('valid', 'n'.repeat(101)),
      legacyResult('valid', 'name', 'f'.repeat(2001)),
    ]) {
      expect(findUnrepresentablePageContent(marker)).not.toBeNull();
    }
  });

  it('does not treat formula-looking inline or fenced code as active result nodes', () => {
    const marker = legacyResult('literal');
    const source = `Use \`${marker}\` here.\n\n\`\`\`html\n${marker}\n\`\`\``;

    expect(findUnrepresentablePageContent(source)).toMatch(/polaris data extension/i);
  });
});
