# Session folders

## Ownership

This module stores the chat folders of one OpenChamber server in
`sessions-directories.json` under the server's data directory, and serves them
to every client of that server: desktop, web, the phone (direct or through the
relay) and another computer signed in to the same server. A second server has
its own data directory and its own folders. VS Code has no OpenChamber server
and keeps its folders in the extension's own storage.

The stored map is keyed by scope: a project root, a worktree or space
directory, or `__archived__:<project root>` for the archive's folders. Each
folder has an id unique across the file, a name, an optional parent in the
same scope, and the ids of the chats filed in it.

`routes.ts` owns the HTTP contract and the file; `folder-changes.ts` owns the
change semantics. The client store (`packages/ui/src/stores/useSessionFoldersStore.ts`)
owns the local cache, the queue of unsent changes and when to read again.

- `GET /api/session-folders` returns the stored snapshot with `exists: true`,
  or `{ exists: false }` when there is no file. A malformed file is a 500,
  never an empty list.
- `PATCH /api/session-folders` takes `{ changes: [...] }` (at most 1,000), applies them in
  order under the write queue, writes the file when something changed and
  answers with the stored snapshot.
- `POST /api/session-folders` is the whole-copy write of clients from before
  shared folders. It stays so an older client on another device keeps working;
  current clients use it only against a server that has no `PATCH`.
- After a write that changed the stored folders the server sends
  `openchamber:session-folders-changed` with the new `updatedAt` on the
  OpenChamber control stream (`onChanged` from `feature-routes-runtime.js`).

## Invariants

- Writes are serialized; each one reads the current file, applies, and
  replaces the file through a temp file and rename.
- `updatedAt` is a revision that only grows: a write sets it to the server
  clock or one past the stored value, whichever is larger. Clients drop
  answers older than the one they show and skip the read for an announcement
  they already show.
- A change that changes nothing writes nothing and announces nothing.
- A failed change announcement leaves the completed write in place.
- A change about a folder that is gone does nothing. A create whose parent is
  gone places the folder at the top level.
- A chat is in at most one folder of a scope after `assign`.
- An `assign` or `unassign` with `from` skips each chat that another client moved
  away from the folder `from` names for it. A chat left in no folder because that
  folder was deleted was not moved, and the change applies. Without `from`, which
  older clients and changes they queued send, it applies to every chat.
- Deleting a folder deletes its sub-folders. Every deleted id (by `delete` or
  `forget-scopes`) is kept as a tombstone for 30 days, so an older client that
  still holds the folder cannot bring it back with its whole copy. A `create`
  with the same id clears the tombstone; only fixed ids (the archive's
  `archived:<scope>:<name>`) are ever created twice.
- A stored snapshot written before tombstones existed, with no
  `deletedFolderIds`, is valid and holds no deletions.
- A change carries ids up to 32,768 characters because a scope key is a
  directory path.
- `import` places parents before their children. A copy with a parent cycle,
  which only a corrupted file can hold, places its first folder at the top
  level.
- `import` keeps what the server already has: its folders keep id, name and
  place, and a chat it already files stays where it is. The only thing it
  removes is a folder the device itself deleted, sent as a tombstone.
- A file that exists but cannot be read is never treated as empty: `GET` and
  `PATCH` answer 500 and nothing is written. Only the older clients' whole-copy
  `POST` replaces it, since a valid copy is all such a file can be repaired from.
- Any write that changes the folders moves `updatedAt` past the stored value,
  the older clients' `POST` included, whose own stamp comes from its clock.
- The client applies the same changes to its own copy with the same results
  (`packages/ui/src/lib/sessionFolders/folderChanges.ts`); a change to one
  side's semantics changes the other in the same commit.

## Decisions

### Why stored revisions remain unparsed until use

The file shape guard accepts a missing or nonnumeric `updatedAt` for writes.
`GET` and the incoming whole-copy `POST` separately require a positive finite
number; a change uses zero for an invalid stored revision and keeps the original
snapshot unchanged for a no-op. `StoredFolderSnapshot.updatedAt` therefore stays
`unknown` until the existing revision check, while written snapshots carry a
numeric revision. Folder parents and tombstones accept explicit `undefined` in
the shape guards and the change schema; the injected callback and clock also
accept it, as the route tests supply it to select their defaults.

### Why the shared record guard has a local predicate

`shared/guards.js` supplies the record check but exposes an inferred boolean
return rather than a TypeScript predicate. The local predicate uses that check
unchanged so file JSON and HTTP bodies narrow before use without converting the
shared module. Folder changes use Zod's inferred discriminated union.

### Why the pending import entry is checked

The nonempty pending list always supplies an entry at the selected splice index.
An explicit occupancy check records this invariant for strict indexed access.

### Why dependencies stay injected

The composition caller supplies filesystem promises, path operations and the
data directory; the clock and announcement callback default to `Date.now` and a
no-op. HTTP bodies and file JSON are parsed at the routes, filesystem failures
remain failures except `ENOENT`, and temporary filenames retain the process id,
clock and random suffix.

### Why changes and not whole copies

Clients used to send their whole folder map and the server merged it per
scope, with the incoming copy winning per folder id. A device that had not
seen another device's rename or move undid it on its next write, and a
missing scope could not be told from a deleted one. A change says what the
user did ("move these chats into this folder"), so a client that is behind
cannot undo anything it did not touch, and the server needs no merge rules
for ordinary edits.

### Why an older client's whole copy merges into the stored folders

An older client sends its whole device map, and that map can predate the server's
state: it may have been built before the client ever read the server, the tab has
been open a long time, or its clock is wrong. A scope or folder missing from the
copy is not a deletion, so the merge keeps the scopes the writer did not send,
lets the incoming folder win per id, and keeps `updatedAt` monotonic. Two devices
that auto-created the archive folder of one scope produce two ids with the same
name, and their chats are unioned so they do not split across duplicates. A
deletion travels as a tombstone, which removes that id from every scope even when
a stale copy sends the folder again.

### Why a move carries where the chat was instead of an id the server remembers

A client that timed out cannot tell whether the server stored its move, so it
sends the move again, and it may do so after a reload, long after another client
moved the same chat. Ids of applied changes would stop only the re-send of a
stored move; a move that never arrived would still undo the newer one. Comparing
the chat's place covers both and keeps the stored file as it is. The cost is
that of two clients moving one chat from the same place, the first to reach the
server wins, and a chat moved back to exactly where it started can still be
moved again by a late re-send.

### Why the server tells clients to read again instead of sending the folders

The announcement carries only the revision, like `project-context-changed`.
A client reads the folders once per change it has not seen, so an event that
arrives late or twice cannot show an old map, and the event stays small for
any number of projects.

### Why the import lets the server win

Each device's copy from before sharing is merged in once. What the server
already has is what the other devices show, so it wins; a local folder with
the same name under the same parent in the same scope joins it instead of
becoming a duplicate, any other local folder is added, and a chat only the
device had filed goes into the matching folder. Nothing on either side is
dropped except folders deleted elsewhere within the last 30 days. The client
sends `import` and waits for the answer without applying it to its own copy, so
the merge happens only here. A deletion the device sends also removes that folder
from scopes the device no longer sent.

### Why collapsing a folder is not shared

Which folders are open is how one screen is arranged; collapsing one on the
phone must not close it on the desktop. The client keeps it per device and
ignores `collapsedFolderIds` in the file, which only older clients still read
and write. A whole copy keeps the writer's state for the folders it sent and
another device's entries only for folders the writer did not send, so expanding
a folder is not undone by a copy that still has it collapsed.
