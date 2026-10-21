# Session export

The export of a session and the sub-agent sessions below it, in Markdown, HTML
and JSON.

## Ownership

This module owns the whole export: which sessions it covers, how their
records become one sequence, how a sub-agent call is joined to the child
session it started, and what each format writes.

`../exportSession.ts` owns the parts that touch the platform — the download,
the desktop save dialog, the file name — and the API the rest of the app
calls. `components/session/export/` owns the dialog and the writing of the
file, so the Header and the Sidebar produce the same document.

The sub-agent's own helpers stay where they are: `lib/opencode/subagent-run.ts`
reads a reported run, `lib/opencode/tools.ts` reads a call's metadata, and
`components/chat/message/parts/taskToolModel.ts` reads the legacy output
envelope. This module uses them; it does not reimplement them.

The document's own text lives in `../i18n/messages/export-document.i18n.ts`
and is read through `i18n.ts`, so the exported file speaks the reader's
language like the app around it.

## Invariants

- **One pipeline, three formats.** The Markdown, HTML and JSON renderers read
  the same event model. They cannot disagree about what happened.
- **One lineage walk.** The dialog's count of sub-agent tasks and the
  export's list of descendants come from `collect.ts`. The number the user is
  shown and the number the document carries are one.
- **No invented chronology.** Events are ordered by their recorded timestamp.
  An event without one keeps the place the source gave it, and the source
  order breaks ties. The export never guesses an order.
- **No invented relationships.** A call is joined to a child session through a
  recorded identity — the call's metadata, its output envelope, the report the
  runtime appended, the session's own parent link. Position in a list is
  never used: two sub-agents can start at the same moment.
- **Compact never means lost.** The readable view cuts a long tool result
  down and marks the cut. The JSON export carries every source record, so
  nothing is gone.
- **A partial export says so.** Everything the export could not establish —
  a child that would not load, a call that named no child, a session that was
  resumed, a part the model does not cover — lands in `findings`, and the
  readable document reports them once at the end. A child that would not load
  also becomes a `gap` event, so the hole is visible where the sub-agent's
  work would have been. An ordinary message never carries a diagnostic line.
- **Deterministic.** The same source snapshot produces the same document.
- **Bounded work.** The descendants are loaded in waves, and the lineage walk
  stops at a session it has already visited, so a cyclic lineage ends the
  walk instead of looping.

## Decisions

### Why the events are normalized before they are rendered

The three formats answer different questions: a person wants to read a
conversation, a browser wants to filter one, a tool wants to verify one. The
questions differ, the history does not.

Normalizing first (this module's `events.ts`, `normalize.ts` and `order.ts`)
means the history is resolved once. A second format is a second renderer over
the same events, not a second implementation of the sub-agent linking and the
chronology. The rejected alternative was one renderer per format, which is
what the issue calls a competing export pipeline.

### Why a sub-agent's block sits where its call sat

The old export appended the child transcripts at the end of the document. A
reader had to hold the parent's story in their head and then read the
sub-agents separately, and could not tell which call each block belonged to.

The block is anchored at the call that started it, and the block's header
carries the task and the agent. The rejected alternative was a strictly
timestamp-sorted log: with hundreds of tool calls it reads as a log, not as a
conversation, and it loses the thread of who was doing what.

### Why the concurrency is marked instead of serialized

Two sub-agents that ran at the same time are shown at the same time. The
block says which other work overlapped it, and the two blocks keep their own
times. The rejected alternative was picking one order and hiding the overlap,
which would tell the reader a sequence the runtime never recorded.

### Why the JSON export keeps the source records next to the derived events

`source` holds the records as the runtime wrote them; `events` holds what
the pipeline derived from them. A reader can rebuild the conversation from
the export, or check the readable view against the original.

A part the pipeline does not know is still in `source`. The rejected
alternative was projecting every part into the event model, which would have
meant guessing at parts the model does not cover and would have made the
event model a lossy copy of the source.

### Why the JSON export sorts its events and the readable view does not

The JSON export promises a chronology: its schema says the events are
ordered by their recorded timestamp, and a tool that verifies an export
needs that promise to hold. The pipeline collects the events session by
session, so the raw list is grouped by session; the JSON renderer sorts it
by `(timestamp, source order, session id)` before writing.

The readable view keeps the conversation's own shape instead: a sub-agent's
transcript is a block placed where its call sat, not a row among the
orchestrator's messages. Sorting it by time would turn it into a log. The
two views answer different questions, and the JSON export's ordering
guarantee is the one a downstream tool can check.

### Why the export is one pipeline the UI drives, not a library the UI copies

The Header and the Sidebar both open the same dialog and call the same
function, so the document they produce is the same document. The UI hands
the pipeline the session list and a loader; the pipeline loads the
descendants in waves and joins a call to the child session it started.

The rejected alternative was a second collector in the UI that loaded the
descendants itself. It had the same wave size as the pipeline's, so the
bounded work existed in two places and could drift apart — and the
descendant count the dialog showed came from a third place again.
