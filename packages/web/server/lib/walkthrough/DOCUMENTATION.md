# Walkthrough

Generates a guided, ordered reading path through a diff: the small model groups
related hunks into stops and chapters and explains each group, and the UI
renders those stops interleaved with the code they describe.

Generation is **always user-initiated**. Nothing here runs on a timer, on a file
change, or as a side effect of opening a panel — it spends tokens, so a person
has to ask for it.

## Files

- `hunks.ts` — parses a unified diff into files and hunks and assigns each hunk
  a stable id.
- `generated.ts` — recognises tool-produced files that are kept out of the
  model's input.
- `sources.ts` — turns a source descriptor into diff *sections*.
- `digest.ts` — builds the model-facing digest and the alias↔id mapping.
- `prompt.ts` — system prompt, size guidance and previous-walkthrough section.
- `schema.ts` — response schema, response normalization, tolerant JSON parsing.
- `store.ts` — content-addressed cache entries plus mutable pointers.
- `pull-request.ts` — change request diffs and per-file contents through the
  provider-neutral readers the runtime injects from the source-control module
  (`readChangeRequestPatch`/`File`), which dispatch by the context's provider
  to its `resources.readChangeRequestPatch`/`File` (GitHub's are
  `github/change-request-patch.js`, GitLab's `gitlab/resources.js`, Gitea's
  `gitea/resources.js`, Gerrit's `gerrit/resources.js`). It also
  says which providers walkthroughs serve: those whose descriptor has
  `capabilities.changeRequestPatch`.
- `model-settings.ts` — the feature's own model override.
- `languages.ts` — the languages the prose may be written in.
- `index.ts` — orchestration.
- `routes.ts` — `/api/walkthrough*`.

## What a walkthrough says

A walkthrough does three things, in the prompt's words: a reading order (stops
grouped across files and ordered so each builds on the last), an explanation
of what each stop's code now does differently, and rare **observations**. An
observation is a fact the reader agrees to by accepting the change, of one of
five kinds: `decision` (a product or architecture call that could have gone
another way), `cost` (code in another language, a dependency or pinned
version, a second implementation), `limitation` (what users still cannot do),
`asymmetry` (two paths of the same thing behaving differently for the user),
and `unproven` (the main promise has no test). Each stop carries an
`observations` array, empty on most; the normalizer drops unknown kinds and
empty notes and keeps at most two per stop and `MAX_OBSERVATIONS` in all.
Entries written before observations existed have no array, and the client
treats that as none.

The focus line says what changes for the people using the software, worked out
from the code: strings, docs, tests and what the new code connects to.
`critical` is meant for the stop or two the change rests on; the size guidance
gives the model a ceiling for both critical stops and observations.

The reader's own preferences come from the Walkthrough Magic Prompt
(`walkthrough.instructions`), read on the server for the directory through
`readWalkthroughInstructions` (project override over global; no built-in
text, so no override means none). They go into the system prompt inside
`<preferences>`, at most 4,000 characters — enough for a page of preferences
and small enough that a pasted document cannot crowd out the diff — after a
line saying they shape tone and emphasis and cannot change the format, the
anchoring or the factual nature of observations. A generation that cannot read
them fails with `instructions-unreadable` instead of sending none; the panel
read only measures readiness with them and does not fail. They are not part of
the cache key, like the thinking level: changing them keeps the review on
screen until the user regenerates.

### Why observations and not "what a reviewer should check"

The earlier prompt asked every stop for what a reviewer should check or be
suspicious about. Models answered every stop, on every model tried, with the
invariant they had just described rephrased as "check that…": it read like a
review and checked nothing. Finding bugs is the Review action's job. The five
kinds are facts rather than verdicts, so a model can say "this pins OkHttp
5.3.2" without calling the code wrong, and empty is the expected answer for
most stops.

### Why the user need comes from the code and not the PR description

The description is not sent. It can be stale, wrong, or written for a reviewer
rather than about the change, and a local scope has none at all. The code, its
strings, docs and tests are the same evidence for every scope.

## Hunk identity

`hunks.js` is the only place that decides what a hunk is or what its id is. The
client never recomputes ids; it receives the current hunk index (id → patch)
alongside the walkthrough and matches ids to ids. Two implementations of the
same hash would have to agree byte-for-byte forever, and the first one to drift
would silently mis-anchor every stop.

An id is `<scope>:<path>:<sha1(header + body)[:8]>`, with a `-2`, `-3`, … suffix
for byte-identical hunks repeated inside one file.

The model never sees an id. The digest gives every hunk a request-local alias
(`h1`, `h2`, …), which costs fewer tokens than an id and cannot be plausibly
invented for a hunk that does not exist; the normalizer resolves each alias back
to the real id.

Two consequences fall out of hashing the content:

- Editing a hunk changes its id, so an anchor that no longer resolves is
  **proof** the code it described changed. Staleness needs no heuristics.
- Editing one hunk does not disturb its neighbours, so a small edit invalidates
  only the stops that actually covered it.

`scope` keeps staged and unstaged versions of the same lines apart, so a stop
written against staged code never silently re-anchors onto an unstaged edit.

## Sources

| Kind | Sections | Notes |
|---|---|---|
| `working-tree` (`all` \| `staged` \| `working`) | `staged`, `working` | Untracked files are fetched individually because `git diff` omits them |
| `branch` | `branch` | `getRangeDiff` with `includeWorkingTree: true` compares the selected merge base with current files, including committed and local work in one net diff |
| `commit` | `commit` | `getCommitDiff` compares the full selected commit hash with its first parent; root commits compare with an empty tree |
| `pr` | `pr:<number>` | The provider's committed pull-request diff, without local working-tree changes. Every read carries a validated repository binding context |

Changes, mobile Changes and walkthrough resolve the current branch's base
through `packages/ui/src/hooks/useBranchComparisonBase.ts`, which takes the
first candidate that names a ref (`resolveBranchComparisonBase` in
`packages/ui/src/components/views/git/baseBranch.ts`): an explicit choice, then
the base of the branch's open pull request as the status store already holds it,
then reflog detection, then the repository's default branch. The pull request's
base outranks the reflog because it is what the branch merges into and survives
a rebase or restack. Each candidate is qualified by `qualifyBaseRef`: the range
API names refs literally, a bare name resolves to the bound remote's copy
(`origin/main`, what the pull request compares against) and to the local branch
only when the remote has none, an explicit `refs/heads/` choice stays local, and
a base outside the bound remote is not a comparison this repository can make. A
chosen base that no longer resolves, or a candidate naming the branch or its own
remote copy, gives way to the next. The toolbars use
`packages/ui/src/components/views/git/BranchComparisonSelector.tsx` to select or
change the base directly; its Automatic item drops the choice. Walkthrough allows selecting Branch before a base is
known and waits for a valid choice before loading or generating. Opening
walkthrough from Changes carries the selected base and head; later selections
in either toolbar update both comparisons.

Commit mode uses the shared `CommitComparisonSelector` in both toolbars. It
lists the latest 50 commits reachable from the checked-out branch, with subject,
author, date, and short hash. Opening the picker refreshes that list; selecting a
commit changes the comparison, not the checkout. Changes hands the selected full
hash to walkthrough. The server accepts full object IDs for commit sources and
keys their cache entries and generation jobs as `commit:<hash>`, so reviews of
different commits cannot overwrite each other. Existing source keys keep their
format. Commit reads have no working-tree freshness dependency, and selecting a
commit never starts model generation.

The Git module owns exact-ref and working-tree comparison semantics. Local and
remote bases remain distinct, and a checkout during a branch review requires
the source to be resolved for the new branch rather than including another
branch's local files.

Successful status refreshes invalidate the visible branch comparison even when
file names and insertion/deletion counts stay the same. Walkthrough refreshes
its current hunk index while visible; regeneration remains user-initiated. The
content-addressed cache continues to reuse an old review only when its hunks
match, and otherwise reports stale anchors and uncovered current hunks.

PR mode uses the same searchable, paginated selector as Changes. Its list loads
only while PR mode is visible. Selection ownership and handoff rules are in
`packages/ui/src/stores/DOCUMENTATION.md`.

PR sources may include `sourceRepo: { owner, repo }`. `owner` is a single
segment on GitHub and Gitea, a namespace path on GitLab (`group/subgroup`), and
on Gerrit the project path before its last slash, matching
what each provider's project mapper produces. It qualifies the cache/job
key as `pr:<owner>/<repo>:<number>`, so equal numbers in different repositories
stay apart. Number-only sources keep `pr:<number>` and read the repository behind
the bound primary remote. A named repository is honoured only inside the bound
repository's network, the repository and the upstream it was forked from, which
is what the bound pull request list reads with the same account. A name outside
that network, in a source without `linked: true`, fails with `409 PULL_REQUEST_REPOSITORY_MISMATCH` before any GitHub
request. Each owner segment allows the characters a repository name does with
dots kept internal, so `.` and `..` can never be a segment, and the owner is only
ever compared against the bound repository's network, never turned into a
filesystem path. The PR panel forwards the project of the pull request it shows.

`GET /api/walkthrough/pr-diff` accepts `directory`, a JSON `source` restricted
to PRs, and the same bound read-context fields as the other walkthrough routes.
It validates that context against the binding and reads with its exact account;
without one it reads nothing. It returns GitHub's complete published diff as
text, with no model readiness checks or generation. A GitLab context returns
the merge request's diff, rebuilt by `gitlab/resources.js` into the same git
patch shape from GitLab's per-file hunks (GitLab diffs against the merge base,
like GitHub). A Gitea context returns Gitea's own `.diff` of the pull request. A Gerrit
context returns the diff part of the patchset's `/patch` against its first
parent, for the current patchset or the named `revision`.
Successful empty patches return 200; auth,
GitHub and malformed-response failures remain errors. Walkthrough generation
keeps its existing empty-diff refusal. UI comparison behavior is documented in
`packages/ui/src/components/views/DOCUMENTATION.md`.

`GET /api/walkthrough/pr-file` takes the same `directory` and PR `source` plus
`path`, optional `previousPath`, and `status`, and returns `{ original, modified }`
for that one file as the provider has it: the base side at the PR's merge base, the
head side at the PR head. This is how the comparison view expands collapsed
context for a PR: its patch arrives at fixed context and its commits may not be
on disk, so the working tree is never read. Files above 5 MB answer `413`
(`code: 'file-too-large'`).

## No truncation

Within what it covers, the digest is complete. When it does not fit the resolved
model's context, generation is **refused** (`409`, `code: 'context-too-small'`)
so the user can pick a roomier model. A walkthrough written against a silently
clipped diff is confidently wrong in a way no reader can detect, which is worse
than no walkthrough.

Readiness and generation hold the prompt to the same limits (`small-model`,
*Prompt shape*). A provider that still refuses it as too long ends in the same
`409`, without sizes. That refusal is not a schema refusal: it triggers no
schema-free retry and is not remembered against the model.

## Generated files

`generated.js` excludes tool-produced files — lockfiles, minified bundles,
codegen, snapshots — from the digest by **name, never by size**. A lockfile can
be larger than the entire change around it and carries no intent, so sending it
wastes context that real code needs.

They are excluded, not hidden: they carry no hunk aliases (so nothing can anchor
to them), but they are still parsed, still returned to the client, and still
appear in the uncovered tail. The matcher is deliberately conservative —
`src/lock.ts` and `src/generator.ts` are authored code — because a false
positive silently drops real code from a review, which is the exact failure this
feature exists to prevent.

When a change consists only of generated files, generation is refused with
`code: 'only-generated'` rather than the misleading "nothing changed".

## Model selection

The walkthrough has its own model setting (Settings → Sessions → Changes
Walkthrough Model), read by `model-settings.js`:

`walkthroughModelOverride` (`provider/model`) is the whole contract: set, that
model is used for this feature and nothing else; unset or empty, generation
falls back to whatever the small-model chain resolves to. Choosing a model *is*
the opt-out, so there is no separate toggle to disagree with the picker — the
settings picker simply shows "Small model will be used" until a choice is made,
and clearing it restores the fallback.

`walkthroughModelVariant` is the thinking level chosen beside that model in
Settings. It applies only while the walkthrough runs on the saved model: a
model picked for one review runs at its own default level, and changing or
clearing the saved model clears the level. The server checks it against the
catalog the way the small model's level is checked (`small-model`'s
`resolveModelVariant`). The level is not part of the cache key, so changing it
keeps the review on screen until the user regenerates.

The separation exists because the two roles pull in opposite directions: the
small model is chosen to be cheap and fast for recaps and commit messages, while
this one needs schema-shaped output and enough context for a whole diff. Forcing
one setting to serve both means degrading one feature to fix the other.

A review can also override the model for itself: `GET`/`POST` accept a `model`
(`provider/model`) that outranks both the setting and the small-model chain.
That choice is panel state, not a settings edit — picking a roomier model for
one risky change should not silently redefine the default for every future one.
It needs no storage: the model that produced a walkthrough is already recorded
in its cache entry, so reopening a panel resolves the picker as *explicit choice
→ model that generated what is on screen → settings*. Because the model is part
of the cache key, switching models and back returns the earlier review for free.

The composer's provider is a preference, not an override: without a model of its
own, the walkthrough stays on the provider the user is working in rather than on
whichever provider happens to be connected, and on that provider's model when it
has no small one.

The picker hides models the catalog reports as `structured_output: false` —
offering them would move the same refusal one click later — and, like the small
model picker, only shows providers with a usable login. The in-panel picker on a
blocked walkthrough writes this setting too, so recovering from a refusal never
silently changes the model behind commit messages.

A settings or `opencode.json` `small_model` override can still name a provider
with no usable login (neither `auth.json` nor `provider.<id>.options.apiKey`).
`describeSmallModel` reports that as `hasLogin: false`, readiness refuses with
`reason: 'no-provider-login'` and omits the unusable model so the panel cannot
present it as selected, and generation maps the same code to HTTP 401. The UI
disables Generate and keeps the picker on authenticated providers only — it does
not surface a raw auth error or a special login blocker for this case.

## Output language

A walkthrough its reader cannot read is worth nothing, so the prose language is
a per-review choice in the panel header, defaulting to the interface language.
Like the model it is request state rather than a setting: it travels as
`language` on `GET` and `POST`, and it is not persisted, because the language a
walkthrough was written in is already recorded in its cache entry and returned
as `language` — which makes it the better default on reopen than any remembered
preference. Resolution is *explicit choice → language of what is on screen →
interface locale*.

Only prose is translated. Hunk aliases are keys that resolve back to hunk ids,
and `icon`/`importance` are validated against fixed English values, so a
translated one is dropped by the normalizer — losing an anchor or a style
silently. The prompt says so explicitly. Language names go into the prompt in
English, keeping the instruction in the same language as the rest of the system
prompt; a switch mid-sentence is handled less reliably.

`languages.js` owns the accepted tags; they match the UI's `Locale` union, and
anything else — unknown, malformed, absent — resolves to English rather than
failing the request. Case and separator drift (`uk-UA`, `pt_br`) is normalized
before matching, so a platform locale does not silently fall back to English.
The two lists cannot be one, because the server cannot import from
`packages/ui`, so `languages.test.js` reads `i18n/runtime.ts` and
compares them. That test exists because a locale added to the interface alone
fails silently in the worst way: the picker offers the language, the tag
resolves to English, and the reader pays for a walkthrough written in the wrong
one while the picker still names theirs. The default language adds no instruction at all, since the
system prompt is already English.

The language is part of the cache key. Without that, asking for a translation
would be answered with the untranslated entry that was already there; with it,
switching language and back returns the earlier walkthrough for free, exactly as
switching models does.

The read follows the same rule: `GET` builds the cache key for the language and
model being asked for and answers from that entry when it exists, before
consulting the pointer. The pointer alone was not enough — it records what was
generated here *last*, which after a switch is the answer to a different
question, and the panel kept showing the English review while the picker said
Ukrainian and the Ukrainian one sat unused in the cache. The key is computed
from the diff the read already parsed, so this costs one file read and no extra
git work.

Falling back to the pointer still happens when nothing exists in the requested
language: an English review beats an empty panel, and the response says which
language it is in so the panel can say so too — it shows a banner naming what is
on screen versus what was asked for, and only once a read has settled, because
claiming something is missing while still looking for it is the same flicker in
another place. Serving an entry makes it the last
one shown here, so the pointer follows it — otherwise a regeneration would
re-author from a walkthrough the reader is not looking at.

Attaching to a running job still ignores the language of the second request,
because the job already has one. That matches how the model behaves.

## Structured output, and what happens when it is refused

`structured_output: false` in the catalog blocks generation up front. A
**missing** capability field does not block — the catalog omits it for roughly
half of all models, and treating unknown as unsupported would hide models that
work.

Providers that do not declare the capability sometimes reject the schema at
request time (a plain `400`, or Alibaba/Qwen's "'messages' must contain the word
'json'"). A rejected request shape is not a dead end, so a `4xx` on a schema
request that OpenCode reports as `invalid_request` triggers exactly one retry
with the schema moved into the prompt and the tolerant parser handling the
result. Only if *that* fails to yield usable JSON is
`structured-output-unsupported` reported — at which point it is a real capability
problem the user can fix by switching model.

Once the fallback yields a walkthrough, the refusal is remembered per `provider/model`
and the fallback goes first from then on. Without that, every generation on such
a provider pays for a call whose failure is already known. A rate limit, a
rejected login or a content filter says nothing about the schema: it fails at
once and is not remembered, and neither is a request refused with and without
the schema. The memory is process-lifetime only on purpose:
a provider that gains structured-output support should not need a settings
change to be tried again, and one wasted first attempt after a restart is cheap.

The system prompt states "respond with a single JSON object" explicitly, which
also satisfies the providers that scan the request for the word `json` before
honouring `response_format`. That keeps them on the fast path instead of paying
for a wasted first call.

## Output budget

A walkthrough itself is only a few thousand tokens of JSON. The budget exists
for what comes before it: reasoning models spend the same allowance thinking and
return nothing when it runs out, which is a bill for no answer.

The ask is therefore derived from the resolved model rather than fixed:
`min(96k, max(24k, a quarter of the context))`, then capped by the catalog's
`limit.output`. A flat 24k was the same number for a 64k-context model and for
one that admits to 384k output tokens and a million of context — and on the
latter it was the only reason generation failed.

The bounds are not arbitrary. The **same number is reserved from the input
allowance**, so the ceiling and the context share are what stop a generous
answer budget from eating the diff it is supposed to describe; the 24k floor is
what this feature always asked for, so no model gets less room than before. A
model whose own `limit.output` is below the floor gets its limit, because asking
for more than a provider allows is rejected by some and ignored by others.

`describeSmallModel` decides this once — the walkthrough hands it the rule as a
function and reads back `outputTokens` — so the reserve and the request cannot
drift apart.

When a model exhausts even that, `code: 'output-exhausted'` reports it as what
it is: this model cannot finish this job, so pick another or review a narrower
scope.

## Caching and staleness

**Cache entries** (`entries/<sha256>.json`) are immutable and content-addressed.
The key covers walkthrough version, prompt version, repo root, source, provider,
model, output language, and every file's path/status/hunk-ids. PR keys also cover
the validated source-control provider, normalized instance, immutable account ID,
repository ID, binding revision, directory, trusted primary remote, and PR number.
A PR source may name a `revision` (a full commit SHA) on a provider that keeps
revisions (`capabilities.revisions`, Gerrit's patchsets); the source key becomes
`pr:<…>:<number>@<revision>`, so the job, cache entry and pointer of each
revision are separate, while a source without one keeps the key it always had.
The routes refuse a revision for any other provider with
`400 INVALID_SOURCE_CONTROL_READ_CONTEXT` before reading. The shared UI does
not name a revision yet, so its walkthroughs cover the current patchset. The key is computed from the
*current* diff, so a hit means the walkthrough was written about exactly this
code; there is no freshness question to ask of an entry, because staleness is a
miss. Returning the working tree to an earlier state therefore costs nothing.

**Pointers** (`pointers/<sha256(repoRoot + source)>.json`) are mutable and hold
`{ cacheKey, generatedAt, repoRoot, sourceKey }`. PR pointer keys and payloads
also contain the full validated read context. Scoped PR reads never consult old
unscoped pointer files or cache entries. Pointers answer what the cache
cannot: which walkthrough was last shown here, and has the code moved since. A
pointer whose entry has been evicted reads as "no walkthrough" — truthful, and
the next generation overwrites it.

A pointer is a *fallback*, not the primary lookup. A read that can name the
entry it wants — same diff, same model, same language — goes straight to it and
moves the pointer there; the pointer answers only when nothing matches the
request exactly.

Regeneration is manual and re-authors rather than merges: the previous
walkthrough goes into the prompt as prose so the model can keep what is still
true, with its anchors deliberately stripped so everything is re-anchored
against the current digest. Splicing partially-regenerated chapters into an old
narrative was considered and rejected — the seams produce stops that contradict
each other, and the failure is invisible.

The previous narrative goes only to the same model writing in the same
language. A review asked of another model or in another language is a fresh
one: handing it the last entry, under a prompt that says the code has moved on,
got a near-copy of the first model's review back on an unchanged diff, which is
the opposite of the second opinion that switching models asks for.

## Hygiene

- Entries are bounded by count and total size (200 / 50 MB) and evicted
  least-recently-used after a write that crosses a limit. Nothing is dropped for
  being merely old: an entry costs kilobytes and stays reachable if the working
  tree ever returns to that state.
- Writes are tmp+rename; reads enforce a size limit and validate the version, so
  a corrupt file is a miss rather than a crash. A failed write costs a
  regeneration next time and never fails the request that already produced a
  good walkthrough.
- Pointers are never evicted by size. They are pruned only when their repository
  is **provably gone**, deferred off the request path, fully asynchronous, and
  capped.

That last point is deliberate rather than incidental. The desktop app hosts this
server inside the Electron main process, so a synchronous loop here would stall
IPC and the window rather than a single request — and the paths being checked
are user repositories, where a worktree on an unplugged drive or an unreachable
share can make one existence check hang for seconds. Only `ENOENT` deletes a
pointer: unreachable is not the same as gone, and a dead share must not cost the
user their walkthroughs. Housekeeping also starts deferred and unawaited: this
module is imported lazily, so work at module level would land on the first
walkthrough request.

## Coverage

The model is told it may leave mechanical changes out. Whatever it does not
anchor is computed as `uncoveredHunkIds` and rendered as a collapsed tail, so
the reader can always answer "have I seen everything that changed". No hunk
disappears from the view. A hunk belongs to exactly one stop: when the model
anchors the same code twice, the later anchor is dropped, because the stream
would otherwise render that code twice.

For each file it left out the model writes one `routine` note ("Translations
for the two new strings"), shown under that file in the tail, so the reader can
trust a left-out file without opening it. The normalizer keeps a note only for
a digest file a stop left at least partly uncovered, one per path. Generated
files never reach the model and carry none.

## Cost of reading

Opening the panel is a `GET` that runs the whole git pipeline, so it is kept as
cheap as the data allows:

- Untracked files come from `listUntrackedPaths` (a plain `ls-files`) rather
  than `getStatus`, which also computes ahead/behind, diff stats, and merge
  state — roughly 180ms of work for an answer this module discards.
- Their diffs go through `getUntrackedDiffs`, which resolves the repository once
  for the whole batch and bounds concurrency, instead of one `getDiff` per file
  each re-resolving the repository.
- Readiness is computed from the same diff as the walkthrough itself. It used to
  be its own endpoint that the client called in parallel, which meant every
  panel open ran the entire pipeline twice.

On a working tree of 80 files and 138 hunks this took a panel open from ~800ms
to ~340ms. Parsing and digest building are ~3ms of that; everything else is git.

## Generation outlives its request

A dropped connection and a deliberate cancel are indistinguishable at the
socket, so tying generation to the request lifetime meant an accidental refresh
threw away a minute of paid-for work. Instead:

- Jobs live in a module-level map keyed by repository + source. PR jobs add the
  validated provider, normalized instance, immutable account ID, repository ID,
  binding revision, directory, trusted primary remote, and PR number. A second
  `generate` for the same source **attaches to the running job** rather than
  starting a rival one — pressing the button again after a refresh costs
  nothing extra.
- Leaving the page detaches the client; the job finishes and writes its cache
  entry, so coming back finds the result waiting.
- `GET /api/walkthrough` reports `generating`, letting a returning client show
  progress instead of an empty panel, and the client re-attaches so the result
  lands somewhere.
- Stopping is an explicit `POST /api/walkthrough/cancel`. That is the only thing
  that aborts the model call.

The cost of this is that a job everyone abandoned keeps spending until it
finishes; the generation timeout bounds it.

That timeout is a hang guard, not a pace-setter, and it scales with the diff:
120s plus 1s per hunk, capped at 15 minutes. A fixed number made a three-hunk
edit and a 500-hunk pull request wait the same, which guarded nothing in the
small case and risked killing the big one just short of the finish line. It errs
long on purpose — losing a nearly-complete generation costs real money, while an
over-long deadline only holds a job slot. Note that the schema fallback can use
the deadline twice, once per attempt.

## Progress

A running job records a coarse stage: `collecting` (reading the diff, which for
a pull request is seconds of network), `asking`, `retrying` when a provider
rejects the schema and the prompt-side fallback runs, and `assembling`.

Only phases a person can wait on are named. Building the digest and reading the
cache take single-digit milliseconds; giving them rows would imply progress that
is not happening.

`retrying` exists for diagnostics but is **not shown**: from outside it is the
same wait on the same model, and naming our fallback only raises the question of
what it is. The client folds it into `asking`.

The client also paces the display, holding each step for a floor before
revealing the next and keeping the list on screen briefly after the work ends.
Assembling takes milliseconds, so without that the result replaces the list
before the final step is ever seen finishing — naming a step the user never
observes is worse than not naming it. The cost is well under a second at the end
of a wait measured in minutes.

`GET /api/walkthrough/progress` reads the job registry and nothing else — no git,
no network — so the client can poll it once a second. The full read must never
be used for this: it re-runs the whole git pipeline.

## Routes

- `GET /api/walkthrough?directory&source&model&language` — last walkthrough, the
  current hunk index, staleness, and `readiness`. Never generates. `language`
  matters here because readiness is measured against the prompt that would be
  sent, and the language instruction is part of it.
- `POST /api/walkthrough/generate` — `{ directory, source, force, model, language }`. Survives
  client disconnects; a concurrent call for the same source joins the running
  job.
- `GET /api/walkthrough/progress?directory&source` — the current stage, or
  `null`. Memory-only and safe to poll.
- `POST /api/walkthrough/cancel` — `{ directory, source }`; aborts a running
  generation.

Disconnect detection checks the response socket (`writableEnded`/`destroyed`),
never `req.destroyed`: the body parser consumes the request stream, so
`req.destroyed` is true for every healthy request afterwards, and a check on it
would silently swallow every response.

For a PR source, all four routes also require flat `provider`, `instance`,
`accountId`, `repositoryId`, `bindingRevision`, and `primaryRemote` fields in the
query or JSON body. They do not accept a nested context object. The source-control
binding service validates these immutable fields before walkthrough service,
cache, job, credential, repository-coordinate, or provider work. The server
accepts a validated context whose provider's descriptor has
`capabilities.changeRequestPatch` (GitHub, GitLab, Gitea and Gerrit today) and refuses any
other provider with `422 UNSUPPORTED_WALKTHROUGH_PROVIDER`. It resolves the exact bound
account and trusted primary remote, with no active-account or default-remote
fallback, and every successful PR response echoes the trusted `readContext`.
An exact-account `401` reconciles the account through the source-control binding
service before credential invalidation; `403` and network failures leave the
account and binding intact.

There is deliberately no delete route: regeneration covers the need, and an
endpoint nothing calls is a maintenance surface that rots untested.

Registered lazily from `feature-routes-runtime.js`. `/api/walkthrough` is in the
JSON body-parser allowlist in `core-routes.js`.

## A server that does not have these routes

An `/api/*` path no OpenChamber route claims reaches the OpenCode proxy, and
OpenCode answers any path it does not know with its embedded web UI — HTML, with
status **200**. So a client newer than the server it is connected to is not told
"no such route"; it is handed a web page. Parsing that as JSON is where
`Unexpected token '<', "<!doctype "...` came from, a message that names neither
the cause nor the remedy.

The client therefore checks the content type before parsing. A non-JSON answer
on 2xx or 404 becomes `server-unsupported`, which the panel renders as "this
server is older than the app, update it". A non-JSON **5xx** keeps its own
failure: a server that answered badly is not a server missing the feature, and
telling someone to upgrade would send them after the wrong thing.

## Runtime availability

Web, desktop, and hosted mobile reach these routes normally. VS Code serves Git
through its own bridge rather than the OpenChamber Git routes, so the feature is
not offered there; the surface is also gated to tablet width and above.

## TypeScript boundaries

Relative imports retain `.js` specifiers for converted implementations. Shared
read-context fields live in `contracts.ts`. JSON parsing establishes JSON values;
normalization establishes the complete `Walkthrough` shape. A cache read checks
only the version and the presence of a chapters array. Chapter contents, model
metadata and timestamps retain their JSON types. Pointer reads establish only a
string cache key. The compile-time contract test prevents these reads from
claiming the stronger normalized shape.

Source descriptors enter through `SourceRequest` with an unchecked source field.
Commit parsing validates the hash's string coercion before calling its own
`toLowerCase` method. That method's result remains unchecked in `WalkthroughSource`.
Git's `CommitDiffOptions` accepts that result because `resolveCommitHash` validates
`String(hash)` before constructing the Git argument. Boxed strings, custom
normalization results and symbol coercion failures retain their existing behavior.
The lowercase accessor is read once and invoked with the original hash receiver;
the function's own `call` property does not participate in invocation.

### Why cache consumers retain shallow validation

Generation results contain normalized walkthroughs, while cache hits retain their
JSON types. Anchor resolution narrows cached arrays where it uses them and preserves
the existing TypeErrors for malformed chapters, stops and hunk lists. Cache keys
serialize the small-model module's unchecked provider and model identifiers without
claiming they are strings. Pointer timestamps likewise retain their stored JSON
type. Optional read-context attachment mutates the original result before returning
it, so callers that discard the helper's return value still receive the context.

Read-context string and integer checks remain at the service boundary. Injected
pull-request readers retain their function check; untracked patches come from Git's
typed string array and no longer repeat a string check. Deferred pruning failures
remain ignored because housekeeping must not fail a walkthrough request.

### Why change request reads retain JSON results

The provider contract establishes JSON, not a patch or file result schema.
`pull-request.ts` uses that owner's exported `Json` type. File reads pass the
result through unchanged. Diff reads retain unchecked optional patch and
metadata fields. The `allowEmpty` path skips the patch text check, as before;
other reads preserve the existing trim failures and empty-diff error.
Both injected-reader `instanceof Function` checks remain at the JavaScript
runtime boundary.

Routes use the shared HTTP contracts and the source-control module's
`ProviderReadContext`. The lazy service contract retains the implementation's
inferred results. It does not strengthen unchecked service responses, source
descriptors or error fields. Optional revision and previous-path fields accept
explicit `undefined` because the routes supply those keys even when absent.

### Why route guards leave fields unchecked

Body, source and error guards establish only the object being accessed and, for
PR prevalidation, the `kind` discriminator. Arrays and functions retain their
property reads. Field checks remain where the original routes made them:
directory, model and language strings, provider/model schemas, repository owner,
revision and finite error budgets. Other source validation still belongs to
`parseSource`, after bound-context validation. Non-PR sources pass through
unchanged, and error logging retains the original thrown value, including
primitives.

### Why previous walkthroughs keep their JSON type

The prompt accepts the cache's shallowly checked JSON, including primitive chapter
and stop entries. Property reads preserve the existing primitive-to-undefined
behavior and text coercion. Null entries and truthy non-array stops retain their
existing TypeErrors and messages. Local checks establish only the array or object
being used; they neither claim normalized chapters nor discard malformed entries.
`WalkthroughSource` in `contracts.ts` describes the parsed source consumed by the
prompt. The source parser remains responsible for validating external input.

### Why external checks remain at typed boundaries

Diff text, language tags, model settings and stored JSON can arrive from
unconverted callers or files. Their existing string, object and array checks
remain in type guards. The settings reader exposes an inferred empty object, so
the local guard establishes only optional, unchecked model-setting fields before
the existing string checks run. Generated-file paths come from parsed diff files
and use their internal string type.

### Why language normalization keeps the own-property check

Language tags are external dictionary keys. `constructor` and `toString` must
normalize to English, while direct `languageName` calls retain the original
property-lookup behavior. Internally, `languageName` accepts the supported tag
union returned by normalization. The regression test covers both lookup paths.

### Why parser state is excluded by copying the completed file

The temporary hunk-digest map exists throughout file parsing. Copying the
completed file without that field preserves the returned keys and their order
while keeping the parser state's required map type. Required regex captures use
empty-string fallbacks only where the matching expression guarantees a capture.

### Why digest omission uses separate path and flag fields

The model digest omits absent paths and flags. Separate fields preserve both
omission and the original JSON property order when the digest is serialized into
the prompt.
