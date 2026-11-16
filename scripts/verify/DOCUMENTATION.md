# Behavior verification

`bun run verify` checks that the app still does what a user does with it: it starts an isolated dev instance, plays scenarios in headless Chrome, and exits non-zero when one fails. It is the net for refactors: a zone's scenarios are green before a large file is split and green after. How to use it during a refactor is in the `openchamber-change-discipline` skill (*Refactoring under the behavior net*).

Sections: *Ownership*, *Running it*, *The feature map*, *Steps*, *Invariants*, *Decisions*.

## Ownership

- `zones/*.json` is the feature map: per zone, its source files, its features (what, how to reach, what proves it) and their scenarios as steps.
- `vocabulary.json` names every part of the UI a step points at (`composer.send`, `sidebar.row`, `diff.added`) with its selector and one line saying what it is. It is the shared name for each thing, and the one place a selector changes when the markup does.
- `stand.mjs` starts and resets the isolated instance, `browser.mjs` drives Chrome, `steps.mjs` runs steps, `run.mjs` is the command.

The stand reuses `scripts/perf`: `cdp.mjs` for Chrome, `fixture-provider.mjs` for the model, `fixture-conversations.mjs` for the scratch project and the scripted agent turns.

## Running it

```bash
bun run verify                                   # every scenario
bun run verify -- composer files.edit            # a zone, a feature, or one scenario id
bun run verify -- --list composer                # the feature map, no run
bun run verify -- diff --keep                    # keep the stand up after the run
bun run verify -- diff --attach tmp/verify/<run>/stand.json   # reuse a kept stand
```

Each run writes `tmp/verify/<time>/`: per scenario a folder with `result.json` (the failing step and its message, page errors), its screenshots and `failure.png` or `end.png`; `summary.json` for the run; `logs/dev.log` and `logs/fixture.log` of the stand. A failure prints the step, what was expected and what the page showed:

```
FAIL composer.send.shift-enter (21.8s)
     step 7 editor: the editor is "line two", expected "line one\nline two"
```

A fresh stand warms up for about 40 s (Vite's first compile of the chat, Changes and Files) before the first scenario; a full run takes 4 to 6 minutes. With `--keep` the stand runs until Ctrl-C, and `--attach` runs against it in seconds, which is the loop for writing scenarios. Vite serves the checkout's UI source, so a UI edit shows in the next scenario without restarting the stand. The server runs the code it started with: a change under `packages/web/server` needs a new stand.

## The feature map

A zone file:

```json
{
  "zone": "files",
  "name": "Files",
  "sources": ["packages/ui/src/components/views/FilesView.tsx"],
  "features": [{
    "id": "edit",
    "name": "Editing a file",
    "what": "What the user gets, in their words.",
    "reach": "How to get there in the app.",
    "proof": "What shows that it works.",
    "scenarios": [{
      "id": "save",
      "kind": "path",
      "title": "Typing and Cmd/Ctrl+S writes the file to disk",
      "steps": [
        {"do": "session.create", "as": "s"},
        {"do": "open", "session": "s"},
        {"do": "click", "on": "panel.surface", "surface": "editor"},
        {"do": "file.expect", "path": "src/api/client.ts", "contains": "edited"}
      ]
    }]
  }]
}
```

A scenario id is `zone.feature.scenario`. `kind` is `path` for the plain user path and `break` for an ordinary failure (a provider that is down, a dropped connection, a file changed outside the app). The runner rejects a step whose `do` or `on` it does not know before anything starts.

A selector in the vocabulary can hold `{name}` placeholders. A step fills them from its own field of that name, and a value naming a variable (`"session": "s"`) becomes that variable's value; `{project}` is always the project path. `"text"` on a step keeps only elements whose visible text contains it (`"exact": true` for equal), `"index"` picks among several.

## Steps

Every step waits up to 20 s (`"timeout"` in seconds changes it) and fails with what it saw.

| Step | Does |
|---|---|
| `session.create` `as`, `title` | Creates a session in the project; `as` names the variable holding its id |
| `session.send` `session`, `prompt`, `model`, `wait` | Sends a prompt as another client would; waits for the answer unless `wait` is false |
| `session.idle`, `session.busy` `session` | Waits for the session's status |
| `file.write` `path`, `content`; `file.delete` `path` | Changes the project on disk; `content` may be an array of lines |
| `file.expect` `path`, `contains` or `equals` | Waits for the file's content |
| `open` `session` | Loads the app, at that session when given |
| `reload` | Reloads the page |
| `click`, `hover` `on` | Moves the real mouse to the element's centre, once it stands still and nothing covers it |
| `drag` `on`, `to` | Presses on the element, moves to the centre of `to` (an object with its own `on`, `text`, `index`) with the button held, and releases there; both ends must be on screen together |
| `wheel` `on`, `dy`, `times` | Scrolls with the wheel over the element |
| `type` `text`; `press` `key`, `mods`, `times` | Types into the focused element; presses a key (`mods`: `shift`, `alt`, `ctrl`, `meta`, `mod` for Cmd on macOS and Ctrl elsewhere) |
| `see` `on`, `count`, `disabled`, `inView` | Waits until the element shows (exactly `count` of them; `count: 0` asserts none; `inView` on screen: some innermost element holding `text` intersects the viewport) |
| `gone` `on` | Waits until no such element shows |
| `steady` `on`, `count`, `ms` | Fails if the count changes during `ms` |
| `editor` `equals`, `contains`, `empty` | Waits for the composer's text |
| `url` `contains` | Waits for the address; `{var}` placeholders allowed |
| `remember` `on`, `attr`, `as` | Stores an attribute of the element in a variable |
| `clipboard` `equals`, `contains`, or `set` | Waits for the clipboard text; `set` writes a marker first, so a copy that does nothing cannot pass on old content |
| `server.stop`, `server.start` | Stops the stand's OpenChamber server (and the OpenCode it runs) and starts it again from the checkout's current server code; not with `--attach` |
| `screenshot` `name` | Saves a screenshot next to the result |
| `inspect` `selector`, `props`, `full` | Writes the matching elements' attributes, text and properties to a JSON file; for writing scenarios, not for keeping |
| `pause` `ms` | Waits; only where the time itself is the behavior (a debounced save, a cache window) |

"Shows" means rendered, not `display: none` or `visibility: hidden`, with opacity above zero, searched through open shadow roots (the diff viewer renders its lines in one).

## Invariants

- Nothing touches the user's data: the stand runs from a fresh folder under `/private/tmp` with its own `HOME`, `XDG_*` and `OPENCHAMBER_DATA_DIR`, and its processes get only `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and `TERM` from the shell, so no provider key, token or app variable reaches it or `stand.json`. It refuses to start, and `--attach` refuses to run, when the server lists sessions of the checkout itself. Ports are free ones picked per run.
- The reset deletes only sessions under the stand's folder; a server holding any other session is not this stand, and the run stops before deleting anything.
- Every scenario starts from the same state: all sessions deleted, the project reset to its first commit and cleaned, a fresh browser context. A scenario's result does not depend on which ran before it.
- The model is the fixture provider, so answers are the same every run. `offline/no-answer` is a provider whose server refuses connections. No scenario calls a real model.
- A stopped run leaves nothing: the dev server's process group, the fixture, Chrome and its profile, the stand folder and the Vite cache of its port are removed on exit, on failure, and on Ctrl-C or SIGTERM, startup included.
- A scenario during which the page reloaded or hot-updated on its own fails, whatever its steps saw: a source file changed under it (another session editing the checkout, or your own edit mid-run), so its result proves nothing. The failure says so; rerun with the source still.
- Steps act as a user does: real pointer and keys at element centres, the URL, files on disk, other clients through the CLI. Stores are not set from the page.

## Decisions

### Why a dev instance and not the production build

A refactor is checked many times while it is split; a production build takes minutes each time and the dev instance serves the edited source at once. The price is that dev-only behavior shows: React StrictMode, and libraries that assert in development. The Markdown pipeline's `devlop` assertion fails on the fixture's `showcase` document in dev, so no scenario uses that document.

### Why the server is a snapshot and the UI is live

Several sessions edit this checkout at once. With the server under a file watcher, another session's edits restarted it 13 times in one run, and scenarios failed on the restarts. The stand runs the server without a watcher, so its code is fixed for the run, and serves the UI through Vite, which is how a refactor sees its own edits. A UI edit from elsewhere still reaches a page mid-scenario as a reload or a hot update; the runner sees it and voids that scenario instead of trusting it.

### Why a dropped connection is a server restart

Chrome's offline emulation also cuts Vite's socket, and Vite reloads the page once it is back, so a scenario built on it passed through the reload whether or not the app reconnected. Stopping and starting the stand's server cuts every connection the app holds and leaves Vite's alone, so new data after the restart can only arrive through the app's own reconnect.

### Why scenarios are JSON and targets are names

A scenario is read the same way by every agent and every run: the steps are data, the runner gives each one meaning. The names in `vocabulary.json` are also the words people and agents use for the UI, so "the Mark done check on a sidebar row" is `sidebar.rowMarkDone` everywhere. When the markup changes, one selector changes and every scenario using it follows; a scenario changes only when the behavior does.

### Why other clients act through the CLI

Sessions created and prompts sent through `openchamber session` reach the app the way a second window, the phone or an agent's tool do, so the same step seeds a scenario and tests live sync. Only what the user does in this window goes through the page.

### Why waits are on conditions

Every check polls until it holds or times out, and clicks wait until the target stops moving and is the topmost element at its centre. A fixed sleep either flakes on a slow machine or wastes time on a fast one; the few `pause` steps left are the behavior under test (a debounced draft save, the 1.2 s Git status cache).
