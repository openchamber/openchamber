# OpenCode adapter

## Ownership

This module owns official OpenCode SDK calls and translation from wire records
to the shared UI domain model. Sync owns transcript membership and store writes.

## Invariants

- `getSessionMessage` reads only the requested session. Pins, message references
  and linked-message existence checks must retain this strict behavior.
- `getToolContentMessage` is reserved for `completeToolContent`, which checks
  that the displayed transcript already holds the message and a shelled result.
  It projects the result into that transcript without changing other readers.
- Ancestor reads follow only server-provided `parentID` links after a message
  404. At most 32 sessions, including the requested session, are read. An ended
  or cyclic chain, the limit, a missing session or a runtime switch returns the
  first message 404. Other errors stop the walk and propagate unchanged.
- A runtime switch during a successful read also discards that response. Sync
  independently checks runtime identity and transcript membership before writing.
- A send that switches the session's agent first reads the folder's agent list.
  Sync also passes the agent when the session already sits on one the folder's
  loaded catalog lacks, so that session gets the same check.
  An agent missing from it throws `AgentUnavailableError` before any switch,
  the model included. A failed or empty list lets the switch through.

## Decisions

### Why fresh provider reads wait for post-call requests

Provider, model and default-model reads share one catalog promise per directory
on the active SDK instance. `fresh` waits for any request started before the
call, including another fresh request. Callers waiting on the same read share
the replacement started afterward. Joining an earlier fresh request lost a
second catalog change arriving during that request. Catalog invalidations
coalesce by resource revision above this adapter. Reconnect clears the request map;
obsolete completions cannot remove the replacement runtime's entries.

### Why a missing agent stops the send instead of being skipped

OpenCode records any agent name and fails only the next turn, so the send has
to check first. Skipping the agent write and sending on the session's current
agent was rejected: the composer would show one agent while another answered.
The send stops and the composer shows the error, so the user picks an agent.
Before that, the agent picker marks such an agent with a warning
(`components/chat/agentAvailability.ts`), read from the loaded catalog of the
composer's own folder; a catalog still loading marks nothing.

### Why ancestor reads belong to tool completion

A child transcript can list a tool message stored by its parent. Completing an
existing shell needs that result, but broadening strict reads would make pins
and references attribute parent messages to a child and make existence checks
accept messages outside that session's history. All shared UI runtimes use the
same completion path through the runtime-aware SDK transport.
