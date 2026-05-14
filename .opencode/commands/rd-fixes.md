---
description: Create a React Doctor diagnostics cleanup PR from the next generated batch
agent: build
---

You are working in the OpenChamber repository.

Goal: reduce React Doctor diagnostics in a small, reviewable maintenance PR.

Start by running:

`bun run doctor -- next-batch --min-issues 75 --max-issues 120`

Use the command output as the source of truth for this task scope.

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
- Skip a diagnostic only when the fix would require broad architectural changes, unclear behavior changes, or changes outside the selected batch scope. If skipped, mention it in the PR body.
- Do not suppress React Doctor diagnostics unless there is a clear false positive.
- If a listed diagnostic requires changes outside the selected files, make only the minimal required supporting change. Do not expand the cleanup scope.

After edits, run:

`bun run doctor -- check-batch --run <run-id>`

Then run:

`bun run type-check`

`bun run lint`

Validation and delivery:
- Confirm selected files have fewer diagnostics than before.
- If validation fails, fix failures only if the fixes stay within the task scope. Otherwise stop and report the blocker.
- Commit the changes with a concise message.
- Push the branch.
- Create exactly one PR with `gh pr create` using the exact printed `PR title`.
- After the PR is created, switch back to `main` and pull the latest remote changes again.

PR requirements:
- Use the exact printed `PR title`.
- Include the `Run ID`, `Batch name`, and `Branch name`.
- Include selected files.
- Include diagnostics fixed according to `check-batch`.
- Include remaining diagnostics in selected files.
- Include validation results for `bun run type-check` and `bun run lint`.
- Include a `Manual testing recommendations` section with focused checks for the changed behavior. Base it on the selected files and actual edits, for example checking affected dropdowns, keyboard navigation, model/agent selection, settings controls, or mobile/desktop variants.
- Include any skipped diagnostics and why.

Constraints:
- Keep the PR small and reviewable.
- Do not auto-merge.
- Do not modify unrelated files except minimal supporting changes required by selected-file fixes.
- Do not run broad formatting.
- Do not fix diagnostics outside the selected files.
- Leave `.tmp/react-doctor/runs/<run-id>/` intact after creating the PR. These files are the handoff for the review follow-up task.
