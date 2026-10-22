# Permission Auto-Accept

## Purpose

This module owns the authoritative per-session permission policy for web, desktop, and mobile runtimes. Policy is persisted in OpenChamber settings so permission handling survives UI disconnects and server restarts.

## Policy

Each session has a mode (`modes.js`):

- `ask`: every request waits for the user.
- `safety`: a request is accepted when the safety net (Jev, `../routing/DOCUMENTATION.md`) says the user need not decide; otherwise it waits. Without a usable classification provider, or when Jev fails, it waits.
- `auto`: every request is accepted.

`permissionAutoAccept.sessions` maps session ids to modes. Inheritance uses the nearest explicit session value, so a child `ask` overrides a parent `auto`; descendants without an explicit value inherit from their nearest configured ancestor.

Policies written before the modes stored booleans. The first read converts them and persists the result once: `false` becomes `ask`, `true` becomes `safety` when the old global safety-net switch in the routing config was on and `auto` otherwise (`resolveLegacyEnabledMode`). The settings sanitizer accepts both shapes so the converting write and older files pass.

## Default mode

`permissionDefaultMode` (Settings → Sessions) is written onto each new top-level session when `session.created` arrives, and only when no policy exists for it yet: a mode the creating flow already set wins, and changing the default never reaches back into older sessions. Subagents inherit instead. `ask` writes nothing. Mode resolution waits for pending writes, so a session's first permission request sees its default. The server inside an isolated space has no such setting; it reads the default from a file the host keeps current instead (`readDefaultMode`), see "Default permission mode" in `../spaces/DOCUMENTATION.md`. The UI also writes the default for a session it creates in a space from a draft or for a `/btw` fork, which covers a space still running an older server; a mode chosen there wins as on the host.

## Fork inheritance

On `session.forked`, the runtime copies the source session's effective mode into the fork's own policy, including an implicit `ask`. The Settings default applies to ordinary new sessions. A fork keeps its copied mode when the source changes, and an explicit policy already set on the fork wins. Duplicate events do not replace that policy. Permission resolution waits for pending inheritance, including when the source is itself a new fork.

Source lookup or persistence failure leaves the fork unconfigured and logs the failure; unknown policy remains `ask`. Failed writes preserve the previous policy and do not block later writes. Existing forks are not backfilled.

### Why fork permissions are copied rather than linked

The fork event's `parentID` identifies the source transcript, not subagent lineage. Copying the effective mode gives the fork an independent policy and covers forks made by any connected client without relying on a `session.created` event, which OpenCode does not emit for forks.

## Runtime

`createPermissionAutoAcceptRuntime` loads and serializes policy writes, subscribes to the global OpenCode event hub, caches session lineage, retries transient replies, and reconciles pending permissions after startup, reconnect, and when a session moves to `safety` or `auto`. It keeps handling requests without a connected UI. Startup and reconnect ask the pending list of each running session's directory (`/api/session/active`, then each session's record), never a list without a directory: OpenCode 2 answers that one for its own working directory only and starts that location, MCP servers included.

Lineage comes from session events and, when unknown, from the session record in OpenCode. Only `session.created` or a fetched record proves a session has no parent: a `session.updated` is partial (title, usage) and leaves the parent unknown, so the next lookup fetches the record. After a restart, a running subagent's first event is such an update. A failed lookup is retried like a failed reply and then leaves the request for the user.

Unknown lineage and failed policy loads fail closed (`ask`). A failed pending-permission fetch is distinct from an empty successful response and never clears policy state.

## Safety net

`evaluatePermission` (the routing runtime) is consulted in `safety` sessions only, before the reply. Only `accept` replies; anything else counts the request as handled without replying, so it stays on screen. A `permission.replied` event is passed to `onPermissionReplied` so the routing runtime forgets its cached decision.

Each request's outcome (`replied`, `held`, `ignored`, `failed`) is kept for a bounded while. `isPermissionAutoAnswered` lets notifications skip only a request that was actually answered: a held one still notifies. When its own lineage lookup fails, it waits for the request's outcome, so a reply that succeeds on retry sends no push.

A `held` or `failed` outcome is broadcast as `openchamber:permission-auto-accept.left-for-user` (`permissionId`, `sessionId`, `directory`). Clients keep a `safety` or `auto` session's request out of sight until this arrives or the request is answered, so an accepted request never flashes a card; the broadcast is what puts a held one on screen. Reconnect reconciliation broadcasts again for a request still held, which a client that already shows it ignores.

Both broadcasts (`updated` and `left-for-user`) go to the main WebSocket, the legacy notification stream (an isolated space's host reads it) and the control stream (`broadcastPermissionUiEvent` in `server/index.js`). A window whose main event stream runs over SSE, by setting or after a WebSocket fallback, reads only the control stream; without it, such a window hid a held request for good and kept a mode another window had changed.

## Routes

- `GET /api/permission-auto-accept` answers `{ sessions, modes, revision }`. `modes` is the policy; `sessions` is its on/off view (`ask` is off) for clients from before the modes.
- `PUT /api/permission-auto-accept/sessions/:sessionId` takes `{ mode, directory }`; a body with only `enabled` (older clients, VS Code's bridge shape) means `auto` or `ask`.

These are normal authenticated OpenChamber runtime routes. They must not be added to browser URL-token allowlists.

## UI ownership

`packages/ui/src/stores/permissionStore.ts` is a projection of server policy and does not persist an independent policy. A session in an isolated space has its mode in this module inside that space, which sees the space's OpenCode and answers there; the host's runtime sees the host's events only and never answers into a space. The host forwards the space's `updated` and `left-for-user` events to the browsers, see "Sessions and events" in `packages/web/server/lib/spaces/DOCUMENTATION.md`. The server is the sole responder and the UI renders pending requests until the authoritative `permission.replied` event arrives. The composer's shield button cycles ask → safety → auto, skipping `safety` while no classification provider can run it (a `safety` session then shows as `ask`).

VS Code retains its foreground-only responder because it does not run the web server runtime. Its extension host persists and broadcasts an on/off policy across webviews, so VS Code has only `ask` and `auto` and no default mode. The active UI handles live events plus startup, reconnect, and enablement reconciliation. With all OpenChamber webviews closed or suspended, permissions are not auto-accepted; this is an intentional VS Code limitation.

For forks initiated in the VS Code UI, the shared fork action refreshes the extension host's policy and saves the source mode onto the fork through the existing permission bridge. A fork policy already present is preserved. A failed read or write rejects the action while retaining the created fork; runtime changes stop subsequent inheritance work.

## Tests

`runtime.test.js` covers restart persistence, on/off requests, the one-time conversion of pre-modes policies, the default mode on new sessions, nearest explicit subagent inheritance, missing-lineage lookup (including a subagent first seen through a partial update, and a failed lookup), retry/deduplication, reconnect reconciliation, the safety net's hold and accept, and which outcomes notifications may skip.
