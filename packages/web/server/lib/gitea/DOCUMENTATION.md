# Gitea Module Documentation

## Purpose

- This module owns Gitea/Forgejo auth (Personal Access Token), raw REST v1 client access, remote-URL repo resolution, and Gitea issue / pull-request (PR) APIs for OpenChamber, including PR create/update/merge writes.
- From a user perspective, this is the layer that lets the app show Gitea issues and pull requests for a local project, including comments and per-file diffs, and create, edit, and merge pull requests.
- Gitea and Forgejo share the same GitHub-style REST v1 API, so this module serves both. Gitea calls remote work **pull requests** (PR), not merge requests. Gitea repos are flat `owner/repo` — there are no multi-segment namespaces.
- The module mirrors `packages/web/server/lib/gitlab/` (PAT auth + raw-fetch client) but uses a **Personal Access Token** against the `Authorization: token <pat>` header and a **user-supplied base URL** (Gitea is self-hosted; there is no default instance).

## Entrypoints and structure

- `packages/web/server/lib/gitea/index.js`: public server entrypoint re-exports.
- `packages/web/server/lib/gitea/routes.js`: Express route registration for `/api/gitea/*` endpoints.
- `packages/web/server/lib/gitea/auth.js`: PAT auth storage, multi-account support, base URL normalization.
- `packages/web/server/lib/gitea/client.js`: raw `fetch` Gitea REST v1 client (timeout, ETag conditional GET, rate-limit cooldown, `Link`-header pagination, redirect handling).
- `packages/web/server/lib/gitea/repo.js`: Gitea remote URL parsing (flat `owner/repo`) and directory-to-repo resolution.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: API route layer that calls this module (via `registerGiteaRoutes`).
- `packages/web/src/api/gitea.ts`: web client wrapper for Gitea endpoints.
- `packages/ui/src/lib/api/types.ts`: shared response types consumed by web, desktop, VS Code, and mobile.

## Public exports

### Auth (`auth.js`)

- `getGiteaAuth()`: current auth entry.
- `getGiteaAuthAccounts()`: all configured accounts (`{ id, user, baseUrl, current }`).
- `setGiteaAuth({ accessToken, baseUrl, user })`: save or update an account (validating `user` comes from `GET /user`). `baseUrl` is required — throws when missing/invalid.
- `activateGiteaAuth(accountId)`: switch active account.
- `clearGiteaAuth()`: remove the current account.
- `normalizeBaseUrl(raw)`: add `https://` when a scheme is missing, strip trailing slash, return `null` for invalid input.
- `GITEA_AUTH_FILE`: auth file path.
- There is **no default base URL**: Gitea/Forgejo is self-hosted, so the instance URL is always user-provided.

### Client (`client.js`)

- `createGiteaClient({ token, baseUrl })`: raw-fetch REST v1 client with `request(path, { method, query, body, signal, raw })` plus convenience methods `user()`, `repo(owner, repo)`, `issues(owner, repo, params)`, `issue(owner, repo, number)`, `issueComments(owner, repo, number, params)`, `createIssueComment(owner, repo, number, body)`, `updateIssue(owner, repo, number, params)` (PATCH), `milestones(owner, repo, params)`, `repoLabels(owner, repo, params)`, `pullRequests(owner, repo, params)`, `pullRequest(owner, repo, number)`, `pullRequestDiff(owner, repo, number)` (raw `.diff` text via the `raw` option), `pullRequestFiles(owner, repo, number, params)`, `pullRequestCommits(owner, repo, number, params)`, `pullRequestReviews(owner, repo, number, params)`, `createPullReview(owner, repo, number, params)` (POST), `commitStatuses(owner, repo, sha, params)`, `createPullRequest(owner, repo, body)`, `updatePullRequest(owner, repo, number, body)` (PATCH), `mergePullRequest(owner, repo, number, body)` (POST), `branches(owner, repo, params)`.
- `getGiteaClientOrNull()`: client for the current account, or `null`.
- `isGiteaRateLimited()` / `noteGiteaRateLimit(error)`: own module-level rate-limit cooldown (not shared with the GitHub/GitLab modules).

### Repo (`repo.js`)

- `parseGiteaRemoteUrl(raw, knownHosts?)`: parse SSH/HTTPS remote URL into `{ owner, repo, host, baseUrl, url }` (exactly two path segments; never matches `github.com` or `gitlab.com`).
- `resolveGiteaRepoFromDirectory(directory, remoteName?)`: resolve a Gitea repo from a local git remote.

## Auth storage and config

- Auth storage: `~/.config/openchamber/gitea-auth.json` (override with `OPENCHAMBER_DATA_DIR`).
- Writes are atomic (tmp file + rename) and file mode is `0o600`.
- Base URL resolution: the caller-supplied `baseUrl` (normalized) is the only source — there is no default instance. Stored entries without a usable base URL are dropped.
- Account id: `` `${host}:${username}` `` (e.g. `gitea.example.com:alice`), falling back to `token:<first8>` when the username is missing.
- Auth header on every request: `Authorization: token <pat>`.
- Gitea's `GET /user` uses `login`/`full_name`/`html_url`; `setGiteaAuth` accepts both that and the `username`/`web_url` variants.

## Client behavior

- Base URL joining: `{baseUrl}/api/v1{path}`. Gitea repos are flat `owner/repo`, so owner/repo segments are interpolated directly (single path segments, no encoding needed).
- Per-request timeout: 8000 ms via `AbortSignal.timeout`, unless the caller passes its own signal.
- ETag conditional-GET cache: keyed `token\nurl`, max 300 LRU entries; a `304` is replayed from cache as a `200`. GET only.
- Pagination: Gitea list endpoints return a `Link` header (`rel="next"`) plus `X-Total-Count`; both are parsed into the returned `page` object (`hasMore` = a next page exists). List requests use `page` + `limit` query params (Gitea caps `limit` at 50).
- Redirects: `301`/`302`/`308` with a `Location` header are followed exactly once with `redirect: 'manual'`, preserving the `Authorization` header across the hop.
- Rate limits: a `429` records a module-level cooldown (honoring `Retry-After` seconds / `X-RateLimit-Reset` Unix seconds when present) and surfaces `{ status: 429, error: 'Gitea rate limited' }`. While the cooldown is active, requests short-circuit without hitting the network.
- `request` never throws for HTTP error statuses — callers branch on `status`. The `raw: true` option returns the response body as text (used for the `.diff` endpoint).

## API integration overview

- Issues/PRs are repo-scoped by **number** (GitHub-style, not per-namespace iid).
- User: `GET /user` -> `{ id, login, full_name, avatar_url, html_url, email, ... }`.
- Issue list: `GET /repos/{owner}/{repo}/issues?type=issues&state=open&limit=50&page=N&q=<query>` (`type=issues` excludes pull requests; entries carrying a `pull_request` field are skipped client-side as a backstop).
- Issue detail: `GET /repos/{owner}/{repo}/issues/{number}`.
- Issue/PR comments: `GET /repos/{owner}/{repo}/issues/{number}/comments`.
- PR list: `GET /repos/{owner}/{repo}/pulls?state=open&limit=50&page=N&q=<query>`. Gitea has no server-side source-branch filter, so when `sourceBranch` is requested the route scans `state=all` pages (cap 10 pages) and filters by `head.ref === sourceBranch` client-side, returning all matching states (open and merged).
- PR detail: `GET /repos/{owner}/{repo}/pulls/{number}`.
- PR files: `GET /repos/{owner}/{repo}/pulls/{number}/files?patch=true` (capitalized JSON fields `Filename`/`Status`/`Additions`/`Deletions`/`Patch`; a `404` on older Gitea instances falls back to `files: []`).
- PR diff: `GET /repos/{owner}/{repo}/pulls/{number}.diff` (raw text; falls back to concatenated per-file patches when it fails).
- PR commits: `GET /repos/{owner}/{repo}/pulls/{number}/commits?limit=100` (mapped to `{ sha, message, summary, author, committedAt, parents }`).
- PR reviews: `GET /repos/{owner}/{repo}/pulls/{number}/reviews?limit=100` (mapped to `{ id, state, author, submittedAt, body, commitSha }`; `state` passes through, e.g. `APPROVED`/`REQUEST_CHANGES`).
- Commit statuses: `GET /repos/{owner}/{repo}/commits/{sha}/statuses?limit=100` (the `prs/statuses` route resolves the PR `head.sha` first, then maps statuses to `{ state, name, description, url, createdAt }` with `state` lowercased).
- PR create: `POST /repos/{owner}/{repo}/pulls` with `{ title, head, base, body? }` (body omitted when absent).
- PR update: `PATCH /repos/{owner}/{repo}/pulls/{number}` with `{ title?, body?, state? }` (undefined fields omitted; the PR number IS the issue index, so the edit-issue `state` transition applies directly).
- PR merge: `POST /repos/{owner}/{repo}/pulls/{number}/merge` with `{ Do: true, MergeMethod: 'merge' | 'squash' | 'rebase' }` (`method` defaults to `'merge'`).
- Issue comment write: `POST /repos/{owner}/{repo}/issues/{number}/comments` with `{ body }` (PRs are issues at the API level, so `prs/comment` uses the same endpoint with the PR number as the index).
- Issue update: `PATCH /repos/{owner}/{repo}/issues/{number}` with `{ title?, body?, state?, labels?, assignees?, milestone?, unset_milestone? }` (labels are label **names**, assignees are logins; `milestone` is resolved from a title to a milestone id and `null` sets `unset_milestone: true`).
- Pull review write: `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with `{ event, body? }` (`event` is `APPROVED`/`REQUEST_CHANGES`/`COMMENT`).
- Milestones: `GET /repos/{owner}/{repo}/milestones?state=all&limit=50` (first page) for title-to-id resolution on issue updates.
- Repo labels: `GET /repos/{owner}/{repo}/labels?limit=100` (first page) so metadata editors can offer existing labels.
- Branches: `GET /repos/{owner}/{repo}/branches?limit=50&page=N` mapped to names, plus `GET /repos/{owner}/{repo}` for `default_branch` (Gitea branch objects carry no default flag).
- There is **no ready-for-review endpoint** in this module (Gitea has no GitLab-style ready_for_review action).

## Route contract (`/api/gitea/*`)

| Method | Path | Shape |
|---|---|---|
| GET | `/api/gitea/auth/status` | `{ connected, user?, accounts[] }` |
| POST | `/api/gitea/auth/connect` | body `{ accessToken, baseUrl }` -> `{ connected, user, accounts }`; `400` for missing/invalid token or base URL |
| POST | `/api/gitea/auth/activate` | body `{ accountId }` -> `{ connected, user, accounts }`; `404` unknown account |
| DELETE | `/api/gitea/auth` | `{ removed }` |
| GET | `/api/gitea/me` | `{ username, id, name, avatarUrl, webUrl, email? }`; `401` when not connected |
| GET | `/api/gitea/issues/list` | `?directory&page&query` -> `{ connected, repo?, issues[], page, hasMore }` |
| GET | `/api/gitea/issues/get` | `?directory&number&owner&repo` -> `{ connected, repo?, issue }` |
| GET | `/api/gitea/issues/comments` | `?directory&number&owner&repo` -> `{ connected, repo?, comments[] }` |
| GET | `/api/gitea/prs/list` | `?directory&page&query&sourceBranch` -> `{ connected, repo?, prs[], page, hasMore }` |
| GET | `/api/gitea/pr/context` | `?directory&number&includeDiff&owner&repo` -> `{ connected, repo?, pr, comments[], files[], diff? }` |
| GET | `/api/gitea/prs/commits` | `?directory&number&owner&repo` -> `{ connected, repo?, commits[] }` |
| GET | `/api/gitea/prs/reviews` | `?directory&number&owner&repo` -> `{ connected, repo?, reviews[] }` |
| GET | `/api/gitea/prs/statuses` | `?directory&number&owner&repo` -> `{ connected, repo?, statuses[] }` (resolves the PR `head.sha` first, then lists commit statuses for that SHA) |
| POST | `/api/gitea/pr/create` | body `{ directory, title, sourceBranch, targetBranch, description? }` -> `{ connected, repo?, pr }`; `400` for missing fields or an unresolvable repo |
| PATCH | `/api/gitea/pr/update` | body `{ directory, number, title?, description?, state? }` -> `{ connected, repo?, pr }`; `404` when the PR does not exist |
| POST | `/api/gitea/pr/merge` | body `{ directory, number, method? }` -> `{ connected, merged: true }` on success; non-mergeable PRs -> the Gitea status (`405`/`409`/`422`) with `{ connected, merged: false, message }` |
| POST | `/api/gitea/issues/comment` | body `{ directory, number, body, owner?, repo? }` -> `{ connected, repo?, comment }` |
| POST | `/api/gitea/issues/create` | body `{ directory, title, body?, labels?, owner?, repo? }` -> `{ connected, repo?, issue }` |
| PATCH | `/api/gitea/issues/update` | body `{ directory, number, title?, body?, state?, labels?, assignees?, milestone?, owner?, repo? }` -> `{ connected, repo?, issue }`; `400 'Milestone not found'` when a milestone title does not match |
| POST | `/api/gitea/prs/comment` | body `{ directory, number, body, owner?, repo? }` -> `{ connected, repo?, comment }` (PRs are issues at the API level, so the PR number is the issue index) |
| POST | `/api/gitea/prs/review` | body `{ directory, number, event, body?, owner?, repo? }` -> `{ connected, repo?, review }`; `400` when `event` is not `APPROVED`/`REQUEST_CHANGES`/`COMMENT` |
| GET | `/api/gitea/repo/labels` | `?directory&owner&repo` -> `{ connected, repo?, labels[] }` |
| GET | `/api/gitea/repo/branches` | `?owner&repo` -> `{ branches[], defaultBranch? }` (`defaultBranch` is `null` when Gitea is disconnected or the repo has no default) |

Conventions mirror `github/routes.js` and `gitlab/routes.js`:

- Not authenticated -> `connected: false` (or `401` for `/me`).
- Missing/invalid params -> `400` with `{ error }`.
- Hard failures -> `4xx`/`5xx` with `{ error }`.
- A Gitea `429` -> `503 { error: 'Gitea rate limited' }`.
- Lazy-import pattern: route handlers import `./index.js` on first use, so the module never loads unless Gitea endpoints are hit.
- Composite routes run under a 15 s route-level budget on top of the client's 8 s per-request timeout. Write routes deliberately skip the route-level timeout (a timeout can orphan a write); the client's per-request timeout still bounds them.
- Repo targeting: `owner`/`repo` query params override the directory-local git remote; write routes also accept them in the JSON body.

## Consumers

- `packages/web/src/api/gitea.ts` calls every `/api/gitea/*` endpoint and maps them to the shared types.
- `packages/ui/src/lib/api/types.ts` defines the shared `Gitea*` response types used across web, desktop, VS Code, and mobile.

## Failure handling

- If Gitea is disconnected, read routes return `connected: false`.
- A repo that does not resolve from the local git remote yields `repo: null` with empty lists, matching GitHub/GitLab behavior. Write routes reject an unresolvable repo with `400 { error: 'Unable to resolve Gitea repo from directory' }`.
- Invalid/expired tokens are cleared on `401`/`403` and reported as disconnected.
- Gitea `403` on write routes means the token lacks repository write scope; they respond `400 { error: 'Your Gitea token needs write:repository scope to ...' }`.
- Milestone titles on issue updates are resolved against `GET /repos/{owner}/{repo}/milestones`; an unmatched title yields `400 { error: 'Milestone not found' }` and `null` sets `unset_milestone: true`.
- PR merge rejections (`405`/`409`/`422` from Gitea) are surfaced as `{ connected, merged: false, message }` with the Gitea status so clients can show the message without treating it as a transport error (mirrors `github/pr/merge`).
- The pull-files endpoint returning `404` (older Gitea) yields `files: []` instead of failing the whole PR context; a missing `.diff` falls back to concatenated patches.
- Rate-limit and timeout failures surface explicit `503` responses so clients keep last-known state rather than clearing UI.

## Notes for contributors

- Keep the response shapes in lockstep with `Gitea*` types in `packages/ui/src/lib/api/types.ts`.
- Never log tokens. Error messages must not include the access token.
- The ETag cache and rate-limit cooldown are module-level and per-instance — they are NOT shared with the GitHub or GitLab modules.
- Gitea `GET /user` returns `login`/`full_name`/`html_url`; the route mappers accept the GitHub-style `username`/`name`/`web_url` variants too, so Forgejo versions that differ still map.
- To add further Gitea write operations, add the endpoint in `routes.js`, add a convenience method in `client.js`, and extend the shared types — mirror the existing issue/PR write routes and the GitHub PR write routes.
