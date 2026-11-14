# Git status transport

## Ownership

`batch.ts` coalesces HTTP Git status reads from the shared adapter. Stores keep
their own freshness and mutation revisions; the transport settles each directory
as its answer arrives. Web, Electron, hosted mobile and Capacitor use this path
through `runtimeFetch`, including relay. VS Code uses its existing native Git bridge.

## Invariants

- Reads admitted in the same event-loop turn share a request only within one runtime, isolated
  space routing context and status mode. Batches contain at most 200 reads.
- At most two status requests are active per client. A single read uses the GET route;
  multiple reads use POST `/api/git/status/batch` with an NDJSON response.
- Each successful line resolves its directory immediately. A per-directory
  failure rejects only that directory. A truncated or malformed stream rejects
  remaining reads and preserves completed results.
- Runtime changes abort the stream and reject queued reads. Cache publication
  remains fenced by the adapter's existing mutation revisions.
- Callers may already hold a background network slot. The transport never
  reacquires that slot; its own connection limit leaves capacity for search.

## Decisions

### Why batch status reads at the HTTP adapter

The command palette and background loaders all use this adapter. Coalescing here
prevents each new loader from creating another unbounded connection burst, while
keeping single-directory store and native bridge contracts intact.

### Why stream each directory

A large repository can take seconds. Waiting for the whole batch would delay
fast directories and prevent their caches and rows from updating independently.
NDJSON crosses the existing authenticated HTTP and relay paths without adding a
persistent connection or reconnect protocol.
