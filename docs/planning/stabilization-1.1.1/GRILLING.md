# Internal critical review

- **Why another round after closed tickets?** The original-item audit demonstrated real partial behavior. Closed tickets are historical context, not a substitute for acceptance.
- **Should we update upstream again?** No evidence requires it. Preserve base 1.2.1; make attribution explicit.
- **Can the inverse error be skipped?** No. A new target property exists in a staged schema while pair validation reads the old state. Validate a coherent candidate and test atomic rejection; do not remove validation.
- **Is the row failure necessarily a product bug?** Not established. Diagnose journal/action readiness and distinguish test timing from rejected user actions. Preserve meaningful counts and recovery checks.
- **Could one extra z-index fix everything?** No. Modal/popover ownership, focus, outside click, Escape and raster dimensions require shared contracts and actual interaction tests.
- **What is the fair visual comparison?** Canonical inline embed and linked view of the same database, with the same view state and viewport; comparing a full-page source is insufficient.
- **What does the release include?** All user-visible fork work since downloadable 1.0.1, including unreleased 1.1.0, plus this stabilization. Windows x64 only is the chosen build scope.
- **Can screenshots prove behavior?** They illustrate it; tests and recorded interactions establish persistence, undo and errors. Use genuine synthetic data and no private source assets.
- **Can packaging touch the current installation?** No. Test isolated unpacked payload; describe installer coverage accurately. No user windows or native file dialogs.
- **Granularity/dependencies:** Three independently demonstrable correction groups; final acceptance/build/release blocked by all three. Shared table files require serialized ownership even where conceptual dependencies are absent.
- **Assumptions:** Fork patch 1.1.1, unchanged base 1.2.1, NSIS and portable x64, no new signing setup. These are implementation judgments, not invented user answers.
