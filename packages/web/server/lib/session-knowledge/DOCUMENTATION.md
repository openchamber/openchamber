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
| `openchamber.guidance` | when to link, when to draw a page, where the tools are called |
| `openchamber.checkout` | the directory and branch the session works on |
| `openchamber.response-style` | the user's current response style |

`sync` writes all of them right before a message goes out: the UI awaits it
before the prompt request, the queue, scheduled tasks and dispatched sessions
call it in process. An empty text removes the entry. A key left out of
`buildKnowledgeEntries` keeps what the session holds. User-facing UI sends pass
the current style, including main chat, btw forks, UI-queued messages and fusion
judges. A disabled setting returns empty text and removes the entry. A failed
settings read omits the style and preserves the existing entry.

Internal subagents, scheduled tasks and multi-run lanes pass an explicit empty
style to clear one inherited from an earlier user-facing send. A send into the
user's own session, including `session.send`, server-delivered queued messages,
review handoffs, review feedback and auto-review, omits the style and preserves
the entry. A review session starts with no entry of its own, so its sends leave
it that way too.

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
The response style keeps the full custom text allowed by settings, up to 50,000
characters. It has no knowledge-entry truncation budget.

VS Code has no OpenChamber session-knowledge route. Its shared UI writes or
removes only `openchamber.response-style` through the directory-scoped OpenCode
SDK before sending. An omitted style still preserves the entry. Web, desktop,
hosted mobile and Capacitor use the server sync above.

## When to link

A session whose agent has the managed `openchamber` tool (the setting is on and
OpenChamber launched OpenCode) is also told when to link an issue or change to
it with `session.link` (`SESSION_LINK_GUIDANCE`), and only here: the tool's
description does not repeat it. Stated only in the action's description it went unread: an
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

While that branch still has the placeholder name OpenChamber generated (Quick
worktree's `agile-chipmunk`) and was never pushed (`readPlaceholderBranch`,
which is `readRenameableGeneratedBranch` in `../git`), the entry adds an
instruction: name the task with `work.name` and pass `branch`, the branch
named after the task in the repository's own naming or else
`<type>/<short-kebab-case>`, with no tool prefix; `work.name` renames it.
An issue's placeholder (`issue-180-merry-salamander`) keeps its number, which
`../git` puts in front of the last segment of the agent's name
(`fix/180-login-timeout`), and the instruction says so, so the agent does not
fight it.
Said only in the `work.name` answer, the first agent to hear it read it and
went on; told to run `git branch -m` beside `work.name`, weaker models named
the task and dropped the rename, so `work.name` now refuses a placeholder
worktree without `branch` (`../openchamber-sessions/work-naming.js`). A
rename changes the entry, so OpenCode tells the agent about the new branch
and the instruction leaves with it. A failed placeholder check tells only the
branch. The agent picks the name, since it fits the repository where a slug
of the task title would not.

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
only when asked again. The guidance holds the cases and the limits (no page for
a few numbers, at most one per answer), the mockup exception, and asking with a
page (`awaitAnswer`) when the user has to choose between visual options; the
tool description repeats none of it. It goes into `openchamber.guidance`, so a
change to the text reaches running sessions on their next message.

## When to ask for a secret

A session whose agent has the `openchamber_secret` tool (the setting is on and
OpenChamber launched OpenCode, read through `isSecretRequestAvailable`) is told
to ask for any secret on the tool's card and never in the chat
(`SECRET_REQUEST_GUIDANCE`). An agent needs the rule before it thinks of the
tool, and a token pasted in the chat stays in the transcript. The tool
description says only what the card does.

## When to offer a workflow

A session whose agent has the `openchamber_workflow` tool (a build with
workflows, the setting on, and OpenChamber launched OpenCode, read through
`isWorkflowAvailable`) is told when a task is big enough for one
(`WORKFLOW_GUIDANCE`). A run costs many agents, so the agent starts one only
when the user asks; when it sees a task with many similar independent pieces
it says so and offers one. Small tasks never get one.

## Where the tools are called

While the managed tools are direct tools (the default; `agentToolsCodeMode`
puts them in Code Mode's catalog), a session that has any of them is told
they are called directly, never from inside a Code Mode `execute` script
(`DIRECT_TOOLS_GUIDANCE`). OpenCode's Code Mode teaches the model that tools
live in `execute`'s catalog: a model that called `tools.openchamber(...)` from
a script was answered "Unknown tool", concluded the tool did not exist, and
never named its task. With Code Mode on for our tools the sentence would be
wrong, so it is left out.

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
