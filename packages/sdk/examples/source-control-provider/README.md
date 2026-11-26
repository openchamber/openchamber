# Source-control provider: Teahouse

An extension that adds a Git host to OpenChamber, next to GitHub, GitLab, Gitea
and Gerrit. It declares `contributes.service.provides: ["source-control"]` and
describes the host in `contributes.sourceControl`: its name, its terms, which
instances it accepts, what it can do, and how its token travels. OpenChamber
calls the host `ext-source-control-provider` and draws its Settings card, its
board and its badges from that description, without starting the service.

The service (`service/main.ts`, built to `service/main.js`) answers each call
OpenChamber forwards at `POST /source-control` by talking to a subset of
Gitea's REST v1. Pointing it at a real Gitea 1.21 or newer works for that
subset: pull requests (list, read, create, edit, merge), issues (list, read),
comments, close and reopen, branches, the live state of tracked items, and a
pull request's diff and both sides of a changed file for the Changes view and
walkthroughs (`changeRequestPatch`). A
pull request opens on the project's bound remote; its head can come from
another remote only when that remote is a fork of it on the same server, and
the service names the fork's branch `owner:branch` as Gitea expects. A branch
whose pull request was merged or closed shows it instead of offering a new one.
Labels, reviewers, reviews and CI are off in the manifest, so OpenChamber
never asks for them; `reviewDrafts` is on, so it serves `/pr/review/state`
and the draft routes. A draft is a Gitea `PENDING` review: adding a line
comment is the same `POST /pulls/{n}/reviews` with `event: PENDING` and the
comment inline, which opens the review with that first comment or appends to
the viewer's existing one, since Gitea has no route that adds to a pending
review. A draft comment is edited as an issue comment through
`PATCH /issues/comments/{id}`, read first and refused unless it is in the
pending review. Removing one draft comment is refused before anything is
written: Gitea answers `DELETE /issues/comments/{id}` on a review comment with
204 and keeps it, so the way to drop a draft comment is to discard the review.
A short page of reviews does not end the scan: Gitea counts and pages reviews
before it hides other users' pending ones. Gitea has no comment on a whole file or a line range, so
`reviewDrafts.fileComments` is off, a comment on a line range is refused
before anything is written, and a read-back carries one line side. A pull
request with more reviews than the service scans (500) is a failed read, not
one without a draft, so discard never reports success from a partial list. Gitea 1.24.3
and Forgejo 9.0.3 refuse a `PENDING` review whose body is empty or only whitespace
(`review event PENDING requires a body`, Gitea issue #15933), so the example sends a
zero-width space as that body; the review's summary is set when it is submitted, and
Gitea then reuses the pending review and replaces the body with ours.

A pull request's context with the timeline lists its reviews with their Gitea
ids, and the manifest opts in to `reviewDismiss: "others"` and
`reviewUndismiss`: a repository admin can dismiss someone's review with a
reason and restore it, on an open pull request (`canDismissReviews`). The
service checks the review is on that pull request before writing, posts to
`/reviews/{id}/dismissals` or `/undismissals`, and reconciles by reading the
review back.

The diff is Gitea's `/pulls/{n}.diff` as it comes; a pull request's context
with `includeDiff` splits it per file next to `/pulls/{n}/files`, the same way
the built-in Gitea host does. A file's old side is read at the pull request's
`merge_base` and its new side at the head commit, both from the target
repository through `/raw/{path}?ref=`.

## What stays in OpenChamber

The service never sees a token. OpenChamber keeps the accounts, checks a new
token by calling `auth.verify`, and hands the service a handle for each call.
The service sends forge requests through `createSourceControlForge`, which
posts them to OpenChamber's callback listener (`OPENCHAMBER_HOST_CALLBACK_URL`);
OpenChamber keeps them on the instance's origin, adds the token, and relays the
answer. The handle stops working when the call ends.

OpenChamber also owns the parts that must not change between versions of an
extension: the mutation kinds, the digest that decides whether a retried write
is a replay, the idempotency records, the status cache and the Git credential
used for clone and push. The service resolves what a write targets, performs it
once, and after a restart says whether an earlier write landed.

This is least exposure, not a sandbox: an approved service runs as the user.

## Version floor

`engines.openchamber` is `>=2.8.1`, the first release that knows the
`reviewDrafts` capability. The role itself ships in 2.5.1, but a host before
2.8.1 refuses a manifest that declares `reviewDrafts` as invalid; to run the
example there, drop `reviewDrafts` from the manifest and lower the floor to
`>=2.5.1`. A 2.5.0 host refuses the manifest as `invalid-service`, since it
does not know the role; from 2.5.1 on, an older host refuses it as
`host-too-old`. A development build reports the version of this repository,
so the example installs there once `package.json` says 2.8.1 or newer.

## Try it

1. Install this folder from Settings → Extensions and allow the local service.
2. On the **Teahouse** card in Settings → Integrations, add your Gitea server's
   address and a token with the `write:repository`, `write:issue` and
   `read:user` scopes.
3. Open a project whose remote is on that server. Its pull requests and issues
   show on the Issues and PRs board; comment, close, reopen or merge from there.

The service runs `git remote get-url` in the project to find the repository,
which is why the manifest lists `git` under `permissions.exec`.

## Adapting to a CLI-owned login

Teahouse itself uses Gitea tokens. A CLI-backed variant replaces `token` with
the following contribution and implements `auth.status`. It can also keep
`token` to offer both methods.

```json
"login": {
  "kind": "service",
  "hint": "Run forge auth login on the OpenChamber server"
}
```

`login` needs OpenChamber 2.7.1 or newer, so declare
`engines.openchamber: ">=2.7.1"`. The token-only example keeps its existing
floor.

`auth.status` receives `session.instance`, an empty `input` and no candidate
token. Return `{ user: null }` for an origin the CLI is not signed in to;
failures to execute or read the CLI are errors. Otherwise return the existing
user DTO with an `id` that is a positive safe integer or a non-empty string
of at most 256 characters. Keep string IDs unchanged, including numeric-looking
ones beyond JavaScript's safe integer range.

Resource handlers read through the CLI instead of `createSourceControlForge`.
Compare `String(current.id)` with `String(session.user.id)` before the read and again
before returning data. Discard data on a mismatch and return the following
answer. This protects logout/login and identity changes outside OpenChamber
without requiring a CLI switch command.

```json
{
  "ok": false,
  "error": {
    "code": "ACCOUNT_CHANGED",
    "status": 409,
    "message": "The CLI account changed"
  }
}
```

The host uses its non-persisted `#cli:<id>` account. Its handles cannot call
the forge proxy. Clone, fetch and push use system Git, `mode: 'system'`;
do not extract or pass a CLI credential to OpenChamber. The full contract is
in [GUEST_SERVICES.md](../../GUEST_SERVICES.md#service-owned-sign-in).

## Change-based hosts

Teahouse is a pull-request host and declares none of the fields below. A host
that reviews one change at a time, with revisions and per-label votes the way
Gerrit does, adds them to `contributes.sourceControl`:

```json
{
  "terminology": { "changeRequest": "change", "ci": "checks" },
  "capabilities": {
    "changeRequests": true,
    "reviews": true,
    "merge": { "methods": ["submit"] },
    "reviewModel": "votes",
    "revisions": true
  },
  "token": { "header": "authorization", "scheme": "basic", "username": true, "scopes": [] },
  "presentation": { "features": { "submitRequirements": true } }
}
```

- `reviewModel: "votes"`: `/pr/review` reaches `mutation.perform` as
  `{ votes: { "Code-Review": 2 }, body? }`. Each change's context lists its
  `voteLabels`, with the scores the caller may give.
- `revisions: true`: `changeRequestContext`, `readChangeRequestPatch` and
  `readChangeRequestFile` may carry `revision`, a commit sha. The context lists
  `revisions`, oldest first.
- `merge: { methods: ["submit"] }`: `submit` is the only method when present.
  With `submitRequirements`, the context lists what must hold before a submit.
- `scheme: "basic"` with `username: true`: Settings asks for a username, and
  OpenChamber sends `Basic base64(<login>:<token>)` on every forge request.
- `changeRequestStatus` may add `localRevision` and `stack`.

OpenChamber sends `revision` and `votes` only to a host that declares the
capability, so Teahouse never sees them. Creating a change by pushing to
`refs/for/<branch>` stays with OpenChamber's built-in hosts; an extension's
host opens one through `/pr/create`. Older OpenChamber builds refuse a manifest
with these fields, so raise `engines.openchamber` to the first release that
has them. The full contract is in `GUEST_SERVICES.md`.

## Tests

`fake-forge.ts` is an in-memory forge with one repository (`mona/teapot`) that
speaks the same subset, a fork of it (`octo/teapot`) and an unrelated
repository (`mona/kettle`). Pull request #2 changes one file, `README.md`, so
it has a diff, a changed-file list and both sides of that file. It can refuse a token with 401 (`refuseToken`), move a
branch (`push`), and logs every write (`writes`), so a test can prove a
mutation reached the forge exactly once.
`packages/sdk/scripts/source-control-example.test.ts` runs the built service
against it through a stand-in for OpenChamber's outbound proxy.

Rebuild after editing the service or the SDK. The service loads the reviewer
state, reference, and diff mappings from their own bundles:

```bash
for entry in main reviewer-states review-drafts references diff; do
  bun packages/sdk/scripts/bundle-guest.ts --node "packages/sdk/examples/source-control-provider/service/$entry.ts" "packages/sdk/examples/source-control-provider/service/$entry.js"
done
```
