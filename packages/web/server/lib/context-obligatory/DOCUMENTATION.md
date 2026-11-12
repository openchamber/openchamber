# Context Obligatory Messages

Messages explicitly pinned by the user are stored under
`session.metadata.openchamber.context_obligatory_messages` as `{ id, createdAt,
role, sessionID }`. The UI uses a fresh-read metadata merge when pinning or
unpinning and requires an owner for every new pin. The runtime only re-injects
into root sessions. A session with a `parentID` is skipped before its metadata
is read, so child and subagent sessions cannot restore parent pins. Root
sessions, including user forks, retain the existing handling of inherited pins
and the compaction cursor, whether pins have an explicit owner or are legacy
ownerless entries.

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

### Why root sessions keep inherited pins

User forks keep their existing pin inheritance. Copied messages receive new ids,
so remapping inherited pins needs a separate change. Filtering by the source
owner or the fork's creation time would hide those pins and stop their restore
after compaction.
