# Final original-scope acceptance protocol

Gate #49 runs after the correction deliveries and startup support are accepted. This checklist is a protocol, **not a passing report**. Record new results under a unique stabilization run; preserve the original audit and failed attempts.

Use the final versioned candidate, synthetic fixtures, hidden windows, listeners on every reopened renderer and stable build fingerprints. For every item link assertions and evidence of behavior, not just a label or a closed ticket. Source-level tests complement UI tests for invalid configurations that normal UI cannot generate.

| Original item | Required final behavior |
|---:|---|
| 1 | Block palette hues and custom HEX apply to the intended block and persist. |
| 2 | Quick filters, matching rows, reset and compact filter controls work. Include a narrow/multiple-filter sample or retain an explicit visual-coverage qualification. |
| 3 | Actual image context menu, caption, alignment, crop/recrop, cancel and replacement work; original synthetic source file remains unchanged. |
| 4 | Full-width page and menus remain within wide/narrow viewports; nested icon dialog is usable above its origin; Escape and focus act on the top layer. |
| 5 | Opt-in hierarchical heading collapse, nested content, disabling and reopening preserve the document. |
| 6 | Cell focus/edit/commit, Tab/Enter/arrows, clipboard and actual vertical and horizontal fill preserve other cells and undo correctly. |
| 7 | Portuguese column menu says Editar coluna and opens the intended settings. |
| 8 | Conditional formatting exposes palette/custom HEX and a real formula condition; only matching rows are colored after reopening. |
| 9 | Linked view collapse/expand and title hiding persist without renderer/document-selection errors or leaking the source name as a visible title. Restore/source access remains available. |
| 10 | Compact Options contains all requested sections, active filter/sort information, state toggles and linked references. Preserve read-only property access without enabling prohibited mutations. |
| 11 | Canonical inline embed and linked view of the same source/configuration/viewport match table/header/cell styles; independent names and view settings persist. |
| 12 | Independent per-column/per-view calculations persist. Footer and body alignment agree with defaults and explicit alignments, including resize, scroll and frozen columns. |
| 13 | Actual drag into an existing six-column group shows an indicator, creates the seventh column with moved content and persists; an eighth is refused. |
| 14 | Mouse and keyboard ranges, Delete and Backspace clear only selected cells, preserve rows and undo correctly. |
| 15 | Six-dot grip selects and opens row actions while preserving drag, filtered/multi-row and keyboard behavior. Insert/undo/insert, duplicate, copy/move, trash and recovery remain reliable after reopening. |
| 16 | Column types have icons and searchable localized names/aliases. |
| 17 | Formula references have visual tokens and related-column suggestions; keyboard insertion and persisted binding work. |
| 18 | Formula results expose the display-format options applicable to their selected result type, preserving zero/false versus empty. |
| 19 | Creating an inverse and linking existing populated relations work and persist. Unit/storage tests verify cardinality, limits and invalid/duplicate-ID rejection without partial schema changes. |
| 20 | Actual custom raster/SVG upload fits fixed header/settings slots, survives type changes/reset/reopen as appropriate, and preserves page icon rendering. |

## Release gate beyond the original twenty

- Run repository check and independent review on the integrated source; CI must pass on the final publication commit.
- Version base and fork separately. Notes cover everything since the last downloadable release 1.0.1, with genuine synthetic demonstrations and textual explanations.
- Capture media from the candidate's actual UI and record source/build provenance. Commit media and stable release prose before choosing the final tag target; final packaging must use identical reviewed source inputs.
- Build Windows x64 NSIS and portable artifacts. Run the real unpacked executable only through the constrained smoke seam, verify packaged status/paths/hidden windows and synthetic save/reopen. Inspect installer/payload and signing status without running its wizard.
- Publish checksums and actual artifact-validation results as release assets/notes. Verify tag target, uploaded files and published state. Do not replace the personal installation.
- Keep historical handoffs and original personal notes out of the publication staging set.
