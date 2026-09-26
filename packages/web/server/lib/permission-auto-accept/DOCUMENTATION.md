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

`permissionDefaultMode` (Settings → Sessions) is written onto each new top-level session when `session.created` arrives, and only when no policy exists for it yet: a mode the creating flow already set wins, and changing the default never reaches back into older sessions. Subagents inherit instead. `ask` writes nothing. Mode resolution waits for pending writes, so a session's first permission request sees its default.

## Runtime

`createPermissionAutoAcceptRuntime` loads and serializes policy writes, subscribes to the global OpenCode event hub, caches session lineage, retries transient replies, and reconciles pending permissions after startup, reconnect, and when a session moves to `safety` or `auto`. It keeps handling requests without a connected UI.

Unknown lineage and failed policy loads fail closed (`ask`). A failed pending-permission fetch is distinct from an empty successful response and never clears policy state.

## Safety net

`evaluatePermission` (the routing runtime) is consulted in `safety` sessions only, before the reply. Only `accept` replies; anything else counts the request as handled without replying, so it stays on screen. A `permission.replied` event is passed to `onPermissionReplied` so the routing runtime forgets its cached decision.

Each request's outcome (`replied`, `held`, `ignored`, `failed`) is kept for a bounded while. `isPermissionAutoAnswered` lets notifications skip only a request that was actually answered: a held one still notifies.

## Routes

- `GET /api/permission-auto-accept` answers `{ sessions, modes, revision }`. `modes` is the policy; `sessions` is its on/off view (`ask` is off) for clients from before the modes.
- `PUT /api/permission-auto-accept/sessions/:sessionId` takes `{ mode, directory }`; a body with only `enabled` (older clients, VS Code's bridge shape) means `auto` or `ask`.

These are normal authenticated OpenChamber runtime routes. They must not be added to browser URL-token allowlists.

## UI ownership

`packages/ui/src/stores/permissionStore.ts` is a projection of server policy and does not persist an independent policy. The server is the sole responder and the UI renders pending requests until the authoritative `permission.replied` event arrives. The composer's shield button cycles ask → safety → auto, skipping `safety` while no classification provider can run it (a `safety` session then shows as `ask`).

VS Code retains its foreground-only responder because it does not run the web server runtime. Its extension host persists and broadcasts an on/off policy across webviews, so VS Code has only `ask` and `auto` and no default mode. The active UI handles live events plus startup, reconnect, and enablement reconciliation. With all OpenChamber webviews closed or suspended, permissions are not auto-accepted; this is an intentional VS Code limitation.

## Tests

`runtime.test.js` covers restart persistence, on/off requests, the one-time conversion of pre-modes policies, the default mode on new sessions, nearest explicit subagent inheritance, missing-lineage lookup, retry/deduplication, reconnect reconciliation, the safety net's hold and accept, and which outcomes notifications may skip.
