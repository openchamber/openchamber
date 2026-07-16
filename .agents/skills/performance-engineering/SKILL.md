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

### 1. Reproduce And Measure

- Reproduce the exact interaction, not a nearby helper in isolation.
- Separate scripting, rendering, painting, network, disk, and waiting time.
- Use a profiler to identify total time and self time.
- Add operation counters when timings are noisy: selector calls, normalizations, scans, allocations, sorts, notifications.
- Capture a baseline before changing code.

Do not infer a bottleneck from code appearance when a trace or counter can identify it.

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
- Do not sort structural lists from token/delta-frequency fields.
- Coalesce repeated same-entity events and skip no-op reducer updates.
- Ensure hidden or disabled surfaces perform no ongoing work.
- Preserve scroll position synchronously with `useLayoutEffect`; do not wait visible frames before compensation.
- Distinguish viewport resize from content growth and avoid fighting browser scroll anchoring.
- Avoid textarea auto-size shrink/expand cycles when content only grows.
- Freeze structural ordering during high-frequency updates and reorder at an explicit lifecycle edge.

## Caching Rules

Add a cache only when all are explicit:

- exact key and source identity;
- invalidation events;
- stale-result behavior;
- memory count and byte bounds where values can grow;
- runtime/project/user isolation where identities can collide;
- proof that caching removes enough work to meet the budget.

A cache inside an `O(consumers × entities × candidates)` loop is a mitigation, not automatically a complete fix.

## Verification

Require both correctness and performance guards:

- representative-scale fixture from the report;
- cold and warm paths when caching exists;
- median plus p95/max, not one lucky run;
- deterministic operation-count assertion when possible;
- repeated-event test for streaming/polling paths;
- no-op and unrelated-entity update tests;
- reference-stability test for unaffected buckets;
- failure, partial-data, empty-success, and stale-async-completion tests;
- memory/cache growth check for long-running paths;
- production build or equivalent runtime profile for UI interactions.

State what was not measured. Never claim a freeze is fixed from type-check and unit tests alone.

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

## Exit Checklist

- [ ] Exact interaction and production scale reproduced.
- [ ] Cost equation written and dominant multipliers removed.
- [ ] Sources of truth, completeness, and invalidation explicit.
- [ ] No broad subscription or render-time global scan on a high-frequency path.
- [ ] Unaffected references remain stable.
- [ ] Partial failure cannot trigger destructive cleanup.
- [ ] Representative benchmark meets the stated budget.
- [ ] Operation-count or repeated-event regression test prevents recurrence.
- [ ] Correctness, type, lint, and relevant runtime validations pass.
