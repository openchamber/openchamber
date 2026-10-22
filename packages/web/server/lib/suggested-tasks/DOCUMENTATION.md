# Suggested tasks module

Per-project scans that read the code and propose work, and the inbox where the
user approves, snoozes or dismisses what they propose. Product page:
`packages/docs/content/docs/suggested-tasks.mdx`.

## Pieces it reuses

- **Timing.** A project with Suggested tasks on has one scheduled task,
  `suggested-tasks-scan`, marked `suggestedScan: true`. The scheduled-tasks
  runtime arms its timer, claims each occurrence across server processes and
  counts it against the concurrency limits like any task, then calls
  `runSuggestedScan(projectID, reason)` instead of starting a session itself
  (`../scheduled-tasks/runtime.js`). "Scan now" is the scheduler's `runNow`.
  Manual cadence keeps the task with `enabled: false`, so `runNow` still
  reaches it; turning the feature off deletes the task. The scheduled-tasks
  service refuses to edit or delete a `suggestedScan` task, and loop files
  never adopt it.
- **Sessions.** A lens runs as an ordinary OpenCode session. Approving a
  suggestion as a session, a worktree session or a draft pull request goes
  through `openChamberSessionService.create` (`../openchamber-sessions`), so
  worktree creation, bootstrap and goals behave as they do for the agent tool.
- **End of a turn.** The watcher follows the same rule as
  `../dispatch-results`: an idle event arms a short timer, the tick asks
  `/api/session/active`, then reads the newest records and takes the outcome
  from OpenCode's `idle` record with `readDispatchOutcome`. Unknown is never
  "finished"; a failed read retries with backoff.
- **Todos** go through `projectContextRuntime.createTodo`; open todos are read
  for deduplication with `readContext`.
- **Notifications** go through the plugin notification emitter (same rate
  window as `/api/notifications/emit`).

## Files

- `config.js` — the `suggestedTasks` key of the per-user project config
  (`../projects/project-config.js` owns the file and its lock). Zod schemas
  with defaults; `readSuggestedTasksConfig` turns a missing key into the
  default and a key that no longer validates into an error, never into
  "off". `lensApprovals` (repository lens file → fingerprint) is written only
  by the approval route.
- `presets.js` — starting prompts for a lens. Adding one copies the prompt
  into the config; later changes here never reach existing lenses.
- `repo-lenses.js` — `.agents/lenses/*.md` in the project root. A repository
  lens runs only while the approval recorded on this machine matches the
  fingerprint of its whole definition, so a pull that changes it waits for a
  new approval (the rule repository loops follow).
- `scan-prompt.js` — the prompt a lens session receives, the parser of its
  answer, glob matching, title similarity, and `selectSuggestions`.
- `store.js` — the inbox: `<projectsDir>/<project stem>/suggested-tasks.json`.
- `issue-links.js` — prefilled new-issue URLs for GitHub, GitLab and Linear.
- `open-issues.js` reads open issues using ready repository bindings and mapped
  Linear teams. It reuses the provider readers and exact bound accounts, with
  at most 10 pages per provider. Partial reads keep successful pages and report
  warnings on the run. A run snapshots issue titles for restart-safe deduplication.
- `runtime.js` — scanning, watching lens sessions, the token budget, timeouts,
  and the inbox operations.
- `routes.js` — HTTP routes.

## A scan

`runScan` reads the config and decides first whether anything runs: off
(`disabled`), inside quiet hours for a scheduled run (`quiet-hours`), no lens
enabled (`no-lenses`), or an incremental scan where nothing in scope changed
since the last complete scan of that branch (`no-changes`). Each of those is
recorded as a `skipped` run and costs nothing. A run already in progress
answers 409 to "Scan now" and makes a scheduled run return without a record.

With a `baseBranch` that is not checked out, the scan reads a detached
worktree of that branch under `<data dir>/suggested-tasks/checkouts/<run id>`,
  removed when the last lens finishes (`git worktree remove --force`). Hooks,
  filters, submodule recursion and lazy fetching are disabled during creation.
  Paths in suggestions are repository-relative, so they
mean the same in the project.

The run is claimed under the inbox lock and every lens is recorded as
`pending` before any session starts. A fast lens cannot finish a run whose
other lenses are still waiting for dispatch. Each session id is persisted
before its prompt is sent. Each enabled lens gets one session, started in turn:

The lens records prompt delivery as `created`, `sending`, `sent` or
`uncertain`. A failed prompt response keeps its session watched because
OpenCode may already have accepted the request. A dead owner's `created`
session is failed on recovery without waiting for execution records.

- `permissions` (`scanPermissions`): deny `*`, then allow `read`, `glob`,
  `grep` and `skill`, deny `.env` reads as OpenCode's default policy does,
  and allow `webfetch`/`websearch` only for a lens with web access. OpenCode
  applies the last matching rule and puts session rules after the agent's, so
  no edit, shell, MCP tool, subagent or question can run whatever the agent
  allows. The scan is read-only by construction, not by instruction.
- model, variant and agent from the lens, or the project's session defaults.
- metadata `openchamber.kind: 'scheduled'` (stays out of In work) and
  `openchamber.suggestedScan: { runId, lensId }`.
- the prompt: the lens prompt, the scope, the changed files of an incremental
  scan, the rules, everything already known (open, snoozed and approved
  titles; dismissed titles with their reasons; open todos and issue titles), and the answer
  format: one fenced JSON block `{"suggestions":[...]}`.

A lens that cannot start is recorded as failed; the others still start. The
scan returns as soon as the prompts are out.

## A lens finishing

When a lens session's turn ends, `completeLens` parses its last answer:

- no readable JSON block: the lens `failed` ("ended without a readable list"),
  never an empty result. `{"suggestions": []}` is an answer: `done`, nothing
  added.
- one unreadable entry is skipped alone and counted as `invalid`.
- `selectSuggestions` drops entries whose files are all out of scope, entries
  below the minimum confidence or severity, and titles similar to anything
  known or already accepted in this run. Overlapping file/line references and
  shared significant title or explanation words also catch reworded findings
  from different lenses. This is similarity matching, so unrelated phrasing
  may still repeat. Deduplication reads the latest inbox inside the write lock.
  It then keeps the most severe and most
  certain up to the run's remaining slots (`maxSuggestions` is shared by all
  lenses of a run). Each drop is counted on the lens run.

The store update is idempotent: a lens that is no longer `running` (another
server process finished it) is left alone, and a lens whose turn ended before
`runScan` recorded it is retried shortly. The run becomes `done` when every
lens is done, `failed` when every lens failed, `partial` otherwise. Only a
`done` run moves the incremental baseline (`lastScanned[branch] = commit`),
so a failed lens sees the same changes next time.

When the last lens finishes: the temporary checkout is removed, the scan
sessions are archived (`archiveScanSessions`), and a notification goes out if
anything was added (`notify`). A lens whose action is not `suggest` then
approves each suggestion it added with that action. A failure is stored on
the suggestion as `conversionError`. A known created session stays linked;
an ambiguous outcome requires the user to check it before retrying.

### Stopping

- **Token budget.** `session.updated` events carry a session's token usage;
  input + output + reasoning of all lenses of the run is persisted and
  compared with `tokenBudget`. At the limit every running lens is interrupted.
  After a restart counts are restored and reconciled with OpenCode's session
  usage before enforcing the budget again. Usage arrives at model step
  boundaries, so an in-flight model step can cross the limit before it can be
  interrupted.
- **Timeout.** A lens running longer than 45 minutes is interrupted.
- **User.** `POST .../runs/:runId/stop` interrupts the run's running lenses.

Stopping also cancels the session's queued inbox items. An acknowledged
interrupt, an authoritative inactive status and an empty inbox can finish a
stopped lens that never produced a terminal execution record. A request still
being sent by a live owner stays watched until delivery settles.
The watcher also remembers locally settled requests, so a failed delivery-state
write cannot keep a stopped, empty session classified as in flight.

The stop reason is persisted too. An interrupted lens ends `stopped` with the reason; whatever readable answer
it left is still used.

After a restart, `start()` reads every project's inbox and watches the lens
sessions of runs still `running`. Pending lenses belonging to a dead server
are marked failed rather than keeping the project stuck. Terminal runs whose
cleanup did not finish are reconciled again. Shutdown drains in-flight writes.
While a known pending lens or conversion still needs its owner, the minute
sweep repeats ownership recovery. An owner that dies after startup is detected
without restarting the surviving server. Recovery stops reading inboxes when
no unresolved owner remains and does not re-fetch sessions already watched.

## The inbox

`suggested-tasks.json` holds `suggestions`, `runs` and `lastScanned`. A missing
file is an empty inbox. A file that is not JSON or not an inbox is an error
(500), never "no suggestions", and is not overwritten. One unreadable entry is
dropped alone. Unknown file versions and missing inbox collections fail closed.
Every change is a read-modify-write under a cross-process lock
(`../source-control/file-lock.js`), because a desktop app and a CLI `serve`
can share the projects dir and watch the same sessions. Open and snoozed items
are never evicted. At 500 pending items scans stop admitting new suggestions.
The newest 200 dismissed or approved items and 30 terminal runs are retained;
running runs are always retained.

Statuses: `open`, `snoozed` (until `snoozedUntil`; read as open once the time
has passed, nothing has to wake it), `dismissed` (optional `dismissReason`, at
most 500 characters), `approved` (with `conversion`). Restore returns any of
them to open.

Approving first reserves the suggestion under the inbox lock, so another
process cannot create the same work. Session creation records its identity
before dispatch, including on partial failure. Ambiguous failures retain the
reservation and report an error instead of permitting an unsafe retry.
After checking the external outcome, the user can explicitly restore a failed
conversion. In-flight conversions cannot be dismissed or snoozed. An automatic
action rechecks that the project and lens policy are still enabled before it
creates work.

`conversionRecoverable` grants that explicit recovery only after an operation
has failed or its owner has died. A new reservation clears old errors and
recovery authority. Dismissal accepts only open or snoozed suggestions under
the inbox lock, so a stale dialog cannot erase a completed conversion.

| Action | Work created |
|---|---|
| `session` | session in the project with the suggestion as prompt |
| `worktree` | new worktree `suggested-<title slug>` and a session in it |
| `draft-pr` | the same with goal mode and an instruction to open a draft pull request |
| `todo` | project todo: title and explanation, at most 1,000 characters |
| `issue` | nothing on the tracker: a prefilled new-issue URL for the `origin` remote (GitHub, or a host containing `gitlab`) or `linear.new` when Linear is connected; the client opens it |
| `draft` | nothing: the client opens a new-session draft with the prompt |

Issue creation stays in the user's browser on purpose: provider writes go
through the source-control mutation pipeline, whose audit records only
user-initiated mutations, and a scan has no business filing issues by itself.
For the same reason no lens action creates issues.

## Routes

- `GET /api/openchamber/suggested-tasks/summary` — open count and running
  flag per project; a project whose inbox cannot be read reports `error`.
- `GET /api/projects/:projectId/suggested-tasks` — the inbox and the issue
  providers the project offers.
- `GET|PUT /api/projects/:projectId/suggested-tasks/settings` — the config
  (without approvals), repository lenses, presets, next scheduled scan.
- `POST .../repo-lenses` `{ file, enabled }` — record or withdraw this
  machine's approval of a repository lens.
- `POST .../run` `{ lensIds? }` — scan now, all enabled lenses or the named
  ones.
- `POST .../runs/:runId/stop`
- `POST .../items/:id/approve` `{ action, provider? }`, `.../dismiss`
  `{ reason? }`, `.../snooze` `{ until }`, `.../restore`.

Every change broadcasts `openchamber:suggested-tasks-changed { projectId }`
on the OpenChamber event stream.

## Runtime parity

| Runtime | Behaviour |
|---|---|
| Web, Electron desktop | Full: inbox page from the sidebar, whose Configure dialog holds the settings; the same form is the Suggested tasks tab under Settings → Projects. |
| Hosted mobile, Capacitor | Full: inbox surface from the sessions menu with the same Configure dialog. Settings → Projects is not part of the phone's Settings, so the dialog is the only way to set it up there. |
| VS Code | Not offered: no OpenChamber server in the extension. The sidebar entry, the page and the settings tab are absent, and the summary is never requested. |

## Compatibility

An older OpenChamber sharing the same projects dir does not know
`suggestedScan`. When it fires the scan task it sends the task's fallback
prompt as an ordinary scheduled session, which tells the model to reply and
stop. Its scheduled-tasks UI also lists the task.
