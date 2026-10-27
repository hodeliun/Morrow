# Morrow

Public derivative of Morrow v1.2.1 (Apache-2.0), integrated through upstream commit
`5e6392bb6425924abd30eec8a99b42aa8c953577`. Preserve the original license and
attribution.

## Migration and upstream policy

- The reviewed source tree came from private source commit
  `9c96ed85cee9962a12867d6da3bdee2fe0fcb905`. It is published here as one
  sanitized snapshot based on the public upstream commit above because the
  private history contains personal author metadata. Do not publish that
  history or copy personal files into this repository.
- The product branch and default branch is `main`.
- Track the official base version and commit separately from `forkVersion` in
  `package.json`. The package version combines both; `CHANGELOG-FORK.md` records
  original fork changes and upstream syncs. Do not infer upstream coverage from
  the package's version alone.

- The upstream remote is `https://github.com/Aarav2709/Morrow.git`. For an
  upstream update, fetch and review upstream changes, then merge the selected
  upstream changes into `main` while preserving enhanced behavior. Never
  force-push over collaborators'
  work. Run `npm run check` after resolving an update.

## Authority and scope

- Active tracker: https://github.com/hodeliun/Morrow/issues. Specification:
  `docs/SPEC.md`; research: `docs/RESEARCH.md`; decisions:
  `docs/GRILLING.md`; historical ticket notes: `docs/tickets/`.
- Read the spec and relevant domain notes before implementation. `PAPEL:
  EXECUTOR` means execute only the assigned issue; do not restart planning or
  create sessions.
- Keep all examples synthetic. Never commit personal vaults, profiles,
  attachments, credentials, account exports, or real records.
- Do not launch or restart apps or manipulate user windows. Use isolated test
  profiles and synthetic fixtures when runtime verification is necessary.
- Persist edits through the existing commands and save queue. Preserve YAML
  and unknown data. Unsupported formats must fail safely rather than silently
  discard content.
- Keep formula evaluation pure: no `eval`, arbitrary shell, network, filesystem
  writes, or action side effects.
- User-facing text is translated and accessible. For UI work, include UI
  verification as well as core tests.
- Run meaningful tests, typecheck and lint for changed scope; the integration
  gate is `npm run check`. Record evidence and limitations honestly.
- Do not close an issue until its acceptance criteria are verified. Never
  weaken tests to make them pass or use TODO placeholders as delivery.
