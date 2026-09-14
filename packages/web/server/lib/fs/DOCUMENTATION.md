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
    - `GET /api/fs/serve/:path(*)`
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
      symlink marks a repository boundary; junk directories and symlinks are
      never descended into)
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Enforces workspace boundary checks with active project + worktree fallback support.
  - The active project directory is validated with `fs.realpath`, so when the project root is itself a symlink the workspace base no longer matches the paths the client sends. Workspace resolution therefore retries against the raw directory the client requested (`requestedDirectory` from `resolveProjectDirectory`) before falling back to worktree roots. Symlinks are still resolved afterwards, and write/exec routes keep their canonical containment check against the resolved base.
- `createFsSearchRuntime({ fsPromises, path, spawn, resolveGitBinaryForSpawn })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional `git check-ignore` filtering.

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
- `GET /api/fs/home` answers `{ home, chatsRoot }`. `chatsRoot` is the server-resolved managed chats root; clients must use it instead of joining `home` + the well-known segment (a relocated root does not contain that segment).
- Filesystem `EPERM`/`EACCES` failures use the stable `reason: "os-permission"` response marker. Policy denials such as workspace-boundary or missing-grant failures must not use that marker because a native folder picker cannot remediate them.
- `GET /api/fs/directory-stat?path=...` uses one `stat` without listing contents or resolving project topology. It follows the same authenticated directory-discovery path policy as `/api/fs/list`, including targets outside the active workspace. A directory returns `{ isDirectory: true }`; `ENOENT` returns `not-found`, and a file or `ENOTDIR` returns `not-directory`. Permission and other failures remain distinct from a missing path. VS Code explicitly returns 501, so the shared client treats its probe as unknown.
- Read-only routes authorize the requested path against the workspace before resolving symlinks. A symlink reached through the workspace may therefore target a file outside it, while a directly requested outside path still requires an exact-path grant. Write routes keep canonical-target boundary checks.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
- `GET /api/fs/list` may resolve symlinks with `realpath` to read directory contents, but the response `path` and each entry `path` must stay in the caller's requested path space (`path.join(requestedPath, name)`). Returning real paths breaks file-tree expansion for directories reached through workspace symlinks.
- `POST /api/fs/upload` accepts one `application/octet-stream` body with `path` and optional `overwrite=true` query parameters. The body streams into a same-directory temp file with a 100 MiB default cap configurable through `OPENCHAMBER_FS_UPLOAD_MAX_BYTES`; failed and oversized uploads clean up that temp file. New files commit through an atomic no-replace link, existing files return `409` unless overwrite is explicit, directory targets are rejected, and the destination parent resolves before writing so uploads cannot escape through workspace symlinks.
