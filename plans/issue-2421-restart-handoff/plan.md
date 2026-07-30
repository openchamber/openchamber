# Issue #2421: Restart Handoff

## Accepted architecture

- Keep phase-1 v1 in `managed-opencode-handoff-protocol.js` unchanged.
- Add an isolated v2 namespace under `packages/web/server/lib/opencode/managed-opencode-handoff-v2/` for Linux/POSIX Web-daemon foundations.
- V2 owns a private local master-secret provider, a separate SQLite record store, and a signed reservation/lease protocol. It does not share the legacy managed-process registry or any auth/HMR/CLI secret source.
- Default v2 storage is `~/.local/state/openchamber/managed-opencode-handoff-v2/`, containing `master-secret.bin` and `master-secret.initialized` (`0600`) plus `records.sqlite3`; records contain public identity, lease, revision, and MAC fields only.
- A Linux/POSIX-only standalone **guardian process** (`bin/openchamber-guardian.js`) outlives the web server and manages OpenCode child processes via the v2 durable protocol over a Unix-domain socket at `<rootDir>/guardian.sock` (mode `0600`, same-UID local trust boundary).
- Web lifecycle adoption (`bootstrapOpenCodeAtStartup()`) and restart handoff (`restartOpenCode()`) are best-effort and fall back to legacy stop/start when the guardian is unavailable.

## Phase order

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Isolated v1 protocol + fake-store tests | complete |
| 2A | v2 secret provider, SQLite CAS store, reservation/launch/lease protocol | complete |
| 2B | Linux guardian core + IPC server + GuardianClient | complete |
| 2C | Guardian launch wiring: `openchamber-guardian` bin entry, `openchamber guardian {status\|start\|stop\|reload}` subcommand, `--guardian`/`--no-guardian` flag, autostart in `serve`, graceful shutdown sequencing, Linux-only smoke test | complete (local, uncommitted) |
| 3 | Web lifecycle integration (`bootstrapOpenCodeAtStartup()` adoption + `restartOpenCode()` handoff branch + `--handoff` CLI flag) | complete (landed in same PR as 2B) |
| 4 | Cross-runtime adoption — see "Phase 4 scope" below | closed by user direction (2026-07-29): no VS Code, no Electron, no mobile, no hosted mobile |

## Current status

Phases 1, 2A, 2B, 2C, and 3 are implemented and validated locally on branch `fix/issue-2421-restart-handoff`. PR #2485 in upstream `openchamber/openchamber` references the issue and walks reviewers through the dormant-until-2C framing; a follow-up commit on the same branch carries Phase 2C plus an `ipc-server.js` shutdown-response ordering fix surfaced by the Phase 2C smoke test. Nothing is committed or pushed in this session — all Phase 2C work plus the protocol fix sit as uncommitted changes on the local branch awaiting explicit approval.

## Phase 2A state machine

`reserved -> launch-delivering -> launching -> active -> handoff-prepared -> claimed -> active`

- Phase 2A implements only `reserved -> launch-delivering -> launching -> active`, active lease renewal, and explicit interruption/stopping/retirement handling. The short-lived `launch-delivering` fence permits only its owner to complete delivery; public terminal mutations cannot win during that fence.
- `reserved`, `launching`, and `active` may become `interrupted` or `stopping` on an explicit failure path.
- `handoff-prepared` and `claimed` are reserved future states; no handoff or adoption operation is exposed in Phase 2A.
- `stopping -> retired`; `interrupted` and `retired` have no outgoing Phase 2A transitions.

## Phase 4 scope (closed by user direction)

User research on OpenCode's resume machinery (2026-07-29) confirmed that **session durability is an OpenCode-side property, not an OpenChamber-side one**. OpenCode persists `session_message`, `session_input`, `session_context_epoch`, and `session_message(type=compaction)` rows in its own SQLite store; `SessionV2.resume(sessionID)` rebuilds the runner from that durable state. What is **not** durable across an OpenCode child restart is the in-memory `SessionRunCoordinator`, `BackgroundJob` state, and the currently-in-flight LLM turn — by design lost on a hard process boundary, resumed by OpenCode's own resume flow when the child starts again.

User direction (2026-07-29) closes the originally-listed Phase 4 items as follows:

| Originally listed | Decision |
|---|---|
| Session resume / agent loop restoration | **Not ours — already provided by OpenCode.** No action. |
| VS Code integration | **Out — not doing.** Windows is out of scope by project policy; cross-platform VS Code would need a separate design (named-pipes guardian IPC, extension-host lifecycle). Closed. |
| Electron integration | **Out — not doing.** Electron starts the backend in-process (`AGENTS.md` runtime boundary); the Unix-socket guardian has nothing to attach to. Closed. |
| Mobile (Capacitor iOS/Android) | **Nothing to do.** Mobile is a client that connects to an existing OpenChamber server over HTTP/relay. It already works as long as the server works. Closed. |
| Hosted mobile | **Out — not doing.** Closed. |
| UI state persistence (open tabs, draft, scroll) | **Ours but unrelated to #2421.** This is a `packages/ui` client-persistence task, not a server-restart-handoff task. Different issue, different PR if/when it ever happens. |

**Net Phase 4 status: closed.** Phase 2C closes the user-visible bug in #2421; there is no Phase 4 work on our roadmap. If a future request brings VS Code, Electron, mobile, or hosted-mobile guardian support, each becomes a fresh issue with its own design.

**VS Code forward-reference:** a Linux-only "do it" sketch and a hypothetical Windows plan (transport abstraction, named-pipes-or-localhost-TCP decision, Windows process-termination refactor, sub-phase breakdown W-A through W-E) are documented in `plans/vscode-handoff-design-notes.md`. Read that file only if a fresh VS Code issue is opened.

## Risks and gates

- Secret, filesystem, SQLite, clock, MAC, or CAS failure blocks v2; it is never treated as an absent/free record.
- Credential material is armed before `reserved -> launch-delivering` CAS. A terminal mutation either wins before that fence (so delivery cannot begin) or is rejected while delivery is fenced; expiry and callback failure revoke material before user callback delivery.
- Renewal is bounded from authoritative store time, never accumulated from a prior expiry.
- Master initialization has durable evidence and exclusive creation semantics; a missing/corrupt secret in a previously initialized root, or a secret-only root without evidence, fails closed. Deleting the whole root remains an unavoidable loss-of-evidence boundary.
- Concurrent store initialization must converge under SQLite locking/retry across worker threads and OS processes, and reject damaged, under-constrained, metadata-tampered, or SQLite-lookalike schema objects.
- No raw master, child credential, or lifecycle material may be persisted, logged, returned as public record data, or reused from existing auth/config state.
- The guardian is a long-lived process subject to the same-UID local trust boundary. Cross-process adoption with a `claimCapability` is intentionally out of scope (Phase 2B deferred it).
- Validate focused unit/integration tests, source syntax, package checks available in the worktree, and documentation consistency. No real child, ports, signals, lifecycle, registry, route, CLI, Electron, VS Code, UI, or resume wiring belongs to the v2 protocol package; Phase 2C adds launch-time wiring only for the Linux/POSIX web daemon.
