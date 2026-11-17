import { describe, expect, it } from 'vitest';
import {
  findUnrepresentablePageContent,
  findUnrepresentableVaultMetadata,
} from './compatibility';

const basicDatabase = `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: name
      name: Name
      type: text
    - id: total
      name: Total
      type: formula
      formula: Quantity * Price
  views:
    - id: table
      name: Table
      type: table
      filters:
        - id: filter-1
          prop: name
          op: contains
          value: Widget
      sorts:
        - prop: name
          dir: asc
      widths:
        name: 220
---
`;

describe('vault representability guard', () => {
  it('allows upstream database fields and the reserved Polaris Dados v1 envelope', () => {
    expect(findUnrepresentablePageContent(basicDatabase)).toBeNull();
    expect(
      findUnrepresentablePageContent(
        basicDatabase.replace(
          '---\n# Inventory',
          'vendorRecord:\n  id: opaque\n  nested:\n    preserve: true\n---\n# Inventory',
        ),
      ),
    ).toBeNull();
  });

  it('rejects fork-only and nested database fields before normalization', () => {
    const unsupported = `---
kind: database
database:
  properties:
    - id: amount
      name: Amount
      type: currency
      format:
        currency: BRL
        precision: 2
---
`;
    expect(findUnrepresentablePageContent(unsupported)).toMatch(/database property/i);
  });

  it('rejects fork Markdown markers, custom data attributes, and unrepresentable extras', () => {
    for (const body of [
      '<!-- morrow:image align="right" width="35%" -->',
      '<!-- morrow:linked-view:v1:opaque-id -->',
      '<span data-morrow-control="control-1">Control</span>',
      '<span data-morrow-result="opaque-payload">Result</span>',
      '<div data-columns data-widths="35,65">layout</div>',
      '<p data-block-id="opaque-id" data-block-background="blue">Block</p>',
      '<details data-morrow-table-toggle="Older">Contents</details>',
    ]) {
      expect(findUnrepresentablePageContent(body)).not.toBeNull();
    }
    expect(findUnrepresentablePageContent('<!-- morrow:header-column -->\n| Name | Value |')).toBeNull();
    const oversizedExtras = Array.from({ length: 201 }, (_, index) => `extra${index}: value${index}`).join('\n');
    expect(findUnrepresentablePageContent(`---\n${oversizedExtras}\n---\nBody\n`)).toMatch(/frontmatter values/);
  });

  it('allows known Morrow workspace and recent metadata, rejects fields their readers discard', () => {
    expect(
      findUnrepresentableVaultMetadata(
        { version: 1, pages: { 'Inventory.md': { id: 'page-1', icon: 'archive', favorite: true } } },
        'workspace',
      ),
    ).toBeNull();
    expect(
      findUnrepresentableVaultMetadata(
        { version: 1, opened: { 'page-1': 20 }, activity: { '2026-11-11': 4 } },
        'recent',
      ),
    ).toBeNull();
    expect(
      findUnrepresentableVaultMetadata(
        { pages: { 'Inventory.md': { id: 'page-1', futureRegistryId: 'opaque' } } },
        'workspace',
      ),
    ).toMatch(/registry/);
    expect(findUnrepresentableVaultMetadata({ opened: {}, futureRecent: { id: 'opaque' } }, 'recent')).toMatch(
      /recent-items/,
    );
    expect(findUnrepresentableVaultMetadata(null, 'workspace')).toBeNull();
  });
});
