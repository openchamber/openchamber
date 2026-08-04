---
name: performance-engineering
description: Use when implementing or reviewing code on interaction, render, event, polling, synchronization, list-processing, store-selector, cache, indexing, or high-volume data paths; when users report lag, freezes, jank, high CPU, memory growth, slow startup, or performance regressions; and before accepting memoization or caching as a fix for repeated work.
---

# Performance Engineering

## Overview

Optimize the amount and frequency of work before optimizing individual operations.

**Core principle:** Make expensive work structurally unnecessary. A fast inner function still freezes the app when called millions of times on the main thread.

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
alongside the application's own render counters.

**Prove the workload is comparable.** When the stimulus varies in size between
runs, per-second and total figures are not comparable. Normalise by units of
work delivered, and check run-to-run spread on an unchanged build before
attributing any difference to a change.

Do not report a number whose validity you have not established. State which
validity checks ran.

### 1. Reproduce And Measure

- Reproduce the exact interaction, not a nearby helper in isolation.
- Separate scripting, rendering, painting, network, disk, and waiting time.
- Use a profiler to identify total time and self time.
- Add operation counters when timings are noisy: selector calls, normalizations, scans, allocations, sorts, notifications.
- Capture a baseline before changing code.

Do not infer a bottleneck from code appearance when a trace or counter can identify it.

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

When activation is threshold-based, test threshold minus one, threshold, and threshold plus one. Also test applicable collapsed/expanded, hidden/visible, filtered/unfiltered, and short/long transitions. If the current DOM or scroll topology cannot expose the virtual tail reliably, correct that topology or retain normal rendering rather than virtualizing solely by item count.

## Caching Rules

Add a cache only when all are explicit:

- exact key and source identity;
- invalidation events;
- stale-result behavior;
- memory count and byte bounds where values can grow;
- runtime/project/user isolation where identities can collide;
- proof that caching removes enough work to meet the budget.

A cache inside an `O(consumers × entities × candidates)` loop is a mitigation, not automatically a complete fix.

## Repository Tooling

`scripts/perf/DOCUMENTATION.md` is the entry point: it covers every capture
command, how to stand up a production build to measure against, how to read the
artifacts, and the validity guarantees these scripts enforce. Read it before
measuring.

Four unattended capture commands exist; prefer them over ad-hoc timing code,
and extend them when a scenario is missing rather than measuring by hand.

| Command | Answers |
|---|---|
| `bun run profile:idle` | What the app does while nobody interacts with it. Supports `--session`, `--tab`, `--then-tab`, `--panel`, `--expand-projects` to reach a specific mounted state, plus `--baseline` and `--budget-*` for regression gating. |
| `bun run profile:session` | What a streaming assistant response costs. Creates a session, dispatches a prompt through the `openchamber session` CLI, and records until the session reports idle. Reports the long-task distribution, a timeline-trace breakdown, running animations, and output-normalised metrics. |
| `bun run profile:animation` | What a CSS animation costs, isolated from the app. Animate only `transform` and `opacity`; everything else recalculates style every frame. |
| `bun run profile:browser` | A manually driven capture when the interaction cannot be scripted. |

Both automated commands fail loudly rather than reporting a clean result when
the renderer was throttled, the trace collected no tasks, or the scenario never
rendered. Keep that property when extending them.

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

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The helper is cheap" | Multiply it by events, entities, candidates, and consumers. |
| "No component rerendered" | Selectors and equality comparisons may still burn CPU. |
| "`useMemo` fixes it" | Memoization does not help when dependencies churn or consumers duplicate work. |
| "The cache made it 10× faster" | Compare the result with the interaction budget, not only the baseline. |
| "Projects are few" | Identify the dimension that is large and the dimensions multiplying it. |
| "Move it to a worker" | Moving waste changes responsiveness, not total cost or data correctness. |
| "Empty means nothing exists" | Empty after failure or partial loading is not authoritative absence. |
| "We can optimize later" | Add a scale regression now or the multiplier will return. |
| "The profile is clean" | Prove the instrument fired and the renderer was not throttled. A disabled instrument looks identical to a fast app. |
| "It is much faster now" | Against which baseline, on which build, in which scenario? Re-run the unchanged build. |
| "Most of the time is `(program)`" | The sampler cannot see native work. Read the timeline trace. |
| "It does not reproduce here" | Compare your scale to the reporter's on the dimension the code keys on. |
| "It cannot hurt to keep the change" | An unmeasured change is unvalidated complexity that hides the path from the next investigation. |

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
- [ ] Remaining cost compared against the budget, and stopping justified when inside it.
- [ ] Correctness, type, lint, and relevant runtime validations pass.
