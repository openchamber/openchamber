# Performance Measurement Tooling

Owns the unattended performance capture commands and their shared Chrome
DevTools Protocol plumbing. Read this before measuring OpenChamber performance
or extending these scripts. The methodology rules they enforce come from
`.agents/skills/performance-engineering/SKILL.md`.

## Commands

| Command | Answers |
|---|---|
| `bun run profile:idle` | What the app does while nobody interacts with it. |
| `bun run profile:session` | What receiving and rendering a live assistant response costs. |
| `bun run profile:animation` | What a CSS animation costs, isolated from the app. |
| `bun run profile:switch` | How long switching sessions from the sidebar takes, cold and warm. |
| `bun run profile:startup` | How long a packaged Desktop build (from process spawn), or the web app with `--url` (from navigation start), takes to mount and become usable. |
| `bun run profile:browser` | A manually driven capture, for interactions that cannot be scripted. |

All of them measure a real browser over CDP. Pass `--help` to any of them for
the full option list.

## Before Measuring Anything

**Measure a production build.** A development build's render and bundle
behaviour does not represent what users run.

When launching from an agent inside packaged Desktop, explicitly set
`OPENCHAMBER_DIST_DIR` to the checkout's `packages/web/dist`. The inherited
value can point at the installed app's `web-dist`, so rebuilding the checkout
would leave the browser running the old bundle. Before comparing runs, match
the loaded module script URL against the checkout's built `index.html`. Bypass
the service worker and HTTP cache during this check.

An authenticated browser run can use a separate server with an isolated
`HOME` and `OPENCHAMBER_DATA_DIR`, a generated `OPENCHAMBER_UI_PASSWORD`, and
its own Chrome profile. Keep the password inside the launcher and pass it to
CDP input without logging it. For heap comparisons, start each run in a fresh
page and close previous test pages; retained back/forward-cache documents can
otherwise inflate later runs. Measure the same selected session before and
after cleanup, and label JS heap separately from process RSS.

```bash
bun run build:ui && bun run build:web
cd <a project directory> && node <repo>/packages/web/bin/cli.js serve --port 4599 --foreground
```

`profile:idle` and `profile:session` need a running server; `profile:animation`
serves its own fixture and needs nothing.

## Running An Isolated Copy

Any server, dev shell or Electron an agent starts for a check runs beside the
maintainer's own app and dev shell, on the same machine.

- **Own data dir, own env.** Use a scratch `OPENCHAMBER_DATA_DIR` (and `HOME`
  where the run needs one); a headless client on the real
  `~/.config/openchamber` writes its default theme into the user's settings and
  the desktop app flips themes. Copy `settings.json` in, minus
  `desktopUiPassword`, when the run needs the saved projects or hosts. A shell
  inside the desktop app inherits its `OPENCHAMBER_*` variables (UI password,
  dist dir, agent-tool URL and token) and `OPENCODE_PASSWORD`: start copies
  with `env -i HOME USER PATH SHELL TMPDIR` or unset them first, and use
  `OPENCODE_BINARY=/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode`
  when `~/.opencode/bin/opencode` lags the version the repo needs.
- **Dev server:** from the repo root, after the env is clean,
  `OPENCHAMBER_DATA_DIR=<scratch>/oc-data OPENCHAMBER_HMR_UI_PORT=5391 OPENCHAMBER_HMR_API_PORT=3991 bun run dev`
  in the background; the UI is at `http://127.0.0.1:5391/`. It runs React
  StrictMode, which detaches and reattaches ref callbacks right after mount.
- **Packaged-UI Electron** (the `openchamber-ui://` origin, host windows,
  shared localStorage): `bun run --cwd packages/electron build:web-assets`,
  then from `packages/electron`, in the background,
  `env -i … OPENCHAMBER_ELECTRON_DEV=1 OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1 OPENCHAMBER_DISABLE_PWA_DEV=1 OPENCHAMBER_DATA_DIR=<scratch>/oc-data OPENCHAMBER_DESKTOP_USER_DATA_DIR=<scratch>/electron-userdata bun x electron ./entry.mjs --remote-debugging-port=9339`.
  The userData override avoids the installed app's single-instance lock; the
  window does appear on screen, and its logs mix into
  `~/Library/Logs/OpenChamber/main.log`.
- **Probes:** drive pages through `cdp.mjs` (`http://127.0.0.1:<port>/json/list`).
  Wait about 10 s after load before clicking, or navigation is ignored. Keep
  probe scripts in the gitignored `tmp/`. For chat scrolling, sample
  `scrollTop`/`scrollHeight` every frame against the fixture provider
  (`fixture-provider.mjs`, model `perf/stream-300cps`), with the project
  directory outside `/tmp` (the `/private/tmp` symlink changes behaviour), and
  run 4 to 6 times per variant, because scroll bugs are often intermittent.
  The in-app browser panel cannot wheel-scroll the inner chat scroller, and
  an occluded preview tab runs one frame per 500 ms, so its measurements lie.
- **One heavy job at a time.** A UI type-check, a build, a dev stack and a
  headless Chrome each take gigabytes; several at once have frozen the machine.
  Run at most one type-check or build per round (parallel agents run only
  single-file tests), and one live probe per round, at the end.
- **Stop exactly what you started.** Record each PID at launch and stop that
  process tree; a pattern kill (`pkill -f vite`, `pkill -f "cli.js serve"`)
  also hits the maintainer's dev shell, which runs the same scripts. Before a
  heavy run, check for orphaned headless Chromes and `opencode serve`
  processes from earlier probes and report them.

## profile:idle

Loads the app, lets it settle, then records a window during which no input is
delivered. Everything it reports is therefore work the app performs while the
user is doing nothing — the class of regression users notice as fan noise,
battery drain, and a permanently busy tab.

Reports per second of idle time: main-thread busy time, script, style
recalculation and layout time and counts, DOM node / document / frame /
listener growth, heap trajectory including a least-squares growth rate, a CPU
sampling profile with self time per function, and attribution of timer,
animation-frame and observer work to the call site that scheduled it.

```bash
# Baseline, then compare a change against it and fail on a budget.
bun run profile:idle -- --url http://127.0.0.1:4599 --output artifacts/before
bun run profile:idle -- --url http://127.0.0.1:4599 --baseline artifacts/before --budget-cpu 5
```

Scenario options reach a specific mounted state, because idle cost depends on
what is mounted: `--session`, `--tab`, `--panel <mode>`, `--expand-projects`,
`--expand-sessions`, and `--then-tab` (navigate away after settling, to measure
what a surface keeps doing once the user has left it).

## profile:session

Creates a session, opens it in a browser, dispatches a prompt through the
supported `openchamber session` CLI, and records until the session reports
itself idle. No input is synthesised; the prompt is the only stimulus.

Streaming is judged by responsiveness, not totals, so the report leads with the
long-task distribution, a timeline-trace breakdown naming where time went,
running animations, the application's own stream counters, and output-normalised
metrics.

```bash
bun run profile:session -- --url http://127.0.0.1:4599 --dir <project directory>
# What an idle session costs while a different session is active elsewhere:
bun run profile:session -- --view-session <idle session id> --expand-projects --expand-sessions
```

Without `--model` this command calls a real model. Use a real one to confirm
that a report reproduces, and the fixture provider below for everything else.

### Process CPU is the figure a user reports

Main-thread busy time and the CPU a process monitor shows are different
numbers. Streaming at 300 characters per second, the main thread is 17% busy
while the renderer process uses 34% of a core, because the compositor thread,
raster and garbage-collection workers, and the GPU process never appear in a
main-thread profile. Every run reports CPU per process, of one core, for each
Chrome process, the OpenChamber server, and the OpenCode instance it manages.

The sampler and the trace run inside the renderer and inflate that figure
(15% uninstrumented became 21-24% instrumented on the same scenario). Quote
process CPU from a `--process-cpu-only --headed` run: it switches every in-page
instrument off, and headless Chrome has no GPU, so its split between renderer
and GPU process is not the one a user has. Use an instrumented run to explain
the number, never to state it.

`--thread-breakdown` names the work behind it: CPU per thread across all traced
processes, with the trace events that spent it. `--save-trace` writes the raw
timeline for the DevTools Performance panel.

### Deterministic stimulus

A hosted model returns a different length at a different speed on every run,
and streaming cost follows the rate of deltas, not the amount of text. Two
captures against a real model are therefore not comparable. `fixture-provider.mjs`
is an OpenAI-compatible provider that always streams the same document, at the
rate the model name asks for. OpenCode still produces its real event stream.

```bash
node scripts/perf/fixture-provider.mjs 4601 &
OPENCODE_CONFIG_CONTENT="$(node scripts/perf/fixture-provider.mjs 4601 --print-config)" \
  node <repo>/packages/web/bin/cli.js serve --port 4599 --foreground
bun run profile:session -- --url http://127.0.0.1:4599 --dir <project directory> --model perf/stream-300cps
```

Rates from `stream-100cps` to `stream-1200cps` cover hosted models.
One run is never a result: repeat a scenario and aggregate with
`node scripts/perf/aggregate-runs.mjs <run directories…>`.
`perf/code-300cps` and `perf/code-1200cps` stream one 240-line code block,
because what a growing fence costs does not show in fences of five lines.
`perf/think-30s` stays silent for thirty seconds and then answers in one word:
it holds the app in its working state with nothing streaming, which is what an
agent thinking or running a tool looks like to the UI.
`perf/agent-20tools-300cps` (and `agent-40tools-300cps`) behaves like an agent:
each step says a line and calls the `glob` tool, OpenCode runs the tool for
real, and after the last step the document streams. The turn on screen then
carries twenty tool parts while the text arrives, which is the shape of a long
agentic turn and what the cost of re-rendering a turn per delta depends on.
`perf/unicode-300cps` (and `unicode-1200cps`) streams prose with em dashes,
curly quotes and whole Cyrillic paragraphs, and a 150-line TypeScript fence
whose comments and strings carry the same characters. V8 stores a string with
any character above Latin-1 at two bytes per character, which changes what
concatenation, slicing, lexing and hashing cost; the ASCII documents never
reach that path, and a Ukrainian-speaking user always does.
`stream-20000cps`, `code-20000cps` and `unicode-20000cps` are not stimuli:
they answer in about a second so that `seed-long-session.mjs` can build a
session with a hundred turns of realistic history in minutes:

```bash
node scripts/perf/seed-long-session.mjs --port 4599 --dir <project directory> --turns 120 --title "perf: long 120"
```

Run-to-run spread on an unchanged build is one to two points of renderer CPU,
so a smaller difference is noise.

`--inject-css` adds a stylesheet before the page loads, to measure what a rule
or an animation costs by switching it off without a rebuild. The report marks
such a run as a modified app. Keep it for attribution; a fix is measured on a
real build.

### Frame budget and the end of the reply

Besides long tasks (over 50 ms, what a user calls a freeze), the report counts
renderer main-thread tasks over 8.33 ms and over 16.7 ms: one frame at 120 Hz
and at 60 Hz, what a user calls jank while text streams. These counts use the
`CrRendererMain` thread only and warn when the trace does not name it.

`finalizeLongestTaskMs` is the longest main-thread task within 1000 ms after
the session went idle: the spike when the finished turn is finalised. The idle
edge is the first idle status frame for the session on the page's realtime
WebSocket after a busy one (OpenChamber's `openchamber:session-status`, or
OpenCode's `session.status` / `session.idle`), timestamped by the
browser, so the window starts when the page learned the reply ended; the CLI
poll that ends the recording is a second late and is not used. CDP network
timestamps and trace timestamps share Chrome's monotonic clock; the run checks
that the busy frame lands after its `perf:stream-start` mark and that the idle
frame lies inside the trace, and otherwise reports the metric as missing with a
warning, never as zero. Keep `--tail` at 1 s or more so the window is recorded.

### Measuring the desktop shell

`--attach <port>` measures a browser that is already running instead of
launching Chrome: the packaged desktop build started with
`--remote-debugging-port=<port>`. The session opens in the app's own window on
its own scheme, the window keeps the size the user gave it, and the report says
it was attached. `--url` still names the OpenChamber server the CLI talks to,
which for the desktop is the port in `desktopLocalPort` of its settings; run the
command with `OPENCHAMBER_DATA_DIR` pointing at that app's data directory so the
CLI reads the same settings. Electron's main process hosts the server, so the
per-process table lists it once, as `chrome browser`, and the managed OpenCode as
a server child.

Launch the build in an isolated home the way `profile:startup` does
(`HOME`, the `XDG_*` directories, `OPENCHAMBER_DATA_DIR` and
`OPENCHAMBER_DESKTOP_USER_DATA_DIR` under one temporary directory, and
`OPENCHAMBER_*` / `OPENCODE_*` / `ELECTRON_*` stripped from the environment),
seed its `settings.json` with the project to measure and a `desktopLocalPort`
that the installed app does not use, and pass the fixture provider through
`OPENCODE_CONFIG_CONTENT`. The installed app can keep running.

Hidden windows: on the machine this was written on (Electron 43.7, macOS 27)
a window that is hidden, minimized or covered keeps `document.visibilityState`
at `visible` and keeps animation frames ticking whatever
`setBackgroundThrottling` says, so a hidden-window figure needs its frame
liveness checked before it means anything. The GPU process stops drawing for a
hidden window in every configuration measured.

## profile:animation

Serves an isolated fixture and measures each animation variant directly, so a
comparison takes seconds instead of an application rebuild plus a streamed
response.

```bash
bun run profile:animation
bun run profile:animation -- --variant border-color --count 8
```

Measured on this repository's fixture, at any element count from 1 to 32:

| Animated property | Style recalculations/sec | Layouts/sec |
|---|---|---|
| none | 0 | 0 |
| `transform` (rotate, translate, scale) | 0 | 0 |
| `transform` + `steps(30)` | 0 | 0 |
| `opacity`, `filter` | 0 | 0 |
| `rotate` (the individual property) | 60 | 0 |
| `background-position` | 60 | 0 |
| `border-color` | 60 | 0 |
| `box-shadow` | 60 | 0 |
| `width` | 60 | 60 |

Animate `transform` and `opacity`. Anything else recalculates style on every
frame for as long as the animation runs, and geometry properties add layout on
top. Note that `rotate: 360deg` is *not* equivalent to
`transform: rotate(360deg)` in cost.

Composited does not mean free. With `--headed` the command also reports process
CPU, and a composited animation that costs the main thread nothing still makes
the compositor and the GPU process draw every frame: the three pulsing dots of
the chat status row (`busy-dots`) cost about 3% renderer plus 6.5% GPU process
on an otherwise still page, against 0.2% with no animation. An infinite
animation is paid for as long as it is on screen, so give it a bounded lifetime
or step it. Stepping halves the cost only when staggered elements share their
frames: `busy-dots-steps-aligned` makes one step equal to the stagger and
measures 4.7% against 10.3%. A running animation has a floor of its own, so
fewer steps do not approach zero, and a timer that writes the same frames
(`busy-dots-timer`) measured no cheaper.

VS Code uses `steps(30)` over 1.5 seconds specifically to reduce CPU usage.
Local repeated 32-element runs showed median main-thread busy 0.04% smooth vs
0.02% stepped, but these tiny values are environment-sensitive and the
documented contract is transform-only zero recalc/layout.

Add a variant to `animation-fixture.html` to measure a property or technique
that is not listed.

## profile:switch

Clicks sidebar session rows with real mouse input and measures, per click:

- `ack`: the clicked row is highlighted as active (the first visible reaction);
- `content`: messages that were not in the DOM before are in it. They may still
  be invisible: a freshly opened timeline stays at opacity 0 while renderers
  hold their provisional first paint (`data-timeline-reveal="pending"`), then
  fades in;
- `visible`: every new message that intersects the chat viewport has an
  effective opacity (its own times every ancestor's) of 1, checked once per
  animation frame. This is when the user sees the session, and it does not
  depend on how the reveal is implemented. `revealCleared` (the
  `data-timeline-reveal` attribute left the DOM) and `revealStates` (each
  attribute state with its time) are recorded next to it to explain it;
- layout shift after `visible`, for `--shift-window` ms (default 1500): the
  messages on screen at reveal are anchors, and `shift.maxPx` is the largest
  distance any of them moved relative to the chat viewport. That covers late
  code highlighting changing block heights, list re-measurement and scroll
  corrections alike, which is what a user sees as a jump. Also recorded:
  frames with movement, scroll-height and scroll-top changes, and the
  browser's own `layout-shift` score for the same window (which ignores
  scrolling, so it can read 0 while the content jumped). Showing a session
  before code is highlighted must not shift it: gate with `--budget-shift`.
  A zero is proven, not assumed: `--inject-script` with a script that adds a
  60 px margin to the on-screen message after each reveal reads `maxPx` 60
  on every switch (the app's pin-to-end scroll compensates a frame later, and
  the browser's layout-shift score missed one switch in four);
- the longest main-thread task inside the switch;
- every request the switch triggered, with encoded (on the wire) and decoded
  (parsed) bytes, totals per switch and per endpoint pattern (ids collapsed to
  `:id`, hashed assets to `/assets/*.js`), so fan-out and payload regressions
  show up next to the latency they cause.

Every session in the plan is visited twice per cycle. A visit is cold when it
is the first visit to that session since the page loaded (a network round
trip for messages), warm otherwise (served from the in-memory session store).
They have different budgets and are reported separately, overall and per
session.

Targeting: `--title <text>` adds the sidebar row containing that text
(repeatable), which is how a long seeded session joins the plan.
`--cold-reload --repeat <n>` reloads the page before every cycle, parked on a
session outside the plan (`--park`, default the first other row, opened with
`?session=`), so every cycle gives one cold visit per session; without it,
cycles after the first are all warm. `--profile-dir` gives a run its own
Chrome profile; the app keeps sidebar state and the last session in storage
per origin, so compared builds served on the same port each need a fresh one.

```bash
bun run profile:switch -- --url http://127.0.0.1:4599 --output artifacts/switch-before
bun run profile:switch -- --url http://127.0.0.1:4599 --baseline artifacts/switch-before --budget-ack 32 --budget-content 100
```

```bash
bun run profile:switch -- --url http://127.0.0.1:4599 --title "perf: long 120" --title "perf: short A" --title "perf: short B" --cold-reload --repeat 5 --headless
```

`--sessions a,b,c` picks the rows to click; the default is the first rows in
the sidebar, so pass explicit ids or titles to compare runs across days. The
row must be present in the sidebar; the command fails rather than measuring a
click on nothing, and skips (with a warning) a click on the session that is
already active, which would measure nothing.

## profile:startup

Launches a packaged Desktop build and reports, per launch, milliseconds since
the process was spawned: the main process's own `[startup-performance]` marks
(entry module, Electron ready, window created and shown, main module loaded,
server start and ready, OpenCode ready, application navigation and load), and
renderer readiness from `startup-probe.mjs`, a recorder installed into the
application document before it runs and checked once per animation frame:

- `reactMounted`: a child of `#root` carries React's fiber expando. `#root`
  holds the HTML splash `#initial-loading` from the first parsed byte, so a
  child count says nothing;
- `splashGone`: `#initial-loading` left the document (on the web, React's
  first commit replaces it);
- `overlayGone`: the React `AppStartupOverlay` left the DOM after its fade.
  It has no test id and is matched by its classes; `overlaySeen: false` in a
  sample means the selector is stale, not that the overlay was instant;
- `composerHittable` (the composer host wins `elementFromPoint` at its centre)
  and `composerEditable` (its editor is contenteditable outside any inert or
  disabled subtree);
- `usable`: all of the above in one frame;
- `modelPickerReady`: the app's `ModelControls:ready` trace mark with providers
  and a selected model;
- `trace:<name>`: the first occurrence of every `markStartupTrace` mark (the
  recorder turns the `OPENCHAMBER_STARTUP_TRACE` flag on);
- `rendererIdle` once the renderer main thread stayed quiet for `--settle-ms`.

Medians and p95 with min…max over the measured runs. A launch fails, and the
command exits non-zero, when the app process exits early, the application
never mounts, the recorder never ran, or it never becomes usable within
`--timeout-ms`; a failed warm-up counts too, because it means a broken build.
CDP calls are bounded, so a dead renderer fails the launch instead of hanging
the run.

`--url <OpenChamber URL>` measures the web app the same way in a fresh Chrome
per launch, from navigation start, and also records every request made until
`usable` with its bytes, grouped by endpoint. `--cache cold` (default) uses an
empty profile per launch, a first visit; `--cache warm` reuses one profile, a
returning user.

```bash
bun run profile:startup -- --url http://127.0.0.1:4599 --runs 10 --warmup 1 --cache cold
```

```bash
bun run electron:build           # or the package steps with --dir; only the .app is needed
bun run profile:startup -- --runs 5 --warmup 1 --window-at 1400,100
bun run profile:startup -- --app dist-a/OpenChamber.app --compare dist-b/OpenChamber.app
```

The app runs in an isolated home (`--home`, default under the OS temp
directory): its own settings, Electron profile, logs and OpenCode data, with
`OPENCHAMBER_*`, `OPENCODE_*` and `ELECTRON_*` stripped from the environment.
It never touches the installed app, and the installed app can keep running.
Electron on macOS resolves the home directory from the user record rather than
`$HOME`, so the profile is moved through the `OPENCHAMBER_DESKTOP_USER_DATA_DIR`
hook the entry module honours; a build without that hook would hit the
installed app's single-instance lock and exit at once.

`--compare` alternates launches of two builds so machine drift affects both
equally; compare builds rather than remembered numbers, because background
load on the machine moves every figure by tens of percent between sessions.
`--warmup` launches are discarded: the first launch of a new binary pays the
Gatekeeper scan and takes seconds. `--opencode cold` (default) lets the app
start its own OpenCode on every launch, the way a user's login does;
`--opencode warm` starts one from the bundled CLI before the runs and attaches
every launch to it through `OPENCODE_PORT`, which isolates OpenChamber's own
startup from OpenCode's. `--fresh` wipes the home before every launch to
measure the first launch after an install.

`--screen` (macOS, with `--window-at`) samples the window's pixels from the
screen and reports when they first changed and when they stopped changing.
Chromium stops painting an occluded window and a splash reads as "painted"
long before the interface is on screen, so this is the ground truth for what a
user sees. It needs the Screen Recording permission for the terminal running
the benchmark; without it the run reports the sampler as unavailable instead
of a number.

What the marks showed on the 2026-09-20 baseline (M-series Mac, packaged
build, isolated profile): Electron's own initialisation puts the first line
of our code at ~130 ms and `ready` at ~170 ms; a `BrowserWindow` costs ~55 ms
to construct and its first `ready-to-show` follows ~70 ms later; importing
the server module graph costs ~300 ms of main-thread time. A window whose
first paint is queued behind that import shows at ~600 ms; created on `ready`
and given the thread until it is on screen, it shows at ~320 ms.

The next known cost: `getLoginShellEnvSnapshot` in
`packages/web/server/lib/opencode/env-runtime.js` runs `$SHELL -lic 'env -0'`
synchronously on the Electron main thread during OpenCode bootstrap, although
Desktop already merged the same probe into `process.env`, so the user's shell
startup is paid twice.

## Reading The Results

Every run writes a JSON summary next to any raw capture, so results can be
compared later without re-running:

- `profile:idle` → `idle-summary.json`, `cpu-profile.cpuprofile`
- `profile:session` → `session-summary.json`, `cpu-profile.cpuprofile`
- `profile:startup` → `startup-summary.json`
- `profile:switch` → `switch-summary.json`, `trace.json`, `cpu-profile.cpuprofile`

`--baseline <directory>` prints a per-metric delta table against a previous run
of the same command. `--budget-*` options make the command exit non-zero, so the
same invocation works as an investigation tool and as a regression gate.

Artifacts can reveal project paths and endpoint names. They are gitignored; do
not publish them without review.

## Validity Guarantees

These commands fail loudly rather than reporting a clean result, because each
of these failure modes once produced a confident, wrong "everything is fast":

- **Throttled renderer.** Chrome stops producing frames and throttles timers for
  windows it considers backgrounded or occluded. Launch flags disable that, and
  every run measures frame liveness and warns when the renderer was not
  producing frames.
- **Missing trace data.** `RunTask` is only emitted under the
  disabled-by-default timeline category. A capture without it would report zero
  long tasks; the missing-task case is reported instead.
- **A scenario that never ran.** A session belonging to a directory the browser
  is not viewing renders nothing and produces a perfectly quiet profile.
  `profile:session` verifies both rendered growth in the DOM and message-list
  render counters before believing a quiet result. A virtualised timeline
  keeps its mounted message count constant, so new text counts as growth.
- **A response that never streamed.** A provider that rejects the request
  leaves the session idle within seconds with the user message rendered, which
  passes the check above. The run asks the session for an assistant message and
  says so when there is none.
- **A launch that never became the app.** `profile:startup` fails a run whose
  process exited early, or whose application document never mounted React or
  never became usable within the timeout, and exits non-zero, rather than
  reporting the milestones it did reach as a fast launch. "Mounted" means a
  React-created node, never the HTML splash.
- **Content that is in the DOM but not on screen.** A switched-to timeline is
  hidden until its reveal finishes; `profile:switch` reports `visible` from
  computed opacity next to `content`, and counts switches whose content never
  became visible.
- **A finalize window placed on the wrong clock.** The idle edge for the
  after-idle task is checked against a page mark and the trace bounds, and is
  reported missing when it does not fit.
- **A path no user takes.** Streaming state follows the app's active directory.
  A session opened by URL from another directory renders, but its timeline
  re-renders in full on every flush instead of only the streaming tail. The run
  compares the two directories and warns; make the session's directory the
  active project before trusting a render-cost figure.

Preserve this property when extending these scripts. A metric reading zero must
be a measurement, never a disabled instrument.

## Methodology Rules

- **Never report an "after" without a "before" on the identical scenario and
  build.** Rebuild the unchanged version and re-run it, however inconvenient.
  Expect plausible fixes to change nothing.
- **A sampling profiler cannot explain native work.** Self time in `(program)`
  only means the time was not in interpreted JavaScript. Use the trace
  breakdown, which names parsing, style, layout, layerization, paint and raster.
- **Normalise when the workload varies.** Assistant responses differ in length
  between runs, so per-second totals are not comparable; `profile:session`
  reports output-normalised metrics for this reason.
- **Revert what you cannot measure.** A change that does not move its target
  metric is unvalidated complexity, not a small win.
- **Reproduction may need production scale you do not have.** A threshold effect
  is invisible below its threshold. Compare the reporter's scale against yours
  on the dimension the code keys on before concluding a bug is absent.

## Module Layout

| File | Responsibility |
|---|---|
| `cdp.mjs` | Chrome launch, target discovery, minimal CDP client. Owns the anti-throttling launch flags. |
| `metrics.mjs` | Metric derivations shared by the profilers: growth rates, percentiles, long-task, frame-budget, windowed longest-task, trace-event and per-thread summaries. |
| `process-cpu.mjs` | CPU per process from cumulative counters: Chrome through browser-level `SystemInfo`, the server and its OpenCode child through `ps`. Unresolved processes are reported as missing, never as zero. |
| `fixture-provider.mjs` | Deterministic OpenAI-compatible provider: one fixed document at a rate chosen by model name. |
| `seed-long-session.mjs` | Builds a long session (default 120 turns) through the `openchamber session` CLI and the fixture provider's seeding models. |
| `aggregate-runs.mjs` | Median, p95, min and max per metric over repeated single-run captures, excluding runs whose validity flags say they measured nothing. |
| `network.mjs` | Request and byte accounting over the CDP Network domain, grouped by endpoint pattern. |
| `startup-probe.mjs` | Page-side startup recorder: React mounted, splash and overlay gone, composer usable, model picker, and the app's startup trace marks. |
| `cpu-profile.mjs` | Aggregates `Profiler.stop()` output into self time per function. |
| `idle-probe.mjs` | Page-side instrumentation installed before application code runs; attributes scheduled work to the call site that scheduled it. Must never change observable behaviour. |
| `scenario.mjs` | Shared scenario setup, currently sidebar expansion. Setup always runs before the measured window. |
| `animation-fixture.html` | Isolated animation variants for `profile:animation`. |
