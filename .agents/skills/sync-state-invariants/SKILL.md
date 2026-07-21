---
name: sync-state-invariants
description: Use when changing session synchronization, bootstrap or reconnect state, event reducers, polling, optimistic updates, message queues, live activity, ordering/reconciliation, runtime-scoped caches, or directory-dependent session behavior.
---

# Sync State Invariants

## Read First

Read `packages/ui/src/sync/DOCUMENTATION.md` and the nearest owning module documentation before editing.

## Sources Of Truth

Classify every input before deriving state:

| Input | Valid use |
|---|---|
| Directory child store | Live per-directory session/message/status/permission state |
| Global sessions store | Complete global active/archived cache and retention/sidebar coverage |
| Persisted history/cache | Startup continuity and context restoration, never proof of current activity |
| Optimistic shadow state | Temporary UI continuity until authoritative reconciliation |

Prefer deterministic authoritative records over heuristics. Derive live behavior from live channels, not historical anomalies.

## Failure Is Not Empty

Any authoritative loader whose result can replace, delete, or clear state must distinguish failure from successful empty data.

Use an existing pattern:

- Throw when an outer logical block can catch and preserve prior state.
- Return `T | null` when follow-up work must continue and `null` exclusively means fetch failure.

Never swallow an SDK/API error into `[]`, `{}`, or another valid empty success. Verify that callers skip destructive replacement after failure.

Track completeness at the smallest entity/scope. One failed project or directory blocks destructive work for itself, not for unrelated complete scopes.

Inferring destructive cleanup from disappearance between snapshots requires an established authoritative baseline. This is separate from applying a complete snapshot whose contract explicitly authorizes first-load replacement.

- Never infer a disappearance event from the first snapshot, startup-empty state, filtered/visible subsets, or partially loaded scopes.
- Compare two complete authoritative snapshots from the same runtime and logical scope before treating disappearance as removal.
- Key disappearance by stable entity identity. Owner, directory, grouping, category, or presentation moves are not deletion unless the authoritative contract says so.
- Reset the baseline when runtime identity or authoritative scope changes.
- Prefer explicit deletion events; snapshot-difference cleanup is a fallback that requires completeness guarantees.

## Live And Historical State

- Use historical state to restore context, not to infer ongoing execution.
- Scope delayed-live fallbacks to the active entity and clear them when authoritative state arrives.
- Do not let stale persisted data keep a fallback active indefinitely.
- Define field precedence when global and local/live snapshots feed the same view.
- Use one ordering/rank source for all views of the same entities.

## Event Reducers

- Clone only fields the event mutates; preserve every unrelated reference.
- Return no change for semantically identical events.
- Gate scans behind cheap event/entity checks.
- Coalesce repeated same-entity events without violating ordering.
- Reject stale async/event completions using generation or authoritative timestamps.
- Do not widen a narrow fallback to arbitrary historical records.

For streaming-frequency work, also load `performance-engineering`.

## Polling And Bootstrap

- Preserve rich fields when lightweight polling omits them.
- Use cheap change detection before heavy per-directory fetches.
- Treat startup 502/503 as transient with bounded retry/recovery.
- A retry loop requires a real failure signal; swallowed errors disable retries.
- Preserve previous authoritative state during transient bootstrap/reconnect failures.
- Distinguish stale-scope rejection from same-scope mutation reconciliation. A generation token rejects obsolete owners but does not protect mutations made while a still-valid request is in flight.
- Capture a mutation revision when an authoritative load starts. At commit time, read current state and preserve or overlay entity mutations newer than that revision.
- Record removals as mutations even when the entity is already absent, so an in-flight response cannot resurrect it.
- Return committed reconciled state, not the raw fetched snapshot, when callers depend on the result.

## Optimistic Updates

- Insert optimistic data into the visible store and a separate shadow tracker.
- Use client-generated IDs accepted and echoed by the server to reconcile in place.
- Remove optimistic data from both visible and shadow state on failure.
- Reconcile deterministically on authoritative fetch/event; do not guess from unrelated events.
- Stabilize callbacks stored in module-level refs to avoid effect loops.

## Session And Queue Consistency

- Capture provider, model, agent, variant, and other send configuration when queueing.
- Do not re-resolve queued configuration from mutable current state at send time.
- Preserve server-backed attachments and convert paths at the transport boundary.
- Pass a directory hint when a newly created session is not indexed yet.
- Read mutable current directory at call time; never cache it in a long-lived closure.

## Cache And Lifecycle

- Match session-store limits to loaded data before events can trigger trimming.
- Invalidate message/prefetch/file caches on mutation and session eviction.
- Key runtime-scoped caches by runtime identity when IDs or paths can collide.
- Clean optimistic and local cache state after partial failures.

## Persisted Snapshot Ordering

When state exists in memory and one or more persistent stores, define an explicit authority and ordering protocol:

- Distinguish a missing snapshot from authoritative empty data, malformed data, and read failure.
- Preserve mutation order independently per owner by serializing writes or attaching monotonic revisions and rejecting stale writes. Do not rely on uncontrolled wall-clock timestamps.
- Capture runtime/owner identity with every debounced or asynchronous operation and verify it again before commit.
- Pending writes must complete against their captured owner, drain before an owner switch, or be canceled only under an explicit durability/data-loss contract. Apply the strongest available guarantee at page hide/freeze and shutdown boundaries.
- During hydration, capture the local mutation revision and do not replace state after newer local mutations.
- Validate persisted payload shape before granting authority. Malformed data is failure, not empty success.
- Define retention explicitly; never silently evict older owner namespaces unless bounded retention and resulting data loss are intentional contracts.

## Verification

Cover the relevant lifecycle, not only static state:

- fresh bootstrap and successful empty result;
- fetch failure preserving prior state;
- reconnect/retry and stale completion;
- repeated/no-op/out-of-order events;
- optimistic success, reconciliation, and rollback;
- create, stream, abort, permission, archive/delete, and revisit when session behavior changes;
- partial multi-directory/project failure;
- runtime or worktree switch with dynamic directory resolution.
- snapshot-difference cleanup establishing its first authoritative baseline without deletion, then cleaning a later authoritative disappearance exactly once;
- identity-preserving moves/category changes and runtime/scope changes resetting cleanup baselines;
- create, update, move, archive, and delete mutations surviving responses started before those mutations;
- missing versus empty persistence, malformed payloads, out-of-order writes, hydration races, and lifecycle durability behavior.

## Red Flags

- Fetch helper catches and returns `[]`.
- Historical message/session data drives a live spinner.
- One failed entity blocks or clears all entities.
- Light polling overwrites fields it did not fetch.
- Queue reads current model/agent at send time.
- New session lookup assumes SSE already indexed it.
- Optimistic data has no shadow entry or rollback.
- Snapshot-difference cleanup treats its first startup snapshot as a disappearance event.
- Missing or malformed persistence becomes authoritative empty state.
- Debounced writes are canceled on owner/lifecycle change without completing against the captured owner or an explicit durability/data-loss contract.
