# Bot service adapters

## Ownership

The server owns service credentials, exact identity resolution, outbound provider
requests and provider reconciliation. `../services.js` is the engine entry point;
`../identities.js` owns the private identity store. The bot engine owns admission,
the durable effect journal, delivery cursors and user attention. Repository bindings
remain owned by source control and are unchanged by a bot operation.

These are internal module APIs. The engine derives identity, target and worktree
from the admitted item and reserves its bot branch exclusively. Managed tool
arguments do not grant authority to choose another identity or destination.

### Engine contract

`createBotServices({ identities, dataDir, runtimeIdentity, policyOptions?, fetchImpl?, approvedDiscordPeople?, resolveQuestionAuthority? })`
returns:

- `prepare({ key, operation, botId, itemId, identityId, identityRevision, target, input })`
  returns a serializable effect with captured authority and `inputDigest`. It performs
  authenticated reads, but no content write. Persist this effect before dispatch.
- `execute(effect, input, { beforeDispatch?, beforeAdmission? }?)` performs the operation and returns a compact receipt. `beforeDispatch` is the engine's durable dispatch admission. Captured identity and destination policy are checked before that callback; no source-control mutation is claimed and no content executor is entered until it resolves. For Git push, current signature rules select the API or Git transport destination to validate. Provider boundaries still revalidate identity and policy at use time. `beforeAdmission` separately checks the merge generation after GitHub preflight. Recovery never invokes either callback to send another write.
- `reconcile(effect, input)` performs reads and returns
  `{ state: 'succeeded', result }` or `{ state: 'outcome-unknown' }`.
- `read({ identityId, identityRevision, operation, target, input? })` performs a
  provider read using that exact identity.

Operations are `git.push`, `pr.open`, `pr.comment`, `pr.auto-merge`, `pr.disable-auto-merge`, `pr.dequeue`,
`jira.comment`, `jira.question`, `jira.transition`, `discord.send` and `discord.question`. Targets and inputs are
strictly parsed by `contracts.js`. GitHub targets name `repositoryId`, `owner`
and `repo`; Jira targets name `projectKey` and `issueKey`; Discord targets name
`guildId` and `channelId`. A DM uses guild `dm` and an approved `recipientId`.
`approvedDiscordPeople(effect)` reads the machine-approved directory at use time
and returns Discord user IDs. Without that dependency, DM sends are refused.

| Operation | Input |
|---|---|
| `git.push` | `{ directory, branch, headSha, baseSha, expectedRemoteSha: string \| null, base }` |
| `pr.open` | `{ branch, base, headSha, title, body, draft? }` |
| `pr.comment` | `{ number, headSha, body }` |
| `pr.auto-merge` | `{ number, branch, headSha, baseSha, mode: 'auto-merge' \| 'queue', mergeMethod?: 'MERGE' \| 'SQUASH' \| 'REBASE' }` |
| `pr.disable-auto-merge`, `pr.dequeue` | `{ number, branch }` with the exact `bot/<itemId>` branch |
| `jira.comment` | `{ body }` |
| `jira.transition` | `{ transitionId, expectedStatusId }` |
| `discord.send` | `{ body }` |
| `jira.question`, `discord.question` | `{ body, recipients: [{ personId, serviceId }], policyFingerprint }` |

Question operations are server-only. The question owner supplies the selected
recipient set; neither operation is an ordinary tool action. The strict input
accepts 1 to 20 distinct person/service pairs. Discord validates snowflakes and
the complete 2,000-character message including the generated mention prefix.

`resolveQuestionAuthority({ botId, itemId, key })` returns `null` or
`{ policy, question }` from the current approved repository policy and private
question journal. It must resolve the matching active item and return a question
only when `data.pendingQuestion === key`. The service parses this result, checks
current approval/fingerprint and every person/service mapping, and compares the
exact operation, identity revision, destination, body and selected recipient set
with the journaled route. Returning the whole approved directory alone grants no
mention authority. A missing callback fails closed for question writes.

The service validates at prepare, before dispatch admission, and after provider
issue/channel preflight immediately before the content POST. The adapters require
that service callback for question writes. Discord generates `<@id>` prefixes and
`allowed_mentions: { parse: [], users: selectedIds, roles: [], replied_user: false }`.
Jira creates ADF `mention` nodes with exact `attrs.id`. The question body stays
untrusted text. Ordinary sends suppress pings and ordinary Jira comments remain
text-only. Identity and enterprise checks still apply at the HTTP write boundary.
Question responses use the existing compact comment/message receipt shape.

Reads are `github.rules` and `github.branch` with `{ branch }`, `github.pull`
with `{ number, headSha? }`, `jira.issue`, `jira.transitions`, `jira.comments`
with `{ startAt? }`, `jira.search` with `{ jql, nextPageToken?, maxResults? }`
and `discord.channel`. Jira search takes an empty `{}` target and sends the user's
JQL unchanged, including ordering. Results may span projects; each issue key must
agree with its returned project. Writes retain their exact issue/project targets.

`github.authorization` takes `{ number, branch }` and returns `{ number, headSha,
baseSha, merged, autoMerge, queued }`. It verifies the exact repository, PR and
owned branch through REST and GraphQL. Revocation intentionally accepts a changed
head. Legacy admission descriptors without branch/base remain parseable for
read-only recovery; fresh dispatch requires both fields.

`configureBotWorktreeIdentity({ directory, name, email })` in `git.js` writes worktree-local
author settings and disables local commit signing. The checkout must be a linked
worktree. Shared author and transport settings are preserved. The engine derives
the name/email from the chosen identity before starting correction.

GitHub operations additionally use the source-control mutation journal. Bot
authority is a separate target variant containing bot, item and identity revisions;
it grants no repository binding capability. Jira and Discord dispatch are called
only by the engine after its journal enters `dispatching`. After that transition,
restart recovery calls `reconcile`, never `execute`.

A service failure before `beforeDispatch` leaves the engine effect prepared and
its exact request available for explicit Resume after repair. After the callback,
errors retain the existing conservative outcome handling, including failures in
later provider checks. No error-code heuristic changes an ambiguous network write
into a retryable refusal. Terminal failed source-control receipts stay immutable.

`BotServiceError` exposes `code`, `status` and `state`. Authentication and permission
failures use `needs-you`; a write with no authoritative response uses
`outcome-unknown`. Errors contain no upstream body or credential. The engine keeps
the original key and authority on recovery and never invents a replacement key.

### Focused validation

`../identities.test.js`, `../services.test.js`, `git.test.js`,
`../provider-events.test.js`, `../discord-gateway.test.js` and
`../../source-control/bot-authority.test.js` cover the adapter contracts. Run each
through the web package's `test` script as a single file. Existing source-control
mutation-storage, mutation-executor and audit-storage suites cover user behavior.
`node packages/web/server/lib/bots/services.driver.mjs` runs successful, replayed
and failed service calls against a controlled HTTP upstream.

`questions.test.js` in this directory covers selected-only mentions, denied
policy/recipient changes at preparation and both dispatch boundaries, ordinary
post isolation, enterprise refusal and original-key unknown outcomes through
the actual question/service owners. `../questions-driver.mjs` prints captured
Jira ADF and Discord allowed-mention requests, plus zero additional writes for
denied requests. The host callback hunk is in `../questions-contract.md`.

These checks use fixtures. Real GitHub App signature acceptance, GitHub rules and
merge completion, live Jira and Discord credentials, Discord developer-portal
configuration and packaged Windows process behavior require authorized live QA.

### Runtime behavior

| Runtime | Behavior |
|---|---|
| Web | Server executes operations and stores private identities. |
| Electron | Uses the in-process web server. No renderer credential access. |
| Hosted mobile | Calls the same server through authenticated bot routes. |
| Capacitor mobile | Calls the same server through authenticated bot routes. |
| VS Code | Bots are unsupported. No credential or dispatch adapter exists. |

## Invariants

- A connected GitHub account resolves with `getGitHubAuthByAccountId` and its
  captured credential revision. Active accounts, CLI accounts and environment
  credentials never grant bot authority.
- App keys, Jira tokens and Discord bot tokens live only in
  `<dataDir>/bot-identities.json`, atomically replaced with mode `0600`.
  Public lists use an explicit allowlist. Rotation increments identity revision.
  Jira OAuth service accounts use the additive `jira-oauth` definition with site,
  cloudId, clientId and clientSecret. Client secrets follow the same private-file
  contract; access tokens exist only in the resolved credential's memory.
- GitHub App JWTs and installation tokens exist only for one operation in memory.
- Every content write checks `assertBotWriteAllowed` immediately before dispatch.
  All HTTPS requests reject redirects and use fixed provider origins. Basic Jira
  identities use configured Jira Cloud sites under `atlassian.net`. OAuth first
  reads that site's public `/_edge/tenant_info` without authorization and checks
  its cloudId before sending credentials or content. Only then may it exchange
  client credentials at `https://auth.atlassian.com/oauth/token` and call the
  fixed `https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/` gateway.
  The configured site remains the captured authority and exact enterprise
  site/project destination. A shared gateway grant authorizes no tenant.
- OAuth uses the service-account `client_credentials` form exchange, not an
  authorization-code, JWT-bearer or refresh-token flow. Each resolved credential
  owns an in-memory token and a single in-flight renewal. It renews before expiry
  on demand; it has no global token cache, persisted access token or timer. Token
  expiry is measured from exchange start with a bounded safety margin. Failed
  renewal cannot reuse the expired token. Every call checks the captured identity
  revision, including after exchange; replacement or removal invalidates it.
- Token acquisition is credential-only traffic to a fixed endpoint, not a content
  mutation. The final content boundary awaits renewal, rechecks identity and any
  question authority, then checks current enterprise policy immediately before
  fetch. API401/403 and uncertain writes never trigger token renewal and replay.
- Ordinary Git publication uses an operation-private bare repository and the
  existing loopback credential broker. Git receives no token in argv or its
  environment. It has no shared config, hooks, SSH or credential fallback, and
  refuses redirects. The administrator's Git destination is `https://github.com`;
  API writes use `https://api.github.com`. Each needs its own exact policy entry.
- A signed publication requires a GitHub App. It checks legacy branch protection
  and effective rulesets, uploads exact blob/tree objects, creates commits with no
  author/committer overrides and requires `verification.verified`. Its receipt
  contains `headSha`, `sourceHeadSha` and `commitMap`. The engine must use the
  published SHA for PR admission and retain the local SHA for proof evidence.
  A lost signed-publication receipt stays unknown. No unsigned fallback exists.
- Publication supports linear histories of at most 100 commits, 2,000 files per
  snapshot and 16 MiB of snapshot content. LFS pointers and gitlinks fail before
  publication because this adapter has no separate auxiliary transfer authority.
- A lost comment has no safe reconciliation evidence. Its outcome stays unknown.
  Unique PR branches can reconcile only an exact repository, branch and base.
- A question's selected recipients, policy fingerprint and provider operation are
  immutable effect inputs. Unknown question posts only reconcile by reads, just
  like ordinary comments. Mention authorization never grants a new retry key.
- Auto-merge and merge queue requests use GitHub admission. No direct merge or
  administrator bypass is available.
- Both GraphQL admissions pass `expectedHeadOid`. Queue admission uses
  `jump: false`; rebase auto-merge is refused when signatures are required.
- Cancellation uses `disablePullRequestAutoMerge({ pullRequestId })` and
  `dequeuePullRequest({ id })`, both with the PR node ID. Each operation reads its
  postcondition; the coordinator additionally confirms both flags absent. A
  merged PR returns `{ number, headSha, merged: true }` and does not establish
  successful cancellation. New cancellation operations are server-internal and
  unavailable through bot tools. Enterprise destination policy gates them at the
  same write boundary as admission, with no cancellation exemption.
- Discord opens only an outbound Gateway connection. Only configured channel
  mentions and DMs from approved people enter the durable event delivery path.

`createBotProviderEventStore({ dataDir })` owns `read(scope)`,
`record(scope, { expectedCursor, cursor, events })` and `drain(scope, deliver)`.
`record` saves pending events and cursor atomically before delivery. The engine's
`deliver(event)` must durably deduplicate `event.id`, since a crash after callback
success and before the local delivery receipt can repeat that callback. Pending
events are retained; delivered deduplication history is bounded at 2,000 per stream.
This supports process-restart recovery and does not claim power-loss durability.

`pollBotJiraComments({ services, eventStore, identityId, identityRevision, target, deliver })`
reads only an active issue. It scans offset pages from zero and advances a creation
timestamp watermark only after complete pagination. Own comments and app comments
do not wake the item. A changed total or incomplete scan retains the old watermark.

`createBotDiscordGateway({ identities, identityId, identityRevision, channels, people,
eventStore, deliver, onError, fetchImpl?, policyOptions? })` returns `start()` and
`stop()`. The engine supplies approved channels and people. Gateway session/sequence
state is persisted before event delivery. Reconnect resumes with that cursor;
invalid sessions reset it, auth/intents failures require user action. Heartbeats
continue while the engine processes a slow delivery. The Gateway sends only auth
and protocol frames; all conversation sends use the gated HTTPS adapter. Its queue
holds at most 128 frames and reconnects with backoff on overload.

## Decisions

### Why the Discord Gateway asks for messages only

Identify sends the server-message and direct-message intents. With the server
intent, Discord follows READY with one frame per server that lists every channel
and role. On a real server that frame exceeded the 128 KiB frame limit, the
socket closed, and the owner reconnected about every 10 seconds, spending a
session start each time. Discord allows 1,000 a day and resets the bot token
beyond that. The owner reads only `MESSAGE_CREATE`, so the snapshot is not
requested. A frame over the limit now stops the owner as
`BOT_DISCORD_FRAME_TOO_LARGE`, and the reconnect delay returns to 1 second only
after a session lasted 60 seconds.

### Why branch rules come from GraphQL and not the REST rules endpoint

`github.rules` reads `ref.rules` and `branchProtectionRule` in one GraphQL query.
`GET /repos/{owner}/{repo}/rules/branches/{branch}` answers 403 for a private
repository on GitHub Free, and the transport cannot tell that from a missing
permission, so every push and merge admission there stopped as an authorization
failure. GraphQL returns the active repository and organization rules on every
plan. Rule types are lowercased to the REST names the callers compare. A branch
with more than 100 rules is refused, since an unread rule could require
signatures or a merge queue.

### Why the Jira site's identity stays authoritative behind the gateway

All OAuth tenants share api.atlassian.com, so granting that origin alone would
broaden a site's project permission to other tenants. The public tenant lookup
binds the immutable identity's cloudId to its selected site before authentication,
preserving existing exact site/project grants while deriving the wire URL.

### Why access tokens live inside a resolved credential

Jira service-account tokens are renewable with the stored client credentials.
Operation-local state supports expiry between calls without a persistent token
store or a global cache retaining deleted identities. Renewal does not authorize
replaying a comment or transition whose outcome is uncertain.

### Why bot authority and not a replacement repository binding

A bot chooses credentials independently for each service and item. A distinct
source-control target records that authority without changing the user's shared
repository selection or allowing an ambient credential to authorize the bot.

### Why an atomic secret snapshot and not separate key rotation writes

The private snapshot contains the App PEM and tokens under one `0600` file.
Replacing identity metadata and secret material together prevents partial rotation
from pairing an old revision with a new key.

### Why unknown outcomes and not automatic comment retry

Providers do not give a durable idempotency key for ordinary comments. Matching
text cannot prove who wrote a comment or whether the lost request took effect.
The engine asks for human intervention when it cannot prove the result.

### Why cancellation has separate durable operations

Auto-merge and queue membership can coexist, so disabling one cannot establish
the other's absence. Each captured generation keeps its disable and dequeue
receipts independently. Ambiguous operations only read their own postcondition
through the source-control owner's explicit reconciliation API; authorization
still present leaves the owner blocked and cannot authorize a replacement key.

### Why isolated Git transport and not the repository's configured remote

A bot's account is independent of the shared repository binding. An ephemeral
bare repository reads local Git objects while its sole credential lease grants
only the fixed GitHub HTTPS endpoint, so repository helpers and URL rewrites
cannot substitute another account or destination.

### Why creation watermarks and not persisted Jira offsets

Deleting an older comment shifts later offsets. Each active-issue poll starts at
zero and retains its timestamp boundary and event IDs until complete pagination,
so deletion between polls cannot skip a newer reply.

### Why question mentions have separate service operations

Ordinary model-authored text has no recipient-selection authority. A separate
operation checks the server's selected question route and current machine policy
before generating provider mentions, keeping ordinary posts unable to enable pings.
