---
name: openchamber-change-discipline
description: Use when implementing, fixing, refactoring, or otherwise modifying OpenChamber source code, dependencies, exports, build configuration, generated assets, package contracts, or module ownership.
---

# OpenChamber Change Discipline

## Core Principle

Make the smallest complete change and validate at the narrowest level that covers the real risk.

## Before Editing

1. Classify every applicable change risk below.
2. Identify every affected consumer, runtime, persisted format, and public export. This step is complete only when each risk has an owner and required validation.


## Risk Classification

| Risk | Examples | Planning consequence |
|---|---|---|
| Local implementation | Private helper or component behavior in one package | Preserve observable behavior; validate the owning package |
| Module contract | Exported API/type or documented module invariant | Inspect consumers; update contract tests and owning docs |
| Cross-workspace contract | Shared UI/runtime/package shape consumed by multiple workspaces | Trace every actual consumer and runtime; validate across workspaces |
| Persisted or external behavior | Stored settings/data, routes, IDs, files, CLI output | Define compatibility, round-trip, failure, and conversion behavior for existing consumers |
| Platform/runtime behavior | Electron, VS Code, mobile, relay, native or packaged behavior | Run the relevant runtime/build/integration validation |

Apply every matching category. Do not escalate local work into workspace-wide ritual, and do not treat a type-only export as local merely because it emits no JavaScript.

## Structural Discipline

- Preserve behavior established by callers and tests unless the request replaces it. Keep the diff scoped to the complete requested behavior.
- A migration or port (an API cutover, a library swap, a rewrite) keeps product behavior identical. Diff behavior, not types: for every fallback chain, heuristic, cost rule and refusal the old code had, show that the new code reproduces it. Where it cannot, stop and hand the maintainer "old did X, new cannot, options are…" before building; a reshaped behavior otherwise has to be re-verified by hand, feature by feature. "Upstream owns this now" holds only after checking that the upstream route does the same thing.
- A new bare import is listed in the importing workspace's `package.json` `dependencies`. A stale link in `node_modules` lets tests pass without it, while the packaged desktop app fails at start with `ERR_MODULE_NOT_FOUND` (in `~/Library/Logs/OpenChamber/main.log`); the dead-code check does not report unlisted dependencies.
- Make the normal use-case path read top to bottom in domain terms. Keep orchestration entrypoints thin and move mechanics or domain logic behind focused, intention-revealing boundaries.
- Pull complexity downward only when a boundary hides meaningful mechanics, owns an invariant, isolates a proven integration, or captures stable repetition. Do not spread obvious code across pass-through layers.
- Prefer explicit dependencies and dependency injection over hidden module coupling.
- Follow local TypeScript types; avoid `any`, blind casts, and guessed payload shapes.
- Reject invalid inputs and broken preconditions early so the valid path stays flat. Do not force a numeric happy-path/error-path ratio when correctness requires substantial failure handling.
- Require evidence before adding retries, caches, compatibility paths, lifecycle machinery, or generalized race handling. Security, data-loss, destructive-operation, and concurrency invariants still require proactive design when the risk is inherent to the operation.

## Review Prompts

Before broadening a change, ask:

- Is the new abstraction reused or merely possible to reuse?
- What concrete complexity, invariant, stable repetition, or boundary does each new helper, interface, layer, and file pay for?
- Is the code in the package that owns the behavior?
- Does the change alter shared UI contracts across web, desktop, VS Code, or mobile?
- Does it change persisted data, IDs, routes, exports, generated files, or package entrypoints?
- Can failure leave optimistic state, caches, files, or remote state stranded?

For partial or destructive flows, answer explicitly:

- What remains valid after the first failure?
- What is rolled back or cleaned up?
- What can be retried or resumed safely?
- What does the user observe?

For persisted data, require a migration only when existing stored data needs conversion. Test downgrade compatibility only when older application versions are a concrete supported consumer. "Rollback" means preserving/restoring valid state after a failed write or migration unless a broader contract explicitly says otherwise.

Do not hide a required architectural migration behind a local heuristic. Do not turn a local fix into a speculative rewrite.

## Answering Review Findings

When a reviewer (a subagent, a review session, a bot) reports on your change, you own the change and the reviewer advises. Review loops grow a change one cheap-looking fix at a time; hold it at the size its goal needs.

- Weigh every finding yourself before acting. A problem the change neither causes nor set out to fix (another path, a rare case, a small cost that was there before) is a nit, whatever label it came with. A regression this change introduces is never a nit, however rare its case.
- Fix what is wrong in the case the change is for, with the smallest fix. A fix that deletes or narrows code beats a new guard, helper, option, or test the goal does not need.
- A finding you think is wrong stays unfixed, with evidence: file and line, a test, command output. Decline nits and out-of-scope items in one line each; a real problem outside the change goes to the report as a follow-up.
- Never agree with a finding just to end the review.
- A finding still disputed after you and the reviewer have each answered twice goes to the maintainer, with both positions in two or three lines each. Do not argue a third round.
- After the fixes, compare the diff size with the one before review. If review grew it, cut first.

## Validation Matrix

| Change | Minimum validation |
|---|---|
| Executable source | Proof of the changed behavior (*Proof*, below); type-check and lint come from the pre-commit gate. TypeScript and lint do not cover server JS, CLI JS, Electron helpers, or native code: run `node --check`, focused tests, or the build for those |
| Cross-workspace/shared contract | Workspace-wide type-check and lint plus affected builds/tests |
| Added/deleted/renamed source file, export/type/entrypoint/import shape | Relevant checks; dead code comes from the pre-commit gate |
| Persisted or external contract | Compatibility and round-trip tests plus the persisted-state cases in `sync-state-invariants`, *Persisted Snapshot Ordering*, and failed-write rollback |
| Dependency or lockfile | Workspace-wide checks and affected builds |
| Added, renamed, or removed `packages/*` workspace | Mirror it in the Dockerfile `deps` stage, which copies those manifests by name, then run `docker build .`: a `COPY` of a missing workspace fails the build, and a workspace another one depends on fails the frozen install when absent. CI does not build the image. |
| Generated asset | Regeneration check plus consumer build/test |
| Docs-only or isolated config | Narrow syntax/schema/link validation; do not run unrelated full suites |
| UI or server behavior a user sees | Run it and look before calling it done, where the change lives (*Where to run it*, below) |
| Platform/runtime behavior | Relevant runtime build or manual/integration check; static checks are insufficient |
| Desktop update or quit/install sequence | A real update run; read `references/updater-testing.md` first, because a run done the obvious way completes the update and reports success while testing nothing |

`bun run check:changed` is the pre-commit gate: run it once, right before a commit, on the finished diff. While iterating, run only the focused tests for the behavior you just changed; an edit to docs, comments, or strings needs no check at all.

When several agents edit one checkout in parallel, they edit and run single test files only. The coordinator runs type-check, lint, builds and full suites once, serially, on the combined diff: each type-check holds over a gigabyte, parallel copies have frozen the machine, and a check run mid-edit reports the other agents' half-finished work.

Use a sufficiently long timeout for broad checks.

For type-only shared contracts, validate compile-time consumers. Add runtime serialization tests when the contract crosses a process, persistence, network, or untyped JavaScript boundary.

## Proof

A test is proof when it is deterministic and fails without the change: a pure function, a page script, a reducer. Behavior that lives in a runtime is proven by running that runtime and watching the scenario; a test there that only mirrors the implementation through mocks or races real timers adds upkeep and flakes, and the run already shows more.

Pick the scenarios before counting them. First run the plain path a user takes, end to end in the running app; then break it the ordinary ways it breaks: a credential the server stops accepting, a server that is down, a sign-in the user cancels or that fails, an empty or slow answer. Look at what the user sees each time. These ordinary breaks are where shipped bugs sit, so they come before rare races and exotic inputs, which earn coverage only with a concrete reason. Tests then pin what the runs found.

## Where to run it

Run the scenario in the runtime that executes the changed code. Every route below starts its own instance on free ports, beside the user's own app and dev servers.

| Change lives in | Run it with |
|---|---|
| Shared UI or server (also what desktop and VS Code render) | `OPENCHAMBER_HMR_UI_PORT=<port> OPENCHAMBER_HMR_API_PORT=<port> bun run dev`, then the browser panel at `http://localhost:<ui-port>` |
| Mobile web | The same server at `/mobile.html`, the panel at the mobile viewport |
| Electron main, preload, native windows | `electron:dev` with a debugging port, driven over CDP (`desktop-shell`, *Validation*) |
| The in-app browser panel and its agent actions | `electron:dev`, then the actions through that instance's control route (`packages/web/server/lib/browser-control/DOCUMENTATION.md`) |
| VS Code extension host or webview | `vscode:dev` with a debugging port, driven over CDP (`packages/vscode/README.md`) |
| Behavior only the packaged app has: client auth headers, the updater | The installed app over CDP (`desktop-shell`, *Validation*) |
| Capacitor shell | The iOS Simulator (`serve-sim`); timing, motion and keyboard latency on a device (`performance-engineering`, `references/ios-webkit.md`) |
| Pure logic | A deterministic test that fails without the change |

A scenario with real sessions, OpenCode turns or extensions runs in an isolated dev instance, set up and driven as `references/live-dev-instance.md` describes: a plain `bun run dev` writes the user's own settings and sessions.

Use `localhost`, never `127.0.0.1`, for the web server: the desktop app lifts Chromium's connection cap for `127.0.0.1`, and the panel then overruns Vite and resets connections. Build the desktop app only for a change that lives in its shell. Stop each instance by its own process id or process group, never by a name pattern that would stop someone else's.

The panel's browser actions run in the app the agent itself works from, so they cannot reach a change to the panel's own code until that app is rebuilt; the `electron:dev` route above covers it before.

## Refactoring under the behavior net

The net is the gate at handoff, run once on the finished change: when the work is about to be committed, pushed or opened as a pull request, or handed to the maintainer to test. While building and trying things out, look at the result yourself in a dev instance (*Where to run it*) and run focused tests; a net run in the middle of the work spends minutes of a shared machine on code that is about to change again. A refactor is the exception in one place only: step 2 below runs the selection before the first edit.

A split, move or rewrite of a large file keeps behavior identical. `bun run verify` proves it for the features its map covers: it starts its own isolated instance, plays the user scenarios and exits non-zero on a red one. For a normal change the command is `bun run verify -- --changed`: it runs only the scenarios whose sources the change's files are, or import, and prints which file led to which feature and which changed files no scenario covers. The full run (about 25 minutes) is for merging a large batch and before a release.

1. See what your files select: `bun run verify -- --changed --list` once the first edit is in, or the zones by name before it (`bun run verify -- --list composer`). A file reported as covered by no scenario has no net yet.
2. Before the first edit, run the selection on the unchanged code (`bun run verify -- composer.send chat.footer`). All green. A red scenario on untouched code is a finding: report it before refactoring.
3. Give each behavior your change touches and no scenario plays a scenario now, green on the old code (format in `scripts/verify/DOCUMENTATION.md`).
4. After the change, run `bun run verify -- --changed`. Done means the selected scenarios green, and the files it lists as uncovered named in your report. A red one is a behavior change, so fix the code. Edit a scenario only when the markup it points at moved, and then the selector in `vocabulary.json`, with the step's meaning unchanged. A split or a rename of a listed source updates the feature's `sources` in the same change; the run refuses a source that does not exist.

While iterating, `--keep` holds the stand and `--attach <run>/stand.json` reruns against it in seconds. A run is one heavy job (a dev server and Chrome). Runs in separate worktrees do not disturb each other, and a machine runs two at once: a third waits for a free slot by itself and says so, so never work around the wait. Start every net run as a background command and carry on or end the turn; its result arrives when it finishes. A run prints nothing useful for minutes even without a queue, so a foreground call only blocks the session.

## Test Design

A new test earns its place before it is written. Settle three things for yourself first (this is a decision you make, not something to report): the behavior it protects, in words a user or a caller would use; the existing test that owns that behavior, if one does; and one credible way the code could be wrong that this test would catch and the existing tests would not. When an owner exists, extend its case instead of adding a file or a sibling case. When no such failure can be named, the change needs no new test: adding one because it is cheap leaves the next agent a test to rewrite, not a protection.

A useful test fails when the behavior is wrong and stays green through an equivalent rewrite of the code. A test that fails whenever the code is merely different (it replaces an internal module with a mock, asserts which helper was called, or reads source as text) mirrors the implementation; what it meant to protect belongs in a lint rule (a rule about how code is built), a type (the shape of data) or a test of the result the user sees. Substitutes stop at the edge of the system: a provider, the network, the clock, a child process. The project's own modules run for real.

When a change makes an existing assertion fail, decide which of the two happened before touching the test: the behavior changed on purpose, and the commit body says which behavior and why; or the code is wrong, and the code is fixed. In a refactor the behavior does not change, so an existing assertion that needs editing there was tied to structure: rewrite it to check the result, in the same change when that is small.

- Prefer observable contracts, state transitions, failure handling, rollback, and operation counts.
- Test private helpers through public/module behavior when that captures the risk clearly.
- Assert internal map shape, helper calls, or call order only when that structure/order is itself a contract.
- Keep refactor tests resilient to equivalent internal implementations.
- For behavior-preserving refactors, establish the current behavior before changing structure (*Refactoring under the behavior net*).

## Module Documentation

A module's `DOCUMENTATION.md` lives in its folder and holds what the code cannot show the next agent: what the module owns, what must stay true, and why it is built this way. A module gets its own document when it owns a contract other code relies on, an invariant, or a non-obvious design choice; a folder without any of these is covered by its parent's document.

The document has three parts:

- **Ownership.** What the module owns and where its boundary is: what belongs here and which neighbouring module owns the rest.
- **Invariants.** What must stay true, each stated so a change can be checked against it.
- **Decisions.** One `### Why X and not Y` entry per non-obvious choice: the chosen approach, the alternative it was weighed against or replaced, and the reason in one or two sentences. A choice is non-obvious when a later reader could reasonably "fix" it back: a simpler design that was rejected, a deliberate workaround, a measured trade-off.

The document describes the module as it is now. When a decision changes, rewrite its entry around the new choice and keep the old approach as the rejected alternative, so the file stays current and carries no history to unwind. Spend its lines on reasons and contracts; file listings and function-by-function walkthroughs restate the code and go stale first.

## Completion Standard

- Implement the behavior end to end, including rollback and cleanup.
- Prove the changed behavior (*Proof*): the reproduction passes in every runtime the change has code of its own in.
- No known problem is handed over. A case noticed on the way (a runtime that may differ, state that may not survive a reload, a server switch or eviction from cache) is run, and fixed when it breaks. Between several ways to fix something, pick the one that works and passes the checks, and show it; only a product decision goes to the maintainer. The report names what could not be run at all and the reason, which is a missing device or account and never a missing step.
- Preserve unrelated changes encountered in shared files.
- The owning `DOCUMENTATION.md` is true of the new code and has a decision entry for every non-obvious choice the change made; a new module that meets the bar in *Module Documentation* has its own document.
- Perform a final simplification pass over your own diff, hardest after a rework or a removal: every branch, condition, prop, parameter, export, key, and helper the change made unreachable, always-true, or single-valued is gone, along with speculative branches, shallow wrappers, stale compatibility, and names that do not clarify intent.
