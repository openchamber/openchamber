# Scheduled Tasks module

Server-owned scheduled task runtime and routes for OpenChamber-only automation.

## Scope

- Per-project scheduled task persistence is owned by `packages/web/server/lib/projects/project-config.js`.
- Runtime orchestration and execution is owned by this module.
- This module is OpenChamber feature logic; it is intentionally separate from OpenCode proxy/runtime internals.

## Files

- `packages/web/server/lib/scheduled-tasks/runtime.js`
  - Next-run computation (daily/weekly/cron compatibility)
  - Timer scheduling and queueing
  - Concurrency controls
  - Session create + prompt_async execution
  - Emits OpenChamber task-run events

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Scheduled task CRUD endpoints
  - Manual run endpoint
  - OpenChamber events SSE stream endpoint

## Prompt placeholder expansion

The prompt is expanded in two stages before being sent to OpenCode:

1. **Snippet expansion** (`expandSnippets`) — resolves `#snippetName` references from project and global snippet files.
2. **Scheduled-time placeholders** (`expandScheduledTaskPlaceholders`) — resolves `{{scheduled_time}}` placeholders to the originally scheduled wall-clock time (not the execution wall-clock time).

### Syntax

`{{scheduled_time}}` — default format: ISO 8601 (e.g. `2025-06-15T09:30:00.000Z`).

`{{scheduled_time:<format>}}` — custom format using [Luxon format tokens](https://moment.github.io/luxon/#/formatting?id=table-of-tokens). Examples:

| Placeholder | Resolves to |
|---|---|
| `{{scheduled_time}}` | `2025-06-15T09:30:00.000Z` |
| `{{scheduled_time:yyyy-LL-dd}}` | `2025-06-15` |
| `{{scheduled_time:HH:mm}}` | `09:30` |
| `{{scheduled_time:yyyy-LL-dd'T'HH:mm:ssZZZ}}` | `2025-06-15T09:30:00+00:00` |

For scheduled runs, the time reflects the original schedule slot (from `task.state.nextRunAt`). For manual runs (`runNow`), the current wall-clock time is used instead. All placeholders are resolved in the task's configured timezone.

Placeholders are also expanded in slash-command arguments, so `/review --since {{scheduled_time:yyyy-LL-dd}}` works as expected.

## Public exports (runtime.js)

- `createScheduledTasksRuntime(dependencies)`
- `expandScheduledTaskPlaceholders(text, scheduledTimeMs, zone)`
- `parseScheduledCommandPrompt(prompt)`
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
