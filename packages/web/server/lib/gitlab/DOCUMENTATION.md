# GitLab Module Documentation

## Purpose

- This module owns GitLab auth (Personal Access Token), raw REST v4 client access, remote-URL repo resolution, and GitLab issue / merge-request (MR) APIs for OpenChamber, including MR create/update/merge writes.
- From a user perspective, this is the layer that lets the app show GitLab issues and merge requests for a local project, including comments and per-file diffs, and create, edit, and merge merge requests.
- The module mirrors `packages/web/server/lib/github/` but uses a **Personal Access Token (PAT)** with a configurable base URL (gitlab.com by default, or a self-hosted instance), and talks to GitLab's REST v4 API directly via `fetch` — no new dependencies.

## Entrypoints and structure

- `packages/web/server/lib/gitlab/index.js`: public server entrypoint re-exports.
- `packages/web/server/lib/gitlab/routes.js`: Express route registration for `/api/gitlab/*` endpoints.
- `packages/web/server/lib/gitlab/auth.js`: PAT auth storage, multi-account support, base URL normalization.
- `packages/web/server/lib/gitlab/client.js`: raw `fetch` GitLab REST v4 client (timeout, ETag conditional GET, rate-limit cooldown, pagination, redirect handling).
- `packages/web/server/lib/gitlab/repo.js`: GitLab remote URL parsing and directory-to-repo resolution.
- `packages/web/server/lib/opencode/feature-routes-runtime.js`: API route layer that calls this module (via `registerGitLabRoutes`).
- `packages/web/src/api/gitlab.ts`: web client wrapper for GitLab endpoints.
- `packages/ui/src/lib/api/types.ts`: shared response types consumed by web, desktop, VS Code, and mobile.

## Public exports

### Auth (`auth.js`)

- `getGitLabAuth()`: current auth entry.
- `getGitLabAuthAccounts()`: all configured accounts (`{ id, user, baseUrl, current }`).
- `setGitLabAuth({ accessToken, baseUrl, user })`: save or update an account (validating `user` comes from `GET /user`).
- `activateGitLabAuth(accountId)`: switch active account.
- `clearGitLabAuth()`: remove the current account.
- `normalizeBaseUrl(raw)`: add `https://` when a scheme is missing, strip trailing slash, return `null` for invalid input.
- `GITLAB_AUTH_FILE`: auth file path.
- `DEFAULT_GITLAB_BASE_URL`: `https://gitlab.com` (compatibility constant).
- `getGitLabDefaultBaseUrl()`: effective default base URL — configured `gitProviders.gitlab.apiBaseUrl` from `settings.json` if present, else `https://gitlab.com`. Used for stored-account fallback and the auth status/connect `defaultBaseUrl` fields.

### Client (`client.js`)

- `createGitLabClient({ token, baseUrl })`: raw-fetch REST v4 client with `request(path, { method, query, body })` plus convenience methods `user()`, `project(path)`, `issues(path, params)`, `issue(path, iid)`, `issueNotes(path, iid, params)`, `createIssueNote(path, iid, body)`, `updateIssue(path, iid, params)`, `mergeRequests(path, params)`, `mergeRequest(path, iid)`, `mergeRequestDiffs(path, iid, params)`, `createMergeRequest(path, body)`, `updateMergeRequest(path, iid, body)`, `mergeMergeRequest(path, iid, body)`, `createMrNote(path, iid, body)`, `approveMr(path, iid)`, `milestones(path, params)`, `branches(path, params)`.
- `getGitLabClientOrNull()`: client for the current account, or `null`.
- `isGitLabRateLimited()` / `noteGitLabRateLimit(error)`: own module-level rate-limit cooldown (not shared with the GitHub module's `rate-limit.js`).

### Repo (`repo.js`)

- `parseGitLabRemoteUrl(raw, knownHosts?)`: parse SSH/HTTPS remote URL into `{ namespace, project, host, baseUrl, url }` (multi-segment namespaces supported; never matches `github.com`).
- `resolveGitLabRepoFromDirectory(directory, remoteName?)`: resolve a GitLab repo from a local git remote.

## Auth storage and config

- Auth storage: `~/.config/openchamber/gitlab-auth.json` (override with `OPENCHAMBER_DATA_DIR`).
- Writes are atomic (tmp file + rename) and file mode is `0o600`.
- Base URL resolution: caller-supplied `baseUrl` (normalized) -> effective default via `getGitLabDefaultBaseUrl()` (configured `settings.json` `gitProviders.gitlab.apiBaseUrl`, else `https://gitlab.com`).
- Per-project overrides: data routes resolve a directory-scoped API base via `getEffectiveProviderApiBaseUrl('gitlab', directory)` (in `packages/web/server/lib/git-providers/project-config.js`). A per-project `gitProviders.gitlab.apiBaseUrl` override (stored under `projects/<projectId>.json`) replaces the global default for that project's routes, and its host is accepted for directory-to-repo resolution (`resolveGitLabRepoFromDirectory`); a connected account whose host matches the remote keeps its own base URL. A forced `gitProviders.provider: 'gitlab'` accepts any remote host for directory resolution. Global routes (`auth/connect`, `auth/status`, `auth/activate`, `me`, `repo/branches`) stay global.
- Account id: `` `${host}:${username}` `` (e.g. `gitlab.com:alice`), falling back to `token:<first8>` when the username is missing.
- Auth header on every request: `PRIVATE-TOKEN: <pat>`.

## OAuth readiness

The stored entry shape (`accessToken`, `baseUrl`, `username`, `name`, `avatarUrl`, `webUrl`, `email`, `createdAt`, `current`) is intentionally generic. OAuth flows would slot in at two points:

1. `routes.js` — add `POST /api/gitlab/auth/start` / `auth/complete` endpoints next to the existing `auth/connect` (mirroring the GitHub device-flow routes), exchanging the OAuth grant for an access token.
2. `setGitLabAuth` — persists whatever `accessToken` + `user` shape the OAuth callback produces; no storage changes needed.

Nothing in the client or repo layers assumes the token came from a PAT.

## Client behavior

- Base URL joining: `{baseUrl}/api/v4{path}`. Project `:id` segments are URL-encoded with `encodeURIComponent` (e.g. `group/sub` -> `group%2Fsub`) and never double-encoded.
- Per-request timeout: 8000 ms via `AbortSignal.timeout`, unless the caller passes its own signal.
- ETag conditional-GET cache: keyed `token\nurl`, max 300 LRU entries; a `304` is replayed from cache as a `200`. GET only.
- Pagination: `x-page`, `x-next-page`, `x-total-pages`, and the `Link` header (`rel="next"`) are parsed into the returned `page` object (`hasMore` = a next page exists).
- Redirects: `301`/`302`/`308` with a `Location` header are followed exactly once (project moves) with `redirect: 'manual'`, preserving `PRIVATE-TOKEN` across the hop.
- Rate limits: a `429` records a module-level cooldown (honoring `Retry-After` / `RateLimit-Reset` when present) and surfaces `{ status: 429, error: 'GitLab rate limited' }`. While the cooldown is active, requests short-circuit without hitting the network.
- `request` never throws for HTTP error statuses — callers branch on `status`.

## API integration overview

- Issues/MRs are addressed project-scoped by **iid**.
- Issue list: `GET /projects/:id/issues?state=opened&scope=all&per_page=50&page=N&search=<query>`.
- Issue detail: `GET /projects/:id/issues/:issue_iid`.
- Issue notes: `GET /projects/:id/issues/:issue_iid/notes?per_page=100` (system notes are skipped; each note links as `{issue_web_url}#note_{id}`).
- MR list: `GET /projects/:id/merge_requests?state=opened&scope=all&per_page=50&page=N&search=<query>&source_branch=<branch>` (the route passes `sourceBranch` through to `source_branch` when present, matching local-branch MR-status UIs).
- MR detail: `GET /projects/:id/merge_requests/:merge_request_iid`.
- MR diffs: `GET /projects/:id/merge_requests/:merge_request_iid/diffs?per_page=100&page=N` (paginated; the route caps at 10 pages / 3000 files).
- MR commits: `GET /projects/:id/merge_requests/:merge_request_iid/commits?per_page=100` (mapped to `{ sha, shortSha, message, summary, authorName, committedAt, parents }`).
- MR notes: `GET /projects/:id/merge_requests/:merge_request_iid/notes?per_page=100`; the timeline route keeps `system: true` notes only and infers the event `type` from the note body text (best-effort heuristic, falls back to `'other'`).
- MR notes: `GET /projects/:id/merge_requests/:merge_request_iid/notes?per_page=100`.
- MR create: `POST /projects/:id/merge_requests` with `{ source_branch, target_branch, title, description?, remove_source_branch }` (description omitted when absent; `remove_source_branch` defaults to `false`).
- MR update: `PUT /projects/:id/merge_requests/:merge_request_iid` with `{ title?, description?, state_event?, labels?, assignee_ids?, milestone_id? }` (undefined fields omitted; `state_event` is derived from `state`, milestone titles are resolved to ids).
- MR merge: `PUT /projects/:id/merge_requests/:merge_request_iid/merge` with `{ squash? }`.
- Issue comment write: `POST /projects/:id/issues/:issue_iid/notes` with `{ body }` (the route resolves the issue `web_url` first so the note links as `{issue_web_url}#note_{id}`).
- Issue update: `PUT /projects/:id/issues/:issue_iid` with `{ title?, description?, state_event?, labels?, assignee_ids?, milestone_id? }` (`state: 'open'|'closed'` maps to `state_event: 'reopen'|'close'`; labels/assignees are full-set replaces per GitLab semantics; `milestone` titles are resolved to ids and `null` clears).
- MR comment write: `POST /projects/:id/merge_requests/:merge_request_iid/notes` with `{ body }`.
- MR approve: `POST /projects/:id/merge_requests/:merge_request_iid/approve` (approve-only; GitLab has no request-changes event via this API — the facade capability reflects that).
- Milestones: `GET /projects/:id/milestones?state=all&per_page=100` (first page) for title-to-id resolution on issue/MR updates.
- Branches: `GET /projects/:id/repository/branches?per_page=100&page=N`.
- User: `GET /user` -> `{ id, username, name, state, avatar_url, web_url, email, ... }`.

## Route contract (`/api/gitlab/*`)

| Method | Path | Shape |
|---|---|---|
| GET | `/api/gitlab/auth/status` | `{ connected, user?, accounts[], defaultBaseUrl }` |
| POST | `/api/gitlab/auth/connect` | body `{ accessToken, baseUrl? }` -> `{ connected, user, accounts, defaultBaseUrl }`; `400` for missing/invalid token |
| POST | `/api/gitlab/auth/activate` | body `{ accountId }` -> `{ connected, user, accounts, defaultBaseUrl }`; `404` unknown account |
| DELETE | `/api/gitlab/auth` | `{ removed }` |
| GET | `/api/gitlab/me` | `{ username, id, name, avatarUrl, webUrl, email? }`; `401` when not connected |
| GET | `/api/gitlab/issues/list` | `?directory&page&query` -> `{ connected, repo?, issues[], page, hasMore }` |
| GET | `/api/gitlab/issues/get` | `?directory&number&namespace&project` -> `{ connected, repo?, issue }` |
| GET | `/api/gitlab/issues/comments` | `?directory&number&namespace&project` -> `{ connected, repo?, comments[] }` |
| GET | `/api/gitlab/mrs/list` | `?directory&page&query&sourceBranch` -> `{ connected, repo?, mrs[], page, hasMore }` |
| GET | `/api/gitlab/mrs/context` | `?directory&number&diff&namespace&project` -> `{ connected, repo?, mr, comments[], files[], diff? }` |
| GET | `/api/gitlab/mrs/commits` | `?directory&number&namespace&project` -> `{ connected, repo?, commits[] }` |
| GET | `/api/gitlab/mrs/timeline` | `?directory&number&namespace&project` -> `{ connected, repo?, events[] }` (system notes only; event `type` inferred from note body text — best-effort heuristic) |
| POST | `/api/gitlab/mrs/create` | body `{ directory, title, sourceBranch, targetBranch, description?, removeSourceBranch? }` -> `{ connected, repo?, mr }`; `400` for missing fields, unresolvable repo, or a token without the `api` scope |
| PUT | `/api/gitlab/mrs/update` | body `{ directory, number, title?, description?, state?, labels?, assigneeIds?, milestone? }` -> `{ connected, repo?, mr }`; `404` when the MR does not exist; `400 'Milestone not found'` when a milestone title does not match |
| PUT | `/api/gitlab/mrs/merge` | body `{ directory, number, squash? }` -> `{ connected, merged: true }` on success; non-mergeable MRs -> the GitLab status (`405`/`406`/`409`/`422`) with `{ connected, merged: false, message }` |
| POST | `/api/gitlab/issues/comment` | body `{ directory, number, body, namespace?, project? }` -> `{ connected, repo?, comment }` |
| POST | `/api/gitlab/issues/create` | body `{ directory, title, body?, labels?, namespace?, project? }` -> `{ connected, repo?, issue }` |
| PUT | `/api/gitlab/issues/update` | body `{ directory, number, title?, body?, state?, labels?, assigneeIds?, milestone?, namespace?, project? }` -> `{ connected, repo?, issue }`; `400 'Milestone not found'` when a milestone title does not match |
| POST | `/api/gitlab/mrs/comment` | body `{ directory, number, body, namespace?, project? }` -> `{ connected, repo?, comment }` |
| POST | `/api/gitlab/mrs/approve` | body `{ directory, number, namespace?, project? }` -> `{ connected, repo?, approved: true }` |
| GET | `/api/gitlab/repo/branches` | `?namespace&project` -> `{ branches[], defaultBranch? }` (`defaultBranch` is `null` when the repo has no marked default branch or GitLab is disconnected) |

Conventions mirror `github/routes.js`:

- Not authenticated -> `connected: false` (or `401` for `/me`).
- Missing/invalid params -> `400` with `{ error }`.
- Hard failures -> `4xx`/`5xx` with `{ error }`.
- A GitLab `429` -> `503 { error: 'GitLab rate limited' }`.
- Lazy-import pattern: route handlers import `./index.js` on first use, so the module never loads unless GitLab endpoints are hit.
- Composite routes run under a 15 s route-level budget on top of the client's 8 s per-request timeout. Write routes deliberately skip the route-level timeout (a timeout can orphan a write); the client's per-request timeout still bounds them.

## Consumers

- `packages/web/src/api/gitlab.ts` calls every `/api/gitlab/*` endpoint and maps them to the shared types.
- `packages/ui/src/lib/api/types.ts` defines the shared `GitLab*` response types used across web, desktop, VS Code, and mobile.

## Failure handling

- If GitLab is disconnected, read routes return `connected: false`.
- A repo that does not resolve from the local git remote yields `repo: null` with empty lists, matching the GitHub behavior. Write routes reject an unresolvable repo with `400 { error: 'Unable to resolve GitLab repo from directory' }`.
- Invalid/expired tokens are cleared on `401`/`403` and reported as disconnected.
- GitLab `403` on write routes means the token lacks the `api` scope; they respond `400 { error: 'Your GitLab token needs the api scope to ...' }`.
- Milestone titles on issue/MR updates are resolved against `GET /projects/:id/milestones`; an unmatched title yields `400 { error: 'Milestone not found' }` and `null` clears the milestone (`milestone_id: null`).
- MR merge rejections (`405`/`406`/`409`/`422` from GitLab) are surfaced as `{ connected, merged: false, message }` with the GitLab status so clients can show the message without treating it as a transport error (mirrors `github/pr/merge`).
- Rate-limit and timeout failures surface explicit `503` responses so clients keep last-known state rather than clearing UI.

## Notes for contributors

- Keep the response shapes in lockstep with `GitLab*` types in `packages/ui/src/lib/api/types.ts`.
- Never log tokens. Error messages must not include the access token.
- Do not double-encode project paths; convenience methods already call `encodeURIComponent` on the `pathWithNamespace`.
- The ETag cache and rate-limit cooldown are module-level and per-instance — they are NOT shared with the GitHub module.
- To add further GitLab write operations, add the endpoint in `routes.js`, add a convenience method in `client.js`, and extend the shared types — mirror the existing issue/MR write routes and the GitHub PR write routes.
