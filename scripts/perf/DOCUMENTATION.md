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
| `bun run profile:browser` | A manually driven capture, for interactions that cannot be scripted. |

All of them measure a real browser over CDP. Pass `--help` to any of them for
the full option list.

## Before Measuring Anything

**Measure a production build.** A development build's render and bundle
behaviour does not represent what users run.

```bash
bun run build:ui && bun run build:web
cd <a project directory> && node <repo>/packages/web/bin/cli.js serve --port 4599 --foreground
```

`profile:idle` and `profile:session` need a running server; `profile:animation`
serves its own fixture and needs nothing.

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
`perf/think-30s` stays silent for thirty seconds and then answers in one word:
it holds the app in its working state with nothing streaming, which is what an
agent thinking or running a tool looks like to the UI. Run-to-run
spread on an unchanged build is one to two points of renderer CPU, so a smaller
difference is noise.

`--inject-css` adds a stylesheet before the page loads, to measure what a rule
or an animation costs by switching it off without a rebuild. The report marks
such a run as a modified app. Keep it for attribution; a fix is measured on a
real build.

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

Add a variant to `animation-fixture.html` to measure a property or technique
that is not listed.

## profile:switch

Clicks sidebar session rows with real mouse input and measures, per click, the
two moments a user feels: `ack`, when the clicked row is highlighted as active
(the first visible reaction), and `content`, when the timeline shows messages
that were not on screen before. It also reports the longest main-thread task
inside each switch and every request the switch triggered, so fan-out
regressions show up next to the latency they cause.

Every session in the plan is visited twice. The first visit is usually cold
(a network round trip for messages); the second is warm, served from the
in-memory session store. They have different budgets and are reported
separately.

```bash
bun run profile:switch -- --url http://127.0.0.1:4599 --output artifacts/switch-before
bun run profile:switch -- --url http://127.0.0.1:4599 --baseline artifacts/switch-before --budget-ack 32 --budget-content 100
```

`--sessions a,b,c` picks the rows to click; the default is the first rows in
the sidebar, so pass explicit ids to compare runs across days. The row must be
present in the sidebar; the command fails rather than measuring a click on
nothing.

## Reading The Results

Every run writes a JSON summary next to any raw capture, so results can be
compared later without re-running:

- `profile:idle` → `idle-summary.json`, `cpu-profile.cpuprofile`
- `profile:session` → `session-summary.json`, `cpu-profile.cpuprofile`

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
| `metrics.mjs` | Metric derivations shared by the profilers: growth rates, percentiles, long-task, trace-event and per-thread summaries. |
| `process-cpu.mjs` | CPU per process from cumulative counters: Chrome through browser-level `SystemInfo`, the server and its OpenCode child through `ps`. Unresolved processes are reported as missing, never as zero. |
| `fixture-provider.mjs` | Deterministic OpenAI-compatible provider: one fixed document at a rate chosen by model name. |
| `cpu-profile.mjs` | Aggregates `Profiler.stop()` output into self time per function. |
| `idle-probe.mjs` | Page-side instrumentation installed before application code runs; attributes scheduled work to the call site that scheduled it. Must never change observable behaviour. |
| `scenario.mjs` | Shared scenario setup, currently sidebar expansion. Setup always runs before the measured window. |
| `animation-fixture.html` | Isolated animation variants for `profile:animation`. |
