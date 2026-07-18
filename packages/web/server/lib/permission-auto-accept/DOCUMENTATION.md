# Permission Auto-Accept

## Purpose

This module owns the authoritative permission auto-accept policy for web, desktop, and mobile runtimes. Policy is persisted in OpenChamber settings so permission handling survives UI disconnects and server restarts.

## Policy

`permissionAutoAccept.default` is an optional server-wide boolean default. Missing or malformed values fail closed to `false`.

`permissionAutoAccept.sessions` contains explicit per-session boolean policies.

Policy inheritance resolves in this order:

1. explicit current session value
2. nearest explicit ancestor value
3. global `permissionAutoAccept.default`
4. `false`

A child `false` therefore overrides both a parent `true` and a global `true`. Unknown lineage, invalid lineage payloads, and failed lineage fetches still fail closed. A session detail response must decode into a valid session object whose `id` matches the requested lineage node before the runtime can fall through to the global default.

## Runtime

`createPermissionAutoAcceptRuntime` loads and serializes policy writes, subscribes to the global OpenCode event hub, caches session lineage, retries transient replies, and reconciles pending permissions after startup, reconnect, and policy enablement. Enabling Auto-Accept for either a session or the global default immediately accepts matching pending requests and keeps handling future requests without requiring a connected UI. Global-default enablement reserves invocation-order serialization before it performs authoritative active-root-session discovery through the paginated `experimental.session.list` endpoint, so a later disable cannot be overwritten by an older slow enable. Disabling either policy persists and broadcasts the new snapshot but does not reply to pending requests.

Unknown lineage and failed policy loads fail closed. A failed pending-permission fetch is distinct from an empty successful response and never clears policy state. If global-default enable preflight fails before persistence, the runtime rejects that enable attempt, does not persist or broadcast anything from it, and still allows later queued mutations such as a disable to proceed.

## Routes

- `GET /api/permission-auto-accept`
- `PUT /api/permission-auto-accept/default`
- `PUT /api/permission-auto-accept/sessions/:sessionId`

These are normal authenticated OpenChamber runtime routes. They must not be added to browser URL-token allowlists.

## UI ownership

`packages/ui/src/stores/permissionStore.ts` is a projection of server policy and does not persist an independent authoritative policy. The server is the sole responder and the UI renders pending requests until the authoritative `permission.replied` event arrives. The shared UI deliberately does not persist a client-side global `default: true`; runtime switches and hydration must always re-read the authoritative server snapshot.

VS Code retains its foreground-only responder because it does not run the web server runtime. Its extension host persists and broadcasts the authoritative snapshot (`default` plus `sessions`) across webviews, scoped to the current workspace/runtime identity, while the active UI handles live events plus startup, reconnect, and enablement reconciliation. Global-default reconciliation uses authoritative live directories (current directory, initialized sync directories, and workspace folders). With all OpenChamber webviews closed or suspended, permissions are not auto-accepted; this foreground-webview-only limitation is intentional and must stay documented.

## Tests

`runtime.test.js` covers restart persistence, malformed-default fail-closed handling, nearest explicit subagent inheritance, global-default fallback, explicit false/true overrides, missing-lineage lookup, retry/deduplication, reconnect reconciliation, and pending-permission reconciliation for both session and global enablement.
