# Mode 1 — Individual GitHub

**Status:** In implementation.
**Audience:** Solo developers using GitHub daily.
**Goal:** Make OpenChamber the command center for the user's GitHub work, so
they rarely need to open github.com to do their day job.

This document is the *working* implementation plan. It names concrete files,
endpoints, UI locations, and acceptance criteria. As features land, each
section is updated with its actual commit/link and the "Status" flipped to
`shipped`.

## How to use this document (autonomous agents, read first)

This plan is designed to be executed by an autonomous coding agent
(e.g. Kimi 2.6 in a ralph-style loop). Two rules govern behavior:

1. **Defaults beat blocking.** Every open question in this doc has a
   pre-chosen "default for autonomous runs" further down. If you hit a
   decision and the default exists, take the default, record it in
   `docs/IMPLEMENTATION_NOTES.md` under the feature heading, and keep going.
2. **Stuck protocol.** If a task is blocked by something a default can't
   resolve (missing credentials, genuinely ambiguous upstream behavior,
   conflicting existing code), stop and write a single line to
   `docs/BLOCKERS.md` describing the feature, the exact block, what you
   tried, and the minimum info you need. Then move to the next feature that
   has no dependency on the blocked one. Do not invent behavior.

Both files (`IMPLEMENTATION_NOTES.md`, `BLOCKERS.md`) are created lazily —
don't pre-commit empty ones.

Before writing any code, also read:

- `docs/IMPLEMENTATION_GUIDE.md` — cross-cutting rules (commit policy,
  verification commands, allowed dependencies).
- `docs/TEAMS_OVERVIEW.md` — product context for the three modes.
- `AGENTS.md` at the repo root — coding standards that always apply.

## Defaults for autonomous runs

When a decision is implied but not spelled out in a feature section, apply
these in order:

| Question | Default |
| --- | --- |
| Branch name prefix for "Work on this issue" | `label:bug` → `fix/`, `label:enhancement|feature` → `feat/`, else `work/` |
| Slug source for branch name | issue title, ASCII lower-case, non-`[a-z0-9]` → `-`, collapse repeats, max 40 chars |
| Base branch for new work | repo's `default_branch` from GitHub API, not local `main` |
| Worktree path root | existing worktree helper's default; do not introduce a new root |
| Where to persist local-only state (snoozes, cockpit prefs) | `~/.config/openchamber/teams/<feature>.json`, mode `0o600` |
| Rate-limit handling | if `X-RateLimit-Remaining < 50`, skip speculative fetches and log once per session |
| Endpoint error contract | JSON `{ ok: false, error: { code, message } }`, HTTP status mirroring GitHub's where relevant, 500 for server bugs only |
| Octokit absent | endpoint returns `{ ok: false, error: { code: 'not_authenticated' } }` with HTTP 401 |
| GitHub API pagination | always paginate; stop at 500 items for lists (log if truncated) |
| Unit test location | `packages/web/server/lib/github/__tests__/<module>.test.js` for pure modules; no new harness |
| Test runner | `bun test` (already used in repo — confirm via `grep -r '"test"' packages/*/package.json` before assuming) |
| UI feature folder | `packages/ui/src/features/<feature-name>/` with `index.tsx`, `hooks.ts`, `api.ts` as needed |
| Store placement | new narrow zustand store per feature; do not extend broad stores |
| Toast import | `@/components/ui` wrapper, never `sonner` directly |
| Dep addition policy | no new npm deps; if one is unavoidable, log a blocker instead |
| Commit size | one feature = 1–4 commits; never mix two features in one commit |
| Commit subject | `feat(teams/mode1/<feature>): …`, `fix(teams/mode1/<feature>): …` |

## Verification gates (run before declaring any feature done)

```bash
bun run type-check   # must exit 0
bun run lint         # must exit 0
bun run build        # must exit 0
bun test             # for features that add a test file
```

No feature is "shipped" until all four pass. If a failure is in code you did
not touch, log it in `docs/BLOCKERS.md` and stop — do not "fix" unrelated
failures in the same branch.

## Non-goals for Mode 1

- Team features (assignment, review routing, shared skills). Those are Mode 2.
- Any new auth flow. Mode 1 reuses the existing GitHub OAuth device flow and
  multi-account support in `packages/web/server/lib/github/auth.js`.
- Any new data store. Mode 1 persists user preferences in the existing
  `settings.json` / local storage and treats GitHub as the source of truth
  for issues/PRs/notifications.
- Webhooks. Mode 1 polls. Webhooks arrive with Mode 2's GitHub App.

## What is already in place (reuse, don't rebuild)

From `packages/web/server/lib/github/`:

- **Auth:** OAuth device flow, multi-account switching, atomic 0o600 storage.
- **Octokit factory:** `getOctokitOrNull()`.
- **Repo resolution:** `parseGitHubRemoteUrl`, `resolveGitHubRepoFromDirectory`
  (handles `origin`, `upstream`, parent/source for forks).
- **PR status resolver:** cross-remote, fork-aware, pending-check polling.
- **Routes (existing `/api/github/*`):**
  - `auth/status`, `auth/start`, `auth/complete`, `auth/activate`, `auth` (delete)
  - `me`
  - `pr/status`, `pr/create`, `pr/update`, `pr/merge`, `pr/ready`
  - `issues/list`, `issues/get`, `issues/comments`
  - `pulls/list`, `pulls/context`
- **Client wrapper:** `packages/web/src/api/github.ts`
- **UI surfaces:**
  - `packages/ui/src/components/views/git/PullRequestSection.tsx`
  - `packages/ui/src/components/session/SessionSidebar.tsx`
  - `packages/ui/src/components/session/sidebar/SessionGroupSection.tsx`

We build on top of these. We do **not** fork them.

## Features

Ordered by priority. Each feature has: problem, UX, endpoints, UI location,
acceptance criteria, status.

### 1.2 Issue-to-Work Pipeline  (priority: **first**)

**Problem.** Going from "I opened this issue" to "I have a working session on
the right branch with the right context" is 6–7 manual steps today.

**UX.** From any issue list row, or the issue detail view, click *Work on this*:

1. Create a new branch off the repo's default branch. Slug is derived from
   issue title: `fix/<number>-<short-slug>` (bug label ⇒ `fix/…`,
   feature/enhancement ⇒ `feat/…`, otherwise `work/…`).
2. Open a new git worktree (reuse the existing worktree feature in
   `packages/ui/src/...` — do not invent a new one).
3. Start a fresh OpenCode session attached to that worktree.
4. Prefill the session's first user message with a *structured brief*:
   - Issue title + body
   - Acceptance criteria (if the issue has a `## Acceptance criteria` section)
   - Any linked PRs
   - File paths the issue mentions (extracted by regex: `path/to/file.ext`)
   - Labels
5. Open the session in plan mode with an initial prompt:
   `"Plan how to resolve issue #<N>. Use the brief above as ground truth.
    Don't write code yet."`
6. Leave the user at a ready-to-review plan.

**New endpoint.**
`POST /api/github/issues/start-work`
Body: `{ directory, owner, repo, issueNumber, baseBranch?, branchPrefix? }`
Response: `{ branch, worktreePath, brief, sessionSeed }`

The endpoint is pure server-side work: fetch issue, compute branch name,
create branch + worktree via `simple-git`, render brief. It does *not* start
the OpenCode session — that's the UI's job so we keep session lifecycle in
one place.

**UI entry points.**
- `PullRequestSection` gets a new button when viewing an issue-linked branch.
- A new *Start work* button on every issue card in the forthcoming inbox (1.1).
- Command palette entry: `GitHub: Work on issue…` (prompts for issue number).

**Files to create/touch.**
- `packages/web/server/lib/github/routes.js` — add the route
- `packages/web/server/lib/github/issue-brief.js` — new module, pure function
- `packages/web/server/lib/github/branch-naming.js` — new module, pure function
- `packages/web/server/lib/git/` (existing) — reuse worktree helper
- `packages/web/src/api/github.ts` — client wrapper
- `packages/ui/src/features/issue-work/` — new folder for UI trigger + dialog

**Acceptance criteria.**
- Works on repos with `origin` + `upstream` (fork setups).
- Fails gracefully if branch already exists locally: surface it, ask whether
  to reuse or pick a suffix.
- Respects the active GitHub account (multi-account aware).
- Brief is plain Markdown; no HTML in prompts.
- Cancelable: if worktree creation fails, the branch is removed.
- Type-check + lint clean. Unit test for `branch-naming` and `issue-brief`.

**Commit plan (suggested).**
1. `feat(teams/mode1/issue-to-work): add pure branch-naming + issue-brief modules with tests`
2. `feat(teams/mode1/issue-to-work): add /api/github/issues/start-work route`
3. `feat(teams/mode1/issue-to-work): add UI trigger and result dialog`
4. `feat(teams/mode1/issue-to-work): wire command palette entry`

Each commit must leave type-check/lint/build green on its own.

**Open questions (autonomous defaults in the table above apply).**
- Branch prefix per-repo override — default: skip, ship the label-based
  mapping only. Log to `IMPLEMENTATION_NOTES.md`.
- What if worktree helper requires a GUI step we can't trigger
  server-side? — block, do not invent a shell invocation.
- How to pass the session seed to the OpenCode session — default: prefill the
  first user message via the existing session creation API. If no such API
  surface exists yet, block.

**Stuck checks before writing code.**
- `packages/ui/src/**/*worktree*` — find the existing worktree creation path.
  If none exists or it's UI-only with no callable function, BLOCK.
- `packages/web/src/api/session*` or `packages/ui/src/**/session*` — find how
  new sessions are created with a seed message. If there's no programmatic
  seeder, BLOCK.

**Status:** shipped (commits: f35440a3, 50b84a88, 5251dfd7, 0848e04a).

---

### 1.1 Unified GitHub Inbox  (priority: **second**)

**Problem.** GitHub's own notifications UI is noisy and not actionable. Users
don't open it. Unread-count badges sit at 99+.

**UX.** New sidebar tab, *Inbox*. Left column: filters. Right column: list.

Filters:
- Review requested
- Assigned
- Mentioned
- CI failing (on my PRs)
- Stale (my PRs, no activity 7+ days)
- Ready to merge (my PRs, all checks green + approved)

Each row shows: repo, type (PR/issue/check), title, last activity, and action
buttons: *Start session*, *Snooze*, *Mark done*.

Snooze is local-only (GitHub has no snooze API). Stored in
`~/.config/openchamber/inbox-snooze.json`.

**Endpoints.**
- `GET /api/github/inbox` — aggregates notifications + "ready to merge" +
  "stale PRs" + "CI failing". Not a 1:1 mirror of `/notifications` — it's a
  computed feed.
- `POST /api/github/inbox/snooze` — local only.
- `POST /api/github/inbox/mark-done` — calls
  [`activity.markThreadAsRead`](https://docs.github.com/en/rest/activity/notifications).

**Files to create/touch.**
- `packages/web/server/lib/github/inbox.js` — new, heavy work module
- `packages/web/server/lib/github/routes.js` — new routes
- `packages/web/server/lib/github/snooze-store.js` — local JSON store
- `packages/ui/src/features/github-inbox/` — new UI

**Acceptance criteria.**
- One aggregated fetch. Budget: ≤ 3 API requests per filter tab refresh.
- Rows respect rate limits (handle `X-RateLimit-Remaining` gracefully).
- `Start session` on an issue row calls Feature 1.2's flow.
- Filter state is per-account.

**Commit plan.**
1. `feat(teams/mode1/inbox): add inbox aggregator module + snooze store with tests`
2. `feat(teams/mode1/inbox): add /api/github/inbox* routes`
3. `feat(teams/mode1/inbox): add sidebar tab and list UI`
4. `feat(teams/mode1/inbox): wire per-row actions to existing flows`

**Open questions.**
- Polling interval when inbox tab is active — default: 60s, pause on tab
  hidden. Configurable later.
- "Ready to merge" criteria — default: `mergeable === true && reviews has
  APPROVED && no failing required checks`. If branch protection info is
  unavailable for a repo, omit that row rather than falsely claiming ready.
- "Stale PR" threshold — default: 7 days since last activity on the user's
  own open PRs.

**Stuck checks.**
- Confirm the existing sidebar tab registration pattern
  (`packages/ui/src/components/session/SessionSidebar.tsx` neighbors).
- Confirm `activity.listNotificationsForAuthenticatedUser` is callable with
  the default token scopes.

**Status:** planned, after 1.2 ships.

---

### 1.3 PR Cockpit

**Problem.** `PullRequestSection` today covers create/update/merge/ready, but
reviews, conversations, check logs, and merge-queue state are scattered. The
user still needs github.com for the "why can't I merge?" moment.

**UX.** Extend `PullRequestSection` into a full cockpit with:
- Checks list with per-check status and *Fix with AI* (feature 1.5)
- Reviewers panel (who reviewed, who's requested, who's waiting)
- Conversation panel (inline + general comments, resolved/unresolved)
- Branch-protection diagnostic line ("Can't merge: 1 required check failing")
- Timeline of force-pushes, rebases, label changes

**Endpoints.**
- `GET /api/github/pr/reviews` — `pulls.listReviews` + `pulls.listRequestedReviewers`
- `GET /api/github/pr/comments` — inline + issue comments merged
- `GET /api/github/pr/protection` — branch protection + why-not-mergeable
- (Reuse) `pulls.context` for the rest.

**Files.** Extend, don't duplicate, `PullRequestSection.tsx`. New subcomponents:
- `packages/ui/src/components/views/git/pr/ChecksPanel.tsx`
- `packages/ui/src/components/views/git/pr/ReviewersPanel.tsx`
- `packages/ui/src/components/views/git/pr/ConversationPanel.tsx`
- `packages/ui/src/components/views/git/pr/ProtectionBanner.tsx`

**Acceptance criteria.**
- No regression to existing sidebar PR badges (shared store unchanged).
- Cockpit loads incrementally (checks first, then reviews, then comments).
- "Why can't I merge?" is a single line, human-readable.

**Commit plan.**
1. `feat(teams/mode1/pr-cockpit): add reviews + comments + protection endpoints`
2. `feat(teams/mode1/pr-cockpit): add ChecksPanel subcomponent`
3. `feat(teams/mode1/pr-cockpit): add ReviewersPanel subcomponent`
4. `feat(teams/mode1/pr-cockpit): add ConversationPanel subcomponent`
5. `feat(teams/mode1/pr-cockpit): add ProtectionBanner + wire into PullRequestSection`

Panels may ship in any order after the endpoints land. Each panel ships with
its own loading + error states.

**Open questions.**
- Should the cockpit replace the current PR section, or add below it?
  Default: extend in place. Visual change stays minimal until all panels
  ship, then a second pass re-organizes layout.
- Branch-protection detail level — default: surface the human summary from
  `repos.getBranchProtection`, don't duplicate GitHub's full policy UI.

**Stuck checks.**
- Confirm `PullRequestSection.tsx` is the single PR view (no duplicate views
  in `packages/ui/src/components/views/git/*`).
- Confirm the shared PR store in `packages/ui/src/stores/**` can add
  cockpit-local fields without causing cascading re-renders in the sidebar.

**Status:** planned, concurrent with 1.4.

---

### 1.4 Review-Comment-to-Session

**Problem.** PR review threads contain many small asks. Each one needs context:
the file, the hunk, the thread history. Setting that up by hand is friction.

**UX.** Every inline review comment row in the cockpit gets a *Start session
with this comment* action. The resulting session is opened on the PR's branch
(worktree if one exists), with the first user message prefilled:
- Reviewer's comment
- The hunk being commented on
- The full thread (all replies)
- Path + line
- Prompt: `"The reviewer is asking for the change above. Propose a minimal diff."`

**Endpoints.** No new endpoint. This reuses `pulls.context` + the session
creation flow that Feature 1.2 builds.

**Files.** `packages/ui/src/features/review-comment-session/` — just the UX
wire-up. The server-side primitive is already there.

**Acceptance criteria.**
- Works on inline review comments, not just PR-level comments.
- Correct handling of outdated comments (comment no longer maps to the file).

**Commit plan.**
1. `feat(teams/mode1/review-comment): add session seed builder for review comments`
2. `feat(teams/mode1/review-comment): wire Start-session action into ConversationPanel`

**Open questions.**
- If the target file doesn't exist locally (e.g. deleted), should we still
  open the session? Default: yes, include the pre-delete content from the
  PR's diff in the seed.
- Outdated comments (`diffHunk` no longer matches HEAD). Default: include the
  original hunk as context and mark it `[outdated]` in the seed.

**Status:** planned, after 1.3 is enough to host the entry point.

---

### 1.5 Actions Log Triage

**Problem.** "CI failed" is a dead end without the log. Users end up pasting
logs into chat by hand.

**UX.** On any failing check in the cockpit (or inbox), *Debug with AI*:
1. Fetch the failing job's log.
2. Pull the failing step's section (by log marker / `##[error]` scan).
3. Pull the diff at the failing SHA.
4. Open a session with a prefilled prompt:
   `"CI failed as shown below. Here is the diff of the commit that failed.
    Propose the smallest fix."`

**Endpoints.**
- `GET /api/github/checks/logs` — query: `{ owner, repo, runId, jobId }`
  returns excerpted log + error context. GitHub's raw logs are large; we
  bound the response to the last `N` lines + matched error blocks.

**Files.**
- `packages/web/server/lib/github/checks-logs.js` — new
- `packages/ui/src/features/ci-triage/` — new UI trigger

**Acceptance criteria.**
- Excerpt is ≤ 200 KB in typical failures.
- Works on both GitHub Actions (fully supported) and 3rd-party checks (best
  effort: link out if no log API available).

**Commit plan.**
1. `feat(teams/mode1/ci-triage): add log-excerpt module + tests`
2. `feat(teams/mode1/ci-triage): add /api/github/checks/logs route`
3. `feat(teams/mode1/ci-triage): add Debug-with-AI action in ChecksPanel`

**Open questions.**
- How to parse "the failing step" across different runners. Default:
  - GitHub Actions: match `##[error]` and `##[group]Run …/##[endgroup]` markers.
  - Others: last 500 lines of the job log.
- Large log files. Default: tail-sample (first 50 lines + last 200 lines +
  any `##[error]` blocks). Hard cap 200 KB.
- Private-repo log access depends on token scope. If 403, surface a clear
  "permissions: add `actions:read`" message.

**Stuck checks.**
- Confirm `getOctokitOrNull()` returns a client with `actions.downloadJobLogsForWorkflowRun` available.

**Status:** planned, after 1.3.

---

### Smaller/auxiliary improvements (batched)

These are one-prompt, one-change items. Do not promote any of them to features
until Mode 1's five headline flows above are shipped.

- **Draft PR description from commits** — already exists; leave as-is.
- **Summarize long review thread** — adds a button to ConversationPanel that
  sends the thread + code context to the agent with a summary prompt.
- **Suggest reviewers** — uses `git log --follow` on the PR's changed files to
  propose people. Pure heuristic, no CODEOWNERS (that's Mode 2).
- **Release-notes generator** — list merged PRs this week, prompt the agent.

## Shipping order

1. Baseline green (type-check, lint, build) on the fork.
2. Design doc merged (this file + `TEAMS_OVERVIEW.md`). **(done when this
   lands in main)**
3. **1.2 Issue-to-Work** end-to-end, behind no flag.
4. **1.3 PR Cockpit** panels, incrementally.
5. **1.4 Review-Comment-to-Session** (small, on top of 1.3).
6. **1.5 CI Triage** (self-contained).
7. **1.1 Inbox** (biggest UI, ships last because it depends on the others as
   action targets).
8. Batch the auxiliary improvements.

## Implementation discipline

- **Smallest correct change.** No drive-by refactors of unrelated GitHub code.
- **Follow local precedent.** New routes match the shape of existing routes
  in `routes.js` (same error handling, same `getOctokitOrNull()` guard).
- **Shared state over per-component fetches.** New UI surfaces subscribe to
  existing stores where possible; add new narrow stores when they would
  re-render high-frequency components.
- **No new dependencies** unless a feature fundamentally needs one. Ask first.
- **Keep cross-runtime parity.** If a new route is added, decide immediately
  whether the VS Code webview consumes it, and wire it if so.
- **Respect polling budgets.** The inbox must not add noticeable GitHub API
  rate-limit pressure for normal users.

## Open questions

- Branch-naming prefix mapping — we pick by label now. Should users be able
  to override per-repo? (Probably yes, but ship the default first.)
- Snooze storage — JSON file is fine for solo. If Mode 2 arrives, snoozes
  may need to be per-workspace.
- Inbox computed feed — should "stale PR" threshold be configurable?
  Default 7 days now, leave configurability for after shipping.
