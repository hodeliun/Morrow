# Table interaction and presentation checkpoint

Issue: https://github.com/hodeliun/Morrow/issues/48

The correction hides linked source titles completely while retaining restore/open controls, gives the six-dot grip selection/context/keyboard behavior, centralizes settings in a compact toolbar with accessible active-state counts, preserves property access in read-only mode, shares table styles between canonical inline and linked embeds, and aligns footer calculations with body cells by default and under explicit alignment.

## Verification

- Typecheck and build passed. Focused component tests passed in two files; the full unit suite at this checkpoint passed **473 tests in 61 files**. Script syntax, focused lint and diff checks passed.
- [Verified UI report](stabilization-tables-ui-verified.json) covers actual source-title hiding/restoration, independent naming and reopen, compact Options with setting discovery/counts, matching measured styles, calculation alignment after resize/scroll/freeze, grip click/Ctrl/Shift/context/keyboard/drag, and a real read-only database opened through Trash with immutable Markdown.
- The Enter test starts from a deselected row. The hidden-title test compares the actual title `Financeiro`. Read-only property controls are checked for access and disabled mutations. These strengthen three proof gaps found by independent review.
- [Initial report](stabilization-tables-ui.json) and its original screenshot remain historical evidence; they are **not** the final acceptance for those three strengthened checks.
- Independent Sol review approved the code and the corrected functional proof with no remaining blockers for this delivery.

The UI used the same stable compiled build, with harness fingerprint `8b03f42e9f20756961cabeca17bdf0285362837bbbd7cadbc30238fb3ebf2634`, zero renderer errors and hidden windows throughout. No source-input fence was captured for that build, so none is invented. The source was the pre-publication checkpoint plus uncommitted table/editor changes; the release gate must independently bind the final source and versioned build.

The style comparison uses the same source database and matching table-render configuration; view name and title visibility intentionally differ to exercise their independence. It establishes parity of the measured table/header/body/footer styles, not byte-identical view definitions.

All fixtures and screenshots are synthetic. The personal application and original notes were not used.
