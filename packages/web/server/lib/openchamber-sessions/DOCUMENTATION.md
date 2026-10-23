# OpenChamber sessions

## Ownership

This module owns OpenChamber session creation, dispatch, metadata writes, archive
state and explicit fork inheritance. OpenCode owns the session record and its
metadata. Automation producers choose their metadata and permission policy.

## Invariants

- `create(payload, { metadata, onSessionCreated })` passes internal metadata
  directly to OpenCode's `session.create`, before the callback and first prompt.
  `payload.metadata` and nested client options are ignored. HTTP and agent
  adapters pass only the payload and cannot inject these internal options.
- Automation producers write `openchamber.automation` with `source`, their
  identifiers and `notify: 'finish' | 'attention'`. Identifiers include
  `projectId`, `suggestionId`, `lensId`, `runId`, `taskId`, `botId`, `itemId`
  and `stage` where applicable. Creation preserves the supplied JSON metadata.
- A failed creation does not run the callback or dispatch. A failed callback
  leaves the created session usable and reports its identity as partial success;
  no prompt is sent. Callers can retain that identity for recovery.
- Explicit forks clear `automation` and `kind: 'scheduled'`, preserve unrelated
  metadata and pause active goals. The shared UI twin,
  `packages/ui/src/lib/sessionForkInheritance.ts`, applies the same rules on
  web, Electron, VS Code, hosted mobile and Capacitor mobile.
- Metadata writes preserve unrelated keys through merge patches. A failed read
  never supplies an authoritative empty record for a write.

## Decisions

### Why metadata is an internal creation option

The automation owner supplies metadata before any prompt can run. Keeping it
outside the public payload prevents HTTP and agent callers from selecting an
internal automation policy through session creation.

### Why explicit forks clear automation

A user fork starts independent work. Inheriting the source's automation would
keep its notification policy and automation identity on the user's session.
Both fork implementations remove the marker even when `kind` is absent.
