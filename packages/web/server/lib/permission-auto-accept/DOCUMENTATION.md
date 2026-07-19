# Permission Auto-Accept

## Purpose

This module owns the authoritative permission auto-accept policy for web, desktop, and mobile runtimes. Policy is persisted in OpenChamber settings so permission handling survives UI disconnects and server restarts.

## Policy

`permissionAutoAccept.sessions` contains explicit per-session boolean policies.

Policy inheritance uses the nearest explicit session value. A child `false` therefore overrides a parent `true`; descendants without an explicit value inherit from their nearest configured ancestor.

## Runtime

`createPermissionAutoAcceptRuntime` loads and serializes policy writes, subscribes to the global OpenCode event hub, caches session lineage, retries transient replies, and reconciles pending permissions after startup, reconnect, and policy enablement. Enabling Auto-Accept for a session immediately accepts matching pending requests and keeps handling future requests without requiring a connected UI.

Unknown lineage and failed policy loads fail closed. A failed pending-permission fetch is distinct from an empty successful response and never clears policy state.

## Routes

- `GET /api/permission-auto-accept`
- `PUT /api/permission-auto-accept/sessions/:sessionId`

These are normal authenticated OpenChamber runtime routes. They must not be added to browser URL-token allowlists.

## UI ownership

`packages/ui/src/stores/permissionStore.ts` is a projection of server policy and does not persist an independent policy. The server is the sole responder and the UI renders pending requests until the authoritative `permission.replied` event arrives.

VS Code retains its foreground-only responder because it does not run the web server runtime. Its extension host persists and broadcasts the authoritative policy across webviews, while the active UI handles live events plus startup, reconnect, and enablement reconciliation. With all OpenChamber webviews closed or suspended, permissions are not auto-accepted; this is an intentional VS Code limitation.

## Tests

`runtime.test.js` covers restart persistence, nearest explicit subagent inheritance, missing-lineage lookup, retry/deduplication, and reconnect reconciliation.
