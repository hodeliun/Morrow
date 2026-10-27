# Issue #1 — public fork migration

Verified on 2026-10-26.

## Source and branch

- The published Polaris tree was prepared from private source commit
  `9c96ed85cee9962a12867d6da3bdee2fe0fcb905`; its source tree matched when
  fetched into an isolated public-fork checkout.
- The private Polaris history contains personal author metadata. To avoid
  publishing it, the migration uses one sanitized snapshot commit,
  `3457e822436e682371b713998c1c89bfb4479d5d`, directly on public upstream
  commit `0e630ccea927174a655404b7769b793f0a64e403`. The private commits are not
  ancestors of the published branch.
- `polaris` was pushed to
  https://github.com/hodeliun/Morrow/tree/polaris. After verifying the tree and
  documentation, GitHub's default branch was set to `polaris`. The original
  `main` remains at `0e630ccea927174a655404b7769b793f0a64e403`.
- The upstream source remains https://github.com/Aarav2709/Morrow. No pull
  request was opened upstream, and issues #2–#6 were not edited.

## Publication audit

- The migration review covered the changed-file inventory, repository
  instructions, package links, demo vault, generated SVG assets, and historical
  evidence. Demo records and artwork are synthetic. User-specific names, local
  checkout paths, private tracker IDs, and private pilot details were removed
  from the public-facing documentation.
- A scan for common credential and private-key markers found no matches in the
  published tree. The Apache-2.0 license and upstream attribution are intact.
- The private source repository remained clean. No personal vault or profile
  was opened or written during this migration.

## Documentation changes

`AGENTS.md` and `docs/agents/issue-tracker.md` now point to this fork's Issues
and record how to merge reviewed upstream changes. `CONTRIBUTING.md`, package
metadata, and the Settings source-code link point to `hodeliun/Morrow`.
`docs/issues.json` now snapshots the six public issues; it contains no private
tracker identifiers.

## Verification

`npm run check` passed on the published code commit `3457e822436e682371b713998c1c89bfb4479d5d`:
typecheck, ESLint, 36 test files / 280 tests, and production renderer, Electron,
and MCP builds. Vite emitted an informational `INEFFECTIVE_DYNAMIC_IMPORT`
warning for `DatabaseView.tsx`, which is dynamically imported and also
statically imported by linked database components; the build succeeded.
