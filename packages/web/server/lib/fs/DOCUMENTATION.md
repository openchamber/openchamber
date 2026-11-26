# FS module documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and command execution.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.ts`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/search.ts`: fuzzy filesystem search for workspace supplements and project icon discovery.
- `canonical-path.ts` resolves existing path aliases and missing descendants without creating folders. Filesystem authorization and chat-directory cleanup share it so a missing child cannot hide its existing ancestor's identity. Permission, symlink-loop and non-directory failures propagate.
- `packages/web/server/lib/fs/content-search.ts`: find in files, run by ripgrep (`GET /api/fs/find-in-files`).
- `packages/web/server/lib/fs/ripgrep.ts`: where the ripgrep binary comes from.
- `folder-change-watch.ts` owns signal-driven fingerprint/settle scheduling for extension packages, custom themes and settings files. Each root has one watcher, one 30-second safety interval and at most one pending fast check. Its first fingerprint starts at creation; stop closes the watcher, cancels timers and suppresses in-flight results. A changed fingerprint becomes reported only after its awaited notification succeeds, so a failed publication can be retried.
- `text-write.ts` writes the Files panel's text saves for `POST /api/fs/write`: in place, one write per path at a time (see the decision on text writes below).
- `packages/web/server/lib/fs/exec-command.ts`: runs one command in a workspace directory for `POST /api/fs/exec`. The timeout always answers and closes both output pipes; it signals the command's process group on POSIX and attempts a tree kill on Windows, falling back to the shell alone.

### Why folder change checks retain a safety interval

The interval reopens the watcher before checking, so Linux/Windows folder deletion and recreation recovers even when the old watcher emits nothing. A failed, errored or closed watcher uses the caller's fast cadence until a safety tick restores it; healthy roots read files only on signals, settling checks and safety ticks.

### Why a timed-out command answers from the timer

The timeout kills the command and then answers from the timer instead of waiting for the child's `close` event. A command the shell started inherits the stdout pipe and can outlive the shell, so `close` may never arrive and the request would hang for as long as that command runs. Do not simplify this back to a `close`-only answer.

A timed-out result carries `success: false`, the timeout error and the output captured until then, within the job's output limit. It has no exit code and no signal name, because the timer answers before the killed process reports either.

### How the timeout stops the command's processes

The shell is only the parent of what it runs. On POSIX the shell is spawned `detached`, so it leads its own process group and the kill can signal that group as a whole. A descendant that moves to a process group of its own (`setsid`, a daemonizing command) is outside it and survives; on Windows the kill runs `%SystemRoot%\System32\taskkill.exe` with `/T /F`. A pid that is missing, not an integer, 0 or 1 kills the shell alone: `kill(-0)` would signal the server's own process group and `kill(-1)` every process the server may signal.

On Windows the tree kill is best effort. When `taskkill.exe` cannot start, or exits nonzero, only the shell is killed, and a command it started can outlive the timeout. The answer never waits for that cleanup.

`detached` also means a signal aimed at the server's group no longer reaches an in-flight command. The module therefore tracks every running command, and graceful shutdown (`../server-frame/shutdown-runtime.ts`) first closes command admission, so a later command in a running batch or a request still resolving its workspace is answered `Server is shutting down` without starting, then kills every running command the same way the timeout does and waits for that, on Windows until `taskkill.exe` and its fallback finish, at most 5 seconds. A hard kill of the server skips this, and an in-flight command then runs until it exits on its own.

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - `runCommandInDirectory({ shell, shellFlag, command, resolvedCwd, maxOutputBytes, spawn, execEnv, commandTimeoutMs })` from `exec-command.js` runs one command and always settles, with at most `maxOutputBytes` of captured output.
  - `stopActiveCommands()` from `exec-command.js` refuses every later command, kills every running command as the timeout does and resolves when the kills finish; graceful shutdown calls it.
  - `killCommandTree(child, spawn, options)` from `exec-command.js` signals the command's POSIX process group, or on Windows runs `taskkill /T /F` with a shell-only fallback, and resolves when that is done. `platform`, `kill` and `systemRoot` are injectable for tests; the async `killProcessTree` in the spaces runner is a separate implementation with its own wait.
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `GET /api/fs/read`
    - `GET /api/fs/raw`
    - `GET /api/fs/stat`
    - `GET /api/fs/directory-stat`
    - `POST /api/fs/directory-stats` — the batched form of `directory-stat`:
      one request answers `{ results: [{ path, isDirectory, reason?, realPath? }] }` for
      many paths with the same reason codes, isolating per-path failures.
      A directory also carries `realPath`, the path with links followed, when
      `realpath` resolves it: settings store a project under that path, so the
      Add project dialog uses it to show a link to an added project as added.
    - `POST /api/fs/preview`
    - `GET /api/fs/preview/:grant/:path(*)`
    - `POST /api/fs/write`
    - `POST /api/fs/upload`
    - `POST /api/fs/delete`
    - `POST /api/fs/rename` — renames or moves within one workspace root and
      never replaces an existing destination: it returns `409` with
      `reason: 'already-exists'`, except for a case-only rename where the
      destination is the source itself. The check runs before the rename, so
      a file created in between can still be replaced. Moving a folder into
      itself or into one of its subfolders returns `400`; a missing source
      returns `404` with `reason: 'not-found'`.
     - `POST /api/fs/reveal`
     - `POST /api/fs/clone`
     - `POST /api/fs/exec`
    - `GET /api/fs/exec/:jobId`
     - `GET /api/fs/list`
     - `GET /api/fs/search` returns `{ files }` with name, absolute path,
       relative path and extension. It accepts `directory` (active workspace
       when omitted), `query`, `limit` (default 60, clamped to 1..500),
       `includeHidden=true` and `respectGitignore=false`. Paths stay under the
       requested root, including symlink aliases.
    - `GET /api/fs/find-in-files` — find in files, see below.
    - `GET /api/fs/git-dirs` — shallow nested git repository discovery for the
      Git tab (breadth-first readdir walk, capped at depth 3 and 100 visited
      directories so shallow repositories are checked before deeper folders;
      `.git` directory, file, or
      symlink marks a repository boundary, except the root's own `.git`,
      which the walk goes past: a root repository's submodules and nested
      checkouts are reported too, and the client decides whether the root or
      a discovered repository is the one a surface works in; junk directories are skipped;
      symlinked directories are followed, each real directory walked once,
      and repositories are reported under the link path)
  - Returns completed command results on POST and retains recent results for GET by job ID. Background execution is refused.
  - Exec commands run with the terminal's PATH plus the user's and the project's environment variables for their directory (`environmentRuntime`, see `../environment`).
  - Enforces workspace boundary checks with active project + worktree fallback support.
  - The active project directory is validated with `fs.realpath`, so when the project root is itself a symlink the workspace base no longer matches the paths the client sends. Workspace resolution therefore retries against the raw directory the client requested (`requestedDirectory` from `resolveProjectDirectory`) before falling back to worktree roots. Symlinks are still resolved afterwards, and write/exec routes keep their canonical containment check against the resolved base.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
   - Supports fuzzy matching, hidden-file handling, and optional Git ignore filtering.
   - An empty query stops at `limit` candidates. A query walks the tree until it is exhausted or 10,000 files are inspected (`FILE_SEARCH_MAX_VISITED_FILES`): weak shallow matches would otherwise exhaust a candidate budget before exact deeper matches are ever visited. The ceiling mirrors `packages/vscode/src/bridge-fs-helpers-runtime.ts`, and both suites pin the two runtimes' agreement.

### Why workspace search supplements OpenCode

The shared file-search store keeps OpenCode's indexed hits in their original
order, appends unique filesystem hits for non-default toggles, then applies the
caller's result limit. Replacing the index with the icon-discovery walk would
drop normal results. Web, desktop, hosted mobile and Capacitor use this endpoint;
VS Code forwards the same flags to its extension-host search.

Git ignore reads use NUL-delimited paths, preserving Unicode, whitespace and
newlines. Git's quoted line output cannot be compared directly with filesystem
names.

`workspaceSearch: true` searches generated directories such as `build` and
`dist`, excludes only `.git` and `node_modules`, and removes the icon walk's
10,000-file ceiling. A 30-second deadline fails the search rather than returning
an unmarked partial answer. Default icon discovery keeps its existing bounds.

When the client closes the response (a new letter aborted the request) the walk
stops at its next batch, starts no more Git reads, kills the running one and
sends nothing. Typing a name otherwise leaves one whole-tree walk per letter
running at once. VS Code stops its own walk through `api:fs:search:abort`.

### Why a stopped walk kills Git without `taskkill /T`

On Windows the spawned `git.exe` is Git for Windows' launcher, so the kill leaves
the real `git` to finish that one read, about 250 ms in a 20,000-file checkout.
`taskkill` would start one more process per stopped read, on a path that exists
to start fewer. The Git service's untracked listing uses it because that listing
can walk for a minute.

### Why workspace search reads ignored paths per repository

Workspace search runs `git ls-files --others --ignored --exclude-standard
--directory -z` once per repository in each query. Per-directory `check-ignore`
spawned hundreds of Git processes in a copied checkout; batching its input still
repeated path checks. Git's ignored-path listing keeps tracked files visible,
applies nested ignore and negation rules, and collapses fully ignored directories
so the filesystem walk can prune them. A nested `.git` file or directory starts
a separate read in that repository's context. A wholly ignored search root can
be reported as `./`; it excludes that root's contents. Git keeps directories with
tracked descendants expanded, preserving their tracked exceptions.
The reads live only for the current
query, so later queries see changed ignore rules and cannot share state across
requested roots. Icon discovery retains per-directory `check-ignore` and its
bounded walk.

### Find in files

`GET /api/fs/find-in-files?query=…&regex=true|false&limit=…&includeHidden=true&respectGitignore=false`
searches the active workspace (resolved like every other fs route, from the
`x-opencode-directory` header) for lines containing `query`, as text unless
`regex=true`. ripgrep runs the search (`content-search.js`), so what it covers
is what the file tree shows: `.gitignore` rules apply unless
`respectGitignore=false`, hidden entries stay out unless `includeHidden=true`,
binary files are skipped, and `.git` and `node_modules` never take part. A
lowercase query matches any case; one with a capital letter matches exactly
(`--smart-case`). The user's ripgrep configuration is ignored (`--no-config`).

The answer is `{ matches, stopped }`. Each match is one line:
`{ path, relativePath, line, column, text, ranges, cutStart }`, where `column`
is the 1-based position of the first match in the original line, `text` is the
line without indentation, cut to at most 200 characters, and `ranges` are
`[start, end)` offsets inside `text` (UTF-16 code units, converted from
ripgrep's byte offsets). A match more than 48 characters into a line is shown
with 24 characters before it and `cutStart: true`. ripgrep runs in the
canonical project directory, but `path` is built under the directory the client
requested (`requestedDirectory`), so a project opened through a symlink gets the
same paths as its file tree. Matches are sorted by path,
then line.

`limit` defaults to 200 and is capped at 500; when it is reached the process
is killed and `stopped` is `'limit'`. A search running for 30 seconds is killed
too and answers what it found with `stopped: 'deadline'`. Neither is an error.
When the client closes the response (a new keystroke aborted the request) the
process is killed and nothing is sent. A failed search is never an empty one:
an invalid regular expression answers `400` with `reason: 'invalid-pattern'`
and ripgrep's reason as `error`; a server without ripgrep answers `501` with
`reason: 'search-unavailable'`; any other failure answers `500` with
`reason: 'search-failed'`. ripgrep exits with code 2 after a search that found
matches but could not read every file, which counts as a success.

ripgrep itself (`ripgrep.js`, composed in `feature-routes-runtime.js`) is taken
from, in order: `Resources/ripgrep` in a packaged desktop build, staged for the
target architecture by `packages/electron/scripts/prepare-ripgrep.mjs`; the
`@vscode/ripgrep` platform package, an optional dependency of this package that
npm and Bun install for the current platform; `rg` on the PATH user commands
get. A found binary is kept for the process lifetime; a miss is looked up again
on the next search. The stderr pipe is read to the end, for the reason below.

Both search and directory listing discard Git ignore-read stderr at spawn.
They consume stdout for ignore matches. Never create an unread stderr pipe:
Git diagnostics can fill it and block the child indefinitely, so repeated
searches accumulate live Git processes. Both also kill a `check-ignore` child
that has not exited within `OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS` (default
2500 ms, `0` disables it) and continue with no ignored names.
`git-process.test.js` exercises both
paths with real OS pipes, twelve concurrent checks, and 2 MiB of diagnostics
per child. Successful completion must preserve ignore filtering and reap all
twelve children. Workspace search applies the same timeout and fallback to its
`ls-files` child.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.
- The composition root passes the Git network operation service's `cloneRepository` adapter. The FS module does not construct or spawn Git for clone.

## Invariants

- Missing chat roots retain the existing ancestor's disk casing, so the first directory creation and later OpenCode sessions address the same root.
- Watch signals request fingerprint checks. A changed fingerprint is reported only after 2 consecutive equal checks, so callers observe settled changes.
- An aborted workspace search never publishes results. A killed Git ignore read yields no ignored paths, so publishing that walk could expose an unfiltered answer.
- Repository discovery skips unreadable descendants while root failures reach the route's shared error mapping. A bad subtree cannot hide other discoverable repositories.
- An exec job captures at most 1 MiB of raw output across stdout, stderr and all commands. Each result that loses output reports `outputTruncated: true` in both POST and GET. The marker leaves the command's exit status unchanged.
- Completed exec results expire after 30 idle minutes, even without more requests. The store holds at most 64 results and 16 MiB of encoded response data. It evicts the least recently completed or read result first. The store keeps the JSON body POST sent, encoded once, so the bytes it counts are the bytes on the wire and GET returns the same body. A response too large for the store is returned by POST only.

## Decisions

### Why canonicalization stops at the parent

Write, delete, rename and mkdir canonicalize the parent directory through `canonicalDirectoryPath` and re-check containment against the canonical workspace base, because the lexical resolution above accepts `<workspace>/link/x` for any `link` inside the workspace. Write also canonicalizes an existing target, so writing through a symlink file cannot land outside. The authorized base is canonicalized the same way, through its nearest existing ancestor, so a chats root that does not exist yet and is reached through a home alias still contains its first folder. Mkdir of the authorized base itself follows a link at the base, as `mkdir` does, so a base reached through an alias stays creatable. These checks live in `workspace-target.ts`.

The rejected alternative is canonicalizing the whole target for every route. It reads as stricter, and it changes what delete and rename mean: `realpath` on a symlink returns its target, so deleting `<workspace>/note` would delete the file it points at outside the workspace instead of removing the link, and renaming would move that target. Keeping the leaf as the caller wrote it keeps link semantics while the parent check keeps the operation inside the boundary. The upload route already worked this way, and this is the same shape.

A concurrent swap of the link between canonicalization and the operation can still land outside; closing that needs dirfd-relative operations, which neither this module nor the upload route has.

### Why only a chat's session folder falls back to the chats root

A project such as the home directory can contain the chats root lexically while a link or junction puts the real folder elsewhere. Checked against the project, creating the first chat of a day answers 403. When the workspace check refuses, mkdir and delete of `<chats root>/<YYYY-MM-DD>/session-<id>` therefore repeat the same canonical containment check with the chats root as the base. `containedChatSessionFolder` in `workspace-target.ts` owns that rule. Checking the chats root first would refuse a target behind a day folder that links elsewhere inside the project, which the workspace check allows.

The rejected alternative is picking the deepest root for every route. Rename requires both paths to share a base, so it would refuse moves between a project and a managed folder inside it, and an HTML preview would get a narrower read root.

### Why route inputs retain property and string guards

HTTP bodies and thrown values expose only optional unchecked properties until
their existing tests succeed. Property-access guards accept non-null primitives
as JavaScript does; object-only error checks still exclude primitives and functions.
Directory normalization preserves non-string inputs, so its generic overload
does not promise that an unchecked preview path becomes a string. Exec commands
remain unchecked array elements until each command passes its string test.
The optional file-miss predicate retains the exact four accepted error codes.

`FsRouteDependencies` owns the composition contract. Search accepts a nullable
`resultRoot` because the project resolver can return null and the search already
falls back with `options.resultRoot || rootPath`. Source imports retain `.js`
specifiers, including the converted `../path-realpath-cache.ts` helper.

### Why download filenames retain an ASCII fallback

RFC 5987 clients receive the encoded full name through `filename*`; older clients
receive the same name with every non-ASCII character removed through `filename`.
The ASCII Unicode property expresses the original byte-range filter without a
control-character regular expression.

### Why folder watchers share a timer contract with their test clock

Native timers and the deterministic clock have different handles. The watcher
keeps the handle type supplied by its clock so cancellation uses that same type.
The harness supplies clock advancement and watch signals without OS waits.

### Why search checks pipe and ignore-read occupancy

The spawn options request stdout and, for `check-ignore`, stdin. Missing pipes
follow the existing failed-read fallback. Each workspace ignore map entry holds
the query's pending read before the walk consumes it; an absent entry is an
invariant failure.

### Why the bare Node import test strips types from copied helpers

The test copies helpers as JavaScript into a directory without dependencies or
the source resolver. Removing type syntax from those copies preserves its check
of the packaged JavaScript import graph.

### Why project discovery uses JavaScript realpath and not native realpath

Project probes use the same JavaScript `fs.realpath` as settings. Native realpath also resolves Windows `subst` and mapped drives, changing the identity settings retain and preventing recognition of an already-added project.

### Why Git path reads share a bounded cache and not arbitrary exec results

Repository path metadata stays effectively static during a short TTL, so a shared read absorbs repeated client initialization requests. Only successful allowlisted, side-effect-free `rev-parse` queries enter the cache; transient failures remain retryable, LRU hits preserve the original expiry, and entry-count and byte bounds limit growth in long-lived deployments.

### Why exec keeps draining output after the capture limit

Leaving a pipe unread can block the command on a write. The runner discards bytes beyond the limit and retains each stream's valid UTF-8 prefix. Settling the command ends capture even if a pipe stays open. Completed Git reads enter the cache only if their output is complete, and a hit must fit the remaining budget. In-flight reads share only when their budgets match.

### Why exec result reads also check wall time

The expiry timer releases output when no client reads it. A host can sleep past the wall-clock deadline before that timer fires. GET checks the deadline before refreshing an entry, so it cannot revive an expired result.

### Why repeated Git reads reuse environment state and not refresh commands

Automatic Git path queries reuse the directory's environment variables without rerunning its environment command. Other exec commands may refresh that state while retaining the terminal's augmented PATH.

### Why raw responses serve single ranges and not multipart bodies

The media viewer's consumers request single spans, so multi-range headers receive the whole file without multipart machinery. Streaming keeps large recordings and PDFs out of server memory; empty files bypass range streams, files open before span headers commit, and response closure destroys the stream because `pipe()` alone can leave a paused source holding its file handle.

### Why text writes overwrite the file in place and not truncate it or rename a temporary file

`/api/fs/write` saves files the user edits in the Files panel, so it writes the way an editor does: it opens the existing file, overwrites its bytes from the start, then truncates the old tail. A reader never sees the file empty, which is what the earlier `O_TRUNC` race broke. A same-directory temporary file renamed over the target was the previous design; it creates and renames entries in the folder, and watchers on the project (watchexec, dev servers) see that as a change of the folder itself, pass it through their extension filters and restart on every save. It also replaced the file with a new one, losing its mode (an executable script lost `+x`) and its hard links. A new file is created with `wx`, so a dangling link cannot create its target outside the workspace. Writes to one path run one after another inside the server, because two interleaved writes would let the later truncate pad or cut the other's bytes. The cost is that a reader in the middle of a write can see the new start with the old tail, and a crash or a full disk then leaves a partly written file, as in other editors; the Files panel keeps the draft and shows the save error, so saving again recovers it. The unchanged-content check runs inside the same queue, so it sees the result of every earlier save to that path. OpenChamber's own state files never go through this route and keep their atomic writers. Reads still retry an unexpectedly empty result when the preceding stat reports content, because other programs can truncate between stat and read. New uploads publish a flushed same-directory temporary file through a no-replace hard link so a racing destination remains intact.

### Why content search consumes chunks incrementally and not repeated growing buffers

Minified files can produce lines tens of megabytes long. Pending chunks are joined once per complete line, sorted byte offsets advance through newly decoded bytes only, and stderr keeps draining after the retained diagnostic limit so the child cannot block on a full pipe.

### Why search errors select a diagnostic line and not the whole stderr preamble

Ripgrep's invalid-pattern diagnostics include the pattern and a caret before the useful `error:` line. Search failures show that reason when present and otherwise use the first diagnostic line.

### Why preview annotation uses a parent bridge and byte-preserving injection

The preview's opaque origin prevents direct app access, so only messages from the frame's parent can request evaluation inside the page's existing sandbox permissions. Injection uses a latin1 view to keep byte offsets and preserve ASCII-compatible encodings; placing the script after the document anchor preserves standards mode, and UTF-16 pages remain unchanged.

### Why desktop ripgrep uses a staged binary and not the build host's package

Cross-built desktop apps require the target architecture's staged binary because the optional npm package matches the build host. Failed lookups remain uncached so installing ripgrep makes a later search work without restarting the server.

### Why bare-name lookups share a workspace listing and not one Git process per name

Git startup and Windows untracked-file walks make repeated name lookups expensive, so concurrent requests share a short-lived workspace listing. A deadline and output-size cap bound the work and retained data; Git failure or a non-repository directory yields no match.

### Why Windows folder reveal uses the default handler and not Explorer selection

Opening a folder through its default handler respects replacement file managers. File selection inside a folder remains Explorer-specific. `windows-shell-open.ts` runs both through PowerShell `Start-Process`, and the desktop app's project header button imports the same helper so every way to open a project folder lands in the same file manager.

### Why the Windows reveal path travels in an environment variable and not in the command text

PowerShell ends a single-quoted string at `'` and also at the typographic quotes U+2018 to U+201B, which folder names carry after autocorrect. With the path inside the command, `Bob’s app` failed to open, and a folder named `x’;calc;’` ran `calc`. Read from `$env:` the path is never parsed as code, so no escaping rule has to keep up with PowerShell's quote set.

## Legacy clone route

`POST /api/fs/clone` remains for existing clients. It requires `unverifiedConfirmed: true` alongside `remoteUrl`, `destinationPath`, and optional `gitIdentityId`. Without explicit confirmation it returns `409 GIT_NETWORK_OPERATION_REQUIRED` before filesystem or Git work. First-party clients use the planned clone intent instead. If `destinationPath` names an existing directory or ends in a path separator, the route appends the repository name inferred from `remoteUrl`. Otherwise it treats the resolved path as the exact clone target.

The route rejects an existing exact target with `409`. It delegates the resolved target and confirmation to the Git network operation service. A successful response remains `{ success: true, path, output }`; `path` is the exact absolute target and `output` is redacted compatibility output, currently an empty string. A retained checkout after binding or cleanup failure returns HTTP 200 with `{ success: false, state: 'partial', setupRequired: true, path, operationId, error }`. Clients must finish setup on that path, not retry clone. The route never returns raw Git stdout, stderr, credential-bearing endpoints, or private filesystem details in error text.

The Git service validates a selected commit identity before planning or spawning and applies it to the operation-owned temporary checkout. It then exclusively claims the destination and publishes each checkout node with no-replace operations. Failed publication moves the destination root to an operation-private same-parent quarantine before checking recorded identities and contents. Exact operation-owned trees are deleted only from quarantine. Changed trees are restored without overwrite when possible; restore conflicts remain quarantined and make cleanup fail. The temporary checkout follows the same rename-first rule, and recursive deletion never targets either original pathname. See `../git/DOCUMENTATION.md` for the canonical clone protocol, deadline, publication ownership, cleanup, transport, and runtime contracts.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- Keep Git process, transport, credential, cancellation, and clone cleanup policy in the Git network operation service. The legacy clone handler may resolve its compatibility target and map the service result, but must not spawn Git.
- Workspace checks accept, besides the active workspace and its worktrees, the **managed roots**: the OpenChamber config root and the managed chats root (`managedChatsRoot` dependency; `OPENCHAMBER_CHATS_DIR` upstream, default `<config root>/chats`). Chat worktrees may legitimately live outside every project workspace. With no project directory resolved, only the chats roots are accepted: the managed chats root and `<config root>/chats`, each also by its canonical path. A first chat then works on an install with no project; the rest of the config root still needs a resolved project.
- `GET /api/fs/home` preserves `{ home, chatsRoot }` and adds `canonicalChatsRoot` and `canonicalLegacyChatsRoot`, resolved by the server's filesystem. If a root does not exist yet, it resolves the nearest existing ancestor and appends the missing segments, without creating directories. Errors resolving the configured root fail the request. A failed legacy lookup warns and omits only that optional alias, retaining exact legacy matching without blocking an accessible relocated root. Clients use confirmed aliases for exact membership while keeping the original roots as folder/scope identities. `chatsRoot` is the server-resolved managed chats root; clients must use it instead of joining `home` + the well-known segment (a relocated root does not contain that segment).
- The server creates the managed chats root at startup (`ensureChatsDir` in `lib/data-dir-migration.js`, called from `main`). The UI reads that folder as soon as a new chat opens, and OpenCode fails every read of a missing folder, so on a fresh install the sidebar used to report "Could not initialize workspace" until the first chat created it. A root that cannot be created only logs a warning.
- Workspace authorization accepts both the configured managed paths and their filesystem-confirmed canonical roots. Canonical lookup runs only when lexical workspace/managed-root checks fail. One failed managed-root lookup cannot reject an independently authorized root or worktree. Path comparisons remain case-sensitive on POSIX: distinct Linux directories named `chats` and `Chats` never become aliases through string folding. Shared UI keeps exact root membership for classification and directory cleanup.
- Filesystem `EPERM`/`EACCES` failures use the stable `reason: "os-permission"` response marker. Workspace-boundary policy denials must not use that marker because a native folder picker cannot remediate them.
- `GET /api/fs/directory-stat?path=...` uses one `stat` without listing contents or resolving project topology. It follows the same authenticated directory-discovery path policy as `/api/fs/list`, including targets outside the active workspace. A directory returns `{ isDirectory: true }`; `ENOENT` returns `not-found`, and a file or `ENOTDIR` returns `not-directory`. Permission and other failures remain distinct from a missing path. VS Code explicitly returns 501, so the shared client treats its probe as unknown.
- HTML previews are untrusted content. `POST /api/fs/preview` (normal API auth, body `{ path }`, workspace resolved like any read) mints a grant `{ grant, expiresAt }` for one page. A page outside the workspace is asked for with `allowOutsideWorkspace=true`, as the editor reads it; its grant's base and read root are the page's own folder. `GET /api/fs/preview/<grant>/<absolute path>` serves the page and its files: the grant sits in the path, so the page's relative URLs carry it and no session credential appears in a URL the page can read. `core-routes.js` lets these GETs past API auth; the route itself rejects an unknown or expired grant with 403. A grant fixes the workspace base at mint time (the page's project, or the managed root it lives in) and lapses after ten idle minutes; every served file extends it. Every answer carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`, so the page is an opaque-origin document even when opened in its own tab, and the Files view frame has no `allow-same-origin`. Embedding (images, stylesheets, classic scripts) works anywhere the grant's base allows. Reading bytes from script (`fetch`, fonts, module scripts) is a CORS request from origin `null`, answered with `Access-Control-Allow-Origin: null` only inside the grant's read root: the page's project, or for a page inside a managed root, the page's own folder. Other files under `~/.config/openchamber` stay unreadable to the page. Every HTML file served this way carries `preview-bridge.js` as the first script of its head, so the Files view can run its annotation overlay in the page: the bridge evaluates code posted by the frame's parent and posts the result back. It runs in the page's own sandbox, so it can do only what the page's scripts already can. The same tag first replaces `localStorage`, `sessionStorage` and `document.cookie`, which throw in an opaque origin, with in-memory storage and an empty cookie. It is inserted into the bytes after `<head>`, `<html>` or the doctype, never before the doctype, which would switch the page to quirks mode; UTF-16 pages go out unchanged.
- `GET /api/fs/raw` answers one `Range: bytes=…` span with `206`, `Content-Range` and a stream from disk (`byte-range.js` reduces the header to a span). Media elements send a span on every seek, and Chromium and WebKit refuse to seek without a `206`, so the viewer's audio and video players depend on this. A whole-file request streams from disk the same way, so a large PDF or recording never sits in server memory. The MIME table (`FILE_MIME_MAP`) is shared with `/api/fs/preview` and covers images, PDF, audio, video, fonts, CSV/TSV and Mermaid.
- File read, raw and stat routes accept outside paths with `allowOutsideWorkspace=true` under the normal server authentication and OS permissions. They do not require a separate file grant. Legacy grant parameters are ignored. Workspace-scoped reads resolve symlinks after checking the requested path. Write, delete, rename and mkdir canonicalize the parent directory, and the existing target for write, before the boundary check, so a directory symlink inside the workspace cannot carry the operation outside it. Renaming or deleting a symlink acts on the link itself, not on its target.
- Read, raw and stat preserve whitespace in absolute file targets. These paths are already resolved filenames; applying pasted-directory cleanup would read a different file. Relative and tilde inputs keep directory normalization, and workspace and symlink authorization remain unchanged.
- `GET /api/fs/stat?optional=true` answers `{ path, exists: false }` without error logging for `ENOENT`, `ENOTDIR`, `EINVAL`, and `ENAMETOOLONG` from the target's `realpath` or `stat`. Chat-token probes can produce invalid paths or invalid ASAR names, so these expected misses stay quiet. Unexpected failures such as `EIO`, `EMFILE`, and internal errors still log and return `500`; OS permission errors remain `403`. Without `optional=true`, a missing path returns `404` and other non-permission failures log and return `500`. VS Code's local filesystem proxy is unchanged and retains its own error mapping.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `routes.js` and the sibling modules it imports load with Node built-ins only: `routes.test.js` imports a copy of them in a bare Node process without `node_modules`, the way a packaged desktop build once failed to load them. A new sibling module goes into that test's copy list and takes its value guards from `../shared/guards.js` rather than from a dependency.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller's requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.
- `POST /api/fs/upload` accepts one `application/octet-stream` body with `path` and optional `overwrite=true` query parameters. The body streams into a same-directory temp file with a 100 MiB default cap configurable through `OPENCHAMBER_FS_UPLOAD_MAX_BYTES`; failed and oversized uploads clean up that temp file. An oversized body is rejected with `413` carrying `reason: 'too-large'` and the effective `maxBytes`, so a client can name the limit it hit. A path that resolves outside the workspace is rejected with `403` carrying `reason: 'outside-workspace'`. New files commit through an atomic no-replace link, existing files return `409` unless overwrite is explicit, directory targets are rejected, and the destination parent resolves before writing so uploads cannot escape through workspace symlinks.
