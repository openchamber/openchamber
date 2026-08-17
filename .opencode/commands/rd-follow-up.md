---
description: Follow up on a React Doctor PR by addressing Greptile review feedback
agent: build
---

You are working in the OpenChamber repository.

Goal: follow up on an existing React Doctor maintenance PR, address Greptile/review bot feedback, and clean up the local batch handoff files when done.

This task can run unattended on a schedule, so it must be safe to start at any moment and must stop cleanly when there is nothing to do.

First, verify the worktree is safe to use:

`git status --porcelain`

If the output is not empty, stop immediately and report that the worktree has uncommitted changes. Do not stash, reset, discard, or switch branches.

List the active batches:

`bun run doctor -- active`

The listing may include batches owned by the anti-slop pipeline; those are shown as `[pipeline as]`. Never touch them.

Workflow:
- If there are no active batches, stop and report that there is nothing to follow up.
- Each active batch corresponds to one open PR. Read its `batch.json` for `runId`, `branchName`, `batchName`, `prTitle`, and selected files.
- Use `gh` to find the open PR for each batch branch.
- Work on the oldest batch that has an open PR with unaddressed feedback. If several qualify, handle exactly one and leave the rest.
- If a batch's PR was already merged or closed, do not treat it as follow-up work. Release its claim with `bun run doctor -- release --run <run-id>` so its files return to the pool, then continue looking.
- If no batch has an open PR with actionable feedback, stop and report that.
- Switch to the batch branch using the exact `branchName`.
- Pull or update the branch from remote if needed.
- Use `gh` to inspect PR review comments, PR issue comments, review threads if available, and check run summaries if relevant.
- Focus specifically on Greptile/review bot feedback and actionable reviewer comments.
- Address actionable comments with minimal follow-up fixes.
- Keep changes within the original selected files whenever possible.
- If a review comment requires changes outside the selected files, make only the minimal required supporting change.
- Do not perform unrelated cleanup.
- Do not rewrite the original PR.
- Do not force-push.

After fixes, run:

`bun run doctor -- check-batch --run <run-id>`

Then re-run the package-scoped checks for the packages you touched, for example `bun run --cwd packages/ui type-check`, `bun run --cwd packages/ui lint`, and `bun run --cwd packages/ui test`. Workspace-wide checks are CI's job.

Delivery:
- Commit follow-up fixes with a concise message.
- Push the branch.
- Reply to addressed review comments using `gh`.
- For each specific review comment you addressed, reply with what was changed and the follow-up commit hash.
- If the feedback was a general PR comment, add one general PR comment summarizing what was addressed, commit hashes, and validation results.
- Update the PR description so it stays true for the final HEAD: refresh `## Validation` with the checks you re-ran, and move any new behavior change into `## Risks and failure behavior`. Keep every heading of `.github/PULL_REQUEST_TEMPLATE.md` intact, and preserve content the repository owner added by hand, including screenshots. Read the live description before editing and merge into it rather than overwriting.
- If a comment is intentionally not addressed, reply with a concise reason.
- Do not release the batch while its PR is still open and awaiting review. The claim is what keeps parallel batches off these files.
- Release the batch only once its PR has been merged or closed: `bun run doctor -- release --run <run-id>`.
- After the follow-up is complete, switch back to `main` and pull the latest remote changes.

Constraints:
- Work on exactly one React Doctor batch PR.
- Prefer the oldest batch with an open PR.
- Do not auto-merge.
- Do not close the PR.
- Do not edit `CHANGELOG.md`, package versions, or release metadata.
- Do not release or delete handoff directories for batches you did not handle.
- If validation fails and cannot be fixed safely within scope, leave the batch claimed and report the blocker.
