# Ticket 07 — principal UI review

The principal reviewed the implementation on a synthetic, isolated vault. Electron windows were hidden throughout, and no personal files or profiles were included.

## Verified

- Two embedded views used page controls for year/month filters and independent pending-state filtering. December 2026 displayed BRL 100 in all expenses and BRL 60 pending; changing controls to January 2027 displayed BRL 25 in both views and the calculated result in prose.
- Reopening preserved control values, filter configuration and the currency result. The three original synthetic row files remained byte-identical after control edits.
- Renaming a control from the UI preserved the formula binding and calculated total. Renaming a calculated result from its UI persisted.
- Slash insertion of a new control, changing its type to select, editing two options, saving and reopening persisted the definition and block. All tests asserted that no Electron window became visible.
- Visual inspection found that new inline controls had no scoped CSS. Added compact chip-like controls and a readable, keyboard-focusable configuration panel in `features.css`.
- The fast slash insertion/configuration path initially lost the new inline block: the control command could update workspace state before the editor's delayed document commit. The control now commits pending editor changes before changing its value, configuration or definition. The fast UI authoring/reopen scenario then passed.
- Full `npm run check` passed after the principal fixes: typecheck, ESLint, 264 tests in 32 files, renderer/Electron/MCP builds.

Local QA artifacts outside Git: `controls-result.json/png`, `controls-authoring-result.json`, `controls-editor.png`, and `controls-principal-check.log` under `local QA folder (excluded from Git)`. Drivers remain under the local Temp directory. The fixture contains invented financial values only.

## Next boundary

Table buttons, durable action recovery and conflict-aware undo belong to ticket 11. The final packaged pilot and user guide belong to ticket 12.
