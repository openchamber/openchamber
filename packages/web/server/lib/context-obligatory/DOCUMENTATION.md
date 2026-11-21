# Context Obligatory Messages

Messages explicitly pinned by the user are stored under
`session.metadata.openchamber.context_obligatory_messages` as `{ id, createdAt,
role, sessionID }`. The UI uses a fresh-read metadata merge when pinning or
unpinning and requires an owner for every new pin. The runtime only re-injects
into root sessions. A session with a `parentID` is skipped before its metadata
is read, so child and subagent sessions cannot restore parent pins. Root
sessions, including user forks, restore their own pins. Fork repair maps copied
messages to their new IDs and owner when the message reads succeed.

The server runtime listens for `session.compacted`. OpenCode 2.x declares that
event but never publishes it; the server's wire translator
(`event-stream/translate-v2.js`) produces it from `session.compaction.ended`.
The runtime finds the newest completed `compaction` message,
fetches every pinned message by ID, keeps non-empty text content, sorts them by
the stored creation time, and posts one message to
`/api/session/:id/synthetic` with `resume: false`. Project knowledge needs
nothing here: it lives in the session's instruction entries, which OpenCode
keeps through compaction (`../session-knowledge/DOCUMENTATION.md`). Missing
individual messages are skipped without
discarding the remaining context. Other events perform no work and make no
requests.

After a successful send, the runtime merge-writes
`context_obligatory_last_compaction_message_id`. This cursor prevents a
replayed compaction event from reinjecting the same summary. The runtime is
owned by the OpenChamber web backend and therefore is not available in
extension-only VS Code mode.

## Invariants

- The runtime stays inert without both metadata read and cursor persistence
  dependencies. Cursor writes merge only their fields into the OpenChamber
  namespace, preserving concurrent goal and assist changes.
- Metadata pins are checked for a string id, numeric creation time and user or
  assistant role. Other metadata fields remain unchecked. The compaction cursor
  preserves the upstream id after its existing truthiness check, so its type
  remains unknown.
- OpenCode JSON responses are read as records with unchecked optional fields.
  Non-record responses have no usable session, page or message fields and are
  treated as absent. Text parts require a text type and string text.

## OpenCode response contract

The [`@opencode/client` 2.3.0 contract](https://www.npmjs.com/package/@opencode/client/v/2.3.0)
uses newest-first message pages with data and cursor fields. Completed compaction
messages have their own role, completed status and `time.created`. User messages
carry text, while assistant messages carry content arrays. Synthetic context is
a separate message; model and agent selection belongs to the session.

### Why fork repair uses complete message lists

Copied messages have new IDs but retain their role and creation time. Repair
uses those fields only when the source match is unique and the fork has at most
one match. It leaves ambiguous or unreadable pins unchanged, and removes a pin
only when complete reads show its source message was not copied. A copy the
user pinned while the repair ran keeps that one pin.

The repair writes through the conditional metadata route, decided against the
current record, so a pin added or removed meanwhile survives. That coordination
holds only for writers on the same server or extension host. Repair runs once,
when the fork is made: forks created before it keep their source IDs. The UI
opens a fork only after the repair, and a server-side fork sends its first
prompt only after it, so the first compaction and the user's pin edits see the
repaired IDs. A fork opened some other way before the repair lands (from the
session list, or another client) can still compact without the inherited pins
or have an unpin undone by the repair.
