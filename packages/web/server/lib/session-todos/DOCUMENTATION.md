# Session todos

## Ownership

Keeps the agent's todo list of each session for the Work Status panel's Tasks
section. The list comes from OpenCode's experimental `todowrite` tool, which
is off unless the user turns on `experimental.todo`. OpenCode stores nothing
for it: the current list is the input of the session's newest completed
`todowrite` call before its revert boundary, and OpenCode's own clients find it
by scanning loaded messages.

The module owns the per-session lists, the state file `session-todos.json` in
the data dir, the `/api/session-todos/:sessionId` route and the
`openchamber:session-todos` broadcast. The UI side is
`packages/ui/src/stores/useSessionTodosStore.ts` and
`packages/ui/src/sync/session-todos-sync.ts`.

## Invariants

- Revisions begin from the current clock so a post-restart answer sorts newer
  than the prior process's list. Restarted lists remain unverified until checked
  against history, because persisted data cannot account for missed events.
- While the tool is off in a directory, the route answers `off` and reads no
  history; the UI lists no Tasks section. The event handling costs nothing
  there: an OpenCode with the tool off emits no `todowrite` calls.
- The tool counts as on in a directory as OpenCode resolves its flag:
  `OPENCODE_FLAGS` of the managed OpenCode (an external one's environment is
  unknown), then `experimental.todo` from the highest config document that sets
  `experimental` (the whole section, not per key), then `experimental.all_flags`,
  then on only for OpenCode's `local` and `0.0.0-dev-*` builds. A `todowrite`
  call seen in a directory also counts as on, until its config changes. The
  config is read for a directory only when a session there is asked for, which
  the user's open chat has already started.
- A completed call on the event stream replaces the session's list. The call's
  name arrives only on `session.tool.input.started`, and `session.tool.success`
  has no input, so a call is followed from its start; the list is the success
  event's `metadata.todos`, which the tool sets to its input.
- No history is read at startup. A session is looked up in its history when it
  is first asked for and has no list followed without a gap: newest agent
  messages first (`type=assistant`, 50 a page), one session at a time across
  the server, stopping at the first completed call or at the first message
  that finished by the time the stored list accounts for (`checkedThrough`). A
  message still streaming at that time is looked at again: a call in it may
  have ended while the stream was down. A walk that reaches the start without a
  call stores an empty list, so it runs once.
- A history walk that an event overtook does not commit: the event's list is
  newer.
- A (re)connect of OpenCode's stream marks every list unchecked, since calls,
  reverts and config changes during the gap were missed, and announces
  `sessionId: null, directory: null`, so clients ask again for the lists they
  show even when their own connection to this server stayed up, and mark the
  rest to ask when shown; the next ask walks back only to
  `checkedThrough`. A revert boundary at or before `checkedThrough` makes that
  walk start over, since a missed revert may hide the stored call.
- A revert (`session.revert.staged`, `cleared`, `committed`) drops
  `checkedThrough` and announces the session with `todos: null`; the next ask
  walks again, skipping messages from the boundary on. A config change
  announces the directory (`sessionId: null`), and clients read their lists
  there again.
- Only the event types this module reads are parsed; every other event of the
  stream, text deltas included, is dropped on its type, and a call's own
  events only for a call being followed.
- `session.deleted` forgets the session. The file keeps at most 2,000
  sessions, the least recently changed going first; it is derived data, so a
  file this version cannot read is rebuilt from history.
- Sessions in an isolated space answer `off`: their history lives in the
  space's own OpenCode.
- A route that cannot tell (OpenCode did not answer) fails with 502; the UI
  keeps what it shows.

## Decisions

### Why the server keeps the list and not the client's loaded messages

The chat loads a window of the newest turns and cuts long transcripts back to
it, and evicts sessions nobody looks at. A client-side scan therefore loses any
list older than the window. The server follows every session's calls from the
event stream and can page as far back as needed.

### Why the history is read lazily, one session at a time

A startup sweep would read the history of every session the user has. The
lazy walk usually ends on the first page, because an agent that keeps a list
updates it often; the expensive case, a long session without any call, walks
once and is remembered as empty.

### Why the flag is resolved here and not read from OpenCode

OpenCode 2.2.7 has no route for resolved flags or for a location's tool list.
Its config route returns the documents, so the resolution order is mirrored
from `Flag.resolve` in OpenCode's `packages/core/src/flag.ts`; a seen
`todowrite` call covers what the mirror cannot know (an external OpenCode's
`OPENCODE_FLAGS`, other preview channels).

### Why the route uses a structural HTTP contract

The server package has no Express type declarations. The route declares only
the request fields and response methods it uses, following the other converted
route modules. Request values remain unknown until their Zod schemas parse them.
The error guard checks for a message without requiring an Error instance or a
string message, preserving logging of arbitrary thrown values.

### Runtime conversion contracts

The runtime's `flagFromConfig` uses `Array.prototype.findLast` twice.
The shared server compiler includes ES2023 declarations while preserving its
ES2022 emit target. Conversion preserves both lookups without a local shim.

Todo inputs and history messages keep their schema-inferred types. These schemas
leave individual values unchecked, so the todo and message parsers validate them
where they are used. A todo needs nonempty text; an unknown status becomes pending.
The upstream contracts are defined by https://github.com/anomalyco/opencode.

The event hub owns the subscription and JSON payload contracts. The runtime checks
the incoming event type and call id before parsing the full event, keeping unrelated
stream traffic out of the parser. Property guards also retain inherited properties
and arbitrary thrown values when reading error messages and filesystem error codes.

Directory headers are percent-encoded because raw non-ASCII header values are
rejected by the client transport in `@opencode/client` 2.3.0. A newly written
record must remain present after trimming; a missing record still throws rather
than announcing an invented directory.
