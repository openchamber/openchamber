# Bot attention adapter

## Ownership

`createBotAttention({ center, notify })` from `bots/attention.js` implements
`attention.sync({ projectId, item, critical? })` for the coordinator. Construct
`center` using `createNotificationCenterRuntime` and the data-directory
`createNotificationCenterPersistence`, then pass this adapter as `attention`
to `createBotsRuntime`. Main owns these imports and construction in `server/index.js`.

`notify(payload)` is a required host-owned alert operation. It applies existing
settings, focus, enterprise redaction and push delivery. The adapter sends only
`kind`, `priority`, `requestId`, `action`, `title`, `body`, `sessionId`, `directory`
and `critical`. It never receives credentials or performs network requests.
`requestId` is the item ID; `action` is `{ type: 'bots', projectId, itemId }`.
The UI opens that item without requiring a session. Directory is the recorded
worktree, when available. Fixing, investigation and judge are the session fallback
order. Web, Electron, hosted mobile and Capacitor share this contract. VS Code
has no Bots runtime.

## Invariants

- Only validated explicit items can resolve a request. Missing items, failed
  store reads and incomplete project snapshots supply no resolution authority.
- Needs-you and waiting-answer persist high pending records. Other states resolve
  by project and item even when no session was created.
- An identical sync emits no event or alert. Changed needs-you requests alert;
  questions remain center attention only. Explicit critical calls request an
  alert regardless of state. A push failure leaves the durable request valid.
  Alerts are best effort and have no historical replay guarantee.
- The center owns persistence and item-level serialization. Failed writes reject
  the sync; failed durable mutations restore prior pending data for safe retry.
- UI stores must preserve unresolved bot entries on clear. Existing `removed`
  and `added` events replace changed entries with their original center ID.

## Decisions

### Why delivery is injected

The notification runtime owns transport, redaction and user settings. An explicit
host operation keeps bot state decisions independent of network and credentials.

## Validation

`attention.test.js` runs the disk-backed `attention-driver.mjs` and failure tests.
`node packages/web/server/lib/bots/attention-driver.mjs` independently exercises
upsert, no-op, change, push policy, retention, clear, restart and sessionless
resolution. Live push and UI navigation require host composition QA.
