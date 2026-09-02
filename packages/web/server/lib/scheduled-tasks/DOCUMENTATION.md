# Scheduled Tasks module

Server-owned scheduled task runtime and routes for OpenChamber-only automation.

## Scope

- Per-project scheduled task persistence is owned by `packages/web/server/lib/projects/project-config.js`.
- Markdown loop discovery/parsing is owned by `packages/web/server/lib/scheduled-tasks/loops.js`.
- Runtime orchestration and execution is owned by `packages/web/server/lib/scheduled-tasks/runtime.js`.
- This module is OpenChamber feature logic; it is intentionally separate from OpenCode proxy/runtime internals.

## Cross-instance occurrence claiming

Multiple OpenChamber server processes can share the same on-disk project config
(for example CLI `serve` on port 3000 and the Electron desktop server on port
57123). Each process keeps its own timers, so without coordination a daily (or
weekly / cron / once) slot would dispatch twice.

Before a **scheduled** run creates a session, the runtime claims the occurrence
in shared project config under the project write lock:

- Writes `state.lastScheduledFor` to the armed `nextRunAt` timestamp and advances
  `state.nextRunAt` to the following occurrence.
- A second instance that loses the claim skips session creation and reschedules
  from the winner's persisted `nextRunAt`.
- Project config writes also take a cross-process `.json.lock` file so the
  read-modify-write is serialized across processes, not only within one process.
- The sharing processes may run different OpenChamber versions. Normalization
  keeps only the fields a build knows, so every writer persists tasks it did
  not change verbatim from disk and swaps only `state` onto a task whose state
  it updated; a task goes out normalized only when it was deliberately
  replaced (upsert, loop adoption). An older server touching the file after a
  run therefore cannot strip fields a newer build added, such as a task's goal
  or auto-accept settings.
- Lock timeout / filesystem errors on claim, manual-start, or completion state
  writes always release the in-process running slot (via `finally`) and best-effort
  re-arm the **next future** occurrence; they must not leave the task permanently
  "running" or reject unhandled from the queue pump.
- Project write locks release the in-process promise chain even when
  `acquireProjectFileLock` times out, so a later write for the same project can
  proceed after the on-disk lock is cleared (a hung chain would permanently wedge
  every mutating API and strand `runTask` before its `finally`).
- Re-arm helpers only schedule a persisted `nextRunAt` when it is still in the
  future. A past slot (common for `once` after claim, which cannot advance
  `nextRunAt`) falls back to `computeNextRunAt` — which returns null for a
  consumed/past once occurrence — so a losing instance stops instead of
  spinning delay-0 timers against the project lock.
- On claim lock/fs failure, best-effort persist `lastStatus: error` + `lastError`
  when nobody else claimed the occurrence, so a past `once` task is not left
  enabled-but-inert with only a warn log. Recurring schedules still re-arm the
  next slot.
- On completion-write failure after a session already ran, in-memory status is
  set to a terminal value and a single persist retry is attempted so
  `lastStatus` does not stay `running`. Manual `runNow` still returns the
  `sessionID` as a successful dispatch (`ok` follows run status, with
  `persistError` set) rather than a hard 500; the run API and Scheduled Tasks
  UI surface `persistError` as a warning toast.
- The claim predicate rejects a duplicate solely via `lastScheduledFor` within
  slack of this occurrence. It does not consult advanced on-disk `nextRunAt`
  (that field is routinely overwritten by a second instance syncing inside
  `TASK_DUE_SLACK_MS`, including on later days when `lastScheduledFor` is already
  set from a prior claim).
- Claiming always writes `nextRunAt` (including `undefined`) so a past once-slot
  is cleared when there is no following occurrence.

Manual `runNow` does not claim a schedule occurrence.

## Files

- `packages/web/server/lib/scheduled-tasks/runtime.js`
  - Next-run computation (daily/weekly/cron compatibility)
  - Timer scheduling and queueing
  - Concurrency controls
  - Session create + prompt_async execution
  - Emits OpenChamber task-run events

- `packages/web/server/lib/scheduled-tasks/loops.js`
  - Discovery of `.agents/loops/*.md` (project scope, ancestors up to the worktree root) and `~/.agents/loops/*.md` (user scope)
  - Frontmatter parsing into scheduled-task definitions
  - `syncProject` reconciles discovered loops with the persisted task list on every project sync (startup, task list load, task save/delete)

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Scheduled task CRUD endpoints
  - Listing tasks reconciles loop files first, so opening the Scheduled Tasks UI discovers file additions, edits, and removals without a server restart
  - Loop-file endpoints toggle `enabled` in frontmatter or delete the authoritative markdown file, then reconcile the project
  - Manual run endpoint
  - OpenChamber events SSE stream endpoint

## Loop file format

Portable, git-commit-able scheduled-task definitions:

```markdown
---
name: daily-digest
schedule: "0 9 * * *"
enabled: true
model: anthropic/claude-sonnet-4-5
agent: plan
timezone: Europe/Kyiv
---
Summarize repository changes since yesterday.
```

Field mapping (model: `packages/ui/src/lib/scheduledTasksApi.ts`):

| Frontmatter | Task field |
|---|---|
| `name` | `name` (required, max 80 characters — longer names are rejected as malformed) |
| `schedule` | `schedule.kind: "cron"` + `schedule.cron` (required, cron-only in the portable format) |
| `enabled` | `enabled` (default `false` — a loop only runs when the file explicitly enables it; add `enabled: true` to activate) |
| `model` | split on the first `/` into `execution.providerID` / `execution.modelID` (required) |
| `agent` | `execution.agent` (optional) |
| `timezone` | `schedule.timezone` (optional, IANA; defaults to the server zone) |
| body | `execution.prompt` (required) |

`thinking_level` and `goalEnabled`/`goalTokenBudget` are not part of the portable
format (UI/JSON-only today); `daily`/`weekly`/`once` schedules remain UI/JSON-only.
Runtime state (`lastRunAt`, `nextRunAt`, `lastStatus`, `lastError`, `lastSessionId`,
`lastDurationMs`) is never written to the markdown file — it continues to live in
the project config state store.

## Loop reconciliation rules

`projectConfigRuntime.reconcileLoopTasks(projectID, loops)` runs inside the
project write lock on every `syncProject` when the project path is known:

- **Identity.** For loop-owned tasks (carrying the `loopFile` marker) identity
  is the loop file path: a loop takes its task over regardless of the task's
  current name, so renaming the loop (the `name` field, or a UI rename) renames
  the task in place instead of leaving a stale duplicate behind. A loop whose
  name matches a JSON task (no `loopFile`) takes that task over instead: its
  schedule/execution/enabled are overwritten from the file while the task's
  `id` and runtime `state` are preserved (markdown wins on conflict).
- **UI-only fields survive adoption.** Execution fields the file format does
  not define (`goalEnabled`, `goalTokenBudget`, `permissionAutoAccept`,
  `variant`) are preserved from the task when a loop adopts it; only fields the
  file defines are re-applied.
- **Deletion.** A task carrying the `loopFile` marker whose loop file is no
  longer discovered (removed or renamed) is unscheduled (removed from the
  config). The marker is persisted in the config file, so removal is detected
  across restarts. JSON-configured tasks without the marker are never removed.
  A task whose loop file still exists but is currently unparseable is KEPT with
  its last good definition — a transiently malformed file (mid-edit, bad merge)
  never deletes a task or its runtime state.
- **Creation.** Loops without a matching task are created under a deterministic
  `loop:<scope>:<name>` id so runtime state survives restarts. At most one task
  is driven per loop file; orphan duplicates of the same file are unscheduled.
- **Scope precedence.** Project-scope loops shadow user-scope loops with the
  same name; among project files the nearest ancestor wins.
- **Malformed files** (missing `name`/`schedule`/`model`/body, invalid cron,
  unreadable) are reported to the scheduler as `definition: null` entries and
  warned about; they never block valid loops in the same or other scopes.
- **Loop-file mutations.** The loop file remains authoritative. The scheduled-
  tasks UI opens it in the built-in file editor, updates its `enabled`
  frontmatter through the loop-file endpoint, and deletes the file through the
  loop-file endpoint after confirmation. Each mutation reconciles the project.
  The general task deletion API still rejects loop-sourced tasks while their
  file exists; once the file is gone, deleting an orphan task is allowed.

## Public exports (runtime.js)

- `createScheduledTasksRuntime(dependencies)`
- Returned API:
  - `start()`
  - `stop()`
  - `syncAllProjects()`
  - `syncProject(projectId)`
  - `runNow(projectId, taskId)`

## Public exports (routes.js)

- `registerScheduledTaskRoutes(app, dependencies)`
- Registers:
  - `GET /api/projects/:projectId/scheduled-tasks`
  - `PUT /api/projects/:projectId/scheduled-tasks`
  - `DELETE /api/projects/:projectId/scheduled-tasks/:taskId`
  - `PATCH /api/projects/:projectId/scheduled-tasks/:taskId/loop-file`
  - `DELETE /api/projects/:projectId/scheduled-tasks/:taskId/loop-file`
  - `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
  - `GET /api/openchamber/scheduled-tasks/status`
  - `GET /api/openchamber/events`
