# Context Obligatory Messages

Messages explicitly pinned by the user are stored under
`session.metadata.openchamber.context_obligatory_messages` as `{ id, createdAt,
role }`. The UI uses a fresh-read metadata merge when pinning or unpinning.

The server runtime listens for OpenCode's dedicated `session.compacted` event.
It fetches every pinned message by ID, keeps non-empty text parts, sorts them
by the stored creation time, and immediately sends one synthetic user part
through `prompt_async`. OpenCode's session runner serializes this with its own
post-compaction continuation. Missing individual messages are skipped without
discarding the remaining context. Ordinary idle events perform no work and
make no requests.

After a successful send, the runtime merge-writes
`context_obligatory_last_compaction_message_id`. This cursor prevents a
replayed compaction event from reinjecting the same summary. The runtime is
owned by the OpenChamber web backend and therefore is not available in
extension-only VS Code mode.
