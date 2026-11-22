# Behavior verification

`bun run verify` checks that the app still does what a user does with it: it starts an isolated dev instance, plays scenarios in headless Chrome, and exits non-zero when one fails. It is the net for refactors: a zone's scenarios are green before a large file is split and green after. How to use it during a refactor is in the `openchamber-change-discipline` skill (*Refactoring under the behavior net*).

Sections: *Ownership*, *Running it*, *The feature map*, *Steps*, *Invariants*, *Decisions*.

## Ownership

- `zones/*.json` is the feature map: per zone, its source files, its features (each with its own source files where they are narrower than the zone's) (what, how to reach, what proves it) and their scenarios as steps.
- `vocabulary.json` names every part of the UI a step points at (`composer.send`, `sidebar.row`, `diff.added`) with its selector and one line saying what it is. It is the shared name for each thing, and the one place a selector changes when the markup does.
- `server-routes.mjs` and `requests.mjs` select and record by server route (see *Running only what a change touches*).
- `stand.mjs` starts and resets the isolated instance, `browser.mjs` drives Chrome, `steps.mjs` runs steps, `changed.mjs` picks the scenarios a change touches, `run.mjs` is the command.
- `processes.mjs` owns process identities and recovery records under this checkout's `tmp/verify/owners`. `process-guardian.mjs` waits for the runner's pipe to close and reaps that run if its owner died without cleanup.

The stand reuses `scripts/perf`: `cdp.mjs` for Chrome, `fixture-provider.mjs` for the model, `fixture-conversations.mjs` for the scratch project and the scripted agent turns.

## Running it

```bash
bun run verify -- --changed                      # the scenarios the change touches (see below)
bun run verify -- --changed --base A..B --list   # what the commits between A and B select, no run
bun run verify                                   # every scenario
bun run verify -- composer files.edit            # a zone, a feature, or one scenario id
bun run verify -- --list composer                # the feature map, no run
bun run verify -- --retry-failed                 # play a failed scenario once more; a pass then is reported as flaky
bun run verify -- --shard 2/4                     # the second of four equal parts, for several machines
bun run verify -- diff --keep                    # keep the stand up after the run
bun run verify -- diff --attach tmp/verify/<run>/stand.json   # reuse a kept stand
```

Each run writes `tmp/verify/<time>/`: per scenario a folder with `result.json` (the failing step and its message, page errors), its screenshots and `failure.png` or `end.png`; `summary.json` for the run; `logs/dev.log` and `logs/fixture.log` of the stand. A failure prints the step, what was expected and what the page showed:

```
FAIL composer.send.shift-enter (21.8s)
     step 7 editor: the editor is "line two", expected "line one\nline two"
```

A fresh stand warms up for about 40 s (Vite's first compile of the chat, Changes and Files) before the first scenario; a full run of about 200 scenarios takes about 25 minutes. With `--keep` the stand runs until Ctrl-C, and `--attach` runs against it in seconds, which is the loop for writing scenarios. Vite serves the checkout's UI source, so a UI edit shows in the next scenario without restarting the stand. The server runs the code it started with: a change under `packages/web/server` needs a new stand.

The stand runs the OpenCode server the desktop app bundles, at the version this checkout pins (`@opencode/server` in `packages/electron/package.json`). It stages it into `packages/electron/resources/opencode-server` on first use, which downloads native packages from npm; without network access the stand stops at once and says so. `OPENCODE_BINARY` overrides it with an OpenCode CLI of that exact version; a separate official npm platform package can be extracted outside the checkout without changing `PATH`. For example, in Windows Command Prompt:

```bat
cd /d C:\Users\openc\projects\openchamber
set "OPENCODE_BINARY=C:\Users\openc\opencode-verify\package\bin\opencode.exe"
start "" /b /wait /high bun run verify -- workspace > C:\Users\openc\verify-workspace.log 2>&1
start "" /b /wait /high bun run verify -- composer > C:\Users\openc\verify-composer.log 2>&1
```

`node --test scripts/verify/platform.test.mjs` checks the fixture entrypoint, isolated Git configuration, the installed virtualizer patch and repeated Windows fixture shutdown without starting the app. A frozen install can report no changes while leaving a corrupted installed patch in place; this smoke test catches the broken virtualizer before a browser warm-up.

`node --test scripts/verify/processes.test.mjs scripts/verify/stand.test.mjs` covers process ownership, detached children, an exited group leader, abrupt runner death, stale-run recovery, live/foreign-run protection and PID reuse. `VERIFY_LIFECYCLE_TEST=1 node --test scripts/verify/lifecycle.test.mjs` opts into five real stand/browser runs: success, a failing scenario, a thrown error, SIGINT and SIGTERM. They run sequentially and verify that no process identity, command line or cwd from the stand survives, and that its root and Vite cache are gone.

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
| A server file (`packages/web/server/`) loaded by files that register routes or handle WebSocket upgrades | The features whose scenarios made requests to those routes, by `requests.json`, with the features that list or import the file |
| A server file that loads most of those files (the server's wiring), one that serves only requests most features make or a socket most of them hold open, or a deleted one | Every scenario |
| App code nothing above reaches | Nothing; listed as covered by no scenario |

The output names the feature each file led to, and lists the changed app files no scenario covers: for those the net has nothing to say, and a green run proves nothing about them. A change that selects nothing exits without starting a stand. `--list` with `--changed` prints the selection and the map without running.

The selection code is `changed.mjs`, tested without a stand in `changed.test.mjs`.

`requests.json` holds, for each feature, the requests its scenarios made to the server, as `METHOD route`, and under `*` the requests more than half the features make (what every page reads when it loads). Every run writes the requests a scenario's page made into its `result.json`, and `node scripts/verify/requests.mjs <artifact folders>` turns the results of a full run (all its parts) into the file. A feature is recorded anew only when all its scenarios passed in those results; otherwise it keeps what it had and adds what was seen. A new route or a moved handler is picked up by the next recording; until then a server file serving only that route is printed as uncovered.

### Where it runs by itself

Pull requests play `--changed` against their base in four parts (`behavior-net` in `.github/workflows/oc-review.yml`), with `--retry-failed`. The check is not required. `.github/workflows/behavior-net.yml` plays the whole net every night on the default branch in six parts, and from those results rewrites `requests.json`; when the file differs it opens a pull request from `ci/net-requests`.

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
| `fixture.request` `session`, `prompt` | Waits until the fixture has an active model request for this session whose latest user message contains `prompt` |
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
| `type` `command`, `shell`; `clipboard` `command` | Builds a host-shell-safe Node command from `output`, `repeat`, `read`, `file`, `content`, `append`, `gate`, `hold`, `rawInput` and `fail`. Type inserts it through real keys; `shell: true` enters the composer's `!` mode and waits for its shell editor before inserting. Clipboard puts it on the clipboard for Paste. Read prints a file's bytes; gate waits for a project-relative file; hold stays running until stopped; fail exits with status 1. `rawInput: {output, file}` reads raw terminal input until Ctrl+C, flushes its final output while still raw, restores cooked input and writes a ready file before exit. |
| `see` `on`, `count`, `disabled`, `inView` | Waits until the element shows (exactly `count` of them; `count: 0` asserts none; `inView` on screen: some innermost element holding `text` intersects the viewport) |
| `gone` `on` | Waits until no such element shows |
| `steady` `on`, `count`, `ms` | Fails if the count changes during `ms` |
| `above` `on`, `to` | Waits until the element's top is above that of `to` (an object with its own `on`, `text`, `index`): the order of sidebar sections and rows. Compares rendered elements by layout position, on screen or scrolled off |
| `editor` `equals`, `contains`, `empty`, `caret` | Waits for the composer's text; `caret: "start"` or `"end"` also waits for the focused, collapsed cursor at that edge |
| `terminal.expect` `on`, `contains` or `equals` | Selects the visible canvas grid with a real drag and copies it with Cmd/Ctrl+C until its text matches; replaces the clipboard |
| `terminal.select` `on` | Selects the visible terminal grid with a real drag. Use before menu Copy because a previous keyboard Copy may clear the selection on the host. |
| `toast.dismiss` | Clicks Close on visible dismissible toasts, if any, before interacting with a control an unrelated update notice can cover. |
| `field` `on`, `equals` or `contains` | Waits for an input or textarea's current value, such as a commit message retained after a failed save |
| `url` `contains` | Waits for the address; `{var}` placeholders allowed |
| `remember` `on`, `attr`, `as` | Stores an attribute of the element in a variable |
| `clipboard` `equals`, `contains`, or `set` | Waits for the clipboard text, `{var}` placeholders allowed; `set` writes a marker first, so a copy that does nothing cannot pass on old content |
| `clipboard.permission` `state` | Sets this browser context's clipboard-read permission to `granted`, `denied` or `prompt`, as a browser permission choice; the next scenario starts with fresh permissions |
| `settings` `values` or `expect` | `values` saves profile settings before `open`, such as `{"showTurnChangedFiles": true}`; `expect` only reads settings and waits for the named saved values, including global switches changed through the UI |
| `server.stop`, `server.start` | Stops the stand's OpenChamber server (and the OpenCode it runs) and starts it again from the checkout's current server code; not with `--attach` |
| `network.block` `urls`; `network.allow` | Refuses matching browser requests using Chrome's URL patterns, then clears the block. Variable placeholders such as `{s}` resolve to scenario variables. A fresh browser context clears the block between scenarios. |
| `screenshot` `name` | Saves a screenshot next to the result |
| `inspect` `selector`, `props`, `full` | Writes the matching elements' attributes, text and properties to a JSON file; for writing scenarios, not for keeping |
| `style` `on`, `property`, `equals` | Waits for a visible element's computed CSS property to equal the given string, such as `background-color` and `rgb(21, 23, 32)` |
| `pause` `ms` | Waits; only where the time itself is the behavior (a debounced save, a cache window) |

"Shows" means rendered, not `display: none` or `visibility: hidden`, with opacity above zero, searched through open shadow roots (the diff viewer renders its lines in one).

`pathText: true` on a target compares text with both path separators treated as `/`. Other text checks remain exact about separators. A target with `shortcut: "save_file"` substitutes `{shortcut}` in its `label` with the product's shortcut formatter and default binding, evaluated in the page.

`containsLines` on a clipboard check matches consecutive text lines with LF or CRLF separators. Other text and file checks retain exact byte expectations. `dismissToasts: true` on a click closes visible dismissible notices when they cover its target, including a notice that arrives while the target is settling. Dismissal shares the click's deadline. Other obstructions still fail the click.

## Invariants

- Nothing touches the user's data: the stand runs from a fresh folder under `/private/tmp` on macOS or the OS temp directory elsewhere with its own `HOME`, `XDG_*` and `OPENCHAMBER_DATA_DIR`, and its processes get only `PATH`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and `TERM` from the shell. Windows also keeps `SystemRoot`, `ComSpec`, `PATHEXT`, `TEMP` and `TMP`, and redirects `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` into the stand. No provider key, token or app variable reaches it or `stand.json`. It refuses to start, and `--attach` refuses to run, when the server lists sessions of the checkout itself. Ports are free ones picked per run.
- A `settings` step refuses a key that is not a profile setting (`scope: "profile"` in `settings-registry.json`), since the reset drops only those.
- The reset deletes only sessions under the stand's folder; a server holding any other session is not this stand, and the reset refuses before deleting anything.
- Every scenario starts from the same state: all sessions deleted, linked worktrees removed, unfinished rebases and merges cleared, the project's starting branch and commit restored with a clean index and tree, saved drafts removed, scenario branches and stashes removed, the repository configuration restored, the server's settings put back as they were when the stand started and the user's profile settings (Settings > Chat and the like) dropped back to the stand's, the sidebar's folders removed, a fresh browser context. A scenario's result does not depend on which ran before it, so one that changes a setting needs no step to change it back. Worktree cleanup refuses any linked directory outside the stand before removing anything. A failed Git reset rebuilds the fixture and records the reason as a failed scenario; later scenarios still run. Other reset failures also become scenario results.
- The model is the fixture provider, so answers are the same every run. `offline/no-answer` is a provider whose server refuses connections. No scenario calls a real model.
- Tools run without asking, except a read of a `*.secret` file and a web fetch: those ask, so a scenario can raise a permission request by having the agent read such a file, or hold a session on the user with a scripted fetch.
- A stopped run leaves nothing: the API, Vite, OpenCode, PTY daemons, fixture, Chrome and its helpers are tracked through OS process identities and the stand's isolated directories. Cleanup continues after a wrapper or group leader exits, escalates remaining processes, and removes the stand folder, Chrome profile and port-specific Vite cache only after the tree is gone. Failure in browser cleanup still runs stand cleanup. Startup errors and both runner signals take the same path.
- Every new stand first names and reaps abandoned stands of this checkout. PID alone, a reused port or a matching process name establishes no ownership. A live runner, including `--keep`, and a stand of another checkout are never reaped.
- A scenario during which the page reloaded or hot-updated on its own fails, whatever its steps saw: a source file changed under it (another session editing the checkout, or your own edit mid-run), so its result proves nothing. The failure says so; rerun with the source still.
- Steps act as a user does: real pointer and keys at element centres, the URL, files on disk, other clients through the CLI. Stores are not set from the page.

## Decisions

### Why shell fixtures run JavaScript files

The stand's terminal and OpenCode shell use the host's configured shell, including cmd.exe on Windows. Commands execute JavaScript files with Node, already required by the stand, so shell quoting cannot alter markers, escape sequences or file bytes. The content-addressed files live under the scratch project's `.git/verify-commands`, outside its file tree and diffs, and survive scenario resets. Fixture tool commands are written when the project is seeded; typed and pasted commands are written before insertion. The real terminal, clipboard and tool paths still execute the commands. Held commands have no completion timer, so a slower machine cannot finish them before the scenario presses Stop.

The scratch project's `.gitattributes` fixes text files at LF on checkout. Discard scenarios can compare exact bytes on every host without normalizing away a broken discard.

The subagent-chat fixture uses `perf/wait-for-stop`, an open model response cancelled by Stop or scenario cleanup. A 30 s worker could finish while a slower host opened its panel, leaving no running turn for Stop to test.

Subagent navigation dismisses unrelated update notices through their Close buttons before using bottom-of-panel controls. Those notices depend on the host's installed version and can cover Stop or Parent; the controls still have to be visible and clickable afterward.

### Why queue cleanup waits for the follow-up's model request

A session can stay busy while a steered follow-up moves from admission to execution. The fixture's opt-in request control identifies the new request by OpenCode's session header and its latest prompt, so Stop targets the follow-up's running turn. The control returns only a boolean and removes requests on completion or cancellation; normal profiling fixtures do not expose it.

The queue scenario allows 60 s for that request to start because the first fixture response stays silent for 30 s before OpenCode can consume the steer. Stop still has to make the session idle within 10 s after the follow-up request starts.

Ctrl+Enter cleanup uses the same request precondition before Stop.

The request-control test keeps each streamed `Response` until teardown. An unreferenced response can be garbage-collected, closing its request before the test aborts it. `node --expose-gc --test scripts/verify/fixture-request.test.mjs` forces that collection while the follow-up must remain active.

### Why Windows stops process trees

Windows has no POSIX process groups or group signals. The stand uses `taskkill /PID <owned pid> /T /F` there, and macOS/Linux send signals to identified members, escalating survivors to SIGKILL. Windows uses the installed OpenChamber app's bundled OpenCode when present, resolving its path before redirecting the stand's user directories.

Shutdown drains process log pipes for at most 1 s, then detaches and closes them before flushing the log file. A descendant retaining an inherited pipe must not prevent the runner from finishing cleanup.

The Windows API launch builds the built-in extensions and starts `server/index.js` with an explicit port. The `dev:server` script uses POSIX environment substitutions that Bun's Windows script shell passes literally. macOS continues to use that script.

Chrome starts with desktop mouse capabilities on every platform, because a Windows SSH session or a Linux CI runner has no attached input devices. Otherwise `(hover: hover)` and `(pointer: fine)` both report false and hover-only tab controls never show. On a machine with a mouse the settings match what Chrome reports anyway. Phone emulation still switches to coarse, touch-only input. `node --test scripts/verify/browser.test.mjs` checks both modes without a stand.

Windows browser teardown asks Chrome to close over CDP before falling back to killing its owned process tree. Terminating only the main process leaves helpers holding profile files open and can fail profile removal with `EPERM`.

The Windows runner explicitly gives itself, its API, Vite and Chrome High process priority. `start /high bun run verify` alone leaves these children at Normal, where windowless runs became slow enough to exceed control API timeouts. Vite runs through its Node entrypoint on Windows so the priority applies to the actual server. Other platforms retain the existing process launches and priorities.

Windows reset reads the global session list directly, including archived and child sessions. The CLI's 4 s control-request budget was too short for cleanup after a server restart; housekeeping can wait up to 120 s for the same raw list the reset already uses for child sessions. Scenario actions retain the CLI and its existing request budgets. Reset follows continuation cursors through the terminal empty page: OpenCode can return a cursor even on a short page. A failed or malformed page, or a repeated cursor, stops the reset before anything is deleted.

### Why a wrapper's exit does not finish cleanup

`bun run dev:server` can exit before its shell, server and managed OpenCode have stopped. OpenCode's detached PTY daemon is outside that group too. Waiting only for the direct child's `exit`, or skipping an already exited leader, left those processes alive. Cleanup snapshots descendants, group members with surviving identity evidence, and processes whose cwd or command names the isolated root. It waits for those processes themselves, including detached children.

The registry records PID and birth time before readiness and survives removal of the stand root. Updates publish complete JSON by atomic rename; `ps` identities use the C locale. A guardian waits on an inherited pipe rather than polling: EOF lets it recover the same record when the runner dies without `finally`, including Windows forced termination. Normal cleanup removes the record and waits for the guardian to exit.

Every parent edge requires a child born at or after its current parent. Windows retains creator PIDs after exit, so a reused PID can otherwise adopt unrelated older processes. Windows termination targets the validated identities individually; `taskkill /T` would follow the unvalidated numeric parent links again.

API and Vite launches use a small leader that stays alive until tree cleanup and reports the target's exit over IPC. This keeps their group identity valid when a wrapper exits before a late-spawned helper can be snapshotted. Its command also names the isolated root, covering the interval between spawn and registration.

Old runs without a registry are recognized only through `stand.json` in this checkout's artifacts and their isolated cwd, command paths or API/Vite environment. A standalone wrapper name or port is insufficient evidence. This migration reads candidate process environments locally and never logs them.

### Why stands queue per machine and not per session

A stand with its browser is the heaviest thing a session starts, and several sessions work on one machine. Two stands run side by side; a third pushed the machine into swap and made every run slower and flakier. So a run takes one of the machine's slots before it starts its stand (`slots.mjs`, slot files in the system temp folder holding the owner's process id) and waits when none is free; a slot whose owner is gone is taken over. Slots are read and changed by one process at a time, behind a guard folder, and a run gives back only a slot that still carries its own process id. A run frees its slot when it exits even if stopping its stand failed: a slot held by nobody would stop every later run, which is worse than one stand too many. `OPENCHAMBER_VERIFY_SLOTS` changes the limit for a bigger machine. `--attach` takes no slot, since its stand is already running; a stand kept with `--keep` holds its slot until it stops. Leaving the limit to each session's judgement was the alternative, and sessions cannot see each other.

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

Every check polls until it holds or times out, and clicks and hovers wait until the target stops moving, stays the same node (a list or diff that re-renders its rows after opening replaces them in place), and is the topmost element at its centre. A fixed sleep either flakes on a slow machine or wastes time on a fast one; the few `pause` steps left are the behavior under test (a debounced draft save, the 1.2 s Git status cache).

### Why session-load retry fails only the message request

The retry scenario blocks its target's message URL before the page opens, since desktop prefetch can otherwise load that session before the server stops. The session list and event transport stay available. Clearing the block and pressing Try again proves the recovery action; server restarts remain in the sync scenarios that prove reconnection.

### Why a setting is a precondition and not clicks in Settings

Some chat behavior shows only with a setting on (changed files under a turn, reasoning traces). The scenario is about the chat, so the `settings` step saves the setting through the server the way another window would, and the page reads it when it opens. Clicking through Settings in every such scenario would tie chat scenarios to the Settings page's markup and test it many times over; Settings gets its own zone when it needs one.

### Why native drags are intercepted

A row drag (move a file, attach it to the chat) and a drop from the desktop are HTML drag and drop, which a headless browser cannot run from mouse events alone: Chrome starts its own drag loop and waits for the operating system. `dragStart` has Chrome hand the drag data to the runner instead, after the page's own `dragstart` ran, and `dragOver`, `drop` and `dragCancel` deliver it as the browser would. A drop from the desktop needs no source in the page, so `dragStart` with `files` only builds the data. The `drag` step stays for pointer gestures inside the page, such as selecting diff rows.

### Why the reset restores settings

Some choices made in the app live on the server, not in the browser: Don't ask again on a file move turned off the confirmation for every later scenario, which then failed where it expected the dialog. The stand copies the server's settings files once it is up and the reset copies them back, so a scenario's choice ends with it.

### Why the reset removes worktrees and their branches

Deleting sessions leaves their worktrees behind. A repeat then creates a suffixed branch, while a selector for the original branch opens an empty old worktree's menu. Removing the stand's linked worktrees and non-main branches gives every scenario the same topology and names.

The reset cleans the index and tree and checks out the starting branch before deleting scenario branches. A failed scenario can leave its branch checked out, so deleting branches first would stop the run. The starting commit and repository configuration come from stand creation, since resetting to `HEAD` preserves scenario commits and configuration edits.

### Why the reset keeps the project's `.opencode` folder

OpenCode watches a project's `.opencode` folder for agents, commands and skills. When the folder is removed and made again within moments, OpenCode 2.3.2 keeps its old list and stops noticing later changes: 24 of 25 such rounds on a stand never showed the new command, and none of 30 did when only the folder's contents were removed. A reset that cleaned the folder away, followed by a scenario writing a command into it, made `commands.edit.write-failure` fail about once in a full run, always after another scenario that had used the folder. The fixture project has the folder from the start, and the reset empties it without removing it. A reset that fails and rebuilds the whole fixture still replaces the folder, so scenarios after such a failure can miss what they write there until the stand restarts.

### Why a failed reset rebuilds the fixture

A leftover Git lock or damaged metadata can prevent ordinary cleanup. Rebuilding the stand-owned project and removing its linked directories makes the next reset usable, while a failed scenario result keeps the cleanup failure visible. The isolation check reads Git's worktree registry directly, so an invalid Git configuration cannot bypass it. Worktrees outside the stand or an unreadable registry prevent both reset and recovery.

### Why Git scenarios wait for completed actions

Staging can leave Commit disabled while the index refreshes. A branch header can update before branch creation finishes and closes its form. Creating a stash shows its row before Apply is re-enabled, and Apply restores a stashed file before its refresh finishes and re-enables Pop. The scenarios wait for enabled actions and for the creation form to disappear before the next action, so faster steps in a warmed-up run cannot click a disabled button or close a picker that is still completing creation.

Stage and unstage move rows at once, before the index changes. After Unstage all nothing is staged, so no button changes when the request finishes; the changed-files list is `aria-busy` until then, and the scenario waits for `git.listBusy` to go before it reloads. On a stand whose Git commands each took 2 s, a reload during the request showed both files staged again.

### Why an unreachable MCP server's toast is matched by its kind

Connect and Test connection show OpenCode's error for the server as an error toast. Its text comes from the HTTP client of the OpenCode build: the bundled Node server says `fetch failed`, and a CLI build named `ECONNREFUSED`. The scenario counts one error toast per attempt, and the card's Failed status stays the proof of what happened.

### Why prompt history waits for its caret

Recalling a prompt changes the editor's text before the next animation frame puts the cursor at the start. The Arrow Down scenario waits for that cursor before moving it to the end, so the pending recall cannot move it back between End and Arrow Down. The driver reads the browser's selection without accessing editor or application state.

### Why Copy link waits for its answer

Opening a session waits for its composer and selected sidebar row. Its messages can arrive afterward. Copy link waits for the answer before remembering its message id, so a read made before the transcript arrives cannot fail as a missing attribute.

### Why the subagent permission scenario waits for the request

The arriving permission request can replace the subagent's tool-row elements. A pointer pressed on the open-subtask arrow and released during that replacement lands on the row, so the browser does not click the arrow. The scenario waits for the parent's Allow once button before opening the subagent's chat, then answers the request in that read-only chat.

### Why agent permission scenarios wait for the file

An added rule's text can reach disk before its effect does, and a removed rule disappears from the editor before autosave finishes. The pattern scenario waits for the saved effect and removal before reopening the agent. Permission scenarios scroll the Shell row up before editing, keeping the default and rule controls clear of the update notification at the bottom of the page.

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

### Why server files are selected by recorded requests

The UI reaches the server over HTTP, so the import walk never arrives at server code: with eight server files listed by hand, 690 of 769 server files selected nothing, the Git routes and the server's wiring among them, and the run was green without playing a scenario. A hand-kept list of server folders per zone would go stale with every new route. The page already shows which requests a scenario makes, and the server's code shows which file answers each path and what that file loads, so the link is recorded and derived: a path belongs to the most specific `/api` pattern a serving file names (or a constants file it imports), and a changed server file selects through every serving file that loads it. Type-only imports count here, since a route file is handed the modules it calls and names them by type. With the recording 145 files select nothing.

The method is part of a recorded request because reading the settings is something every page does and writing them is what a few scenarios check; by path alone the settings routes selected either everything or nothing that saves a setting.

A `settings` step saves through the runner, outside the page, so it records its own request (`PUT@step`): the page saves settings on every load, and without the mark the few features that check a saved setting would be lost among all of them.

What this does not see: requests a scenario makes through the CLI (they reach the same session routes the page uses), requests the server passes on to OpenCode, and a module handed to a route file as a plain callback with no type import, such as the settings store given to the settings routes. A file like that is selected through whatever else loads it, and a feature that depends on it lists it in its `sources`. A route renamed or removed inside a file that stays selects by the file's remaining routes only; a deleted file selects everything. A file is given every path it names, also one it only lists (the realtime proxy's allowed targets), which can select more than it serves and never less.

### Why the checks in CI retry a failed scenario and a local run does not

Five full runs on CI runners gave two rare failures, a different scenario each time, none of which failed when played again. A pull request check that is red once in a few runs for reasons outside the change teaches people to ignore it. So CI plays a failed scenario once more and names it as flaky when it then passes; the run's log and `summary.json` list them, which is where a scenario that needs a better wait shows up. A local run stays strict: the person at the keyboard can look at the failure, and a flaky scenario found there is fixed, not retried.

### Why uncovered files are printed and not ignored

A change whose files no feature reaches selects nothing and exits green. Without naming those files, that green reads as "checked"; the list says where the net has no scenario, so the change gets a scenario or a check of another kind.

### Why terminal text is read through Copy

The terminal renders into a canvas with no DOM text. `terminal.expect` drags across the visible grid and copies it through the keyboard, so it reads the same output a user can select without accessing the emulator or its store. It also waits for the first shell prompt before typing: a mounted canvas can precede the shell connection. The terminal Copy scenario waits 600 ms before its triple-click because the terminal counts nearby clicks within 500 ms; the earlier focus click must expire before the selection gesture starts.

History scenarios select the grid again before menu Copy because keyboard Copy can clear the selection on Windows. The clipboard sentinel still proves the menu action copied restored or newly revealed output.

The mouse-reporting fixture uses a raw-input application, so cmd.exe does not restore console modes before the scenario acts. On Ctrl+C it flushes the disable sequence before restoring cooked input and signals completion itself, so another shell command cannot race its exit.

History scenarios also wait for the restored or newly revealed output with `terminal.expect`. The canvas can mount before replay has finished. Its drag leaves the restored text selected; each scenario then replaces the clipboard marker and uses the context menu's enabled Copy action to prove that path too.

### Why a reload scenario closes Settings first

Settings has its own URL, so a reload can restore the open Settings page. The MCP creation and provider editing scenarios close Settings before reloading, then open it again to read the saved configuration. Their sidebar Settings button is reachable on the chat page.

### Why MCP advanced options reopen after autosave

Saving a timeout reloads the server definition and can close Advanced after the file has changed. The scenario reloads the page and reopens the server before changing Code mode, so callbacks from the earlier save cannot remove the next selector. The summary and field both have to show the saved timeout.

### Why workflows wait for the saved settings

The Workflow tool switch and the approval choice change visually before their settings request finishes. A prompt from another client can reach the server while the tool is still disabled there. The scenarios read back the saved flags before sending that prompt. `settings expect` is read-only; `settings values` still refuses global fields.

### Why clipboard refusal changes the browser permission

The stand normally grants clipboard access. `clipboard.permission` changes Chrome's read permission for that scenario's browser context, so Paste gets a real refused read and can be retried after access is granted. A fresh context restores the stand's permissions for the next scenario.
