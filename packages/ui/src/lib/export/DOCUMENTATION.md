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
language like the app around it. `labels.ts` holds the names the document
gives things — the agent, the role, the overlapping work, the cut of a long
prompt — so the Markdown and the HTML cannot name them differently.

## Invariants

- **One pipeline, three formats.** The Markdown, HTML and JSON renderers read
  the same event model. They cannot disagree about what happened.
- **One lineage walk.** The dialog's count of sub-agent tasks and the
  export's list of descendants come from `collect.ts`. The number the user is
  shown and the number the document carries are one. The count is only made
  from a complete session list: the list arrives in pages, and a count taken
  from a partial one would name a number the document does not carry.
- **No invented chronology.** Events are ordered by their recorded timestamp.
  An event without one keeps the place the source gave it, and the source
  order breaks ties. The export never guesses an order.
- **One order for every event.** Every event carries its place on one scale:
  the record's own place, and the part's place inside it. A message and a
  tool call of the same record therefore keep the order the source gave them.
- **No invented relationships.** A call is joined to a child session through a
  recorded identity — the call's metadata, its output envelope, the report the
  runtime appended, the session's own parent link. Position in a list is
  never used: two sub-agents can start at the same moment.
- **The sub-agent's work sits where it was delegated.** A nested block takes
  the place of the call that started it, in the parent's own sequence. A
  parent that delegated work and then answered keeps the answer after the
  work it depends on.
- **The document names the agent, not a role.** The root's own messages carry
  the agent that wrote them, and a sub-agent's block carries the sub-agent's
  name. The agent has a name in the history, and a role of the export's own
  would be a claim the history does not support. A session that recorded no
  agent gets a neutral label, never an invented one.
- **One name for one agent.** The label in the document and the value in the
  HTML filter come from the same name, so a reader who filters by an agent
  finds the entries the document shows under that name.
- **Compact never means lost.** The readable view cuts a long tool result
  down and marks the cut. The JSON export carries every source record, so
  nothing is gone. The cut is the same in every format: a long prompt reads
  the same in the Markdown and in the HTML.
- **A partial export says so.** Everything the export could not establish —
  a child that would not load, a call that named no child, a session that was
  resumed, a part the model does not cover — lands in `findings`, and the
  readable document reports them once at the end. A child that would not load
  also becomes a `gap` event, so the hole is visible where the sub-agent's
  work would have been. An ordinary message never carries a diagnostic line.
  A child the user left out on purpose is not a gap: the export knows it was
  left out.
- **The export speaks the reader's language.** A finding carries the key of
  its text and the values that text names; the renderer resolves the text
  when it writes the document. The JSON export carries the resolved text
  beside the key, so a tool that reads it gets a sentence.
- **Deterministic.** The same source snapshot produces the same document.
- **Bounded work.** The descendants are loaded in waves, and the lineage walk
  stops at a session it has already visited, so a cyclic lineage ends the
  walk instead of looping. A child the session list does not name is loaded
  too, because the call that started it recorded its id.

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

A nested block is anchored the same way, inside its parent's own sequence
rather than after everything the parent said. The rejected alternative was to
keep the parent's records and the nested blocks in two lists and print the
blocks at the end: the parent's final answer would then stand before the
work it depends on, which is the mistake the old export made at the top
level.

### Why an event without a timestamp keeps the place the source gave it

The source recorded a record without a time. The export cannot say when it
happened, so it does not say: the event keeps the place its own record put
it, between the timed events around it.

The rejected alternative was to sort an untimed event to the end of the
session, which reads as a claim about when it happened. The rejected
alternative on the other side — carrying the time of the previous event
forward — was also a claim, and it moved the event away from where the source
put it. The place is derived, but it is the source's place.

### Why the pipeline loads a child the session list does not name

The session list is where the lineage lives, and it arrives in pages. A child
the list has not named yet would be left out of the export, and its
transcript would be missing for a reason that has nothing to do with the
history.

The call that started the child recorded its id, so the collector reads the
ids out of the loaded records and loads those children too. The rejected
alternative was to trust the list alone: an incomplete list would then
silently shorten the export, and the document would look complete.

### Why a finding carries a key and not a sentence

A finding is read by a person in the exported document, and the document
speaks the app's language. The pipeline records which finding it is and the
values the sentence names; the renderer resolves the text when it writes the
document.

The rejected alternative was to write the sentence where the finding is
created: the pipeline would then bake one locale's wording into a model that
every format reads, and the JSON export would carry a sentence in the
language of whoever happened to run the export last.

### Why the concurrency is marked instead of serialized

Two sub-agents that ran at the same time are shown at the same time. The
block says which other work overlapped it, and the two blocks keep their own
times. The rejected alternative was picking one order and hiding the overlap,
which would tell the reader a sequence the runtime never recorded.

The caption names the other work by its agent and by its session title. The
title alone does not tell two sub-agents apart: the runtime names a child
after the call that started it, so two children of one call carry the same
title. The rejected alternative was the title on its own, which left the
reader with a name that pointed at two different things.

### Why the document names the agent instead of a role

The root's own messages carry the name of the agent that wrote them, and the
name comes from the history: the session records the agent it ran, and the
messages record the agent that answered them. The rejected alternative was a
role of the export's own — the export used to call every root message
"Orchestrator" — which named a thing the product does not have. A reader who
knows the session knows the agent, and a word the export made up is a claim
the history cannot back.

A session that recorded no agent gets a neutral label. The rejected
alternative was inventing a name for it, which would put a claim in the
document where the history has none.

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
