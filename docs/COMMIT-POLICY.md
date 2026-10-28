# Commit and publication policy for this fork

Effective from 27 October 2026, at the maintainer's request. Applies to agents,
contributors and future deliveries. Existing published history is preserved.

## Unit of publication

Publish one commit per coherent, meaningful functional delivery. A delivery
includes its implementation, translations, tests, documentation, migrations and
corrections discovered while developing or validating it. Readers should be able
to understand the resulting behavior and revert that delivery as a unit.

A ticket, source requirement, file, development session or agent assignment is
not automatically a commit. Several related tickets may form one delivery; a
large requirement may justify several separately usable features. Avoid both
microcommits and a single enormous commit combining unrelated features.

Before starting a delivery, record the intended publication groups in its issue
or delivery plan. Identify the user-visible outcome and associated tickets for
each group. Adjust the groups if the actual scope changes; do not create extra
remote commits merely to follow the original ticket boundaries.

## Local checkpoints and remote history

1. Work on a local feature branch. Local checkpoint, WIP and fixup commits are
   allowed and encouraged when useful for recovery.
2. Before the first push, consolidate those unpublished checkpoints into the
   agreed functional commits. Include fixes to mistakes made during that same
   development cycle in the feature commit, rather than publishing a broken
   feature followed by repair commits.
3. Review the final diff and commit list against the target branch. Run the
   required checks on the consolidated result; each published delivery must be
   usable, with no known intermediate broken state. Include UI evidence where
   the project requires it.
4. Push only the curated commits. This applies to remote feature branches as
   well as main. Do not push WIP merely as an informal backup unless the
   maintainer explicitly requests that exception.
5. A PR containing one delivery should squash into one functional commit. A PR
   containing several meaningful deliveries may retain its curated commits;
   do not squash away useful boundaries merely to achieve one commit per PR.

Consolidation may rewrite **unpublished, agent-owned local commits only**. Inspect
the worktree and preserve other contributors' changes first. Never reset away
work to obtain a clean history. Do not rewrite main, force-push shared branches,
retag releases or rewrite previously published commits under this policy.
If checkpoints are already shared, preserve them and use the normal integration
process; an exception to rewrite shared history requires explicit authorization.

## Bug fixes and supporting changes

- A bug introduced and found before publishing a feature belongs in that
  feature's consolidated commit, including its regression test.
- A user-reported bug in a published version can form a meaningful fix commit.
- Bugs found in a review/test round should normally be published together as
  one verified correction delivery for that round, rather than one commit per
  small bug. Describe all corrected behaviors in the body and link the issues.
  Separate a correction only when independent urgency, risk or rollback needs
  justify doing so.
- Do not mix unrelated features into a correction batch. A standalone refactor
  is justified only if it is a substantial, useful prerequisite; routine cleanup
  stays with the delivery it supports.
- Batch a planning round's spec, tickets and tracker documentation into one
  documentation commit. A substantive policy update can also be one commit.
- Prefer including version/changelog updates in the delivery they identify.
  Separate release bookkeeping is acceptable when a release combines several
  deliveries; do not add one bookkeeping commit per file.
- **Upstream integration exception:** preserve the upstream commits and merge
  ancestry required by this fork's migration policy. Do not squash or rewrite
  official history to satisfy a commit-count target. Group our conflict
  resolution and related adjustments coherently around that integration.

## Messages and final review

Use an informative title such as `feat(database): add compact view controls`,
`fix(editor): correct layout regressions from validation`, or
`docs: define interaction expansion and execution tickets`.

The body explains what now works, why the group belongs together, associated
issues and validation. Avoid titles such as `fix`, `WIP`, `adjust again` or
agent/session names. Do not use closing keywords for tickets whose acceptance
criteria remain unverified.

Before publishing, confirm: each commit describes a meaningful outcome; routine
fixups are absorbed; all affected tickets and verification are traceable; no
unrelated or personal material is included. Report the published functional
groups to the maintainer, rather than the number of local checkpoints.
