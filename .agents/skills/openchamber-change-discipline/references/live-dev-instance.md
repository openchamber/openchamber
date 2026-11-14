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

The variables go because a shell opened inside the desktop app (an agent's, the integrated terminal) inherits the app's server env: the LAN UI password, `OPENCHAMBER_RUNTIME=desktop`, `OPENCHAMBER_DIST_DIR`, the managed OpenCode's `OPENCODE_*`, with their names recorded in `OPENCHAMBER_INJECTED_ENV`. `bun run dev` drops every recorded name, an inline override included, so while that record survives, `OPENCODE_CONFIG=/tmp/x.json bun run dev` silently writes the user's real `opencode.json`. Never print the password variable.

Spawn it detached and keep its process group. Before the first write, `GET /api/session?directory=<the real checkout>` on the API port must return an empty list; anything else means the instance is not isolated, so stop.

## Seed it

All on the API port, `localhost`:

- **Project:** `git init` a folder in `D`, then `PUT /api/config/settings {projects:[{id,path,label}],activeProjectId}`.
- **Session:** `POST /api/session` (header `x-opencode-directory`, body `{title, location:{directory}, model:{providerID:'opencode', id:'big-pickle'}}`; Big Pickle needs no login), `POST /api/session-knowledge/sync {sessionId, directory}`, then `POST /api/session/:id/prompt {text}`. Sending a prompt puts the session in In work.
- **More providers** (a check "on several providers", or when Big Pickle answers 429 because the free Zen limit is spent): provider keys in the shell environment and in `~/.local/share/opencode/auth.json` are often stale, so probe each model with a one-word prompt before a long run. Working keys live in the user's OpenCode database: copy an API-key row into the instance's with `sqlite3 <D>/data/opencode/opencode.db "attach 'file:$HOME/.local/share/opencode/opencode.db?mode=ro' as src; insert or replace into credential select * from src.credential where integration_id='openrouter'"`, then restart the instance. Copy API-key rows only, never OAuth ones: a token refresh in the copy can rotate the user's own token. OpenRouter alone covers the Anthropic, Gemini and OpenAI model families.
- **Extension:** `POST /api/guests {path}` installs from a folder, `PUT /api/guests/<id>/capabilities {granted:[...]}` approves it. The dev build reports the released version, so a package whose `openchamber.engines` asks for the next one fails with `host-too-old`: install a copy with the range lowered.
- **Fixture session** (exact tool rows without running a model): `opencode session export <id> > s.json` from the user's own data, append an assistant message whose parts copy an existing completed tool part (`state.content`, `state.metadata`), give it an id that sorts after the last message, set `info.location.directory` to the isolated project, then `opencode session import s.json --directory <project> --standalone` with the instance's `HOME`/`XDG_*` env. Message ids are global, so importing the same session again fails with Internal Server Error: `DELETE /api/session/<id>` first. History pages arrive with shell tool results, so a collapsed row shows only what its metadata carries until it opens.
- **Image model** (OpenCode's image jobs without a paid provider): a local Node server answering `POST /v1/images/generations` after a delay with `{data:[{b64_json:<1x1 PNG>}]}`, declared in `$XDG_CONFIG_HOME/opencode/opencode.json`:

  ```json
  {"providers":{"fakeimg":{"package":"@opencode/ai/providers/openai-compatible",
    "settings":{"baseURL":"http://127.0.0.1:<port>/v1","apiKey":"test"},
    "models":{"pic":{"type":"image","package":"@opencode/ai/providers/openai-compatible/images",
      "capabilities":{"input":["text"],"output":["image"]}}}}}}
  ```

  The key is `providers`: the legacy `provider` is converted without `type` and `package`, so the model lands as a chat model and the image tool never registers. `GET /api/model?types=image` lists it when it took. Big Pickle then calls the tool when asked for a picture.

## Drive the page

Headless Chrome from `scripts/perf/cdp.mjs`, at `http://localhost:<ui>/`; wait until `document.body.innerText` is long (the first Vite compile takes about 20 seconds).

- `/?session=<id>` opens a session only when its directory is a registered project, compared by real path: create sessions under `/private/tmp/...`, never `/tmp/...`.
- A locale: set `localStorage['openchamber.i18n.v1'] = '{"locale":"ar"}'` on the origin, then navigate.
- Typing: focus the field, then `Input.insertText`.
- The image read tool can serve a cached picture for a path written twice: give each screenshot a new filename.
- For a Gecko check where Playwright's Firefox does not launch, Zen (a Firefox build) runs headless: `/Applications/Zen.app/Contents/MacOS/zen --headless --profile <empty dir> --no-remote --window-size=1507,1000 --screenshot <out.png> <url>`. It shoots after the page load, so a page that keeps a request open never gets one.

Vite serves the app's source modules, and a dynamic import of a module's URL returns the instance the app runs. So `Runtime.evaluate` can read, subscribe to and set any store without clicking:

```js
import('http://localhost:<ui>/@fs/<checkout>/packages/ui/src/stores/useUIStore.ts')
  .then((m) => m.useUIStore.getState().setOpenGuestPage('<extension id>'))
```

Build such URLs from the checkout path; `performance` resource entries stop at 250 and miss modules. Subscribing inside the page records every store change, which sampling from outside misses when a change lasts one batch.

An extension's frame is a separate `iframe` target: take it from `http://127.0.0.1:<debug port>/json` and evaluate there. Clicks go through the page target at the frame's rect plus the element's offset.

Take click coordinates from the page (`getBoundingClientRect`), never from a screenshot: the image read tool downscales captures (a 2880-pixel DPR-2 shot reads as 2000 wide), so neither its pixels nor pixels divided by the DPR are CSS pixels. To check hit-testing in a frame, dispatch `mouseMoved` over a grid and record where the page reacts.

## Stop

Kill the dev server by its process group and Chrome by its own handle, then delete `D`.
