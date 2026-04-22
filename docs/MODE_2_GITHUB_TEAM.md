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

## The 3-Tier Hybrid Architecture

To provide a fast, secure, and real-time team experience without locking
user IP into a proprietary cloud database, Mode 2 (and Mode 3) relies on a
strict 3-tier architecture. 

**Rule: Never store data in the wrong tier.**

1. **GitHub API (Live Read / Cache-less)**
   - **What:** PRs, issues, CI statuses, reviewer states.
   - **Why:** GitHub is the source of truth. Caching this elsewhere creates stale data and synchronization bugs. We read this live using the GitHub GraphQL API and REST API.
   
2. **Git Layer (`.openchamber/` in the repository)**
   - **What:** Team Skills, Team Prompts, Architecture Decision Records (ADRs), Playbooks, Project-level notes.
   - **Why:** Low-frequency, high-value context that requires team consensus, version control, and code review (via PRs). It naturally travels with the code.

3. **SQLite (Host Machine / Central Node)**
   - **What:** Presence (who is looking at what), Activity Feed (instant notifications), Session Handoff metadata (who sent what to whom), and Live Session CRDTs (in Mode 3).
   - **Why:** High-frequency, ephemeral, or coordination data that would overwhelm GitHub API rate limits or bloat the Git history. Stored locally on the team's host machine to ensure IP never leaves the internal network.

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
| Team Skills location | `.openchamber/skills/` directory inside the connected repository. |
| Secrets | `~/.config/openchamber/teams/secrets.enc`, xsalsa20-poly1305 using a machine key derived from OS keychain. |

---

## Reusable building blocks from Mode 1 / upstream

- GitHub auth + Octokit factory (`packages/web/server/lib/github/`).
- Repo resolver, remote URL parser.
- PR status, issues, pulls endpoints.
- Event stream for SSE fan-out.
- UI feature folder convention, shared PR store.

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
  kind TEXT NOT NULL,                   -- 'pr.opened', 'review.requested', 'handoff.sent'
  actor_login TEXT,
  repo_full_name TEXT,
  payload_json TEXT NOT NULL,
  happened_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE INDEX idx_activity_workspace_time
  ON activity_events(workspace_id, happened_at DESC);

-- Session handoff notifications (metadata only, PR context comes from GitHub live).
CREATE TABLE handoffs (
  id TEXT PRIMARY KEY,                  -- uuid
  workspace_id TEXT NOT NULL,
  from_login TEXT NOT NULL,
  to_login TEXT NOT NULL,
  session_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,          -- summary, open files, plan, risks
  target_repo TEXT NOT NULL,
  target_pr_number INTEGER,
  status TEXT NOT NULL CHECK(status IN
    ('sent','accepted','declined','expired')),
  created_at INTEGER NOT NULL,
  responded_at INTEGER
);
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

**Architecture Note:** To avoid stale data, the PR Board data is *not* stored in SQLite. It is fetched live from GitHub via GraphQL API, with aggressive client-side caching (SWR).

**UX.** Full-page view. Columns match the statuses above. Cards aggregate
data fetched live. Filters: my reviews, my PRs, all, by repo, by label.

**Endpoints.**
- `GET /api/teams/:workspace/board` — Uses GitHub GraphQL to fetch open PRs across workspace repos in a single request.
- Card-click actions reuse Mode 1's PR cockpit endpoints.

**Files.**
- `packages/web/server/lib/teams/board.js` — GraphQL query builder and aggregator.
- `packages/ui/src/features/team-board/` — kanban UI.

**Commit plan.**
1. `feat(teams/mode2/board): add GraphQL board aggregation endpoint`
2. `feat(teams/mode2/board): add kanban UI shell and SWR cache`
3. `feat(teams/mode2/board): add card + quick actions`

**Open questions.**
- Stale-card threshold — default: 48h of no activity.

---

### 2.4 CODEOWNERS-Aware Review Routing

**Problem.** GitHub's round-robin reviewer assignment ignores who touched
the files recently or who's already overloaded.

**UX.** When opening a PR (or on an existing PR), a *Suggested reviewers*
panel shows: CODEOWNERS match + top 3 recent editors + lowest-load
teammate. One-click "Request these".

**Endpoints.**
- `GET /api/teams/:workspace/reviewers/suggest` — params: repo, branch. Calculates live from Git history.

**Commit plan.**
1. `feat(teams/mode2/reviewer): add CODEOWNERS parser with tests`
2. `feat(teams/mode2/reviewer): add suggestion ranker + endpoint`
3. `feat(teams/mode2/reviewer): add suggestion panel in PR cockpit`

---

### 2.5 Session Handoff (the core team feature)

**Problem.** Half-done work lives in one person's head. Status updates don't
transfer context.

**Architecture Note:** The "Who and What" (snapshot metadata) is stored in SQLite for instant delivery and notifications. The "Where" (PR Context) remains in GitHub.

**UX.** In any session → *Hand off to …* → picker. Recipient gets a
notification with the handoff package via SSE. Accept → their app opens the session.

**Endpoints.**
- `POST /api/teams/:workspace/handoffs` — create handoff in SQLite.
- `GET  /api/teams/:workspace/handoffs/inbox` — my pending handoffs from SQLite.
- `POST /api/teams/:workspace/handoffs/:id/accept`

**Commit plan.**
1. `feat(teams/mode2/handoff): add snapshot serializer + db tables`
2. `feat(teams/mode2/handoff): add routes for create/accept/decline`
3. `feat(teams/mode2/handoff): add send dialog and inbox UI`
4. `feat(teams/mode2/handoff): enrich snapshot with AI summary`

---

### 2.6 Git-Native Shared Team Skills

**Problem.** Skills today are personal. Teams want shared conventions (commit
style, review checklists, incident playbooks), and they want them version controlled.

**Architecture Note:** Do NOT store Team Skills in SQLite. They live in `.openchamber/skills/` within the repository itself.

**UX.** Skills management UI reads from the local `.openchamber/skills/` directory of the active project. To edit a team skill, the user edits the markdown file and commits it via the standard Git workflow.

**Endpoints.**
- Extend `packages/web/server/lib/skills-catalog/` to discover skills from the `.openchamber/` directory of the active project workspace.

**Files.**
- `packages/web/server/lib/skills-catalog/git-provider.js` — scans project dir.

**Commit plan.**
1. `feat(teams/mode2/skills): add git-provider to skills-catalog`
2. `feat(teams/mode2/skills): UI badge to distinguish repo-scoped skills`

---

### 2.7 Repo Activity Feed

**Problem.** GitHub event streams are firehose. Teams want a signal-only
feed per repo.

**Architecture Note:** Driven entirely off the `activity_events` table in SQLite, populated by the Webhook Receiver.

**UX.** Per-repo tab in the workspace: chronological events.

**Commit plan.**
1. `feat(teams/mode2/activity): add activity feed endpoint + UI`
2. `feat(teams/mode2/activity): add filters and per-type icons`

---

## Shipping order

1. 2.1 Workspaces & SQLite Setup.
2. 2.6 Git-Native Shared Team Skills (High value, easy win).
3. 2.2 Webhooks (unlocks Activity Feed and live Board refreshes).
4. 2.3 PR Board (GraphQL).
5. 2.5 Handoff (highest team-level value).
6. 2.8 Activity feed.
7. 2.4 Reviewer routing.

Anything not shipped after 6 weeks of real-team use is either cut or moved
to a separate track. Do not extend Mode 2 indefinitely.
