# FS module documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, directory listing, reveal, and background command execution jobs.

## Entrypoints and structure
- `packages/web/server/lib/fs/routes.js`: route registration and runtime-owned state for `/api/fs/*` endpoints.
- `packages/web/server/lib/fs/search.js`: fuzzy filesystem search runtime used by non-FS routes (for example project icon discovery).

## Public exports
- `registerFsRoutes(app, dependencies)` from `routes.js`
  - Registers all filesystem routes:
    - `GET /api/fs/home`
    - `POST /api/fs/mkdir`
    - `GET /api/fs/read`
    - `GET /api/fs/raw`
    - `GET /api/fs/stat`
    - `GET /api/fs/directory-stat`
    - `POST /api/fs/preview`
    - `GET /api/fs/preview/:grant/:path(*)`
    - `POST /api/fs/write`
    - `POST /api/fs/upload`
    - `POST /api/fs/delete`
    - `POST /api/fs/rename`
     - `POST /api/fs/reveal`
     - `POST /api/fs/clone`
     - `POST /api/fs/exec`
    - `GET /api/fs/exec/:jobId`
    - `GET /api/fs/list`
    - `GET /api/fs/git-dirs` — shallow nested git repository discovery for the
      Git tab (depth- and visit-capped readdir walk; `.git` directory, file, or
      symlink marks a repository boundary; junk directories are skipped;
      symlinked directories are followed, each real directory walked once,
      and repositories are reported under the link path)
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Enforces workspace boundary checks with active project + worktree fallback support.
  - The active project directory is validated with `fs.realpath`, so when the project root is itself a symlink the workspace base no longer matches the paths the client sends. Workspace resolution therefore retries against the raw directory the client requested (`requestedDirectory` from `resolveProjectDirectory`) before falling back to worktree roots. Symlinks are still resolved afterwards, and write/exec routes keep their canonical containment check against the resolved base.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional `git check-ignore` filtering.

Both search and directory listing discard `git check-ignore` stderr at spawn.
They consume stdout for ignore matches. Never create an unread stderr pipe:
Git diagnostics can fill it and block the child indefinitely, so repeated
searches accumulate live Git processes. `git-process.test.js` exercises both
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
- Workspace checks accept, besides the active workspace and its worktrees, the **managed roots**: the OpenChamber config root and the managed chats root (`managedChatsRoot` dependency; `OPENCHAMBER_CHATS_DIR` upstream, default `<config root>/chats`). Chat worktrees may legitimately live outside every project workspace.
- `GET /api/fs/home` preserves `{ home, chatsRoot }` and adds `canonicalChatsRoot` and `canonicalLegacyChatsRoot`, resolved by the server's filesystem. If a root does not exist yet, it resolves the nearest existing ancestor and appends the missing segments, without creating directories. Errors resolving the configured root fail the request. A failed legacy lookup warns and omits only that optional alias, retaining exact legacy matching without blocking an accessible relocated root. Clients use confirmed aliases for exact membership while keeping the original roots as folder/scope identities. `chatsRoot` is the server-resolved managed chats root; clients must use it instead of joining `home` + the well-known segment (a relocated root does not contain that segment).
- The server creates the managed chats root at startup (`ensureChatsDir` in `lib/data-dir-migration.js`, called from `main`). The UI reads that folder as soon as a new chat opens, and OpenCode fails every read of a missing folder, so on a fresh install the sidebar used to report "Could not initialize workspace" until the first chat created it. A root that cannot be created only logs a warning.
- Workspace authorization accepts both the configured managed paths and their filesystem-confirmed canonical roots. Canonical lookup runs only when lexical workspace/managed-root checks fail. One failed managed-root lookup cannot reject an independently authorized root or worktree. Path comparisons remain case-sensitive on POSIX: distinct Linux directories named `chats` and `Chats` never become aliases through string folding. Shared UI keeps exact root membership for classification and directory cleanup.
- Filesystem `EPERM`/`EACCES` failures use the stable `reason: "os-permission"` response marker. Workspace-boundary policy denials must not use that marker because a native folder picker cannot remediate them.
- `GET /api/fs/directory-stat?path=...` uses one `stat` without listing contents or resolving project topology. It follows the same authenticated directory-discovery path policy as `/api/fs/list`, including targets outside the active workspace. A directory returns `{ isDirectory: true }`; `ENOENT` returns `not-found`, and a file or `ENOTDIR` returns `not-directory`. Permission and other failures remain distinct from a missing path. VS Code explicitly returns 501, so the shared client treats its probe as unknown.
- HTML previews are untrusted content. `POST /api/fs/preview` (normal API auth, body `{ path }`, workspace resolved like any read) mints a grant `{ grant, expiresAt }` for one page. `GET /api/fs/preview/<grant>/<absolute path>` serves the page and its files: the grant sits in the path, so the page's relative URLs carry it and no session credential appears in a URL the page can read. `core-routes.js` lets these GETs past API auth; the route itself rejects an unknown or expired grant with 403. A grant fixes the workspace base at mint time (the page's project, or the managed root it lives in) and lapses after ten idle minutes; every served file extends it. Every answer carries `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads`, so the page is an opaque-origin document even when opened in its own tab, and the Files view frame has no `allow-same-origin`. Embedding (images, stylesheets, classic scripts) works anywhere the grant's base allows. Reading bytes from script (`fetch`, fonts, module scripts) is a CORS request from origin `null`, answered with `Access-Control-Allow-Origin: null` only inside the grant's read root: the page's project, or for a page inside a managed root, the page's own folder. Other files under `~/.config/openchamber` stay unreadable to the page.
- `GET /api/fs/raw` answers one `Range: bytes=…` span with `206`, `Content-Range` and a stream from disk (`byte-range.js` reduces the header to a span). Media elements send a span on every seek, and Chromium and WebKit refuse to seek without a `206`, so the viewer's audio and video players depend on this; a whole-file request still reads and sends the buffer. The MIME table (`FILE_MIME_MAP`) is shared with `/api/fs/preview` and covers images, PDF, audio, video, fonts, CSV/TSV and Mermaid.
- File read, raw and stat routes accept outside paths with `allowOutsideWorkspace=true` under the normal server authentication and OS permissions. They do not require a separate file grant. Legacy grant parameters are ignored. Workspace-scoped reads resolve symlinks after checking the requested path. Write routes keep canonical-target boundary checks.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller's requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.
- `POST /api/fs/upload` accepts one `application/octet-stream` body with `path` and optional `overwrite=true` query parameters. The body streams into a same-directory temp file with a 100 MiB default cap configurable through `OPENCHAMBER_FS_UPLOAD_MAX_BYTES`; failed and oversized uploads clean up that temp file. New files commit through an atomic no-replace link, existing files return `409` unless overwrite is explicit, directory targets are rejected, and the destination parent resolves before writing so uploads cannot escape through workspace symlinks.
