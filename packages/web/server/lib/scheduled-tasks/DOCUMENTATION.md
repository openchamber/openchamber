# Scheduled Tasks module

Server-owned scheduled task runtime and routes for OpenChamber-only automation.

## Scope

- Per-project scheduled task persistence is owned by `packages/web/server/lib/projects/project-config.js`.
- Markdown loop discovery/parsing is owned by `packages/web/server/lib/scheduled-tasks/loops.js`.
- Runtime orchestration and execution is owned by `packages/web/server/lib/scheduled-tasks/runtime.js`.
- This module is OpenChamber feature logic; it is intentionally separate from OpenCode proxy/runtime internals.

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
  - `syncProject` reconciles discovered loops with the persisted task list on every project sync (startup, task save/delete)

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Scheduled task CRUD endpoints
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
- **UI edits** to a loop-sourced task are preserved in the config but the loop
  file remains authoritative: the next reconciliation re-applies the file's
  definition (including `enabled`). Use `enabled: false` in the file to
  disable. Deleting a loop-sourced task through the API is rejected with a 400
  while its loop file still exists on disk — the loop file is the removal
  surface; once the file is gone, deleting the orphan task is allowed. The
  scheduled-tasks UI marks loop tasks as file-managed and disables their
  edit/enable/delete actions for the same reason; `run now` remains available.

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
  - `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
  - `GET /api/openchamber/scheduled-tasks/status`
  - `GET /api/openchamber/events`
