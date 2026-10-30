# FS module documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/search.js`: fuzzy filesystem search for workspace supplements and project icon discovery.
- `packages/web/server/lib/fs/content-search.js`: find in files, run by ripgrep (`GET /api/fs/find-in-files`).
- `packages/web/server/lib/fs/ripgrep.js`: where the ripgrep binary comes from.

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `GET /api/fs/read`
    - `GET /api/fs/raw`
    - `GET /api/fs/stat`
    - `GET /api/fs/directory-stat`
    - `POST /api/fs/directory-stats` — the batched form of `directory-stat`:
      one request answers `{ results: [{ path, isDirectory, reason? }] }` for
      many paths with the same reason codes, isolating per-path failures.
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
      which the walk goes past: clients ask only for roots that are not
      repositories or have no commits yet, and decide from the root's
      status whether its repository hides the ones below; junk directories are skipped;
      symlinked directories are followed, each real directory walked once,
      and repositories are reported under the link path)
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Exec commands run with the terminal's PATH plus the user's and the project's environment variables for their directory (`environmentRuntime`, see `../environment`).
  - Enforces workspace boundary checks with active project + worktree fallback support.
  - The active project directory is validated with `fs.realpath`, so when the project root is itself a symlink the workspace base no longer matches the paths the client sends. Workspace resolution therefore retries against the raw directory the client requested (`requestedDirectory` from `resolveProjectDirectory`) before falling back to worktree roots. Symlinks are still resolved afterwards, and write/exec routes keep their canonical containment check against the resolved base.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional `git check-ignore` filtering.
   - An empty query stops at `limit` candidates. A query walks the tree until it is exhausted or 10,000 files are inspected (`FILE_SEARCH_MAX_VISITED_FILES`): weak shallow matches would otherwise exhaust a candidate budget before exact deeper matches are ever visited. The ceiling mirrors `packages/vscode/src/bridge-fs-helpers-runtime.ts`, and both suites pin the two runtimes' agreement.

### Why workspace search supplements OpenCode

The shared file-search store keeps OpenCode's indexed hits in their original
order, appends unique filesystem hits for non-default toggles, then applies the
caller's result limit. Replacing the index with the icon-discovery walk would
drop normal results. Web, desktop, hosted mobile and Capacitor use this endpoint;
VS Code forwards the same flags to its extension-host search.

Search ignore checks send and receive NUL-delimited names with
`git check-ignore --stdin -z`, preserving Unicode, whitespace and newlines.
Git's quoted line output cannot be compared directly with filesystem names.

`workspaceSearch: true` searches generated directories such as `build` and
`dist`, excludes only `.git` and `node_modules`, and removes the icon walk's
10,000-file ceiling. A 30-second deadline fails the search rather than returning
an unmarked partial answer. Default icon discovery keeps its existing bounds.

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

Both search and directory listing discard `git check-ignore` stderr at spawn.
They consume stdout for ignore matches. Never create an unread stderr pipe:
Git diagnostics can fill it and block the child indefinitely, so repeated
searches accumulate live Git processes. Both also kill a `check-ignore` child
that has not exited within `OPENCHAMBER_GIT_CHECK_IGNORE_TIMEOUT_MS` (default
2500 ms, `0` disables it) and continue with no ignored names.
`git-process.test.js` exercises both
paths with real OS pipes, twelve concurrent checks, and 2 MiB of diagnostics
per child. Successful completion must preserve ignore filtering and reap all
twelve children.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.
- The composition root passes the Git network operation service's `cloneRepository` adapter. The FS module does not construct or spawn Git for clone.

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
- HTML previews are untrusted content. `POST /api/fs/preview` (normal API auth, body `{ path }`, workspace resolved like any read) mints a grant `{ grant, expiresAt }` for one page. A page outside the workspace is asked for with `allowOutsideWorkspace=true`, as the editor reads it; its grant's base and read root are the page's own folder. `GET /api/fs/preview/<grant>/<absolute path>` serves the page and its files: the grant sits in the path, so the page's relative URLs carry it and no session credential appears in a URL the page can read. `core-routes.js` lets these GETs past API auth; the route itself rejects an unknown or expired grant with 403. A grant fixes the workspace base at mint time (the page's project, or the managed root it lives in) and lapses after ten idle minutes; every served file extends it. Every answer carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`, so the page is an opaque-origin document even when opened in its own tab, and the Files view frame has no `allow-same-origin`. Embedding (images, stylesheets, classic scripts) works anywhere the grant's base allows. Reading bytes from script (`fetch`, fonts, module scripts) is a CORS request from origin `null`, answered with `Access-Control-Allow-Origin: null` only inside the grant's read root: the page's project, or for a page inside a managed root, the page's own folder. Other files under `~/.config/openchamber` stay unreadable to the page. Every HTML file served this way carries `preview-bridge.js` as the first script of its head, so the Files view can run its annotation overlay in the page: the bridge evaluates code posted by the frame's parent and posts the result back. It runs in the page's own sandbox, so it can do only what the page's scripts already can. It is inserted into the bytes after `<head>`, `<html>` or the doctype, never before the doctype, which would switch the page to quirks mode; UTF-16 pages go out unchanged.
- `GET /api/fs/raw` answers one `Range: bytes=…` span with `206`, `Content-Range` and a stream from disk (`byte-range.js` reduces the header to a span). Media elements send a span on every seek, and Chromium and WebKit refuse to seek without a `206`, so the viewer's audio and video players depend on this. A whole-file request streams from disk the same way, so a large PDF or recording never sits in server memory. The MIME table (`FILE_MIME_MAP`) is shared with `/api/fs/preview` and covers images, PDF, audio, video, fonts, CSV/TSV and Mermaid.
- File read, raw and stat routes accept outside paths with `allowOutsideWorkspace=true` under the normal server authentication and OS permissions. They do not require a separate file grant. Legacy grant parameters are ignored. Workspace-scoped reads resolve symlinks after checking the requested path. Write routes keep canonical-target boundary checks.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `routes.js` and the sibling modules it imports (`byte-range.js`, `workspace-file-names.js`, `content-search.js`, `../shared/guards.js`, `../git/redaction.js`, `../path-realpath-cache.js`) load with Node built-ins only: `routes.test.js` imports a copy of them in a bare Node process without `node_modules`, the way a packaged desktop build once failed to load them. A new sibling module goes into that test's copy list and takes its value guards from `../shared/guards.js` rather than from a dependency.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller's requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.
- `POST /api/fs/upload` accepts one `application/octet-stream` body with `path` and optional `overwrite=true` query parameters. The body streams into a same-directory temp file with a 100 MiB default cap configurable through `OPENCHAMBER_FS_UPLOAD_MAX_BYTES`; failed and oversized uploads clean up that temp file. New files commit through an atomic no-replace link, existing files return `409` unless overwrite is explicit, directory targets are rejected, and the destination parent resolves before writing so uploads cannot escape through workspace symlinks.
