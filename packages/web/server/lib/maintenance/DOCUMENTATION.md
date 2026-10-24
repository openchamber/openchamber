# Database Maintenance Module

## Ownership

`packages/web/server/lib/maintenance/` owns every OpenChamber operation that
rewrites OpenCode's SQLite file. It does not read or write OpenCode's tables;
only page counters, `wal_checkpoint`, `VACUUM` and `integrity_check` run here.

- `database.js`: `createDatabaseMaintenance({ dataDir, getLifecycle, logger, now, fileSystem })`
  returns `{ getOverview, compactNow, scheduleForNextRestart, runQueuedDatabaseCompactionAtStartup }`.
  Owns the job state, the cross-server lock and the persisted last result.
- `vacuum-worker.js`: forked child process that opens the database, checkpoints
  the WAL, runs `VACUUM` and `integrity_check`, and reports steps over IPC. It
  exits when the parent disconnects. The fork uses `helperSpawnEnv` from
  `../git/helper-launch.js` so Electron starts it as Node rather than as a
  second copy of the app.
- `routes.js`: `registerDatabaseMaintenanceRoutes(app, { databaseMaintenance })`
  registers the three HTTP routes. Composition happens in
  `lib/opencode/feature-routes-runtime.js`; the runtime itself is created in
  `server/index.js` right after the OpenCode lifecycle, because it stops and
  starts that lifecycle.

OpenCode's database path comes from `../opencode/opencode-db.js`, the same
resolver the V1 session top-up uses. No route accepts a path.

## HTTP contract

- `GET /api/openchamber/maintenance/database` returns `path`, `inMemory`,
  `exists`, `bytes`, `walBytes`, `pageSize`, `pageCount`, `freelistCount`,
  `reclaimableBytes`, `liveBytes`, `openCodeRunning`, `externalOpenCode`,
  `activeTurns`, `pendingOnNextRestart`, `blockedReason`, `compaction` and
  `lastCompaction`. `blockedReason` is `no-database`,
  `in-memory`, `external`, `sqlite-unavailable`, `busy` or
  `nothing-reclaimable`.
- `POST .../compact` validates, takes the lock and starts the rewrite, then
  answers `202 { compaction }`. Refusals are `409` (`external`, `busy`,
  `nothing-reclaimable`, `no-database`, `in-memory`) or `507`
  (`insufficient-space`), with `{ error, code }`. The client polls the overview
  for `phase`.
- `POST .../compact-on-next-restart` writes `database-compaction.next-start`.
  The flag survives restart, is consumed by
  `runQueuedDatabaseCompactionAtStartup` before the managed child spawns, and
  is removed only after a successful rewrite.

Phases: `stopping`, `checkpoint`, `vacuum`, `integrity`, `restarting`, `done`,
`failed`. The overview reports `compaction` only while a job exists in memory;
`lastCompaction` is persisted to `<dataDir>/maintenance/database-compaction.json`
so Settings can report the last freed size after a restart.

## Invariants

- Never compact while an external OpenCode owns the database. OpenChamber
  cannot stop it, and `VACUUM` would fail on the lock anyway.
- Never start a second rewrite in the same process (`activeJob`) or across
  servers sharing a data dir (`database-compaction.lock`, pid-checked the way
  `instance-dir.js` checks live servers). A stale lock is reclaimed only when
  its pid is gone.
- The managed child is always restarted, including when the job throws. The
  job error is reported after the restart attempt.
- A queued compaction never fails startup and only runs when no managed child
  is running, because the lifecycle calls it before the spawn. A plain startup
  compacts nothing.
- Every rewrite requires free disk of at least `(file + WAL) * 1.10`.
- The last result file holds sizes, trigger and timestamp only. No session
  content, paths or error text.
- Journal actions are fixed: `database compact started`, `database compact
  done`, `database compact failed`, mirrored in
  `packages/ui/src/lib/diagnostics/export.ts`.

## Decisions

### Why a forked worker and not the server process

Both SQLite bindings are synchronous. A multi-gigabyte `VACUUM` would block the
event loop, the HTTP routes and the SSE streams for minutes. The worker also
keeps the database handle out of the server process, so a crash inside the
driver cannot take the UI with it. Progress is step-level because SQLite
exposes no rewrite percentage.

### Why stop the child instead of `auto_vacuum = INCREMENTAL`

Switching `auto_vacuum` requires a full `VACUUM` anyway and changes OpenCode's
schema-level setting behind its back. `PRAGMA incremental_vacuum` can only move
pages already on the freelist and still needs a write lock. Stopping the child
for a full rewrite is the smallest change that works with OpenCode's own
database.

### Why refusals are refused at the route

`compactNow` checks external OpenCode, in-memory database, an existing job,
missing database, an empty freelist and free disk before it returns `202`.
A caller learns immediately; nothing starts and then fails a second later.
