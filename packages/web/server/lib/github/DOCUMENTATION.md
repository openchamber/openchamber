# GitHub Module Documentation

## Purpose

- This module owns GitHub auth, Octokit access, repo resolution, and Pull Request status resolution for OpenChamber.
- From user perspective, this is the layer that lets the app know which PR belongs to a local branch and keeps that UI feeling current.

## Entrypoints and structure

- `packages/web/server/lib/github/index.js`: public server entrypoint. `routes.js` loads it lazily with `await import('./index.js')` and destructures the handler it needs, so a re-export removed from here breaks a route at request time rather than at build time. Static "unused export" reports do not see these consumers.
- `packages/web/server/lib/github/routes.js`: Express route registration for canonical `/api/source-control/github/*` resources, shared auth compatibility paths, and fail-closed retired `/api/github/*` resources.
- `packages/web/server/lib/github/auth.js`: auth storage, multi-account support, client id, scope config.
- `packages/web/server/lib/github/device-flow.js`: OAuth device flow.
- `packages/web/server/lib/github/octokit.js`: Octokit factories for legacy current auth and immutable account IDs.
- `packages/web/server/lib/github/repo/index.js`: remote URL parsing and directory-to-repo resolution.
- `packages/web/server/lib/github/pr-status.js`: PR lookup across remotes, forks, and upstreams.
- `packages/web/server/lib/source-control/routes.js`: provider registry that registers this module and supplies repository binding validation plus the durable mutation executor.

## Public exports

### Auth

- `getGitHubAuth()`: current auth entry.
- `getGitHubAuthAccounts()`: all configured accounts.
- `getGitHubAuthByAccountId(credentialId, revision?)`: exact valid persisted credential lookup with optional revision pinning and no current-account or CLI fallback. The returned record keeps `credentialId` separate from `providerUserId`.
- `setGitHubAuth({ accessToken, scope, tokenType, user, accountId })`: save or update account.
- `activateGitHubAuth(accountId)`: switch active account.
- `clearGitHubAuth()`: clear current account.
- `markGitHubAuthAccountInvalid(accountId)`: retain exact account metadata but make its credential unavailable.
- `removeGitHubAuthAccount(accountId)`: remove exactly one persisted account.
- `getGitHubClientId()`: resolve client id.
- `getGitHubScopes()`: resolve scopes.
- `GITHUB_AUTH_FILE`: auth file path.

### Device flow

- `startDeviceFlow({ clientId, scope, fetch, timeoutMs })`: request and validate the provider grant with a bounded request that rejects redirects.
- `exchangeDeviceCode({ clientId, deviceCode, fetch, timeoutMs })`: server-internal access-token polling. The provider device code never crosses the OpenChamber HTTP boundary.

### Octokit

- `getOctokitOrNull()`: current Octokit or `null`.
- `getOctokitForAccountId(accountId)`: exact persisted or verified CLI Octokit context with credential revision and provider-user identity. It never falls back to another account.

### Repo

- `parseGitHubRemoteUrl(raw)`: parse SSH or HTTPS remote URL into `{ owner, repo, url }`.
- `resolveGitHubRepoFromDirectory(directory, remoteName)`: resolve GitHub repo from a local git remote.

## Auth storage and config

- Auth storage: `~/.config/openchamber/github-auth.json`
- Writes are atomic and file mode is `0o600`.
- Client ID resolution order: `OPENCHAMBER_GITHUB_CLIENT_ID` -> `settings.json` -> default.
- Scope resolution order: `OPENCHAMBER_GITHUB_SCOPES` -> `settings.json` -> default.
- New verified credentials use immutable opaque `occred:v1:github:<uuid>:r1` IDs. Their separate `providerUserId` is `github.com#<numeric-provider-user-id>`, so login changes do not change provider identity. Reading a legacy verified entry preserves its migrated provider-user ID as the credential ID so existing `ocgit:v1` references remain exact; the next explicit transport save writes `ocgit:v2` with the stored credential revision.
- Account inventory contains `valid` and `invalid` records without tokens. A provider `401` marks only the acting account invalid; network failures and resource `403` responses do not invalidate it.

## HTTP routes

- `/api/source-control/github/capabilities` is the provider-neutral capability endpoint.
- GitHub auth, PR, repository, issue, and pull-context handlers use `/api/source-control/github/*` as their canonical paths.
- Account-management handlers retain `/api/github/*` aliases for login and account-inventory compatibility. Both `/api/github/me` and `/api/source-control/github/me` are retired with `410` and `SOURCE_CONTROL_ACCOUNT_CONTEXT_REQUIRED` because no production consumer supplies exact account authority. Legacy PR, repository, issue, and pull-context paths return `410` with `SOURCE_CONTROL_CONTEXT_REQUIRED` before account, repository, cache, or provider work.
- `/api/source-control/github/auth/accounts` and its legacy alias return token-free persisted account inventory.
- Device-flow start returns an opaque `flowId`, user code, verification URL, expiry, and polling interval. The process-local source-control registry retains the provider device code and starting client ID. Completion accepts only `flowId`; pending and slow-down responses release it for another poll, while success, denial, expiry, and malformed terminal responses consume it. Restart, unknown IDs, and consumed IDs return `410`; concurrent polls return `409`.
- Canonical issue, upstream, branch, and pull reads require the repository read context. They validate the binding before exact credential lookup, repository or fork-network resolution, metadata cache access, or a GitHub call. A server without binding validation returns `501` for these reads.
- Canonical reads use the exact account and primary remote returned by validation. A GitHub `401` invalidates only that account. `403` and network failures remain read errors and do not change account state.
- Route, PR discovery, and repository metadata caches use an opaque digest of both account ID and credential. Canonical status cache keys also include the trusted repository ID and binding revision, so path replacement and rebinding cannot reuse a warm response. Exact accounts and repository bindings are resolved before cache reads, and bound repository validation always precedes fork metadata cache reads.
- Canonical PR create, update, merge, and ready routes validate the complete mutation context before credential, Git, cache, or provider access. They use only the validated account and trusted primary remote, require the target and source to belong to the provider-reported fork network, and return durable mutation receipts. Retired `/api/github/pr/*` mutations never enter this flow.
- Canonical mutations resolve the exact local credential and its revision before inspecting durable state. The exact credential ID and revision remain in authorization and digest input, while the route derives the provider-user ID from that resolved credential and passes it separately as receipt actor `providerAccountId` and audit identity. A client-supplied provider-user ID is never accepted as authority and cannot affect either value. Terminal records replay their compact result or stored error without provider repository preflight, but only after exact credential resolution. Running records lazily read only the provider state needed for reconciliation and never repeat a write. New keys retain the full strict preflight before claim and the single provider write. Changed credential, revision, input, or binding authority conflicts. Provider `4xx` rejections are definite failures; `5xx` and statusless transport failures after dispatch remain `outcome-unknown`.
- Cross-process execution exclusion, lock errors, and stopped-writer orphan recovery follow the [source-control lock contract](../source-control/DOCUMENTATION.md#cross-process-locks-and-manual-recovery). A live or crashed owner's execution lock blocks reconciliation; restarting alone does not remove it.
- Durable mutation records keep the exact credential account actor used for replay authorization, binding authority, server-resolved project and PR coordinates, an input digest, and compact public results only. Receipt and audit actor metadata use the separately verified provider-user ID. PR title/body text and raw provider payloads are not persisted or logged.
- A succeeded canonical mutation, including replay or restart reconciliation, invalidates PR status and context entries for every linked-worktree directory sharing its account credential, repository ID, binding revision, primary remote, and target number. It also cancels writes from matching canonical reads that started before invalidation, so their later responses cannot refill those caches. Other accounts, repositories, and bindings remain cached. Pull-list, history, and search-miss invalidation is limited to the same credential and target repository; matching in-flight writers may finish for their original callers but cannot restore invalidated entries. In-flight tokens are discarded when each request settles. Failed, conflicted, and outcome-unknown mutations do not invalidate caches.
- Auth removal requires the exact credential `accountId`. Missing authority returns `400` without consulting or removing the current account. Source-control binding reconciliation completes before that exact auth record is removed.

## PR integration overview

- Provider-neutral UI status reads first resolve the authoritative repository binding, then send its immutable read context to `GET /api/source-control/github/pr/status`.
- The canonical route validates that context before exact-account credential lookup. `/api/github/pr/status` is retired and returns `SOURCE_CONTROL_CONTEXT_REQUIRED`.
- The route calls `resolveGitHubPrStatus(...)` in `packages/web/server/lib/github/pr-status.js`.
- The resolver finds the most likely repo and PR for a local branch.
- The route then enriches that result with checks, mergeability, and permission-related fields.
- The client caches and shares the result between sidebar and Git view.

## Bound issues and repository metadata

- Issue lists and upstream detection start at the trusted primary remote. Branch selectors and optional issue detail selectors must match that repository or one of its parent/source repositories.
- Canonical selector reads fail when the fork network cannot be resolved. A selector outside the resolved network returns the existing empty/not-found response without calling GitHub for that selector.
- Canonical issue lists retain successful sibling repositories and return failed repository selectors in `failedRepos`. They reject if every repository fails.
- Canonical issue search rejects search endpoint failures. It enriches matched issues through their repository, retains successful enrichments with `failedRepos` for failed repositories, and rejects when every matched enrichment fails.
- Canonical issue search rejects malformed or out-of-network `repository_url` values instead of assigning those results to another repository in the fork network.
- Canonical branch, issue, pull-list, and pull-context reads reject malformed provider collections and records, including pull requests, comments, reviews, files, and fork metadata. Head-repository web and clone URLs must resolve to the reported repository on `github.com`. Pull-list reads may report failed non-primary repositories, but failure of the trusted primary remote fails the read.
- Canonical upstream reads propagate repository metadata, default-branch ref, rate-limit, and network failures. No ambient best-effort upstream route remains.
- Malformed optional check-run or combined-status collections are never summarized as zero checks. A valid fallback may still supply CI; otherwise CI remains unavailable. Failed or malformed workflow-job detail remains non-authoritative and may leave the check run without job details.

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
- Only when no target has an open PR does it return the branch's newest closed/merged PR, as history.
- History is looked up **only for the ranked-first remote and the branch's own name** — the repo it actually pushes to. Live status is worth searching the whole fork network for; history is not, and asking every target for it multiplies serial GitHub calls until the route hits its `12s` resolve timeout and returns no status at all.
- The history answer is remembered per repo+branch so discovery polls do not re-query it: a found closed/merged record for `6h`, and "no history yet" for `10m`. A found record only changes if a second PR appears on the same head, and while that one is open the open-PR path wins without ever reading this cache.
- Creating, merging, or closing a PR invalidates both the shared repo pull list and that remembered history.
- The route skips the checks summary and the merge-permission lookup for a closed/merged PR: neither is actionable, and both cost extra GitHub calls.
- `403` and `404` during repo lookups are treated as expected gaps, not hard errors.

## Shared client state model

- Bound client keys include runtime, provider instance, account ID, repository ID, binding revision, directory, branch, and primary remote. Multiple bound entries may coexist for the same provider instance; bound Git and Walkthrough readers select only an exact read context.
- One entry stores last known status, loading state, error, timestamps, watcher count, identity, and resolved remote.
- Requests are deduplicated by branch signature, not by component instance.
- This keeps sidebar and Git view aligned and avoids duplicated fetches.

## Persistence

- PR state is persisted in local storage under `openchamber.github-pr-status`.
- Persisted fields include status, timestamps, identity, and resolved remote. Hydration accepts an entry only when every authority dimension serialized in its key matches the embedded identity.
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

- Sidebar shows only compact PR state.
- Aggregation is by bound repository authority plus directory and branch, so account or binding changes cannot reuse old status.
- If multiple entries exist, sidebar keeps the strongest visible PR state.
- Visual state is based on PR health, not merge permissions.

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
