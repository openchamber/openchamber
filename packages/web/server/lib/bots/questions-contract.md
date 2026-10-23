# Bot questions owner

## Ownership

`questions.js` owns outbound question intent, approved recipient selection and the
item's `waiting-answer` projection. `questions-blame.js` owns read-only Git blame
and GitHub commit attribution. Existing config and repository-policy owners grant
machine approval. Existing effects and services owners journal, authorize, send
and reconcile writes. The coordinator still owns stage progression, answers,
budgets, permission attention and explicit Resume.

The production host constructs this owner with the coordinator's stores and
services. Investigation reports, judge verdicts and `item.ask` share its durable
question lifecycle. Focused checks do not establish live provider notifications.

### Constructor and methods

```js
const questions = createBotQuestions({
  config, store, worktrees, context, services, attention, events, now,
});
```

All dependencies except `now` are required. `context` is the complete return of
`createBotServiceContext`, including `github` and the current scoped
`serviceContext({ project, bot, item, service, operation })`. `worktrees`
is the host's composed production owner, including isolated-result inspection.
The other dependencies are the existing owners used by `createBotsRuntime`.
Outbound requests use the server-only `jira.question` and `discord.question`
service operations. No credential export is added.

Call these methods under the existing project `.owner.lock`. The owner does not
take that lock recursively. Remote calls execute outside item/journal file locks.

```js
await questions.ask({
  project, bot, itemId,
  eventId: 'investigation:0',
  questions: ['Which behavior is expected?'],
  requestedRole: 'tech-lead', // optional
  people: ['person-id'], // optional, exact approved directory IDs
  resumeState: 'fixing', // investigating | fixing | judging
});
await questions.retry({ project, bot, itemId });
await questions.answered({ projectId, itemId });
```

`ask` and `retry` return `{ item, question, receipt? }`. A replay of an answered
event also returns `answered: true` and leaves the current item state unchanged.
`question.code` is a durable failure code; a null route means no recipient/destination
was admitted. `receipt` proves the provider accepted a channel/issue post. It does
not prove a recipient read it. Delivery of the mention's notification also depends
on provider permissions and the person's notification settings.

### Selection and exact destinations

1. Read the current machine-approved people directory. Any explicit `people` ID
   absent from it rejects the request before routing, even when an area matches.
2. Inspect the actual owned worktree. Both old and new paths participate in area
   matching. Use owners from approved matched areas only. A changed area supplies
   no question authority; the existing merge policy still requires human review.
3. Try the complete owner set, then an explicitly requested approved person set,
   then the requested role, then the latest routable approved blame author.
   Each set must have complete, distinct identities for the destination service.
   An incomplete owner set can fall back; it is never partially contacted.
4. For each selection tier, prefer the Jira-origin item's exact issue when the
   bot has Jira identity. Otherwise use its linked Discord conversation or the
   provider runtime's single explicitly configured channel. Selection tier takes
   precedence across services. An owner on Discord precedes a role on Jira.

The explicit-person tier preserves `item.ask`'s existing ability to name approved
people. It does not override matched owners. With no explicit people, the order
is owners, role, blame. Repository names, tool strings and Git author names/emails
never supply a service identity.

Blame reads old paths at the diff's merge base, so renamed/deleted files retain
their pre-change author and newly added files supply no prior author. At most
20 files and 100 unique commits are accepted; exceeding either limit remains
visible for manual routing. No partial attribution is silently truncated.
Each SHA is looked up through the existing `context.github` credential's
fixed-origin `request({ path: '/repos/OWNER/REPO/commits/SHA' })`. The response
SHA must match. Only REST `author.login`, `author.id` and `type: 'User'` have
authority. Null authors and bot accounts are skipped. A case-insensitive GitHub
login must match exactly 1 approved directory entry. Committer dates rank mapped
authors, with SHA as a deterministic tie-breaker. Failed reads propagate and
cannot authorize an empty-success fallback.

No new DM is created. A linked DM is usable only when its exact recipient matches
the sole selected recipient. The existing provider resolver also checks current
channel configuration and current machine approval. Jira has no fallback to an
unrelated issue. No Slack, email or directory editor is added.

### Coordinator integration contract

The production host and coordinator enforce the following wiring requirements.

- `host.js`: import `createBotQuestions`, construct it after `worktrees` and
  `context` using the existing `config`, `store`, `services`, `attention`, `events`,
  then pass `questions` into `createBotsRuntime`. Do not construct another service
  executor or register another route.
- `runtime.js`: add the required `questions` dependency. Replace the UI-only
  branches in `advance` for `investigation.questions` and `requiresAnswer` with
  `questions.ask`. Investigation uses `eventId: investigation:${round}` and
  `resumeState: 'fixing'`. Judge uses `eventId: judge:${round}` and
  `resumeState: 'judging'`. Pass `output.requestedRole` and, if applicable, the
  original `output.reviewers` directory IDs. `judgment.reviewers` already contains
  GitHub logins and must never be passed as person IDs. Keep saving the reports
  and judgment before calling the question owner.
- `runtime.js`, `handleTool` `item.ask`: strictly parse
  `{ operationId, question, people?: string[], requestedRole?: string }`, use
  `eventId: tool:${operationId}`, `questions: [question]`, and the stage being
  paused as `resumeState`. Return the owner's result. The operation ID has the
  existing `^[A-Za-z0-9_-]{1,80}$` constraint. Replays while waiting must reuse the
  captured resume state instead of deriving `waiting-answer`. A new operation ID
  cannot replace an unanswered request.
- `runtime.js`, `answer`: after deduplicated feedback delivery, call
  `questions.answered` before resuming. It refuses unsettled effects. Clear the
  pending question only through that method. Do not turn a provider reply into
  automatic Resume of `needs-you` authorization, permission or budget attention.
  Keep the existing explicit Resume and budget checks for those cases.
  Feedback retains its original question key so an old answer cannot settle a
  newer question. `data.questionAnswer` persists the target and fixed judge round
  until the continuation completes, including after pointer settlement and restart.
- `runtime.js`, recovery and Resume: if the private journal has `pendingQuestion`,
  restore its `waiting-answer` projection before ordinary stage progression.
  `retry` is explicit and retains the captured request. It does not leave
  `needs-you`; any coordinator transition needed for explicit Resume must pass
  its authorization/budget checks first. Restore an intent whose descriptor
  persisted before the item's wait transition by calling `retry` once; do not
  periodically retry undeliverable questions. Stop must refuse a prepared question
  effect under its original key before cleanup, just as it does pending tools.
  Unknown question effects retain the existing cleanup block.
- `prompts.js`: add optional `requestedRole` to investigation/judge output schemas
  and examples. Keep `questions` as strings. The judge's `reviewers` stay directory
  IDs at the model boundary; the question owner validates them against the current
  directory. Add focused parser and runtime entry-point tests.
- `tool.js`: expose optional `requestedRole` for `item.ask`. Require the existing
  `operationId` parameter for a logical question in the tool's description/schema
  and enforce it server-side. Add no recipient service IDs, raw targets, channel
  IDs, identity IDs or mention controls to tool input.
- `DOCUMENTATION.md` and `runtime-contract.md`: link this contract and record the
  new dependency and pending-question recovery/answer/stop behavior.

### Host mention-authority callback

`createBotServices` requires `resolveQuestionAuthority` for question writes. Its
default returns null and refuses them. The production host provides the callback
using its item and journal owners, with the following read contract. It also
requires the current bot to remain enabled with the captured service identity.

```js
resolveQuestionAuthority({ botId, itemId, key });
// => null | { policy, question }
```

The callback only reads authoritative owners. Read failures propagate. It returns
the policy and active selected question record, so approval of other directory
people cannot authorize mentioning them. The service parses both records and
checks the exact selection, identity, target, body and policy at prepare and
dispatch. The adapter rechecks after its issue/channel preflight, immediately
before the POST. See `services/DOCUMENTATION.md` for the operation contract.

Discord generates a selected-user mention prefix and an exact users allowlist,
with role/everyone/reply pings disabled. Jira generates ADF mention nodes;
caller body text is never interpreted as ADF. Ordinary `discord.send` and
`jira.comment` retain their existing no-mention behavior. No tool actions or raw
target inputs are added. Official syntax references are Discord's
[allowed mentions](https://discord.com/developers/docs/resources/message#allowed-mentions-object)
and Jira's [mention node](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/mention/).

## Invariants

- `data.questions[key]` and `data.pendingQuestion` persist intent before policy,
  worktree or provider reads. The key hashes item ID and the caller's stable
  event/round ID. Input changes under that key fail. An unanswered question blocks
  a different event key. `answered` clears only the pointer and retains history.
- The route captures person IDs, service IDs, policy fingerprint, base/head SHAs,
  service identity revision and exact target. It persists before service prepare.
  The prepared envelope and input then persist in `execution.operations[key]`
  before the effect can become dispatching or a content executor can run.
- Dispatch checks current directory approval, captured policy/head/base, enabled
  bot, selected service identity and destination. A changed target cannot reroute
  a prepared request. Unrelated unknown effects block fresh writes for the item.
- Proven pre-dispatch failures remain prepared for explicit same-key repair.
  Dispatching and unknown effects only reconcile by reads. A lost comment never
  gets a replacement key. Existing comment adapters cannot prove a lost result,
  so the question remains central and blocks resumption until settled externally.
- Missing routing, ambiguous destinations, read failure and delivery failure keep
  the item waiting with channel `ui` and the question text. Successful posting
  also keeps the central request until an answer. The owner never clears
  `needs-you`, permission or budget attention and never resumes a model session.
- Store/journal write failure propagates. No remote write follows a failed intent
  or descriptor write. A lost receipt leaves the effect dispatching for recovery.
  Snapshot and journal storage guarantee process-restart recovery, not power-loss
  durability. Existing items need no migration; the journal adds private fields.
- Existing plain-post question descriptors retain their original operation and
  key. They can settle or reconcile without becoming a new mention write. An
  uncertain old post cannot be upgraded or resent under a replacement key.

### Runtime and risk ownership

| Runtime | Question behavior |
|---|---|
| Web | Server owner, authenticated existing Bots routes and central attention. |
| Electron | Same owner in the in-process web server. |
| Hosted mobile | Same server and central attention. No local credential access. |
| Capacitor mobile | Same server and central attention through its selected connection. |
| VS Code | Bots remain unsupported; no question owner is constructed. |

This change has local routing, internal module-contract, persisted-intent and
external-write risks. The questions owner owns routing and intent tests; effects,
service and provider owners retain write/reconciliation/enterprise authority.
Question text is egress through the already-gated Jira/Discord operations. GitHub
reads transmit only repository IDs and commit SHAs through the credential owner.
No listener, provider entry or telemetry is added. No shared UI export changes.

## Decisions

### Why repository owners precede requested recipients

Approved matched areas express the project's routing rule. Explicit directory IDs
remain available when no complete owner route exists; arbitrary usernames have
no authority.

### Why GitHub attribution follows local blame

Git identifies the commits that last changed the relevant pre-change files.
GitHub maps those exact commits to accounts. Local author names and emails are
editable and cannot establish a GitHub or Discord identity.

### Why a posted question remains central

Provider receipts confirm posting and carry no personal notification/read receipt.
Keeping the central question open gives unresolved routing and uncertain writes
an actionable user-visible outcome even when provider notification settings mute
the selected mention.

### Why an unanswered question has one key

Comments have no provider idempotency key or safe text-based reconciliation.
Retaining the original event key prevents a restart or model retry from sending
the same logical question twice under a different operation ID.

## Focused evidence

`questions.test.js` drives the real question owner, policy reader, config parser,
item/execution stores, production worktree owner, identity/credential resolver,
service adapters and central-attention adapter. Its peers are controlled HTTP,
credential storage, notification-center methods and inactive event-delivery hooks.
`questions-driver.mjs` repeats the blame/outbound/unknown-restart path as a separate
Node process and prints its Git SHA, exact recipient, stable key and write count.
Disposable Git fixtures create commit objects without touching this checkout's
history. These checks do not prove live provider behavior, production host wiring,
UI rendering, personal notification delivery or all 3 coordinator entry points.
