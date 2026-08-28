---
name: triage-issues
description: Load when asked to triage, clean up, batch-process, or work through the issue backlog — covers the mechanical sweep (stale-fixed, dead needs-info, duplicates), fan-out assessment, and approved batch actions.
---

Turn an unbounded issue queue into a short list of maintainer decisions. Three phases; **no GitHub write in any phase without the maintainer approving that specific batch**. Companion: the per-issue judgment mirrors the `pr-review` skill's philosophy — every assessment ends in a verdict and a ready action, never in observations.

## Verdicts

- **FIX-READY** — a real bug with a traced mechanism (`root-cause:found` from intake, or traced during this sweep). Ready action: a one-line fix-backlog entry (file:line, mechanism, suggested fix shape) — these accumulate into the sweep's fix list for agents to implement.
- **NEEDS-REPORTER** — cannot proceed without the reporter. Ready action: the single unanswerable question, posted once; the issue then lives on a clock (close as stale after ~30 days of silence).
- **CLOSE-FIXED** — behavior fixed by a merged change. Ready action: close comment naming the commit/PR and the release that carries it.
- **CLOSE-DUPLICATE** — same failure as an existing issue. Keep the issue with the better evidence, close the other naming it.
- **CLOSE-DECLINE** — a feature or behavior the product should not take (the `pr-review` skill's whim/scope grounds apply). Ready action: honest close comment; where a real ache underlies it, salvage per the pr-review skill's rule.
- **FEATURE-DECISION** — a plausible feature only the maintainer can judge. Ready action: the product question in one line plus drafted comments for both answers. These go to the maintainer as a numbered list, like the PR triage's Product fit block. The maintainer's answer resolves the issue's fate mechanically:
  - **"так" (wanted)** → post the acceptance comment (what was approved and, when known, the welcome implementation shape), add the `accepted` label, and leave it open. `accepted` marks the decision as made — later sweeps never re-ask an `accepted` issue, and `label:accepted` is the implementation roadmap for agents and contributors.
  - **"ні" (declined)** → post the drafted decline comment (with ache salvage where one underlies it) and close as not planned.
  - A conditional answer ("так, але тільки як настройка", "ні в такому вигляді, але X — так") is folded into the posted comment verbatim in spirit — the maintainer's condition becomes the recorded scope.

## Phase 1 — Mechanical sweep

Fetch all open issues with `gh issue list --limit` above the real count. Bucket cheaply before any deep reading:

| Bucket | Signal | Likely verdict |
|---|---|---|
| Stale-fixed | references code/behavior changed by merged PRs; CHANGELOG `[Unreleased]`/recent releases mention the symptom | CLOSE-FIXED (verify per *Silently-fixed detection*) |
| Dead needs-info | `needs-info` with no reporter reply > 30 days | close as stale |
| Duplicate clusters | title/error-string similarity across open issues | CLOSE-DUPLICATE |
| Feature wishes | `enhancement` | FEATURE-DECISION or CLOSE-DECLINE |
| Traced bugs | `root-cause:found` | FIX-READY candidates, verify the trace still applies |

### Silently-fixed detection

Many fixes land without linking the issue they resolve, so an issue can sit open with a perfectly valid-looking repro that describes code which no longer exists. A fresh-looking issue is not proof of a live bug — probe in this order, strongest evidence first:

1. **Mechanism anchor.** For issues carrying `root-cause:found` (or any comment citing `file:line`), check whether the cited code changed since the issue's date: `git log -L<line>,<line>:<file> --since=<issue date>` (fall back to `git log --since -- <file>` when lines drifted). Untouched code → the bug is live. Changed code → re-read the mechanism on current main; if it is gone, this is CLOSE-FIXED with the commit as evidence.
2. **Repro re-run.** When the intake comment carries an inline reproduction script or test, run it against current main. Passing repro = fixed, with the run as evidence.
3. **Symptom search.** Extract the issue's distinctive strings (error messages, function names, user-visible symptom terms) and search `git log --grep`, `CHANGELOG.md`, and merged PR titles/bodies *since the issue's creation date*.

CLOSE-FIXED always names its evidence (commit, PR, or repro run); a hunch that "this area was reworked" downgrades to a comment asking the reporter to retry on current main, keeping the issue open on the needs-reporter clock.

Every issue/PR reference in maintainer-facing reports is a clickable link (`[#3164](https://github.com/openchamber/openchamber/issues/3164)`), never a bare number; each entry carries 2–4 sentences — enough to decide without a follow-up question — and any manual-check note lives inside the entry, never in a separate number-repeating section. An issue where the maintainer already commented or the reporter replied to a question runs in pickup mode: state the thread first, continue it, never re-ask a decided question.

Weigh trusted community reviewers' comments (see the `triage-prs` skill's rule — same names, same weight) and the intake bot's "For the maintainer" lines as strong signals. Deliver the sweep as one report and stop for approval.

## Phase 2 — Approved batch actions

Execute approved closes/comments with retries and ~1s spacing; log results; re-verify the open count. Closes use `--reason "completed"` for fixed and `--reason "not planned"` for declines/duplicates/stale.

## Phase 3 — Assessment fan-out

For the surviving pool, fan out subagents (~15 issues each) that read the issue, its comments, and the relevant code, and return per-issue verdict blocks. Consolidate grouped by verdict, FEATURE-DECISION questions in a numbered block for the maintainer, FIX-READY entries as an ordered fix backlog. Stop for approval; then act, and hand the approved fix backlog to implementation agents in dependency-safe batches.

## Message templates

**stale-close (dead needs-info)**
> Closing as stale: the requested details never arrived, and without them this can't be reproduced. If you hit it again on a current version, a fresh report with the missing details is welcome.

**fixed-close**
> This was fixed by [ref] and ships in [release/next release]. Closing — if the problem persists there, comment and it will be reopened.

**duplicate-close**
> Closing as a duplicate of #[N], which tracks the same failure[: one clause on what this report added, if anything]. Follow that issue for updates.

**decline-close**
> Thanks — closing this one: [honest one-sentence reason grounded in product direction or maintenance cost]. [If a real ache underlies it: the welcome shape of a future change.]
