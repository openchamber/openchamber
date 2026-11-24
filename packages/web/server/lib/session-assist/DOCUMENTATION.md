# Session assist

The server generates a short reminder of recent work and an optional next user
message with Small Model. Results live in `metadata.openchamber.assist` with
`recap`, `suggestion`, `forMessageID`, and `generatedAt`. The payload shape is
unchanged; an empty suggestion is a successful outcome.

## Ownership

- `runtime.ts` owns idle timers, cancellation, provider selection, SDK reads,
  freshness checks, settings gates, and metadata writes.
- `context.ts` reads bounded history and constructs human turns. It removes
  tool payloads and injected prompts before retaining message text.
- `activity.ts` reduces tool parts to the short record of what ran in a turn:
  names and outcomes, never outputs.
- `prompt.ts` owns the generation instructions and total input budget.
- `../small-model/DOCUMENTATION.md` owns provider/auth resolution, generation,
  output limits, and overflow behavior.

## What the model receives

Read backward through the official SDK in newest-first pages of 50 messages
(`{ data, cursor }`) until three human turns are covered, history ends, or eight
pages have been read. A failed page or repeated cursor aborts generation; it is
not treated as complete history. `loadAssistContext` throws for a failed or
stalled read and returns `null` when the bounded history holds no eligible final
answer; both skip generation and write nothing. At the page limit, use fewer
available human turns. If the latest answer's human request has not been found,
skip generation rather than invent its context.

Three turns retain the substance behind short commit confirmations without
bringing an entire old task back into the prompt. This was compared against
one, five, ten, and full-history contexts on long maintainer sessions. There
is no full-history cache and no assumed provider prefix-cache behavior.

The latest content record must be a completed, successful, non-summary
assistant answer with visible text. OpenCode closes every turn with an `idle`
record and appends agent/model/location switches as records of their own;
`newestContentId` looks past those, both here and in the re-check before the
write, so an ordinary v2 transcript still ends in its answer. An `idle` whose
outcome is `failed` or `interrupted` is not skipped: it disqualifies the turn.
Child, archived, and reverted sessions are skipped. A new prompt clears the
revert boundary before its next idle event.

A v2 message carries no `parentID`: a turn is positional, the run of records
between one user message and the assistant reply that follows it. A user message
carries a single `text` plus its attachments, an assistant message a `content[]`
array, and attached context arrives as its own `synthetic` message that folds
into the user message after it. Tool payloads never enter this view; only
the record below does. OpenCode inserts synthetic continuation users during compaction, and those stay within
their human turn; compaction summaries are excluded. An interrupted request
remains context with its last visible progress explicitly labeled as unfinished,
rather than being dropped or called a final answer.

`snapshotFiles` lists the files OpenCode saw change during an assistant step, or
is null when it took no snapshot (snapshots off, not a git folder). Every step of
the turn contributes, and the folder is shared, so another session's edits can
appear in it.

### The record of what ran

Each turn in the prompt ends with a record read from its tool parts: names of
changed files, shell commands with their outcome, subagent descriptions with
their outcome, and counts of other tools, newest first, with counts that
include a failure ahead of the rest. A turn without tool calls says `none`. A
background shell or subagent starts as "started in background" and takes the
outcome of its background-result message when that arrives. The record never
holds tool output, error text, file contents, or a command as typed: a command
keeps its program, one lowercase subcommand, script file or bare flag, the
script name after `run`, and a redirect target. A heredoc body is skipped only
in one plain form: a quoted delimiter, no quoting or comment before it and an
exact closing line. Anything after another heredoc, a command substitution or
syntax the reader cannot parse is dropped, and exit 0 then reads "whole script
exit 0, not all steps shown". Exit 0 of a chain not joined by `&&` alone reads
"last step ok", so `test | tail` never counts as passing tests; one that uses
`&` or `||`, or whose last step is not shown, reads "result unknown". A failed
chain reads "a step failed", since the step is not known. Each list has its own
character limit, so a turn adds at most about 500 characters. A file counts as
changed when its call completed or kept the file's diff after failing. A job's
notice settles only a run still marked as started, so a subagent follow-up
leaves earlier rounds alone.

When the prompt has to shrink, the record drops whole entries and counts them
("+3 more"), because a cut through an entry could lose its outcome.

### Attached context and language

The persisted attachment contract is owned by
`packages/ui/src/lib/messages/contextParts.ts`. Its user-facing Markdown
formatter is `packages/ui/src/lib/messages/messageMarkdown.ts`.

The server projects those persisted parts into model context without importing
the UI runtime: code comments, file/chat quotes, browser annotations, PR comments,
checks, terminal selections, and linked repository and tracker items remain attached to
the user turn even when their transport part is synthetic. The OpenCode
`opencodeComment` mirror is also accepted. Unrecognized synthetic prompts and
ignored parts are excluded. Malformed attached text fails the generation.
Older messages still carry the legacy kinds `github-issue`, `github-pr`, and
`linear-issue`, which are accepted alongside the current `repository-issue`,
`repository-discussion`, `change-request`, and `tracker-item`. A legacy
`<terminal_context>` block at the end of a user message counts as quoted source
for language selection.

Quoted material and the user's own comment are separate blocks. The user's
authored text is also supplied separately for language selection. Quoted source,
logs, assistant replies, and injected memory instructions do not choose the
language. A language-neutral final acknowledgment can use recent authored text.
The existing Cyrillic/CJK mismatch guard uses that authored sample per field;
it is not a complete language detector, and it is skipped if no sample exists.

### Input bounds

User text is bounded to 8,000 characters and each assistant answer to 16,000.
Attached quote bodies have their own 4,000-character limit so a large quote
does not consume the user's comment. Excerpts preserve both ends with an
explicit omission marker, including the conclusion of a long final report.

The complete user prompt is limited to 32,000 characters and the resolved small
model's input allowance, reserving space for the system prompt. Under pressure,
drop older whole turns first. If the latest pair itself is too large, excerpt
both its user request and answer rather than discarding either side. If even
the minimum prompt cannot fit, skip generation. `onOverflow: 'error'` prevents
the Small Model service from silently cutting off the instructions. Expected
context/output-budget failures are quiet and do not write metadata.

OpenCode message pages still contain complete tool payloads on the wire. A
single long turn can therefore require substantial I/O even though its retained
model context is small. Page/count bounds are not a network-byte quota.

## Generation and lifecycle

1. The server's existing global event fan-out calls `processPayload`. At an
   idle event the runtime first asks the injected `evaluateTurn` (the
   session-work runtime, `../session-work/DOCUMENTATION.md`): one Jev call says
   which enabled fields are worth the Small Model. It then arms the 60-second
   quiet window for those fields only, and arms nothing when Jev ruled both out.
   An unknown answer (no Jev, a failure) keeps every enabled field, so without
   Jev nothing changes. A newer event drops a pending answer. A session that
   `../session-lineage.js` knows to be a subsession arms nothing at all: no
   gate, no timer, no read. No history scan or
   startup backfill runs.
2. Busy/retry events and newly created user messages clear pending work and
   abort in-flight reads/generation. Re-emitted old user updates do not cancel it.
3. One generation runs per session. If a newer quiet window expires while an
   old canceled request is still settling, retain that pending run and start it
   after the old one finishes. Later activity cancels the pending run as well.
4. Resolve the small model using the last answer's provider/model and the
   existing explicit settings/config overrides. Naming that provider prevents
   an implicit cross-provider fallback. Production does not pin the
   experimental model. Generation accepts an abort signal and a 120-second limit.
   When that resolves to the session's own model on a local endpoint
   (`localEndpoint`), skip generation, whether it came from the fallback or
   from an explicit Small Model naming the same model: llama.cpp-style
   servers keep one prompt cache per slot, so a side request evicts the
   session's cache and the next turn reprocesses the whole history (#3871).
   A different model on the same machine, configured or found by the family
   scan, is still used. The skip writes one `[session-assist] skipped` line per
   provider/model pair: a loopback OpenAI-compatible proxy (CLIProxyAPI,
   LiteLLM, one-api) that forwards to a hosted vendor is indistinguishable from
   a local inference server by hostname alone, and the log line is the only
   thing that tells an operator why an enabled toggle produced nothing (#6173).
5. Recap describes the substantive work and its current result, including the
   work behind a closing commit or acknowledgment. Suggestion is independent:
   only unfinished requested agent work should produce a sendable user message.
   Completed work, optional offers, or a decision/action belonging to the user
   should return an empty suggestion. This is model judgment, not authorization
   enforcement or a guarantee that every generated field is factually correct.
6. Re-read the latest message and fresh session before writing. A moved tail,
   canceled run, changed endpoint/directory, archive, revert, or failed fresh
   read discards the result. Never merge from the old pre-generation metadata.
7. Re-check settings, clamp the enabled fields, and merge into fresh metadata.
   The OpenCode update endpoint has no compare-and-set operation; another
   writer after the final read is not guarded atomically.

`onPendingChange` reports when a session starts waiting for its assist (the
turn end, unless the recap and the suggestion are both off) and when the wait
ends: written, ruled out by the turn-end check, failed, or dropped by a new
turn. `index.js` broadcasts it as `openchamber:session-assist` with the
session's directory, and clients keep a chat's OpenCode location until the
wait ends, because these reads would start a stopped directory again.

Stopping the runtime clears pending timers/runs and aborts in-flight operations.
No failed session blocks another session. A generation failure is logged with
its cause (status, code, bounded message) so a cold-start 503 can be told from
a permanent provider rejection; the two are retried differently upstream, and a
bare "generation failed" hid which one happened. The small-model service
rethrows raw SDK rejections, which are tagged objects rather than Errors, so the
line reads `code`, `message`, and `_tag` from either shape. 404 and the expected
context/output-budget codes stay quiet, and no failure retries here: this layer
makes one attempt, and the small-model service owns the bounded backoff it
runs while a cold catalog has not published the model yet.

## Decisions

### Why a record of what ran and not the tool output

With answer text alone, a turn whose answer could not summarize its work reads
as a turn that did nothing, and the suggestion asked to do the work again
(#5702). Tool output would settle it at many times the cost. The record adds
about 200 tokens to a typical recap. Wording alone could not fix it: without the
record the model can only withhold the claim, and it cannot tell a turn that
failed or did nothing from one that worked.

The record comes after the answer. Placed before it, one of the measured models
still repeated the answer's "could not be confirmed".

### Why not the snapshot's files

`snapshotFiles` covers a shared folder, so another session's edits would be
reported as this turn's work. Files come from the turn's own calls.

### Why malformed attachment text still fails the context read

`attachedText` reads `metadata.openchamberContext` and `metadata.opencodeComment`
from SDK message records. Their values stay JSON until read. Nullish optional
fields default to empty text; a non-string field where trimming is required
throws `TypeError`, preserving the failed read rather than building a recap
from incomplete context.

`answeredBy` in `../routing/history.ts` accepts present `undefined` provider and
model properties, matching the objects returned by `context.ts`.
`Array.prototype.findLast` is supported by the shared check's ES2023 declarations.

### Why runtime inputs keep field checks

Translated events supply the event envelope; status and message fields remain
unchecked until the runtime reads them. Generation JSON and rejection fields
also remain unchecked. Object checks accept arrays where the existing event
reader accepts them. Rejection-field access excludes only null and undefined,
so primitive rejections and inherited fields retain their existing behavior.
The shared primitive-string predicate establishes rejection text before trimming.

Settings come from the merged settings reader and disable each target only for
literal `false`. The environment selects the settings path. SDK session and
message reads, Small Model resolution and generation, and injected metadata
writes retain their owning contracts. A missing metadata writer parks the
runtime; a missing turn evaluator keeps all fields eligible. Pending directory
lookups can return undefined and preserve that value in announcements and stale
assist retirement.

Model prose can surround generated JSON, so extraction scans earlier closing
braces after a parse failure. Directory headers remain percent-encoded because
OpenCode scopes sessions by `x-opencode-directory` and rejects non-ASCII headers.

### Why the metadata write is an injected seam and not an OpenCode route

OpenCode 2.x accepts session metadata only when a session is created, so no
route stores `metadata.openchamber.assist` afterwards. `persistSessionAssist`
write the recap and suggestion into OpenChamber's own session metadata store.
Without that function the runtime arms nothing and generates nothing; it never
spends a model call on text it cannot save.

### Why archive state is asked for instead of read from the record

In v2 archive state is OpenChamber's own and no OpenCode route sets it, so the
runtime calls `isSessionArchived` rather than reading `time.archived` off the
session record. That check is an awaited wait of its own, so the run checks
again for a cancel after it and before the write.

## Settings and consumers

`sessionRecapEnabled` and `sessionSuggestionEnabled` default on and are checked
before work and before writing. The Jev gate is a cost filter under these same
switches, not a setting of its own: it reads the same three turns as the recap,
so a recap still follows a closing "thanks" after real work. With both off there are no reads, model calls,
or writes. With one on, the shared recent context is still available, but only
that field is requested. An empty suggestion does not erase a valid recap.

Freshness has one rule, `getCurrentSessionAssist` in
`packages/ui/src/lib/sessionAssistMetadata.ts`, computed from the session
record alone so the chat and the sidebar row always agree: the payload is
current while `generatedAt >= session.time.idle` and the session is not
reverted. OpenCode moves `time.idle` at every turn end, succeeded or failed.
Do not compare `forMessageID` with the last loaded message: in v2 the newest
record is the turn's `idle` marker or a switch record, never the answer.
When a session turns busy, the runtime also deletes the assist it wrote
(`persistSessionAssist(id, dir, null)`), so stored state goes stale only for
payloads written by an earlier process; the `time.idle` rule retires those.

- `packages/ui/src/lib/sessionAssistMetadata.ts` parses the payload and owns freshness.
- `packages/ui/src/hooks/useSessionAssist.ts` adds live-status and settings gating.
- `SessionRecapSpacer` shows the reminder in the reserved gap under the reply.
- `SessionSuggestionChip` fills the composer; it never sends automatically.
- Sidebar rows (`SessionNodeItem`, Projects view) show the current recap in
  the whole-row tooltip under the same freshness rule, hidden while a turn runs
  and when `sessionRecapEnabled` is off. The sidebar no longer marks open
  suggestions; the "In work" block is the sidebar's attention signal.

Web, Electron, hosted mobile, and Capacitor use the server watcher. VS Code's
extension-only runtime does not generate assists; shared UI can render payloads
produced by a server. The background watcher cannot use the browser's message
store when the UI is closed. Manual AI rename uses that store through
`SessionMessageLoader`; these are intentionally different retrieval lifecycles.
