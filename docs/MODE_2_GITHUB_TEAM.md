# Mode 2 — GitHub Team

**Status:** Planned. Do not start before Mode 1 ships end-to-end and has
been exercised in real use for ≥ 1 week.
**Audience:** 2–50 person teams operating in a GitHub org, mostly async.
**Goal:** Replace the Slack + GitHub + dashboard-tabs shuffle with a single
team-aware, AI-native view. GitHub stays the source of truth; we add the
coordination layer.

Read first: [`IMPLEMENTATION_GUIDE.md`](IMPLEMENTATION_GUIDE.md),
[`TEAMS_OVERVIEW.md`](TEAMS_OVERVIEW.md), [`MODE_1_INDIVIDUAL.md`](MODE_1_INDIVIDUAL.md).

---

## Non-goals

- Replacing GitHub's permission model. We mirror it; we don't outrank it.
- A hosted multi-tenant service. Each team runs its own OpenChamber Teams
  instance (self-hosted or local host machine).
- Slack-level general chat. Only context-bound, work-attached messaging.
- CRDT / live shared sessions. That is Mode 3 exclusively.

---

## Defaults for autonomous runs (additions to the Mode 1 defaults)

| Question | Default |
| --- | --- |
| Storage engine | SQLite via `better-sqlite3`. File: `~/.config/openchamber/teams/team.db`, mode `0o600`. No new ORM; raw SQL with `prepare()`. |
| Schema evolution | `migrations/` dir, numeric file names, idempotent. One-shot on server boot. |
| Workspace vs repo scope | A workspace maps 1:1 to a GitHub org. Repos inside the workspace are all repos the GitHub App is installed on. |
| Role defaults | New member joins as `developer`. Only a workspace `owner` can change roles. |
| Review load calc window | 14 days. Configurable later. |
| Webhook delivery | GitHub App → server endpoint; verify HMAC with stored secret; 10s processing budget; enqueue heavy work. |
| Webhook endpoint path | `POST /webhooks/github` at the existing Express app. |
| Tunnel | reuse existing `tunnels` module (`packages/web/server/lib/tunnels/`) for exposing the webhook receiver. |
| Event bus | reuse existing `event-stream` module. New channel: `teams.activity`. |
| Optimistic PR-board updates | allowed for local actions only (assign, snooze). GitHub-side changes wait for webhook confirmation. |
| Secrets | `~/.config/openchamber/teams/secrets.enc`, xsalsa20-poly1305 using a machine key derived from OS keychain. |

---

## Reusable building blocks from Mode 1 / upstream

- GitHub auth + Octokit factory (`packages/web/server/lib/github/`).
- Repo resolver, remote URL parser.
- PR status, issues, pulls endpoints.
- Event stream for SSE fan-out.
- UI feature folder convention, shared PR store.
- Skills catalog module (`packages/web/server/lib/skills-catalog/`) for the
  personal scope; we add team + repo scopes on top.

---

## Data model (sketch, not final)

All tables live in the single team SQLite file. Column lists below are the
minimum needed for the features described; add as needed.

```sql
-- One workspace per connected GitHub org.
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,                 -- uuid
  github_org_login TEXT NOT NULL UNIQUE,
  github_installation_id INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  github_user_id INTEGER NOT NULL,
  github_user_login TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN
    ('owner','maintainer','developer','reviewer','viewer')),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, github_user_id)
);

-- Append-only activity log for the feed and audit.
CREATE TABLE activity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,                   -- 'pr.opened', 'review.requested', etc.
  actor_login TEXT,
  repo_full_name TEXT,
  payload_json TEXT NOT NULL,
  happened_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_workspace_time
  ON activity_events(workspace_id, happened_at DESC);

-- Per-member assignments for the PR board (not GitHub's own assignees).
CREATE TABLE assignments (
  workspace_id TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  assignee_login TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('author','reviewer','watcher')),
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repo_full_name, pr_number, assignee_login, kind)
);

-- Session handoff records.
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,                  -- uuid
  workspace_id TEXT NOT NULL,
  from_login TEXT NOT NULL,
  to_login TEXT NOT NULL,
  session_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,          -- summary, open files, plan, risks
  status TEXT NOT NULL CHECK(status IN
    ('sent','accepted','declined','expired')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);

-- Team skills live in the existing skills-catalog module, with a new
-- scope column ('personal' | 'team:<workspace_id>' | 'repo:<full_name>').
-- If upstream's schema doesn't support a scope column, add a migration.
```

---

## GitHub App specification

A single GitHub App (`openchamber-teams`) is used per team deployment. It is
not a public marketplace app; each team creates their own App in their org.

**Permissions (minimum viable):**

- Repository:
  - Contents: read
  - Issues: read & write
  - Pull requests: read & write
  - Checks: read
  - Metadata: read
- Organization:
  - Members: read
  - Administration: none
- Account:
  - Email addresses: read (optional)

**Events:** `pull_request`, `pull_request_review`,
`pull_request_review_comment`, `check_run`, `check_suite`,
`issue_comment`, `push`, `installation`, `installation_repositories`,
`member`.

**Installation flow:**

1. Workspace owner clicks "Create workspace" in the app.
2. App redirects them to `https://github.com/organizations/<org>/settings/apps/new?state=<nonce>`
   with a manifest that encodes all permissions and the callback URL
   (the running OpenChamber Teams instance's webhook endpoint).
3. GitHub installs the App and returns an installation ID.
4. Server stores `{ workspace_id, installation_id, webhook_secret }`.
5. Server creates workspace row, fetches org members, seeds
   `workspace_members` (all as `developer`; owner role is granted to the
   creator).

---

## Features

### 2.1 Team Workspaces

**Problem.** There is no "team" concept in OpenChamber today. Everything is
scoped to the current user.

**UX.** Settings → Workspaces → *Connect GitHub org*. Guided App install.
After success, a workspace switcher appears in the top bar next to the
account menu.

**Endpoints.**
- `POST /api/teams/workspaces` — create from an installation ID.
- `GET  /api/teams/workspaces` — list workspaces the user has membership in.
- `POST /api/teams/workspaces/:id/activate` — set current.
- `GET  /api/teams/workspaces/:id/members` — list.
- `PATCH /api/teams/workspaces/:id/members/:login` — change role (owner only).
- `DELETE /api/teams/workspaces/:id` — owner only; soft-deletes the row and
  keeps activity log by default.

**Files.**
- `packages/web/server/lib/teams/workspace.js` — CRUD + member sync.
- `packages/web/server/lib/teams/db.js` — SQLite open + migrations.
- `packages/web/server/lib/teams/routes.js` — mount under `/api/teams/*`.
- `packages/ui/src/features/team-workspace/` — switcher + settings page.
- `packages/ui/src/stores/team/workspace.ts` — narrow store.

**Commit plan.**
1. `feat(teams/mode2/workspace): add teams db module with migrations`
2. `feat(teams/mode2/workspace): add workspace + member CRUD routes`
3. `feat(teams/mode2/workspace): add workspace switcher UI`

**Open questions / defaults.**
- Does joining a workspace require acceptance, or auto-join based on org
  membership? Default: auto-join (the App already proves membership).
- What happens when the user leaves the org? Default: mark member `inactive`
  in the next webhook pass; don't delete history.

---

### 2.2 Webhook Receiver & Event Pipeline

**Problem.** Team features need near-real-time updates without GitHub
polling.

**UX.** Invisible to users; enables everything else.

**Endpoints.** `POST /webhooks/github` — raw body, HMAC verified, responds
within 1s. Heavy work deferred to an in-process queue.

**Files.**
- `packages/web/server/lib/teams/webhooks/receiver.js` — verifies and parses.
- `packages/web/server/lib/teams/webhooks/dispatch.js` — routes payloads to
  handlers by event type.
- `packages/web/server/lib/teams/webhooks/handlers/` — one file per event
  family: `pull-request.js`, `review.js`, `check.js`, `push.js`, etc.
- `packages/web/server/lib/teams/activity-log.js` — append to
  `activity_events`.
- Tunnels: if no public URL is configured, surface a "requires a public URL
  (tunnel) for webhooks" banner in workspace settings.

**Commit plan.**
1. `feat(teams/mode2/webhooks): add webhook receiver + HMAC verify`
2. `feat(teams/mode2/webhooks): add dispatcher with per-event handlers`
3. `feat(teams/mode2/webhooks): append events to activity_events`
4. `feat(teams/mode2/webhooks): fan out to SSE channel 'teams.activity'`

**Open questions.**
- Storage of the webhook secret per workspace — default: encrypted field in
  the workspaces table using the secrets store defined in the defaults.
- Retry-on-failure — default: rely on GitHub's redelivery; we don't queue
  ourselves.

**Stuck checks.**
- Confirm the existing `tunnels` module can expose a single stable path
  (`/webhooks/github`) with known HMAC secret.
- Confirm the Express app can accept `application/json` with raw body
  preserved (needed for HMAC); GitHub expects exact bytes.

---

### 2.3 Team PR Board (Kanban)

**Problem.** GitHub's PR list is linear. Teams operate in columns: draft →
needs review → changes requested → approved → merged.

**UX.** Full-page view. Columns match the statuses above. Cards aggregate
data we already fetch. Filters: my reviews, my PRs, all, by repo, by label,
by milestone. "Blocking me" vs "I'm blocking" toggle.

**Endpoints.**
- `GET /api/teams/:workspace/board` — query params for filter. Returns PRs
  grouped by column, with per-card aggregates (CI dot, reviewer avatars,
  time since last activity).
- Card-click actions reuse Mode 1's PR cockpit endpoints.

**Files.**
- `packages/web/server/lib/teams/board.js` — aggregation across repos.
- `packages/ui/src/features/team-board/` — kanban.
- `packages/ui/src/stores/team/board.ts` — narrow store.

**Commit plan.**
1. `feat(teams/mode2/board): add board aggregation endpoint`
2. `feat(teams/mode2/board): add kanban UI shell`
3. `feat(teams/mode2/board): add card + quick actions`
4. `feat(teams/mode2/board): add filters + saved views`

**Open questions.**
- Stale-card threshold — default: 48h of no activity.
- Card action set — default: `Start session`, `Request review`, `Assign`,
  `Snooze`. Anything destructive (close, delete branch) goes through the
  existing PR cockpit.

---

### 2.4 CODEOWNERS-Aware Review Routing

**Problem.** GitHub's round-robin reviewer assignment ignores who touched
the files recently or who's already overloaded.

**UX.** When opening a PR (or on an existing PR), a *Suggested reviewers*
panel shows: CODEOWNERS match + top 3 recent editors + lowest-load
teammate. One-click "Request these".

**Endpoints.**
- `GET /api/teams/:workspace/reviewers/suggest` — params: repo, branch.
- `GET /api/teams/:workspace/review-load` — per-member load dashboard.

**Files.**
- `packages/web/server/lib/teams/codeowners.js` — parser.
- `packages/web/server/lib/teams/reviewer-suggest.js` — ranker.
- `packages/ui/src/features/reviewer-suggest/`.

**Commit plan.**
1. `feat(teams/mode2/reviewer): add CODEOWNERS parser with tests`
2. `feat(teams/mode2/reviewer): add suggestion ranker + endpoint`
3. `feat(teams/mode2/reviewer): add suggestion panel in PR cockpit`
4. `feat(teams/mode2/reviewer): add review-load dashboard`

**Open questions.**
- "Auto-assign on PR open" toggle — default: off; visible toggle in workspace
  settings.
- Load calculation — default: weighted open-review count * (review age / 24h).

---

### 2.5 Session Handoff (the core team feature)

**Problem.** Half-done work lives in one person's head. Status updates don't
transfer context.

**UX.** In any session → *Hand off to …* → picker. Recipient gets a
notification with the handoff package. Accept → their app opens the session
(same worktree on their machine is optional; if absent, they clone from the
host and continue from the snapshot).

**Endpoints.**
- `POST /api/teams/:workspace/handoffs` — create handoff.
- `GET  /api/teams/:workspace/handoffs/inbox` — my pending handoffs.
- `POST /api/teams/:workspace/handoffs/:id/accept`
- `POST /api/teams/:workspace/handoffs/:id/decline`

**Handoff snapshot contains:**

```json
{
  "summary": "AI-generated short narrative",
  "plan": "copy of current plan-mode contents",
  "openFiles": ["path", ...],
  "cursors": { "path": { "line": 12, "col": 3 } },
  "risks": ["bullet 1", "bullet 2"],
  "lastMessages": [ { "role": "...", "content": "..." }, ... ],
  "suggestedNextPrompt": "AI-generated",
  "branch": "feat/xyz",
  "worktreeHint": "/Users/alice/code/proj-xyz/.worktrees/feat-xyz"
}
```

**Files.**
- `packages/web/server/lib/teams/handoff/snapshot.js` — serializer.
- `packages/web/server/lib/teams/handoff/routes.js`.
- `packages/ui/src/features/handoff/` — send + inbox.

**Commit plan.**
1. `feat(teams/mode2/handoff): add snapshot serializer (no AI yet) + tests`
2. `feat(teams/mode2/handoff): add routes for create/accept/decline`
3. `feat(teams/mode2/handoff): add send dialog and inbox UI`
4. `feat(teams/mode2/handoff): enrich snapshot with AI summary + next prompt`

**Open questions.**
- "Async handoff scheduled for tomorrow morning" — default: yes, include a
  `not_before` timestamp; recipient only sees it after.
- Auto-generated summary quality — default: use the session's active model.
  If unavailable, skip the AI step and let the user write a summary manually.
- Worktree re-creation on recipient side — default: do not auto-create; show
  the hint and let the recipient open it.

**Stuck checks.**
- Confirm session state is queryable from the server-side (messages,
  plan-mode contents, open files). If session data lives only in the UI,
  BLOCK and surface.

---

### 2.6 Shared Team Skills

**Problem.** Skills today are personal. Teams want shared conventions (commit
style, review checklists, incident playbooks).

**UX.** Skills management UI gains a *Scope* field: Personal, Team, Repo.
Team and Repo scopes are visible to all workspace members; protected skills
(Maintainer+) get a lock icon.

**Endpoints.** Extend the existing skills-catalog module with a `scope`
column and query filters. No new endpoints needed if the existing routes
accept a scope filter.

**Files.**
- Extend `packages/web/server/lib/skills-catalog/`.
- `packages/ui/src/components/sections/skills/` — add scope picker.

**Commit plan.**
1. `feat(teams/mode2/skills): add scope column migration + model update`
2. `feat(teams/mode2/skills): add scope filter + write permissions`
3. `feat(teams/mode2/skills): UI scope picker + visibility lock icons`

**Open questions.**
- Where are skills physically stored? Default: existing disk location;
  scope is metadata-only. If upstream later adds a git-backed skills repo,
  we adopt that then.
- Conflict resolution when two maintainers edit the same skill. Default:
  last-write-wins with a visible warning; no merge UI in Mode 2.

---

### 2.7 Multi-Agent Runs for Teams

**Problem.** The upstream multi-agent feature runs in isolation; teams want
to collectively decide which variant wins.

**UX.** After a multi-agent run, a *team vote* banner appears in the
session. Any workspace member can vote; the winner is the one the human
reviewer accepts.

**Endpoints.**
- `POST /api/teams/:workspace/agent-runs/:runId/vote` — up/down from a member.
- `GET  /api/teams/:workspace/agent-runs/:runId` — aggregated votes.

**Files.**
- `packages/web/server/lib/teams/agent-runs.js`.
- `packages/ui/src/features/multi-agent-vote/`.

**Commit plan.**
1. `feat(teams/mode2/agent-votes): add vote table + routes`
2. `feat(teams/mode2/agent-votes): add vote banner + avatar strip`

**Open questions.**
- Do votes bind the outcome? Default: no. The PR author decides; votes are
  advisory.

---

### 2.8 Repo Activity Feed

**Problem.** GitHub event streams are firehose. Teams want a signal-only
feed per repo.

**UX.** Per-repo tab in the workspace: chronological events. Filters by
type. Outbound webhook (optional) to Slack, Discord.

**Endpoints.** Driven off `activity_events`; no new endpoint beyond
`GET /api/teams/:workspace/activity?repo=&since=`.

**Files.**
- `packages/ui/src/features/activity-feed/`.
- Optional outbound: `packages/web/server/lib/teams/relay/` (only if a user
  configures a Slack/Discord webhook).

**Commit plan.**
1. `feat(teams/mode2/activity): add activity feed endpoint + UI`
2. `feat(teams/mode2/activity): add filters and per-type icons`
3. `feat(teams/mode2/activity): add optional outbound relay to Slack/Discord`

**Open questions.**
- What counts as "noise" vs "signal"? Default: omit label edits, milestone
  touches, stale-close/reopen unless the user flips "show everything".

---

### 2.9 Milestone / Projects Sync

**Problem.** Teams plan in GitHub Projects (v2). We don't need to mirror
the whole thing, just surface "active work" relevant to the logged-in user.

**UX.** In the top of the PR board, an optional strip shows projects items
tagged "In progress" or "Blocked" that belong to the current user's
milestone.

**Endpoints.** `GET /api/teams/:workspace/projects/active` — queries
GitHub Projects v2 GraphQL.

**Files.** `packages/web/server/lib/teams/projects.js` + UI strip.

**Commit plan.**
1. `feat(teams/mode2/projects): add projects v2 query module`
2. `feat(teams/mode2/projects): add active-items strip on the board`

**Open questions.**
- Does the minimum viable App have `read:project` scope? Confirm before
  shipping; if not, document it as a setup step.

---

### 2.10 Shipping order

1. 2.1 Workspaces.
2. 2.2 Webhooks (unlocks 2.3, 2.8).
3. 2.3 PR Board.
4. 2.5 Handoff (highest team-level value; ship before broader UX polish).
5. 2.4 Reviewer routing.
6. 2.6 Shared skills.
7. 2.8 Activity feed.
8. 2.7 Multi-agent votes.
9. 2.9 Projects strip (optional / nice-to-have).

Anything not shipped after 6 weeks of real-team use is either cut or moved
to a separate track. Do not extend Mode 2 indefinitely.

---

## Cross-runtime notes

- **Electron** inherits everything.
- **VS Code webview** gets: handoff inbox (so people receive handoffs in
  their editor), PR cockpit panels (already shared from Mode 1). The
  full PR Board is too large for a VS Code side panel; keep it web/electron.

## Security notes

- Webhook HMAC verification is non-negotiable. Drop requests without it.
- Secrets never leave the host machine. Peers in Mode 3 receive encrypted
  blobs they can't decrypt unless explicitly shared.
- Rate limits: cross-repo aggregations must paginate and back off on 429.
- Audit log is `activity_events`. Do not delete rows; add a tombstone if
  needed.
