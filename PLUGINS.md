# Writing a Morrow plugin

A plugin is a folder in your vault at `.morrow/plugins/<id>/` with two files:

- `manifest.json`, which names the plugin
- `main.js`, a JavaScript module whose default export is a function

Morrow calls that function with its API when the plugin starts. Settings → Plugins lists every plugin in the
vault. Plugins stay off on each computer until **Turn on plugins on this computer** is switched on there,
and then each plugin is turned on by itself.

Plugins run inside Morrow with the same access to your notes Morrow has. Only add ones you trust.

## manifest.json

```json
{
  "id": "word-count",
  "name": "Word count",
  "version": "1.0.0",
  "description": "Counts the words on the open page.",
  "author": "You"
}
```

The folder's name is the plugin's id: letters, numbers, `-` and `_`.

## main.js

```js
export default function (morrow) {
  morrow.commands.add({
    id: 'count',
    name: 'Count the words on this page',
    shortcut: 'Mod+Shift+W',
    run: () => {
      const page = morrow.pages.current();
      if (!page) return morrow.notice('Open a page first.');
      const words = (morrow.pages.read(page.id) ?? '').split(/\s+/).filter(Boolean).length;
      morrow.notice(`${words} words`);
    },
  });

  morrow.slash.add({
    id: 'signature',
    title: 'Signature',
    description: 'Signs off a letter',
    markdown: 'Best wishes,\n\n**Me**',
  });

  // a function returned here runs when the plugin is turned off
  return () => {};
}
```

Everything a plugin adds goes away again when it is turned off or reloaded, so nothing needs cleaning up by
hand unless the plugin made it itself.

## The API

| Call                                                                  | What it does                                                                                         |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `morrow.version`, `morrow.plugin`                                     | Morrow's version and this plugin's id.                                                               |
| `commands.add({ id, name, shortcut?, run })`                          | A command in the search (Ctrl/Cmd+K), with an optional shortcut such as `Mod+Shift+W`.               |
| `slash.add({ id, title, description?, keywords?, markdown? , run? })` | An item in the `/` menu. It inserts `markdown`, or calls `run`.                                      |
| `providers.version`                                                   | Version of the database-provider namespace (`1`).                                                    |
| `providers.register({ id, apiVersion: 1, mount })`                    | Registers one database provider. Returns an unregister function.                                     |
| `pages.list()`                                                        | Every page: `{ id, title, path, tags, properties, parentId, kind }`.                                 |
| `pages.get(id)`, `pages.current()`                                    | One page, or the one open, in the same shape.                                                        |
| `pages.read(id)`                                                      | A page's text as Markdown.                                                                           |
| `pages.write(id, markdown)`                                           | Replaces a page's text. The earlier version stays in page history.                                   |
| `pages.create({ title, markdown?, parentId? })`                       | Makes a page and returns its id.                                                                     |
| `pages.open(id)`                                                      | Opens a page.                                                                                        |
| `editor.insert(markdown)`                                             | Immediately inserts at the current page editor. Returns `true` only when its guard accepts the edit. |
| `editor.selectedText()`                                               | The text selected in the page being edited.                                                          |
| `editor.insertion.version`                                            | Version of the asynchronous insertion namespace (`1`).                                               |
| `editor.insertion.capture()`                                          | Captures the current editor target before opening a picker; returns a handle or `null`.              |
| `onChange(listener)`                                                  | Calls `listener` whenever a page changes. Returns a function that stops it.                          |
| `notice(message)`                                                     | Shows a short message at the bottom of the window.                                                   |
| `styles.add(css)`                                                     | Adds CSS to the window.                                                                              |
| `storage.get()`, `storage.set(value)`                                 | The plugin's own settings, kept as `data.json` in its folder.                                        |
| `register(cleanup)`                                                   | Runs `cleanup` when the plugin is turned off.                                                        |

Every `add` returns a function that takes the thing away again.

### Asynchronous editor insertion

Capture the target before showing an asynchronous picker. The version 1 handle is opaque and exposes only
`version`, `insert(markdown)`, and `dispose()`. `insert()` is one-shot and returns `{ ok: true }` when the
captured editor and its coordinator accept the transaction, or `{ ok: false, reason }` when the target is
stale or the insertion is refused. `dispose()` releases the capture when the picker is cancelled or
unmounted. A failed or invalidated capture needs a new explicit capture; the old handle never becomes valid
again.

Blurring the editor to use the picker is allowed. Navigation, changing the target tab or pane, changing the
document or selection, entering read-only mode, switching workspace sessions, closing the page editor, or
unloading/reloading the plugin invalidates the handle. The host inserts into the captured editor instance;
it does not remap an old selection into a new document. `editor.insert(markdown)` remains available for an
immediate guarded insertion, but capturing a new focused editor after a picker closes does not provide the
same safety.

`{ ok: true }` confirms that the editor transaction passed the host coordinator and content guards in the
in-memory editor. It does not confirm that bytes reached the vault; normal autosave and the workspace save
queue remain responsible for persistence. On refusal, the target text, selection, and undo history remain
available for recovery or an explicit recapture.

### Database providers

A provider is selected by a database's `polarisDados` metadata. Registration belongs to the running
plugin instance; duplicate provider ids and unsupported API versions are rejected. The host mounts a
registered provider only for a matching opted-in database. Its public mount context is:

```ts
{
  element: HTMLElement,
  databaseId: string,
  data: DataApi,
  locale: 'pt' | 'en' | 'es',
  editable: boolean,
  signal: AbortSignal
  // linked views also receive a view handle bound to this note/view/source/mount
  view?: LinkedViewApi
}
```

`data` is scoped to that database and that mount. It exposes `version: 1`, `snapshot`, `patchCell`,
`history`, `subscribe`, and `flush`; calls for another database are rejected. When the view unmounts,
the provider is unregistered, or the plugin reloads, `signal` is aborted, subscriptions are removed,
and the scoped data handle becomes inactive. Return a cleanup function to remove listeners and resources
created outside `element`.

For a linked view, the optional `view` handle exposes the linked-view configuration and its local
undo/redo history. It is bound to the containing note, view ID, source database, and one mount generation.
Its `subscribe()` reports configuration changes without remounting the provider; its `flush()` uses the
workspace save queue. Multiple roots keep separate view handles while their scoped `data` handles point
at the same source database and share its row values and data history. Main database mounts omit `view`.

```js
morrow.providers.register({
  id: 'polaris-dados',
  apiVersion: 1,
  mount({ element, databaseId, data, locale, editable, signal }) {
    const onUndo = (event) => {
      if (event.key.toLowerCase() !== 'z' || !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const direction = event.shiftKey ? 'redo' : 'undo';
      const snapshot = data.snapshot(databaseId);
      if (snapshot.status === 'ready')
        data.history({ databaseId, direction, expectedRevision: snapshot.revision });
    };
    element.addEventListener('keydown', onUndo, { signal });
    element.dataset.locale = locale;
    element.dataset.editable = String(editable);
    return () => element.replaceChildren();
  },
});
```

The host sends focused undo/redo commands to the provider root as a non-bubbling `keydown` event. A
provider should consume the command even when its history is empty so the host does not undo an unrelated
page property. The host keeps opted-in databases out of the native renderer; if a provider is absent or
its mount fails, it shows raw values and formula source in a read-only fallback.

### Linked-view document block

The host preserves a linked view as a standalone Markdown comment, independent of whether its provider
is installed:

```md
<!-- morrow:polaris-dados-view:v1:<BASE64URL_UTF8_JSON> -->
```

The encoder writes compact UTF-8 JSON with the keys in the order shown and canonical unpadded base64url.
When a filter is present its keys are written in the order `propertyId`, `op`, `value`. The payload has
exactly these fields:

```json
{
  "version": 1,
  "viewId": "view-id",
  "sourceDatabaseId": "database-id",
  "title": "View title",
  "columnOrder": [],
  "filter": null
}
```

`filter` is either `null` or an object with exactly `propertyId`, `op: "gte"`, and a finite numeric
`value`. View and source IDs are non-empty strings of at most 128 characters, `title` is at most 300
characters, `columnOrder` contains at most 1,000 unique IDs, and the decoded JSON payload is at most
64 KiB. A page may not contain duplicate `viewId` values. Unknown or invalid markers remain protected
raw content, including noncanonical JSON or base64url. The editor shows an inert fallback with the saved
title and source ID when the view is unavailable. For a compatible source, the host mounts the registered
provider with scoped data and view APIs; the host does not evaluate formulas in the saved payload.

### Linked-view configuration and history API

The host's `LinkedViewApi` v1 binds one handle to a note, view ID, source database, and mount generation.
Its `snapshot()` returns the current config, an opaque revision, source status, diagnostics, readonly state,
and whether local config undo/redo is available. `patchConfig({ patch, expectedRevision })` changes only the
view title, property order, and numeric `gte` filter. `history({ direction, expectedRevision })` undoes or
redoes config changes without consuming database-data history or page-text undo. `subscribe(listener)`
returns a cleanup function; `flush()` asks the normal workspace save queue to persist staged changes.

`columnOrder` contains real schema property IDs. Listed IDs take priority, followed by the remaining
properties in schema order; the virtual row title stays first. An empty list uses schema order. Missing
property references remain in the saved config with a repair diagnostic and can be corrected explicitly.
The revision tracks config, source identity/schema, and handle lifetime; adjacent text, row values, source
path, and source title do not change it by themselves.

`staged` means the in-memory page document and open editors accepted the config; it does not mean the file
was saved. Only `flush()` returning `persisted` confirms the save queue completed. If a result has
`error` and `staged: true`, the accepted change still needs confirmation: keep the draft visible and retry
`flush()` after synchronization or save recovery. Do not present Cancel as though it rolled back that
accepted change. Config history keeps the latest ten before/after steps per view in the current session;
the saved config survives reopen, but the local undo/redo stack starts empty.

Removing the note/view, changing its source identity, losing the source after it was available, unloading
the owner, or closing the session makes the old handle inactive or terminal. Reconnecting after source
restoration requires a new handle. The host mounts compatible linked views and passes the bound handle in
the provider context. View configuration controls and source capture/insertion workflows belong to separate
integration slices.

## Trying changes

After editing `main.js`, press the reload button beside the plugin in Settings → Plugins. A plugin that
fails to start shows why there.
