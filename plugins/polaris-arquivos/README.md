# Polaris Arquivos

Polaris Arquivos adds a read-only file and folder catalog below the note tree in the Morrow sidebar. It lists names from the active vault, expands folders, and loads metadata in pages of up to 200 entries. Filters can show selected or all extensions, include extensionless files or vault attachments, search known and discovered types, and add a custom extension. Preferences are stored in the local profile separately for each vault; the plugin does not write Markdown or vault files.

The plugin uses the host's session-scoped file catalog mount from Morrow #297 and its narrow, session-bound preference capability from #298. Discovered extensions are scanned from paged metadata only when the filter panel opens. Without the host catalog capability, the plugin stays inactive; it does not read file contents or open files.

## Build

From the repository root:

```sh
npm run build:polaris-arquivos
```

The build writes a self-contained ESM bundle to `dist/polaris-arquivos/main.js`. Install that bundle with this manifest in `.morrow/plugins/polaris-arquivos/` and enable **Polaris Arquivos** in the vault's plugin settings.
