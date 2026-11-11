# Chat directory cleanup

## Ownership

This module removes generated managed chat folders after confirmed host session deletions. `scheduled-tasks/chats-scope.js` and the shared UI own folder creation. The filesystem routes still serve explicit file operations and draft rollback.

## Invariants

- Only the locally managed OpenCode process authorizes cleanup. An external OpenCode and isolated-space events cannot remove host files. A process change retires the previous process's session directory evidence and pending cleanup.
- Session creation and directory updates supply the directory that a deletion event omits. Fork events read the new fork's record through the SDK. A later update or complete snapshot supersedes that read, and a deletion during the read waits for its directory evidence. Each stream connection also seeds the directory index from a complete host session list. A startup list alone supplies no cleanup candidates, and unknown deleted sessions leave their files untouched.
- A fresh list includes every active and archived root, fork and subagent. Every continuation cursor must complete; a terminal cursor object can omit `next` or set it to null. A missing cursor object is a failure. Failed, malformed, repeated or incomplete pages authorize no removal.
- Session mutations during a read or filesystem check invalidate its deletion authority. A batch reads again before removing anything. Cascading deletions share the pending read.
- A remaining session in the folder or any descendant keeps the folder. Lexical descendants and filesystem-confirmed aliases count as references. An unreadable reference retains pending cleanup. Deleting the last session from a nested working directory also reclaims its generated chat folder.
- Eligible paths match the generated date and session layout under the configured or legacy chats root. Shared roots, date buckets, symlinked date buckets and symlinked session folders stay untouched. Configured root symlinks are resolved before checking ownership.
- Cleanup captures the folder and parent identities with exact device and inode values before reading references and checks them again before removal. Ownership capture and cleanup completions belong to the same process and candidate, independently of session inventory freshness. A session event causes a fresh reference read while retaining the original identities. A replacement at either path stays untouched, including after failed cleanup.
- Failed initial inspection leaves the files untouched and discards the automatic candidate because no original identity was established. Once identity is captured, failed reference reads or removal keep the candidate in memory for the next deletion or stream connection. Shutdown aborts reads and prevents new removal. Pending cleanup does not survive a server restart.

## Decisions

### Why cleanup follows confirmed deletions

A chat folder can belong to an unsent draft before OpenCode has a session for it. Scanning the chats root and deleting every unreferenced folder would remove those drafts. Historical orphan folders remain outside this module's ownership.

### Why references come from the host API

Client lists may be unloaded, filtered or missing an event. The server reads the unfiltered global OpenCode list without starting directory locations, so another device's deletion gets the same reference check while forks and archived sessions keep their files.

### Why forks read their own record

OpenCode emits a fork event without its directory. A cached source directory can be stale after a move through another OpenCode process, so cleanup reads the fork's own record and rejects replies superseded by a session update or owner change.
