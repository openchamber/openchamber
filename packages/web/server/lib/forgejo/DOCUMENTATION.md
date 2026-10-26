# Forgejo module

## Ownership

This module is Forgejo as a source-control provider: its descriptor, the provider the registry loads, the recorded fixtures and the record of what was checked against live Forgejo. The implementation is Gitea's (`../gitea/`): `createGiteaFamilyProvider` with Forgejo's descriptor and the Forgejo edition (`GITEA_EDITIONS.forgejo`). Everything about requests, mapping, mutations, drafts, reviewers and CI is documented in `../gitea/DOCUMENTATION.md` and holds here unchanged unless this document says otherwise. The descriptor is registered last in `source-control/provider-descriptors.js` and the implementation in the loader map of `source-control/provider-registry.js`. No UI code names Forgejo.

Target: Forgejo 7.0 or newer (7.0 answers as Gitea 1.21, the oldest the Gitea module supports), verified against live 15.0.10 (the current long-term release) and 17.0.0 (see *Verified against live instances*). Codeberg runs Forgejo.

## Invariants

- The descriptor is Gitea's with the id `forgejo`, the label, the mark (Forgejo's logo, CC BY-SA 4.0, credited where the path is defined), a placeholder, the pull request template paths Forgejo looks up, and one default instance, `https://codeberg.org`. Capabilities, auth methods, transport, limits, terminology and settings fields are Gitea's by construction (`...giteaDescriptor`), so the two providers cannot drift apart by accident.
- Codeberg is a default instance: a `codeberg.org` remote is recognised before any account is connected (the client's default identities, `GET /api/source-control/instances`, `auth.ownsHost` in the server's change-request worktree), the Forgejo card lists it without the user typing it, and `builtInDefaultHosts` keeps an extension from claiming it. Nothing reaches Codeberg until the user opens the card (the card reads `GET /api/v1/version` for its capabilities, as the GitLab card does for gitlab.com) or connects an account.
- Accounts live in `section('forgejo')` of `source-control-auth.json`; mutation kinds and digest fields are the standard table's, as Gitea's are, with Forgejo's actor in the digest (`mutation-digest-freeze.test.js` holds them).
- An instance belongs to one card, the one its `/version` names: Forgejo's carries the Gitea version it is compatible with (`17.0.0+gitea-1.22.0`), Gitea's never does. Connecting a token on the other card refuses with `409 SOURCE_CONTROL_INSTANCE_OTHER_PROVIDER` and `provider: '<id>'` before anything is stored, and the Settings card names the right provider in its own words (`SourceControlInstanceOtherProviderError` in the web adapter).
- A version older than 7.0 is `400 UNSUPPORTED_PROVIDER_VERSION`, worded in Forgejo's numbering.
- Errors a person reads name Forgejo: the client, resources and provider take the descriptor's label.

## Verified against live instances

On 2026-10-23 Forgejo 15.0.10 and 17.0.0 (official linux-amd64 binaries, SQLite, three users, a fork network) were driven with the scenario the Gitea fixtures came from, and every endpoint the module calls was recorded and compared with the Gitea fixtures field by field. Then this provider was driven end to end against both: connect (and the Gitea card's refusal), status before and after a fork pull request, lists (open, created by me, search, review requested), create (and a draft), update, labels, reviewers, comments, review and its refusals, context with diff, files, timeline, reviewers and verdicts, patch and both sides of a file, issues and their comments, labels and state, upstream, branches, candidates, live summaries, the worktree head and contributor source, ready, merge with a stale and a current head, and reconciliation of the merge. All 46 checks passed on both versions. `fixtures/api.json` holds the scrubbed responses (origin rewritten to `https://forgejo.example.com`; unsuffixed keys are 17.0.0, `_15` keys 15.0.10).

The answers match Gitea 1.27's in every field the module reads, except:

- `/version` is `<forgejo version>+gitea-1.22.0` on both; the Gitea module checks the Gitea version, and the suffix is what tells the two servers apart. Forgejo also serves `/api/forgejo/v1/version`, which the module does not read.
- A combined status with a `warning` reads `warning` (Gitea 1.27 says `failure`); the module counts a warning as a failure either way.
- A newer review by the same user does not mark the older one `dismissed` (Gitea 1.27 does, 1.21 does not). Verdicts are read per review, as on 1.21.
- Merging a pull request that is already merged answers 405 with an empty message, so the error reads "Forgejo request failed with status 405".
- Right after other writes to a pull request, merging the current head can answer 405 `Please try again later` while Forgejo rechecks mergeability; a second try a moment later succeeds. The module re-reads the head, finds it unchanged and passes Forgejo's answer on, so the user sees the message and can retry. Gitea answers the same way from the same code.

The same as Gitea 1.27 on both: the direct `pulls/{base}/{head}` lookup with `owner:branch`, an encoded colon and a slash in a branch; `draft` ignored on create and `WIP:` / `[WIP]` as the draft marker; labels set by ids and by names, unknown ids dropped; review refusals (own pull request, request for changes without a body) and a review pinned to a foreign commit marked stale; `requested_reviewers` keeping a reviewer who reviewed after a 204 `DELETE`; statuses on a fork not shown on the base repository; issue comments ignoring paging; pull request commits newest first; `MAX_RESPONSE_ITEMS` 50 and the `Link` and `x-total-count` headers where Gitea sends them; the review-requested search; raw files at the fork head and the merge base from the base repository; the three token scopes the card asks for.

Still unverified: Forgejo 7 to 14, Codeberg itself with a token (its `/version` was read anonymously and carries the Forgejo suffix), MySQL or PostgreSQL backends, Forgejo Actions statuses (Actions were off; statuses were posted through the API), and an instance whose SSH host differs from its web host.

## Enterprise mode

Forgejo is a destination for a token and for what the user writes into a pull request, issue or comment, like Gitea and self-managed GitLab: a user-initiated action toward a service the user connected, outside enterprise mode today (`../gitea/DOCUMENTATION.md`, Enterprise mode). Codeberg is a public service; as a default instance it receives an anonymous `/version` read when the user opens the Forgejo card, the same metadata request gitlab.com receives from the GitLab card.

## Decisions

### Why Forgejo reuses the Gitea module and not a shared module with two dialects

The recording found no difference in any field or route the module uses, so a dialect object would have been empty. Forgejo is Gitea's code with another descriptor and edition; a difference found later goes into the edition (`GITEA_EDITIONS`) where it is one place to read, and the shared folder the plan foresaw can wait for a second difference to share.

### Why the server version decides the card and not the order of the registry

Both providers accept any origin, so a server connected on both cards would be claimed twice and the registry order would quietly pick one. `/version` is read on every connect anyway and says which server it is, so the card an instance belongs on is decided once, at connect, with a message naming the right card. Probing unknown remotes to guess their provider was rejected: an unknown host has no account to read with, and the probe would send requests to every host a repository names.

### Why Codeberg is a default instance

Codeberg is the public Forgejo instance, the way gitlab.com is GitLab's: recognising its remotes without an account lets the app offer to connect, and listing it on the card means a token is all a Codeberg user enters.
