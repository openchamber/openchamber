# GitHub Module Documentation

## Purpose

- This module owns GitHub auth, Octokit access, repo resolution, and Pull Request status resolution for OpenChamber.
- From user perspective, this is the layer that lets the app know which PR belongs to a local branch and keeps that UI feeling current.

## Entrypoints and structure

- `packages/web/server/lib/github/index.js`: public server entrypoint. `routes.js` loads it lazily with `await import('./index.js')` and destructures the handler it needs, so a re-export removed from here breaks a route at request time rather than at build time. Static "unused export" reports do not see these consumers.
- `packages/web/server/lib/github/routes.js`: Express route registration for `/api/github/*` endpoints.
- `packages/web/server/lib/github/auth.js`: auth storage, multi-account support, client id, scope config.
- `packages/web/server/lib/github/device-flow.js`: OAuth device flow.
- `packages/web/server/lib/github/octokit.js`: Octokit factory for the current auth.
- `packages/web/server/lib/github/repo/index.js`: remote URL parsing and directory-to-repo resolution.
- `packages/web/server/lib/github/pr-status.js`: PR lookup across remotes, forks, and upstreams.
- `packages/web/server/lib/github/pr-summaries.js`: batched live state for PRs already known by number.
- `packages/web/server/lib/github/checks-summary.js`: the one checks summarizer shared by every PR route.
- `packages/web/server/index.js`: API route layer that calls this module.
- `packages/web/src/api/github.ts`: web client wrapper for GitHub endpoints.

## Public exports

### Auth

- `getGitHubAuth()`: current auth entry.
- `getGitHubAuthAccounts()`: all configured accounts.
- `setGitHubAuth({ accessToken, scope, tokenType, user, accountId })`: save or update account.
- `activateGitHubAuth(accountId)`: switch active account.
- `clearGitHubAuth()`: clear current account.
- `getGitHubClientId()`: resolve client id.
- `getGitHubScopes()`: resolve scopes.
- `GITHUB_AUTH_FILE`: auth file path.

### Device flow

- `startDeviceFlow({ clientId, scope })`: request device code.
- `exchangeDeviceCode({ clientId, deviceCode })`: poll for access token.

### Octokit

- `getOctokitOrNull()`: current Octokit or `null`.

### Repo

- `parseGitHubRemoteUrl(raw)`: parse SSH or HTTPS remote URL into `{ owner, repo, url }`.
- `resolveGitHubRepoFromDirectory(directory, remoteName)`: resolve GitHub repo from a local git remote.

## Auth storage and config

- Auth storage: `~/.config/openchamber/github-auth.json`
- Writes are atomic and file mode is `0o600`.
- Client ID resolution order: `OPENCHAMBER_GITHUB_CLIENT_ID` -> `settings.json` -> default.
- Scope resolution order: `OPENCHAMBER_GITHUB_SCOPES` -> `settings.json` -> default.
- Account id resolution order: explicit `accountId` -> user login -> user id -> token prefix.

## PR integration overview

- The UI asks `github.prStatus(directory, branch, remote?)` from `packages/web/src/api/github.ts`.
- That hits `GET /api/github/pr/status` in `packages/web/server/index.js`.
- The route calls `resolveGitHubPrStatus(...)` in `packages/web/server/lib/github/pr-status.js`.
- The resolver finds the most likely repo and PR for a local branch.
- The route then enriches that result with checks, mergeability, and permission-related fields.
- The client caches and shares the result between sidebar and Git view.

## Consumers of PR data

PR list/search failures propagate as errors instead of successful empty lists.
Comparison pickers use these responses to offer retry rather than claiming the
repository has no PRs. A failed repository in a multi-repository listing fails
that page, so callers cannot mistake a partial page for a complete one.

- `packages/ui/src/components/session/SessionSidebar.tsx` reads all PR entries and maps them to `directory::branch`.
- `packages/ui/src/components/session/sidebar/SessionGroupSection.tsx` renders the compact badge, PR number, title, checks summary, and GitHub link.
- `packages/ui/src/components/views/git/PullRequestSection.tsx` uses the same shared entry for the full PR workflow.
- `packages/ui/src/components/ui/MemoryDebugPanel.tsx` reads request counters for debugging.

## How PR resolution works

- It reads local git status and remotes first.
- It ranks remotes in this order: explicit remote, tracking remote, `origin`, `upstream`, then the rest.
- It resolves those remotes into GitHub repos.
- It expands each repo through `parent` and `source` so PRs in upstream repos can still be found.
- It skips PR lookup when the current branch matches that repo's default branch.
- It first searches for **open** PRs by likely source owner plus exact head branch.
- If that fails, it falls back to broader GitHub search for open PRs on the branch name.
- An **open PR from any candidate repo always wins** over a closed/merged one, so a merged fork PR can never hide an open upstream PR for the same head.
- Only when no target has an open PR does it return the branch's newest closed/merged PR, as history — and only when that PR's head commit is an ancestor of the checkout's `HEAD`. History is matched by branch name, and names get reused: a fresh worktree cut from the default branch under a name that was merged before must not inherit the old PR.
- History is looked up **only for the ranked-first remote and the branch's own name** — the repo it actually pushes to. Live status is worth searching the whole fork network for; history is not, and asking every target for it multiplies serial GitHub calls until the route hits its `12s` resolve timeout and returns no status at all.
- The history answer is remembered per repo+branch so discovery polls do not re-query it: a found closed/merged record for `6h`, and "no history yet" for `10m`. A found record only changes if a second PR appears on the same head, and while that one is open the open-PR path wins without ever reading this cache.
- Creating, merging, or closing a PR invalidates both the shared repo pull list and that remembered history.
- The route skips the checks summary and the merge-permission lookup for a closed/merged PR: neither is actionable, and both cost extra GitHub calls.
- `403` and `404` during repo lookups are treated as expected gaps, not hard errors.

## Batched live summaries

- `POST /api/github/pr/summaries` takes up to `100` `{ owner, repo, number }` refs and answers `{ connected, fetchedAt, summaries }`.
- It sends one GraphQL document per `25` PRs, one after another. Each alias reads state, draft, title, head sha, `mergeable`, `mergeStateStatus` (lowercased, same values as REST `mergeable_state`) and up to `100` check contexts of the head commit. GitHub prices such a document at one point of the GraphQL budget (measured), which is separate from the REST limit.
- Checks go through the same summarizers as the REST routes (`checks-summary.js`), so sidebar, chat and Git view count the same runs. Do not switch to the rollup's `state` or `checkRunCountsByState`: both still count a failed run that a later re-run superseded, which paints a green PR as failing. A closed/merged PR gets `checks: null`.
- A PR GitHub cannot resolve (deleted, lost access) is left out of `summaries`: absence means unknown, never closed. Partial GraphQL answers keep the resolved aliases.
- A GraphQL `RATE_LIMITED` error (HTTP 200) records the shared rate-limit cooldown like a REST 403/429 and returns `503`; while the cooldown runs the route answers `503` without calling GitHub.
- This route never discovers PRs; branch-to-PR resolution stays with `GET /api/github/pr/status`.

## Shared client state model

- Client key is effectively `directory::branch`.
- One entry stores last known status, loading state, error, timestamps, watcher count, identity, and resolved remote.
- Requests are deduplicated by branch signature, not by component instance.
- This keeps sidebar and Git view aligned and avoids duplicated fetches.

## Persistence

- PR state is persisted in local storage under `openchamber.github-pr-status`.
- Persisted fields include status, timestamps, identity, and resolved remote.
- Runtime-only details are not persisted.
- Persisted entries expire after 12 hours.
- On reload, users get last known state first, then background refresh resumes.

## Polling and refresh model

- There are two layers: entry-level polling in `useGitHubPrStatusStore` and repo scanning in `useGitHubPrBackgroundTracking`.
- Entry-level polling decides when a known branch should revalidate PR state.
- Background tracking decides which directories and branches should even be watched.

## Entry-level polling rules

- Start watching -> immediate refresh.
- If no PR is found yet -> retry after `2s` and `5s`.
- Still no PR -> discovery refresh every `5m`.
- Open PR with pending checks -> refresh about every `1m`.
- Open PR with non-pending checks -> refresh about every `5m`.
- Open PR without a stable checks signal -> refresh about every `2m`.
- Closed or merged PR -> discovery refresh every `5m` (do not permanently stop polling).
- Hidden tab -> skip polling.
- Non-forced refreshes use a `90s` TTL.
- Failed non-forced attempts also observe the `90s` TTL so transient server or rate-limit failures cannot retry on every sidebar update. Forced user/action refreshes bypass this guard.

## Persistence notes for terminal PRs

- Closed/merged branch associations are persisted like open ones, so a reload still shows that the branch's PR was merged.
- Hydrate resets `lastDiscoveryPollAt` for them, so restored history revalidates on the first watcher tick instead of waiting out a discovery interval.

## Background tracking rules

- Track up to `50` likely directories.
- Sources are current directory, projects, worktrees, active sessions, and archived sessions.
- Active directory branch TTL is `15s`.
- Background directory branch TTL is `2m`.
- Background scan wakes every `15s`, but only fetches directories whose TTL expired.
- Each scan reads `branch`, `tracking`, `ahead`, and `behind` from git status.
- If any of those branch signals change, that branch's PR status refreshes immediately.
- After that, one more delayed refresh runs after `5s` to catch GitHub eventual consistency.

## UI refresh triggers

- App or tab becomes visible.
- Window regains focus.
- Current branch changes.
- Tracking branch changes.
- Ahead or behind changes.
- User selects a different remote in Git view.
- GitHub auth state changes.

## Action-based refreshes in Git view

- After `Create PR` -> refresh now, then after `2s` and `5s`.
- After `Merge PR` -> refresh now, then after `2s` and `5s`.
- After `Mark ready for review` -> refresh now, then after `2s` and `5s`.
- After `Update PR` -> refresh now, then after `2s` and `5s`.

## Sidebar behavior

- Sidebar rows are not watched. The tracked set is the worktree branches whose badge is on screen in the current mode: Timeline rows in Timeline; expanded project groups and Recent rows in Projects; In work rows in both. Collapse state from the Projects view never limits Timeline. For that set the sidebar runs discovery through `refreshTargets` (first resolution, then every `5m` while a branch has no PR or only a closed/merged one).
- Open PRs on those rows stay live through batched summaries (`useOpenPrSummarySync`): every `2m` while the window is visible, again when the window regains focus or visibility (at most once per `15s`), when new rows appear, and when cached statuses finish restoring after a reload. A PR merged or closed on GitHub turns so on the next batch, and failing checks show up the same way.
- The batch skips watched entries (the Git view refreshes those in full) and PRs asked about within the cadence. A failed batch keeps the last known status and waits for the next cadence.
- A session row shows its worktree branch's PR and the PRs linked to the session (`openchamber.linked_issues` entries of kind `pull`, see `packages/ui/src/lib/linkedIssues.ts`), each once, most urgent first (`blocked`, `open`, `draft`, `merged`, `closed`); the badge names the first and counts the rest, the tooltip lists all. Links come from a PR attached in the composer, a worktree created from a PR, the issue picker, the chat's Linked section, and a PR created in the Git view (linked to the open session when it works in that directory).
- Linked PRs join the same live-summary batches; their state lives in `linkedSummaries` (runtime-only, never persisted). A merged link is not asked about again; a closed one stays on the cadence because it can reopen.
- Sidebar shows only compact PR state.
- Aggregation is by `directory::branch`, so multiple sessions on one branch share one signal.
- If multiple entries exist, sidebar keeps the strongest visible PR state.
- Visual state is based on PR health, not merge permissions.
- Orange (`blocked`) means something to fix: failed checks or conflicts (`mergeable: false`, `dirty`). A `blocked` merge state alone, which usually means a required review is missing, keeps the open colour and never reads "Ready to merge". Sidebar, Git view and Git header apply the same rule.

## Git view behavior

- Git view watches one branch directly.
- It supports create, edit, mark ready, and merge.
- It can probe alternate remotes so fork-heavy setups still find the right PR.
- It uses the same shared store as the sidebar.

## Failure handling

- If GitHub is disconnected, API returns `connected: false`.
- If a repo is private or inaccessible, resolver calls may quietly return no PR.
- Sidebar stays quiet on missing or inaccessible PR state.
- Git view is where explicit PR-level problems should be shown.

## Notes for contributors

- Keep the UI calm. Do not add noisy diagnostics to the sidebar.
- Prefer shared state over per-component fetches.
- Prefer event-shaped refreshes over blind frequent polling.
- Prefer correctness for fork and multi-remote setups over assuming `origin` is enough.
- Device flow handles GitHub `authorization_pending` at caller level.
- Repo parser supports `git@github.com:`, `ssh://git@github.com/`, and `https://github.com/`.
