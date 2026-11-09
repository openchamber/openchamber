# A live run in an isolated dev instance

For a scenario that needs real OpenCode turns, sessions and extensions: the plain user path end to end, in a dev web instance that touches none of the user's own data.

Sections: *Isolate*, *Seed it*, *Drive the page*, *Stop*.

## Isolate

`bun run dev` alone reads and writes the user's real OpenChamber settings and OpenCode sessions. Start it from a fresh temp folder `D` (macOS: under `/private/tmp`, because the server stores real paths and `/tmp/x` becomes `/private/tmp/x`), with every `OPENCODE_*`, `OPENCHAMBER_*` and `GIT_*` variable removed and:

```
HOME=$D/home XDG_CONFIG_HOME=$D/xdg XDG_DATA_HOME=$D/data XDG_CACHE_HOME=$D/cache XDG_STATE_HOME=$D/state
BUN_INSTALL_CACHE_DIR=$D/cache OPENCHAMBER_DATA_DIR=$D/oc
OPENCODE_BINARY=/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode
OPENCHAMBER_HMR_UI_PORT=<ui> OPENCHAMBER_HMR_API_PORT=<api> bun run dev
```

Spawn it detached and keep its process group. Before the first write, `GET /api/session?directory=<the real checkout>` on the API port must return an empty list; anything else means the instance is not isolated, so stop.

## Seed it

All on the API port, `localhost`:

- **Project:** `git init` a folder in `D`, then `PUT /api/config/settings {projects:[{id,path,label}],activeProjectId}`.
- **Session:** `POST /api/session` (header `x-opencode-directory`, body `{title, location:{directory}, model:{providerID:'opencode', id:'big-pickle'}}`; Big Pickle needs no login), `POST /api/session-knowledge/sync {sessionId, directory}`, then `POST /api/session/:id/prompt {text}`. Sending a prompt puts the session in In work.
- **Extension:** `POST /api/guests {path}` installs from a folder, `PUT /api/guests/<id>/capabilities {granted:[...]}` approves it. The dev build reports the released version, so a package whose `openchamber.engines` asks for the next one fails with `host-too-old`: install a copy with the range lowered.

## Drive the page

Headless Chrome from `scripts/perf/cdp.mjs`, at `http://localhost:<ui>/`; wait until `document.body.innerText` is long (the first Vite compile takes about 20 seconds).

Vite serves the app's source modules, and a dynamic import of a module's URL returns the instance the app runs. So `Runtime.evaluate` can read, subscribe to and set any store without clicking:

```js
import('http://localhost:<ui>/@fs/<checkout>/packages/ui/src/stores/useUIStore.ts')
  .then((m) => m.useUIStore.getState().setOpenGuestPage('<extension id>'))
```

Build such URLs from the checkout path; `performance` resource entries stop at 250 and miss modules. Subscribing inside the page records every store change, which sampling from outside misses when a change lasts one batch.

An extension's frame is a separate `iframe` target: take it from `http://127.0.0.1:<debug port>/json` and evaluate there. Clicks go through the page target at the frame's rect plus the element's offset.

## Stop

Kill the dev server by its process group and Chrome by its own handle, then delete `D`.
