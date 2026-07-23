# CLI Module Map

This directory contains the non-entrypoint implementation for the OpenChamber CLI. `packages/web/bin/cli.js` should stay thin: it owns bootstrap, command wiring, top-level dispatch, signal/cancel handling, and compatibility exports. Domain logic belongs in these modules.

## Entrypoint Boundary

- `../cli.js`
  - Owns process bootstrap, package/version lookup, command table wiring, signal handlers, top-level error handling, and legacy exports used by tests or external consumers.
  - Injects runtime dependencies into command factories, such as `serveCommand`, `stopCommand`, package-manager loading, cancel cleanup, and foreground server state setters.
  - Should not grow command-specific behavior. If a new branch needs more than dispatch/wiring, move it here into a command or helper module instead.

## Command Modules

Command modules implement user-facing commands and preserve output contracts across interactive, non-TTY, `--quiet`, and `--json` modes. They should use `../cli-output.js` for presentation helpers and keep safety validation in command logic, not prompts.

- `commands-serve.js`
  - Implements `openchamber serve`.
  - Owns OpenCode CLI checks, port resolution, log rotation, PID/instance registry writes, foreground/background server launch, startup summaries, and foreground shutdown behavior.

- `commands-lifecycle.js`
  - Implements `openchamber stop` and `openchamber restart`.
  - Owns lifecycle stop/restart semantics, desktop-managed port rejection, unmanaged instance shutdown attempts, PID/instance cleanup, and restart reuse of stored instance options.

- `commands-status.js`
  - Implements `openchamber status`.
  - Formats discovered instances and tunnel readiness/status for human, quiet, and JSON output.

- `commands-session.js`
  - Implements `openchamber session create`, `list`, `status`, and `messages`.
  - Uses OpenChamber session orchestration for create/worktree/prompt flows, including optional Goal Mode, and official directory-scoped OpenCode APIs for authoritative status and text-only message reads.
  - Message projection matches Export Markdown semantics: only ordered `text` parts are exposed; tool, reasoning, file, and other parts are omitted.
  - `--wait` composes with create and messages. Create waits through the initial idle race until activity is observed or a newly completed assistant message exists; `--last-assistant` returns that text in the same result. Wait timeouts are explicit failures and never fabricate an idle result.

- `commands-schedule.js`
  - Implements scheduled task status/list/create/run/delete/enable/disable.
  - Resolves projects by id or directory and supports normal or goal-enabled task execution.

- `commands-models.js`
  - Prints OpenChamber default, favorite, and recent model settings.

- `commands-projects.js`
  - Prints configured project labels, ids, and directories for later control-plane calls.

- `commands-logs.js`
  - Implements `openchamber logs`.
  - Resolves log files, tails recent lines, and follows log output.

- `commands-startup.js`
  - Implements `openchamber startup`.
  - Handles startup subcommand dispatch and presentation around the lower-level startup service helpers.

- `commands-connect-url.js`
  - Implements `openchamber connect-url`.
  - Finds or starts a local instance and prints the browser/connect URL according to the selected output mode.
  - Emits a **pairing v2** link (`openchamber://connect?v=2&p=<base64url>`): it creates a one-time pairing session in the shared store (`client-pairing-sessions.json`) and encodes the pairing id + secret + transport candidates. The client redeems the secret over whichever candidate connects first (`/api/client-auth/pairing/redeem`). No standalone token is embedded — the QR itself is the single-use credential.
  - The default form advertises the resolved server URL as a direct (lan/tunnel) candidate and folds in a relay candidate when the host relay is enabled, so one link works on-LAN and off-network.
  - `--relay` builds a relay-only pairing link (the sole candidate is the relay transport), for sharing with a device that is not on the host's network — no server URL, no auto-start. The relay endpoint follows `OPENCHAMBER_RELAY_URL` / the stored setting / the default, matching the running host; the host must be running with the relay enabled to serve the redeem over the tunnel.

- `commands-update.js`
  - Implements `openchamber update`.
  - Loads the package-manager helper, performs update flow, and coordinates restart behavior after updates.

- `commands-tunnel.js`
  - Implements `openchamber tunnel` and its subcommands: `profile`, `providers`, `ready`, `doctor`, `status`, `start`, `stop`, and `completion`.
  - Owns tunnel-specific command flow, interactive prompt decisions, managed-local/managed-remote startup, QR display rules, tunnel start/stop API calls, and tunnel profile command handling.
  - Receives `serveCommand` and `stopCommand` by dependency injection. Do not reach back into `cli.js` command globals from this module.

## Shared Helper Modules

These modules hold reusable, non-presentational logic for commands.

- `cli-args.js`
  - Argument parsing, defaults, help text, completion script generation, and typo suggestions.

- `cli-errors.js`
  - CLI exit codes and typed tunnel CLI errors.

- `cli-paths.js`
  - Data, run, log, settings, tunnel profile, and managed-local config paths.

- `cli-process.js`
  - PID files, instance registry files, process identity checks, runtime metadata checks, and process termination helpers.

- `cli-lifecycle.js`
  - Instance discovery, live health probing, attachability checks, provider discovery, and status aggregation used by lifecycle/status/tunnel commands.

- `cli-http.js`
  - HTTP helpers for health checks, shutdown requests, JSON API calls, tunnel provider fetches, and system info fetches.
  - Owns local desktop bearer auth and managed CLI-instance UI password retry for control-plane requests.

- `cli-api-target.js`
  - Resolves the target OpenChamber runtime for control-plane commands, preferring desktop unless a port is explicit.

- `cli-projects.js`
  - Loads configured projects through the settings API and resolves an exact directory to its project id.

- `cli-goal.js`
  - Owns shared Goal Mode token-budget validation for session and schedule commands.

- `cli-network.js`
  - Host resolution, URL building, LAN detection, unsafe browser port validation, and UI password/network exposure checks.

- `cli-ports.js`
  - Port availability checks and available-port resolution.

- `cli-log-files.js`
  - Log rotation, tail reads, and file-follow streaming.

- `cli-executables.js`
  - Executable path resolution and PATH lookup helpers.

- `cli-startup.js`
  - Native startup service detection, install/uninstall/status helpers, and platform-specific startup command execution.

- `cli-tunnel-profiles.js`
  - Tunnel profile normalization, token resolution/redaction, profile storage, migration, file-permission warnings, and managed-remote pair persistence.

- `cli-tunnel-utils.js`
  - Tunnel-specific command string builders, TTL parsing/formatting, and replay command helpers.

- `cli-tunnel-capabilities.js`
  - Built-in tunnel provider capability fallbacks used when a live server cannot provide tunnel metadata.

## Placement Rules

- Add new CLI commands as `commands-*.js` modules and wire them from `cli.js`.
- Add reusable logic to the narrow helper module that owns the domain. Create a new helper module before mixing unrelated domains into an existing one.
- Keep command modules responsible for user-visible behavior and mode-specific output. Keep helper modules mostly output-free unless the helper exists specifically for CLI rendering.
- Preserve output contracts when moving code:
  - `--json` emits JSON only.
  - `--quiet` emits concise essential output.
  - Prompts are gated by `canPrompt(options)`.
  - Validation and policy run in every mode.
- Prefer dependency injection from `cli.js` for cross-command behavior, especially when one command needs another command's implementation.
- Do not import `cli.js` from modules in this directory. The dependency direction is `cli.js` -> command modules -> helper modules.

## Verification

For CLI behavior changes, run the focused CLI suite from `packages/web`:

```sh
bun run test -- bin/cli.test.js
```

Before finalizing source changes that affect CLI behavior, also run:

```sh
bun run type-check
bun run lint
```
