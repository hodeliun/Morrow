# Morrow

Public derivative of Morrow v1.3.0 (Apache-2.0), integrated through upstream commit
`13ce1908ac7777a16161b5ef0c013de5eadcb3a1`. Preserve the original license and
attribution.

## Migration and upstream policy

- The initial sanitized public snapshot was based on Morrow v1.2.1 at
  `5e6392bb6425924abd30eec8a99b42aa8c953577`, using reviewed private source
  `9c96ed85cee9962a12867d6da3bdee2fe0fcb905`. Its private history contains
  personal author metadata and must not be published. Later official updates
  preserve public ancestry; the current official base is identified above.
  Never copy personal files into this repository.
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

- Follow `docs/COMMIT-POLICY.md`: remote commits represent coherent functional
  deliveries, not local checkpoints or individual microtasks. Consolidate
  unpublished local fixups before pushing; preserve published history and
  upstream ancestry. Ticket boundaries do not mandate commit boundaries.
- Follow `docs/RELEASE-POLICY.md`: distinguish official-base and fork changes,
  explain changes since the last downloadable release, include genuine synthetic
  visual demonstrations, and verify final artifacts before publishing.

- Active tracker: https://github.com/hodeliun/Morrow/issues. Specification:
  `docs/SPEC.md`; research: `docs/RESEARCH.md`; decisions:
  `docs/GRILLING.md`; historical ticket notes: `docs/tickets/`.
- Read the spec and relevant domain notes before implementation. `PAPEL:
  EXECUTOR` means execute only the assigned issue; do not restart planning or
  create sessions.
- Keep all examples synthetic. Never commit personal vaults, profiles,
  attachments, credentials, account exports, or real records.
- Do not launch, restart or replace the user's personal installed apps, profiles
  or vaults, and do not manipulate the user's windows. Authorized implementation
  verification may launch a test build/Electron with a validated isolated profile,
  synthetic vault and hidden windows under the coordinator's build/test lease.
  This test exception does not permit personal clipboard access, visible windows,
  installation, unrelated apps or bypassing an actual tool permission rejection.
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

## Executor questions and escalation

- Route executor questions to the assigned reviewer/coordinator first, including
  evidence, options and a recommendation. Do not open user-input tools or ask the
  maintainer directly about implementation, tests, spec interpretation or shared
  ownership that the reviewer can resolve within the authorized scope.
- The reviewer records technical decisions without presenting them as user
  answers. Only the main coordinator asks the maintainer when an indispensable
  intention, inaccessible fact or human authorization remains missing.
- Continue independent work within the assigned mission while awaiting review.
  Forward any already-open question to the reviewer; do not invent a user answer
  or leave execution waiting on the maintainer after a technical resolution.
- Review does not replace human approval required by tools, authorize unrelated
  actions or permit bypassing a rejected operation.
- A technical status must name its reviewer recipient and clarify when no user
  answer is needed. Avoid ambiguous final messages such as "waiting for info"
  when the missing input is the reviewer's responsibility.
