# Message search

Full-text search over this server's conversations. OpenCode 2 searches session
titles only, so the server keeps its own index.

## What is indexed

User messages and the text of settled agent replies, for root sessions. Tool
calls and their output, attached context records and subagent sessions stay
out (maintainer decision, 2026-10-01).

Agent reasoning is a second opt-in (`messageSearchReasoningEnabled`, off by
default: models that think at length can make the index several times
bigger). Reasoning is stored as its own row (`role = 'reasoning'`, row id
`<messageId>:reasoning`, `message_id` = the message), so it is filtered and
dropped without touching replies, and a hit still leads to its message. The
file records whether it holds reasoning (`meta.reasoning`): turning it on
clears every session's agent cursor so the next walk reads agent records
again; turning it off deletes the reasoning rows at once. The UI asks without
reasoning (`reasoning=0`) while the reader hides reasoning traces. On the maintainer's machine
that is ~3 MB of text in ~13 MB of index; tool output alone would be ~200 MB.

## Opt-in

Search is off until `messageSearchEnabled` (instance scope, `settings.json`)
is turned on in Settings → Chat (maintainer decision, 2026-10-01: indexing
must cost nothing on weak hardware unless asked for). Off means no index file
is opened, no event is looked at, no backfill runs, the route answers 503, and
the UI shows no message search (no Cmd+P group, Cmd+F left alone).

The runtime reads the setting at startup; `persistSettings` calls
`setEnabled` when the key changes. Switching off stops the indexer (after the
session being read finishes), closes the file and keeps it. Switching on
opens it and walks the session list, which re-reads every session changed
while search was off and drops deleted ones. Start, stop and delete run one
after another in the order asked.

## Ownership

- `sqlite.js` opens the builtin SQLite (`node:sqlite` on Node and Electron,
  `bun:sqlite` on Bun). No dependency; without either the runtime reports
  itself unavailable and the route answers 503.
- `store.js` owns the file `<dataDir>/message-search.sqlite`: `sessions`,
  `messages`, and an external-content FTS5 index with the trigram tokenizer
  (any 3+ characters inside a word, any script, case-insensitive). The schema
  version lives in `meta`; a mismatch drops and rebuilds, the file is derived.
  It also builds snippets: FTS5's `snippet()` counts trigrams and cuts a hit to
  a few characters, so the window is taken in JS on the returned hits.
- `indexer.js` keeps the index in step with OpenCode.
- `runtime.js` follows the setting, wires the indexer to the global event hub
  while on, answers queries, reports status (state, file size, progress) and
  deletes the file (while on, a fresh index starts at once: "rebuild").
- `routes.js` serves `GET /api/openchamber/message-search`,
  `GET .../message-search/status` and `DELETE .../message-search/index`.

## Keeping in step

- Live: `session.idle` and a settled assistant step (`message.updated` with
  `time.completed`) queue that session, debounced; a sync reads each message
  type (`user`, `assistant`) from its stored `cursor.next` onward. OpenCode
  returns a cursor with every non-empty page, so no cursor format is assumed.
- An assistant record without `time.completed` is still being written: it is
  not indexed and the cursor does not move past it, so the next sync reads it.
- OpenCode rejecting a cursor (the message is gone) resets the session and
  reads it again from the start, once per sync.
- A revert hides the conversation's tail and the next prompt deletes it: a
  changed revert boundary resets the session, and while one is set nothing at or
  after the reverted message is indexed and no cursor is kept.
- Background: on every (re)connect the session list is walked and sessions
  changed since they were read (`time.updated`) are queued behind live work,
  one at a time with a short pause. Sessions the index holds that the list no
  longer has are dropped, but only when the whole list arrived; a failed page
  is not an empty list.
- `session.updated` (rename, move) and `session.deleted` apply directly.

## Queries

Hits carry the message id; pages are cut by row id, since a reply and its
reasoning share a message. Every word of the query must occur; words shorter than three characters cannot
be looked up and are left out, and a query made only of them answers
`query-too-short` rather than everything. Newest first by default; `before`
pages by creation time with the message id breaking ties, so pages never
repeat or skip. Snippets mark matches with U+E000 / U+E001 and are plain text.
