# Context Obligatory Messages

Messages explicitly pinned by the user are stored under
`session.metadata.openchamber.context_obligatory_messages` as `{ id, createdAt,
role }`. The UI uses a fresh-read metadata merge when pinning or unpinning.

The server runtime listens for `session.compacted`. OpenCode 2.x declares that
event but never publishes it; the server's wire translator
(`event-stream/translate-v2.js`) produces it from `session.compaction.ended`.
The runtime finds the newest completed `compaction` message,
fetches every pinned message by ID, keeps non-empty text content, sorts them by
the stored creation time, and posts one message to
`/api/session/:id/synthetic` with `resume: false`, together with the session's
pinned project knowledge. Missing individual messages are skipped without
discarding the remaining context. Other events perform no work and make no
requests.

After a successful send, the runtime merge-writes
`context_obligatory_last_compaction_message_id`. This cursor prevents a
replayed compaction event from reinjecting the same summary. The runtime is
owned by the OpenChamber web backend and therefore is not available in
extension-only VS Code mode.
