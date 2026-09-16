# Resolved Model Monitor

## Purpose

Shows which backing model a proxied provider actually served, per session.
Provider aliases can be stable while what they resolve to is not: a LiteLLM
gateway (or any LiteLLM-fronted proxy) usually exposes friendly codenames and
decides the real model behind them. The OpenCode config only knows the alias,
so this module reads the resolved model from the gateway's response headers and
publishes it for the composer to display. It never changes request behavior:
headers are read without touching the body, and every call succeeds or fails
exactly as if the plugin were absent.

## Runtime flow

1. `prepareManagedOpenCodeEnv()` materializes the plugin under
   `<openchamber-data-dir>/resolved-model/` and appends its `file://` URL to
   `OPENCODE_CONFIG_CONTENT` via `appendManagedPlugin`, so it composes with the
   other managed plugins (agent tool, system prompt optimizer) in any order.
2. A random per-child token and the loopback callback URL are added only to the
   managed OpenCode child environment.
3. The plugin's `chat.headers` hook tags every outgoing chat request with the
   OpenCode session id (`x-openchamber-session`).
4. The plugin wraps `globalThis.fetch` for the child process lifetime; for a
   tagged request with an `x-litellm-model-name` response header it reports
   `{ sessionID, model, modelGroup?, callId? }` to
   `POST /api/openchamber/resolved-model/report`. Detection is by header
   presence, not by hostname, so any LiteLLM-fronted proxy works.
5. The route stores one entry per session (server receive time as `updatedAt`,
   most-recently-updated first for the size bound) and broadcasts
   `openchamber:resolved-model` on the control SSE stream
   (`/api/openchamber/events`).
6. `GET /api/resolved-model` returns the authoritative snapshot for a client
   that joined after the events fired; the UI re-reads it on
   `openchamber:event-stream-ready` and applies live events in between.
7. `session.deleted` prunes that session's entry; a managed OpenCode restart
   clears every entry, because a restart reloads providers and old entries
   would lie.

## State contract

- One entry per session: `{ sessionId, model, modelGroup?, callId?, updatedAt }`.
- Absence means "nothing to report" — a direct (non-proxied) provider never
  emits the headers, so the UI correctly shows nothing rather than a stale or
  guessed value.
- The map is bounded (2000 sessions, least recently updated evicted) and never
  persisted.
- The snapshot route answers `503` when the runtime is absent (a wiring bug),
  never an empty success that would silently clear the UI.

## Security invariants

- The callback accepts loopback requests only and requires the current
  per-child bearer token using a timing-safe comparison.
- The token is never persisted, logged, returned to the UI, or written into the
  materialized plugin.
- Reports are validated to non-empty strings; there is no arbitrary URL or
  header forwarding.
- The plugin reports through the captured original `fetch`, so reporting can
  never re-enter the wrapper, and all reporting failures are swallowed —
  observability never fails the real request.

## Runtime parity

- Web and Desktop managed OpenCode: injected automatically.
- External OpenCode selected with `OPENCODE_HOST` or skip-start: not injected,
  because OpenChamber does not control that process environment.
- VS Code: not injected; the extension owns a separate OpenCode lifecycle. The
  shared UI opts out of the snapshot route there explicitly instead of falling
  through to the generic proxy.
- Hosted and Capacitor mobile clients consume the server's stream and snapshot.
- Providers without a LiteLLM-fronted proxy: the plugin loads but reports
  nothing, and the composer badge renders nothing.

## Testing

- Run `bunx vitest run server/lib/resolved-model` from `packages/web`.
- `runtime.test.js` covers env preparation, auth, validation, the session bound,
  pruning, and reset; `plugin.test.js` loads the materialized plugin exactly as
  the OpenCode child would and exercises the fetch wrapper end to end;
  `routes.test.js` covers the snapshot route.
