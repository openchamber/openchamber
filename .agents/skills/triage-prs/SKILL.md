---
name: triage-prs
description: Load when asked to triage, clean up, batch-process, or work through the open PR queue or backlog — covers the mechanical sweep (stale, conflicts, duplicates), fan-out verdict reviews, and approved batch actions.
---

Turn an unbounded PR queue into a short list of maintainer decisions. The pipeline has three phases; **no GitHub write happens in any phase without the maintainer approving that specific batch** — present verdicts and drafted messages first, act on their word.

Companion: each substantive review inside phase 3 applies the `pr-review` skill; this skill owns only the batch mechanics around it.

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

Split the clean pool smallest-first (tiny diffs are fast wins and most likely mergeable). Fan out subagents in batches of ~10 PRs each; every subagent receives the full `pr-review` skill text as its instructions plus its PR numbers, reads real diffs (`gh pr view`, `gh pr diff`) and the local checkout, and returns per-PR verdict blocks in the skill's output format.

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
