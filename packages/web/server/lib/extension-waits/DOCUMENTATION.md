# Extension waits

## Ownership

Owns agents waiting on what an extension's service follows
(`contributes.waits`, contract in `packages/sdk/src/waits.ts`). The agent calls
the `openchamber` tool's `wait.start` with a source (`<extension id>/<wait id>`)
and arguments, then ends its turn: the call only subscribes. This module keeps
the wait, asks the service at `/waits/check` on the type's interval whether it
fired, and wakes the session with one synthetic message when it did. One wake
ends the wait. `wait.stop` ends one or every wait of the calling session,
`wait.list` names the session's waits and every source it may start one on.

It also owns the one source that is not an extension's: the built-in `timer`
(`wait.start` with `source: "timer"`, `args: { minutes }`). The host keeps it
and fires it on the clock, with no extension, no service and no approval
behind it, and delivers its wake like any other.

Wiring: created in `server/index.js` after `../pr-watch`, handed to the
control service as `extensionWaits` (`../openchamber-control/service.js`,
actions `wait.list`, `wait.start`, `wait.stop`, always for the calling
session), reconciled on every extension activation and deactivation
(`onExtensionWaitsChanged` in `server-frame/feature-routes-runtime.js`), stopped
by `server-frame/shutdown-runtime.js` in the same tick as guest admission closes.

It owns a second built-in source, `script` (`wait.start` with `source:
"script"`, `args: { code, minutes, hours? }`, in `builtin-waits.ts` and
`script-wait.ts`): the agent's Code Mode script runs every `minutes` without a
model, for up to `hours` (24 by default, at most 168), and the session wakes
with the text the script returns. The script runs as an OpenCode automation
the host creates for the session (`POST /api/experimental/automation`, a code
action with an `every` trigger and `expires`); this module checks that
automation at least once a minute (more often than a long script interval, so
a wake is not an interval late) and delivers the wake like any other.
OpenCode before 2.4 cannot run such a script: `wait.list` offers `script`
only when `GET /api/info` names 2.4.0 or newer, and `wait.start` refuses it
with the version otherwise.

A script wait owns its automation for its whole life. Every way the wait ends
deletes it: the wake delivered, the wait ended, `wait.stop`, the session
deleted (also while the start is still creating it) or archived (checked
before each check). A delete that fails, and a crash before it, leave an
automation behind; the next check pass and every start list the automations
named `OpenChamber script wait <owner>` and delete those no stored wait
names, once they are five minutes old so a start in flight keeps its own.
`<owner>` comes from this server's data directory, so two OpenChamber
servers on one OpenCode never delete each other's.

The extension's service is reached through `../guests/service.js`
(`proxyGuestServiceRequest`), with the guest proxy's own grant, pause and
idle-stop rules. The proxy stops a service after ten minutes without a
request, and each wait request carries that same idle stop.

## Invariants

- An extension's wait exists only after its service took it. `wait.start`
  checks the arguments against the declared params (`waitArgsSchema`), then
  posts `/waits/start`; a refusal, an unexpected answer or an unreachable
  service fails the agent's call with the reason, and nothing is stored. A
  timer is checked against its own params, then `minutes` must be a whole
  number from 1 to 1440; anything else is refused and nothing is stored.
  The bare source name `timer` cannot collide with an extension's, whose
  source always holds a slash.
- Starting a timer reads no catalog, and no catalog change or failed
  catalog read ends a timer or postpones its check: a due check marks every
  due timer fired before it reads the catalog, and `reconcile` leaves timers
  out. The wake is saved and handed to delivery when that check pass ends,
  after its catalog read and extension checks, and a timer that comes due
  while a pass runs waits for a later pass. So a slow catalog read or
  extension service makes a timer late by as long as the pass takes; it does
  not end it. `wait.list` still answers 503 when the catalog cannot be read,
  timer included, since an unreadable catalog is not an empty one.
- Only a catalog row that is enabled, fully approved, and holds both
  `service` and `wake` may start or keep a wait (`isWaitProvider`). `wake` is
  approved for the declared wait ids (`../guests/grant-scope.js`), so a
  version that adds one is unapproved until the dialog runs again.
- A wait never ends silently while the agent may still count on it, and never
  hangs forever. These end it with a wake whose `outcome` is `ended` and says
  why: a paused or removed extension, a withdrawn approval, a type the package
  no longer declares, a check entry for it that does not parse, and six hours
  in which every check of it failed. Six hours separates a service that is
  down for a while from one that is broken. `wait.stop`, `session.deleted` and an
  archived session end it without one. A full store refuses `wait.start`
  (409) and never evicts a wait: an evicted wait would end without telling its
  agent.
- A check answer whose envelope does not parse is a failed check: no wait
  fires and no state moves, and the type is asked again after its interval
  doubled per consecutive failure, up to ten minutes. Inside a good envelope
  each entry is read on its own, so one malformed entry ends only its wait.
  A catalog that cannot be read is never an empty catalog. One check timer
  serves the earliest due wait, and a type has at most one check in flight: a
  wait being checked is left out of the timer and reschedules when its answer
  is in. A run marks the waits it will check before its first await, so a run
  that a stop, a start or a wake schedules meanwhile cannot check them twice.
- The extension's text sits inside an `<openchamber-wait source="…">`
  envelope that names the extension and says the words are its own; `<` and
  `>` are removed from the summary, the label and the title, and the SDK caps
  the summary at `WAIT_SUMMARY_MAX`.
- Delivery follows `../pr-watch`: a wake is sent as soon as it fires, into a
  running turn too (see pr-watch's decision), one wake at a time per session,
  the message id minted and persisted before the first attempt, OpenCode's 409
  counts as delivered, 404 ends the wait, eight failed attempts give up. A
  wake that comes due while an attempt is in flight is tried at that
  attempt's end. Attempts are spaced by `QUIET_MS` (500 ms). The id is saved
  before the send because a second attempt would otherwise mint another and
  OpenCode would admit the wake twice.

## Persistence

`<data-dir>/extension-waits.json`, written atomically, owner-readable only:
`{ id, sessionID, directory, guestId, type, title, label, args, state,
startedAt, nextCheckAt, failingSince, wake }` per wait. `state` is the opaque
JSON the service handed back, posted again on the next check; `failingSince`
survives a restart, so the six hours count across it. A timer has `guestId`
`null` and its due time as `nextCheckAt`, so one that came due while the
server was down fires on the next start. A malformed file is moved aside, one
unreadable wait is dropped alone, a failed read keeps writes off until a load
succeeds. Writes run one at a time.

A start, a removal (stop, delivered wake, deleted or archived session) and a
wake's message id count only once they are on disk: a write that fails undoes
the change in memory and broadcasts the list as it was, with the revision
raised again so a snapshot that showed the change is replaced. So a failed
start leaves no wait, a failed stop keeps the wait running, and a restart
restores what the caller was told. A removal or message id that could not be
saved during delivery is retried like a failed delivery, and no message goes
out under an id that is not saved. A removal that fails also reschedules the
checks and a pending wake, since a check or wake that came due while the write
was pending saw the waits gone. A fired or ended check stays in memory when
its write fails; the next write catches the file up.

At most 200 waits, 20 per session, refused with 409 and never evicted. A start
holds its place under both caps from the check until the wait is in or
refused, so starts racing past the service request cannot exceed them.
Timers, failure counts, reservations and the in-flight set are memory only:
after a restart every due wait is checked on the next tick.

## Message

`POST /api/session/:id/synthetic` with `delivery: 'steer'`, `resume: true`,
`description` `<title> (<label>): <first line of the summary>` (the chat shows
it as a notice row), and `metadata` `{ source: 'openchamber-wait', waitId,
extension, type, title, label, outcome }`, `extension` being `null` for a
timer, which also carries `minutes` so the chat names it in the user's
language. A timer's text is the host's own (`Timer (10 min) fired: 10 minutes
passed.`), not quoted as an extension's words.

## Routes and events

| Route | Purpose |
|---|---|
| `GET /api/extension-waits` | `{ revision, waits[] }`: `waitId`, `sessionID`, `directory`, `source`, `extension` (its name when the wait started), `title`, `label`, `args`, `startedAt`, `status` (`waiting`, or `waking` once it fired or ended and its message is on the way) |
| `DELETE /api/extension-waits/sessions/:sessionID` | The user's stop, of the wait at `?waitId=` or of every one: what it stops does not wake the session |

The revision starts from the clock at load, so it keeps rising across a
restart even when the file is behind the last run (a write that failed, a
corrupt file moved aside); clients drop anything older than what they
applied. Every change a client can see (a start, a stop, a wait turning
`waking`, a wake delivered) bumps the revision and broadcasts
`openchamber:extension-waits.updated` `{ revision, sessionID, waits[] }` on
the control stream, `waits` being the session's whole list. Saving a wake's
message id or a new `state` is not such a change. The UI projection is
`packages/ui/src/sync/extension-waits.ts`.

## Runtime parity

Web and desktop with an OpenChamber server run it, and show the composer row
and the session as waiting. VS Code has no server, so no agent there has the
tool and the UI reads no waits. The server inside an isolated space refuses
`wait.start`, timer included, and `wait.list` offers no source there: it runs
no extensions, and it stops itself after a time with no working session
(`../spaces/idle-stop.js`), so a timer could be stopped before it fires. Both
mobile clients show the composer row, the waiting session and the wake row
through the server they are connected to.

## Decisions

### Why in-memory arguments follow the schema output

`WaitArgs` is the inferred output of the SDK's `waitArgsSchema`. An optional
argument explicitly supplied as `undefined` stays an own property in memory.
JSON serialization omits it from service requests and the stored file, whose
unchanged `argsSchema` accepts only strings, numbers and booleans. The message
helper uses the in-memory contract too. Claiming `GuestWaitArgs` at the parser
would promise more than the schema checks.

Arguments may arrive as JSON text from the agent. Parsing that text before
the argument schema preserves the same validation for object and text inputs.

### Why provider admission does not promise a service contribution

`isWaitProvider` checks enablement, wait declarations and approval. It does not
check `service`, so its narrowed type keeps that field optional, matching
`GuestRecord`. The injected proxy request describes exactly what the runtime
passes, including a potentially absent service; the service implementation owns
that request's failure. The SDK wire argument types and the guest proxy's
required service parameter remain unchanged.

### Why the host checks and the service answers

The service would otherwise need its own timers, its own storage, and
`service.keepRunning` to outlive the idle stop and every restart. With the host keeping
the waits and posting each one's `state` back, a service is a pure function of
the request and can stop between checks. `../pr-watch` makes the same choice
by riding the tracked-items refresh instead of a poller of its own. A push
callback for services that hear about events themselves (webhooks) is the
next step, not a replacement.

### Why a wait and not `sessionControl`

A service with `sessionControl` can already send to any session, whenever and
whatever it likes. A wait asks for less and shows the user more: the agent
chooses to wait and names on what, OpenChamber writes one message to that
session only, once, when the service says the wait fired, and meanwhile the
session reads as waiting with a Stop in the composer. So `wake` is its own
capability: approving waits never lets a service write into a session the agent
did not hand it.

### Why a wait that can no longer fire wakes the agent

An agent that started a wait ended its turn believing a message will come.
`../pr-watch` documents the agent that kept waiting on a watch that had been
replaced. Ending with a wake that says why lets the agent decide what to do
instead of waiting forever.

### Why the delivery is a copy of pr-watch's for now

`../dispatch-results`, `../pr-watch` and this module share the same delivery
rules. Moving them into one module changes two shipped runtimes, so it is its
own change; until then this copy follows pr-watch line for line.

### Why the script runs as an OpenCode automation and not in OpenChamber

Running a script with tools and no model is OpenCode's Code Mode, and
OpenChamber has no executor of its own for it. An OpenCode code automation
runs exactly that on a trigger, with the session's permission rules, a
30-second and 32 KB cap per run, and state kept between runs. The script is
wrapped (`wrapScript`) so the agent writes a plain check: its own `return`
ends a run, a non-empty string or `{ wake }` becomes OpenCode's `done` with
the wake text in `state.wake`, and `{ state }` is kept under `state.s`. A
throw ends the automation with the error in `state.error`, because OpenCode
retries a failed run after a minute and the next run could cover the
failure before the host reads it. The
automation never sends to the session itself: OpenCode's `send` steers the
session directly, past this module's delivery rules, so the host reads
`state.wake` when the automation is done and wakes the session the usual
way.

OpenCode creates an automation from a plugin or over HTTP without anyone
present, so each permission the script needs is settled by the session's
rules alone: an `allow` passes, and an `ask` refuses the script with
OpenCode's own words, which `wait.start` passes on. OpenChamber's
permission auto-accept never sees that request. A run that throws ends the
wait with its error, because the next run fails the same way and the agent
can fix the script. The text a script returns reaches the agent escaped
(`&lt;` for `<`), and unchanged in the wake's metadata.

### Why the timer is a source of this runtime and not an extension or a runtime of its own

An agent needs a timed wake of its own session without a registered project
or an extension. Shipping the `wait-kit` example as a built-in extension
would need an approval, a service process and a check every ten seconds for
something the host's clock already knows. A runtime of its own, like
`../pr-watch`, would be a third copy of the delivery, with its own file,
routes and UI projection, and `wait.list` and `wait.stop` would have to merge
two stores. As one host-owned source here it reuses the store, the caps, the
check timer, the delivery, both routes and the composer row. Its record
carries `guestId: null` rather than a reserved extension id, because no
extension id is reserved and a real extension could carry it.

### Why a timer is whole minutes up to a day

Minutes are the unit an agent waits in on background work; one day bounds
how long a forgotten timer can outlive the attention it was for, and stays
far below the delay at which a Node timer overflows (about 24.9 days), so the
one check timer needs no special case.

### Why a session may hold several timers

Extension waits already allow several per session, up to the 20-wait cap, and
each one shows in `wait.list` and the composer row with a Stop. Replacing the
session's running timer, as watching the same pull request again replaces
its watch, would end a wait the agent still counts on without a wake.
