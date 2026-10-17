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
| `bun run profile:heap` | How much JS heap and DOM the page keeps after hovering and opening N sessions. |
| `bun run profile:composer` | What each new composer line costs in style recalculation. |
| `bun run profile:toggle` | What opening and closing the left session sidebar and the right context panel costs, per toggle. |
| `bun run profile:compare` | Whether a change made the scenarios faster or slower: builds the before and the after, measures both the same way, prints one table. |
| `bun run profile:serve` | An isolated server with the fixture provider, to run the commands above by hand. |
| `bun run profile:analyze` | Where one run's time went: functions, source files, components, long tasks, renders. |
| `bun run build:web:diag` | Not a capture: the diagnostic build that names functions and components (Attribution below). |

All of them measure a real browser over CDP. Pass `--help` to any of them for
the full option list.

To answer "did my change help", start with `profile:compare` (Comparing Two
Builds). To answer "where does the time go", run one scenario on the
diagnostic build with `--render-probe` and read it with `profile:analyze`
(Attribution).

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
bun run build:web
bun run profile:serve        # isolated server on :4799 with the fixture provider
```

`build:web` compiles the UI from source; `build:ui` is only the UI
type-check and adds nothing to the bundle. `profile:serve` keeps its state,
project directory and seed under `tmp/perf-serve` (`--root`), refuses a busy
port, checks that it serves the build's main chunk, and stops the server, its
OpenCode and the fixture provider on Ctrl-C. Pass `--dir tmp/perf-serve/project`
to the session commands. Every command except `profile:animation` and
`profile:startup` without `--url` needs a running server.

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

## When An Accessibility Client Is On

Chrome builds no accessibility tree until a client asks for one: a screen
reader, or on macOS any app that reads other windows (window managers,
launchers, clipboard, dictation and automation tools, anything listed under
System Settings > Privacy & Security > Accessibility). From then on every frame
that changes what the tree exposes ends in a serialization pass inside the main
thread's `Commit` (`SerializeLifecycleStage`), and the browser process receives
the result. The same build therefore measures differently on two machines, and
headed differently from headless: headless Chrome has no client.

What it costs here, measured on an M-series Mac with such an app running:

- a node beside the transcript changing its own hidden state (`aria-hidden` or
  `inert` on the sidebar's column) re-serialized the transcript: 40 to 55 ms
  in the first frame of every sidebar toggle, two dropped frames. Hiding a
  node inside a small subtree costs a few ms; the sidebar now flips only
  `inert` on its content (`components/layout/Sidebar.tsx`);
- text in the transcript re-wrapping (a context panel wide enough to narrow
  the message column) re-serializes the transcript once, 40 to 50 ms, usually
  just after the animation and sometimes inside it;
- a session switch serializes the new transcript before it shows (45 to 65
  ms). It used to serialize it twice more after the reveal: when LegendList's
  DOM-order pass moved rows (about 40 ms; rows now mount in order, see
  `components/chat/message/parts/DOCUMENTATION.md`) and when code blocks got
  a span around every path-like token (about 30 ms on a cold switch; only
  confirmed files are wrapped now);
- streaming costs about 5% of main-thread time in small passes, with no long
  task.

Every `profile:toggle`, `profile:switch` and `profile:session` run records the
`accessibility` category and says which case it measured: `accessibility: on`
(with the native calls a macOS client made, or `forced`) or `off`. To check a
machine by hand, open `chrome://accessibility` in the browser being measured:
"Native accessibility API support" ticked means a client is on. Toggles report
`accessibility ms` per toggle, switches per switch, sessions for the stream.

`--force-accessibility` on those commands, and on `profile:compare`, launches
Chrome with `--force-renderer-accessibility`, so headless runs and every
machine measure the client case; measured headless, it reproduced the headed
figures above. Without it, compare runs only against each other on the same
machine in the same state: `compare-runs.mjs` flags a scenario whose sides
differ (`ACCESSIBILITY DIFFERS`). Find the cause with ablations, as for any
other cost: the trace names the pass, not what dirtied the tree.

## profile:idle

Loads the app, lets it settle, then records a window during which no input is
delivered. Everything it reports is therefore work the app performs while the
user is doing nothing — the class of regression users notice as fan noise,
battery drain, and a permanently busy tab.

Reports per second of idle time: frames the display compositor drew,
main-thread busy time, script, style recalculation and layout time and counts, DOM node / document / frame /
listener growth, heap trajectory including a least-squares growth rate, a CPU
sampling profile with self time per function, and attribution of timer,
animation-frame and observer work to the call site that scheduled it.

```bash
# Baseline, then compare a change against it and fail on a budget.
bun run profile:idle -- --url http://127.0.0.1:4599 --output artifacts/before
bun run profile:idle -- --url http://127.0.0.1:4599 --baseline artifacts/before --budget-cpu 5
```

Frames drawn come from a `viz`-only trace of `Display::DrawAndSwap`
(`frame-count.mjs`) and are the metric that sees motion: a composited spinner
or pulse costs the main thread nothing and draws 60 frames a second. A still
app draws about 0, the shared 1 s waiting tick 1. `--budget-frames <n>` fails
the run above `n`; prove the gate with the positive control, which must fail:

```bash
bun run profile:idle -- --url http://127.0.0.1:4799 --budget-frames 3 --inject-script scripts/perf/controls/pulse-dot.js
```

Scenario options reach a specific mounted state, because idle cost depends on
what is mounted: `--session`, `--tab`, `--panel <mode>`, `--expand-projects`,
`--expand-sessions`, and `--then-tab` (navigate away after settling, to measure
what a surface keeps doing once the user has left it). `--render-probe` names
the components that keep re-rendering while nothing happens, and
`--inject-script` runs an ablation.

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
or an animation costs by switching it off without a rebuild; `--inject-script`
does the same with a script (Ablations below). The report marks such a run as
a modified app. Keep it for attribution; a fix is measured on a real build.
An injected script that defines `globalThis.__perfInjected.snapshot()` gets its
result saved to `injected-probe.json` after the tail: the way to sample, say,
the distance from the scroll end during the stream. Read geometry inside a
`ResizeObserver` callback, which runs after layout, so the probe forces no
layout and requests no frame of its own.

`rAF callbacks/sec` counts the page's `requestAnimationFrame` calls, not
frames drawn; frames are `frames submitted/s` from a `--save-trace` run.

### The quiet floor and attribution options

`--quiet <seconds>` sends no prompt and records that long with the session
open and every instrument on. Streaming figures stand on this floor: what a
stream costs is the streaming run minus the quiet run on the same session, so
pair it with `--session` (the `quiet` and `long` scenarios of
`profile:compare` do exactly that). The summary says `quiet: true`, and the
stream checks (rendered growth, an assistant reply, the finalize task) read as
not applicable instead of failing the run.

`--heap-sampling` records a sampling heap profile (`heap.heapprofile`, opens in
the DevTools Memory panel) and lists the functions that allocated most. Reach
for it when heap max or GC time moves. It adds overhead, so the run is
attribution only, and the report says so.

`--extra-categories <list>` adds trace categories.
`disabled-by-default-devtools.timeline.invalidationTracking` names what
invalidated each style recalc; read it with `--save-trace` in DevTools.

`--render-probe` counts renders per component (Attribution below).

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
top.

Every variant also reports frames drawn per second. Measured headed under
Xvfb (software GL), two runs each, CPU of one core across Chrome's processes:

| Variant | Frames/sec | CPU % |
|---|---|---|
| `none` (still page) | 0.1 | 0.9-1.2 |
| `blink-timer` (1 s JS toggle, `useWaitingBlink`) | 1.0 | 0.9-1.0 |
| `caret-css` (CodeMirror's `steps(1)` caret) | 1.7 | 4.1-4.4 |
| `caret-timer` (600 ms JS toggle) | 1.7 | 1.2-1.5 |
| `opacity` (smooth pulse) | 59-60 | 7.3-7.6 |
| `transform-rotate` (spinner) | 60 | 7.7-8.2 |

A stepped animation draws few frames and still keeps the compositor ticking
every vsync, so `caret-css` costs three times `caret-timer` for the same
frames. Note that `rotate: 360deg` is *not* equivalent to
`transform: rotate(360deg)` in cost.

Composited does not mean free. With `--headed` the command also reports process
CPU, and a composited animation that costs the main thread nothing still makes
the compositor and the GPU process draw every frame: the three pulsing dots of
the chat status row (`busy-dots`) cost about 3% renderer plus 6.5% GPU process
on an otherwise still page, against 0.2% with no animation. An infinite
animation is paid for as long as it is on screen, so give it a bounded lifetime
or stop it. Stepping halves the cost only when staggered elements share their
frames: `busy-dots-steps-aligned` makes one step equal to the stagger and
measures 4.7% against 10.3%. A running animation has a floor of its own, so
fewer steps do not approach zero. At five changes a second a timer that writes
the same frames (`busy-dots-timer`) measured no cheaper; at one or two changes
a second a timer drops below the animation's floor (`blink-timer`,
`caret-timer` in the table above).

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
  A zero is proven, not assumed: `--inject-script scripts/perf/controls/shift-60px.js`
  adds a 60 px margin to the on-screen message after each reveal and reads
  `maxPx` 60 on every switch (the app's pin-to-end scroll compensates a frame later, and
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
cycles after the first are all warm. The app keeps sidebar state and the last
session in storage per origin, so every run gets a fresh temporary Chrome
profile, removed afterwards; `--profile-dir` reuses one on purpose.

```bash
bun run profile:switch -- --url http://127.0.0.1:4599 --output artifacts/switch-before
bun run profile:switch -- --url http://127.0.0.1:4599 --baseline artifacts/switch-before --budget-ack 32 --budget-content 100
```

```bash
bun run profile:switch -- --url http://127.0.0.1:4599 --title "perf: long 120" --title "perf: short A" --title "perf: short B" --cold-reload --repeat 5 --headless
```

`--render-probe` counts renders across the switches after the last page load
(with `--cold-reload`, the last cycle) and prints them per switch.

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

## profile:heap

Reads the JS heap, DOM nodes and listeners three times, each after two forced
garbage collections and a settle: with the app loaded, after resting the
pointer on each of the first `--count` sidebar session rows (600 ms each, the
hover-prefetch path), and after opening each of them (2 s each). Every run
gets a fresh Chrome profile that is removed afterwards, because retained
back/forward-cache documents in a reused profile inflate later runs.

```bash
bun run profile:heap -- --url http://127.0.0.1:4799 --count 20
```

The rows are the first N in sidebar order, so compare runs only on the same
server state and the same row count (`rows` in `heap-summary.json`). The heap
after opening includes the session cache by design: compare it between
builds, not against zero.

## profile:composer

Types `--lines` lines into the composer of an open session with Shift+Enter
between them, and reports for each Shift+Enter (the 700 ms after it, before
the next line's text) the style recalcs, the elements they restyled, their
time, and the top invalidation reasons. The draft is cleared afterwards.

```bash
bun run profile:composer -- --url http://127.0.0.1:4799 --session <long session id>
```

Open a long session: a value written where the transcript inherits it
restyles the whole mounted transcript, so the cost scales with what is
mounted. Element counts are deterministic for one session and are the figure
to compare; milliseconds follow the machine. The run fails when the page has
no editable composer, and warns when the editor holds fewer lines than were
typed, because then Shift+Enter inserted nothing and only typing was measured.

## profile:toggle

Opens a session from the sidebar (`--title`, default `perf: long 120`), then
toggles both sides the way a user does and records each toggle separately.
Three phases run in order, each with `--warmup` unrecorded-in-statistics pairs
(default 1) and `--count` measured pairs (default 5):

| Phase | Toggle types | Starting state |
|---|---|---|
| `sidebar` | `sidebar-close`, `sidebar-open` | context panel closed |
| `panel` | `panel-open`, `panel-close` | sidebar open |
| `sidebar-with-panel` | `sidebar-close@panel`, `sidebar-open@panel` | context panel open |

`--method click` (default) clicks the real buttons: the titlebar's sidebar
button (`data-sidebar-toggle`) and the rail button of `--surface` (default
`file`; `data-context-surface` carries the registry id), so the UI language
does not matter. The sidebar is `[data-left-sidebar]`. The right side is the
slot `[data-right-slot]`, which holds the context panel and the work-status
card: it can be as wide as the card while the panel is closed, so the panel's
open state is read from `data-context-panel-open`, never from the width.
Builds older than these hooks are found by icon and class, and the panel is
open when wider than 1 px, so a baseline from before them still measures. The
`file` surface opens tree-only (240 px) in a project with no file open;
`--open-file <name>` first opens that root-level file of the project from the
panel's tree, so every panel toggle shows the editor with it, and a
`panel-open` whose editor does not show the file afterwards is invalid.
`--surface context` measures a full-width panel. `--method key` presses `mod+b` and
`mod+alt+<rail digit>`, as the app's shortcuts read them. The pointer rests on
the button for `--hover` ms before a phase, so its tooltip opens there; the
first click closes it, which is one reason the warm-up exists. The other is
the first panel open, which loads the surface's code: a warm-up toggle is
recorded and printed, never pooled.

```bash
bun run profile:toggle -- --url http://127.0.0.1:4799 --output tmp/toggle/before
bun run profile:toggle -- --url http://127.0.0.1:4799 --title "perf: short A" --method key
```

Each toggle has a window: from a mark set just before the input until the
target's `width` transition ended plus `--tail` ms (default 250), or
`--window` ms when it never ends. Between toggles the page rests for
`--settle` ms, unrecorded. Per toggle, and as median / p95 per type:

- `input to next frame`: from the input event's timestamp to the end of the
  main-thread work of the next frame (an animation frame scheduled from the
  input, then a message task). `input task` is the trace task that handled the
  click or the shortcut's keydown. The Event Timing duration is recorded only
  when the browser reports it, above 16 ms;
- frame pacing from an animation-frame loop that runs only while a toggle is
  armed: the refresh interval comes from the `--pre` ms before the input,
  `worst frame` is the largest gap in the window, and a gap of k intervals
  counts k−1 `dropped frames`. Long animation frames (over 50 ms) are kept
  with the scripts inside them and their forced style and layout time;
- from the trace: style recalcs (count, ms, elements restyled) and layouts
  (count, ms), overall and for the worst frame (frames split at the main
  thread's `Commit`), and forced style/layout: a recalc or layout nested in
  script, attributed to the JS stack Chrome recorded on it. The run prints
  the top forcing stacks across measured toggles;
- `observed transition`: `transitionstart` to `transitionend` of the target's
  `width`, against the declared duration; widths and open states before and
  after, and the work-status card's width before and after;
- with `--render-probe`, React commits and renders inside the window with the
  components rendered most.

A toggle is invalid, and the run exits non-zero after writing its summary,
when the open state did not go from closed to open or back, the width did not
change, the page never received
the input, a width transition is declared but never ran, none is declared
without reduced motion, the window drew fewer than two frames or the refresh
interval before it was over 50 ms (throttled), the document was hidden, or the
trace has no renderer main thread for the window. `profile:compare` and
`compare-runs.mjs` exclude such a run. `--reduced-motion` emulates
`prefers-reduced-motion: reduce`; then no transition is expected, and a side
that still animates is a warning.

The recorder takes widths during the animation from a `ResizeObserver` and
reads geometry only outside the window, so it forces no layout of its own.
`dropped frames` in a headless run come from a software compositor: quote
frame pacing from a headed run (the default), and keep the window uncovered.
Prove the instruments with the positive control (Ablations below):
`--inject-script scripts/perf/controls/toggle-jank.js` must read dropped frames
and forced layouts on every toggle.

On a production build the forcing stacks name chunks, not modules: the main
app chunk is called after one of its modules (`useAppFontEffects-*.js` at the
time of writing), so a stack "in useAppFontEffects" is any app code. Map it
with the diagnostic build (`profile:analyze`, or `createSourceMapper` in
`source-map.mjs`) before blaming a file.

`--extra-categories cc,gpu,viz` adds trace categories. A long main-thread
`Commit` with nothing traced inside it is usually the accessibility pass
(When An Accessibility Client Is On): each toggle reports `accessibility ms`,
the summary says whether a tree was built, and `--force-accessibility` builds
one in any Chrome. Hiding a CodeMirror editor in place (`aria-hidden`,
`inert`, `display: none`, `content-visibility`) made that pass 200 to 300 ms
per close, while removing the editor's DOM cost a few ms (`CodeMirrorEditor`
`detached`).

## Comparing Two Builds

`profile:compare` automates the before/after rule from Methodology Rules:
same scenarios, same server state, same scripts, only the build differs.

```bash
# The uncommitted change against HEAD:
bun run profile:compare
# A committed change, more scenarios, before and after alternating twice:
bun run profile:compare -- --before <commit> --after HEAD --scenarios stream,code,agent,long,quiet,switch,idle,startup-cold --rounds 2
# The plan only: sources, worktrees, builds and every command line:
bun run profile:compare -- --dry-run
```

What it does, in order:

1. Resolves the sources. `--before` (default `HEAD`) and `--after` are
   commits; without `--after` the after side is the working tree: HEAD, plus
   `git diff HEAD --binary`, plus every untracked file that is not ignored.
2. Creates a worktree per side under `<root>/worktrees` (default root
   `tmp/perf-compare`), applies the diff and copies the untracked files into
   the after one, and verifies each worktree byte-identical to its source
   before building. A worktree whose source is unchanged since its last build
   is reused; a stale one is removed and recreated. They are ordinary git
   worktrees: `git worktree list` shows them, and
   `git worktree remove --force tmp/perf-compare/worktrees/<side>` deletes one.
3. Runs `bun install` and the web build (`--build diag`: the diagnostic
   build) in each, one at a time under `nice`. Logs go to `<root>/logs`.
4. Seeds the server state once per root, on the before build, when a scenario
   needs it: `perf: long 120` (120 turns) and `perf: short A/B/C`, kept in
   `<root>/seed`.
5. Per round, before then after: restores the seed, wipes the Chrome profiles,
   starts the fixture provider and an isolated server on that side's build and
   server code, refuses to continue unless the server serves that build's main
   chunk, runs every scenario serially under `nice`, and stops what it started.
6. Prints the table and writes it to `<output>/comparison.md`.

| Scenario | What runs | Notes |
|---|---|---|
| `stream`, `code`, `unicode`, `agent` | `profile:session` on the `-300cps` fixture (`agent`: `agent-40tools-300cps`) | a new session per run |
| `long` | `profile:session` streaming into the 120-turn session | the streaming path at scale |
| `quiet` | `profile:session --quiet 20` on the 120-turn session | the floor `long` stands on |
| `cpu` | `profile:session --process-cpu-only --headed` | the process CPU a user sees; opens a visible window |
| `switch` | `profile:switch` over long, short A and short B, `--cold-reload --repeat <runs>` | one invocation per round |
| `idle` | `profile:idle`, 30 s with the long session open | |
| `startup-cold`, `startup-warm` | `profile:startup --url`, `--runs <runs>` | one invocation per round |
| `heap` | `profile:heap --count 20` | sees the sessions earlier scenarios added; keep the scenario list identical between compares |
| `composer` | `profile:composer` on the long session | |
| `toggle`, `toggle-short`, `toggle-context` | `profile:toggle` on the long session and on short A, `--count <runs>`; `toggle-context` on the long session with the full-width `context` surface | one invocation per round; headed, opens a visible window |

`--render-probe` and `--save-trace` pass through to the scenarios that take
them. `--force-accessibility` launches the session, switch and toggle
scenarios with Chrome's accessibility tree on, so the table does not depend on
whether the machine runs an accessibility client. `--rounds 2` or more alternates the sides, so machine drift lands on
both; use it when the expected change is a few percent.

### Reading the table

Per scenario and metric: `median / p95 (n)` for each side, the change of the
median, and a verdict.

- `noise`: the after median lies inside the before runs' min…max. With five
  runs a change that small is not a result.
- `better` / `WORSE`: outside that range. Lower is better for every timing,
  count and percentage.
- Rows marked `(workload)` must match. `WORKLOAD DIFFERS` means the two sides
  did different work (different rendered characters, a different sidebar row
  count), and no other row of that scenario is comparable.
- `switch` and `startup` pool every switch or launch. Switch pools sessions of
  different sizes, so its range is wide and its noise verdict conservative;
  `bySession` in each `switch-summary.json` has one session's numbers.
- `toggle` pools every measured toggle, one row set per toggle type
  (`panel-open worst frame ms`); `byType` in each `toggle-summary.json` has
  every metric, including the ones the table leaves out.
- With `--save-trace`, session scenarios add pipeline rows (frames submitted,
  elements restyled, layerize, GPU compositor, raster); with `--render-probe`,
  render rows and a renders/s table per component.

The lines under each scenario are its validity flags: runs excluded and why,
modifications (render probe, injected script, quiet), low frame liveness, a
reply end not placed on the trace, rendered characters that vary between
runs. A scenario without such lines measured what it claims.

A run whose summary exists is skipped, so an interrupted compare resumes.
`<output>/sources.json` pins the sources and the build; once the code changes,
the old output is refused and needs a new `--output`. A compare of a clean
tree against `HEAD` is an A/A run: it measures the noise floor of the machine.

`node scripts/perf/compare-runs.mjs <before dir> <after dir>` reprints the
table from saved runs, and compares any two directories of run directories
named `<scenario>-<n>`, such as an ablation batch against its control.

## Attribution

Timings come from the production build. Names come from the diagnostic build
of the same tree, with the render probe and `profile:analyze`; ablations then
prove which suspect owns the time.

### The diagnostic build

`bun run build:web:diag` writes `tmp/web-dist-diag` with the production
config (`packages/web/vite.diag.config.ts`) minus minification, plus source
maps, plus zustand reporting store notifications to the render probe. Serve it
with `bun run profile:serve -- --dist tmp/web-dist-diag`, or use
`profile:compare --build diag`. Unminified code runs at a different speed, so
its timings are never quoted; it answers which function, component and store.
It is written outside `packages/web` on purpose: the desktop app copies that
package into its asar, so a build there ships inside the app.
The build fails when zustand's store source changes shape, rather than
producing store counts that silently read zero.

### Render probe

`--render-probe` on `profile:session`, `profile:switch`, `profile:idle` and
`profile:toggle` installs `render-probe.mjs` before application code: a
minimal React DevTools hook that walks every commit, the store probe, and a
MutationObserver. The run
writes `render-probe.json`, adds `renderProbe` to its summary, and prints:

- per component: renders/s; `no DOM`, the renders whose whole subtree wrote
  nothing to the DOM (pure waste: a memo boundary or a narrower subscription
  removes them); the cause: `parent` (with the props that changed),
  `parentSameProps` (a new props object with equal values), `state`, `store`
  or `context`;
- cascades by origin: the component whose own state, store or context started
  a render, and what re-rendered under it (in `render-probe.json`);
- store notifications/s, listeners run/s, the keys that changed and where the
  store was created. Only the diagnostic build reports them; on any other
  build the report says they were not recorded, never zero;
- DOM mutation records/s per UI region. Regions are matched by the selectors
  in `render-probe.mjs`; growth in `app-other` means one stopped matching.

`--render-probe-hook <Component:index>` also records the call stacks that
dispatch to that hook, to find who keeps setting a state.

The probe works on every commit, prints its own cost, and inflates the run's
timings. When React never registers with the hook the run says so instead of
reporting zero renders.

### profile:analyze

```bash
bun run profile:analyze -- <run dir> --dist <checkout>/tmp/web-dist-diag
bun run profile:analyze -- <run dir> --dist <…> --callers 'setProperty'
```

From the artifacts a run already wrote, it prints CPU self and inclusive time
by function, inclusive time by app source file and by component render body;
the caller chains of functions matching `--callers`; scheduled work by call
site; the rendering pipeline per second (`trace.json`); main-thread tasks over
`--tasks-over` ms grouped by trigger and outermost call, with their script,
style, layout and paint split; style recalcs that touched at least
`--recalcs-over` elements (a whole-document restyle shows here); and the
render probe. `--dist` must be the build the run served: without source maps
the positions stay chunk names, and on a minified build the function names
stay minified.

### Ablations

Switch one suspect off in the page and measure again. A suspect that does not
move the number when disabled is not the cause, however busy it looks.
`scripts/perf/ablations/` holds snippets for `--inject-script`:

| Snippet | Switches off |
|---|---|
| `instant-web-animations.js` | every Web Animations API animation (motion) finishes at once |
| `instant-smooth-scroll.js` | smooth `scrollTo` jumps instantly, so the chat's follow glide draws no frames |
| `no-css-animations.js` | every CSS animation and transition, and Web Animations: the upper bound of what motion costs |

One rule at a time goes through `--inject-css` on `profile:session`, such as
`'.animate-status-logo{animation:none!important}'`. Against one server:

```bash
bun run profile:serve        # in its own terminal
for i in 1 2 3; do bun run profile:session -- --url http://127.0.0.1:4799 --dir tmp/perf-serve/project --model perf/stream-300cps --output tmp/ablate/control/stream-$i; done
for i in 1 2 3; do bun run profile:session -- --url http://127.0.0.1:4799 --dir tmp/perf-serve/project --model perf/stream-300cps --inject-script scripts/perf/ablations/instant-web-animations.js --output tmp/ablate/no-waapi/stream-$i; done
node scripts/perf/compare-runs.mjs tmp/ablate/control tmp/ablate/no-waapi
```

A new snippet is an IIFE that disables one mechanism and leaves the rest of
the app working, with a header comment naming what it removes; a broken page
measures nothing. Ablation runs describe a modified app and are marked so in
the summary and the table. The fix that follows is measured with
`profile:compare` on real builds.

`scripts/perf/controls/` holds positive controls: injections that create the
effect a metric must catch. `shift-60px.js` moves content after each switch
reveal, so `profile:switch` has to read a 60 px shift. `toggle-jank.js` busy-waits
25 ms and forces a layout on every frame of a width transition, so
`profile:toggle` has to read dropped frames, a worst frame of 25 ms or more,
and forced layouts under `forceLayoutOnTransitionFrame` on every toggle.

## Reading The Results

Every run writes a JSON summary next to any raw capture, so results can be
compared later without re-running:

- `profile:idle` → `idle-summary.json`, `cpu-profile.cpuprofile`
- `profile:session` → `session-summary.json`, `cpu-profile.cpuprofile`
- `profile:startup` → `startup-summary.json`
- `profile:switch` → `switch-summary.json`, `trace.json`, `cpu-profile.cpuprofile`
- `profile:heap` → `heap-summary.json`; `profile:composer` → `composer-summary.json`
- `profile:toggle` → `toggle-summary.json`, `trace.json`, with `--cpu-profile`
  `cpu-profile.cpuprofile`
- `--render-probe` → `render-probe.json`; `--heap-sampling` → `heap.heapprofile`;
  `--save-trace` → `trace.json` (`profile:analyze` and `compare-runs.mjs` cache
  their pipeline figures next to it in `trace-pipeline.json`)
- `profile:compare` → `<output>/before|after/<scenario>-<n>/` with the above,
  `bundle-check-<round>.json` per side, `sources.json`, `comparison.md`

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
  keeps its mounted message count constant, so new text counts as growth,
  measured per message: in a long session the rows above unmount as the reply
  grows, and the page's total text shrinks while a whole reply streams in.
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
- **A server running another build.** `profile:serve` and `profile:compare`
  compare the main chunk the server serves with the build's own `index.html`
  and refuse to measure on a mismatch; `profile:compare` also verifies each
  worktree byte-identical to its source before building it.
- **Two sides that did different work.** `profile:compare` marks workload rows
  (rendered characters, sidebar rows) and flags them when they differ, since
  every other row of that scenario is then incomparable.
- **An instrument that never attached.** The render probe reports when React
  never registered with its hook, and store notifications on a build without
  the store probe as not recorded.
- **A path no user takes.** Streaming state follows the app's active directory.
  A session opened by URL from another directory renders, but its timeline
  re-renders in full on every flush instead of only the streaming tail. The run
  compares the two directories and warns; make the session's directory the
  active project before trusting a render-cost figure.

Preserve this property when extending these scripts. A metric reading zero must
be a measurement, never a disabled instrument.

## Methodology Rules

- **Never report an "after" without a "before" on the identical scenario and
  build.** Rebuild the unchanged version and re-run it, however inconvenient:
  `profile:compare` does exactly that. Expect plausible fixes to change nothing.
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
| `cdp.mjs` | Chrome launch, target discovery, minimal CDP client. Owns the anti-throttling launch flags and the per-run temporary Chrome profile (`resolveProfileDir`); `profile:browser` alone keeps a reusable profile, for a manually driven session. |
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
| `isolated-server.mjs` | `profile:serve`, and the server, fixture, seed-restore and bundle-check functions `profile:compare` uses. Strips `OPENCHAMBER_*`, `OPENCODE_*` and `ELECTRON_*` from every child it starts. |
| `render-probe.mjs` | Page-side render attribution: React commit hook, store probe, DOM mutations per region; its summary and report. Must never change observable behaviour. |
| `run-summary.mjs` | Reading run directories, and the one definition of a run that measured nothing and of a modified run. |
| `compare-runs.mjs` | The before/after table over two directories of runs. |
| `analyze-run.mjs` | `profile:analyze`: attribution report for one run directory. |
| `accessibility.mjs` | Accessibility-tree work in a trace window, whether a tree was built and who asked for it, and the flag that forces one. |
| `trace-analysis.mjs` | Saved-trace analysis: pipeline per second, task classification, large style recalcs. |
| `toggle-analysis.mjs` | `profile:toggle`'s pure analysis: refresh interval and frame pacing, per-window style/layout and forced layouts from the trace, renders per window, statistics per toggle type. |
| `source-map.mjs` | Dependency-free source-map reader for the diagnostic build. |
| `ablations/`, `controls/` | Injected scripts: ablations switch a suspect off, controls create the effect a metric must catch. |
