# Chat directory cleanup

## Ownership

This module removes generated managed chat folders after confirmed host session deletions. `scheduled-tasks/chats-scope.js` and the shared UI own folder creation. The filesystem routes still serve explicit file operations and draft rollback.

## Invariants

- Only the locally managed OpenCode process authorizes cleanup. An external OpenCode and isolated-space events cannot remove host files. A process change retires the previous process's session directory evidence and pending cleanup.
- Session creation and directory updates supply the directory that a deletion event omits. Fork events read the new fork's record through the SDK. A later update or complete snapshot supersedes that read, and a deletion during the read waits for its directory evidence. Each stream connection also seeds the directory index from a complete host session list. A startup list alone supplies no cleanup candidates, and unknown deleted sessions leave their files untouched.
- A fresh list includes every active and archived root, fork and subagent. It is read oldest first, so a session written during the read moves ahead of the cursor and is read again; the later copy wins. Every session the host stream names during the read (any wire event with a session id, including archives and message writes the translation drops) and the list lacks is read on its own; only a not-found answer drops it. Every continuation cursor must complete; a terminal cursor object can omit `next` or set it to null. A missing cursor object is a failure. Failed, malformed, repeated, unsettled or incomplete pages authorize no removal.
- Session mutations during a read or filesystem check invalidate its deletion authority. A batch reads again before removing anything. Cascading deletions share the pending read.
- Removal needs a connected host stream and an inventory read after that connection. A stream loss invalidates every read in flight and suspends removal; the next connection reads a complete inventory before any candidate is removed.
- A remaining session in the folder or any descendant keeps the folder. Lexical descendants and filesystem-confirmed aliases count as references. An unreadable reference retains pending cleanup. Deleting the last session from a nested working directory also reclaims its generated chat folder.
- Eligible paths match the generated date and session layout under the configured or legacy chats root. Shared roots, date buckets, symlinked date buckets and symlinked session folders stay untouched. Configured root symlinks are resolved before checking ownership.
- Cleanup captures the folder and parent identities with exact device and inode values before reading references and checks them again before claiming the folder. Ownership capture and cleanup completions belong to the same process and candidate, independently of session inventory freshness. A session event causes a fresh reference read while retaining the original identities. A replacement at either path stays untouched, including after failed cleanup.
- Removal never targets the reusable pathname. A candidate is claimed by renaming it into a private `.reclaiming-*` folder under its chats root, and the claimed identity must match the captured one. A second complete inventory follows; only an unreferenced claim under unchanged authority is deleted, from the quarantine. A reference, a stream loss, an owner change, shutdown or a failed check puts every claim back. The return takes the free name with `mkdir` and renames onto that empty folder, so it never replaces anything that took the name meanwhile; when the name is in use the files stay in the `.reclaiming-*` folder and the log names it. A quarantine whose removal fails (a busy file on Windows) is logged by path and removed again on the next check, by that quarantine path only.
- Failed initial inspection leaves the files untouched and discards the automatic candidate because no original identity was established. Once identity is captured, failed reference reads or removal keep the candidate in memory for the next deletion or stream connection. Shutdown aborts reads and prevents new removal. Pending cleanup does not survive a server restart.

## Decisions

### Why cleanup follows confirmed deletions

A chat folder can belong to an unsent draft before OpenCode has a session for it. Scanning the chats root and deleting every unreferenced folder would remove those drafts. Historical orphan folders remain outside this module's ownership.

### Why references come from the host API

Client lists may be unloaded, filtered or missing an event. The server reads the unfiltered global OpenCode list without starting directory locations, so another device's deletion gets the same reference check while forks and archived sessions keep their files.

### Why forks read their own record

OpenCode emits a fork event without its directory. A cached source directory can be stale after a move through another OpenCode process, so cleanup reads the fork's own record and rejects replies superseded by a session update or owner change.

### Why removal claims the folder first

Checking the identity and then deleting the original path leaves a gap: a new session, an owner change or a replacement folder after the check cannot stop a recursive delete already running there, and nothing after it brings files back. A rename into a private folder is atomic, so everything that may be destroyed has a known identity, and the fresh reference check runs while the original path is free and the files are still recoverable.

### Why the inventory is read oldest first

OpenCode pages sessions by update time. Read newest first, a session updated between two pages jumps back to the first page, behind the cursor, and vanishes from the list, so its folder would look unused. Oldest first, the same write moves it to the end, ahead of the cursor, where the read meets it again. Invalidating on every write instead would restart the read for as long as any session streams.
