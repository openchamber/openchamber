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

## Red Flags

- Fetch helper catches and returns `[]`.
- Historical message/session data drives a live spinner.
- One failed entity blocks or clears all entities.
- Light polling overwrites fields it did not fetch.
- Queue reads current model/agent at send time.
- New session lookup assumes SSE already indexed it.
- Optimistic data has no shadow entry or rollback.
