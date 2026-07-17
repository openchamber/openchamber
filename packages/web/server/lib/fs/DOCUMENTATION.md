# FS Module Documentation

## Purpose
Own filesystem API behavior for the web server runtime, including workspace-bound file operations, repository cloning, directory listing, reveal, and command execution jobs.

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
    - `GET /api/fs/serve/:path(*)`
    - `POST /api/fs/write`
    - `POST /api/fs/delete`
    - `POST /api/fs/rename`
    - `POST /api/fs/reveal`
    - `POST /api/fs/clone`
    - `POST /api/fs/exec`
    - `GET /api/fs/exec/:jobId`
    - `GET /api/fs/list`
  - Delegates repository cloning to the Git service's bounded canonical destination reservation.
  - Delegates `/api/fs/list` ignore filtering to the classified Git service. Its bounded timeout aborts queued/running ignore work and preserves fail-open, unfiltered listing behavior without leaving an unobserved rejection.
  - Owns exec job queue state (`execJobs`) and lifecycle/TTL pruning.
  - Enforces workspace boundary checks with active project + worktree fallback support.
- `createFsSearchRuntime({ fsPromises, path, getIgnoredPaths })` from `search.js`
  - Returns `{ searchFilesystemFiles(rootPath, options) }`.
  - Supports fuzzy matching, hidden-file handling, and optional ignore filtering through the classified Git service.

## Composition contract with `index.js`
- `index.js` provides composition-time dependencies only (platform primitives + callbacks such as `resolveProjectDirectory`, `normalizeDirectoryPath`, and `buildAugmentedPath`).
- `index.js` no longer owns FS route handlers or FS exec job state.

## Notes for contributors
- Keep filesystem policy (workspace root checks, error mapping, exec timeout behavior) inside this module, not in the composition root.
- `/api/fs/exec` executes user-authored shell commands and is an explicit Git-scheduler bypass; do not parse arbitrary commands into Git profiles.
- Owned clone and ignore-check behavior must delegate to the Git service rather than spawning Git directly.
- If adding new `/api/fs/*` endpoints, add them in `routes.js` and extend this document.
