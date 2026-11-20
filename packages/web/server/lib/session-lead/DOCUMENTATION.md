# Session lead

## Ownership

A lead is a session the user marked to own a direction of work
(`metadata.openchamber.lead = { at, digest? }`): it hands work to the
sessions it creates with `ownWork`, checks what comes back against the
outcome it agreed with the user, and keeps a brief and a digest. This module
owns everything that only leads have on the server: the brief file, the
`lead.brief` and `lead.digest` actions of the `openchamber` tool, the
`openchamber.lead` and `openchamber.lead-brief` instruction texts, sleep
compaction, the compaction callback route, and whether a lead's workflow runs
start without approval. The UI owns the mark, the start points and the digest
row (`packages/ui/src/lib/sessionLead.ts`). Session knowledge writes the
entries (`../session-knowledge/`), the control service routes the actions
(`../openchamber-control/`), `work.name` names a lead
(`../openchamber-sessions/work-naming.js`).

## Invariants

- Only the user makes a session a lead (the session menu, or a draft opened
  with New lead). The lead actions refuse any other session with `409`, so an
  agent cannot turn itself or a child into a lead.
- The brief is one markdown file per lead in `<data-dir>/leads/<id>.md`,
  outside the repository and outside Project knowledge. `lead.brief` replaces it
  whole, at most 12,000 characters, and a longer one is refused with nothing
  written. A missing file reads as "no brief yet"; a failed read is never an
  empty brief: the knowledge sync then leaves the entry the session holds.
  `session.deleted` removes the file; archiving keeps it, so a restored lead
  has its brief.
- `lead.digest` replaces the whole digest (`needsYou` at most 3, `now` at most
  8, `news` at most 5, each item one line of at most 300 characters) and stamps
  `updatedAt`. It is session metadata, so every client gets it through the
  metadata broadcast. The server never asks the lead to update it.
- A lead whose agent has the `openchamber` tool gets two instruction entries:
  the fixed lead rules (`LEAD_GUIDANCE`) and its brief. A session that is no
  lead, or whose agent has no tool, has both removed. Unknown metadata leaves
  both as they are.
- `work.name` on a lead renames the session itself, unless the user named it
  (`workTitle.by === 'user'`). Every other session keeps the rule that
  `work.name` never renames a session.
- Sleep compaction runs only for an idle lead whose context is at least
  100,000 tokens, once its provider cache has run out (the model's cache
  lifetime, 5 minutes when unknown, plus 30 seconds). A turn that starts
  cancels the timer; a session the user keeps warm, one that is running again
  and one that is no lead any more are left alone. Overflow compaction during
  a turn stays with the model.
- The compaction hook in our OpenCode plugin asks
  `POST /api/openchamber/agent-tool/lead-compaction` on every compaction. Only a
  compaction this runtime started within the last 2 minutes gets a note; every
  other one, and any failure to ask, falls back to the model's summary.
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
tail verbatim beside it.

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
