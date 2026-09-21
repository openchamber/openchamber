# Session assist

The server generates a short reminder of recent work and an optional next user
message with Small Model. Results live in `metadata.openchamber.assist` with
`recap`, `suggestion`, `forMessageID`, and `generatedAt`. The payload shape is
unchanged; an empty suggestion is a successful outcome.

## Ownership

- `runtime.js` owns idle timers, cancellation, provider selection, SDK reads,
  freshness checks, settings gates, and metadata writes.
- `context.js` reads bounded history and constructs human turns. It removes
  tool payloads and injected prompts before retaining message text.
- `prompt.js` owns the generation instructions and total input budget.
- `../small-model/DOCUMENTATION.md` owns provider/auth resolution, generation,
  output limits, and overflow behavior.

## What the model receives

Read backward through the official SDK in pages of 50 messages until three
human turns are covered, history ends, or eight pages have been read. A failed
page or repeated cursor aborts generation; it is not treated as complete history.
At the page limit, use fewer available human turns. If the latest answer's human
request has not been found, skip generation rather than invent its context.

Three turns retain the substance behind short commit confirmations without
bringing an entire old task back into the prompt. This was compared against
one, five, ten, and full-history contexts on long maintainer sessions. There
is no full-history cache and no assumed provider prefix-cache behavior.

The latest record must be a completed, successful, non-summary assistant answer
with visible text. Child, archived, and reverted sessions are skipped. A new
prompt clears the revert boundary before its next idle event.

Human turns follow chronological message intervals. OpenCode can insert
synthetic continuation users during compaction, so a final answer's `parentID`
need not point directly at the original human request. These continuations stay
within their human turn; compaction summaries are excluded. An interrupted
request remains context with its last visible progress explicitly labeled as
unfinished, rather than being dropped or called a final answer.
An answer must still reference that human user or one of its continuation
users; a late answer for an older request cannot be assigned to a newer request.

### Attached context and language

The persisted attachment contract is owned by
`packages/ui/src/lib/messages/contextParts.ts`. Its user-facing Markdown
formatter is `packages/ui/src/lib/messages/messageMarkdown.ts`.

The server projects those persisted parts into model context without importing
the UI runtime: code comments, file/chat quotes, browser annotations, PR comments,
checks, terminal selections, and linked GitHub/Linear items remain attached to
the user turn even when their transport part is synthetic. The OpenCode
`opencodeComment` mirror is also accepted. Unrecognized synthetic prompts and
ignored parts are excluded. Malformed attached text fails the generation.

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

1. The server's existing global event fan-out calls `processPayload`. An idle
   event arms the 60-second quiet window. No history scan or startup backfill runs.
2. Busy/retry events and newly created user messages clear pending work and
   abort in-flight reads/generation. Re-emitted old user updates do not cancel it.
3. One generation runs per session. If a newer quiet window expires while an
   old canceled request is still settling, retain that pending run and start it
   after the old one finishes. Later activity cancels the pending run as well.
4. Resolve the small model using the last answer's provider/model and the
   existing explicit settings/config overrides. `restrictToPreferredProvider`
   prevents an implicit cross-provider fallback. Production does not pin the
   experimental model. Generation accepts an abort signal and a 120-second limit.
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

Stopping the runtime clears pending timers/runs and aborts in-flight operations.
No failed session blocks another session.

## Settings and consumers

`sessionRecapEnabled` and `sessionSuggestionEnabled` default on and are checked
before work and before writing. With both off there are no reads, model calls,
or writes. With one on, the shared recent context is still available, but only
that field is requested. An empty suggestion does not erase a valid recap.

Clients render an assist only while its `forMessageID` is the last message and
the session is idle. A new message invalidates it without clearing writes.

- `packages/ui/src/lib/sessionAssistMetadata.ts` parses the payload.
- `packages/ui/src/hooks/useSessionAssist.ts` owns freshness/settings gating.
- `SessionRecapSpacer` shows the reminder in the reserved gap under the reply.
- `SessionSuggestionChip` fills the composer; it never sends automatically.

Web, Electron, hosted mobile, and Capacitor use the server watcher. VS Code's
extension-only runtime does not generate assists; shared UI can render payloads
produced by a server. The background watcher cannot use the browser's message
store when the UI is closed. Manual AI rename uses that store through
`SessionMessageLoader`; these are intentionally different retrieval lifecycles.
