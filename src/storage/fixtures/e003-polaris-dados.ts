// Synthetic fixture for the E003 P1 guard. No personal vault data is used.
export const E003_POLARIS_DADOS_FIXTURE: Record<string, string> = {
  'Inventory.md': `---
kind: database
polarisDados:
  version: 1
  provider: polaris-dados
database:
  properties:
    - id: name
      name: Name
      type: text
    - id: quantity
      name: Quantity
      type: number
    - id: price
      name: Price
      type: number
    - id: total
      name: Total
      type: formula
      formula: Quantity * Price
  views:
    - id: table
      name: Table
      type: table
      widths:
        name: 220
        quantity: 120
---
# Inventory
`,
  'Inventory/Widget.md': `---
Name: Widget
Quantity: 2
Price: 10
vendorRecord:
  id: opaque-widget-7f21
  audit:
    source: synthetic
    tags: [retain, nested]
---
Basic upstream row.
`,
  'Archive.md': `# Archive
`,
  'Archive/Legacy.md': `---
kind: database
futureDatabase:
  identity:
    id: legacy-schema-opaque-17
    nested:
      retained: true
database:
  properties:
    - id: amount
      name: Amount
      type: currency
      format:
        currency: BRL
        precision: 2
    - id: image
      name: Receipt
      type: image
      description: Fork-only image property
  views:
    - id: legacy-view
      name: Legacy view
      type: table
      futureFilterGroups:
        mode: OR
        id: future-view-group-13
---
# Legacy database
`,
  'Archive/Legacy/Row.md': `---
Amount: 12.50
Receipt: [[attachments/opaque-receipt-id]]
futureRow:
  id: opaque-row-991
  nested:
    preserve: true
---
Legacy row with unsupported typed values.
`,
  'Fork content.md': `---
title: Fork content
opaqueMetadata:
  ids:
    - unknown-frontmatter-id-91
  details:
    nested:
      keep: true
---
<!-- morrow:block-background:#2f80ed -->
<!-- morrow:heading collapsible collapsed -->
<!-- morrow:image align="right" width="35%" -->
<span data-morrow-control="opaque-control-id" data-morrow-page-id="opaque-page-id">Control</span>
<span data-morrow-result="opaque-result-payload">Result</span>
<!-- morrow:linked-view:v1:opaque-linked-view-id -->
![[attachments/fork-image.png]]
<div data-columns data-widths="35,65">
<p data-block-id="opaque-block-id" data-block-background="blue" data-morrow-summary-format="markdown" data-morrow-table-toggle="Opaque heading">Fork layout</p>
</div>
`,
  'attachments/fork-image.png': 'synthetic-image-payload-must-survive',
};
