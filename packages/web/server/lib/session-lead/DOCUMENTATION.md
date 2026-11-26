# Session lead

## Ownership

A lead is a session the user marked to own a direction of work
(`metadata.openchamber.lead = { at, digest? }`): it hands work to the
sessions it creates with `ownWork`, checks what comes back against the
outcome it agreed with the user, and keeps a brief and a digest. This module
owns everything that only leads have on the server: the brief file and the
copy of it the lead's context holds, the `lead.brief` and `lead.digest`
actions of the `openchamber` tool, handing a session to a lead
(`lead.handover`), the `openchamber.lead` and `openchamber.lead-brief`
instruction texts, sleep compaction, the compaction callback route, and
whether a lead's workflow runs start without approval. The UI owns the mark,
the start points, the digest row with its answers and dismissals, and the
Hand to a lead menu (`packages/ui/src/lib/sessionLead.ts`,
`packages/ui/src/sync/session-lead.ts`). Session knowledge writes the
entries (`../session-knowledge/`), the control service routes the actions
(`../openchamber-control/`), `work.name` names a lead
(`../openchamber-sessions/work-naming.js`).

## Invariants

- Only the user makes a session a lead (the session menu, or a draft opened
  with New lead). The lead actions refuse any other session with `409`, so an
  agent cannot turn itself or a child into a lead.
- A lead has no parent. OpenCode copies a parent's metadata into every child
  it creates (a subagent, for one), the lead mark and digest included, so the
  runtime's `session.created` handler clears what a new child copied from its
  parent (`inheritedFromParentPatch`, owned by `openchamber-sessions`), and the
  UI never counts a session with a parent as a lead. A fork drops the
  mark through `sourceOwnedLinksPatch`.
- The brief is one markdown file per lead in `<data-dir>/leads/<id>.md`,
  outside the repository and outside Project knowledge. It has a free part
  (goal, outcomes, rules) and, below a marker comment, one `### id` section per
  strand of work (`brief-document.ts`). `brief` replaces the free part whole and
  `edits` (`{ find, replace }`, each `find` exactly once, in order) changes it;
  `strands` sets a strand whole or closes it by id. A file without the marker is
  all free part, so a brief written before strands reads and edits as it did.
  A strand is at most 600 characters without headings, the file at most 12,000.
  One call is one write: a failed edit, strand or limit is refused
  with nothing written. A missing file reads as "no brief yet"; a failed read
  is never an empty brief: the knowledge sync then leaves the entry the session
  holds. `session.deleted` removes the file; archiving keeps it, so a restored
  lead has its brief. Every `lead.brief` answer carries the file's path as
  `file`, so the transcript card can open it in the Files viewer for the user.
- A heading the user writes by hand into the strands part, with what is under
  it, joins the free part, so replacing a strand cannot drop it.
- Every `lead.brief` answer says how full the brief is and which strands are
  largest, and from 9,000 characters a write asks the lead to condense.
- `lead.brief` and `lead.digest` refuse a field they do not have and name it.
  Empty values and the call's own scope (`sessionId`, `directory`, `projectId`)
  pass, since weaker models fill those in. OpenCode deletes undeclared fields of
  a closed schema before the tool runs, so the `openchamber` tool's `parameters`
  is open, and the plugin drops undeclared fields of every other action itself
  (`undeclaredOnlyForLead`), as OpenCode did.
- A refused `lead.brief` or `lead.digest` throws inside a Code Mode script
  (`agent-tool-plugin.ts`); a direct call gets the `ok: false` envelope. OpenCode
  also marks as a script call the one it recovers when a model calls a Code
  Mode tool directly; a refusal there is a failed call with the same message.
- The `openchamber.lead-brief` entry holds the brief as it stood when the
  lead's current stretch of conversation began, kept in `<id>.entry.md` (empty
  when there was no brief yet). A `lead.brief` call does not touch it, and
  `lead.brief` calls for one lead run one at a time; every compaction (the plugin hook calls
  `/lead-compaction` on each one) brings it up to the current brief. A
  compaction of a session that is no lead drops the copy, so marking it again
  starts from the current brief.
- `lead.digest` replaces the whole digest (`needsYou` at most 3 questions,
  each `{ question, options, recommended }` with at most 4 options and the
  recommendation one of them; `now` at most 8; `news` at most 5; `suggestions` at
  most 3; each line at most 300 characters) and stamps `updatedAt`. It is
  session metadata, so every client gets it through the metadata broadcast.
  A lead without a brief file gets `409` and nothing is written, so the
  context a lead wakes up with never rests on the digest alone.
  The server never asks the lead to update it. Suggestions the user
  declined (`lead.dismissed`, written by the UI) are left out, and the answer
  tells the lead which.
- `lead.handover` is the user's alone: it refuses any call that comes from a
  session. It refuses a lead, a session another session runs, a subagent
  session, the lead itself and a lead with a staged undo (OpenCode would take
  the note without waking it). Hand-overs of one session run one at a time. It
  denies the session the question and secret tools, links it as the lead's
  `ownWork` child and wakes the lead with a note naming the session; when the
  link or the wake fails, the session gets its permissions and its place back.
  A session running at that moment returns its answer to the lead through
  dispatch results, counted from its last idle record.
- A lead whose agent has the `openchamber` tool gets two instruction entries:
  the fixed lead rules (`LEAD_GUIDANCE`) and its brief. A session that is no
  lead, or whose agent has no tool, has both removed. Unknown metadata leaves
  both as they are.
- `work.name` on a lead renames the session itself, unless the user named it
  (`workTitle.by === 'user'`). Every other session keeps the rule that
  `work.name` never renames a session.
- Sleep compaction runs only for an idle lead whose context is at least
  200,000 tokens, or three quarters of a smaller window, once its provider cache
  has run out (the model's cache lifetime plus 30 seconds; when the lifetime is
  unknown, 5 minutes for a Claude model and an hour for any other). The wait
  follows the model of the last turn, the threshold the one selected when it ends. A turn that starts
  cancels the timer; a session the user keeps warm, one that is running again
  and one that is no lead any more are left alone. Overflow compaction during
  a turn stays with the model.
- The compaction hook in our OpenCode plugin asks
  `POST /api/openchamber/agent-tool/lead-compaction` on every compaction. Only a
  compaction this runtime started within the last 2 minutes, for a lead that
  has a brief, gets a note; every other one, and any failure to ask, falls
  back to the model's summary.
- Workflow runs start without approval when `agentWorkflowAutoApprove` is on
  (every session), or when `agentWorkflowAutoApproveLeads` is on and the
  proposing session is a lead.

## Decisions

### Why the digest is metadata and not part of the brief entry

OpenCode resends an instruction entry's whole value whenever it changes. A
digest inside the brief entry would resend up to 12,000 characters each time
the lead updates a line of status. The digest is what the user reads, so it
lives where the UI already gets live session state.

### Why sleep compaction writes its own note and not a model summary

A lead often sleeps for hours with hundreds of thousands of tokens of
context. Waking it reads them all cold, which spends subscription quota as
well as money, and a model summary costs one more full read. What a lead
needs after sleeping is already written down: the brief (an entry, kept
through compaction), the digest, and its children's states. The note says
where the full history is (`session.messages`); OpenCode keeps the recent
tail verbatim beside it. A lead with no brief still sleeps, with the model's
summary: the digest is a few lines for the user and cannot stand in for the
conversation, and one summary read now saves the same cold read at waking.

### Why an unknown cache counts as an hour and not as 5 minutes

Most providers keep a prompt cache past 5 minutes and do not say how long:
OpenAI still answered most requests from it after 30 to 60 idle minutes. A wait that is too
long costs one cold read; one that is too short throws away a conversation that
was still cheap to continue. Claude is the exception with a documented 5-minute
default. Session warming keeps its own 4-minute guess, because there a ping
that comes too late is the costly mistake.

### Why the small-window threshold is three quarters and not a lower share

A lead wakes from a compaction with 70,000 to 90,000 tokens when its rules,
tools and kept messages are large. A lower share would compact a 128k model
again after every turn; OpenCode's own automatic compaction starts at 85%.

### Why the lead rules say what is the lead's own work

"Full autonomy" and how to brief a child, without a default, read as permission
to do everything in place: weaker models delegated nothing. The rule covers a
single bug too, because a lead lives for weeks and each task done in place fills
the context it steers from. The rule about refusals covers an action that was
refused and not every limit of the lead's agent: agents are set up with
different permissions on purpose, and a lead that treats its own missing tools
as a ban cannot hand work to the agents that have them.

### Why changes go to child sessions and not to subagents

OpenCode's default depth limit lets a subagent start none of its own, so its
work needs the lead to carry it to a reviewer and back. A child session has no
OpenCode parent, so the limit counts from zero and it returns finished work.

### Why a compaction during a turn gets no state from us

The model that writes that summary reads the whole conversation, where the
lead's `lead.digest` calls and its children's reports already are, and
OpenCode's summary template asks for work state, including uncommitted
changes. A state block added to the request would be summarized again with
the rest. What the summary drops on purpose is environment such as the
session id, which the lead gets again from the environment; the way back to
the full history is one of the lead rules (`LEAD_GUIDANCE`), so it holds after
any compaction. The history read starts from the last turns, because a lead
lives for weeks and reading all of it into the context would refill it.

### Why the brief entry changes only at compaction and not on every lead.brief

OpenCode appends a changed entry to the conversation in full, so a lead that
rewrites its brief each turn would carry a copy of up to 12,000 characters per
turn until the next compaction. The lead's own `lead.brief` calls (the whole
text or the edits) are already in its conversation, so the entry only has to
be right where that history ends: at a compaction. The entry says it is the
brief as the stretch began and that later calls changed it.

### Why strands are units and not part of the free text

Find/replace makes adding cheap and removing expensive: to drop a paragraph a
lead has to quote it back, so briefs grew into logs up to the limit. A strand
is replaced or closed by id, and its size bound leaves no room for a history.

### Why only the lead actions throw inside a script

A script that did not parse the returned string went on after a refused
write. Throwing for every action would break scripts that read `ok: false`
answers today, among them saved script waits, and partial failures whose
`data` says which session was created. A lead write has no such reader.

### Why handing over goes through the control route and not its own route

The agent-tool routes are registered before the UI's authentication, so a UI
route there would skip it, and the server's wiring files may not grow. The
control route is already authenticated for the UI and the CLI; the action
refuses calls that come from an agent's session.

### Why a lead's name is its session title and not a separate field

A separate direction name would show only where the code reads it, and the
tabs, Cmd+P, search and notifications would keep the old title. The session
title is shown everywhere already, and the user's own rename is already
recorded as `workTitle.by === 'user'`.

### Why auto-approval for leads is a second switch and not a third value

`agentWorkflowAutoApprove` is a boolean that older clients read and write.
A three-valued field would be dropped or overwritten by them; a second
boolean keeps both working, and the Settings control shows the pair as one
choice of three.
