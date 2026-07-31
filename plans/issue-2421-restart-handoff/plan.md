# Issue #2421: Restart Handoff

## Accepted architecture

- Keep phase-1 v1 in `managed-opencode-handoff-protocol.js` unchanged.
- Add an isolated v2 namespace under `packages/web/server/lib/opencode/managed-opencode-handoff-v2/` for Web-daemon foundations shared by POSIX and Windows transports.
- V2 owns a private local master-secret provider, a separate SQLite record store, and a signed reservation/lease protocol. It does not share the legacy managed-process registry or any auth/HMR/CLI secret source.
- Default v2 storage is `~/.local/state/openchamber/managed-opencode-handoff-v2/`, containing `master-secret.bin` and `master-secret.initialized` (`0600`) plus `records.sqlite3`; records contain public identity, lease, revision, and MAC fields only.
- A standalone **guardian process** (`bin/openchamber-guardian.js`) outlives the web server and manages OpenCode child processes via the v2 durable protocol. POSIX uses a `0600` Unix-domain socket; Windows uses loopback TCP and an ACL-protected discovery file.
- Web lifecycle adoption (`bootstrapOpenCodeAtStartup()`) and restart handoff (`restartOpenCode()`) are owner-checked and transactional, with legacy fallback only after guardian cleanup/rollback is attempted.

## Phase order

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Isolated v1 protocol + fake-store tests | complete |
| 2A | v2 secret provider, SQLite CAS store, reservation/launch/lease protocol | complete |
| 2B | Linux guardian core + IPC server + GuardianClient | complete |
| 2C | Guardian launch wiring: `openchamber-guardian` bin entry, `openchamber guardian {status\|start\|stop\|reload}` subcommand, `--guardian`/`--no-guardian` flag, autostart in `serve`, owner-scoped shutdown/restart semantics, and real Linux/Windows smoke tests | complete locally; CI gate pending |
| 2D | Cross-platform guardian transport, authenticated IPC, stable owner/launch identity, Windows process/ACL path, and hard Windows smoke gate | implementation complete; real Windows gate pending |
| 3 | Web lifecycle integration (`bootstrapOpenCodeAtStartup()` adoption + `restartOpenCode()` handoff branch + `--handoff` CLI flag) | complete (landed in same PR as 2B) |
| 4 | Cross-runtime adoption — see "Phase 4 scope" below | closed by user direction (2026-07-29): no VS Code, no Electron, no mobile, no hosted mobile |

## Current status

Phases 1, 2A, 2B, 2C, and 3 are implemented on `fix/issue-2421-restart-handoff`. The current provenance is aligned with `upstream/main` at `eafa7ceec`: PR #2485 is OPEN/Draft, head `a2951d4cf`, and GitHub reports the branch mergeable. The PR comparison against the current base is 90 task-scoped files covering guardian/lifecycle/IPC, shared live-status reconciliation in `packages/ui`, CI, docs, tests, and plans. UI client persistence (tabs, drafts, scroll) remains out of scope. Previous local validation reports were collected before this final base alignment and must be refreshed on `a2951d4cf`; real Windows validation remains a required platform gate. No Draft/status change is part of this workflow.

## Phase 2A state machine

`reserved -> launch-delivering -> launching -> active -> handoff-prepared -> claimed -> active`

- Phase 2A implements only `reserved -> launch-delivering -> launching -> active`, active lease renewal, and explicit interruption/stopping/retirement handling. The short-lived `launch-delivering` fence permits only its owner to complete delivery; public terminal mutations cannot win during that fence.
- `reserved`, `launching`, and `active` may become `interrupted` or `stopping` on an explicit failure path.
- `handoff-prepared` and `claimed` are reserved future states; no handoff or adoption operation is exposed in Phase 2A.
- `stopping -> retired`; `interrupted` and `retired` have no outgoing Phase 2A transitions.

## Phase 4 scope (closed by user direction)

User research on OpenCode's resume machinery (2026-07-29) confirmed that **session durability is an OpenCode-side property, not an OpenChamber-side one**. OpenCode persists `session_message`, `session_input`, `session_context_epoch`, and `session_message(type=compaction)` rows in its own SQLite store; `SessionV2.resume(sessionID)` rebuilds the runner from that durable state. What is **not** durable across an OpenCode child restart is the in-memory `SessionRunCoordinator`, `BackgroundJob` state, and the currently-in-flight LLM turn. OpenChamber does not automatically continue a post-crash generation or reconstruct an in-flight turn. It rehydrates a live, identity-verified guardian child when one exists; if none exists, normal startup may create a fresh child, but it is not treated as continuation of the lost generation. Dead, malformed, or ambiguous records remain an attention condition for an explicit lifecycle action.

User direction (2026-07-29) closes the originally-listed Phase 4 items as follows:

| Originally listed | Decision |
|---|---|
| Session resume / agent loop restoration | **Not ours — already provided by OpenCode.** No action. |
| VS Code integration | **Out — not doing.** Cross-platform VS Code would need a separate design (named-pipes guardian IPC, extension-host lifecycle), even though the web guardian now supports Windows. Closed. |
| Electron integration | **Out — not doing.** Electron starts the backend in-process (`AGENTS.md` runtime boundary); the Unix-socket guardian has nothing to attach to. Closed. |
| Mobile (Capacitor iOS/Android) | **Nothing to do.** Mobile is a client that connects to an existing OpenChamber server over HTTP/relay. It already works as long as the server works. Closed. |
| Hosted mobile | **Out — not doing.** Closed. |
| UI state persistence (open tabs, draft, scroll) | **Ours but unrelated to #2421.** This is a `packages/ui` client-persistence task, not a server-restart-handoff task. Different issue, different PR if/when it ever happens. |

**Net Phase 4 status: closed.** Phase 2C closes the user-visible bug in #2421; there is no Phase 4 work on our roadmap. If a future request brings VS Code, Electron, mobile, or hosted-mobile guardian support, each becomes a fresh issue with its own design.

**VS Code forward-reference:** an out-of-scope VS Code design sketch is documented in `plans/vscode-handoff-design-notes.md`. Its historical POSIX-only assumptions are superseded by the current web guardian's POSIX + Windows implementation. Read that file only if a fresh VS Code issue is opened.

## PR review comments and remaining gates (read 2026-07-31)

- The original review blockers (guardian launch wiring, managed launch environment, and list-trust adoption decision) are recorded by the PR bot as addressed. Shared `packages/ui` live-status changes are an intentional affected surface, not UI-persistence scope.
- Workflow files under `.github/workflows/` are a trust boundary. Automated review must remain `human-review-required`; a maintainer must review the Linux/Windows workflows. The separate `pr-review.yml` oversized-diff fail-closed issue is a repository follow-up, not silently waived here.
- `parseAclOutput` now strips the validated target path case-insensitively before parsing inline ACEs, including paths with spaces (for example `C:\Users\Jane Doe\...`); focused regression passes. Native Windows `icacls` output remains unverified.
- The negative test for an explicit, non-inherited `CREATOR OWNER` ACL entry is now present and passing.
- Document the operator-visible guardian-owned `openchamber stop` behavior: an unresponsive web process is not force-killed when owner metadata must be preserved; retry `openchamber stop` or use the explicit guardian administrative command.
- Refresh the validation table on exact head `a2951d4cf`, including the current Windows workflow result; earlier green-run comments are not evidence for this final head.
- The merge-conflict review finding is resolved by the current merge with `upstream/main`; do not rewrite or force-push this published branch without separate approval.

## Risks and gates

- Secret, filesystem, SQLite, clock, MAC, or CAS failure blocks v2; it is never treated as an absent/free record.
- Credential material is armed before `reserved -> launch-delivering` CAS. A terminal mutation either wins before that fence (so delivery cannot begin) or is rejected while delivery is fenced; expiry and callback failure revoke material before user callback delivery.
- Renewal is bounded from authoritative store time, never accumulated from a prior expiry.
- Master initialization has durable evidence and exclusive creation semantics; a missing/corrupt secret in a previously initialized root, or a secret-only root without evidence, fails closed. Deleting the whole root remains an unavoidable loss-of-evidence boundary.
- Concurrent store initialization must converge under SQLite locking/retry across worker threads and OS processes, and reject damaged, under-constrained, metadata-tampered, or SQLite-lookalike schema objects.
- No raw master, child credential, or lifecycle material may be persisted, logged, returned as public record data, or reused from existing auth/config state.
- The guardian is a long-lived process subject to the same-UID local trust boundary. Cross-process adoption with a `claimCapability` is intentionally out of scope (Phase 2B deferred it); bootstrap adoption instead requires exact stable owner/runtime identity.
- Validate focused unit/integration tests, source syntax, package checks available in the worktree, and documentation consistency. The v2 protocol package remains transport/lifecycle agnostic, while the guardian and web lifecycle own real child, port, signal, registry, route, and CLI behavior for POSIX and Windows.
