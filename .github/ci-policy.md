# CI policy — main-only CI (full suite on main)

This file is the in-repo, adjustable policy surface for this repo's CI
tiers. Source design: developing-today/code#1779 ("CI: fast PR tier,
full main tier, self-healing main"), filed from
`designs/ci-fast-pr-full-main.md` in developing-today/code.
Implementation phases: developing-today/code#1780 (Phase 1,
cancel-in-progress), #1781 (Phase 2, PR-tier slimming), #1782
(Phase 3, main-gate + remediation chain). Tracker:
developing-today/code#1599.

Tuning this policy means editing this table by PR — never rewriting
the pipeline to match a new dividing line.

## Merge requirement

**Merge requirement: none from CI. No workflow in this repo runs on
`pull_request` (main-only triggers, 4478502bb, Drew 2026-10-30), so
no CI tier gates a merge.**

The `pr checks` jobs in oc-review.yml are display-named
`basic: lint`, `basic: type-check`, `full (main tier): tests`,
`full (main tier): build`, and `full (main tier): flake eval` — those names are historical. All five run
automatically only on the nightly schedule; a maintainer can also
start them manually via `workflow_dispatch` (on a ref of their
choosing). There is no push trigger: merged code is verified by the
next nightly run, or sooner by an exact-SHA dispatch. Automatic results
feed the remediation chain below instead of blocking PRs. (This file
documents the policy; branch-protection settings themselves are a
maintainer action and are not changed by the CI redesign.)

## Main-only model

- **No PR tier.** No workflow runs on `pull_request`, so a PR gets
  no automatic CI validation before merge; mergeability is a matter
  of the normal review protocol only. (A maintainer may still run a
  workflow manually via `workflow_dispatch`.)
- **Main tier — everything, nightly and on dispatch.** The nightly
  schedule runs the `pr checks` (oc-review.yml) full suite, and
  `workflow_dispatch` allows manual runs on an exact SHA/ref at any
  time. There is no per-merge run: verification of merged code is
  batched into the nightly run (or an explicit dispatch). (`nix-eval.yml` is the exception: manual dispatch
  only — see the tier map below.) Main-tier results feed the
  remediation chain (the `main-broken` watcher workflow) instead of
  blocking PRs.
- **Dedup rule.** A commit must not get duplicate automatic runs
  from overlapping triggers. Shape: `schedule` and
  `workflow_dispatch` only; no `push` and no `pull_request` trigger
  (Drew 2026-11-04: no commit- or PR-triggered CI — CI runs via
  dispatch/placement, schedule, and workflow_call only). Scheduled
  and manual reruns of the same commit are intentional, not
  duplicates.

## Change-class policy (design §3.3)

| class | trigger paths (examples) | validation (runs on main / dispatch, not on PRs) |
|---|---|---|
| 0 — prose | `**.md`, `docs/`, comments-only changes | nothing, or markdown lint only |
| 1 — config/data | `**.json/yaml/toml` non-build, `.github/**` (non-workflow) | syntax parse + lint of changed files |
| 2 — package source (default) | one package's src + tests | lint/format + typecheck/syntax of affected packages + affected unit tests |
| 3 — elevated | lockfiles, `go.mod`/`go.sum` roots, `flake.nix`/`flake.lock`, build definitions, `.github/workflows/**`, shared/core libraries | class 2 + compile check of affected packages |
| 4 — nix expressions | `**.nix` | class 1 + parse/eval of the changed files only |

Default when a change spans classes: the highest class wins. The
policy ships conservative (more class 3) and loosens as the
main-breakage rate proves out — the breakage rate from `main-broken`
issues is the tuning signal.

## This repo's tier map (oc-review.yml, workflow name `pr checks`)

| job | nightly (`schedule`) | dispatch |
|---|---|---|
| `lint` | ✅ runs | ✅ runs |
| `type-check` | ✅ runs | ✅ runs |
| `tests` | ✅ runs | ✅ runs |
| `build` | ✅ runs | ✅ runs |
| `flake-eval` | ✅ runs | ✅ runs |

No job in this workflow runs on `pull_request`; there is no PR column
because there is no PR trigger.

`pr checks` is this repo's designated **main-gate**: the Phase 3
watcher (`main-broken.yml`) watches only this workflow's completions
on `main`, so a red main produces exactly one owned breakage issue
per distinct failure signature (Breakage-ID), not workflow fan-out.
Because the main-gate now completes on nightly and dispatch runs,
breakage attribution is batched: one nightly failure may cover
several merges, and detection can be delayed up to ~24h after a
breaking merge lands. The watcher fires on those nightly/dispatch
completions (it accepts `schedule` and `workflow_dispatch` events),
so a red nightly still files its breakage issue.

`nix-eval.yml` runs only on `workflow_dispatch` (manual dispatch):
it has no `push`, `schedule`, or `pull_request` trigger and is not
paths-gated (class 4: eval of the flake's outputs only, no build).
In this repository its `eval` job is skipped outright — the job is
gated to `openchamber/openchamber`, so a dispatch here validates
nothing until the flakes are reconciled. This repo's own flake is
instead evaluated by the `flake-eval` job in `pr checks` above
(#1566): on the nightly schedule and on dispatch it runs
`nix flake show` and evaluates the `drvPath` of this flake's
packages and devShells for x86_64-linux, without building them —
the automatic check whose absence let PR #1386's broken flake
reach main (#1387).

## Release gate

`release.yml` and `mobile-release.yml` call
`require-main-gate.yml` before creating a release or uploading mobile
release assets. The check requires a successful `oc-review.yml` run,
named `pr checks`, for the exact release SHA. New release tags point to
that checked SHA. Failed, cancelled, pending, missing, or unreadable
results stop the workflow before it publishes.

The normal pre-release step for a missing run is to dispatch
`oc-review.yml` against the exact release SHA, using an existing
branch at that SHA or a temporary branch pointing to it. This
exact-SHA dispatch is the standard path, not a hotfix override.
Once that full-suite run succeeds, retry the release. There is no bypass for a failed or unreadable gate;
fix the commit or release a known-green SHA.

`build-macos-arm64-dmg.yml` is exempt because it only uploads a
seven-day Actions artifact. It does not create a GitHub Release or
upload to TestFlight. Use the gated `release.yml` workflow to distribute
a DMG.

## Concurrency rules (design §4, Phase 1)

Standard pattern for check workflows:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && github.run_id || github.ref }}
  cancel-in-progress: true
```

- Scheduled and dispatched main runs are keyed by `run_id` so they
  are never cancelled; a PR/branch run of a workflow that has such a
  trigger cancels on supersede.
- Scheduled singleton/deploy workflows keep `cancel-in-progress:
  false` on purpose; they are not checks.
- Event bots kept event-based (`pr-review`, `bot-help`,
  `bot-summarize`) key their groups per issue/PR (or per comment), so
  bursts queue or run per item instead of collapsing into one
  repo-wide group and silently replacing each other. A human waits
  synchronously on each of these (a review verdict, a help answer, a
  summary), which is why they stay event-based.
- Issue/PR *management* automation no longer runs on events at all:
  `pr-intake`, `issue-intake`, and `label-merge-conflict` were
  replaced by the single scheduled `repo-sweeper.yml` (every 15
  minutes), which does PR size/parking labels, merge-conflict
  labels, and issue intake in one pass. The sweeper has no
  workflow-level concurrency block (#758): the label passes carry
  per-job groups with `cancel-in-progress: true`, and each
  issue-intake leg carries a per-issue group with the literal
  `cancel-in-progress: false` and no `queue: max`, so a tick can
  never cancel a running intake and at most one leg per issue
  waits pending.
- **Never** pair `queue: max` with a cancel-in-progress expression
  that evaluates `true` for an `issues` / `pull_request_target`
  event: that is a GitHub validation error that killed issue-intake
  and pr-review before (openchamber#84).
