# Gitea module

## Ownership

This module is Gitea as a source-control provider: instance validation, personal access token sign-in, remote resolution, REST v1 reads and writes, and their mapping to the neutral source-control DTOs. It runs behind the shared route shell (`source-control/provider-routes.js`), which owns HTTP, read-context validation, the status cache and the durable mutation executor. The descriptor is registered in `source-control/provider-descriptors.js` (after GitLab) and the implementation in the loader map of `source-control/provider-registry.js`. No UI code names Gitea: the client draws what the published descriptor says, including the icon path.

Target: Gitea 1.21 or newer. Forgejo answers `/version` with the Gitea version it is compatible with (`9.0.3+gitea-1.22.0`), and that version is the one checked; Forgejo is expected to work through the same API but has not been tried against a live instance.

## Invariants

- An instance is a normalized origin: HTTPS, or HTTP on a loopback host. Credentials, paths, queries and fragments are refused, so a sub-path install (`ROOT_URL=https://host/gitea/`) cannot be added: repositories are matched as `<origin>/<owner>/<name>`, and a path prefix would read as an owner. There is no default instance; every instance comes from an account in `section('gitea')` of `source-control-auth.json`.
- Sign-in is a personal access token only. `/auth/token` verifies it with `GET /user`, checks `GET /version` (no token sent) and refuses an instance older than 1.21 with `400 UNSUPPORTED_PROVIDER_VERSION` before anything is stored. Device flow and CLI report `{ available: false, reason: 'unsupported' }`; their routes answer 501 from the shell. A version string that names no version is let through.
- A token goes only to `<origin>/api/v1/...`, as `Authorization: token <pat>`. Every request URL is built from the origin and checked against it before it is sent. Requests use `redirect: 'manual'` and any 3xx answer is an error, so a redirect cannot carry the header to another address.
- Reads (`GET`) retry after 429 and 502, up to three attempts. Writes are sent once: a write answered by a 502 may already be applied, and the durable executor reconciles it.
- A token Gitea refuses with 401 cannot be renewed: the provider reports `invalidated` (bindings move first), then marks the stored account invalid. A 403 or a network failure leaves the account valid.
- The session the shell holds is a frozen object without the token; `provider.js` keeps the token in a module `WeakMap` keyed by that session, so logging or serializing a session never carries it.
- A remote belongs to a known instance by host and, for an HTTP(S) remote, port (`auth.ownsHost`), so two instances on one host with different ports stay apart.
- Git transport uses the stored token as the password and the account's login as the username (`transport.httpsUsername: { kind: 'login' }`), on any known instance.
- Remote parsing is bound to a known instance. HTTPS remotes must match its exact authority, HTTP only for a loopback HTTP instance, SSH remotes its hostname. An instance whose SSH host differs from its web host (`SSH_DOMAIN`) is not recognized over SSH. Repository paths are exactly `owner/name`.
- Bound reads resolve only the binding's primary remote, then that repository's fork parent. A selector naming anything else is a 404. A pull request read for a patch, a file or a mutation must have its base in that network and its head from a repository in it.
- Project ids are the numeric repository id as a string; change request and issue ids are `<repository id>#<number>`. Payloads are mapped to the DTOs GitLab's module emits. A repository whose web or clone URL is not on the instance, or names another repository, is refused as malformed.
- Status by branch: for each repository of the network (the primary first, then its parent) the direct lookup `GET /repos/{o}/{r}/pulls/{default branch}/{head}` runs first (`owner:branch` for a fork's branch, skipped when either branch name has a slash), then a scan of open pull requests (`state=open`, 50 per page, at most 5 pages) matching `head.ref`, the head repository id and the base repository id. A scan that reaches its bound without an answer fails the read; it never reports "no pull request". A closed or merged pull request found by the direct lookup from the primary repository is the history answer when nothing is open.
- CI is the head commit's combined status (`/commits/{sha}/status`); Gitea Actions report there too. `warning` and `skipped` count as success, `error` and `failure` as failure. A failed CI read leaves `ci: null` except a 401, which fails the read.
- Whole collections (comments, reviews, changed files, branches, labels, collaborators) are read page by page up to 2000 items; past that the read fails instead of answering a part.
- Drafts are the title prefix Gitea recognizes by default (`WIP:`, `[WIP]`, case-insensitive) or the pull request's `draft` flag. Create as draft writes `WIP: `; ready strips the prefix. An instance with custom `WORK_IN_PROGRESS_PREFIXES` is read by the `draft` flag, but ready only strips the default prefixes.
- Mutation kinds are GitLab's names (`change-request-create`, `change-request-merge`, `issue-labels`, ...) and the digest is `digestMutationInput({ kind, actor, credential, target, ...fields })` as GitLab computes it. Both are persisted in `source-control-mutations.json`; changing either turns a stored record's replay into a conflict.
- Merge sends `{ Do: merge|squash|rebase, head_commit_id }`. On a 409 the pull request is read again: a head that moved is `SOURCE_CONTROL_MUTATION_TARGET_MISMATCH`; any other 409 is a definite failure. A review is checked against the current head first and pinned with `commit_id`.
- Labels are set as a whole set by name; names are turned into the repository's label ids (`PUT /issues/{n}/labels`). A name the repository does not have is a 422. Organization labels are not looked up.
- Reviewers are set as a whole set by numeric user id, like GitLab's. Ids are turned into usernames through the collaborators and the current review requests, then the difference is sent as `POST` (add) and `DELETE` (remove) on `requested_reviewers`. The two calls are not atomic; reconciliation succeeds only when the current set matches.
- Capabilities off: review threads (no reply or resolve API), uploads (attachments are served to a browser session), stacks, the reference picker.

## Enterprise mode

Gitea is a new destination for a token and for what the user writes into a pull request, issue or comment, all at an origin the user entered. GitLab instances are not gated by enterprise mode, and Gitea follows the same rule: a user-initiated action toward a service the user connected is outside the mode today (`enterprise-boundary` skill). Whether enterprise mode should gate self-hosted source-control providers, or pin allowed instances, is an open product question for the maintainer, and it applies to GitLab equally.

## Endpoint assumptions to check against a live instance

The fixtures in `fixtures/api.json` are written by hand from the published swagger (`gitea.com/swagger.v1.json` as gitea.com served it on 2026-10-22), not recorded from a server. These are the assumptions the code makes:

- `GET /version` answers `{ version }` without a token.
- `GET /user` answers `{ id, login, full_name, email, avatar_url }`.
- `GET /repos/{o}/{r}` and `GET /repositories/{id}` answer a repository with `owner.login`, `html_url`, `clone_url`, `ssh_url`, `default_branch` and an embedded `parent` with its `id`.
- `GET /repos/{o}/{r}/pulls/{base}/{head}` exists on 1.21 and takes `owner:branch` for a fork's branch (needs checking: the minimum version and the fork form). It may answer a closed pull request; the code checks state, head ref and repository ids itself. A 404 falls through to the scan.
- `POST /repos/{o}/{r}/pulls` takes `head: 'owner:branch'` for a branch in a fork, as the swagger describes. The answer carries `head.repo_id` and `base.repo_id`.
- `POST /repos/{o}/{r}/pulls/{n}/merge` answers 409 when `head_commit_id` is not the current head (the swagger lists 409 without saying when). Gitea may also answer 409 for other conflicts; the code re-reads the head to tell them apart. 405 means not mergeable.
- `PATCH /repos/{o}/{r}/issues/{n}` with `{ state }` closes and reopens pull requests too.
- `PUT /repos/{o}/{r}/issues/{n}/labels` takes label ids (newer versions also take names).
- `POST /repos/{o}/{r}/pulls/{n}/reviews` takes `event: APPROVED | REQUEST_CHANGES` with `body` and `commit_id`. Gitea refuses a review of your own pull request, and may refuse REQUEST_CHANGES with an empty body.
- `POST` / `DELETE /repos/{o}/{r}/pulls/{n}/requested_reviewers` take `{ reviewers: [username] }`.
- `GET /repos/{o}/{r}/commits/{sha}/status` answers `{ state, statuses: [{ id, context, status, target_url, description, created_at, updated_at }], total_count }`.
- `GET /repos/{o}/{r}/pulls/{n}.diff` answers the whole unified diff as text; `/pulls/{n}/files` answers `filename`, `status` (`added`, `deleted`, `renamed`, `changed`), line counts.
- `GET /repos/{o}/{r}/pulls/{n}/commits` pages with `x-total-count`; the order is not relied on (the first and last pages are read and sorted by committer date).
- `GET /repos/{o}/{r}/raw/{path}?ref=<sha>` reads a file at a commit, and a fork pull request's head commit is readable from the base repository (Gitea keeps it under `refs/pull/{n}/head`).
- `GET /repos/{o}/{r}/issues` takes `type=issues|pulls`, `state`, `q`, `created_by`, `assigned_by`; `GET /repos/issues/search` takes `review_requested=true` and `owner`, and its items carry `repository.id`.
- Pages are at most 50 items (`[api] MAX_RESPONSE_ITEMS` default) with a `Link` header; `x-total-count` is the fallback.

## Decisions

### Why a fetch client and not a Gitea SDK

The calls are plain REST, the module needs exact control over redirects, retries and where the token goes, and no dependency may be added. A small client keeps those rules in one place where a test can see every request.

### Why reviewers are numeric ids and not usernames

GitLab's reviewer contract is numeric ids, and the board compares the ids of current reviewers with the ids of candidates. Gitea's API takes usernames, so the provider maps ids to usernames at the moment it writes. Keeping usernames on the wire would make Gitea's reviewers the one set the board could not match.

### Why the status scan fails past its bound

A branch whose pull request lies past the scanned pages would otherwise read as "no pull request" and the client would offer to create a second one. Failing keeps the last-known answer in the shell's status cache and tells the user the read did not finish.
