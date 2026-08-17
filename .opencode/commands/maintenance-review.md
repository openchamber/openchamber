---
description: Deeply review every open maintenance PR and fix it to completion, not by commenting
agent: build
---

You are working in the OpenChamber repository.

Goal: take every open automated maintenance pull request and bring it to a state where a human reviewer would merge it without a single objection. You are the intelligence layer between unattended batch tasks and the repository owner. The batch tasks optimize for a metric; you optimize for the code being right.

You do not leave review comments. You do the work. A finding you notice and do not fix is a failure of this task.

## Scope of the run

In scope: every open pull request whose head branch starts with `anti-slop/` or `react-doctor/`.

Find them:

`gh pr list --state open --search "head:anti-slop/" --json number,title,headRefName,url`

`gh pr list --state open --search "head:react-doctor/" --json number,title,headRefName,url`

Work through them one at a time, oldest first. Finish a PR completely before starting the next. Do not interleave.

This task ends only when every PR in the list has been reviewed, fixed, validated, pushed, and its description updated. Do not stop at the first one. Do not stop because a PR looks acceptable at a glance; that judgement comes after reading the diff, not before.

## Before you start

Verify the worktree is clean:

`git status --porcelain`

If the output is not empty, stop immediately and report it. Do not stash, reset, or discard anything.

Read `AGENTS.md`, and read `.opencode/commands/as-fixes.md` in full, including the sections "What a good fix looks like" and "Hard prohibitions". Those describe the standard the anti-slop PRs were supposed to meet. Your job includes verifying they actually met it.

Load every project skill matching the code you end up touching, exactly as `AGENTS.md` requires. These PRs reach into sync, stores, UI, runtime, and CLI code, and the applicable skill is determined by what you change, not by the fact that this is maintenance work.

## Working on one PR

Check out the branch and bring it up to date with `main`:

`gh pr checkout <number>`

`git merge origin/main`

If the merge conflicts, resolve it correctly by reading both sides. Never resolve a conflict by taking one side wholesale to save time.

Then read the entire diff against `main`, not just the changed lines:

`git diff origin/main...HEAD`

For every file in the diff, open the file itself and read the surrounding code. These PRs change type contracts and component structure, so a line that looks correct in isolation is frequently wrong in context.

## What you are looking for

Treat the PR body's claims as unverified. Re-run the checks yourself; do not trust reported results.

Correctness of the change itself:
- Did the change alter runtime behavior? Effect cleanup, hook dependencies, component extraction, conditional object spreads, and added parsing all can. Decide whether the new behavior is right, not merely whether it is different.
- Does a removed or reordered object key change what gets serialized to an API, persisted to disk, or merged over defaults? A key that used to be absent and is now present as `undefined` is a real change.
- Was dead code removed that is actually referenced somewhere the batch task did not search, including dynamic imports, string-keyed lookups, generated assets, and other packages?
- Did a type contract change without every call site being updated? Search for each changed symbol across the workspace.
- Did an extracted component lose state, memoization, ref forwarding, or a stable identity that the original had?

Honesty of the change:
- Is any `// SAFETY:` comment vague, generic, or untrue? A comment must name the check that already ran. If it does not, either delete the assertion by fixing the contract, or write the truthful comment.
- Was a type laundered rather than fixed? Look for invented primitive unions, `any`, new assertions, hand-written type predicates that merely relocate a rejected `typeof` check, or deleted fields and tests.
- Was a lint rule disabled, downgraded, ignored, or suppressed inline anywhere in the diff? Revert that and fix the underlying code.
- Was a new dependency, schema library, utility module, or architectural pattern introduced under the cover of cleanup? Remove it and solve the problem within existing precedent.

Quality of the result:
- Does the new code read like the code around it, in naming, structure, and comment density?
- Are the new names accurate, or do they describe the refactor instead of the domain?
- Is the change complete, or did the batch task fix eight of eleven findings in a file and leave three arbitrary ones behind?

## Fixing

Fix everything you find, on the PR branch, as additional commits. You are explicitly permitted to go beyond the batch's original file scope when correctness requires it: update call sites, correct an upstream contract, add a missing test, or finish an incomplete refactor.

Two boundaries on that freedom:

1. Do not touch files that another open maintenance PR modifies. Check with `gh pr diff <other-number> --name-only` for the other open PRs in this run. If a correct fix genuinely requires such a file, make the change in whichever PR already owns that file, and note the cross-PR dependency in both descriptions.
2. Do not turn a maintenance PR into a feature or a redesign. If you conclude the batch's approach was wrong at the root, revert that part of the diff rather than building on it, and explain the revert in the PR body. A smaller correct PR beats a larger clever one.

Do not disable, downgrade, or ignore lint rules. Do not add `any`, widen a type, or add an assertion to make a check pass. Do not edit `oxlint.config.ts`, `tools/oxlint/anti-slop/`, `CHANGELOG.md`, package versions, or release metadata.

If a batch left findings unfixed and the PR body called them skipped, evaluate each one yourself. Fix the ones that are fixable within a correct, reviewable change. Keep a skip only when you can articulate why fixing it would be wrong here, not merely hard.

## Validating each PR

Re-run the pipeline's own check for the batch, using the run id from the PR body when it is present:

`bun run deslop -- check-batch --run <run-id>` for anti-slop PRs

`bun run doctor -- check-batch --run <run-id>` for React Doctor PRs

If the run directory no longer exists, skip that command and say so; it is a convenience, not the source of truth.

Then, for every package the final diff touches, run its own checks:

`bun run --cwd packages/<name> type-check`

`bun run --cwd packages/<name> lint`

`bun run --cwd packages/<name> test`

Run `bunx oxlint <changed-paths>` on the files in the diff and confirm you have not increased anti-slop findings anywhere.

For surfaces TypeScript does not cover, such as server JavaScript, CLI JavaScript, or Electron main-process helpers, run the focused tests for that surface. Static checks do not prove those correct.

If a check fails for a reason unrelated to this PR, verify that claim by checking the same command on `main` before dismissing it, and report the result either way.

## Delivering each PR

- Commit your fixes with concise messages describing what was actually wrong.
- Push to the PR branch. Never force-push.
- Update the PR description so it describes the final state, using every heading of `.github/PULL_REQUEST_TEMPLATE.md` in the template's order. `## Intent` covers what the batch did and what you corrected; `## Non-goals` covers what you deliberately left alone; `## Affected surfaces` must reflect the final diff, including files you added beyond the batch scope; `## Repository guidance` must list the rules, skills, and module documentation that applied to your own edits, not only the batch's; `## Validation` must contain the exact commands you re-ran and their results; `## Risks and failure behavior` must carry every behavior change you accepted or introduced. A description that still describes only the batch's original work is incomplete.
- Preserve any content the repository owner added to the description by hand, including screenshots. Read the live description before editing it and merge your changes into it rather than overwriting.
- Add one PR comment summarizing your review pass, so the history shows what was examined and what was changed.
- Do not merge, do not close, do not approve, and do not request review.
- Do not release the batch claim. The batch stays claimed until its PR is merged or closed.

Then move to the next PR.

## Finishing the run

When every PR has been handled, return to `main` and pull:

`git checkout main && git pull`

Report, per PR: number, title, what was wrong, what you fixed, what you deliberately left alone and why, validation results, and your assessment of whether it is now ready to merge. State plainly if any PR is not ready and what blocks it.

If you found nothing wrong in a PR, say that explicitly and describe what you checked to reach that conclusion. That is a valid outcome, but only after real inspection.
