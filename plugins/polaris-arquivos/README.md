# Polaris Arquivos

Polaris Arquivos adds a read-only file and folder catalog below the note tree in the Morrow sidebar. It lists names from the active vault, expands folders, and loads metadata in pages of up to 200 entries. The Files page remains available for attachments and references.

The plugin uses the host's session-scoped file catalog mount from Morrow #297. Without that host capability, it stays inactive; it does not read file contents or open files.

## Build

From the repository root:

```sh
npm run build:polaris-arquivos
```

The build writes a self-contained ESM bundle to `dist/polaris-arquivos/main.js`. Install that bundle with this manifest in `.morrow/plugins/polaris-arquivos/` and enable **Polaris Arquivos** in the vault's plugin settings.
