# Source-control provider: Teahouse

An extension that adds a Git host to OpenChamber, next to GitHub, GitLab and
Gitea. It declares `contributes.service.provides: ["source-control"]` and
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
Labels, reviewers, reviews, drafts and CI are off in the manifest, so
OpenChamber never asks for them.

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

`engines.openchamber` is `>=2.5.1`, the first release that ships the role. A
2.5.0 host refuses the manifest as `invalid-service`, since it does not know
the role; from 2.5.1 on, an older host refuses it as `host-too-old`. A
development build reports the version of this repository, so the example
installs there once `package.json` says 2.5.1 or newer.

## Try it

1. Install this folder from Settings → Extensions and allow the local service.
2. On the **Teahouse** card in Settings → Integrations, add your Gitea server's
   address and a token with the `write:repository`, `write:issue` and
   `read:user` scopes.
3. Open a project whose remote is on that server. Its pull requests and issues
   show on the Issues and PRs board; comment, close, reopen or merge from there.

The service runs `git remote get-url` in the project to find the repository,
which is why the manifest lists `git` under `permissions.exec`.

## Tests

`fake-forge.ts` is an in-memory forge with one repository (`mona/teapot`) that
speaks the same subset, a fork of it (`octo/teapot`) and an unrelated
repository (`mona/kettle`). Pull request #2 changes one file, `README.md`, so
it has a diff, a changed-file list and both sides of that file. It can refuse a token with 401 (`refuseToken`), move a
branch (`push`), and logs every write (`writes`), so a test can prove a
mutation reached the forge exactly once.
`packages/sdk/scripts/source-control-example.test.ts` runs the built service
against it through a stand-in for OpenChamber's outbound proxy.

Rebuild after editing the service or the SDK:

```bash
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/source-control-provider/service/main.ts packages/sdk/examples/source-control-provider/service/main.js
```
