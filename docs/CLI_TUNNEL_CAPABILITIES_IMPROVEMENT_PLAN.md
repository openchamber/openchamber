# OpenChamber Tunnel CLI Capabilities Improvement Plan

## Scope

This plan defines a mature, security-first improvement path for OpenChamber tunnel CLI capabilities.

Out of scope:

- Provider-side token operations (generation/rotation/validation).
- Supply-chain release hardening work (artifact signing/provenance).
- Tunnel capability fields `intent` and `stability` as user-facing CLI actions.

### Scope update (March 2026)

Based on the latest tunnel capability mapping review, functional CLI parity is considered sufficient for active tunnel operations.

In scope for capability UX:

- Enrich human-readable `openchamber tunnel providers` output to include per-mode:
  - mode `key`
  - mode `label`
  - mode `requires` (or `requires: none`)

Out of scope for this improvement:

- Adding CLI actions or flags for capability metadata fields `intent` and `stability`.

Notes:

- `--json` output for `openchamber tunnel providers` already carries capability descriptors and remains unchanged.
- The improvement targets text output discoverability only.

### CLI output formatting decision (March 2026)

Adopt `@clack/prompts` as the formatting framework for structured CLI output.

Rationale:

- The existing hand-rolled formatting helpers (`printSectionStart`, `printSectionEnd`, `printListItem`, `color`, `strong`) already use the identical visual language as clack (`┌│└` rail, section open/close, status bullets).
- Clack is battle-tested (6.8M weekly downloads, MIT, 1 transitive dep `@clack/core`), used by Nuxt CLI, SvelteKit, and others.
- Provides primitives the current system lacks: `note()` for boxed content, `spinner()` for long-running ops, `log.message()` with custom symbols for sub-headings.
- Built-in color detection (TTY, `NO_COLOR`, CI) replaces the hand-rolled `STYLE_ENABLED` gating.

Key decisions:

- Accept clack's default symbols (`◇`/`◆`/etc.) rather than overriding to match the current `●`/`✓` style. Cleaner, less custom code.
- Migrate tunnel subcommands first. Non-tunnel commands (`serve`, `stop`, `restart`, `status`, `update`) will be migrated in a separate follow-up effort.
- `--json` output paths remain completely untouched.
- Create a thin internal adapter module (`packages/web/bin/cli-output.js`) that re-exports clack functions plus custom formatters (`formatProviderWithIcon`, `maskToken`) to isolate the dependency.

Clack API mapping to current helpers:

| Current helper | Clack replacement |
|---|---|
| `printSectionStart(title)` | `intro(title)` |
| `printSectionEnd(text)` | `outro(text)` |
| `printListItem({status:'success', ...})` | `log.success(...)` |
| `printListItem({status:'error', ...})` | `log.error(...)` |
| `printListItem({status:'warning', ...})` | `log.warn(...)` |
| `printListItem({status:'neutral', ...})` | `log.info(...)` or `log.step(...)` |
| `color(text, tone)` | Clack handles internally |
| `strong(text)` | Keep for edge cases |
| Doctor sub-headings (raw `│  <bold>`) | `log.step(...)` or `log.message(text, {symbol})` |

Migration scope for tunnel commands:

- `tunnel providers` — enriched per-mode output using `log.step` for mode sub-items. — **done**
- `tunnel ready` — migrate from `printListItem` to `log.success`/`log.warn`/`log.error`. — **done**
- `tunnel doctor` — migrate section/list items; sub-headings become `log.step` or `log.message`. — **done**
- `tunnel status` — migrate from `printListItem` to `log.*`. — **done**
- `tunnel start` — migrate section/list items; hint lines become `note()`. — **done**
- `tunnel stop` — migrate from `printListItem` to `log.*`. — **done**
- `tunnel profile *` — migrate section/list items. — **done**

Post-migration cleanup (tunnel scope only):

- Remove `formatDoctorProvider` (redundant with `formatProviderWithIcon`). — **done**
- Remove `formatProviderWithIcon` from cli.js (moved to `cli-output.js`). — **done**
- Remove `strong()` (replaced by clack). — **done**
- Remove `TUNNEL_PROVIDER_ICON` from cli.js (moved to `cli-output.js`). — **done**
- Keep `printSectionStart`, `printSectionEnd`, `printListItem`, `color()`, `STYLE_ENABLED`, `ANSI`, `STATUS_SYMBOL` for the `logs` command pending non-tunnel migration.

## Phase 1 - Security hardening (highest priority)

Goal: remove avoidable secret exposure risks and tighten local handling of tunnel credentials.

### Work items

1. Add safer token input methods for tunnel start/profile flows:
   - `--token-file <path>` — **done** (`resolveToken()` in `cli.js`)
   - `--token-stdin` — **done** (`resolveToken()` in `cli.js`)
2. Keep direct `--token` support (no deprecation messaging), but treat it as a plain input option. — **done**
3. Prevent token leakage in process args:
   - prefer `cloudflared tunnel run --token-file <path>` when available — **not started** (cloudflared-level change)
   - use environment-based passing only when strictly needed — **not started**
4. Redact secrets in all CLI outputs by default:
   - text output — **done** (`maskToken()` used everywhere)
   - JSON output — **done** (`redactProfileForOutput()` / `redactProfilesForOutput()`)
5. Add explicit opt-in for raw secret display in local-only debugging paths:
   - `--show-secrets` (default: off) — **done** (parsed in `parseArgs`, plumbed through profile commands)
6. Harden profile file access:
   - keep `0600` writes — **done** (was already present, confirmed)
   - warn/fail on unsafe file permissions when reading existing profile files — **done** (`warnIfUnsafeFilePermissions()`)
7. Enforce log redaction policy:
   - never print full token in success, warning, error, or exception paths — **done** (all output paths use `maskToken()`)

### Acceptance criteria

- No tunnel token appears in normal CLI output or logs. — **met** (all text/JSON paths redact)
- No tunnel token appears in spawned process argument lists. — **not yet met** (cloudflared still receives token via args)
- Profile reads detect and report unsafe file permissions. — **met** (`warnIfUnsafeFilePermissions()`)

### Remaining Phase 1 work

- Pass token to cloudflared via `--token-file <tmpfile>` or environment variable instead of command-line argument.

## Phase 2 - CLI UX and automation maturity

Goal: make tunnel CLI predictable for humans and reliable for scripts.

### Work items

1. Introduce structured error categories and stable exit codes: — **done**
   - `EXIT_CODE` constants: `SUCCESS(0)`, `GENERAL_ERROR(1)`, `USAGE_ERROR(2)`, `MISSING_DEPENDENCY(3)`, `AUTH_CONFIG_ERROR(4)`, `NETWORK_RUNTIME_ERROR(5)`
   - `TunnelCliError` class with `exitCode` property
2. Improve command discoverability: — **done**
   - unknown subcommand suggestions via `findClosestMatch()` (Levenshtein distance)
   - actionable "next command" hints after profile add (`Hint: start this profile with ...`)
3. Add `--dry-run` for state-changing tunnel operations where feasible: — **partially done**
   - `tunnel profile add --dry-run` — **done** (validates inputs, shows planned action, no mutation)
   - `tunnel start --dry-run` — **not started**
4. Add script-focused output controls: — **done**
   - `--plain` — suppresses colors/decorations (`HAS_PLAIN_FLAG` + `STYLE_ENABLED` gating)
   - `--quiet` / `-q` — suppresses non-essential output (`options.quiet` checks in profile commands)
5. Add shell completion support: — **done**
   - `generateCompletionScript()` for Bash, Zsh, and Fish
   - `openchamber tunnel completion bash|zsh|fish`

### Acceptance criteria

- Exit codes are documented and covered by tests. — **partially met** (constants defined, tests not yet added)
- `--dry-run` performs no state mutation. — **met** (for profile add; tunnel start not yet implemented)
- Completion scripts work for at least Bash and Zsh. — **met** (Bash, Zsh, Fish all implemented)

### Remaining Phase 2 work

- Add `--dry-run` for `tunnel start`.
- Add exit-code documentation (help text or man page).
- Extend `--quiet` support to all tunnel subcommands (currently only profile commands).

## Phase 2c - Interactive UX with clack capabilities

Goal: leverage the full `@clack/prompts` API surface to make the tunnel CLI interactive, responsive, and safe.

Dependency: Phase 2b must be complete (`@clack/prompts` installed, adapter module in place). — **met**

### Work items (ordered by impact)

1. Add `spinner()` to `tunnel start`: — **done**
   - Animated spinner during the up-to-60s cloudflared startup wait.
   - `spinner.stop()` on success, `spinner.error()` on failure/timeout.
   - Gated on `!json && !quiet && isTTY`.

2. Add `spinner()` to `tunnel doctor`: — **done**
   - Spinner wraps port discovery and provider diagnostics.
   - Updates message per-provider (`Diagnosing ☁ cloudflare...`).
   - Stops before rendering results.

3. Add `confirm()` for destructive operations: — **done**
   - `tunnel stop --all` — prompts "Stop tunnels on all N instances?" (skipped with `--force`, `--json`, `--quiet`, non-TTY).
   - `tunnel profile add` when profile exists — prompts "Overwrite?" instead of hard error (falls back to error in non-TTY).

4. Add `select()` for interactive mode/profile selection: — **done**
   - `tunnel start` without `--mode` or `--profile` in TTY — if saved profiles exist, offers profile picker; otherwise offers mode picker from provider capabilities.
   - Mode picker shows key, label, and required fields as hints.
   - Non-TTY falls through to existing defaults (`quick`).

5. Add `password()` for interactive token input: — **done**
   - `tunnel start --mode managed-remote` without token in TTY — masked password prompt.
   - `tunnel profile add` without token in TTY — masked password prompt.
   - Non-TTY: errors as before requiring `--token-file` or `--token-stdin`.

6. Add `box()` for tunnel warnings: — **done**
   - Security warning box when `--token` flag is used directly in TTY (token visible in shell history/process list).
   - Server-side `printTunnelWarning()` deferred to future server formatting migration.

7. Add `tasks()` to `tunnel doctor`: — **deferred**
   - Spinner-based approach (item 2) provides sufficient feedback.
   - Full `tasks()` integration deferred to a future pass if needed.

8. Add `cancel()` for Ctrl+C handling: — **done**
   - Global SIGINT handler shows styled "Operation cancelled." via `cancel()`.
   - Exit code 130 (standard SIGINT convention).
   - All interactive prompts also handle cancellation via `isCancel()` guard.

### Constraints

- All interactive prompts (confirm, select, password) must be TTY-only.
- Non-TTY paths (CI, piped output) must not hang waiting for input.
- `--json`, `--quiet`, `--force` flags bypass interactive prompts.
- `--plain` disables styled output but interactive prompts still function.

### Acceptance criteria

- `tunnel start` shows animated feedback during startup in TTY.
- Destructive operations prompt for confirmation in TTY (skippable with `--force`).
- Interactive mode/profile selection works when flags are omitted in TTY.
- Token can be entered securely via interactive masked prompt.
- All commands degrade gracefully in non-TTY environments.
- Ctrl+C produces a clean styled cancellation message.

## Phase 2d - Tunnel doctor UX overhaul

Goal: replace the broken, cluttered doctor command with a clean, scannable diagnostic view backed by a real server endpoint.

### Background

The `/api/openchamber/tunnel/doctor` endpoint was never implemented on the server. Every `openchamber tunnel doctor` invocation hits the SPA HTML fallback and shows a misleading error. The CLI rendering code (130+ lines) is dead code designed for a response shape that no server produces.

Additionally the original CLI design had UX problems:
- Port-centric view with duplicated hints per port.
- "No additional mode-specific requirements" noise for passing modes.
- No visual separation between provider checks and per-mode readiness.
- Two separate sections (Port Availability + Tunnel Doctor) that should be one unified view.

### Server-side: new `GET /api/openchamber/tunnel/doctor` endpoint

**File:** `packages/web/server/index.js`

**Route:** `GET /api/openchamber/tunnel/doctor?provider=<id>`

**Checks (light runtime):**
1. `dependency` — run `checkCloudflaredAvailable()` (already exists in `cloudflare-tunnel.js`)
2. `network` — run `checkCloudflareApiReachability()` (already exists in `cloudflare-tunnel.js`)
3. Per-mode readiness — for each mode in provider capabilities:
   - `quick` — always ready if provider available
   - `managed-remote` — check if token and hostname are configured
   - `managed-local` — check if config path is set/accessible

**Response shape:**

```json
{
  "ok": true,
  "provider": "cloudflare",
  "providerChecks": [
    { "id": "dependency", "label": "cloudflared installed", "status": "pass", "detail": "v2024.12.1" },
    { "id": "network", "label": "Cloudflare API reachable", "status": "pass", "detail": null }
  ],
  "modes": [
    { "mode": "quick", "ready": true, "blockers": [] },
    { "mode": "managed-remote", "ready": false, "blockers": ["token not configured", "hostname not configured"] },
    { "mode": "managed-local", "ready": true, "blockers": [] }
  ]
}
```

When provider dependency fails, mode checks are skipped (meaningless without the binary). Network check still runs to give full picture.

### CLI-side: rewritten rendering

**Design principles:**
- Single `Tunnel Doctor` section (not two).
- Port display: inline one-liner for single-port case, sub-group with one shared hint for multi-port.
- Provider checks as compact one-liners (`◇  cloudflared installed — v2024.12.1`).
- Mode readiness: one line per mode. Only expand blocker detail on failures.
- No "No additional requirements" lines.
- Spinner wraps the HTTP calls (reuses Phase 2c work).

**Single CLI port, all good:**
```
┌  Tunnel Doctor
│
◇  port 3000 — CLI (available)
│
◆  Provider: ☁ cloudflare
◇  cloudflared installed — v2024.12.1
◇  Cloudflare API reachable
│
◆  Modes
◇  quick — Ready
◇  managed-remote — Ready
◇  managed-local — Ready
│
└  Done
```

**Multi-port with desktop:**
```
┌  Tunnel Doctor
│
◆  Ports
◇  3000 — CLI (available)
◇  3001 — CLI (available)
✗  52110 — Desktop (tunneling not supported)
│
│  Only CLI instances (openchamber serve) support tunneling.
│
◆  Provider: ☁ cloudflare
◇  cloudflared installed — v2024.12.1
◇  Cloudflare API reachable
│
◆  Modes
◇  quick — Ready
✗  managed-remote — Not ready
│    token not configured
│    hostname not configured
◇  managed-local — Ready
│
└  Done
```

**No cloudflared:**
```
┌  Tunnel Doctor
│
◇  port 3000 — CLI (available)
│
◆  Provider: ☁ cloudflare
✗  cloudflared not installed
│    Install with: brew install cloudflared
│
└  Done (1 blocker)
```

### Dead code to remove

- `getDoctorModeReports()` — replaced by new response shape.
- `getDoctorProviderChecks()` — replaced by direct field access.
- `normalizeDoctorSummary()` — mode readiness is now a simple boolean.
- `isValidTunnelDoctorResponse()` — new response shape, new validation.
- `DOCTOR_PROVIDER_CHECK_IDS` constant — no more provider/mode check deduplication.

### JSON output shape (`--json`)

```json
{
  "ports": [
    { "port": 3000, "type": "cli", "available": true },
    { "port": 52110, "type": "desktop", "available": false }
  ],
  "provider": {
    "id": "cloudflare",
    "checks": [
      { "id": "dependency", "status": "pass", "detail": "v2024.12.1" },
      { "id": "network", "status": "pass", "detail": null }
    ]
  },
  "modes": [
    { "mode": "quick", "ready": true, "blockers": [] },
    { "mode": "managed-remote", "ready": false, "blockers": ["token not configured", "hostname not configured"] },
    { "mode": "managed-local", "ready": true, "blockers": [] }
  ]
}
```

### Doctor flag forwarding and pass details (March 2026)

CLI forwards relevant flags to the doctor endpoint for targeted validation:

- `--config <path>` → `?configPath=<path>` — validates managed-local against a specific config file.
- `--hostname <host>` → `?managedRemoteTunnelHostname=<host>` — validates managed-remote hostname.
- `--token <value>` / `--token-file` / `--token-stdin` → `?managedRemoteTunnelToken=<value>` — validates managed-remote token.

Without these flags, doctor validates against saved settings and defaults (e.g. `~/.cloudflared/config.yml` for managed-local).

Passing modes show a compact detail from the first meaningful check:
- `quick — Ready`
- `managed-remote — Ready (app.example.com)`
- `managed-local — Ready (/Users/.../.cloudflared/config.yml (hostname.example.com))`

Section headers use `━━` thick horizontal rules for clear visual separation:
```
│  ━━ Modes ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Acceptance criteria

- `openchamber tunnel doctor` produces structured, scannable output.
- No duplicated hints or noise lines.
- Provider dependency failure short-circuits mode checks.
- Network reachability check runs as a light runtime probe.
- JSON output matches the new response shape.
- Dead helper functions removed.
- Doctor forwards `--config`, `--hostname`, `--token` to the server endpoint for targeted validation.
- Passing modes show key detail (config path, hostname) for user confidence.

## Phase 3 - Quality gates and regression safety

Goal: lock in reliability for security-sensitive and UX-critical behavior.

### Work items

1. Expand CLI tests for secret handling:
   - redaction in text output
   - redaction in JSON output
   - `--show-secrets` opt-in behavior
2. Add tests for token input paths:
   - `--token`
   - `--token-file`
   - `--token-stdin`
3. Add tests that assert no token is passed in unsafe ways to child process args.
4. Add exit-code contract tests and error-shape snapshot tests.
5. Add regression fixtures for representative tunnel workflows:
   - ready/doctor/status
   - start/stop
   - profile list/show/add/remove

### Acceptance criteria

- New tests cover all credential input paths and redaction paths.
- CI fails on output regressions that expose secret values.
- Tunnel command UX and error contracts remain stable across releases.

### Status

Phase 3 work has not started. It depends on Phase 1 and Phase 2 being finalized.

## Suggested delivery order

1. Phase 1 (security hardening) — **mostly complete**, remaining: cloudflared token-file passing
2. Phase 2 (UX/automation) — **mostly complete**, remaining: tunnel start dry-run, quiet flag coverage, exit-code docs
3. Phase 2b (output formatting) — **complete**
4. Phase 2c (interactive UX) — **complete** (7 of 8 items done, tasks() deferred)
5. Phase 2d (doctor UX overhaul) — **not started**
6. Phase 3 (quality gates) — **not started**
