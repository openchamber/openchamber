# Model bench

Measures how a model handles real OpenChamber work, so the team can decide which model gets which kind of task. Each task replays a commit that already shipped: the model gets the code as it was before the commit and a prompt that describes the symptom, and its result is compared with the fix that shipped.

## Measuring a new model

1. Find the model id: `opencode models | grep <name>` (format `provider/model`, optionally `#variant`).
2. Run it on every task, level 3 tasks twice:

   ```sh
   node scripts/model-bench/bench.mjs run all <provider/model[#variant]> --parallel 4 --repeat 2
   ```

   Several models can go in one command; one model alone is fine, because each run is graded against the shipped fix, not against other models. A full set for one model is 18 runs, about 1 to 2 hours at 4 in parallel. It needs nothing from the person and survives an app restart under `nohup`.
3. Grade the new runs with judges (below), then compare them with earlier models in `~/.config/openchamber/model-bench/judgments.jsonl`.

Options: `--timeout <minutes>` per run (default 30), `--keep` keeps each run's code copy for inspection, `validate <task|all>` checks that a task's reference tests fail before the fix and pass after it (run it after adding or editing a task).

## What a run is

- A fresh copy of the repository at the commit's parent, made with `git archive`, so it has no history the model could read the fix from, and its dependencies installed from that commit's lockfile.
- `opencode run` with the `build` agent in that copy, under a private OpenCode config: no OpenChamber plugins, no personal `AGENTS.md`, no web tools, file tools denied outside the copy.
- A watchdog stops a run at the time limit or after 6 minutes without any event, and kills every process it started. A tool call that names the real checkout stops the whole bench; one that reaches this repository on GitHub stops the run and marks it `leaked`.
- After the run: the commit's own tests are dropped in and run, and the copy and its OpenCode session are deleted.

Results: one line per run in `~/.config/openchamber/model-bench/results.jsonl` (time, steps, tokens, tests, stop reason); artifacts in `~/.cache/openchamber-model-bench/results/<run>/` (`model.patch`, `reference.patch`, `events.jsonl`, `tests.txt`, `answer.txt` for reviews).

## Grading

Reference tests alone are a weak signal: three tasks (`testsAdvisory` in `tasks.json`) have tests bound to the shipped mechanism, so an equally good fix fails them. Every run is graded by judges with `judge.md` (code) and `judge-review.md` (reviews).

1. Anonymize: copy each run's artifacts to `~/.cache/openchamber-model-bench/judge/rNNN/` in random order, with model names stripped from `tests.txt`, and append `rNNN <run-dir>` lines to `judge-map.txt` there. Judges never see the map.
2. Grade with a workflow: one agent per run, reading `judge.md` or `judge-review.md` and the run folder, answering through a schema. Use at least two judges on different models, because a judge rates its own model's work slightly higher.
3. `node scripts/model-bench/report.mjs <workflow-run-id>` joins one judge's grades with the models; `node scripts/model-bench/cross-judge.mjs sol=<run>[:key] opus=<run>[:key] ...` compares judges on the runs they share and leaves out leaked runs.

## Tasks

`tasks.json` holds 10 tasks: 8 code tasks (level 2 and 3: UI logic, server logic, a feature) and 2 reviews, where the model reviews a commit that introduced a bug we later fixed. A new task needs a commit from the last month or two (older ones may be in training data), a prompt that describes the symptom the way a user reports it, the commit's test files as `hiddenTests`, and a passing `validate`. Review tasks name the buggy commit and the later `fixCommit`.

## Results so far

The first full run (10 models, judged by Sol, Opus and DeepSeek V4.1 Flash) put GPT-6.1 Sol and DeepSeek V4.1 Flash on top for code, with Opus and GLM-5.3-Flash close behind; every model was weak at finding visual bugs in review. The agent roster in `~/.config/opencode/agents` and `.opencode/agent` follows from it.
