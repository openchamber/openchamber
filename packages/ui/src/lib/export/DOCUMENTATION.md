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
prompt, the runtime's own cut of a result — so the Markdown and the HTML
cannot name them differently.

## Invariants

- **One pipeline, three formats.** The Markdown, HTML and JSON renderers read
  the same event model. They cannot disagree about what happened.
- **One lineage walk.** The dialog's count of sub-agent sessions and the
  export's list of descendants come from the same walk: the tree the app
  shows, which is the live sessions the list attaches to the exported one.
  The number the user is shown and the number the document carries are one.
  The count is only made from a complete session list: the list arrives in
  pages, and a count taken from a partial one would name a number the
  document does not carry. The walk is read at one moment, so a session the
  app attaches after the count is in the document and not in the number.
  While the list is still being read the count is unknown, and the dialog
  says so. The switch stays: the choice is the reader's, and it has to stay
  reachable when the number is not known. The text says what the choice will
  do, so the promise and the export agree.
- **Every session is read from its own directory.** A descendant that runs in
  another directory lives in another session store, so the root's directory
  would never find it. The export reads each session where it runs, and a
  session it cannot read is a gap the document reports where the sub-agent's
  work would have been.
- **The document carries what the user asked for.** The coverage choice
  reaches the collector, not a filter over a loaded history: a user who left
  the sub-agent transcripts out gets a document without them, and without a
  notice that they were left out. The calls that started them stay, because
  they belong to the root session's own history. The choice belongs to the
  session too: the dialog keeps it per session, so a second export of the
  same session keeps it, and the choice made for one session does not reach
  another one.
- **No invented chronology.** Inside a session's own sequence, events are
  ordered by their recorded timestamp. An event without one keeps the place
  the source gave it, and the source order breaks ties. The export never
  guesses an order.
- **One order for every event.** Every event carries its place on one scale:
  the record's own place, and the part's place inside it. A record's place is
  as wide as the record needs, so the number of parts a record holds never
  decides the order of the records after it. A record without parts and a
  record with parts therefore keep the order the source gave them, and a
  message and a tool call of the same record keep the order the source gave
  them.
- **A message sits where its own parts are.** A record's parts become events
  at the places they held inside it. A tool call and a reasoning part are
  events of their own, and the parts between them are the message the record
  said in that stretch, glued the way the readable view shows a message. The
  text the source wrote before a tool call stays before it.
- **No invented relationships.** A call is joined to a child session through a
  recorded identity — the call's metadata, its output envelope, the report the
  runtime appended, the session's own parent link. A report is a line of
  relationship like a call: a child the parent names only by a report is a
  child the export read and shows, so the export says nothing about it.
  Position in a list is never used: two sub-agents can start at the same
  moment.
- **The sub-agent's work sits where it was delegated.** A nested block takes
  the place of the call that started it, in the parent's own sequence. A
  parent that delegated work and then answered keeps the answer after the
  work it depends on.
- **The document names the agent, not a role.** The root's own messages carry
  the agent that wrote them, and a sub-agent's block carries the sub-agent's
  name. The agent has a name in the history, and a role of the export's own
  would be a claim the history does not support. A session that recorded no
  agent gets a neutral label, never an invented one. A message carries the
  name of the agent that wrote it, wherever it is: a session that switched
  agents is not signed with one name throughout, and the session's own agent
  is the fallback. Inside a sub-agent's block the block's own name stays the
  session's — that is the identity of the block, not the authorship of a
  message.
- **One name for one agent.** The label in the document and the value in the
  HTML filter come from the same name, so a reader who filters by an agent
  finds the entries the document shows under that name.
- **A match stays on the page.** The HTML page's search hides the entries that
  do not match, and a block that holds nothing else. A match inside a nested
  block keeps that block and every block above it, so the count the page
  reports counts matches the reader can see. The search index holds the text
  the page shows: a long prompt and a long sub-agent result are cut in the
  readable view, and the index holds those cuts, so a search does not find a
  word the reader cannot read. The reasoning the readable view does not draw
  is not in the index at all.
- **Compact never means lost.** The readable view cuts a long tool result
  down and marks the cut. The mark says where the whole result is: the
  export of this session with full details, which carries the recorded
  result as it is. A sub-agent's result is cut the same way and marked the
  same way. The JSON export carries every source record, so nothing
  is gone. The cut is the same in every format: a long prompt and a long
  sub-agent result read the same in the Markdown and in the HTML.
- **The detailed view carries what was recorded.** It cuts nothing of its
  own: a tool result is written as the history recorded it. The runtime cuts
  a long result itself and keeps the prefix, so the document says so where
  the reader looks at the output, and names the file the runtime wrote the
  rest to. That is a property of the record, not something the export could
  not establish, so it does not belong in the findings at the end.
- **A partial export says so.** Everything the export could not establish —
  a child that would not load, a call that named no child, a session that was
  resumed, a part the model does not cover — lands in `findings`, and the
  readable document reports them once at the end. A child that would not load
  also becomes a `gap` event, so the hole is visible where the sub-agent's
  work would have been. An ordinary message never carries a diagnostic line.
  A child the user left out on purpose is not a gap: the export knows it was
  left out.
- **A session cut out of the tree is named, not reported.** An archived
  session is not attached to the session you exported, so the export does not
  carry it. The document says that once, as a fact under the header: the
  transcript is not part of the export because the session is not carried
  along, and not because something was lost. The call that started it stays,
  because it belongs to the root session's own history, and the document
  never says the child was not tied to that call. A session that is not there
  at all, and a session whose history could not be read, are still reported:
  the export could not establish those.
- **The export speaks the reader's language.** A finding carries the key of
  its text and the values that text names; the export resolves the text when
  it builds the document — the projection and the render read the dictionary
  then, not when the module is loaded. The JSON export carries the resolved
  text beside the key, so a tool that reads it gets a sentence. The HTML
  page declares that language in its `lang` attribute, so a screen reader
  reads the text in the voice of the language the page names.
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

### Why a message sits at the first of its own parts

A record's text lives in its text parts, and the readable view shows a
message as one piece of text. The export keeps both: the parts that have an
event of their own — a tool call, a reasoning — are events of their own, and
the parts between them are the message the record said in that stretch.

The rejected alternative was to glue a whole record's text into one event and
place it at the last text part. A record that said one thing, called a tool
and said another thing would then read as the call first and the text after
it, and the text the source wrote before the call would move behind it. The
rejected alternative on the other side — one event per text part — would
break a message that was written in one go into pieces the reader has to put
back together. A stretch of parts is the unit that satisfies both.

### Why a record's place is as wide as the record needs

The source order is one number, so the places of the records are counted one
after another: every record takes a place of its own, and the parts inside it
follow, one place apart. A record's place is as wide as the record needs — one
place for the record and one for each of its parts — and a thousand wide at
the least, so the numbers of an ordinary export stay the ones they have
always been.

The rejected alternative was a fixed scale: the record's place times a
thousand, plus the part's place inside it. A record with a thousand parts or
more then filled the place of the record after it, and a record with more
parts than that reached past it, so the record that was written later was
read before the parts that came before it. The rejected alternative on the
other side — a place per part and nothing besides — renumbered every export,
and two sessions whose events share a recorded time could change their
interleaving, so a document came out with other numbers in it and in another
order.

### Why the detailed view has no cut of its own

The runtime truncates a long tool result itself — two thousand lines, or fifty
kilobytes — and writes the rest to a file, keeping the prefix in the record.
A cut of the export's own could therefore only ever lose what the runtime
kept, and the promise of a full result would be the export's instead of the
runtime's.

The rejected alternative was to cut the detailed view at two hundred thousand
characters and point at the JSON export. At the standard configuration the
runtime never lets a result grow that long, so the cut never happened: the
promise was about a case that could not arrive, and it hid the case that
does — the runtime's own cut. The detailed view now carries the recorded
result, and the document says where the runtime put the rest.

### Why the readable view's cut points at the full-details export

The readable view cuts a long tool result down, and the mark under the cut
says where the whole result is: the export of this session with full
details. That is the same document in the other view, and it carries the
recorded result as it is.

A sub-agent's result is cut the same way, so the mark is the same one: the
reader of a sub-agent's result is told what the reader of a tool result is
told. The cut belongs to the projection, which decides how much of each
event reaches the page, so the Markdown and the HTML show the same excerpt
and the page's search index holds the same text the page shows.

The rejected alternative was to point at the JSON export. The app writes one
file, in the format the reader chose, so a reader of the Markdown file has
no JSON file next to it, and the pointer led nowhere.

### Why a report is a line of relationship like a call

A report is a recorded identity: it names the session the work happened in,
and it sits in the parent's own history. A child the parent names only by a
report is a child the export read, shows as a block, and can place — the
report says which session it is about.

The rejected alternative was to read a report only as a result to print. The
export would then claim that a child it had just shown could not be tied to
the history, and a complete export would carry the "Incomplete export"
notice over a transcript that was there. The rejected alternative on the other
side — treating every report as a call — would put a call where the history
recorded a report, and a child would be anchored at a call that never
happened. A report establishes the relationship and nothing more.

### Why the coverage choice reaches the collector

The user chooses whether the sub-agent transcripts are part of the export.
That choice is the collector's business: a user who left the transcripts out
gets a document without them, and the history of a child is not even read.

The rejected alternative was to load the whole lineage and drop the excluded
sessions afterwards. The document would look right, but the export would have
read every child's history to throw it away, and the count of sessions in the
document would have to be kept in step with the choice by hand. The coverage
is one decision, and it is made once, where the sessions are gathered.

### Why the export carries the sessions the app attaches

The app knows which sessions belong to a session: the ones whose parent it
is, and their own children in turn. That is the tree the sidebar shows, and
the export carries the same tree — the same sessions, with the same
transcripts, in the same place.

A session the app does not attach is not a sub-agent session of this one. A
dispatched session is the clearest case: the app creates it without a parent
and shows its result inside the dispatching session's transcript, as a
notice, not as a nested session with a transcript of its own. The export
carries that result the same way. The rejected alternative was to look for
children in the records as well: a record names the session a call started,
so the export could load it and show a transcript the app never shows. The
records would then be a second source of truth about what belongs to the
session, and the two would disagree — the export would carry a session the
sidebar does not, and the count on the dialog would not name it.

A child the app attaches and the records do not name is still carried: the
app shows it, so the export does too. What the records say about it is a
question of relationship, not of membership, and the report the runtime
appended answers it.

An archived session is not attached to anything: the app cuts it out of the
tree, at every depth, so a child below an archived session is out of the tree
too. The export cuts it the same way, and does not even read its history. The
rejected alternative was to carry the archived child: the document would then
hold a transcript the app shows nowhere, and the number on the dialog would
name a session the document's tree does not have.

The session the reader asked for is the exception. They export it on purpose,
from the archive bin, so it is carried even when it is archived — and the
live work below it travels with it.

### Why an archived child is named once, and not reported as a gap

An archived child is cut out of the tree the app shows, so the export does
not carry its transcript. The document says that once, as a fact under the
header, and names the session it is about. The call that started the child
stays, because it belongs to the root session's own history, and the reader
can see it there.

The rejected alternative was to report the missing transcript as a finding.
The document would then carry an "Incomplete export" notice over an export
that is complete against the tree the app shows, and it would claim that the
child was not tied to a call while the call sat right above the notice. The
rejected alternative on the other side — saying nothing at all — would leave
a reader who looks for the transcript of a call they can see without an
answer, and the export knew the answer.

The rejected alternative was a note next to every call that names such a
child. The document's rule is that an ordinary message never carries a
diagnostic line, and a document with one note per call reads like a log of
what went wrong. The note belongs to the document, once, where the reader
learns what the export covers.

The JSON export carries the same fact in a field of its own, next to the
findings and not among them: a tool that reads the export sees which
sessions were left out and why.

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

The spans are half-open: a call that ends at the moment the next one starts
ran after it, not beside it. Two calls that only touch are sequential, and
the runtime never recorded them as running together. The rejected
alternative was the closed interval, which marked such a pair as parallel
and invented an overlap the runtime did not record.

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

A message carries the name of the agent that wrote it, and the session's own
agent is the fallback. The rule is the same everywhere: a message inside a
sub-agent's block is signed with the agent that wrote it, and the sub-agent
session's own name is the fallback there as well. The rejected alternative
was to sign every message of a session with the session's agent: a session
that switched agents would then carry one name over work another agent did,
which is the claim the history cannot back. The rejected alternative on the
other side — showing no name at all when the session recorded none — would
lose the name the messages themselves carry.

The block's own header keeps the session's name in every case. The rejected
alternative was to sign the block with the name of the last message in it:
the block is the identity of the session's work, and a name that changed
under the reader's feet would say that two sessions were one.

### Why the JSON export keeps the source records next to the derived events

`source` holds the records as the runtime wrote them; `events` holds what
the pipeline derived from them. A reader can rebuild the conversation from
the export, or check the readable view against the original.

A part the pipeline does not know is still in `source`. It reaches neither
view of the document: a message is rendered from its text and its files, and
a part of an unknown type is neither. The finding says so, and it names
`source` as the place the part survives. The rejected alternative was
projecting every part into the event model, which would have meant guessing
at parts the model does not cover and would have made the event model a
lossy copy of the source.

### Why the JSON export sorts its events and the readable view does not

The JSON export promises a chronology: its schema says the events are
ordered by their recorded timestamp, and a tool that verifies an export
needs that promise to hold. The pipeline collects the events session by
session, so the raw list is grouped by session, and the JSON renderer sorts
it before writing: by the timestamp, then by the order the source recorded
the event, then by the session it belongs to. The file holds one timeline,
so the events of two sessions interleave.

The readable view keeps the conversation's own shape instead: a sub-agent's
transcript is a block placed where its call sat, not a row among the
orchestrator's messages. Sorting it by time would turn it into a log. The
two views answer different questions, and the JSON export's ordering
guarantee is the one a downstream tool can check.

The readable document says the same about itself, in its own words: a
sub-agent's block sits where the call that started it sits, and inside a
block the events are the ones the source recorded. It promises no
chronology, because the document has none: a block's own events can be
later than the messages the block stands in front of.

### Why the export is one pipeline the UI drives, not a library the UI copies

The Header and the Sidebar both open the same dialog and call the same
function, so the document they produce is the same document. The UI hands
the pipeline the session list and a loader; the pipeline loads the
descendants in waves and joins a call to the child session it started.

The rejected alternative was a second collector in the UI that loaded the
descendants itself. It had the same wave size as the pipeline's, so the
bounded work existed in two places and could drift apart — and the
descendant count the dialog showed came from a third place again.

The dialog's count comes from the app's tree, the same tree the export
covers, so the number the user is shown and the number the document carries
are one. The count is read at one moment, so a session the app attaches
after the count is in the document and not in the number — the count is what
the export could cover when the dialog was opened. The rejected alternative
was to count the export's own walk: it would have loaded every record of
every descendant to name a number the app already knows, and a number read
later could land on a dialog that has moved on.

### Why a field that holds no text costs no error

A tool call's arguments are whatever the model and the tool produced, and the
export reads a handful of fields of every call to find the file it touched or
the command it ran. Most of the fields it probes are not there: a shell call
names a command and no file, a read call names a path and no command.

The schema the export reads a text field with ends in `catch`, so a field that
holds no text comes back as no field rather than as a failure. The rejected
alternative was a schema that fails, and it built an error object for every
field that was not there, only to throw it away. Building those errors was
most of what the projection spent: at 3000 tool calls the projection took
about 200 ms, and the errors for the fields that were not there were the bulk
of it.
