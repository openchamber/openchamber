# Walkthrough

Generates a guided, ordered reading path through a diff: the small model groups
related hunks into stops and chapters and explains each group, and the UI
renders those stops interleaved with the code they describe.

Generation is **always user-initiated**. Nothing here runs on a timer, on a file
change, or as a side effect of opening a panel — it spends tokens, so a person
has to ask for it.

## Files

- `hunks.js` — parses a unified diff into files and hunks and assigns each hunk
  a stable id.
- `generated.js` — recognises tool-produced files that are kept out of the
  model's input.
- `sources.js` — turns a source descriptor into diff *sections*.
- `digest.js` — builds the model-facing digest and the alias↔id mapping.
- `prompt.js` — system prompt, size guidance, previous-walkthrough section, and
  `PROMPT_VERSION`.
- `schema.js` — response schema, response normalization, tolerant JSON parsing.
- `store.js` — content-addressed cache entries plus mutable pointers.
- `pull-request.js` — PR diffs via the shared GitHub octokit helper.
- `model-settings.js` — the feature's own model override.
- `languages.js` — the languages the prose may be written in.
- `index.js` — orchestration.
- `routes.js` — `/api/walkthrough*`.

## Hunk identity

`hunks.js` is the only place that decides what a hunk is or what its id is. The
client never recomputes ids; it receives the current hunk index (id → patch)
alongside the walkthrough and matches ids to ids. Two implementations of the
same hash would have to agree byte-for-byte forever, and the first one to drift
would silently mis-anchor every stop.

An id is `<scope>:<path>:<sha1(header + body)[:8]>`, with a `-2`, `-3`, … suffix
for byte-identical hunks repeated inside one file.

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
| `branch` | `branch` | `getRangeDiff` uses three-dot `base...head`, so work merged in from the base branch is excluded |
| `pr` | `pr:<number>` | GitHub returns the merge-base diff, matching the branch semantics |

The panel offers the current branch's pull request on its own: it registers with
the shared GitHub PR status store (`useGitHubPrStatusStore`) rather than waiting
for the pull request panel to have been visited. That store already dedupes
concurrent requests by signature and throttles by TTL, so several panels asking
the same question produce one call to GitHub.

## No truncation

Within what it covers, the digest is complete. When it does not fit the resolved
model's context, generation is **refused** (`409`, `code: 'context-too-small'`)
so the user can pick a roomier model. A walkthrough written against a silently
clipped diff is confidently wrong in a way no reader can detect, which is worse
than no walkthrough.

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

The picker hides models the catalog reports as `structured_output: false` —
offering them would move the same refusal one click later — and, like the small
model picker, only shows providers with a usable login. The in-panel picker on a
blocked walkthrough writes this setting too, so recovering from a refusal never
silently changes the model behind commit messages.

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
silently. The prompt says so explicitly.

`languages.js` owns the accepted tags; they match the UI's `Locale` union, and
anything else — unknown, malformed, absent — resolves to English rather than
failing the request. The two lists cannot be one, because the server cannot
import from `packages/ui`, so `languages.test.js` reads `i18n/runtime.ts` and
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
request triggers exactly one retry with the schema moved into the prompt and the
tolerant parser handling the result. Only if *that* fails to yield usable JSON is
`structured-output-unsupported` reported — at which point it is a real capability
problem the user can fix by switching model.

The refusal is then remembered per `provider/model` and the fallback goes first
from then on. Without that, every generation on such a provider pays for a call
whose failure is already known. The memory is process-lifetime only on purpose:
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
model, output language, and every file's path/status/hunk-ids. The key is computed from the
*current* diff, so a hit means the walkthrough was written about exactly this
code; there is no freshness question to ask of an entry, because staleness is a
miss. Returning the working tree to an earlier state therefore costs nothing.

**Pointers** (`pointers/<sha256(repoRoot + source)>.json`) are mutable and hold
`{ cacheKey, generatedAt, repoRoot, sourceKey }`. They answer what the cache
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

## Hygiene

- Entries are bounded by count and total size (200 / 50 MB) and evicted
  least-recently-used after a write that crosses a limit. Nothing is dropped for
  being merely old: an entry costs kilobytes and stays reachable if the working
  tree ever returns to that state.
- Writes are tmp+rename; reads enforce a size limit and validate the version, so
  a corrupt file is a miss rather than a crash.
- Pointers are never evicted by size. They are pruned only when their repository
  is **provably gone**, deferred off the request path, fully asynchronous, and
  capped.

That last point is deliberate rather than incidental. The desktop app hosts this
server inside the Electron main process, so a synchronous loop here would stall
IPC and the window rather than a single request — and the paths being checked
are user repositories, where a worktree on an unplugged drive or an unreachable
share can make one existence check hang for seconds. Only `ENOENT` deletes a
pointer: unreachable is not the same as gone, and a dead share must not cost the
user their walkthroughs.

## Coverage

The model is told it may leave mechanical changes out. Whatever it does not
anchor is computed as `uncoveredHunkIds` and rendered as a collapsed tail, so
the reader can always answer "have I seen everything that changed". No hunk
disappears from the view.

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

- Jobs live in a module-level map keyed by repository + source. A second
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

There is deliberately no delete route: regeneration covers the need, and an
endpoint nothing calls is a maintenance surface that rots untested.

Registered lazily from `feature-routes-runtime.js`. `/api/walkthrough` is in the
JSON body-parser allowlist in `core-routes.js`.

## Runtime availability

Web, desktop, and hosted mobile reach these routes normally. VS Code serves Git
through its own bridge rather than the OpenChamber Git routes, so the feature is
not offered there; the surface is also gated to tablet width and above.
