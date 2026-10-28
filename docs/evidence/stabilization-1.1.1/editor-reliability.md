# Editor, menus and icons: correction checkpoint

Issue: https://github.com/hodeliun/Morrow/issues/47

## Corrected behavior

Popover, menu, standard dialog, command palette and rich Canvas dialog now share portal ownership and layer ordering. Escape, outside click and focus restoration act on the appropriate layer. Custom property glyphs receive explicit bounded sizes without changing unsized page-icon contexts. Linked database NodeViews isolate interactive controls from document selection handling rather than suppressing renderer errors.

Independent Sol review approved the final code after identifying and fixing the Rich Canvas dialog that originally remained outside the new layer contract. Focused unit tests, typecheck, lint and script syntax checks passed.

## Actual UI verification

- Historical hidden runs for page options, linked views and property icons passed, including page-options Escape/focus and five collapse/expand cycles with reopening. Their JSONs remain separate in this directory.
- [Icon-only acceptance](editor-20-icon-acceptance.json) records real raster/SVG upload, type change/reset and reopening, with fixed bounds and preserved page icon.
- [Combined acceptance](editor-20-combined-acceptance.json) rechecks raster/SVG images with natural dimensions 200×400: property glyphs are 14×14 within 32×32 controls. The icon dialog is above its origin and works with ordinary mouse actions. It also verifies Rich Canvas layer order, Escape/focus, cancel without persistence, saving and reopening. Both launches recorded zero page errors and hidden windows.

The combined run used planning/code HEAD `43e4045` **plus uncommitted editor/table source**. The complete compiled `dist` and `dist-electron` fingerprint was `bff7b73840b019b3b771fa3a5fb7f77c84e5d1973c4bcdaabeb439f536e6d4f0` (3,596 files), identical before/after and reopening. No source-input fingerprint was available for that compilation; the evidence correctly leaves it null. This is behavior evidence for that compiled checkpoint, not a claim of a clean release commit or published version 1.1.1. Final integrated validation remains in #49.

All images, fixtures and profiles are synthetic. Native operating-system file dialogs and personal installations were not used.
