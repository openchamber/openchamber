---
name: triage-prs
description: Load when asked to triage, clean up, batch-process, or work through the open PR queue or backlog — covers the mechanical sweep (stale, conflicts, duplicates), fan-out verdict reviews, and approved batch actions.
---

Turn an unbounded PR queue into a short list of maintainer decisions. The pipeline has three phases; **no GitHub write happens in any phase without the maintainer approving that specific batch** — present verdicts and drafted messages first, act on their word.

Companion: each substantive review inside phase 3 applies the `pr-review` skill; this skill owns only the batch mechanics around it.

**The timeline outranks the snapshot.** Before any verdict or comment on a PR, read its existing comments: a prior maintainer verdict (a push-back list, a recorded product decision like a placement or scope call) is BINDING — a new sweep verifies whether it was addressed at the current HEAD and says so explicitly ("all three prior items resolved" / "item 2 still open"), never re-decides it or asks the maintainer the same product question again. And never post the generic rebase-request on a PR that already carries a substantive review comment — the author already has their instructions; a bare "please rebase" on top reads as the left hand not knowing the right.

**Pickup mode.** A PR with human activity beyond the bot — a maintainer comment, an author reply, a trusted-reviewer thread — is a conversation in progress, not a fresh review target. Such PRs go into their own report bucket ("Розмова триває"), and each entry opens with the thread state: what the maintainer asked, what the author answered, which points are resolved at the current HEAD and which remain. The ready action *continues* the thread (a reply, a verdict on the author's answer, a merge if everything asked for was delivered) — it never restarts review from scratch. The maintainer may not remember their own comment from days ago; the sweep remembers for them.

## Phase 1 — Mechanical sweep (no judgment, no LLM verdicts)

Fetch all open PRs with `gh` (the repo is `openchamber/openchamber`). Two measurement rules learned the hard way:

- **Staleness is the last commit date on the branch, never `updatedAt`** — bots bump `updatedAt` with every comment and label. Fetch last-commit dates with batched GraphQL (`commits(last: 1)`), ~50 PRs per query.
- `gh pr list` silently defaults to 30 rows — always pass `--limit` above the real queue size and print the resulting count.

Bucket every non-draft PR:

| Bucket | Condition | Action template |
|---|---|---|
| Dead | merge conflict AND no author commit in >30 days | close with **stale-close** |
| Conflicted-active | merge conflict, author committed within 30 days | comment **rebase-request**, leave open |
| Clean | mergeable | phase 3 review pool |
| Draft | `isDraft` | untouched until marked ready |

Then detect **duplicate clusters** across the survivors: pairs with high title-token overlap or high changed-file overlap. For each cluster recommend one keeper (prefer: mergeable over conflicted, references an issue, smaller diff, earlier author — a later near-identical body is likely a regenerated copy of the earlier PR, and the earlier author keeps the credit); the rest close with **duplicate-close**.

Deliver the sweep as one report (counts per bucket, per-bucket tables with number/title/author/size/last-commit-age/areas, clusters with keeper recommendations) and stop for approval.

## Phase 2 — Approved batch actions

Execute the approved closes/comments with retries and ~1–2s spacing between calls. Log every result; report exact ok/fail counts and re-verify the open-PR total afterwards. Branch protection may reject merges — `--admin` is available and accepted for maintainer-approved merges; a merge that becomes conflicted mid-batch (usually CHANGELOG collisions from the batch's own merges) can be resolved in a temporary worktree and pushed to the contributor's branch when `maintainerCanModify` is true.

## Phase 3 — Verdict reviews

**Trusted community reviewers.** `yulia-ivashko` is a core maintainer with merge rights — her review decisions carry maintainer weight (a PR she approved or merged needs no re-verdict; her open questions are the maintainer's questions). Comments and reviews from `patrick-motard` and `mattv8` are strong human signals: during any sweep, collect the PRs/issues they weighed in on, read their assessment, and carry it into the verdict — an approval from them upgrades confidence like a passing verifier; a concern from them is a finding to verify, never to ignore. They write free-form; map their conclusion onto the verdict ladder rather than expecting the format.

The review bot's `review:*` labels are a pre-sort, not a verdict: `review:ready` PRs go first (the bot found no code defects — likely MERGE/MERGE-THEN-FIX), `review:blocked` ones carry a bot comment whose findings the verdict review verifies rather than rediscovers. Bot labels never replace the pr-review pass — the bot cannot judge product fit or maintainability scope.

Split the clean pool smallest-first (tiny diffs are fast wins and most likely mergeable). Fan out subagents in batches of ~10 PRs each; every subagent receives the full `pr-review` skill text as its instructions plus its PR numbers, reads real diffs (`gh pr view`, `gh pr diff`) and the local checkout, and returns per-PR verdict blocks in the skill's output format.

**Report format.** The consolidated report is what the maintainer decides from — calibrate each entry so no follow-up question is needed, without ballooning:

- Every PR/issue reference is a clickable link: `[#3177](https://github.com/openchamber/openchamber/pull/3177)` (issues: `/issues/N`) — never a bare number.
- One entry per PR, 2–4 sentences: what it does for the user, whether the problem is real, why this verdict, the main risk or the thing the decision turns on. "Closes #N" links included.
- A "needs your hands" line appears only when the check gates the merge (per the pr-review skill), and lives INSIDE the PR's own entry as its final line — never as a separate section repeating the numbers. A plain MERGE entry carries no checklist.
- Thread-state line first for pickup-mode entries.
- A one-line entry ("точковий фікс") is fine only for genuinely trivial diffs; a verdict the maintainer must weigh (product calls, larger features) gets the full 4 sentences.

Consolidate into a single report grouped by verdict — MERGE, MERGE-THEN-FIX, PUSH-BACK (with the drafted lists), DECLINE (with the drafted close comments), plus every "needs your hands" line — and stop for approval. After approval: post/merge per verdict, and queue MERGE-THEN-FIX follow-ups as in-house work.

If a batch subagent skips a PR, notice (count outputs against inputs) and re-dispatch the gap.

## Message templates

Canonical texts — reuse verbatim, adjusting only bracketed parts. Tone rules: honest about the backlog, no "feel free to reopen", thanks proportional to real effort.

**stale-close**
> Closing this as stale: the branch has merge conflicts with `main` and hasn't been updated in over a month. The codebase has moved on significantly since this was opened, so this change would need to be redone against the current state anyway.

**rebase-request**
> Sorry for the review backlog — the queue is currently far beyond what a single maintainer can handle. This PR has merge conflicts with `main`, and I can only review PRs that merge cleanly. If you're still interested in landing this, please rebase — conflicted PRs without activity will eventually be closed as stale.

**duplicate-close**
> Closing as a duplicate of #[N], which will be reviewed instead[: one-clause reason it was kept].

**oversized-split** (single PR bundling several concerns)
> Closing this one. It bundles several unrelated concerns — [list] — into a single [size] change across [n] files, which isn't reviewable in this form. If you'd like to pursue [the worthwhile part], please open an issue first to agree on scope, and then a focused PR for that single concern.

**russian-locale** (any PR adding Russian localization — this is a standing decision, apply without re-asking)
> We’re not accepting Russian localization for OpenChamber.
>
> This is an intentional maintainership decision due to Russia’s ongoing war against Ukraine. We don’t want to ship or maintain Russian UI support.
>
> Closing.
