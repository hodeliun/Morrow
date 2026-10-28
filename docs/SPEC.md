# Morrow — local documents and relational databases

Current additive planning: [Aumento de Escopo 2](planning/scope-2-2026-10/index.md),
[specification #51](https://github.com/hodeliun/Morrow/issues/51). This new round
is planning-only; its tickets are not authorization to implement. The baseline
specification below is preserved as historical product context.

Status: implementation specification for the public Morrow fork. This supersedes the earlier planning-only proposals. Morrow is not affiliated with Coda or Notion; the upstream license and attribution are preserved.

## Problem

Users need the editing and navigation of RPG pages alongside database workflows for entertainment and finance in a local Markdown application. Current Morrow has an attractive editor but scalar same-row formulas, unscoped relation pickers, limited types, no embedded independent database views and insufficient page styling controls. The change must be usable through the application, durable on disk and safe for existing content.

## Solution

Keep Morrow's document/editor/storage architecture and add typed local databases with stable references, Coda-inspired formula semantics, linked views, controls/results in prose, explicit table actions, flexible page styling and structured metadata safety. Every feature has authoring UI, validation, readable persistence and reopen behavior. Use a separate product identity/profile/test vault. Three synthetic workspaces demonstrate RPG profile, entertainment tracking and financial planning without copying private data.

## Column matrix

All applicable types support column name/description, width, wrap/alignment, hide/reorder, sorting/filtering, default for new rows, calculated mode and copy/export. Read-only computed fields explain their source. Type conversion previews errors and preserves original data on failure; no silent coercion loss.

| Family | Editing and appearance | Value/calculation contract |
|---|---|---|
| Text/rich text | multiline, wrapping, URL/email/phone rendering and optional label | text functions; validation for specialized formats; no arbitrary HTML execution |
| Number | precision, separators, negative format, bounds and step | finite numeric values; null separate from zero; arithmetic and aggregates |
| Currency | currency code, locale, decimals, negatives, symbol | decimal-safe money operations; BRL example; rounding explicit |
| Percent | percent display and precision | store fraction, 0.25 → 25%; formula returns same typed numeric domain |
| Slider/progress/scale | min/max/step, colors, optional numeric label, rating icons | numeric result; progress may be calculated; no stored display strings |
| Date/time/datetime/duration | calendar/time input, locale and format, unit/fuso guidance | date-only without timezone shift; datetime explicit timezone; duration documented unit; date math |
| Checkbox | clear boolean UI | false differs from missing; false defaults survive |
| Select/multiselect | ordered colored options, configurable choices | IDs with labels, unique lists; calculated options/results validated |
| Relation | target database, single/multiple, display column, search and option filters, inverse | stable row IDs, row/list values, dot projection; legacy ambiguous titles reported |
| Image/file | local upload, thumbnail/preview/name/size, multiple attachments | local references survive reopen; missing-file state; no remote private data copied |
| Formula | field/function picker, autocomplete, typed preview and errors | pure calculation; retain legacy prop(); typed result supports display format |
| Created/modified timestamp | read-only system fields with date formatting | Created()/Modified() stable per row; not repeated defaults on read |
| Rich canvas cell | expandable editor with paragraphs/lists/images/links | structured document storage, not HTML stripped into text |
| Button in table | label/icon/color, disabled condition, action feedback | explicit actions only; reuse session; prevent double action; undo/recovery |

People as local directory relations and personal reactions/checkboxes can be modeled with existing types. Multi-user identities, notification delivery and account-based voting are not promised. Main types above are in scope; exact parity with all external Coda types/Packs isn't.

## User stories and acceptance

1. As a user, I can install/run this edition beside Morrow without sharing profiles, startup vaults or upstream auto-updates.
2. I can create a column with a type, description and display format and change those settings from the column menu.
3. I can set a literal or formula default evaluated once for a new row, while explicit submitted values take precedence.
4. I can calculate a column continuously without losing its output type/format, and distinguish default/manual/calculated modes.
5. I can preserve existing false/zero/empty values and existing rows when defaults change.
6. I can set currency/percent/precision/scale/step, date/time formats and text presentation, saved on reopen.
7. I can safely convert types with invalid values reported rather than discarded.
8. I can pick a target table for a relation, restrict its choices and select one or many rows.
9. I can configure the related display column and a linked inverse field and edit either side consistently.
10. I can reference thisRow.R1.Valor to read a related value; multiple relation values project to a list.
11. I can reference any database in the current vault by name through completion, including names with spaces.
12. I can chain Filter, projection, Sum/Average/Count/Min/Max, use CurrentValue/thisRow appropriately and retain typed rows.
13. I can use If, Switch, WithName, Contains, Unique, List, Sequence, FormulaMap/ForEach, First, IsBlank, ToNumber/ToText, Round/Floor/Mod and common date/text functions with documented semantics.
14. I can reference named controls from formulas and filters, including text, numeric/slider, select, checkbox, date and relation controls.
15. I can display a named calculated result inside a normal page (currency totals/progress included).
16. I get informative errors for missing references/types/cycles, with no silent zero substituted for failure.
17. I can rename referenced objects without breaking bound formulas and resolve duplicate names explicitly.
18. I can insert a linked database view into a normal document, select its source and edit values without copying rows.
19. Each view independently saves filters, AND/OR groups, sorts, grouping, widths, ordering, hidden columns and layout.
20. I can use visible quick filters/search, clear filters and see their active state in tables and embedded views.
21. I can navigate from a linked view to its source and from the source to a list of all its views.
22. Deleting a linked view doesn't delete data; deleting source/columns warns about dependent references and keeps recoverable state.
23. I can use table, board, gallery/card, list and calendar with consistent filtering; card layout supports status grouping and selected fields/image.
24. I can see numeric summaries (sum/average/count/min/max) and apply conditional row/cell colors with readable contrast.
25. I can create explicit table actions to add/update rows or reset controls; calculations alone never mutate data.
26. I can preview/disable actions, avoid duplicate activation and recover from partial multi-file failure; bounded multi-row creation keeps exact totals.
27. I can upload PNG/JPEG/WebP/SVG icons, choose emoji or search a licensed monochrome catalog, recolor vector icons and remove/reset choices.
28. Icons render consistently in the sidebar, page header, page links and row relations. Custom SVGs are sanitized and never execute scripts.
29. I can change/reposition cover image, preview and cancel/save; crop persists independently of image pixels.
30. Page links have subtle underline without blue badges; relations remain recognizable without filled chips, including keyboard focus and unresolved state.
31. I can apply a rounded full-width background to a paragraph/heading/block, independent of text highlighting and bounded by its column.
32. I can arrange portrait, description and navigation in editable columns, resize/reorder blocks and use existing toggles/media/links/tables without losing content.
33. I can set per-note font size, width, line height and paragraph spacing, with defaults for new notes and explicit apply-to-existing with preview/undo.
34. I can view/edit complex YAML safely, including list-of-object sources; unknown structures remain intact and unsupported values aren't silently flattened.
35. I can open OKF concepts while preserving type/provenance/path identity, inspect metadata in a collapsible section and get meaningful compatibility diagnostics.
36. I can export/read Markdown outside the app with readable fallbacks and descriptions of unsupported dynamic elements.
37. I can complete all synthetic RPG/entertainment/finance scenarios from UI and reopen unchanged, with original personal sources untouched.

## Architecture decisions

- Extend existing core/commands/session boundaries. Components don't write disk. Separate property type, display configuration, fill mode/default and calculation.
- Introduce additive versioned metadata/migrations; retain original legacy formulas and values. Unknown future content opens safely, not as an editable document that drops unsupported pieces.
- Stable IDs for row/table/property/control/view references. Persist human-readable expressions plus bindings; preserve bindings on renames and warn about ambiguity/deletion. Don't rely on fuzzy title resolution.
- Formula engine uses a bounded parser/interpreter with typed scalar/list/row/control values, lexical loop context and dependency cycle protection. No eval/network/filesystem/action side effects. Cache invalidation responds to referenced data/control changes and date/time dependencies.
- Linked views own configuration and reference the primary table; no copies of schema or records. Prevent recursive embedding.
- Expose format settings, calculations and initial defaults through coherent column UI. Shared schema changes affect all views; visibility/layout changes remain view-local.
- Explicit action executor validates all targets/disabled conditions at execution, batches commands and records recovery metadata before disk writes; user-visible undo handles intervening edits safely. Distinguish memory success from persisted success.
- Store attachments within isolated test vault; local import/sanitize; no automatic retrieval of protected/private originals.
- Icons: requested exact Notion pack has no verified redistribution license. Ship licensed recolorable catalog and upload support, keep exact pack as disclosed licensing exception. Do not call substitutes Notion assets.
- OKF metadata handling must preserve nested types, unknown fields, links and file paths. App extensions coexist without asserting standard OKF execution of dynamic content.
- Defaults for note styling are captured per new note/version. Global changes don't silently restyle existing notes; batch apply is explicit and reversible.

## Testing decisions

Use existing Vitest core/storage tests and command/session reopen boundaries, plus meaningful UI tests where appropriate. Add regression fixtures for complex YAML, false/zero/defaults, empty/multiple relations, rename/delete/duplicate/cycle semantics, mixed numeric values, datetime boundaries and financial cent allocation. Verify two linked views edit the same record while preserving independent filters. Test action failure/recovery and double click. Build/typecheck/lint, then verify actual UI with synthetic data only on second monitor. Record baseline upstream failures separately and fix relevant regressions. Measure representative 1k-row formulas/filters; avoid unbounded scans per cell and document observed performance rather than claim a target without measurements.

## Scenario acceptance

RPG: reproduce cover/icon/title + three-column portrait/characteristics/navigation, shaded headings, subpages, content blocks and calculated resource table with reusable authoring controls. Entertainment: create media rows, defaults, status/category/rating, progress and timestamps; view category cards grouped by status with filters. Finance: synthetic banks/invoices/categories/transactions; relation projections and inverse lists; yearly/monthly filtered totals controlled on-page; BRL and false defaults; table actions create bounded installments with exact cent total and recoverable writes. No source data changes or connection required to use the demo.

## Out of scope / explicit limits

Cloud collaboration, Coda authentication/Packs/Google Books network calls, arbitrary plugin marketplace, guaranteed full Coda syntax/import compatibility, scheduled execution while app closed, bank/payment integrations and automatic migration of real financial data. Canvas buttons are deferred in favor of controls and table buttons as previously requested. Exact Notion icon redistribution is conditional on a verified license. These are not claimed as completed capabilities.

## Delivery

Public fork and GitHub issues with native dependencies; separate Windows test build/profile, synthetic demo vault, guide and test/known-limitation report. Preserve original Morrow installations and user data. The principal verifies issue implementations before closing them.
