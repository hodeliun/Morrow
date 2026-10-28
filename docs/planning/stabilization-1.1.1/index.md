# Stabilization 1.1.1

The original twenty-item audit is the acceptance source for this correction round. It found twelve passing and eight partial items. The maintainer authorized implementation, verification, Windows build and illustrated GitHub release on 28 October 2026.

- [Specification](SPEC.md) — [GitHub #45](https://github.com/hodeliun/Morrow/issues/45).
- [Internal critical review](GRILLING.md).
- [Data reliability](01-data.md) — [#46](https://github.com/hodeliun/Morrow/issues/46).
- [Editor, menus and icons](02-editor.md) — [#47](https://github.com/hodeliun/Morrow/issues/47).
- [Table interaction and presentation](03-tables.md) — [#48](https://github.com/hodeliun/Morrow/issues/48).
- [Integrated validation and release](04-release.md) — [#49](https://github.com/hodeliun/Morrow/issues/49), natively blocked by #46, #47, #48 and #50.
- [Isolated packaged smoke support](05-packaged-smoke.md) — [#50](https://github.com/hodeliun/Morrow/issues/50). Added after review established that development-only hidden/profile flags are ignored by packaged builds.
- [Release policy](../../RELEASE-POLICY.md).
- [Original-item audit](../../evidence/original-scope-audit-2026-10-28.md).

GitHub is authoritative for current status. Issues #46–#50 are native sub-issues of #45. The three correction tickets and startup-support ticket have no conceptual blocking edges; shared file ownership and build execution are serialized by the orchestrator. The release ticket starts only after all four pass. Startup support belongs to the final release publication group.

## Publication groups

1. Planning, original audit and durable release policy.
2. Reliable relation creation and row operations, including regression tests.
3. Editor layering, icon sizing and document selection, including regression tests.
4. Table interaction and consistent presentation, including regression tests.
5. Final version/changelog, integrated acceptance and illustrated release artifacts.

Local checkpoints are allowed, but unpublished fixups are consolidated within these groups before push. Never rewrite existing public history. Reuse the existing command/session/storage and UI seams; do not create parallel engines. Keep personal data, installations and windows untouched.
