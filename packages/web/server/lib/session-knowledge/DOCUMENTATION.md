# Session Knowledge

What a session must be told about the project — the user's pinned notes and
plans, and the index of what the agent has remembered — and whether it has been
told yet.

## Why it is here and not in the UI

The client used to own this: it assembled the text, decided when to send it, and
remembered what it had sent in a module-scoped map. Two consequences followed.

A session started without a UI got nothing at all. Scheduled tasks and sessions
the agent dispatches build their prompts on the server and never touch the
browser, so pinned context and the memory index simply did not exist for them.

And a tab's memory of what it sent survives compaction, while the conversation
does not. After a summary the agent no longer holds the block, but the tab goes
on believing it does and never sends it again.

## The contract

`session.metadata.openchamber.knowledge_context_delivered` holds the signature
of what the session is carrying. It lives with the session, so it survives the
tab closing and is visible to every sender, including the ones with no tab.

The signature covers content revisions, not just identity: editing a pinned note
must re-send it, not merely renaming one.

## Three moments, two deliveries

| Moment | Delivery |
|---|---|
| A message from the UI | synthetic part on that message |
| A scheduled task, a session the agent dispatched | synthetic part on that prompt |
| After compaction | its own `prompt_async`, alongside the pinned messages |

The first two attach to an outgoing message because there is one. Compaction has
none, which is why it re-sends on its own — and it travels with
`context-obligatory`'s pinned messages in a single turn, since two synthetic
messages back to back read as the agent being interrupted twice.

## Failure behaviour

Nothing here may fail a send. A message without its background costs the agent
some context; a failed send costs the user their message. Every caller treats an
error as "no block this time".

A source that will not load never blanks the rest: an unreadable memory store
still delivers the pinned notes. A memory scope that failed to load is left out
rather than indexed as empty, which would teach the agent to store again what it
already has.

Delivery is recorded only after the send is accepted. Recording it when the text
is handed over would leave a failed send believing the agent had context it never
received.

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

Pinned notes and plans are unaffected: they ship as normal and travel with every
message whether or not memory exists.
