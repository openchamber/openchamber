---
name: triage-prs
description: Load when asked to triage, clean up, batch-process, or work through the open PR queue or backlog — covers the mechanical sweep (stale, conflicts, duplicates), fan-out verdict reviews, and approved batch actions.
---

Turn an unbounded PR queue into a short list of maintainer decisions. The pipeline has three phases; **no GitHub write happens in any phase without the maintainer approving that specific batch** — present verdicts and drafted messages first, act on their word.

Companion: each substantive review inside phase 3 applies the `pr-review` skill; this skill owns only the batch mechanics around it.

Two saved workflows run the heavy parts (`.openchamber/workflows/`): `pr-triage-review` does the phase 1 sweep, the phase 3 reviews and the report; `pr-triage-finish` fixes, reviews and amends the PRs we land ourselves, up to a ready commit per PR, and never pushes. Their agents' models are `args.models`; agree them with the maintainer before the run. GitHub writes and merges stay with the orchestrating session.

**The timeline outranks the snapshot.** Before any verdict or comment on a PR, read its issue comments, reviews (`gh pr view --json comments,reviews` or `gh api repos/{owner}/{repo}/pulls/N/reviews`; a maintainer's *Changes requested* is a review and never appears in the comments list), and commits since the last human event. Never post the generic rebase-request on a PR that already carries a substantive review comment; the author already has their instructions.

**Pickup mode.** PRs with human activity beyond the bot go into their own bucket ("Розмова триває"); each entry runs in pickup mode (`pr-review`, *Process* step 1).

## Phase 1 — Mechanical sweep (no judgment, no LLM verdicts)

Fetch all open PRs with `gh` (the repo is `openchamber/openchamber`):

- **Staleness is the last commit date on the branch, never `updatedAt`** — bots bump `updatedAt` with every comment and label. Fetch last-commit dates with batched GraphQL (`commits(last: 1)`), ~50 PRs per query.
- `gh pr list` silently defaults to 30 rows — always pass `--limit` above the real queue size and print the resulting count.

Bucket every non-draft PR:

| Bucket | Condition | Action template |
|---|---|---|
| Dead | merge conflict AND no author commit in >30 days | close with **stale-close** |
| Conflicted-active | merge conflict, author committed within 30 days | phase 3 review pool; a PR worth taking we rebase and finish ourselves (see *Landing a PR ourselves*). **rebase-request** only when the author has something to decide, or `maintainerCanModify` is false |
| Waiting on author | the last substantive event is a request for changes — a maintainer review with `CHANGES_REQUESTED`, a maintainer push-back comment, or a bot `review:blocked` / `review:needs-evidence` — and the author has neither pushed nor replied since | one line in the report ("чекає автора: <what was asked>"); no re-review, no new comment — the ball is theirs |
| Clean | mergeable and not waiting on the author | phase 3 review pool |
| Draft | `isDraft` | untouched while the author committed within 14 days, and always for the team's own drafts (`btriapitsyn`, `yulia-ivashko`, `deatheros`, `AlexKutas`); otherwise close with **stale-draft** |

Those four authors' PRs are the team bucket and skip review: they land through the team's own process. `IbrahimKhan12` is reviewed like anyone else, but fixes left on his PRs, as on any team member's, are ours to finish, never a push-back list.

Then detect **duplicate clusters** across the survivors: pairs with high title-token overlap or high changed-file overlap. For each cluster recommend one keeper (prefer: mergeable over conflicted, references an issue, smaller diff, earlier author — a later near-identical body is likely a regenerated copy of the earlier PR, and the earlier author keeps the credit); the rest close with **duplicate-close**.

Deliver the sweep as one report (counts per bucket, per-bucket tables with number/title/author/size/last-commit-age/areas, clusters with keeper recommendations) and stop for approval.

## Phase 2 — Approved batch actions

Execute the approved closes/comments with retries and ~1–2s spacing between calls. Log every result; report exact ok/fail counts and re-verify the open-PR total afterwards. Branch protection may reject merges — `--admin` is available and accepted for maintainer-approved merges; a merge that becomes conflicted mid-batch, usually because two PRs touch the same file, can be resolved in a temporary worktree and pushed to the contributor's branch when `maintainerCanModify` is true.

## Phase 3 — Verdict reviews

**Trusted community reviewers.** `yulia-ivashko` is a core maintainer with merge rights — her review decisions carry maintainer weight (a PR she approved or merged needs no re-verdict; her open questions are the maintainer's questions). Comments and reviews from `patrick-motard` and `mattv8` are strong human signals: during any sweep, collect the PRs/issues they weighed in on, read their assessment, and carry it into the verdict — an approval from them upgrades confidence like a passing verifier; a concern from them is a finding to verify, never to ignore. They write free-form; map their conclusion onto the verdict ladder rather than expecting the format.

PRs closed by the contribution gate (label `needs-accepted-issue`, `.github/scripts/pr-checks.cjs`) are not in the queue: they reopen on their own once they link a bug report or an accepted feature request. PRs labeled `evidence-in-branch` or `needs-visual-evidence` are *waiting on author*, one line each in the report; the label comes off on its own once fixed, and removing it by hand waives the check for that PR. The retired `needs-discussion` label from the earlier parking rule is size information only; such a PR is an ordinary review pool entry.

The review bot's `review:*` labels are a pre-sort, not a verdict: `review:ready` PRs go first (the bot found no code defects — likely MERGE/MERGE-THEN-FIX), `review:blocked` ones carry a bot comment whose findings the verdict review verifies rather than rediscovers. Bot labels never replace the pr-review pass — the bot cannot judge product fit or maintainability scope.

Split the clean pool smallest-first (tiny diffs are fast wins and most likely mergeable). Fan out the `review-pr` subagent (`.opencode/agent/review-pr.md`, which loads the `pr-review` skill and carries the hard rules). It takes one PR or several per call — group related PRs together when one context can serve them, give a large or contentious PR its own call; fall back to a general subagent that receives the full `pr-review` skill text when `review-pr` is unavailable. Never hand verdicts to a smaller model to save quota — a verdict from a small model is a pre-sort, not a decision. Each returns per-PR verdict blocks in the skill's output format.

**Brief reviewers neutral or skeptical.** A brief that asks them to prefer landing PRs makes them read past what a merge would cost. Every review brief points the reviewer at *Standing decisions* below: a PR that contradicts one is decided by it, without asking the maintainer again.

**Skeptical scope pass.** Every PR headed for MERGE or MERGE-THEN-FIX gets a second pass after the correctness review, because a clean fix can carry a cost the correctness review does not look for. It answers four questions, each with file evidence or "none":

- **Hidden product decision**: does the fix also change what users see or how something behaves beyond the reported symptom (a row that renders differently, a default, a gesture)? Then the verdict carries a product question, per `pr-review`.
- **Coupling**: does core now read a third-party plugin's private format, a tool's output shape, or one user's setup? That coupling breaks when the third party changes, and the bug reports land on us.
- **Proportion**: are the size and the new concepts (settings, stores, abstractions) in proportion to the problem?
- **Slop**: duplicated helpers, defensive noise, tests that only mirror mocks, doc bloat, or claims in the PR body the code does not back.

A yes on any of them moves the verdict or lands on the action list; it never stays a remark.

**Report format.** The consolidated report is what the maintainer decides from — calibrate each entry so no follow-up question is needed, without ballooning:

- One entry per PR, one or two plain sentences: what changes for the user, and the thing the decision turns on (the risk, the product question, why it closes). "Closes #N" links included.
- A "needs your hands" line appears only when the check gates the merge (per the pr-review skill), and lives INSIDE the PR's own entry as its final line — never as a separate section repeating the numbers. A plain MERGE entry carries no checklist.
- Thread-state line first for pickup-mode entries.
- A genuinely trivial diff gets a few words ("точковий фікс").

Consolidate into a single report grouped by verdict — MERGE, MERGE-THEN-FIX, PUSH-BACK (with the drafted lists), DECLINE (with the drafted close comments), plus every "needs your hands" line — and stop for approval. **Each entry carries the subagent's Ready action verbatim** — the comment or follow-up list exactly as it will be posted or executed, in a quote block under the entry. The consolidation summarizes the reasoning, never the artifact: a paraphrased push-back item loses the file, the cause, and the "done means" the subagent already found, and the maintainer approves what they can read, not a description of it. After approval: post/merge per verdict, and queue MERGE-THEN-FIX follow-ups as in-house work the same day.

If a batch subagent skips a PR, notice (count outputs against inputs) and re-dispatch the gap.

A PR whose verdict needs more than a review — deep investigation of a core path, a rework against code `main` has rewritten, or a live check — can go to its own session with the PR linked to it. Keep it the exception: most PRs, including fix-then-merge ones, are finished inside the triage session.

### Landing a PR ourselves

The default for a PR we want is fix-then-merge in the author's branch, with the author keeping the credit. `scripts/prep.sh <N>` puts the whole PR on current `main` as one staged change in a throwaway worktree (conflicts resolved once, not per commit); after fixing and validating there, `scripts/finish.sh <N> "<subject>" "<comment>" ["Closes #M"]` commits as the author (or amends the commit a fix agent made), rebases it onto a fresh `origin/main`, pushes to their branch, posts the comment and squash-merges. Run finish.sh one PR at a time, right before each merge, so every push sits on the `main` the previous merge left. A rebase conflict makes it exit 2 with nothing pushed; the PR goes back to a fix agent and is validated again before the next try. The push holds a lease on the author's head as prep.sh fetched it, so an author push since then makes it exit 3 instead of overwriting their work; read their new commits and prepare the PR again. prep.sh in turn refuses to reset a worktree holding uncommitted changes or an unpushed landing commit unless `TRIAGE_DISCARD=1` says to drop them. The `pr-triage-finish` result lists only READY PRs as ready for finish.sh; REVIEW_FAILED means the commit never had its second look.

**Fix agents.** When several PRs are fixed at once (the `pr-triage-finish` workflow, or agents you dispatch), each agent:

- works only in its own worktree, `TRIAGE_WT=/tmp/triage/wt-<N> TRIAGE_STATE=/tmp/triage/st-<N> scripts/prep.sh <N>`, and runs every command there. The maintainer's checkout and other agents' worktrees stay untouched, because sessions share the machine and a stray edit lands in someone else's work.
- starts no OpenChamber, dev server, Electron or browser. A second OpenChamber over `~/.config/openchamber` marks the desktop app's live workflow runs as stopped, and servers next to parallel test runs freeze the laptop.
- validates with the test files for the code it touched and `bun run type-check`, until both are green, then `bun run check:changed` once before its final commit. Full suites belong to the coordinator after the merge batch.
- starts no subagents: workflow agents are already one level deep, and review is the workflow's next step.
- commits one commit as the PR author and returns READY with notes for the checks it could not run (a live scenario, a device). BLOCKED is for what stops the work itself: a conflict it cannot resolve without a product decision, a brief that contradicts the code, a PR that is not on `main`'s path anymore.

Hold build-heavy agents to about 3 at a time on a laptop with a limiter in the script, so a slot frees as soon as one PR finishes; fixed batches wait on their slowest PR. A live check runs only when the maintainer asks for one, with an isolated `OPENCHAMBER_DATA_DIR`, isolated OpenCode data and ports of its own.

- **Take the essence.** When `main` has moved under a PR, or the PR bundles extras, land the part that fixes the problem and leave the rest: the 6-line fix out of 250 lines of instrumentation, the concurrency cap without the profiler scenario, the bug fix without the limit bump. A PR that mixes a fix with a change to how the app looks lands the fix; the look goes to the maintainer as a decision. The comment to the author names what was left out and why.
- **A dropped concern is checked in the whole diff.** Conflict hunks are not the whole PR: auto-merged hunks of a concern you decided to leave out still land. Before finishing, grep the staged diff for that concern by its own terms.
- **Review findings on the branch are verified, not obeyed.** Read every unresolved bot and reviewer comment against the current head: one a later push fixed or made moot is done, the rest stand however old they are. Answer each finding the way `openchamber-change-discipline` (*Answering Review Findings*) says, and a finding you decline gets a written reason in the PR, so the next reader does not raise it again.
- **A red check is read before it is believed.** Find which check failed: the review bot's `automation` job failing means the bot did not run, and a test that fails on the PR but passes on current `main` is a stale run, not the PR.
- **Renovate PRs that touch the same file conflict with each other once one lands.** Merge them one at a time; for the rest tick the rebase checkbox in the PR body (`gh pr edit --body-file`) and come back.

### Decision rounds through the question tool

The maintainer decides the batch on question cards, a few at a time; the written report stays the reference behind them.

A round is one call to the question tool with 4–6 cards. Each card is one decision:

- **Header**: `#N` plus two or three words naming the behavior (`#3640 Cmd+Enter`), within 30 characters.
- **Body**: the PR as a markdown link (`[#N](https://github.com/openchamber/openchamber/pull/N)`; the cards render markdown) with a plain title on the first line, then one or two plain sentences: what changes for the user, and what it costs (risk, a new surface, a dependency, a support burden). Describe behavior, never file names; spell out jargon the maintainer would not use.
- **Options**: 2–3, the recommended one first with `(Recommended)`. Each option says its consequence ("Close: /btw stays a command"), not only a verb. When our own follow-up is part of the verdict, the option says so ("Merge, then we fix the 1px offset").

Order the rounds by how much the maintainer is needed: product decisions first, then plain bug-fix merges, then fix-before-merge, then merge-then-fix, and last one card that confirms all mechanical closes (duplicates, superseded, stale) as a list. A group of trivial, uncontested merges (translations, one-line fixes) shares one card with a one-line description per PR.

Between rounds:

- A free-text answer is read for what it is. When it states a decision (often with how to word the reply), act on it; when it asks or doubts, answer that before moving on and re-ask the PR in the next round with the corrected facts.
- When the maintainer doubts a claim ("are you sure that's still broken?", "that sounds fragile"), check the code and the current `main` yourself before replying; a reviewer's verdict is a lead, not proof. Report what you found in plain words, then re-ask.
- A product decision the maintainer states during the rounds is binding: add it to *Standing decisions* as soon as it is given, one line with its anchor PR, after checking the code agrees.

When every card is answered, show one summary grouped by outcome, list what will need the maintainer's own hands (a live check on a device or a packaged app), and get one explicit go before any GitHub write. Comments to people the maintainer works with closely (team members, regular volunteers) are shown as drafts before posting; the rest go out in the maintainer's voice without a separate review.

After a batch of merges:

1. Run `bun run type-check` and `bun run test` on current `main`, in a worktree of its own. `main` has no CI of its own, and PRs that pass one by one break `main` together: two PRs changing the same contract from both sides each pass alone. A failure is traced to its PR and fixed on `main` before the next batch.
2. Write a symptom map of what landed (area, PR, merge sha, which part we wrote) to `docs/personal/pr-triage/pr-triage-<date>-merged.md`, so a later regression can be traced to its PR quickly.
3. Write the testing list for the maintainer to `docs/personal/pr-triage/pr-triage-<date>-what-changed.md`, in Ukrainian: grouped by area of the app, each entry a linked PR (or commit) and two or three sentences on what the user sees change, marking single-platform changes and the parts we rewrote.

## Standing decisions

Maintainer decisions that settle a PR without asking again. A PR that contradicts one gets the verdict the line implies; the close comment gives the reason in plain words. Each line was checked against the code when added; one the code no longer matches goes back to the maintainer instead of being applied.

- **Other agent runtimes** (ACP, Pi, DeepSeek Harness) are declined: OpenChamber runs on OpenCode, and a second backend doubles every session contract. Never word it as "we are a UI for OpenCode" ([#2010](https://github.com/openchamber/openchamber/issues/2010), [#3654](https://github.com/openchamber/openchamber/issues/3654), [#5700](https://github.com/openchamber/openchamber/pull/5700)).
- **Russian localization** is declined because of Russia's war against Ukraine; close with **russian-locale** below.
- **A composer action that rewrites the user's prompt** with a model is declined: mid-session the agent already sees more than an optimizer would. Say that, without pointing at extensions. The opt-in system-prompt optimizer in Behavior settings is a separate feature ([#3602](https://github.com/openchamber/openchamber/pull/3602)).
- **Theme files carry only colours, fonts and transitions** (`lib/theme/definition.ts`); per-component geometry stays in the components, so layout changes never break imported themes ([#5305](https://github.com/openchamber/openchamber/pull/5305)).
- **Mobile list sheets never raise the keyboard on open**, a tap on search does: the keyboard opens by itself only where text entry is the screen's main task ([#5345](https://github.com/openchamber/openchamber/pull/5345), `ThemePicker.tsx`).
- **Usage and quota for third-party plugins and tools** (CLIProxyAPI, Antigravity) go to extensions, which are becoming usage providers; close with that pointer. Fixes to built-in providers (Copilot, Zen, Kimi) stay in core ([#4986](https://github.com/openchamber/openchamber/pull/4986), [#5674](https://github.com/openchamber/openchamber/pull/5674)).
- **Usage estimates without an authoritative provider source** are declined: a guessed limit is wrong in ways users act on ([#5238](https://github.com/openchamber/openchamber/pull/5238)).
- **Gitea and Forgejo are first-class source-control providers** (`packages/web/server/lib/gitea`, `forgejo`); their PRs are reviewed like GitHub and GitLab ones.
- **A failed tool or subagent call stays failed** in the transcript; a new run of the child gives its own result. Core never parses a third-party plugin's private message format, because the plugin changes it without telling us ([#5548](https://github.com/openchamber/openchamber/pull/5548)).
- **Picking an agent or model writes nothing to the session until a message is sent**, and an unsent pick wins over a switch recorded on the session by a plugin, another client or a default change: per-pick writes litter the transcript with switch records ([#5901](https://github.com/openchamber/openchamber/pull/5901), `sync/selection-store.ts`). An unsent model pick also survives switching to an agent with a pinned model; a model restored from the session does not ([#5987](https://github.com/openchamber/openchamber/pull/5987)).
- **Markdown export carries no tool calls**, and there is no multi-format export with its own viewer ([#5356](https://github.com/openchamber/openchamber/pull/5356)).
- **A folder outside every project joins the projects only through OpenCode's folder trust**: an empty or already trusted config registers silently, anything else opens the trust dialog, and sessions of a declined folder never show in lists or open from notifications, links or launch restore. OpenCode runs plugin files and MCP servers from the folder ([#5809](https://github.com/openchamber/openchamber/pull/5809), `sync/session-admission.ts`).
- **Evidence files** (screenshots, logs, recordings) never land in the repo; evidence lives in the PR body, and `pr-checks.cjs` labels a branch that carries them `evidence-in-branch`.
- **Provider retry timing stays the provider's**: no cap that retries before `Retry-After`, and no "Retry now" control that holds and wakes the wait ([#6024](https://github.com/openchamber/openchamber/pull/6024), [#6029](https://github.com/openchamber/openchamber/pull/6029)).
- **Retry never reverts.** A revert restores every file that changed in the folder during the turn, whoever changed it, so a one-click retry built on revert silently undoes other sessions' and the user's edits ([#5997](https://github.com/openchamber/openchamber/pull/5997), [#6005](https://github.com/openchamber/openchamber/issues/6005)).
- **Every Git network transfer gets its own audit entry** (kind, endpoint fingerprint, transport reference) before it starts, including endpoints found after planning such as nested submodules ([#6011](https://github.com/openchamber/openchamber/pull/6011), `lib/git/network-operations.js`).
- **Archiving or deleting a session takes its subagent and review sessions with it**; forks and promoted `/btw` sessions stay active, and a subsession restores on its own only while its parent is active ([#5665](https://github.com/openchamber/openchamber/pull/5665), `components/session/sidebar/DOCUMENTATION.md`).

## Message templates

Canonical texts. Reuse verbatim, adjusting only bracketed parts.

**stale-close**
> Closing this as stale: the branch has merge conflicts with `main` and hasn't been updated in over a month. The codebase has moved on significantly since this was opened, so this change would need to be redone against the current state anyway.

**rebase-request**
> Sorry for the review backlog. The queue is currently far beyond what I can get through. This PR has merge conflicts with `main`, and I can only review PRs that merge cleanly. If you're still interested in landing this, please rebase. Conflicted PRs without activity will eventually be closed as stale.

**stale-draft**
> Closing this as stale: it's been a draft with no new commits for a while, and `main` has moved on a lot since, so it would need redoing against the current code anyway. Thanks for the work on it.

**duplicate-close**
> Closing as a duplicate of #[N], which will be reviewed instead[: one-clause reason it was kept].

**oversized-split** (single PR bundling several concerns)
> Closing this one. It bundles several unrelated concerns, [list], into a single [size] change across [n] files, which isn't reviewable in this form.

**russian-locale** (any PR adding Russian localization: a standing decision, applied without re-asking; the maintainer's own words, "we" included)
> We're not accepting Russian localization for OpenChamber.
>
> This is an intentional maintainership decision due to Russia's ongoing war against Ukraine. We don't want to ship or maintain Russian UI support.
>
> Closing.
