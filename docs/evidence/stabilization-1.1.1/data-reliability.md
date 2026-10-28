# Data reliability correction checkpoint

Issue: https://github.com/hodeliun/Morrow/issues/46

## Corrected behavior

- New inverse-relation validation reads the complete proposed schemas, including the newly created target property, rather than the previous workspace state.
- Creating an inverse rejects a full 200-property target, an invalid explicit property ID or a duplicate target ID before staging the new schema. Rejection preserves both databases and their values.
- Recovery recognizes the storage normalization of an action-created empty row title to `Untitled`. This equivalence is restricted to new rows from table actions; unrelated edits still prevent destructive undo.

## Evidence and review

The three focused core/storage suites passed 29 tests after the final correction. Typecheck, focused lint and diff checks passed. Independent Sol code review found the original property-limit and explicit-ID gaps; both were fixed with atomic-rejection regressions and the final code was approved.

[Hidden UI run](delivery5-ui-2026-10-28T16-05-33-161Z-58644.json) verifies insert-before/undo/insert-after, row reorder, duplicate/move/trash and recovery, plus actual creation of an inverse with a generated ID, existing relation projection and persistence after reopening. It recorded no renderer errors and only hidden windows. The harness checks journal completion, identity, action label and settled undo before the next action; it does not relax row-count assertions.

The tested build was `1.2.1-fork.1.1.0`, planning HEAD `7e26c1f` **plus uncommitted correction source**, identified by compiled artifact hashes in the JSON. It included the main inverse and recovery fixes but not the later 200-property/explicit-ID guards. Those guards have source-level regression coverage; the final release gate must build and verify the integrated candidate before publication. This checkpoint is not a claim that release 1.1.1 has been built or published.

Historical audit evidence remains unchanged. Fixtures and profiles are synthetic; no personal installation or original notes were used.
