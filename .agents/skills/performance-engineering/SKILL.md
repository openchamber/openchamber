---
name: performance-engineering
description: Use when measuring, profiling, or comparing performance; when implementing or reviewing code on startup, interaction, render, scroll, event, polling, synchronization, list-processing, store-selector, cache, indexing, or high-volume data paths; when users report lag, freezes, jank, high CPU, memory growth, heavy network traffic, slow startup, or performance regressions; and before accepting memoization or caching as a fix for repeated work.
---

# Performance Engineering

## Overview

Optimize the amount and frequency of work before optimizing individual operations.

**Core principle:** Make expensive work structurally unnecessary. A fast inner function still freezes the app when called millions of times on the main thread.

Load `sync-state-invariants` when an optimization changes state authority, reconciliation, optimistic data, event ordering, cache lifecycle, or destructive cleanup. This skill owns measured cost; `sync-state-invariants` owns state correctness.

## Start With A Performance Contract

Define before editing:

| Dimension | Required answer |
|---|---|
| Interaction | Which user action or event must remain responsive? |
| Scale | Realistic and worst-known entity counts |
| Budget | Target latency, frame time, CPU, memory, or operation count |
| Path | Main thread, worker, server, network, disk, or mixed |
| Semantics | Ordering, ownership, freshness, failure, and partial-data invariants |

Do not optimize against a toy fixture when the report provides production scale.

## Workflow

Complete the numbered workflow in order. An optimization is complete only when the exact measured scenario meets its budget and separate correctness checks preserve every applicable state, identity, layout, and lifecycle transition.

### 0. Trust The Measurement Before Trusting The Number

A measurement setup that is wrong produces clean, confident, wrong numbers, and
a clean number ends an investigation. Establish validity first.

**Prove the environment is not throttled.** Chrome stops producing frames and
throttles timers for windows it considers backgrounded or occluded, headless or
not. A capture taken that way reports near-zero rendering work no matter what
the page does. Disable background/occlusion throttling at launch and measure
frame liveness inside the capture. The same applies to any environment that
idles when unobserved.

**Prove zero is a measurement.** A metric reading zero, absent, or perfectly
quiet is a claim that requires evidence, because a disabled instrument reports
exactly the same thing. `RunTask` only appears under the disabled-by-default
timeline category; a scenario opened for the wrong directory renders nothing at
all. Before believing a quiet result, confirm the instrument fired and the
workload actually ran: assert on an independent signal, such as DOM growth
alongside the application's own render counters. A positive control proves it
outright: inject the effect the metric should catch (a 60 px shift through
`profile:switch --inject-script`) and confirm the metric reads it.

**Prove the probe ends where the user's wait ends.** A probe that fires on an
earlier moment reports a wait nobody has: "mounted" that fires when the HTML
splash parses, "content" that fires while the transcript is still invisible
behind a reveal hold. Check each end condition once against a screenshot or a
frame trace of the moment the user can act.

**Prove the workload is comparable.** When the stimulus varies in size between
runs, per-second and total figures are not comparable. Normalise by units of
work delivered, and check run-to-run spread on an unchanged build before
attributing any difference to a change. The same build drifts between
sessions (one fixture read 13% and 9% main-thread busy hours apart), so run
the before and after back to back, interleaved when the delta is small.

**Prove the claim on the hardware it is about.** Headless Chrome composites on
a software GPU: a mask swap cut GPU time 39% headless and nothing headed. Confirm
GPU and compositor claims with headed, uninstrumented runs
(`scripts/perf/DOCUMENTATION.md`, "Process CPU is the figure a user reports").

Do not report a number whose validity you have not established. State which
validity checks ran.

### 1. Reproduce And Measure

- Reproduce the exact interaction, not a nearby helper in isolation.
- Separate scripting, rendering, painting, network, disk, and waiting time.
- Use a profiler to identify total time and self time.
- Add operation counters when timings are noisy: selector calls, normalizations, scans, allocations, sorts, notifications.
- Capture a baseline before changing code.

Do not infer a bottleneck from code appearance when a trace or counter can identify it.

**Attribute before you fix.** Measure absolute numbers on the minified
production build and attribute on a diagnostic build of the same tree with
readable names and source maps. Count renders per component from a React
commit hook injected before app code, and record whether each render changed
the DOM: a component that re-renders with zero mutations is pure waste. Then
ablate: switch one suspect off in the page and re-measure (the tooling for
each step is under "Attribution" in `scripts/perf/DOCUMENTATION.md`). A suspect that does
not move the number when disabled is not the cause, however busy it looks
(promoting a spinner to its own layer with `will-change`, `translateZ` or
`contain` changed no CPU figure). Rank the
findings by measured share of the budget, and keep "clearly wasteful" apart
from "intentional but expensive", which is the owner's call (Know When To
Stop).

Treat every proposed optimization as a hypothesis. Memoization, caches, indexes, workers, scheduling, retries, and lifecycle machinery must address an observed cost or failure in the measured path; “could be slow” or “might race” is not evidence. Keep only the smallest mechanism that meets the contract, except where an inherent security, data-loss, destructive-operation, or concurrency invariant requires proactive protection.

**Never accept an "after" without a "before" on the identical scenario and
build.** Measuring a fixed build against a remembered number, a different
scenario, or a nearby baseline proves nothing: the mechanism you changed may
not even execute in the path you measured. Re-run the unchanged build through
the same scenario, however inconvenient the rebuild. Expect to discover that a
plausible fix changes nothing.

**A sampling profiler cannot explain native work.** Self time attributed to
`(program)` says only that the time was not in interpreted JavaScript. Use the
timeline trace, which names parsing, style recalculation, layout, layerization,
paint, and raster, and reserve the sampler for attributing application code.

**Reproduction may require production scale you do not have.** A threshold
effect is invisible below its threshold, and a development workspace is usually
below it. When a report will not reproduce, compare the reporter's scale
against yours on the specific dimension the code keys on before concluding the
bug is absent.

Profiling identifies where time is spent; it does not prove behavioral equivalence. Separately verify the applicable state, identity, layout, and lifecycle transitions for every structural optimization.

### 2. Write The Cost Equation

Name every multiplying dimension:

```text
consumers × events × projects × sessions × candidate paths
```

For each factor, record:

- cardinality at production scale;
- update frequency;
- whether work happens on the main thread;
- whether multiple consumers independently derive the same result.

Treat hidden fanout as real work. Equality checks may prevent renders while selectors, aggregation, sorting, and allocation still execute.

### 3. Map Sources, Derived State, And Lifetimes

Classify each input:

- authoritative or partial;
- live or historical;
- stable or high-frequency;
- successful empty result or fetch failure;
- globally complete or complete only for one entity.

Define invalidation before adding a cache. Prefer a stronger source of truth over inference.

For destructive consumers, represent completeness explicitly. An incomplete empty bucket means "unknown", not "delete everything".

Track completeness at the smallest destructive scope. One failed project/entity blocks cleanup for itself, not for unrelated complete scopes.

### 4. Remove Work In This Order

1. **Skip:** gate disabled paths and return on no-op updates.
2. **Narrow:** subscribe to the exact entity/field that can affect the result.
3. **Share:** compute identical derived data once for all consumers.
4. **Index:** represent the lookup direction the UI actually needs.
5. **Increment:** update only affected buckets/entities and preserve other references.
6. **Cache:** reuse pure results with explicit keys, invalidation, and memory bounds.
7. **Schedule:** defer, chunk, or move genuinely unavoidable CPU work off the interaction path.
8. **Micro-optimize:** tune regexes, loops, and allocations only after structural multipliers are gone.

Do not jump to a worker to hide avoidable work. Do not add a global store when a local shared index has the correct lifetime.

### 5. Retest What Depended On The Old Timing

An optimization that changes when something happens (the UI shows earlier, a
hold is removed, the first frame already has its final geometry) also removes
the cover that hid latent races. Showing the shell before OpenCode answered
surfaced a first-run dialog over the composer, a draft flashing before the
restored session, and bootstraps that failed during startup and never re-ran;
a first paint with stable geometry let LegendList run its DOM-order pass inside
the reveal. After any timing change, walk the flows that relied on the old
order: first visit with empty storage, cold start before the backend is ready,
restore and revert, and session open, each with a frame trace or in the app.

## Structural Pattern

Replace repeated questions with maintained answers:

```ts
// Bad: every consumer asks every item about every owner.
for (const project of projects) {
  const items = sessions.filter((session) => belongsTo(project, session, topology));
}

// Good: resolve ownership once, then read direct buckets.
const sessionsByProject = new Map<string, Session[]>();
for (const session of sessions) {
  const projectId = ownership.resolve(session.directory);
  if (projectId) append(sessionsByProject, projectId, session);
}
```

Prefer indexes keyed by stable IDs. Keep high-frequency runtime state out of metadata indexes unless it changes membership.

## React And Store Hot Paths

- Subscribe to leaf values, not broad collections.
- Preserve references for unaffected entities and buckets.
- Keep streaming state out of broadly consumed stores.
- Never rely on `React.memo`, `useMemo`, or Zustand equality to prevent selector execution upstream.
- Treat every custom memo/equality comparator as a correctness boundary. Inventory every render-relevant value that comparator gates and observe its canonical identity or an explicit semantic version covering the same semantics.
- Do not compare a proxy, aggregate, fallback, or differently resolved identity when the gated render path uses another source. Stable entity IDs do not imply stable rendered content; changes to comparator-gated semantics under the same ID must invalidate affected consumers, while semantically equivalent replacements may remain stable.
- Prefer leaf subscriptions for isolated high-frequency state over threading broad state through custom comparators. Keep comparator work bounded so render fanout is not merely replaced by recursive comparison fanout.
- Do not sort structural lists from token/delta-frequency fields.
- Coalesce repeated same-entity events and skip no-op reducer updates.
- Ensure hidden or disabled surfaces perform no ongoing work.
- Preserve scroll position synchronously with `useLayoutEffect`; do not wait visible frames before compensation.
- Distinguish viewport resize from content growth and avoid fighting browser scroll anchoring.
- Avoid textarea auto-size shrink/expand cycles when content only grows.
- Freeze structural ordering during high-frequency updates and reorder at an explicit lifecycle edge.

## Virtualization Contracts

Virtualization changes layout, mounting, measurement, focus, and scroll semantics. It is not behaviorally equivalent merely because steady-state visible rows look the same.

Before virtualizing a collection, define:

- the actual scrolling element and whether it directly contains the virtualizer or is an ancestor;
- how total virtual height and the final item remain reachable from that scroller;
- estimated versus measured sizes, including expanded, nested, and dynamically resized items;
- initialization, remount, and activation-threshold behavior;
- interactions that depend on mounted DOM, including incremental reveal, focus, selection, drag-and-drop, menus, and accessibility traversal.

Lists here use `@tanstack/react-virtual`; the chat transcript uses LegendList (`components/chat/lib/scroll/DOCUMENTATION.md`). Known traps: a virtualizer enabled before its scroll element exists caches offset 0 and scrolls the scroller to the top on attach, so enable it only once the element is known; row margins collapse in plain flow but not across virtual wrappers, so spacing doubles when virtualization kicks in; `getVirtualItems()[0]` is the overscan boundary, not the first visible row; a scroller hosting a virtualizer sets `overflow-anchor: none`. `bun-patches/@tanstack+virtual-core+*.patch` clamps the render range to real scroll bounds inside a shared scroller: carry it over when bumping the dependency.

When activation is threshold-based, test threshold minus one, threshold, and threshold plus one. Also test applicable collapsed/expanded, hidden/visible, filtered/unfiltered, and short/long transitions. If the current DOM or scroll topology cannot expose the virtual tail reliably, correct that topology or retain normal rendering rather than virtualizing solely by item count.

## Caching Rules

Add a cache only when all are explicit:

- exact key and source identity;
- invalidation events;
- stale-result behavior;
- memory count and byte bounds where values can grow;
- runtime/project/user isolation where identities can collide;
- proof that caching removes enough work to meet the budget.

Do not introduce a cache merely to make an abstraction reusable or prepare for future consumers. First prove repeated work in the real path; then place the cache with the narrowest owner and lifetime that can invalidate it correctly.

A cache inside an `O(consumers × entities × candidates)` loop is a mitigation, not automatically a complete fix.

## Known Costs In This Codebase

- **On-demand surfaces load through `useOnDemandComponent`** (`hooks/useOnDemandComponent.ts`): import first, then render. A `React.lazy` component behind `Suspense` holds its real content at least 300 ms after the fallback shows (React's fallback throttle), whatever the CPU.
- **A whole-UI freeze with a fast server and no event-loop lag is browser connection-pool starvation.** Server timing starts when Express receives a request; the browser's queue is invisible there. Background fan-out goes through the `lib/background-network.ts` gate (a cap, not `priority: 'low'`, which changes nothing), and slow third-party reads get a cap and a timeout.
- **Freshness comes from signals, never idle traffic.** Relay bytes are paid, so nothing polls or streams while nothing happens: refresh from events the client already gets (agent tool calls, git status, own operations), only for what is visible, batched (the Files tree re-lists at most once per 2 s per surface and never auto-re-lists a folder whose last listing had over 1000 entries).
- **A repeated read asks for what it needs, not the list it filters.** Child-session discovery paged through a directory's whole session list every 15 s to keep the children of live sessions: 3.6 MB a pass at 1,100 sessions, about 1 GB an hour over loopback, which a user reported as the app's network traffic. `parentID` returns those children in a few kilobytes. Before a timer reads a list, check the OpenCode route for a filter. To measure what the installed app sends, see `references/loopback-traffic.md`.
- **An inherited custom property on a transcript ancestor restyles the whole transcript.** Writing `--scroll-shadow-*` or `--chat-composer-*` on the chat column or scroller restyled ~47k elements (45 to 90 ms) at every reply start/end and composer line, and `--oc-titlebar-controls-width` on `<html>` restyled the whole document (~65k elements, ~100 ms) on every sidebar toggle. Write the value on the elements that read it (`composer/state/composerInsetReaders.ts`) or register it with `@property … { inherits: false }`.
- **Hidden-state flips beside the transcript cost a frame when an accessibility client is on.** `aria-hidden` or `inert` changing on the sidebar's column re-serialized the whole transcript (40 to 55 ms, two dropped frames, every toggle); flip them on a small subtree inside it (`Sidebar.tsx` hides only its content, with `inert`). Headless runs never show it: measure with `--force-accessibility` (`scripts/perf/DOCUMENTATION.md`, "When An Accessibility Client Is On").
- **Focus and inherited flips on a large subtree restyle all of it.** Tailwind's group variants compile to `:is(:where(.group):focus-visible *)`, so a focus change on an element restyles its whole subtree: focusing the context zone's aside cost 40 ms with a 300-row file tree open, focusing an empty element inside it cost nothing. `inert`, `pointer-events` and `user-select` flips cost the same. Measure such surfaces on a real repository: the perf fixture project has a few files, and a three-file tree hides costs that scale with rows.
- **A closed surface still pays for its subscriptions.** An always-mounted dialog that reads session messages rebuilt itself on every streamed flush. Put the reading body inside `DialogContent` so it mounts only while open or closing (`TimelineDialog`, `SessionGoalDialog`).
- **Whole-record session hooks re-render on every streamed step.** `useSession` and `useSessionMessages` change identity on each `session.updated` and flush; components that show one field read it through the leaf selectors in `sync/sync-context.tsx` (rule in `sync/DOCUMENTATION.md`).
- **LegendList state lags the DOM by a frame.** `getState()` sizes come from estimates until rows are measured and from the footer a beat later; read `scrollHeight` when choosing a scroll target, and list state only to skip work mid-glide. Our bun patch hands out a fresh list's containers in item order, so its DOM-order pass has nothing to move after a session opens (`message/parts/DOCUMENTATION.md`).
- **Count processes on server Git paths.** Look for a git spawn per item, the same read repeated within one operation, and network calls (`ls-remote`, `fetch`) where local refs answer. Batch into one read (`git remote -v`, not `get-url` per remote), keep a fallback when the batched read fails, prove the output matches the old method, and parse with `/\r?\n/`: Git for Windows may print CRLF, and spawns cost more there.

## Motion That Stays On Screen

An infinite CSS animation is paid for as long as it is on screen, and the bill
lands outside the page: the GPU process and the OS compositor draw every frame.
Main-thread busy time, style recalcs and `profile:idle`'s CPU budget all read
it as free. Measured with process CPU on four machines, one spinner or smooth
pulse took a still app from 2 to 9% of a core to 14 to 66%; in this
repository's fixture, headless or under Xvfb, it draws 60 frames a second and
costs 7 to 8% against 1% for a still page.

- **`steps()` still pays.** A stepped animation keeps the compositor ticking
  every frame, whatever it draws: CodeMirror's `steps(1)` caret draws 1.7
  frames a second and costs 4.1%, the same blink from a 600 ms timer 1.3%
  (`lib/codemirror/caretBlink.ts`).
- **Layer promotion changes nothing.** `will-change`, `translateZ(0)` and
  `contain` measured no different.
- **Cost follows changes per second.** Driven from a JS timer, each change
  is one drawn frame: measured headed on an M-series Mac, Chrome renderer plus
  GPU, one indicator: still page 0.3%, 1 change a second 1.0%, 2 1.7%, 4
  2.7%, 8 4.2%, a smooth spinner 8.6 to 9%, a smooth pulse 6.5%.
- **One clock for every indicator** (`hooks/useDurationTicker.ts`): spinners
  step four times a second, blinks, dots and counters once, on the same
  beats, so the page pays for the fastest indicator on screen, not the sum.
  The styling rules live in `theme-system`, "Animation Contract".
- **A tick re-renders its subscriber and everything under it.** Call the
  clock hook in the leaf that shows the change (the dot, the counter), make
  `active` true only while the readout moves, and keep it out of a page or a
  preview: a status age on Remote instances re-rendered that whole page every
  second while any instance was connected. Labels that change by the minute
  ("5m ago") use `useMinuteTickerNow`, which re-renders only when the minute
  turns.
- **Native images count too.** The macOS menu bar icon's breath called
  `setImage` 13 times a second: 6.9 to 7.3% of the Electron main process,
  against 2.6 to 3.1% at five a second (`tray.mjs`).
- **Hidden surfaces stop.** A closed panel, a background tab or an element
  under `opacity: 0` or `inert` neither animates nor polls. Gate on the
  surface's own visibility prop (`PauseClock` for clock-driven indicators):
  desktop windows run with `backgroundThrottling: false`, so
  `document.visibilityState` stays `visible` there, and macOS keeps drawing a
  minimized window at full cost.
- **Measure motion with frames and process CPU, headed, with an ablation.**
  `profile:animation` isolates one technique; `profile:idle` reports frames
  drawn per second and fails `--budget-frames` (its positive control is
  `scripts/perf/controls/pulse-dot.js`). Quote CPU only from headed runs.

## Repository Tooling

`scripts/perf/DOCUMENTATION.md` is the entry point: it covers every capture
command, how to stand up a production build to measure against, how to read the
artifacts, and the validity guarantees these scripts enforce. Read it before
measuring.

Prefer the unattended capture commands over ad-hoc timing code, and extend
them when a scenario is missing rather than measuring by hand. Their options
live in the documentation and `--help`.

| Command | Answers |
|---|---|
| `bun run profile:idle` | What the app does while nobody interacts with it, in a chosen mounted state: frames drawn and main-thread work, with baseline and budget gating (`--budget-frames`). |
| `bun run profile:session` | What a streaming reply costs on deterministic fixtures (prose, code, unicode, tool-heavy): long tasks against the frame budget, the finalize spike, a trace breakdown. |
| `bun run profile:switch` | How long a session switch takes until it is `visible`, cold and warm, the shift after reveal, and the bytes each switch fetches. The gate for sidebar, header, chat container and markdown first-paint changes. |
| `bun run profile:startup` | Time from launch to a usable composer, web or packaged desktop, with the requests and bytes until then. |
| `bun run profile:animation` | What a CSS animation or a timer costs in isolation: frames drawn, style and layout, process CPU. |
| `bun run profile:browser` | A manually driven capture when the interaction cannot be scripted. |
| `bun run profile:heap` | JS heap and DOM kept after hovering and opening N sessions. |
| `bun run profile:composer` | Elements restyled per new composer line. |
| `bun run profile:toggle` | What opening and closing the session sidebar and the context panel costs, per toggle: input to next frame, dropped and worst frames, style/layout, forced layouts with their JS stacks. |
| `bun run profile:compare` | The before/after verdict: builds both sides, runs the scenarios serially, prints median, p95, change and validity flags. |
| `bun run profile:serve` | An isolated server with the fixture provider for manual runs and ablations. |
| `bun run profile:analyze` | Attribution for one run: functions, source files, components, long tasks, large restyles, renders. |
| `bun run build:web:diag` | The unminified, source-mapped build with store notifications, for attribution only. |

The automated commands fail loudly rather than reporting a clean result when
the renderer was throttled, the trace collected no tasks, or the scenario never
rendered. Keep that property when extending them.

A before/after comparison runs the unchanged commit and the change from two
worktrees against the same seeded server state: the after worktree is HEAD
plus `git diff HEAD --binary` and the untracked files, verified identical to
the working tree, and each build's served chunk is checked against its own
`index.html`. Run one build, one server and one Chrome at a time.
`bun run profile:compare` does all of this; `--dry-run` shows the plan.

Measure a production build. A development build's render and bundle behaviour
does not represent what users run.

## Verification

Require both correctness and performance guards:

- representative-scale fixture from the report;
- cold and warm paths when caching exists;
- median plus p95/max, not one lucky run;
- deterministic operation-count assertion when possible;
- repeated-event test for streaming/polling paths;
- no-op and unrelated-entity update tests;
- reference-stability test for unaffected buckets;
- when custom comparators change, tests proving both directions: unrelated or semantically equivalent updates preserve the boundary, while changes to comparator-gated identity, membership, content, and source semantics invalidate it;
- when memoized tree/list consumers change, same-ID replacements and rebuilt-container fixtures covering both semantic change and semantic equivalence;
- when virtualization changes, tests using the real scrolling ancestor that prove final-item/control reachability and stable scroll, focus, and interactions; include activation-boundary cases when such a boundary exists;
- failure, partial-data, empty-success, and stale-async-completion tests;
- memory/cache growth check for long-running paths;
- production build or equivalent runtime profile for UI interactions.

State what was not measured. Never claim a freeze is fixed from type-check and unit tests alone.

## Revert What You Cannot Measure

A change that does not move its target metric is not a small win, a safety
improvement, or a cleanup. It is unvalidated complexity, and shipping it under
a performance rationale makes the next investigation harder by implying the
path was already optimised. Revert it and record the hypothesis as rejected.

This applies to a change whose benefit appears only in reasoning, one measured
against the wrong baseline, and one whose measured scenario turns out to behave
identically without it.

Report negative results explicitly. "Disabling this removed 40% of the
layerization, and the fix that preserved the visuals did not" is a finding, and
the next person needs it.

## Know When To Stop

Compare the remaining cost against the user-facing budget, not against zero.
When the interaction already sits far inside budget, further optimisation of
that path trades real regression risk for an invisible gain, and it displaces
work on the path the user actually reported. Say so and move on.

Cost that comes from intentional, user-visible behaviour is not waste. Removing
it is a product decision, not a performance fix, and it needs the owner's
agreement rather than a quiet commit.

## Hotfix Policy

Ship a bounded cache-only or local mitigation under deadline pressure only when:

- it measurably meets the user-facing budget at reported scale;
- invalidation and memory behavior are correct;
- semantics are unchanged or explicitly accepted;
- remaining complexity is documented as follow-up work.

If the interaction remains above budget, do not call the mitigation the completed performance fix.

## Exit Checklist

- [ ] Measurement validity established: no throttling, instruments confirmed firing, workload comparable.
- [ ] Baseline captured from the unchanged build through the identical scenario.
- [ ] Exact interaction and production scale reproduced.
- [ ] Cost equation written and dominant multipliers removed.
- [ ] Sources of truth, completeness, and invalidation explicit.
- [ ] No broad subscription or render-time global scan on a high-frequency path.
- [ ] Unaffected references remain stable.
- [ ] Partial failure cannot trigger destructive cleanup.
- [ ] Representative benchmark meets the stated budget.
- [ ] Operation-count or repeated-event regression test prevents recurrence.
- [ ] Structural optimizations have transition-focused correctness coverage independent of performance measurements.
- [ ] When mount topology or activation boundaries change, instrumentation distinguishes those transitions from steady state.
- [ ] Every change retained is justified by a measured difference; unvalidated ones reverted and recorded as rejected.
- [ ] Flows that relied on the old timing retested after any change to when something happens.
- [ ] Remaining cost compared against the budget, and stopping justified when inside it.
- [ ] Correctness, type, lint, and relevant runtime validations pass.
