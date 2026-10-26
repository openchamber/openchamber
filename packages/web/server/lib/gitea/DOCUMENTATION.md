# Gitea module

## Ownership

This module is Gitea as a source-control provider: instance validation, personal access token sign-in, remote resolution, REST v1 reads and writes, and their mapping to the neutral source-control DTOs. It runs behind the shared route shell (`source-control/provider-routes.js`), which owns HTTP, read-context validation, the status cache and the durable mutation executor. The descriptor is registered in `source-control/provider-descriptors.js` (after GitLab) and the implementation in the loader map of `source-control/provider-registry.js`. No UI code names Gitea: the client draws what the published descriptor says, including the icon path. Forgejo is this module with its own descriptor (`createGiteaFamilyProvider` with `GITEA_EDITIONS.forgejo`, see `../forgejo/DOCUMENTATION.md`): the client, resources, verification and provider take the descriptor's id and label, and nothing here may assume the provider is `gitea`.

Target: Gitea 1.21 or newer, verified against live 1.21.11 and 1.27.3 (see *Verified against live instances*). Forgejo answers `/version` with the Gitea version it is compatible with (`17.0.0+gitea-1.22.0`), and that version is the one checked; Forgejo itself was verified separately (`../forgejo/DOCUMENTATION.md`).

## Invariants

- An instance is a normalized origin: HTTPS, or HTTP on a loopback host. Credentials, paths, queries and fragments are refused, so a sub-path install (`ROOT_URL=https://host/gitea/`) cannot be added: repositories are matched as `<origin>/<owner>/<name>`, and a path prefix would read as an owner. There is no default instance; every instance comes from an account in `section('gitea')` of `source-control-auth.json`.
- Sign-in is a personal access token only. `/auth/token` verifies it with `GET /user`, checks `GET /version` and refuses an instance older than 1.21 with `400 UNSUPPORTED_PROVIDER_VERSION` before anything is stored. An instance belongs to one card of the two editions, the one its `/version` names (a `+gitea-` suffix is Forgejo's): connect on the other card refuses with `409 SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER` and the right provider's id. The capabilities read checks only the version, never the edition. `/version` is read without a token first; an instance that refuses anonymous API reads (`[service] REQUIRE_SIGNIN_VIEW = true` answers 403) is asked again with the token at connect, and the capabilities read, which has no token, lets it through as a version it cannot see, so the token form shows and connect decides. Device flow and CLI report `{ available: false, reason: 'unsupported' }`; their routes answer 501 from the shell. A version string that names no version is let through.
- A token goes only to `<origin>/api/v1/...`, as `Authorization: token <pat>`. Every request URL is built from the origin and checked against it before it is sent. Requests use `redirect: 'manual'` and any 3xx answer is an error, so a redirect cannot carry the header to another address.
- Reads (`GET`) retry after 429 and 502, up to three attempts. Writes are sent once: a write answered by a 502 may already be applied, and the durable executor reconciles it.
- A token Gitea refuses with 401 cannot be renewed: the provider reports `invalidated` (bindings move first), then marks the stored account invalid. A 403 or a network failure leaves the account valid.
- The session the shell holds is a frozen object without the token; `provider.js` keeps the token in a module `WeakMap` keyed by that session, so logging or serializing a session never carries it.
- A remote belongs to a known instance by host and, for an HTTP(S) remote, port (`auth.ownsHost`), so two instances on one host with different ports stay apart.
- Git transport uses the stored token as the password and the account's login as the username (`transport.httpsUsername: { kind: 'login' }`), on any known instance.
- Remote parsing is bound to a known instance. HTTPS remotes must match its exact authority, HTTP only for a loopback HTTP instance, SSH remotes its hostname. An instance whose SSH host differs from its web host (`SSH_DOMAIN`) is not recognized over SSH. Repository paths are exactly `owner/name`.
- Bound reads resolve only the binding's primary remote, then that repository's fork parent. A selector naming anything else is a 404. A pull request must have its base in that network; its head may come from any fork, so a maintainer's upstream clone reads the patch and files of a contributor's pull request, comments on, reviews and merges it (the network rule in `../source-control/DOCUMENTATION.md`). Creating one still requires the head remote's repository to be in the network. The source of a worktree made from a pull request is the head repository's clone URL on the instance's own origin, so a loopback HTTP instance gives an HTTP endpoint, which Git transport also reaches (`../git/loopback-http.js`).
- Project ids are the numeric repository id as a string; change request and issue ids are `<repository id>#<number>`. Payloads are mapped to the DTOs GitLab's module emits. A repository whose web or clone URL is not on the instance, or names another repository, is refused as malformed.
- Status by branch: for each repository of the network (the primary first, then its parent) the direct lookup `GET /repos/{o}/{r}/pulls/{default branch}/{head}` runs first (`owner:branch` for a fork's branch, each branch name percent-encoded so a slash stays in its segment), then a scan of open pull requests (`state=open`, 50 per page, at most 5 pages) matching `head.ref`, the head repository id and the base repository id. A scan that reaches its bound without an answer fails the read; it never reports "no pull request". When nothing is open, the history answer is the highest-numbered closed or merged match among the direct lookup's answer and the first page of closed pull requests (`state=closed`, recently updated first), counted only when its head is the primary repository. The direct lookup is never history on its own: it answers one pull request of the pair, not the newest.
- CI is the head commit's combined status (`/commits/{sha}/status`) on the base repository; Gitea Actions report there too. `success` and `skipped` count as success; `error`, `failure` and `warning` as failure, because Gitea's own combined state never reads success with a warning. A failed CI read leaves `ci: null` except a 401, which fails the read.
- Whole collections (reviews, changed files, branches, labels, collaborators) are read page by page up to 2000 items; past that the read fails instead of answering a part. Issue and pull request comments are one request: Gitea answers them all and ignores `page` and `limit` there.
- The timeline reads the first page of `/pulls/{n}/commits` (Gitea lists them newest first) and reverses it, so it shows the newest 50 oldest first, in Gitea's order even within one second.
- Drafts are the title prefix Gitea recognizes by default (`WIP:`, `[WIP]`, case-insensitive) or the pull request's `draft` flag. Create as draft writes `WIP: `; ready strips the prefix. An instance with custom `WORK_IN_PROGRESS_PREFIXES` is read by the `draft` flag, but ready only strips the default prefixes.
- Mutation kinds are GitLab's names (`change-request-create`, `change-request-merge`, `issue-labels`, ...) and the digest is `digestMutationInput({ kind, actor, credential, target, ...fields })` as GitLab computes it. Both are persisted in `source-control-mutations.json`; changing either turns a stored record's replay into a conflict.
- Merge sends `{ Do: merge|squash|rebase, head_commit_id }`. Gitea answers 409 for a stale `head_commit_id`, but checks mergeability first, so a push that also made the pull request unmergeable answers 405. On a 409 or a 405 the pull request is read again: a head that moved is `SOURCE_CONTROL_MUTATION_TARGET_MISMATCH`; otherwise Gitea's answer stands (405: work in progress, not mergeable, already merged).
- A review is checked against the current head first and pinned with `commit_id`: Gitea itself accepts any `commit_id`, even one outside the pull request. A request for changes needs a body, refused with 400 before anything is sent, because Gitea answers it with 422.
- Labels are set as a whole set by name; names are turned into the repository's label ids (`PUT /issues/{n}/labels`). A name the repository does not have is a 422. Organization labels are not looked up.
- Reviewers are set as a whole set by numeric user id, like GitLab's. Ids are turned into usernames through the collaborators and the current review requests, then the difference is sent as `POST` (add) and `DELETE` (remove) on `requested_reviewers`. The two calls are not atomic; reconciliation succeeds only when the current set matches. Gitea lists in `requested_reviewers` everyone with a standing review, not only open requests, and a `DELETE` for someone who already reviewed answers 204 and changes nothing. So before any write, a removal reads `/pulls/{n}/reviews` and refuses with `400 GITEA_REVIEWER_HAS_REVIEWED`, naming the logins, when someone to remove has a submitted review (`APPROVED`, `REQUEST_CHANGES` or `COMMENT`, not dismissed). 1.21 answers an empty set as `null`, read as empty.
- `head.label` is the bare branch name even for a fork's branch, so `headLabel` is built as `owner:branch` from `head.repo`, the form the worktree flow reads an owner from.
- Capabilities off: review threads (no reply or resolve API), uploads (attachments are served to a browser session), stacks, the reference picker.

## Enterprise mode

Gitea is a new destination for a token and for what the user writes into a pull request, issue or comment, all at an origin the user entered. GitLab instances are not gated by enterprise mode, and Gitea follows the same rule: a user-initiated action toward a service the user connected is outside the mode today (`enterprise-boundary` skill). Whether enterprise mode should gate self-hosted source-control providers, or pin allowed instances, is an open product question for the maintainer, and it applies to GitLab equally.

## Verified against live instances

On 2026-10-22 every endpoint the module calls was exercised against Gitea 1.27.3 and 1.21.11 (official darwin-arm64 binaries, SQLite, two to three users, a fork network), and the whole provider was driven end to end through the shell routes on both. `fixtures/api.json` holds those responses, scrubbed: the origin is rewritten to `https://gitea.example.com`; unsuffixed keys are 1.27.3, `_1_21` keys 1.21.11, and `errors` keeps refusals with their status. With two versions tried, "1.21" below means "true on 1.21.11 and 1.27.3"; behaviour in the releases between them is inferred.

- `GET /version` answers `{ version }` without a token; `GET /user` answers `id`, `login`, `full_name`, `email`, `avatar_url` (both).
- Repositories (`/repos/{o}/{r}`, `/repositories/{id}`) carry `owner.login`, `html_url`, `clone_url`, `ssh_url`, `default_branch`, and a fork embeds `parent` with its `id` (both).
- `GET /pulls/{base}/{head}` exists on 1.27.3 and not on 1.21.11 (plain-text `404 page not found`; the route arrived in 1.22). On 1.27.3 it takes `owner:branch` for a fork, raw or encoded colon, a percent-encoded slash in either branch, and answers closed and merged pull requests too. With several pull requests from one branch it answered the oldest, closed, while a newer one was open.
- `POST /pulls` takes `head: 'owner:branch'` and ignores `draft`; drafts are the `WIP:` / `[WIP]` title prefix, and 1.21 has no `draft` field at all. A work-in-progress pull request reads `mergeable: false` (both).
- Merge: success is 200 with an empty body; a stale `head_commit_id` is 409 `head out of date`; work in progress, not mergeable and already merged are 405, checked before the head (so a stale head can answer 405); an unknown `Do` is 422; merging a closed pull request is 404 (both, except already-merged and closed checked on 1.27.3 only).
- `PATCH /issues/{n}` with `{ state }` closes and reopens pull requests; it and `PATCH /pulls/{n}` answer 201 (both).
- `PUT /issues/{n}/labels` takes ids on both; 1.27.3 also takes names, 1.21.11 refuses them with 422. Unknown ids and names are dropped silently, so the module resolves names itself.
- Reviews: `APPROVED` / `REQUEST_CHANGES` with `body` and `commit_id`; your own pull request is 422 for both events; `REQUEST_CHANGES` without a body is 422; a `commit_id` from elsewhere is accepted and the review marked `stale` (both). A newer review by the same user marks the older one `dismissed` on 1.27.3, not on 1.21.11. `/pulls/{n}/reviews` also lists `REQUEST_REVIEW` entries without a body.
- `POST` / `DELETE /pulls/{n}/requested_reviewers` take `{ reviewers: [username] }` (201 / 204); the pull request's author is refused (422), an unknown user is 404 (both); a `DELETE` for a user who already reviewed answers 204 and leaves them in `requested_reviewers` (both).
- `/commits/{sha}/status` answers `{ state, sha, total_count, statuses }`, the latest status per context; no statuses is `statuses: null`. Combined state with a `warning`: `warning` on 1.21.11, `failure` on 1.27.3; `skipped` counts as success (both). Statuses posted on a fork's repository do not show on the base repository's read of the same commit.
- `.diff` is the unified diff as `text/plain`; `/pulls/{n}/files` answers `added`, `deleted`, `renamed` (with `previous_filename`), `changed` (both).
- `/pulls/{n}/commits` is newest first, paged with `Link` and `x-total-count` (both).
- `/raw/{path}?ref=<sha>` on the base repository reads a fork pull request's head commit and the merge base (both).
- `GET /issues` takes `type`, `state`, `q`, `created_by`, `assigned_by`; `/repos/issues/search` with `review_requested=true&owner=` answers the caller's requests and each item's `repository.id` (both).
- Paging: `limit` is capped at 50 (`MAX_RESPONSE_ITEMS`), 30 without `limit`. Pulls, issues, search, branches, files and commits send `Link`; labels, collaborators and reviews only `x-total-count`; issue comments ignore paging (both).
- Branches pushed over Git show in `/branches` a moment later on 1.21.11 (synced by a queue), immediately on 1.27.3.

Still unverified:

- Gitea 1.22 to 1.26, MySQL or PostgreSQL backends (the direct lookup's "which of several" answer depends on database order), a sub-path install, an instance with a `MAX_RESPONSE_ITEMS` under 50 (pages counted by `x-total-count` would end early), custom `WORK_IN_PROGRESS_PREFIXES`, a merge 409 for a conflict found while merging (Gitea's code returns it for merge and rebase conflicts and a rejected push; it could not be provoked), and Gitea Actions statuses (Actions were off; statuses were posted through the API).
- The review-requested list filters the owner-wide search to the repository after paging, so one of its pages can come back short or empty while more exist.

## Decisions

### Why a fetch client and not a Gitea SDK

The calls are plain REST, the module needs exact control over redirects, retries and where the token goes, and no dependency may be added. A small client keeps those rules in one place where a test can see every request.

### Why reviewers are numeric ids and not usernames

GitLab's reviewer contract is numeric ids, and the board compares the ids of current reviewers with the ids of candidates. Gitea's API takes usernames, so the provider maps ids to usernames at the moment it writes. Keeping usernames on the wire would make Gitea's reviewers the one set the board could not match.

### Why the status scan fails past its bound

A branch whose pull request lies past the scanned pages would otherwise read as "no pull request" and the client would offer to create a second one. Failing keeps the last-known answer in the shell's status cache and tells the user the read did not finish.

### Why history comes from the closed list and not from the direct lookup

The direct base/head lookup answers one pull request of the pair, and on 1.27.3 it answered the oldest closed one while a newer pull request from the same branch existed. Taking it as history would show a stale state. The first page of recently updated closed pull requests costs one request when nothing is open and also covers 1.21, which has no direct lookup.

### Why the timeline trusts Gitea's commit order and not the commit dates

Both versions list a pull request's commits newest first. Sorting by committer date instead reorders commits made within one second, which scripted commits and rebases produce, and needs a second page read.

### Why a warning fails CI

Gitea's own combined state never reads success while a status says `warning` (1.21 reports `warning`, 1.27 `failure`). Counting it as success would show a green badge on a commit Gitea shows as not passing.

### Why removing a reviewer who already reviewed is refused

Gitea answers 204 to that removal and keeps the person among the reviewers, so a silent success would leave the user looking at a reviewer they just removed. The maintainer chose a clear refusal instead, sent before any write so an addition in the same change is not applied halfway. A dismissed review or a bare review request does not keep anyone, so those removals go through.

### Why `/version` is read anonymously before the token is sent

An open instance answers `/version` to anyone, so the capabilities read and most connects need no token there, and the token is sent only where the instance asked for a sign-in. Gerrit's probe does the same (`../gerrit/verify.js`). The capabilities read cannot see a locked instance's version; treating that as unsupported hid the token form, which is the only way such an instance can be reached. The cost: an address that is not Gitea at all but answers 401 or 403 there also gets the token form, and the mistake shows only when the token is saved, as a refused token, with nothing stored.

### Why the provider id and label are parameters and not literals

Forgejo answers the same API, and the recording showed no difference the code would have to branch on. Taking the id for the DTOs and the label for errors from the descriptor lets Forgejo be this module with another descriptor, where a copy would have to be kept in step by hand.
