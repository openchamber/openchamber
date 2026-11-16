# Agent memory

## Ownership

This module owns the agent memory store (`runtime.js`), the `openchamber_memory`
tool's actions (`actions.js`), the panel's routes (`routes.js`), which store a
folder belongs to (`project-resolution.js`), and dreaming (`dreaming.js`), the
pass that tidies the store on its own. What a session is told about memory is
`../session-knowledge`; the panel is `packages/ui/src/components/session/project-context`.

## Invariants

- A store that cannot be read is a failure, never an empty store (`read`).
- Every write to a scope, a dreaming record and an undo included, runs under
  that scope's lock, so an undo never interleaves with a pass being recorded.
- A dreaming pass never creates entries and never asks: it rewrites by
  `memoryId` and deletes.
- Undo takes back only what the last pass changed: an entry it deleted comes
  back, an entry it rewrote gets its old text unless it changed since. Entries
  created, edited or deleted after the pass stay as they are. A write made while
  the pass ran cannot be told from the pass's own and is undone with it.
- A pass's session carries `metadata.hidden: true` and is deleted when the pass
  ends, so no client or server-side consumer ever sees it.

## Dreaming

The server looks a few minutes after it starts and every hour after, so a
desktop app opened and closed through the day still dreams. A scope is due a day
after its last pass, once it holds ten or more entries created or changed since
then, or its titles no longer fit the index sessions get (`measureMemoryIndex`
in `../session-knowledge/runtime.js`). A pass waits while any session runs.
One pass covers one project, the one dreamed longest ago first, and the global
store too when that is due; the global store alone runs in the active project.

The pass is a session in the project's folder, with the model from
`agentMemoryDreamingModel` (else the session defaults), `metadata.hidden: true`
and `metadata.openchamber.kind = 'memory-dream'`, by which a leftover is found. Its permission ruleset denies everything, then allows
reading (not `.env` files), `git log`/`git show`, skills, the model and Code Mode:
session rules are read after the agent's, so no `ask` in the project's config
can wait for a person who is not there. It gets every entry with its id, the
index budget and the rules, and acts through the memory tool. The runtime polls
`/api/session/active` rather than OpenCode's wait route, which outlives Bun's
five-minute fetch timeout while a slow model thinks; every request has its own
timeout, and the pass as a whole 30 minutes. A turn that ended on a provider
error (the newest idle record failed) is a failed pass, never "nothing to tidy".

When it ends, the runtime diffs the store against the snapshot it took and
records the pass in `memory-dream.json` beside the scope's `memory.json`: the
record, `lastRunAt`, and, when anything changed, the snapshot and the id and
`updatedAt` of every entry the pass left, which is how undo tells the pass's
writes from later ones. Then it deletes the session and announces the change to
open panels. The agent's last line, `DREAM {"project": P, "global": G}`, splits
each scope's deleted count into merged and removed, and its `toDocs` lists the
project entries that belong in the project's agent docs, kept in the record for
the panel to offer moving. The pass leaves those entries as they are: it never
writes to the repository. A failed pass is tried again
after six hours.

### Why topical merges wait for an overflow

Every pass merges entries that say the same thing. Entries that only share a
topic are merged into one only while the index leaves titles out: a merged
entry's title names a topic, and a session picks what to read by its title, so
merging fitting entries trades specific titles for nothing.

### Why a hidden session and not a model call

The pass has to check entries against the code and the agent docs, which takes
the agent's own tools. A tool-less call would see only the entries and could
not tell a recipe the skills already hold from one they lack.

### Why hidden by a metadata flag, filtered on the server

`metadata.hidden: true` is a plain flag any session can carry, a plugin's too.
Most events carry only a session id, so a client could not filter them by
metadata; the server learns the hidden ids instead
(`../opencode/hidden-sessions.js`): from a record's metadata in `session.created`
and `session.updated`, from every session list the proxy serves, and from the
list it reads when it connects to OpenCode. It drops their events in the hub
(`../event-stream/global-hub.js`) and the directory bridge, and leaves them out of
the proxy's `/api/session` and `/api/session/active` and the control tool's
`session.list`. The sidebar, In work, notifications, Jev hints and extension
events all read through those, so no consumer needs a check of its own. A
learned id stays for the life of the process, so the events trailing a deleted
session stay hidden too. A session left by a server that stopped mid-pass is
deleted on the first look that reaches OpenCode, dreaming on or off.

### Why undo keeps later writes

A pass is recorded when it ends, and the agent or the user may save or correct
entries before anyone looks at the panel. Restoring the snapshot alone would
undo that work too.
