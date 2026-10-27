# Internal design review

## What is the actual goal?

A local editable document/database workspace, using RPG, entertainment and finance as behavioral acceptance scenarios. Not a screenshot clone, nor an unrestricted reimplementation of every Coda Pack. Existing originals remain canonical and untouched during development.

## What could invalidate the approach?

1. Relations by title break with duplicates/renames. Persist stable references; disambiguate legacy values and report missing targets. Formula bindings need stable IDs too, with human-readable labels.
2. Formula type and display type are currently conflated. Preserve legacy formula columns while adding independent calculation/default configuration to typed fields. Never store a calculated output as if it were user input.
3. Multi-file actions can partially save. In-memory batching isn't durable atomicity. Explicit bounded actions require a journal/recovery contract before multi-row workflows are called safe.
4. Defaults can overwrite edits on recalculation. Evaluate once at creation, preserve explicit false/zero/empty and don't backfill existing rows without explicit user action.
5. Currency must not drift in installment totals. Use decimal-safe rounding/minor-unit allocation for financial operations; define percentage storage and duration units. Formatting doesn't imply correctness.
6. Embedded views can accidentally duplicate rows or recurse. Store source IDs and view settings separately, guard self-recursive embeds and distinguish deleting view from deleting source data.
7. Personal data might leak into fixtures. Reproduce schema/workflows with synthetic values, not exported financial rows or attachments. No source writes.
8. Source formula anomalies are not target requirements. Surface missing control diagnostics. Don't reproduce broken controls or numeric descriptions.
9. Markdown portability can be oversold. Ensure readable fallbacks and round-trip integrity; other editors need not execute this app's formulas. Don't let vanilla Morrow rewrite unsupported definitions destructively.
10. Icons have provenance. No compatible license located for Notion proprietary pack. Licensed catalog + custom files fulfills the interaction, but exact asset import must remain explicitly unfulfilled pending license.
11. Scope can exceed a single context. Use independently verifiable issues with dependencies, own worktrees and explicit interfaces. Principal integrates, checks acceptance and fixes regressions without recurring user approval.
12. User edits may run concurrently. Separate app/profile/update channel and test vault; don't open or change the live pilot. UI review only second monitor.

## Decisions

Implement main local column families, rich relational formulas, linked views, controls/results, table actions, authorable presentation and OKF safety. Canvas buttons remain lower priority/deferred per earlier explicit preference; table actions and synthetic multi-row workflows are included. No cloud collaboration, account-backed people/reactions, commercial Pack compatibility or automatic migration of source systems. Local person values may be relations to a People table; don't pretend this sends notifications.

Acceptance is UI-driven and reopen-driven, with headless core/session tests beneath it. Build evidence and known limitations must be recorded. No deadline/throughput promise or fabricated compatibility percentage.
