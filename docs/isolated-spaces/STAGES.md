# Isolated spaces: stages

Read [DESIGN.md](DESIGN.md) first.

## Delivery rules

- One stage is one small pull request into `main`. Yulia reads and merges each one, so a stage must be readable in one sitting. If a stage grows, split it.
- The whole feature stays behind one switch until the first release. While the switch is off, the server registers none of the feature's routes and the UI shows none of its entry points.
- Before each pull request: run the local bot review and fix its findings, run every escape test that exists so far, and complete the stage's checklist from [TESTING.md](TESTING.md).
- A checklist line has two states: "passed, here is the evidence" or "blocked, here is the reason". There is no "skipped".
- `yulia/dev` is an optional personal integration branch for daily use. Delivery goes through `main`.
- Stage 4 overlaps with the `opencode-v2-refactoring` branch (proxy, event frame format, the `translate-v2` layer). Before starting it, confirm the frame format is final and build after that layer.

## Stages

A stage is done when its "works afterwards" column is true on a real runtime and its checks have evidence.

Stage 0 finished on 2026-09-19. All four experiments passed with changes, and DESIGN.md already carries those changes. The notes with exact commands are in [stage-0/](stage-0/). They ran on macOS with Colima, linux/arm64, with fake keys only. Still unverified: a real model call through the window over TLS, a real OpenAI token, the transports other than `docker exec`, and a Windows host.

| # | Stage | Works afterwards | Checks |
|---|---|---|---|
| 0 | Experiments | No product code. Four short experiments with a written result each: the host's server version runs in the stock Linux image including the terminal module; how the dispatcher recognises space requests; OpenCode reaches a model through a window and accepts a short OpenAI token record without refreshing; git push and fetch travel over `exec` | A note with results. A failed experiment changes this plan before code exists |
| 1a | Docker place and space manager. Built 2026-09-19, unwired, in `packages/web/server/lib/spaces/` | Create, verify, start, list by label, exec, stop, remove, rollback. No routes, no UI | Contract suite and 17 escape tests pass on real Docker (Colima, linux/arm64, Engine 29). Also passes on native Linux amd64 with Engine 29.8.1 over `DOCKER_HOST=ssh://`, and fails closed on Engine 26. Also passes with the module running on a Windows 11 host against Docker Desktop (Engine 29.6.2). Not verified: a console window flash in an interactive Windows session, and an image pull in a Windows desktop session |
| 1b | Tools volume and the server inside the space. Built 2026-09-20, unwired | The tools volume with the server, OpenCode, and its plugin, for a released version and for a development build from packed local packages. A stopped space moves to new tools at its next start. No routes, no UI | The unchanged contract suite and the escape suite, now 34 tests, pass with the server running inside on real Docker: Colima on linux/arm64 with Engine 29.2.1, native Linux amd64 with Engine 29.8.1 over `DOCKER_HOST=ssh://`, and a Windows 11 host against Docker Desktop with Engine 29.6.2. The server starts from the read-only tools volume, and its terminal runs commands as uid 1000. OpenCode inside reports the space path unchanged, and reports the real path for a symlink. A failed fill leaves nothing. Not built: moving a running space when the agent finishes its turn, and the decision that a host is a development build |
| 2 | Gatekeeper | Corridor, window, live allowlist change, journal, model key outside the space | Escape tests: bypass the gatekeeper, reach private networks, find the key |
| 3 | Code in and out | Transfer, uncommitted snapshot, both apply variants, quarantine | Bait repository: `.env` absent, executable bit kept, unclean apply touches nothing |
| 4 | Dispatcher, sessions, events | The space shows in the sidebar, chat works, an unreachable space breaks nothing | Failure isolation: kill the space mid-work, normal sessions unaffected |
| 5 | The journey in the UI | Places funnel, create dialog, group status and actions, grant dialog with journal, apply dialog, spaces page, chat archive, idle stop, start without waiting | Manual checklist for journey steps 0 to 9 |
| 6 | Dev server preview | A dev server in the space opens in the built-in browser | Manual, bait repository |
| 7 | Browser logins | OpenAI with a short token, Copilot with its warning | Manual with a real OpenAI login: works, refreshes, host login survives |
| | First release: local Docker | The switch is removed | Full manual pass on Mac, Windows, Linux, web. Quick look on mobile |
| 8 | Docker over SSH | The "another machine" place | The same contract suite against the Debian host, manual pass |
| 9 | Cluster | The cluster place with the enforcement probe | kind with and without enforced policies. Refusal to touch an unnamed cluster |
| 10 | Apple container | A place on a Mac without Docker | Manual on macOS 26 with `container` 1.4 or newer |

The contract test suite is written in stage 1 and stays fixed. A later place is done only when it passes the whole suite, including every escape test.

Later, in no fixed order: project-defined images, submodules, sandbox services, Copilot through the gatekeeper.
