# Project-local MCP storage

`../mcp-local.js` owns private MCP persistence. `../mcp-local-plugin.js` materializes
the managed OpenCode plugin. They do not register routes or managed config entries.

## Public APIs

- `createLocalMcpStore({ dataDir })` returns synchronous `read(directory)` and async
  `create(name, config, directory)`, `update(name, updates, directory)` and
  `remove(name, directory)`. Directories and `dataDir` are absolute paths.
- `read` returns `{ path, identity, servers, exists }`. A missing file returns
  `exists: false` and no servers. An authoritative empty file returns `exists: true`.
  Malformed, wrong-version and wrong-identity files throw `MCP_LOCAL_INVALID`.
  Unreadable files throw `MCP_LOCAL_UNREADABLE`. Neither condition grants write authority.
- Mutations return `{ path }`. Creation rejects existing local names. Update and
  removal reject absent local names. Names in lower OpenCode config layers are
  outside this store's ownership and can be overridden by creation here.
- Settings mutations carry the displayed scope as an expected-owner precondition.
  PATCH and DELETE reject a changed owner before dispatching to storage. A stale
  personal editor cannot fall through to a shared file after another window
  removes its local override. Callers without a scope retain owner inference.
- `materializeLocalMcpPlugin({ dataDir })` returns a plugin directory. Its package
  default-exports `{ id: 'openchamber-project-local-mcp', setup }`.

## Identity and format

The reader resolves the location's real directory and walks ancestors for `.git`.
A `.git` file resolves its `gitdir` relative to that checkout. A `commondir` file
resolves relative to the Git directory. The identity is `git:<real common directory>`.
Linked worktrees, subdirectories and directory symlinks share that identity.
Independent clones have different identities, even with identical history or remotes.
Invalid or unreadable Git metadata is an error. No Git process runs.

Outside Git, identity is `directory:<exact real directory>`. A child directory has
its own identity. Moving a checkout's common Git directory or a non-Git directory
changes identity. Old snapshots remain available at their previous identity and
are never automatically deleted or migrated.

Files live at `<dataDir>/mcp-project-local/<sha256(identity)>.json` and contain
`{ version: 1, identity, servers }`. Entries use canonical v2 `McpEntity` fields.
Known fields are validated, including protocol, timeout and OAuth metadata fields
that have no Settings controls. Additional JSON fields survive updates. UI `name`
and `scope` fields are excluded from entries. Updates shallow-merge supplied fields.
`{env:...}` and `{file:...}` references are preserved literally in persistence.

## Writes and recovery

The storage directory and generated plugin directory use mode `0700`. Unique
same-directory temporary files use exclusive creation and mode `0600`. Writes
fsync the temporary file before atomic rename. No repository files are written.
Each read-modify-write holds `source-control/file-lock.js`'s per-snapshot lock, so
separate store instances and host processes preserve unrelated mutations.
The lock helper owns contention deadlines and abandoned-owner recovery.

Failed reads or validation preserve the existing file. Failed publication cleans
its temporary file and releases the lock. The previous snapshot stays valid until
rename succeeds. Removal writes an empty document when deleting the final server.
No secrets or config values are logged. A process killed mid-write can leave a
private unique temporary file; it cannot replace the committed snapshot partially.

## Live plugin

The generated plugin uses Node built-ins only. The host serializes the shared
reader, the canonical JSON value guards from `shared/guards.js`, and plugin setup
with explicit dependency arguments. The generated
directory needs no installed packages and does not import the host's source files.

Each setup resolves only `ctx.location.directory`, watches the containing storage
directory before its initial read, and filters events to its exact hashed filename.
Atomic replacement events coalesce for 20 ms. Changed server data triggers
`ctx.mcp.reload()`. Identical data and other projects' writes trigger no reload.
Reloads run serially. Setup returns async cleanup that closes the watcher, cancels
the timer, prevents queued refreshes and drains an already-running reload.

The same plugin overlays protected MCP selections from
`<dataDir>/mcp-protected/` (see `../../protected-mcp/DOCUMENTATION.md`). It
watches that directory for the global file and this location's project file,
and each selection becomes a `local` entry that starts the protected service's
relay with the connection id. Nothing in a selection is expanded or reaches the
command except the id. Without a readable client configuration the entry runs a
command that exits with an error, so the server fails closed. Protected entries
are set after personal ones and win a name both use. A broken selection file
keeps the last valid protected overlay, independently of the personal one.

Every `ctx.mcp.transform` replay overlays current entries with `editor.set`.
Deletion contributes no entry, so fresh replay restores lower OpenCode layers.
The plugin never calls `editor.remove`. Missing and empty files contribute no
overlay. Malformed or unreadable live changes keep the last valid overlay and
emit a fixed sanitized error. Watch errors also emit a fixed error; no retry or
watcher-recreation policy is added.

## Consumers and validation ownership

- Web and desktop use this module from their shared backend. Main integration
  wires CRUD and the managed config's plugin list.
- Hosted mobile and Capacitor use that backend's CRUD. No native file access is added.
- VS Code bundles these modules into the extension host. Its integration wires
  CRUD and managed launch; generated plugin imports remain self-contained.
- External OpenCode processes receive no implicit plugin injection.
- Enterprise mode leaves MCP entry in Settings unchanged under the existing policy.
  These modules add no network listener or model-provider credential route.

`mcp-local.test.js` covers identity, private CRUD, retained fields, corrupt refusal,
concurrent writers and temporary cleanup. `mcp-local-plugin.test.js` loads the real
generated package and drives per-location transform replay, filesystem events,
last-valid preservation and cleanup. These drivers do not prove compatibility
with a live pinned OpenCode process or Windows filesystem watcher semantics.

The plugin expands `{env:NAME}` and `{file:path}` in string values before
`editor.set`, which does not run OpenCode's file-loader substitutions. Environment
values come from the managed OpenCode process; missing variables expand to an empty
string. File contents are trimmed, `~/` resolves against the host home, and relative
paths resolve against the active location directory. Missing files expand to an
empty string. Other read failures fail the transform without logging values.
Persistence retains literal references. Referenced files are read on transform
replay; they are not watched independently.
