# Runtime isolation check

2026-10-26, runtime verification after the app identity changes.

Launched compiled development Electron using Playwright with MORROW_HIDDEN=1 and a separate synthetic QA profile/vault. Runtime reported app name Morrow Polaris and kept all windows invisible. The renderer initialized and the synthetic note was discoverable; no pageerror events occurred. Closed the test process cleanly.

Local evidence outside Git: baseline-result.json and baseline.png in the local QA folder. No personal content is included. This validates development runtime isolation, not the final packaged build or later feature acceptance.
