A CI workflow failed. Diagnose the failure and fix its ROOT CAUSE.

Failed workflow: {{workflow}}
Failed run: {{run_url}} (run id: {{run_id}})
Branch (head branch of the failed run): {{branch}}
Head SHA: {{sha}}
Pull request associated with the failed run (may be empty): {{pr}}

## Dispatch context — read this first

- You are running in this repository's LAPTOP CHECKOUT (the repo's primary
  checkout on the owner's laptop). Work there; do not clone the repo
  elsewhere.
- A tracking issue and a queue task were ALREADY created for this run by
  the dispatcher, and this session is already claimed against them. Do
  NOT create another tracking issue for this run, and do not dispatch
  further tasks.
- There is NO plan-approval step. Proceed directly; do not stop to ask
  for approval of a plan.

## Instructions

- Start from the failed run's evidence. In this repository, inspect the
  failed jobs and logs of the run, for example with:
  `gh run view {{run_id}} --log-failed`
- Fix the ROOT CAUSE of the failure on branch {{branch}} (head {{sha}}).
  Do not merely re-run the workflow, and do not disable, skip or delete
  failing tests or checks to make it green.
- {{pr}} may hold the number of the pull request whose branch failed, or
  be empty. If a PR number is given, take it into account when deciding
  whether to push the fix to that PR's branch or open a new PR.
- Open or update a pull request for the fix following this repository's
  conventions (check its AGENTS.md / PR template). The pull request must
  reference the failed run ({{run_url}}) and the tracking issue for this
  task.
- In the pull request description, summarize the diagnosis (the root
  cause you found in the failed logs) and the fix you applied.
- Merging is permitted, never required: merge only per this repo's house
  rules — all checks pass, you ran the relevant tests yourself, and the
  change is low-risk and you are reasonably certain it is correct.
  Otherwise leave the PR open and state your confidence level and what a
  human should check.
- If the failure is environmental or a flake rather than a code defect —
  infrastructure outage, runner problem, transient network failure, a
  test that passes on re-run with no code change — do NOT force a code
  change. Report that conclusion, with the evidence from the logs, in
  your summary and on the tracking issue instead.
