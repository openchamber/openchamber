# Configuration store

## Ownership

This module owns the composer's directory-scoped provider catalog, agent catalog,
model and effort selection, settings defaults, voice preferences, startup and
connection state. `../useConfigStore.ts` composes the slices and retains the
public import path. Session-specific picks belong to `sync/selection-store.ts`;
the OpenCode client owns transport and wire-to-domain conversion.

## Invariants

- Every slice receives the same Zustand `set` and `get`. Cross-slice actions
  read through `get()` so they see the current directory and selection.
- Runtime generations reject obsolete responses. Catalog epochs reject reads
  retired by an explicit reload; agent generations also reject invalidated
  per-directory reads.
- Directory snapshots and active fields update together. Persisted catalogs
  provide startup continuity; successful live loads establish catalog readiness.
- Manual model, agent and effort choices retain their existing precedence over
  resolved defaults. A failed load preserves the previous catalog.
- Persistence keeps the existing `config-store` key, version, runtime check and
  selection-only snapshots. Catalog persistence stays in `../configCatalogCache.ts`.

## Decisions

### Why subscriptions are installed by the composer

The composer installs the runtime listener before creating the store, then installs hydration and
configuration listeners after creation, preserving the singleton's setup order.

### Why request state stays with its owner

Defaults, model metadata and initialization retain their own in-flight requests.
Runtime reset calls their reset operations; catalog maps and counters share a
catalog lifecycle owner so all slices observe the same invalidation state.
