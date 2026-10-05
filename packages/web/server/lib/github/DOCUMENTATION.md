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
- `packages/web/server/lib/github/pr-summaries.js`: batched live state for PRs already known by number.
- `packages/web/server/lib/github/reference-search.js`: issue and PR pages for the reference picker.
- `packages/web/server/lib/github/checks-summary.js`: the one checks summarizer shared by every PR route.

## Public exports

### Auth

- `getGitHubAuth()`: current auth entry.
- `getGitHubAuthAccounts()`: all configured accounts.
- `getGitHubAuthByAccountId(credentialId, revision?)`: exact valid persisted credential lookup with optional revision pinning and no current-account or CLI fallback. The returned record keeps `credentialId` separate from `providerUserId`.
- `setGitHubAuth({ accessToken, scope, tokenType, user, accountId })`: save or update account; the new account becomes current and gh CLI activation is cleared.
- `activateGitHubAuth(accountId)`: switch active account; switching to a saved account clears gh CLI activation.
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
- `getOctokitForAccountId(accountId)`: exact persisted or verified CLI Octokit context with credential revision and provider-user identity. It never falls back to another account. A `github.com#cli:` id resolves only while the user has switched to the gh account (`isGhCliActive()`); the gh token is otherwise read only to list the gh account in Settings.

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
- Only when no target has an open PR does it return the branch's newest closed/merged PR, as history — and only when that PR's head commit is an ancestor of the checkout's `HEAD`. History is matched by branch name, and names get reused: a fresh worktree cut from the default branch under a name that was merged before must not inherit the old PR.
- History is looked up **only for the ranked-first remote and the branch's own name** — the repo it actually pushes to. Live status is worth searching the whole fork network for; history is not, and asking every target for it multiplies serial GitHub calls until the route hits its `12s` resolve timeout and returns no status at all.
- The history answer is remembered per repo+branch so discovery polls do not re-query it: a found closed/merged record for `6h`, and "no history yet" for `10m`. A found record only changes if a second PR appears on the same head, and while that one is open the open-PR path wins without ever reading this cache.
- Creating, merging, or closing a PR invalidates both the shared repo pull list and that remembered history.
- The route skips the checks summary and the merge-permission lookup for a closed/merged PR: neither is actionable, and both cost extra GitHub calls.
- `403` and `404` during repo lookups are treated as expected gaps, not hard errors.

## Batched live summaries

- `fetchPrSummaries` (`pr-summaries.js`) reads the live state of PRs and issues already known by number, up to `100` `{ owner, repo, number }` in total, for the tracked-items service (`../tracked-items/`), which calls it with the account a branch's repository is bound to or, for linked items, the current github.com account. It has no route of its own. It answers `{ summaries, issueSummaries }`. An issue reads `open`, `completed`, or `not_planned` (GitHub's `NOT_PLANNED` and `DUPLICATE` close reasons); a PR number asked as an issue is simply absent.
- It sends one GraphQL document per `25` PRs, one after another. Each alias reads state, draft, title, head sha, `mergeable`, `mergeStateStatus` (lowercased, same values as REST `mergeable_state`) and up to `100` check contexts of the head commit. GitHub prices such a document at one point of the GraphQL budget (measured), which is separate from the REST limit.
- Checks go through the same summarizers as the REST routes (`checks-summary.js`), so sidebar, chat and Git view count the same runs. Do not switch to the rollup's `state` or `checkRunCountsByState`: both still count a failed run that a later re-run superseded, which paints a green PR as failing. A closed/merged PR gets `checks: null`.
- A PR GitHub cannot resolve (deleted, lost access) is left out of `summaries`: absence means unknown, never closed. Partial GraphQL answers keep the resolved aliases.
- A GraphQL `RATE_LIMITED` error (HTTP 200) records the shared rate-limit cooldown like a REST 403/429; while the cooldown runs the tracked-items reader does not call GitHub.
- It never discovers PRs; branch-to-PR resolution stays with `GET /api/source-control/github/pr/status`.

## Reference picker lists

- `GET /api/source-control/github/references?<read context>&kind=issue|pull&filter=&query=&cursor=` takes the same bound read context as every canonical read and answers one page (30) of the project's issues or PRs across its repo network, read with that context's account (origin plus fork parent/source): `{ connected, repo, items, cursor, hasMore, total }`. `repo: null` means the project has no GitHub remote.
- One GraphQL `search` document per page, open items newest-activity first. `filter` adds `assignee:@me` (`assigned`), `author:@me` (`created`) or `review-requested:@me` (`reviewRequested`); anything else is `open`. User text is appended as is, so GitHub qualifiers work; state and sort are added only when the text sets none.
- A pasted `#123`, `123` or github.com issue/PR link skips search and reads that number with `issueOrPullRequest` in every network repo (a link: only its own repo), whatever the tab's kind.
- Each item carries what a row and the preview show: state (issues `open` / `completed` / `not_planned`, PRs `open` / `closed` / `merged`), author, labels, comment count, the body cut at 20 000 characters (`bodyTruncated`), and for a PR draft, head/base and head repo (with `cloneUrl` for fork worktrees).
- `GET /api/source-control/github/references/detail?<read context>&owner=&repo=&number=` answers what the preview adds for one item: the newest 50 comments, oldest first, plus for a PR its reviews (a review's text or verdict, and each line comment with `path`/`line`), size and review decision. Its checks come from `references/status`, the same answer that colours it. The repo must be in the project's network. These fields stay off the page query: on a 30-PR page size, review decision and checks together ran past GitHub's 10 s search timeout (measured 2026-10-01), while one item answers in about a second.
- `GET /api/source-control/github/references/status?<read context>&pulls=owner/repo#n,...` answers what colours the PRs a picker page shows, at most 30: `{ connected, statuses: [{ owner, repo, number, checks, mergeable, mergeableState }] }` from `fetchPrSummaries`, the sidebar's summaries, so the picker and the sidebar colour a PR the same way. Every repo must be in the project's network. A PR GitHub could not resolve is left out. Mergeability is most of its cost (30 PRs: about 2 s with checks only, 4 to 7 s with mergeability, measured 2026-10-06), so it is a request after the page, not part of it.
- Failures are errors, never an empty page; GraphQL `RATE_LIMITED` records the shared cooldown and answers `503`. The client cache lives in `packages/ui/src/components/references/`.
- Attaching still reads full context through the canonical `issues/get` + `issues/comments` and `pulls/context`.

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

- Sidebar rows are not watched. The tracked set is the worktree branches whose badge is on screen in the current mode: Timeline rows in Timeline; expanded project groups and Recent rows in Projects; In work rows in both. Collapse state from the Projects view never limits Timeline. For that set (at most 50 directories) the sidebar reads each directory's repository binding and runs discovery through `refreshTargets` under the binding's read context: on first resolution, and again for a branch with no PR or only a closed/merged one when an agent turn finishes in its directory (`openchamber:source-control.activity`) or when the user comes back to the window and the last answer is older than `60s`. Nothing polls.
- Open PRs on those rows, and in the Git view, are followed by the server as tracked items read with the bound account (`getBranchTrackedPull`, `../tracked-items/`), which pushes their state and checks when they move; `applyTrackedPulls` lays them on every entry of that PR. A full refresh newer than the pushed state wins.
- A session row shows its worktree branch's PR and the PRs linked to the session (`openchamber.linked_issues` entries of kind `pull`, see `packages/ui/src/lib/linkedIssues.ts`), each once, most urgent first (`blocked`, `open`, `draft`, `merged`, `closed`); the badge names the first and counts the rest, the tooltip lists all. Links come from issues and PRs attached in the composer, a worktree created from a PR, the chat's Linked section, a PR created in the Git view (linked to the open session when it works in that directory), and an agent's `session.link` call through the managed `openchamber` tool.
- Pull and merge requests linked from other services (an extension's PR, a GitLab merge request attached in the composer or linked by an agent; `getLinkedSidebarChanges`) follow the GitHub PRs in the same badge and tooltip; GitLab merge requests carry their live state from the tracked items, others show by identifier, uncoloured. A linked GitHub PR whose live state has not arrived (not fetched yet, GitHub signed out, a failed batch) is listed the same way as `#N`, so a PR linked after an issue takes the row over at once rather than when GitHub answers. They count as PRs for the rule below.
- A link of any origin whose address is a github.com pull request or issue is that GitHub thread (`getGitHubThreadRef` in `linkedIssues.ts`); a GitLab issue or merge request with the same `owner/repo#N` id is not: it joins the live batches, takes the state colours, and appears once even when the same thread was linked directly and through an extension.
- A session with no PR at all shows its linked issues instead, never both and never counted together (maintainer decision, 2026-10-01): GitHub issues with live state from the same batches (`linkedIssueSummaries`, runtime-only, kept on the cadence even when closed because issues reopen), Linear issues with live state from Linear (`useLinearIssueStateStore`, the team's own state name, coloured by state type: triage, backlog, unstarted and started as open, completed as completed, canceled as not planned), extension trackers by identifier only, muted. Issue colours reuse the PR tokens: open `--pr-open`, completed `--pr-merged`, not planned `--pr-closed`; an issue is never orange. A worktree group header follows the same rule at group level: its branch PR, or else the issues linked to the sessions in the group (a worktree started from an issue records the link on its session, not on the worktree).
- Agents link through the managed tool's `session.link` (`../openchamber-sessions/session-link.js`, contract in `../openchamber-control/DOCUMENTATION.md`). A GitHub address becomes the same `openchamber.linked_issues` entry the UI writes, through the server's queued metadata update, which decides the list at write time, so concurrent agent links never drop each other, and the metadata broadcast updates every open client. A UI link or unlink still reads the list, changes it locally and writes it whole, so an agent link landing inside that window is lost; closing it means moving UI link edits to a server-decided route too. The title comes from the agent; the live summaries above report GitHub's own.
- Linked PRs join the same live-summary batches; their state lives in `linkedSummaries` (runtime-only, never persisted). A merged link is not asked about again; a closed one stays on the cadence because it can reopen.
- Sidebar shows only compact PR state.
- Aggregation is by bound repository authority plus directory and branch, so account or binding changes cannot reuse old status.
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
