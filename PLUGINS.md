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

| Call                                                                  | What it does                                                                           |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `morrow.version`, `morrow.plugin`                                     | Morrow's version and this plugin's id.                                                 |
| `commands.add({ id, name, shortcut?, run })`                          | A command in the search (Ctrl/Cmd+K), with an optional shortcut such as `Mod+Shift+W`. |
| `slash.add({ id, title, description?, keywords?, markdown? , run? })` | An item in the `/` menu. It inserts `markdown`, or calls `run`.                        |
| `providers.version`                                                   | Version of the database-provider namespace (`1`).                                     |
| `providers.register({ id, apiVersion: 1, mount })`                    | Registers one database provider. Returns an unregister function.                      |
| `pages.list()`                                                        | Every page: `{ id, title, path, tags, properties, parentId, kind }`.                   |
| `pages.get(id)`, `pages.current()`                                    | One page, or the one open, in the same shape.                                          |
| `pages.read(id)`                                                      | A page's text as Markdown.                                                             |
| `pages.write(id, markdown)`                                           | Replaces a page's text. The earlier version stays in page history.                     |
| `pages.create({ title, markdown?, parentId? })`                       | Makes a page and returns its id.                                                       |
| `pages.open(id)`                                                      | Opens a page.                                                                          |
| `editor.insert(markdown)`                                             | Inserts at the cursor in the page being edited.                                        |
| `editor.selectedText()`                                               | The text selected in the page being edited.                                            |
| `onChange(listener)`                                                  | Calls `listener` whenever a page changes. Returns a function that stops it.            |
| `notice(message)`                                                     | Shows a short message at the bottom of the window.                                     |
| `styles.add(css)`                                                     | Adds CSS to the window.                                                                |
| `storage.get()`, `storage.set(value)`                                 | The plugin's own settings, kept as `data.json` in its folder.                          |
| `register(cleanup)`                                                   | Runs `cleanup` when the plugin is turned off.                                          |

Every `add` returns a function that takes the thing away again.

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
}
```

`data` is scoped to that database and that mount. It exposes `version: 1`, `snapshot`, `patchCell`,
`history`, `subscribe`, and `flush`; calls for another database are rejected. When the view unmounts,
the provider is unregistered, or the plugin reloads, `signal` is aborted, subscriptions are removed,
and the scoped data handle becomes inactive. Return a cleanup function to remove listeners and resources
created outside `element`.

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
      if (snapshot.status === 'ready') data.history({ databaseId, direction, expectedRevision: snapshot.revision });
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

## Trying changes

After editing `main.js`, press the reload button beside the plugin in Settings → Plugins. A plugin that
fails to start shows why there.
