# Bot notice delivery

## Ownership

`createBotNotices({ store, config, readSession, queueFor })` in `notices.js`
adapts bot answers and provider feedback to the existing message queue. It exposes
`deliver({ projectId, item, eventId, text })` and `assertDispatch(input)`.
The coordinator owns recording feedback and its receipt. The queue owns durable
admission, idle delivery, retries and the synthetic message. No public bot-origin
enqueue route exists.

Constructor dependencies:

- `store.read(projectId)` and `config.read(projectId)` are the existing bot
  owners. Every admission and dispatch reads them again. A caller's `item`
  contributes only its ID.
- `readSession({ projectId, item, bot, stage, sessionId })` reads the actual
  recorded session from its runtime and returns `{ id, directory, isolated, archived?,
  metadata }`. `metadata.openchamber.automation` must retain `{ source: 'bot',
  projectId, botId, itemId, stage }`. The callback normalizes OpenCode's wire
  location and archival fields. For isolation it must validate the existing
  persisted space binding and refuse an unavailable or mismatched space before
  reading inside it. It must never query the host as a fallback. `isolated` comes
  from the item's captured placement, independently of current bot settings.
- `queueFor({ projectId, itemId, sessionId, directory, isolated, stage })` returns
  the queue runtime for that exact target, with `enqueue` supporting server
  origins. A missing queue throws. An isolated target requires a dedicated
  server-owned queue and transport. Public HTTP enqueue refuses bot origins even
  inside a space.

Host wiring passes the deferred guard to `createMessageQueueRuntime`:

```js
assertBotDispatch: (input) => notices.assertDispatch(input)
```

The queue calls it with `{ sessionId, directory, origin, notice, isolated }`.
Host queues keep `botDispatchIsolated: false`, the default. Only a dedicated
queue whose transport, events and persistence belong to the recorded space sets
`botDispatchIsolated: true`. Construct the queue and adapter before starting
delivery. A missing guard refuses admission and keeps restored items queued.

## Invariants

- Correction is the feedback target once its persisted session exists. Before
  correction, a judging item uses its judge session; otherwise investigation
  precedes judge. Missing current sessions fail with `BOT_NOTICE_SESSION_MISSING`.
- Session ID, directory, metadata identity and isolation must match the current
  persisted item and enabled bot. Host directories match the item worktree.
  Isolated directories must name `/spaces/<12-hex-id>/...` and are checked by
  the required runtime resolver. A host queue cannot dispatch an isolated target.
- Provenance is `origin: { kind: 'bot', id: item.id }`. Metadata is exactly
  `{ source: 'openchamber-notice', kind: 'bot', projectId, itemId, eventId }`.
  The full provider-neutral text travels beside metadata.
- Queue and message IDs derive from SHA-256 of the JSON tuple of project, item
  and event. Admission returns only after the queue file write succeeds. A
  repeated pending event keeps its queue ID and cannot change target or text.
  Later re-admission reuses the same `msg_` ID, so an OpenCode 409 after a lost
  response or lost coordinator receipt settles the original event once.
- A failed admission write throws and leaves the in-memory entry available for
  a same-ID persistence retry. Dispatch also requires successful persistence.
  The queue file's atomic rename supports process restart; power-loss durability
  is not claimed.
- Delivery rechecks authority after knowledge work, sends only `/synthetic`
  with `delivery: 'steer'` and `resume: true`, and never switches model or agent.
  The guard returns `{ includeMemorySaveRule: stage === 'fixing' }`; queue sync
  preserves this policy for investigation and judge.
- Bot items refuse take/edit and bulk manual send. Ordinary traffic cannot
  evict an admitted bot item at queue capacity. Explicit removal remains allowed.
  Public HTTP rejects `origin` and `notice`; bot delivery grants no tool or
  provider permission.
- Web and Electron deliver on their server. Hosted mobile and Capacitor render
  the same notices and open their own item detail. VS Code has parser/render
  support without a bot backend or item-navigation action.

## Decisions

### Why deterministic IDs cover both admission and inference

The coordinator can stop after either queue admission or synthetic acceptance
and before saving its receipt. Pending queue IDs suppress repeated admission;
the same inference message ID suppresses repeats after the queue entry is gone.

### Why authority is resolved again at dispatch

A pending notice can outlive a session replacement, directory move, bot disable
or isolation change. The dispatch guard refuses the old target before writing
anything to OpenCode, including after asynchronous knowledge synchronization.

## Validation boundary

`notices.test.js` and `node packages/web/server/lib/bots/notices-driver.mjs`
exercise real item/queue persistence and controlled loopback HTTP admission,
including lost responses and receipt retries. UI parser, queue projection,
composer exclusion and timeline tests cover the presentation contract.
Live OpenCode inference, Docker isolation and browser paint QA belong to the
coordinator's combined runtime validation.
