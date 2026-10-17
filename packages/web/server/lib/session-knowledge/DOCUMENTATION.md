# Session Knowledge

What a session must be told about the project: that session's pinned notes and
plans, the index of what the agent has remembered, the rules for the managed
tools, and the branch it works on.

## Why it is here and not in the UI

The client used to own this: it assembled the text, decided when to send it, and
remembered what it had sent in a module-scoped map. A session started without a
UI got nothing at all: scheduled tasks and sessions the agent dispatches build
their prompts on the server and never touch the browser. So every sender calls
`sync` here, the UI through `POST /api/session-knowledge/sync`.

## The contract

`session.metadata.openchamber.project_context_pins` owns the note and plan ids
attached to that session. Pins never come from project-wide note or plan state.
A new-session draft passes its pins into this metadata when its first message
creates the session.

Directories beneath the managed `~/.config/openchamber/chats` root resolve to that root before project context and project memory are read. Every ordinary chat therefore shares one Chats knowledge owner instead of creating an unreachable context store for each dated session directory.

## How it reaches the agent

The text lives in OpenCode as the session's instruction entries
(`PUT`/`DELETE /api/experimental/session/:id/instructions/entries/:key`), one per
source:

| Key | Holds |
|---|---|
| `openchamber.pinned` | pinned notes and plan bodies |
| `openchamber.memory` | the memory index and when to save |
| `openchamber.guidance` | when to link, when to draw a page |
| `openchamber.checkout` | the directory and branch the session works on |

`sync` writes all of them right before a message goes out: the UI awaits it
before the prompt request, the queue, scheduled tasks and dispatched sessions
call it in process. An empty text removes the entry. A key left out of
`buildKnowledgeEntries` keeps what the session holds.

OpenCode does the rest. The first values go into the session's system prompt;
a value that changed or went away is announced to the agent at its next step as
a system message, and an unchanged write tells it nothing. Compaction keeps the
current values, revert does not cut them, and a fork copies them. So OpenChamber
keeps no record of what a session was told, and the knowledge is never a
message in the transcript.

It used to be one. The block went in as a synthetic message ahead of the prompt,
a signature in the session metadata recorded what was delivered, compaction
re-sent it, and a revert that cut it cleared the signature. The model read that
message as one from the user: after an automatic compaction weaker models
answered it instead of doing the work (#4877). Sessions from that time keep the
old block in their transcript and hear the entries once more on their next
message.

## Failure behaviour

Nothing here may fail a send. A message without its background costs the agent
some context; a failed send costs the user their message. `sync` never throws:
it resolves `false` and the message goes out. One entry that fails to write does
not hold back the others.

While memory is on, every session is told when to save, even with an empty
store. The tool description alone is read only when the agent already means to
call it, so agents told nothing here saved only when the user said "remember".
The session hears "nothing is stored yet" only when both scopes loaded.

The save rule also says to save before the final reply. The chat shows only the
last step's text as the answer, so an agent that answered, then saved, then
wrote one closing line had its whole answer folded into Activity.

A source that will not load never blanks the rest: an unreadable memory store
still writes the pinned notes. A memory scope that failed to load is left out
rather than indexed as empty, which would teach the agent to store again what it
already has.

Each of the pinned and memory entries is cut at 8,000 characters, and says so.

## When to link

A session whose agent has the managed `openchamber` tool (the setting is on and
OpenChamber launched OpenCode) is also told when to link an issue or change to
it with `session.link` (`SESSION_LINK_GUIDANCE`). The same rule leads the tool's
own description. Stated only in the action's description it went unread: an
agent handed an issue to investigate saw no reason to open a session-control
tool, so it never linked anything. It goes into `openchamber.guidance`.

## Which branch the session works on

While the agent has the managed `openchamber` tool, `openchamber.checkout`
names the session's directory and the branch checked out there
(`readCheckoutBranch`, read on every send). An agent once went on editing on a
branch another session had switched the shared checkout to while it was
talking with the user: nothing it could see said the branch had changed. Now
OpenCode tells it the entry changed, and the agent decides what that means.
The directory is in the value, so a session moved to another worktree reads as
a move. Detached HEAD and directories outside a Git repository write
"This session works in `<dir>`, with no branch checked out." A failed Git read
leaves the previous entry as it is. Dispatched prompts resolve the target
session's own `location.directory` through `client.session.get` before syncing;
an unavailable location skips sync and preserves its entries. Without the tool
the checkout entry is removed.

What the agent can do about a busy checkout, moving into a worktree, is
introduced in the tool's own description (`../agent-tool/DOCUMENTATION.md`),
never stated here as a rule. Whether a busy checkout calls for a worktree
depends on how the user works.

## When to draw a page

A session whose agent has the managed `openchamber_render` tool (the setting is
on and OpenChamber launched OpenCode, read through `isPageRenderingAvailable`)
is told when a chart, table, diagram or interface mockup beats prose
(`RENDER_PAGE_GUIDANCE`).
Stated only in the tool description, it went unread: asked for a breakdown of
lines of code per package, an agent answered with a list and drew the chart
only when asked again. The cases and the limits (no page for a few numbers, at
most one per answer) are `RENDER_PAGE_WHEN` in
`../openchamber-control/render-page.js`, which the tool description shares. The
guidance also names asking with a page (`awaitAnswer`) when the user has to
choose between visual options. It goes into `openchamber.guidance`, so a
change to the text reaches running sessions on their next message.

## Entries that read as instructions

Memory is the one place where text from outside can settle permanently. The
agent reads a page, decides a line is worth keeping, saves it — and from then on
it rides into every session in every project. An injection anywhere else lives
for one conversation.

`agent-memory/threat-patterns` scans on write and again on every read, so an
entry written before a pattern existed, or edited on disk since, is judged now.
A match never deletes: the entry is stored, flagged, kept out of what sessions
are told, and shown in the panel with a warning. Silently dropping it would hide
the attempt from the only person able to judge it.

Patterns, not a model — this runs on every index build. That buys the blunt
cases only, which is the honest expectation.

## Shipping dark

Agent memory is complete but unreleased. `OPENCHAMBER_MEMORY_ENABLE` decides
whether it exists in a given process at all: unset, there is no tool, no routes,
no session index, no settings row and no panel tab — absent rather than switched
off, which would invite turning on something never announced. The setting itself
also defaults to off, so setting the variable does not enable memory by itself.

Pinned notes and plans are unaffected by the memory switch and remain scoped to
the session that pinned them.
