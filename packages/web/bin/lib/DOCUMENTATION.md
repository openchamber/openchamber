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

- `commands-logs.js`
  - Implements `openchamber logs`.
  - Resolves log files, tails recent lines, and follows log output.

- `commands-startup.js`
  - Implements `openchamber startup`.
  - Handles startup subcommand dispatch and presentation around the lower-level startup service helpers.

- `commands-connect-url.js`
  - Implements `openchamber connect-url`.
  - Finds or starts a local instance and prints the browser/connect URL according to the selected output mode.

- `commands-update.js`
  - Implements `openchamber update`.
  - Loads the package-manager helper, performs update flow, and coordinates restart behavior after updates.

- `commands-tunnel.js`
  - Implements `openchamber tunnel` and its subcommands: `profile`, `providers`, `ready`, `doctor`, `status`, `start`, `stop`, and `completion`.
  - Owns tunnel-specific command flow, interactive prompt decisions, managed-local/managed-remote startup, QR display rules, tunnel start/stop API calls, and tunnel profile command handling.
  - Receives `serveCommand` and `stopCommand` by dependency injection. Do not reach back into `cli.js` command globals from this module.

- `commands-session.js`
  - Implements `openchamber session` and its actions: `list`, `show`, `rename`, `archive`, `unarchive`, `share`, `unshare`, and `delete`.
  - Mirrors the app's session read/mutation menu functions by talking to a running instance over HTTP (via `cli-api-client.js`). Scopes to the project directory (`--directory`, default cwd), gates deletion behind confirmation/`--force` in every mode, and preserves `--json`/`--quiet` contracts.
  - Session creation and initial-prompt dispatch are intentionally excluded: OpenChamber-owned session orchestration (`/api/openchamber/sessions`) is the source of truth for creating sessions and dispatching the first prompt.

- `commands-resources.js`
  - Implements the config/settings resource commands that mirror the Settings menus: `agent`, `command` (slash commands), `skill`, `mcp`, `snippet`, `provider`, `project`, and `config`.
  - Each group exposes read actions (`list`/`show`/`models`/`get`) and, where the server supports it, safe `create`/`delete` mutations. Shared `renderList`/`renderMutation`/`confirmDestructive` helpers keep output and validation consistent across modes.

- `commands-schedule.js`
  - Implements `openchamber schedule` and its actions: `list`, `show`, `create`, `run`, `enable`, `disable`, `delete`, and `status`. Mirrors the scheduled-tasks menu functions over the per-project `/api/projects/:projectId/scheduled-tasks` routes plus the global `/api/openchamber/scheduled-tasks/status`.
  - Resolves the OpenChamber project via `resolveProjectId` (explicit `--project`, scope directory, active project, or sole project) and builds schedule objects (daily/weekly/once/cron) from flags. Destructive `delete` is gated by confirmation/`--force` in every mode.

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

- `cli-api-client.js`
  - Transport layer for resource commands. Resolves the target instance port (explicit `--port` or single-instance discovery, failing deterministically on none/ambiguous), performs authenticated JSON requests against a running server (throwing `ApiError` on non-2xx so failures are mode-agnostic), and resolves the project scope directory.

- `cli-format.js`
  - Pure presentation helpers shared by resource commands: string truncation, relative-time formatting, and provider/model identifier formatting. Contains no validation or policy.

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
