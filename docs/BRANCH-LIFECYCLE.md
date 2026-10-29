# Branches and completed-work cleanup

Keep `main` and the current development branch, `implementation/scope-2`, while
the second scope is in progress. A branch's age or activity label alone is not
proof that it is safe to remove.

Before retiring a branch:

- Check open pull requests and attached worktrees. Never remove the active
  development branch or another checkout's branch.
- Prove its commits are ancestors of `main`, or verify equivalent patches already
  exist in `main`. Preserve original references in a verified recoverable Git
  bundle outside the public repository before removing divergent old references.
- Replace document, issue and comment URLs that use the old branch with immutable
  commit URLs. The target commits must remain reachable from `main`; validate the
  referenced files and directories before removing the old names.
- Keep working changes, staged changes, tags, upstream history and unrelated
  files intact. A branch cleanup does not authorize publishing unfinished code,
  resetting the checkout or rewriting shared history.

## Cleanup authorized on 29 October 2026

The five old `issue-2-*` through `issue-6-*` branches have patch-equivalent
corrections in `main`. Both `planning/scope-2-*` branches and
`work/stabilization-1.1.1` are already incorporated by ancestry. The original
references and commit identities were captured in a private bundle and verified.

Local `integrate-upstream-1.2.1` and `work/interaction-expansion-2026-10`, along
with the local copies of those planning/stabilization branches, are also already
ancestors of `main`. No open pull request depends on these branches, and the
only checkout uses `implementation/scope-2`.

This maintenance delivery contains documentation links only. The active scope-2
implementation remains separate work in progress; branch cleanup is not ticket
acceptance, a product release or permission to install the application.
