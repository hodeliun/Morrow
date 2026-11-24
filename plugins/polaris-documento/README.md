# Polaris Documento

Polaris Documento restores the Polaris presentation for page links and database relation chips,
displays saved `morrowNoteStyle` values on their notes, and provides the per-note style controls with
a local preview. The host supplies typed, scoped reads and writes; the preview does not change the
page until Save is confirmed. Cancel, Escape, and plugin disable discard the local draft. External
links keep Morrow's normal `.prose a` styling because every page-link rule targets `.prose a.page-link`.

Open **Page style** beside an editable Markdown page title. Choose a font and width, then adjust text
size, line height, and block spacing. The sample previews comfortable, wide, and full widths at 68%,
84%, and 100% of its frame. Save confirms the style for that note; Restore applies the current profile
default. A save conflict keeps the draft open so it can be adjusted and retried.

Set the profile default in **Settings → Appearance → Default for new pages**. **Save default** updates
the profile without saving the open note; **Restore profile default** returns to the profile's general
font and width. The default applies to pages created afterwards. Existing notes keep their saved styles.

The plugin registers its theme-aware styles, per-note page-style panel, and Appearance defaults with
the host APIs. The host removes these contributions and their styles when the plugin is disabled or
reloaded. The per-note panel edits only the style field; it does not create pages or change note body text.

## Build

From the repository root:

```sh
npm run build:polaris-documento
```

The build writes a single self-contained ESM bundle to
`dist/polaris-documento/main.js`. The CSS is embedded in that bundle; there is no runtime import or
CSS sidecar. `manifest.json` is the plugin manifest.

## Install in a synthetic vault

Use a disposable test vault, never a personal Polaris vault. Set `MORROW_TEST_VAULT` to the path of
an empty vault that Morrow can open, then run these commands from the repository root:

```sh
npm run build:polaris-documento
mkdir -p "$MORROW_TEST_VAULT/.morrow/plugins/polaris-documento"
cp dist/polaris-documento/main.js plugins/polaris-documento/manifest.json \
  "$MORROW_TEST_VAULT/.morrow/plugins/polaris-documento/"
printf '{"enabled":["polaris-documento"]}\n' > "$MORROW_TEST_VAULT/.morrow/plugins.json"
```

Open that vault in Morrow, turn on plugins for the local computer, then turn on **Polaris
Documento** in Settings → Plugins. Disable and reload it from the same screen to verify that its
style is removed and reapplied. The plugin does not create or edit pages.

## Styling and provenance

The page-link and relation-chip rules adapt the legacy appearance in the published fork at
`778c6b6ef7d30aad8678dbbbcb50fdcab6bc1106` (`src/app/styles/editor.css`, `features.css`, and
`blocks.css`). The host continues to render resolved, missing, and unresolved states and to own
their semantics, focus targets, navigation, and relation actions. Polaris Dados can share these
rules once its relation renderer is implemented under #204.

All colors come from Morrow theme variables, so the same rules apply in light and dark themes.
