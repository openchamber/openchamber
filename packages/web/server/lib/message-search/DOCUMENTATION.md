# Message search

Full-text search over this server's conversations. OpenCode 2 searches session
titles only, so the server keeps its own index.

## What is indexed

User messages and the text of settled agent replies, for root sessions. Tool
calls and their output, attached context records and subagent sessions stay
out (maintainer decision, 2026-10-01).

Agent reasoning is opt-in (`messageSearchReasoningEnabled`, off by
default: models that think at length can make the index several times
bigger). Reasoning is stored as its own row (`role = 'reasoning'`, row id
`<messageId>:reasoning`, `message_id` = the message), so it is filtered and
dropped without touching replies, and a hit still leads to its message. The
file records whether it holds reasoning (`meta.reasoning`): turning it on
clears every session's agent cursor so the next walk reads agent records
again; turning it off deletes the reasoning rows at once. The UI asks without
reasoning (`reasoning=0`) while the reader hides reasoning traces. On the maintainer's machine
that is ~3 MB of text in ~13 MB of index; tool output alone would be ~200 MB.

### Why the reasoning switch is read per record and dropped on every start

`includeReasoning` is a function rather than a value captured at startup, so
a change applies from the next record read instead of the next restart. While
the switch is off, every start deletes the reasoning rows again, not only a
start that saw the switch change: a session read while it flipped off can
leave a stray row behind. A query with reasoning off filters those rows out
as well, so a row written just before the switch took effect stays hidden.

### Why user text drops a trailing terminal context

Older builds appended the user's terminal selection to a prompt inside
`<terminal_context>`. That text is source material, not what the user wrote,
so it is stripped before indexing, the same way `session-assist/context.js`
strips it.

Scale, measured 2026-10-01 on a synthetic 9072-session / 196k-message index:
a rare word answers in 1 ms, a very common one in 15 ms (max 25), a
single-session search in 12 ms, and the file is ~560 MB (the trigram index is
about five times the text; a word tokenizer would be ~200 MB but loses in-word
and CJK matching). A full backfill of 189 root sessions against a real
OpenCode took 13.7 s and 700 requests with no event-loop block over 50 ms;
blocking is bounded per page, not by session count. To bench against a
throwaway OpenCode: `env -i HOME PATH TMPDIR OPENCODE_SERVER_PASSWORD=<throwaway> opencode serve --port 4999`
(Basic auth user `opencode`).

## On by default

Search is on unless `messageSearchEnabled` (instance scope, `settings.json`)
is `false` (`isMessageSearchEnabled` in `opencode/settings-helpers.js`). A
settings file that never mentions the key belongs to a user who never chose
and gets the default; an explicit `false` is a choice and stays. The settings
response always carries the resolved value, because the client keeps its own
copy of the switch and has to follow the server's: without that a client that
remembered the old default would show the switch off while the server indexed.
The client's own default stays off, so a runtime with no OpenChamber server
(VS Code) offers no message search. Off means no index file is opened, no
event is looked at, no backfill runs, the route answers 503, and the UI shows
no message search (no Cmd+P group, Cmd+F left alone).

### Why on by default and not opt-in

It was opt-in so that indexing cost nothing on weak hardware unless asked for
(maintainer decision, 2026-10-01). Since conversation search came to the
sidebar and Archive, message text is half of what a search finds, and a user
who never opened Settings got the weaker search without knowing why
(maintainer decision, 2026-11-12). The cost that worried us is bounded: the
backfill starts from the newest sessions, pauses between pages, and never
blocks the event loop for long; the index is about 90 KB per conversation and
its size shows under the switch, with Rebuild beside it. Reasoning stays
opt-in, since it can make the index several times bigger.

The runtime reads the setting at startup; `persistSettings` calls
`setEnabled` when the key changes. Switching off stops the indexer (after the
session being read finishes), closes the file and keeps it. Switching on
opens it and walks the session list, which re-reads every session changed
while search was off and drops deleted ones. Start, stop and delete run one
after another in the order asked. The status endpoint waits for that queue,
so it answers with the state a switch or delete just asked for produced, not
the one before it. Shutdown waits for in-flight session reads and lifecycle
overlays before the file closes under them.

## Ownership

- `sqlite.js` opens the builtin SQLite (`node:sqlite` on Node and Electron,
  `bun:sqlite` on Bun). No dependency; without either the runtime reports
  itself unavailable and the route answers 503.
- `store.js` owns the file `<dataDir>/message-search.sqlite`: `sessions`,
  `messages`, and an external-content FTS5 index with the trigram tokenizer
  (any 3+ characters inside a word, any script, case-insensitive). The schema
  version lives in `meta`; schema 4 migrates schema 3 in one transaction to
  preserve indexed rows and cursors. Reopening also completes a schema 3 file
  that already has either lifecycle column from an interrupted development
  migration. Unknown older files rebuild because the file is derived. Session
  rows retain archive state and whether it is known. SQLite keeps its
  write-ahead log and shared-memory index in `-wal` and `-shm` files beside
  the index; deleting the index removes all three, and the reported size adds
  them. Settled message text is immutable, so a re-read writes a row only
  when its text changed.
  It also builds snippets: FTS5's `snippet()` counts trigrams and cuts a hit to
  a few characters, so the window is taken in JS on the returned hits.
- `indexer.js` keeps the index in step with OpenCode.
- `runtime.js` follows the setting, wires the indexer to the global event hub
  while on, answers queries, reports status (state, file size, progress) and
  deletes the file (while on, a fresh index starts at once: "rebuild").
- `routes.js` serves `GET /api/openchamber/message-search`,
  `GET /api/openchamber/message-search/sessions`,
  `GET .../message-search/status` and `DELETE .../message-search/index`.

### Why prepared statements are cached per SQL string

A backfill runs the same few statements tens of thousands of times, so the
wrapper prepares each SQL string once and reuses the statement. Preparing per
call would put the parse cost inside that loop.

## Keeping in step

- Live: `session.idle` and a settled assistant step (`message.updated` with
  `time.completed`) queue that session, debounced; a sync reads each message
  type (`user`, `assistant`) from its stored `cursor.next` onward. OpenCode
  returns a cursor with every non-empty page, so no cursor format is assumed.
- An assistant record without `time.completed` is still being written: it is
  not indexed and the cursor does not move past it, so the next sync reads it.
- Each cursor is stored with the id of the message it points after. OpenCode
  answers a cursor whose message is gone (a revert followed by a new prompt
  deletes the tail) with an empty page, the same as "nothing new". So an empty
  page checks that message: when it is gone, or OpenCode rejects the cursor,
  the session is reset and read again from the start, once per sync. Before
  schema 3 an empty page was taken at its word and such a session was never
  read past that point again.
- A revert hides the conversation's tail and the next prompt deletes it: a
  changed revert boundary resets the session, and while one is set nothing at or
  after the reverted message is indexed and no cursor is kept. When the
  reverted message itself cannot be read the boundary is unknown, and nothing
  is indexed for the session rather than text the user took back.
- Background: on every (re)connect the session list is walked and sessions
  changed since they were read (`time.updated`) are queued behind live work,
  one at a time with a short pause. Sessions the index holds that the list no
  longer has are dropped, but only when the whole list arrived; a failed page
  is not an empty list.
- `session.updated` (rename, move) and `session.deleted` apply directly.
- A completed session-list walk records archive state for every root session,
  including rows without indexed messages. A failed page writes no lifecycle
  state and retains the prior state. Each walk and individual session read
  captures the lifecycle revision before it starts; archive or restore events
  received while that asynchronous read runs win when the snapshot commits.
  The latest committed mutation stays per session so a later full walk cannot
  reopen a stale, older individual read. Deleted sessions release that entry
  after every older lifecycle reader finishes.
- The legacy archive store is folded over OpenCode's records before walks,
  individual reads, and live lifecycle events record them. A live event keeps
  the prior effective state visible until that asynchronous overlay succeeds;
  an overlay read failure publishes nothing. Explicit legacy `null` entries
  restore a session, while missing entries preserve OpenCode's state.
- The indexer reads raw `session.archived` events from the hub envelope's
  `payload` to take OpenCode's own archive time from `created`: the server
  translator (`event-stream/translate-v2.js`) keeps only the session id and
  replaces a missing `created` with the time it received the event. Translated
  `session.unarchived` events are read normally. This is the only exception
  here to the translated-event boundary. The wire payload has `data.sessionID`
  and `created` (`node_modules/@opencode/schema/dist/event.js:27-35`); the UI
  translator confirms the archive pair at
  `packages/ui/src/lib/opencode/events.ts:367-371`.

### Why the OpenCode client is built per call

The client is created at each use instead of once at startup, so a restarted
or re-pointed OpenCode is picked up as soon as it exists. The directory goes
into `x-opencode-directory` URI-encoded because OpenCode 2 scopes requests by
that header and rejects non-ASCII header values.

### Why an unusable record is skipped instead of failing the session

Each record is parsed for the fields the index uses; anything else on it is
ignored. A record this reader does not understand carries nothing it can
index, so it is passed over and the rest of the session stays searchable.

### Why a location-less event has no directory

The hub envelope names the event's directory, and uses `'global'` when the
event has no location; the indexer reads that as the empty directory. When
the envelope has none and the translated payload carries
`properties.directory`, the payload's directory is used.

## Queries

Hits carry the message id; pages are cut by row id, since a reply and its
reasoning share a message. Every word of the query must occur; words shorter than three characters cannot
be looked up and are left out, and a query made only of them answers
`query-too-short` rather than everything. Newest first by default; `before`
pages by creation time with the message id breaking ties, so pages never
repeat or skip. Snippets mark matches with U+E000 / U+E001 and are plain text.
The markers are private-use characters, which ordinary text cannot contain,
and they are not markup, so a snippet is never rendered as HTML. A snippet is
cut in JS rather than by FTS5's `snippet()`, because that counts trigrams and
cuts a hit to a few characters. Where lowercasing changes a string's length
(rare scripts), offsets would drift, so that text is returned unmarked.
The grouped endpoint filters lifecycle, directory and role before grouping. It
uses the newest matching row per session as its representative and counts
distinct message ids, so a reply and its reasoning produce one match count.
Archive state that is still unknown appears only in the `all` lifecycle. Its
repeatable `exclude` parameter accepts at most 200 session ids. Excluded
sessions remain hits but leave the first page's totals and directory counts.
The grouped page walks the chronological message index, chooses each session's
globally newest filtered match, and applies the cursor to those representatives.
It stops after `limit + 1` distinct sessions. A second indexed lookup counts
matching messages only for the selected sessions. Totals inspect at most 20,000
matching rows and return `null` when they reach that cap.

### Why a snippet centres on the longest term

In "git rebase" the rare term says more than a short one that also matches
inside "github", so the window is centred on the longest query term. The cut
is then extended to whole words at both edges.

## HTTP

`GET /api/openchamber/message-search` takes `q` (every word must occur, each
three characters or more), `session` (only this session), repeatable
`directory`, `role` (`user`, `assistant` or `reasoning`), `lifecycle`
(`active`, `archived` or `all`), `reasoning=0` (leave reasoning hits out while
the reader hides them), `order` (`desc`, newest first, or `asc`), `before`
(a previous answer's `next`, `<createdAt>:<id>`) and `limit` (1..200, default
20). It answers `{ status: 'ok', hits, next, index }` or
`{ status: 'query-too-short', hits: [] }`, and 503 when no index runs: search
is off, or this server has no SQLite.

`GET .../message-search/sessions` groups hits by session. It requires `q` and
takes the same `directory`, `role`, `reasoning`, `lifecycle` and `before`,
plus `exclude` (up to 200 session ids left out of the first page's totals and
directory counts) and `limit` (1..100, default 20). Its `next` is
`<createdAt>:<sessionId>`, and it answers `{ status, hits, next, totals, index }`.

`GET .../message-search/status` answers
`{ state: 'unsupported' | 'off' | 'on' | 'failed', sizeBytes, index }`.
`DELETE .../message-search/index` deletes the file and answers the status
afterwards; while search is on a new one starts at once.

Repeated query keys arrive as arrays, so every field accepts the shape it may
take.
