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

## Decisions

### Why ancestor reads belong to tool completion

A child transcript can list a tool message stored by its parent. Completing an
existing shell needs that result, but broadening strict reads would make pins
and references attribute parent messages to a child and make existence checks
accept messages outside that session's history. All shared UI runtimes use the
same completion path through the runtime-aware SDK transport.
