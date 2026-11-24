// Synthetic Markdown samples derived from published Morrow source. These are
// vault files, not IndexedDB databases; no numeric schemaVersion is embedded.

/**
 * Schema 12 source: f4146c8701a3fb00cc5b4648f4d6193cb02c11a1 declares
 * SCHEMA_VERSION = 12 and its pageFile databaseToYaml writer persists
 * `database.displayPropertyId`. The preceding published release was schema 11.
 */
export const E003_FORMAT12_DATABASE_PATH = 'Records 12.md';
export const E003_FORMAT12_ROW_PATH = 'Records 12/Widget.md';
export const E003_FORMAT12_DATABASE = `---
kind: database
database:
  displayPropertyId: name
  properties:
    - id: name
      name: Name
      type: text
  views: []
---
# Records 12
`;
export const E003_FORMAT12_ROW = `---
Name: Widget
---
Synthetic schema 12 row.
`;

/**
 * Schema 13 source: published tag v1.3.0-fork.1.2.0 at
 * 778c6b6ef7d30aad8678dbbbcb50fdcab6bc1106. Its pageFile writer persists
 * both `database.titleAlias` and `database.displayPropertyId`.
 */
export const E003_FORMAT13_DATABASE_PATH = 'Records 13.md';
export const E003_FORMAT13_ROW_PATH = 'Records 13/Widget.md';
export const E003_FORMAT13_DATABASE = `---
kind: database
database:
  titleAlias: Record
  displayPropertyId: name
  properties:
    - id: name
      name: Name
      type: text
  views: []
---
# Records 13
`;
export const E003_FORMAT13_ROW = `---
Name: Widget
---
Synthetic schema 13 row.
`;

/**
 * Published named-control writer: v1.3.0-fork.1.2.0
 * `src/core/markdown/serialize.ts` emits this exact inline span for a
 * `namedControl` node. It is isolated from other fork markers so the guard
 * reason proves this attribute is recognized on its own.
 */
export const E003_PUBLISHED_NAMED_CONTROL_PATH = 'Named control.md';
export const E003_PUBLISHED_NAMED_CONTROL = `# Named control

<span data-morrow-control="year">Year</span>
`;

/** Synthetic future Markdown field; deliberately not an IndexedDB version. */
export const E003_FUTURE_DATABASE_PATH = 'Future records.md';
export const E003_FUTURE_ROW_PATH = 'Future records/Widget.md';
export const E003_FUTURE_DATABASE = `---
kind: database
database:
  futureTitleMode: display-name-v2
  properties:
    - id: name
      name: Name
      type: text
  views: []
---
# Future records
`;
export const E003_FUTURE_ROW = `---
Name: Widget
---
Synthetic future-format row.
`;

/** Current candidate schema-3 Markdown shape used as the editable control. */
export const E003_CURRENT_SCHEMA3_DATABASE_PATH = 'Current records.md';
export const E003_CURRENT_SCHEMA3_DATABASE = `---
kind: database
database:
  properties:
    - id: name
      name: Name
      type: text
  views:
    - id: table
      name: Table
      type: table
      columns: [name]
---
# Current records
`;
