# Release execution checkpoint — 28 October 2026

Historical in-progress record; GitHub and final release evidence remain authoritative.

- Reviewed correction/support issues #46, #47, #48 and #50 are closed with public functional commits and scope-specific evidence. Parent #45 and release gate #49 remain open.
- Public work branch: `work/stabilization-1.1.1`, functional checkpoint `b8acef8`. Main and previously published releases have not been rewritten.
- Local release candidate `e9a8d29` sets package `1.2.1-fork.1.1.1`, fork 1.1.1, official base 1.2.1/`5e6392b`. It is an unpublished local checkpoint to consolidate with final release bookkeeping/media before push.
- Candidate `npm run check` passed 473 tests in 61 files, typecheck, lint and renderer/Electron/MCP builds. The 258 source/config/package inputs had identical SHA-256 `c3aa1d4ae55438b084a24cdb4a63bb641a2126c872ea30b84047b120402d0257` before/after; see the candidate check evidence. Raw logs are in the ignored release validation folder.
- Final original-twenty audit is assigned to the existing Luna max executor session `01a18196-cd0d-79e3-a429-75eb074cf5ad`. It owns verification scripts, new evidence and release-note text, with no app-source edit/build/publication rights in that assignment. The compiled candidate must remain stable during its runs.
- Follow-up ownership split: that session now owns audit scripts/reports and release-note text only. Editor media is assigned to `01a18125-1abb-7bf2-9eaa-2ae2c1f773f5` (new capture script and `editor-*` assets/provenance); data media to `01a18147-5167-7621-b83e-851fb9c9e345` (`data-*`). Both use isolated profiles, the same frozen candidate and no global clipboard. The audit run directory is `docs/evidence/stabilization-1.1.1/e9a8d29-20261028-gate49-aa4b900b/`.
- Before actual packaged launch, strengthen or manually enforce static artifact preflight: expected package version and trusted current main bundle inside `resources/app.asar` must be checked before any executable starts. Old packaged versions ignore the smoke flags, so checking runtime version only after launch is insufficient. `@electron/asar` 3.4.1 is already available, with `extractFile` and `createPackage`. This refinement belongs to #49 and has not yet been implemented at this checkpoint.
- Sol medium reviewer session `01a18108-35e3-7531-98a1-bd36e3b49a86` approved the correction deliveries and will review final acceptance/media/release claims.
- The orchestrator retains version/changelog, curated Git publication, main CI, packaging, actual packaged smoke, checksums, tag and GitHub release publication.
- Use a dedicated package output such as `release/v1.2.1-fork.1.1.1/`; do not overwrite earlier artifacts or personal installations. Actual packaged verification must use the explicit constrained smoke startup. Never run an installer wizard or generic packaged executable against the personal profile.
- The final gate still requires actual twenty-item results, reviewed media/notes since downloadable 1.0.1, final CI, Windows x64 NSIS/portable artifacts, real unpacked executable save/reopen smoke, checksums and verified published assets/tag.
- Preserve historical audit outputs and all failed attempts. The untracked historical user handoff is not part of the release staging set.

No release 1.1.1 is claimed as built or published by this checkpoint. No personal application installation or original vault has been modified.
