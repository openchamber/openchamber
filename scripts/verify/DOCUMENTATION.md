# Behavior verification

`bun run verify` checks that the app still does what a user does with it: it starts an isolated dev instance, plays scenarios in headless Chrome, and exits non-zero when one fails. It is the net for refactors: a zone's scenarios are green before a large file is split and green after. How to use it during a refactor is in the `openchamber-change-discipline` skill (*Refactoring under the behavior net*).

Sections: *Ownership*, *Running it*, *The feature map*, *Steps*, *Invariants*, *Decisions*.

## Ownership

- `zones/*.json` is the feature map: per zone, its source files, its features (each with its own source files where they are narrower than the zone's) (what, how to reach, what proves it) and their scenarios as steps.
- `vocabulary.json` names every part of the UI a step points at (`composer.send`, `sidebar.row`, `diff.added`) with its selector and one line saying what it is. It is the shared name for each thing, and the one place a selector changes when the markup does.
- `stand.mjs` starts and resets the isolated instance, `browser.mjs` drives Chrome, `steps.mjs` runs steps, `changed.mjs` picks the scenarios a change touches, `run.mjs` is the command.

The stand reuses `scripts/perf`: `cdp.mjs` for Chrome, `fixture-provider.mjs` for the model, `fixture-conversations.mjs` for the scratch project and the scripted agent turns.

## Running it

```bash
bun run verify -- --changed                      # the scenarios the change touches (see below)
bun run verify -- --changed --base A..B --list   # what the commits between A and B select, no run
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

A fresh stand warms up for about 40 s (Vite's first compile of the chat, Changes and Files) before the first scenario; a full run of about 200 scenarios takes about 25 minutes. With `--keep` the stand runs until Ctrl-C, and `--attach` runs against it in seconds, which is the loop for writing scenarios. Vite serves the checkout's UI source, so a UI edit shows in the next scenario without restarting the stand. The server runs the code it started with: a change under `packages/web/server` needs a new stand.

### Running only what a change touches

`--changed` takes the files the change touches, counted as `bun run check:changed` counts them (from where the branch left `origin/main`, with uncommitted and new files; `--base <ref>` for another base, `--base A..B` for the commits between two refs only), and runs the scenarios of the features those files can break. Each changed file goes to one of these:

| The file | Selects |
|---|---|
| A test, a document, or a file outside `packages/` and the net | Nothing; listed as not app code |
| `zones/<zone>.json` | The features of that zone whose scenarios changed or are new |
| `vocabulary.json` | The features whose steps use a name whose selector changed, is new or is gone |
| Anything else under `scripts/verify/`, or a file the runner loads from `scripts/` (the fixtures, the isolated server) | Every scenario |
| A file a feature's `sources` list, or under a listed directory | That feature |
| A file the sources of some features import, through their components and hooks, or a store or library (`packages/ui/src/{stores,sync,lib}`) that code imports | Those features; every scenario when more than half the features import it |
| App code nothing above reaches | Nothing; listed as covered by no scenario |

The output names the feature each file led to, and lists the changed app files no scenario covers: for those the net has nothing to say, and a green run proves nothing about them. A change that selects nothing exits without starting a stand. `--list` with `--changed` prints the selection and the map without running.

The selection code is `changed.mjs`, tested without a stand in `changed.test.mjs`.

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
    "sources": ["packages/ui/src/components/views/files/FileEditor.tsx"],
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

`sources` are the files (or directories, ending in `/`) whose breakage the zone's scenarios catch, the ones `--changed` selects by. A feature may name its own; then it is selected by those alone, and a feature without them by its zone's. A feature's sources name the files its behavior lives in, including the container whose own code its scenarios play (the list that scrolls, the row that opens a menu), and leave out stores and libraries many features share: the import graph finds those. A source path that does not exist stops the run before it starts, so a split or a rename updates the map in the same change.

A scenario id is `zone.feature.scenario`. `kind` is `path` for the plain user path and `break` for an ordinary failure (a provider that is down, a dropped connection, a file changed outside the app). The runner rejects a step whose `do` or `on` it does not know before anything starts.

A selector in the vocabulary can hold `{name}` placeholders. A step fills them from its own field of that name, and a value naming a variable (`"session": "s"`) becomes that variable's value; `{project}` is always the project path. `"text"` on a step keeps only elements whose visible text contains it (`"exact": true` for equal), `"index"` picks among several.

## Steps

Every step waits up to 20 s (`"timeout"` in seconds changes it) and fails with what it saw.

| Step | Does |
|---|---|
| `session.create` `as`, `title` | Creates a session in the project; `as` names the variable holding its id |
| `session.send` `session`, `prompt`, `model`, `wait`, `goal` | Sends a prompt as another client would; waits for the answer unless `wait` is false; `goal` sends it as a goal the agent keeps working toward |
| `session.idle`, `session.busy` `session` | Waits for the session's status |
| `file.write` `path`, `content`, `times`; `file.delete` `path` | Changes the project on disk; `content` may be an array of lines; with `times` it writes that many files, `{n}` in the path numbered 01, 02, ... |
| `file.expect` `path`, `contains`, `equals` or `exists` | Waits for the file's content, or for the path to exist (`true`) or be gone (`false`) |
| `open` `session`, `phone` | Loads the app, at that session when given; `"phone": true` loads the phone layout (`/mobile.html`) at a phone's size with touch, and every later click is a tap |
| `reload` `ready` | Reloads the page and waits for the composer; `"ready": false` does not wait, for a reload while the server is stopped |
| `click`, `hover` `on`, `mods`; `button`, `clicks` on a click | Moves the real mouse to the element's centre, once it stands still and nothing covers it; `"button": "right"` opens a context menu, `"button": "long"` presses a finger for 0.8 s (a phone row's menu), `"clicks": 2` double-clicks; `mods` (as on `press`) are held during the move and the click; fails when something still covers it at the timeout |
| `drag` `on`, `to` | Presses on the element, moves to the centre of `to` (an object with its own `on`, `text`, `index`) with the button held, and releases there; both ends must be on screen together |
| `wheel` `on`, `dy`, `dx`, `times` | Scrolls with the wheel over the element, down by `dy` and sideways by `dx` |
| `dragStart` `on` or `files` | Starts a native HTML drag from the element, or holds `files` (`name`, `content`) as if dragged in from the desktop |
| `dragOver`, `drop` `on` | Moves the drag over the element; drops it there |
| `dragCancel` `on` | Ends a row's drag over the element without a drop, as Escape or a release outside a target does |
| `chooseFiles` `files` | The next file picker the page opens gets these files (`name`, `content`) as if the user chose them |
| `download` `name`, `contains` | Waits for the browser to finish downloading a file of that name and checks its content |
| `type` `text`; `press` `key`, `mods`, `times` | Types into the focused element; presses a key (`mods`: `shift`, `alt`, `ctrl`, `meta`, `mod` for Cmd on macOS and Ctrl elsewhere) |
| `see` `on`, `count`, `disabled`, `inView` | Waits until the element shows (exactly `count` of them; `count: 0` asserts none; `inView` on screen: some innermost element holding `text` intersects the viewport) |
| `gone` `on` | Waits until no such element shows |
| `steady` `on`, `count`, `ms` | Fails if the count changes during `ms` |
| `editor` `equals`, `contains`, `empty` | Waits for the composer's text |
| `url` `contains` | Waits for the address; `{var}` placeholders allowed |
| `remember` `on`, `attr`, `as` | Stores an attribute of the element in a variable |
| `clipboard` `equals`, `contains`, or `set` | Waits for the clipboard text, `{var}` placeholders allowed; `set` writes a marker first, so a copy that does nothing cannot pass on old content |
| `settings` `values` | Saves OpenChamber settings as another client would, before `open`: `{"showTurnChangedFiles": true}`; only profile settings, which the reset drops back to the stand's |
| `server.stop`, `server.start` | Stops the stand's OpenChamber server (and the OpenCode it runs) and starts it again from the checkout's current server code; not with `--attach` |
| `screenshot` `name` | Saves a screenshot next to the result |
| `inspect` `selector`, `props`, `full` | Writes the matching elements' attributes, text and properties to a JSON file; for writing scenarios, not for keeping |
| `pause` `ms` | Waits; only where the time itself is the behavior (a debounced save, a cache window) |

"Shows" means rendered, not `display: none` or `visibility: hidden`, with opacity above zero, searched through open shadow roots (the diff viewer renders its lines in one).

## Invariants

- Nothing touches the user's data: the stand runs from a fresh folder under `/private/tmp` with its own `HOME`, `XDG_*` and `OPENCHAMBER_DATA_DIR`, and its processes get only `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and `TERM` from the shell, so no provider key, token or app variable reaches it or `stand.json`. It refuses to start, and `--attach` refuses to run, when the server lists sessions of the checkout itself. Ports are free ones picked per run.
- A `settings` step refuses a key that is not a profile setting (`scope: "profile"` in `settings-registry.json`), since the reset drops only those.
- The reset deletes only sessions under the stand's folder; a server holding any other session is not this stand, and the run stops before deleting anything.
- Every scenario starts from the same state: all sessions deleted, the project reset to its first commit and cleaned, the server's settings put back as they were when the stand started and the user's profile settings (Settings > Chat and the like) dropped back to the stand's, the sidebar's folders removed, a fresh browser context. A scenario's result does not depend on which ran before it, so one that changes a setting needs no step to change it back.
- The model is the fixture provider, so answers are the same every run. `offline/no-answer` is a provider whose server refuses connections. No scenario calls a real model.
- Tools run without asking, except a read of a `*.secret` file and a web fetch: those ask, so a scenario can raise a permission request by having the agent read such a file, or hold a session on the user with a scripted fetch.
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

### Why a setting is a precondition and not clicks in Settings

Some chat behavior shows only with a setting on (changed files under a turn, reasoning traces). The scenario is about the chat, so the `settings` step saves the setting through the server the way another window would, and the page reads it when it opens. Clicking through Settings in every such scenario would tie chat scenarios to the Settings page's markup and test it many times over; Settings gets its own zone when it needs one.

### Why native drags are intercepted

A row drag (move a file, attach it to the chat) and a drop from the desktop are HTML drag and drop, which a headless browser cannot run from mouse events alone: Chrome starts its own drag loop and waits for the operating system. `dragStart` has Chrome hand the drag data to the runner instead, after the page's own `dragstart` ran, and `dragOver`, `drop` and `dragCancel` deliver it as the browser would. A drop from the desktop needs no source in the page, so `dragStart` with `files` only builds the data. The `drag` step stays for pointer gestures inside the page, such as selecting diff rows.

### Why the reset restores settings

Some choices made in the app live on the server, not in the browser: Don't ask again on a file move turned off the confirmation for every later scenario, which then failed where it expected the dialog. The stand copies the server's settings files once it is up and the reset copies them back, so a scenario's choice ends with it.

### Why a shared file is found through imports and not listed

A store or a library sits under dozens of features, and listing it in each would go stale with every new import. `--changed` reads the imports of every feature's sources instead (static, re-exports, `import()`, through the `@/`, `@web/` and `@openchamber/*` aliases; type-only imports change no behavior and are skipped) and selects a feature when the changed file is reachable from its sources. A regular expression over import lines is enough for this repository's code and needs no compiler; a specifier it cannot resolve is a package and is left out.

### Why the walk stops at the first store or library

The stores, the sync layer and `lib/` import each other in cycles: following them, every feature reached every store, and a change to any store selected 64 features of 64. The walk follows a feature's components and hooks to any depth, takes the stores and libraries they import, and stops there. A store change then selects the features whose own code uses it: `useFileSearchStore` selects the file mention list and the file tree, 26 scenarios of 198. The price: a store that matters to a feature only through another store does not select it. Two levels deep already put most stores past half the features, so the walk takes one.

### Why the import walk stops at a file another feature lists

The transcript imports the composer, so without a stop every file the composer loads would select every chat feature. A file a feature lists is that feature's to catch: the walk does not enter it from another feature's sources, and the draft store behind the composer selects the composer's features only. The cost is that a feature which also depends on that file's imports through it must list them itself. For the same reason a feature never lists a file most of the app loads (`sync/sync-context.tsx`, a store): the walk would stop there for every other feature, and that file's imports would select only the one that listed it.

### Why every chat feature lists the transcript's frame

`ChatContainer`, `ChatViewport`, `MessageList`, `ChatMessage`, `MessageBody` and `timeline/` render every turn, so any chat scenario fails when they break, and every chat feature lists them. A change to the frame runs the whole chat zone; a change to what one feature draws (the turn footer, a tool row, the search bar) runs that feature.

### Why more than half the features means every scenario

Session state and the config store are imported by the code of 50 to 63 features of 64, and running those one by one is the full run under another name. Past half the features the selection is close to full anyway, and saying "this file is shared, everything runs" is more honest than a long list that reads as narrow. The threshold is per file, so one shared file in a change runs everything.

### Why a map change runs what changed and not everything

Writing scenarios edits a zone file and the vocabulary in nearly every commit. Running every scenario for that would make `--changed` a full run for all scenario work. A zone file selects its features whose scenarios differ from the base, the vocabulary the features whose steps use a changed name; the runner, the steps and the fixtures can break any scenario and select all of them.

### Why uncovered files are printed and not ignored

A change whose files no feature reaches selects nothing and exits green. Without naming those files, that green reads as "checked"; the list says where the net has no scenario, so the change gets a scenario or a check of another kind.
