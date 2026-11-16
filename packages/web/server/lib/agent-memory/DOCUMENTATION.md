# Agent memory

## Ownership

This module owns the agent memory store (`runtime.js`), the `openchamber_memory`
tool's actions (`actions.js`), the panel's routes (`routes.js`), which store a
folder belongs to (`project-resolution.js`), and dreaming (`dreaming.js`), the
pass that tidies the store on its own. What a session is told about memory is
`../session-knowledge`; the panel is `packages/ui/src/components/session/project-context`.

The store has two scopes:

- **project** — `<projectsDir>/<stem of projectId>/memory.json`, the bounded
  folder name `projectConfigFileStemOf` gives the id, shared with the config
  file and `project-context`.
- **global** — `<userConfigRoot>/memory.json`, for what belongs to no project.

An entry is a `fact` (something true about the project or the user), a
`preference` (how the user wants work done) or a `reference` (a pointer to a
resource that is hard to rediscover). Memory is not the notes surface: notes are
what the user writes and pins, memory is what the agent writes for itself, and
keeping them apart keeps an agent mistake out of the user's notes.

## Invariants

- A store that cannot be read is a failure, never an empty store (`read`).
- A missing file is authoritative empty. An existing document must be an object
  with an `entries` array before individual entries are sanitized. Invalid
  documents fail reads and mutations without changing the stored bytes.
- Entry sanitization remains tolerant of legacy fields and versions. Valid empty
  arrays remain readable.
- A restatement of a stored memory replaces it rather than sitting beside it, so
  the store cannot fill with variants of one fact that later disagree.
- `createdAt` and `updatedAt` are the record of change: the panel derives "new"
  and "changed" against when the user last looked, so the store carries no
  review state of its own.
- A title holds at most 60 characters and a body at most 2000. A title is capped
  because every session carries every title, so their combined length is the
  standing cost of memory; a body is capped because the store is not a document
  archive.
- Project memory holds at most 200 entries, global memory at most 60. A wrong
  project fact costs one project and is noticed quickly; a wrong global fact
  quietly shapes every session in every project and has no code the user can
  check it against.
- Every read re-runs the threat patterns on an entry's text. The `flagged` bit
  in the file is not trusted, so an entry written before a pattern existed, or
  edited on disk since, is judged now.
- A missing or unreadable `memory-dream.json`, and a field in it the schema
  cannot read, read as never dreamed. The state only decides when the next pass
  is due and offers an undo, so it costs one early pass, never memory.
- A failed scope leaves healthy scopes available, in ordinary reads and in
  dreaming alike: a pass skips a project store it cannot read and leaves an
  unreadable global store out, logs why, and never writes to either, so a
  repaired store dreams again on a later look.
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
The pass ends when its turn was seen running and is no longer, or when it was
never seen running thirty seconds after the prompt. Session defaults left on
OpenCode's Auto sentinel are not a model the server can send, so the session is
created without one and OpenCode picks its own default; `POST /api/session`
answers `{ data: session }`, and the parser also accepts a bare session.

When it ends, the runtime diffs the store against the snapshot it took and
records the pass in `memory-dream.json` beside the scope's `memory.json`: the
record, `lastRunAt`, and, when anything changed, the snapshot and the id and
`updatedAt` of every entry the pass left, which is how undo tells the pass's
writes from later ones. Then it deletes the session and announces the change to
open panels. The agent's last line, `DREAM {"project": P, "global": G}`, splits
each scope's deleted count into merged and removed, and its `toDocs` lists the
project entries that belong in the project's agent docs, kept in the record for
the panel to offer moving. The pass leaves those entries as they are: it never
writes to the repository. A failed pass is tried again after six hours, and it
is recorded too, so what it changed before failing can be undone. A finished
pass schedules the next look a minute later, so other due projects do not wait
for the hourly check.

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

### Why document validation precedes entry sanitization

The sanitizer tolerates malformed individual entries. Applying that tolerance
to a missing or non-array collection would treat corrupt storage as an empty
store and let the next save overwrite it. Rejecting the document preserves its
bytes for recovery while keeping legacy-entry tolerance.

### Why the action layer lives beside the store

The control service already owns sessions, schedules and the browser; memory
shares none of that machinery and needs only the same envelope.

### Why project scope comes from the session directory and never from the model

Letting the agent name a project id would let a memory learned in one checkout
be filed against another, which the user would have no way to notice.

### Why a directory resolves to its primary worktree

A session in a worktree carries the worktree's own path. Keying memory by that
path filed the memory under a project the panel never reads: it was written,
stored and invisible. Every worktree of a repository shares one project memory,
which is also what the user means by "this project". A directory that is itself
a configured project is taken as-is before the git lookup, because a user may
register a worktree as a project in its own right and that choice wins over the
git topology.

### Why the scope is a query parameter and each route parses its own body

Global and project memory are one resource with two homes, so one set of
handlers resolves `?scope=global` or `?scope=project&projectId=...`. A project
request without an id is rejected rather than falling back to global, which
would write project facts into every other project. The body parser is attached
per route because the generic OpenCode proxy needs an unread request stream, so
`core-routes` parses only an explicit allowlist of path prefixes; a route that
forgets it sees `req.body` as undefined and rejects every write as a malformed
body.

### Why one gate covers the whole surface

The settings toggle disables the feature, not just its UI: with memory off these
routes must not read or write the store, or a stale client keeps editing memory
the user believes is turned off. The setting is awaited because it is read from
disk; testing the returned promise for truthiness leaves the gate permanently
open. A disabled answer carries `disabled: true` because a missing entry answers
404 too, and a client that could not tell them apart would report a deleted
memory as the whole feature being switched off. The tool lives in the managed
OpenCode child and disappears only when that child restarts, so the action layer
checks the same setting itself: otherwise writes land on disk while the panel is
hidden and the index that carries them is suppressed.

### Why the panel reads both scopes in one response

The panel always shows the two scopes together, and two requests would let one
render while the other is still loading, which reads as memory that has gone
missing. The dreaming record travels without its snapshot: the panel shows one
line and an undo, never the entries as they were.

### Why read matches a title and treats scope as optional

The session index lists titles only, so requiring an id would force a list call
before every read just to translate what the agent can already see. Scope decides
everything for a write, because a fact filed globally reaches every project, but
on a read it is only which drawer to open, and demanding it turned a legible
request into an error the model had to recover from. Omitted, both stores are
searched, project first: when both hold the same title, the one about this
codebase is the one being asked about. A store that failed to read answers 503,
never "no such memory", because the agent would otherwise store the fact a
second time.

### Why a restatement replaces and a related entry is only reported

Two entries are the same memory when 75% of the incoming wording is already in
the stored one; short entries, under four meaningful words, fall back to
exact-title matching because below that overlap is noise ("use bun" and "use npm"
share half their tokens). The threshold is high because merging two genuinely
different memories destroys one silently, which is far worse than a
near-duplicate the user can see and delete. Entries sharing 40% of their wording
are reported as related: a reversed decision is phrased too differently to count
as a duplicate, and a false match costs the agent one line to ignore. The report
travels in the save answer because the agent still knows then whether the new
entry reverses an old one; left to a later tidy-up, both entries reach every
session in between and contradict each other. The restatement check runs before
the capacity limit because replacing an entry does not grow the store, and a
full store must still be able to correct itself.

### Why a save answer is a summary and not the stored text

Handing the model what it just wrote invites it to find something to improve and
re-save; the confirmation is where a save is seen to have worked, not the store.
The answer says `replaced` plainly so the agent does not report storing a second
memory when it corrected one it already had.

### Why a full store's error names its entries

A bare "full" leaves the agent with a dead end, when the useful move — merge the
overlapping entries, drop the stale ones, then retry — is one only it can judge.

### Why writes reject an over-long body and reads clamp it

A silent slice returned success for a body that was never stored, and the store
then read back as a memory the agent never wrote. Reads stay tolerant of entries
written by older builds that truncated at a shorter limit, or hand-edited past
it, because failing on an old over-long body would look like memory loss. Only
writes enforce the limit, so the asymmetry never widens. A missing or
non-string body is reported as `body is required`, never as an over-long body.

### Why injection detection is a pattern list and never deletes

Memory is the one place where text from outside settles permanently: a line
saved from a page rides into every session in every project, where an injection
anywhere else lives for one conversation. Patterns run on every write and every
read, and a classifier there would cost more than the whole feature; that buys
only the blunt cases, which raises the floor rather than closing the door. A
match stores the entry, keeps it out of what the model is shown and flags it for
the user, because a silently dropped entry hides the attempt from the only party
who can judge it.

### Why an announced write cannot fail the action

The agent writes on its own initiative, so without the announcement an open
panel would learn what was stored only the next time something reloaded. The
memory is already on disk by then, and a listener that throws must not report
the write as failed.
