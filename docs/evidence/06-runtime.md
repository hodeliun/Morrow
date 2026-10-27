# Ticket 06 — principal integration and UI verification

Reviewed by the principal; implementation by the assigned executor.

## Checks

- Integrated `npm run check`: passed, 253 tests in 29 files, typecheck, ESLint and renderer/Electron/MCP builds.
- Added format version 7 and the additive version-6 migration for linked blocks and independent view settings.
- Invisible isolated Electron tests used synthetic records only. All windows were checked as not visible; no user profile/vault or original app was touched.
- Two linked blocks chose the same source through the UI. Searching/filtering the first left the second and the source unfiltered. A cost edit from 3 to 9 propagated to both, including the filtered BRL sum.
- A 25-percent filter retained the display value 25 when reopened instead of rescaling the stored fraction. Source backlinks listed both views; slash insertion created another view.
- Closing/reopening preserved view state and data. Removing one linked block preserved both source row files.
- UI switched between gallery grouped by Status, board, list, calendar using a calculated date, and table. Both synthetic records appeared in the expected layouts.
- Conditional row color was authored from the UI and persisted after reopen. Review caught dark-theme descendant controls ignoring the computed foreground; scoped text variables now give `rgb(32, 33, 36)` over the light purple `rgb(246, 243, 249)`. The final screenshot was inspected.
- Count summaries render as counts, independently of a currency/percent/date column format. Date positioning is offered only for calendar layout.

## Local artifacts (not personal content; not committed)

Local QA artifacts outside Git: `views-result.json/png`, `view-layouts-result.json/png`, `views-integration-check.log`, and `views-polish-build.log`.
Temporary reproducible development drivers operate only on generated isolated QA vaults and are not included in this repository.

## Boundaries

Named controls and control-dependent filters are the next ticket; they are not claimed by this delivery. A source/column in active use must have its dependencies removed or retargeted before deletion. Removing a column without active dependencies preserves original row values as extra frontmatter. The full end-to-end demo and packaged final build remain ticket 12.
