---
description: Create a React Doctor diagnostics cleanup PR from the next generated batch
agent: build
---

You are working in the OpenChamber repository.

Goal: reduce React Doctor diagnostics in a small, reviewable maintenance PR.

This task can run unattended on a schedule, so it must be safe to start at any moment and must stop cleanly when there is nothing to do.

First, verify the worktree is safe to use:

`git status --porcelain`

If the output is not empty, stop immediately and report that the worktree has uncommitted changes. Do not stash, reset, discard, commit, or switch branches. Local work in progress must never end up in a maintenance PR.

Then run:

`bun run doctor -- next-batch --min-issues 75 --max-issues 120`

Use the command output as the source of truth for this task scope.

If the output contains `NO BATCH AVAILABLE`, stop immediately and report the printed reason. Do not create a branch, do not create a pull request, and do not look for other work. Concurrency is already handled: the command excludes files claimed by other active batches and refuses to exceed the active-batch limit.

Workflow:
- Before generating the batch, switch to `main` and pull the latest remote changes.
- Read the `next-batch` output carefully.
- Use the exact `Run ID`, `Batch name`, `Branch name`, and `PR title` printed by the command.
- Create the branch using the printed `Branch name`.
- Work only on the selected files listed in the batch output.
- Treat the selected files as complete-file scope. Do not cherry-pick only the first N diagnostics.
- Fix as many diagnostics as practical in the selected files. Your default should be to fix selected diagnostics, not to skip them.
- Prefer direct, behavior-preserving fixes: missing effect cleanup, mutable effect dependencies, accessibility issues with semantic fixes, local performance improvements, Tailwind shorthand replacements, component extraction when the boundary is clear, dead-code removal after verifying no references, and reducer or derived-state cleanup when the state relationship is local and clear.
- Handle larger diagnostics deliberately instead of skipping them: for component splits, extract the smallest coherent subcomponent that reduces the diagnostic while preserving props/state flow; for dead code, verify references with search before deleting exports, types, or files; for state architecture issues, prefer the smallest local reducer or derived-state simplification that preserves behavior; for render-function extraction, extract only stable render helpers that do not depend on large implicit closure state, or pass explicit props; for behavior-sensitive diagnostics, read the surrounding code first and preserve existing runtime behavior.
- Finish each selected file. A file is finished when it has zero React Doctor diagnostics, or when every remaining diagnostic has an individual, specific reason to stay. A half-fixed file will be selected again later and cost a second pull request, a second review, and a second merge over the same code.
- Before considering a file done, re-run `bun run doctor -- file <path>` and read what is left. Leaving more than roughly a quarter of a file's diagnostics behind means you have not finished.
- A group of diagnostics sharing one root cause counts as one reason, and that root cause is usually worth fixing rather than deferring.
- Skip a diagnostic only when the fix would require unclear behavior changes, or a change so large it would stop the pull request from being reviewable. Difficulty alone is not a reason. If skipped, give the specific reason in the PR body under `## Non-goals`.
- Do not suppress React Doctor diagnostics unless there is a clear false positive.
- If a listed diagnostic requires changes outside the selected files, make only the minimal required supporting change. Do not expand the cleanup scope.

After edits, run:

`bun run doctor -- check-batch --run <run-id>`

Then validate the packages you actually touched, not the whole workspace. For each affected package run its own checks, for example:

`bun run --cwd packages/ui type-check`

`bun run --cwd packages/ui lint`

`bun run --cwd packages/ui test`

Workspace-wide `bun run type-check` and `bun run lint` are CI's job. Run them locally only when a change crosses package boundaries or touches shared contracts. For files that TypeScript does not cover, such as server or CLI JavaScript, run the focused tests for that surface instead.

Validation and delivery:
- Confirm selected files have fewer diagnostics than before.
- If validation fails, fix failures only if the fixes stay within the task scope. Otherwise stop and report the blocker.
- Commit the changes with a concise message.
- Push the branch.
- Create exactly one PR with `gh pr create` using the exact printed `PR title`.
- After the PR is created, switch back to `main` and pull the latest remote changes again.

PR requirements. The repository has a mandatory pull request template at `.github/PULL_REQUEST_TEMPLATE.md`, and `AGENTS.md` requires it to be completed with concrete evidence for the final PR HEAD. Read the template and `CONTRIBUTING.md` before writing the description. Use every template heading, in the template's order, and do not invent replacement headings. Fill each section as follows.

- Use the exact printed `PR title`.
- `## Intent`: state that this is an unattended maintenance batch, name the `Run ID`, `Batch name`, and `Branch name`, and say what behavior changes. When nothing observable changes, say so explicitly rather than leaving it implied.
- `## Non-goals`: the diagnostics left unfixed in the selected files, diagnostics elsewhere in the repository, and any refactor you deliberately did not start. Give the reason for each, not just the count.
- `## Affected surfaces`: the packages, runtimes, user-visible states, and persisted or external contracts the diff reaches. Name every runtime the changed code runs in, and explain why an apparently applicable runtime is unaffected.
- `## Repository guidance`: fill the table. List the `AGENTS.md` rules you followed, every project skill that matched the change, required skill references you read, and the nearest `README.md` or `DOCUMENTATION.md` for the touched modules. For each row explain why it applies and how the change complies. Do not list filenames without explanation.
- `## Validation`: fill the table with the exact commands you ran and their results, including `check-batch` and every package-scoped type-check, lint, and test command, naming the packages. Record failures honestly, including pre-existing failures unrelated to this PR, and say which checks you did not run. Do not claim runtime behavior from type-check or lint alone.
- `## Visual evidence`: these PRs usually have no visible change, so explain concretely why the diff cannot affect rendered behavior. If anything user-visible did change, attach before/after evidence for the affected states.
- `## Risks and failure behavior`: cover what breaks if a change is wrong, how to roll it back, and any compatibility, data, performance, or cross-runtime concern. State "None identified" only with a concrete reason.

Add a `## Manual testing recommendations` section after the template sections, with focused checks for the changed behavior. Base it on the selected files and actual edits, for example checking affected dropdowns, keyboard navigation, model or agent selection, settings controls, and mobile or desktop variants.

Also state, inside `## Intent`, the selected files and how many diagnostics `check-batch` reports as fixed and remaining.

Constraints:
- Keep the PR small and reviewable.
- Do not auto-merge.
- Do not modify unrelated files except minimal supporting changes required by selected-file fixes.
- Do not run broad formatting.
- Do not fix diagnostics outside the selected files.
- Do not edit `CHANGELOG.md`, package versions, or release metadata. This is internal maintenance with no user-facing change.
- Leave the batch's run directory intact after creating the PR. `next-batch` prints its location. That directory is both the handoff for the review follow-up task and the claim that stops another batch, including the anti-slop pipeline, from touching the same files. Deleting it early lets a parallel batch collide with this PR. Never delete it by hand; use `bun run doctor -- release --run <run-id>`.
- If you stop before creating a PR for any reason, release the claim with `bun run doctor -- release --run <run-id>` so the files return to the pool.
