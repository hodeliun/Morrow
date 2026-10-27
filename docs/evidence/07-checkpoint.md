# Ticket 07 WIP checkpoint

- Work resumed after safe-stop checkpoints; scope remained the named-controls implementation slice.
- Implemented: page-scoped controls, formulas and linked-view filters; schema/frontmatter and Markdown persistence; control commands; inline UI; stable binding/identity remapping for page and block copies; read-only guards and diagnostics.
- Fixes found during resumed verification: preserve explicit formula bindings against same-name inference; compare boolean filter values without collapsing `false`; reject effectively trashed relation tables/rows; hide trashed relation targets and diagnose unavailable saved targets; accept formula punctuation in Markdown linked-view markers; show IDs in duplicate-name reference choices.
- Verified after these fixes: `npm run check` passed twice, including the final relation UI tweak (typecheck, lint, 32 test files/264 tests, web/Electron/MCP builds); the focused run passed (4 files/41 tests); `git diff --check` passed.
- Focused coverage includes paste identity cloning with internal/external references, page duplication, formula cycles and rename stability, false/zero/empty controls, relation single/multiple validation, two year/month linked views, BRL totals, no row mutation, and Markdown/frontmatter reopen.
- Final evidence is in `docs/evidence/07.md`; only the local ticket commit remains. No UI was launched, no personal data was used, and no issue was closed or work published.
