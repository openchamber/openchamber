# Session warming

## Ownership

Keeps the provider's prompt cache of the sessions the user picked alive while
they sit idle. While a session is warmed, the server sends OpenCode's transient
`POST /api/session/:id/generate` with a keep-alive prompt every 4 minutes,
until the chosen duration (30 minutes, 1, 2 or 3 hours; 1 hour by default)
after the session's last turn ended. The request reads the whole
session context and adds nothing to its history.

The module owns the per-session choice, the timers, the state file
`session-warming.json` in the data dir, and the `/api/session-warming` routes.
OpenCode's own `warming` config, which warms every session, is written by
`opencode/websearch-config.js`; the mode and duration routes here only pick
which of the two a write goes to. The UI side is `packages/ui/src/stores/useSessionWarmingStore.ts`.

## Invariants

- Only one mode is on: `all` writes OpenCode's `warming` key and turns
  per-session warming off; `session` removes the key and turns it on; `off`
  does both. Turning per-session warming off forgets every chosen session.
- While per-session warming is off (modes `off` and `all`) the runtime ignores
  the event stream and holds no per-session state: no timers, no requests.
- The mode route writes OpenCode's config first. When that write fails, the
  per-session state is unchanged.
- A warmed session's `warmUntil` is null while a turn runs and while no turn
  has ended since the toggle. A turn that ends sets it to the chosen duration
  later and arms the first ping one interval later. No ping runs while a turn
  does, and none after `warmUntil`.
- Changing the duration moves every running window by the difference, so the
  countdown shows the new length; a window that had run out and fits the
  longer one pings again at once.
- The duration route takes only the offered steps. For `all` it writes
  OpenCode's `warming.duration` while its warming is on; OpenCode's default
  30 minutes is written back as the plain `true`.
- When the event stream has not told the runtime whether a session is running
  (a toggle it saw no event for, a restart, a reconnect after a gap), it asks
  OpenCode's `/api/session/active` before any ping. Running: wait for the
  turn's end. Idle with no window started: the window starts now and the first
  ping goes at once. A failed read is retried 30 seconds later, never taken as
  idle.
- A ping or status read that was in flight across a state change does not act
  on the new state (`epoch`).
- A session is forgotten when OpenCode deletes it (`session.deleted`) or
  answers a ping with 404. Any other ping failure waits for the next interval,
  and the window keeps counting down, as in OpenCode's plugin.
- The state file is read synchronously at start, before any route or event can
  change the state. `stop` resolves once the last change is written.
- Every change persists the state file and broadcasts the full snapshot
  (`openchamber:session-warming`) with a rising `revision`.
- Sessions in an isolated space are refused: they run on the space's own
  OpenCode, which this server does not reach with the ping.
- Routing's cache hold counts a warmed session as warm until `warmUntil` plus
  one cache lifetime (`isSessionWarm`).

## Decisions

### Why OpenChamber pings and not OpenCode

OpenCode's warming is one config key for every session, and its plugin has no
per-session switch. The generate route is the same request the plugin sends,
so pinging it from here gives the same effect for the sessions the user picks.
The prompt is OpenCode's own keep-alive prompt, so if OpenCode's warming is
also on (a hand-edited config), OpenCode treats the ping as a keep-alive and
does not restart its own window.

### Why a few steps and not a slider

A session is warmed or not; how long is one choice in Settings with four
steps, the same for both modes. A slider per session was asked for and
dropped: a per-session length is more control than the feature needs, and
steps are easier to hit than a slider position.

### Why a state file and not session metadata

`warmUntil` changes at the end of every turn. Session metadata is written to
OpenCode with a session PATCH, which is a request per turn and an update event
for every client. The state file is local, and the broadcast carries the same
snapshot.

### Why an unknown session is asked about and then pinged at once

The server knows when a turn ended only if it saw the event. Treating an
unknown session as idle would send a ping into a running turn; asking
`/api/session/active` costs one cheap request. Once the session is known to
be idle, the turn may have ended more than an interval ago and the cache may
be about to lapse, so the first ping goes right away. A turn the server saw end
under an interval ago gets its first ping on the usual beat.

### Why the status read after a restart waits 30 seconds

OpenCode starts with the server. A read before it is up fails and is retried
30 seconds later anyway; waiting first saves the failed request.
