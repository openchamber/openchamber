---
description: Follow up on a React Doctor PR by addressing Greptile review feedback
agent: build
---

You are working in the OpenChamber repository.

Goal: follow up on an existing React Doctor maintenance PR, address Greptile/review bot feedback, and clean up the local batch handoff files when done.

Inspect local React Doctor batch handoff files:

`find .tmp/react-doctor/runs -maxdepth 2 -name batch.json -print 2>/dev/null || true`

Workflow:
- Read the available `.tmp/react-doctor/runs/*/batch.json` files.
- Find the most recent batch that has `branchName`, `batchName`, and `prTitle`.
- Read its `Run ID`, `Batch name`, `Branch name`, `PR title`, and selected files.
- Use `gh` to find the open PR for that branch or title.
- If no open PR exists for the batch, stop and report that there is no PR to follow up.
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

`bun run type-check`

`bun run lint`

Delivery:
- Commit follow-up fixes with a concise message.
- Push the branch.
- Reply to addressed review comments using `gh`.
- For each specific review comment you addressed, reply with what was changed and the follow-up commit hash.
- If the feedback was a general PR comment, add one general PR comment summarizing what was addressed, commit hashes, and validation results.
- If a comment is intentionally not addressed, reply with a concise reason.
- After successful push and replies, delete only the completed batch handoff directory: `.tmp/react-doctor/runs/<run-id>/`.
- After the follow-up is complete, switch back to `main` and pull the latest remote changes.

Constraints:
- Work on exactly one React Doctor batch PR.
- Prefer the most recent batch with an open PR.
- Do not auto-merge.
- Do not close the PR.
- Do not delete handoff files until comments are addressed, validation passes, and follow-up commits are pushed.
- Do not delete unrelated `.tmp/react-doctor/runs/*` directories.
- If validation fails and cannot be fixed safely within scope, do not delete the handoff directory.
