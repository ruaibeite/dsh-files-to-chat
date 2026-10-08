# @ruaibeite/dsh-files-to-chat

**Right-click → "Add to conversation" in the right Sidebar file tree.** A file or folder
becomes an `@` reference in the current conversation's composer, and you can batch-insert a
whole multi-selection at once.

```
right-click any file / folder  →  Add to conversation   →  an @path reference lands in the draft
⌘/Ctrl+click to multi-select   →  right-click  →  Add N selected to conversation
```

中文说明见 [README.md](README.md)。

## What it does

| Action | Result |
| --- | --- |
| Right-click a file row | Menu: "Add to conversation" / "Copy path" |
| Right-click a folder row | Same, inserting a `@dir/` reference |
| ⌘/Ctrl + click | Add/remove that row from the selection (does not open the file) |
| Shift + click | Select the range from the last pick |
| Right-click inside a selection | Menu becomes "Add N selected to conversation" |
| Header chip | Appears in the file-tree header while a selection exists; `×` clears it |
| Escape | Close the menu; with no menu open, clear the selection |

A plain click keeps the file tree's own behaviour exactly (open a file, expand a folder) and
only clears the selection.

## What gets inserted

The `@` reference syntax itself — identical to picking a file from the built-in `@` menu:

- paths inside the workspace are written relative (`@iwcc/iwcc.sql`), outside it they stay absolute;
- paths containing whitespace use the closed-quote form (`@"my docs/a b.md"`, `@"ba docs/"`);
- a reference does **not** carry file contents: per `dsh-file-reference`, `@path` is just prompt
  text and the model still has to read the file with its own tools. Adding a reference is
  therefore cheap and never floods the context window.

## How it works

The official `dsh-client-ui-sidebar-files` renders its rows read-only
(`<li data-files-entry data-files-path>` wrapping a `<button>`), exposes no row-level slot, and
declares only the header seat `sidebar.right.tab.files.actions`. So this plugin:

1. registers into that header slot (Session scope), which is how it gets `sessionId`,
   `inputActions` and the owner-supplied `absolutePath` (the tree's displayed root = the
   session cwd);
2. resolves its own tab's tree root (`[data-files-root]`) from a zero-width anchor it renders
   in the header, then enhances rows through **capture-phase** `contextmenu` / `click` /
   `keydown` listeners — plain clicks stay entirely the tree's own semantics, only modified
   clicks are taken over;
3. paints its selection by tagging rows with `data-files-to-chat-selected` plus one injected
   stylesheet, so the official components are never rewritten.

Insertion degrades by availability, with two mutually-backup discovery routes:

- **Input face**: the standard `inputActions` prop handed to Session-scoped slot components;
  when it is absent, the plugin falls back to
  `ctx.sessions.scope(sessionId).get('conversation').input.for(scope)` — the input machine
  itself, i.e. the very object the `slash/input-insert-reference` listener calls.
- **Reference form**: the machine's `insertReference`, or the official
  `slash/input-insert-reference` event (the same path the `@` completion menu's pick takes,
  with the same payload shape `ui-reference` builds), producing a **real atomic reference
  chip** — glyph, whole-chip deletion and clipboard projection all owned by the official code.
  If neither is available it falls back to plain text via `inputActions.insertText(mention,
  span)`, the public face the official Voice Input plugin uses; the model-side semantics are
  the same.

Every reference uses the `draftRev` CAS from `captureInsertion()`: if the draft changed
underneath, the remaining references are copied to the clipboard with a notice instead of being
dropped, and a busy composer (submitting/adjudicating) takes the same clipboard path. After a
successful insert the keyboard returns to the composer (`machine.focus()`), caret right after
the new reference.

## Install

From the marketplace / GitHub:

```sh
dsh plugin --profile desktop add github:ruaibeite/dsh-files-to-chat
```

From a local checkout:

```sh
./install.sh                  # default profile: desktop
PROFILE_NAME=web ./install.sh # another profile
```

Then **restart Harness** — the browser half ships with the session bootstrap, so a page reload
alone is not enough. Confirm the row mounted:

```sh
dsh --profile desktop --dump-config | grep -A2 files-to-chat
```

## Known limits

- Only the official file tree's **rows** are enhanced (files and folders). `other` entries
  (sockets, device files…) are not readable, get no menu, and keep the system context menu.
- The multi-selection is this plugin's own component state: switching tabs, refreshing the
  tree or changing session clears it. That is deliberate — it is not the file tree's state and
  no other entry point can mutate it.
- A folder reference inserts `@dir/` only; it is not expanded into the files underneath.
- The plugin depends on the official row DOM contract (`data-files-entry` / `data-files-path` /
  `data-files-root`). If DSH renames those attributes the menu silently stops appearing rather
  than doing anything unexpected.

## Development

```sh
node test/mention.mjs   # pure functions: path relativization, @ syntax, batch building,
                        # both insertion routes and the clipboard degradation
```

`client/client.js` is a **hand-written** prebuilt client entry (`window.__ModuleLoader__.load`)
with no build step; restart Harness after editing.

## License

MIT
