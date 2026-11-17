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
  - Implements `openchamber stop`, `openchamber restart`, and `openchamber rotate-credentials`.
  - Owns lifecycle stop/restart semantics, desktop-managed port rejection, unmanaged instance shutdown attempts, PID/instance cleanup, and restart reuse of stored instance options.
  - Rotation stops through the same SIGINT path as `stop`, then serves with `rotateCredentials`, which `commands-serve.js` passes to the server as the one-shot `OPENCHAMBER_ROTATE_MANAGED_CREDENTIALS` flag; the server discards the saved managed OpenCode password and agent tool token for that start and writes a fresh pair. The command never reads or prints credential values. Foreground instances are only stopped: the stop clears the saved state, so the process manager's restart generates the fresh pair.

- `commands-status.js`
  - Implements `openchamber status`.
  - Formats discovered instances and tunnel readiness/status for human, quiet, and JSON output.

- `commands-session.js`
  - Implements `openchamber session create`, `send`, `fork`, `list`, `status`, and `messages`.
  - Maps CLI options to shared control-service inputs and owns only human, quiet, and JSON presentation.
  - Message projection matches Export Markdown semantics: only ordered `text` parts are exposed; tool, reasoning, file, and other parts are omitted.
  - The server control service owns create/worktree/prompt orchestration, official OpenCode reads, Goal Mode, wait semantics, and partial failures.

- `commands-schedule.js`
  - Implements scheduled task status/list/create/run/delete/enable/disable.
  - Maps options to control-service inputs and renders results; project resolution, validation, persistence, and execution remain server-owned.

- `commands-models.js`
  - Prints OpenChamber default, favorite, and recent model settings.

- `commands-projects.js`
  - Prints configured project labels, ids, and directories for later control-plane calls.

- `commands-quota.js`
  - Implements `openchamber quota [provider ...]`.
  - Reads quota from the running OpenCode in-process: it wires the shared credential source (`server/lib/opencode/auth.js`) itself and calls the shared quota dispatcher (`server/lib/quota/index.js`), so no OpenChamber server needs to be running.
  - The OpenCode endpoint comes from the external-OpenCode settings only: `OPENCODE_HOST`, else `OPENCODE_PORT` on 127.0.0.1, else the default serve port 4096. The auth header is Basic `opencode:<OPENCODE_SERVER_PASSWORD>` when that variable is set, matching the server's auth-state runtime.
  - Provider arguments resolve against the shared provider catalogue (`listQuotaProviderCatalogue`): an argument matches a provider exactly by id, display name, or credential alias, case-insensitively, or as a `*` / `?` wildcard pattern over those fields. Several arguments run in argument order and a provider named more than once is fetched once. An exact match counts as an explicit ask, so it fetches a provider OpenCode has turned off; a wildcard expands over configured providers only and leaves turned off providers out unless `--all` is passed. An argument that resolves to nothing is a usage error (exit 2) raised before anything is fetched.
  - Without a provider it prints every configured provider, leaving out the ones OpenCode has turned off (`disabled_providers`) unless `--all` is passed. One provider's failure is printed inline and does not hide the others.
  - Providers with several stored credentials print one block per credential, labeled with the credential and the account it metered; `--quiet` prints one line per credential and `--json` keeps the same flat list of results with the labels attached. The exit code is 1 when a requested provider produced no successful result; a provider with at least one successful credential does not fail the run.
  - Credentials come from the running OpenCode through the shared source, with OpenCode's local store (`openCodeLocalCredentialSource` in `server/lib/opencode/auth.js`) behind it: the first transport failure — the server unreachable, as opposed to answering — switches the run's reads to the store file on this machine. Every result is stamped `credentialSource` (`server` or `local`); human and quiet modes also print one stderr note when the store served. A server that answers and refuses is never second-guessed with the store.
  - The combined source reports the connected server's launch environment only when that server source has one, which for the CLI means the server it launched itself. A loopback server another process started has none, so providers that resolve their own store (`readLocalOpenCodeCredentials`) get no location and skip the direct read. The CLI's shell environment stays with the fallback source: it is the environment a store read uses after a transport failure, where the result is stamped `local` (#1403).
  - Providers fetch in parallel with bounded concurrency (6), in argument/listing order in the output. Each fetch has a per-provider timeout (`OPENCHAMBER_QUOTA_TIMEOUT_MS`, default 10000): a provider that outlives it answers a `status: 'timeout'` row instead of holding the run, and every result carries its `elapsedMs`.

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
  - `--relay` builds a relay-only pairing link (the sole candidate is the relay transport), for sharing with a device that is not on the host's network — no server URL, no auto-start. The relay endpoint follows the administrator's pin (`pinnedRelayUrl`: policy file, then `OPENCHAMBER_RELAY_URL`) / the stored setting / the default, matching the running host; the host must be running with the relay enabled to serve the redeem over the tunnel.

- `commands-update.js`
  - Implements `openchamber update`.
  - Loads the package-manager helper, performs update flow, and coordinates restart behavior after updates.
  - Installs the exact version returned by the update check and verifies the globally installed version after the package manager exits; a zero exit status without the target version is a loud failure, not a success report (#3083).

- `commands-tunnel.js`
  - Implements `openchamber tunnel` and its subcommands: `profile`, `providers`, `ready`, `doctor`, `status`, `start`, `stop`, and `completion`.
  - Owns tunnel-specific command flow, interactive prompt decisions, managed-local/managed-remote startup, QR display rules, tunnel start/stop API calls, and tunnel profile command handling.
  - Receives `serveCommand` and `stopCommand` by dependency injection. Do not reach back into `cli.js` command globals from this module.

## Shared Helper Modules

These modules hold reusable, non-presentational logic for commands.

- `cli-args.js`
  - Argument parsing, defaults, help text, completion script generation, and typo suggestions.
  - `COMMAND_OWNED_FLAGS` lists flags only one family of commands reads (schedule, session, tunnel, logs). Such a flag on any other command is an `Unknown option for <command>` error in every output mode instead of being ignored; global and shared flags are not listed and stay accepted everywhere. Add a new command-specific flag there.

- `cli-errors.js`
  - CLI exit codes and typed tunnel CLI errors.

- `cli-paths.js`
  - Data, run, log, settings, tunnel profile, and managed-local config paths.

- `cli-settings-accessors.js`
  - Minimal settings.json read/write for CLI contexts that must not load the
    full web settings runtime (`connect-url` relay identity resolution).
  - Mirrors the settings runtime's guarantees so a CLI read-modify-write can
    never corrupt shared state: atomic tmp+rename writes (no concurrent reader
    in the running app can observe a torn file), a strict read that throws on
    corrupt/unreadable payloads, and the same `0600` file mode.
  - The strict read gates relay identity regeneration exactly like the server
    runtime (`server/lib/relay/key-store.js`, which may still find legacy keys
    in settings.json): a swallowed read failure can never mint a replacement
    signing or encryption keypair, which would change `serverId` and orphan
    every paired device and push binding.

- `cli-process.js`
  - PID files, instance registry files, process identity checks, runtime metadata checks, and process termination helpers.

- `cli-lifecycle.js`
  - Instance discovery, live health probing, attachability checks, provider discovery, and status aggregation used by lifecycle/status/tunnel commands.

- `cli-http.js`
  - HTTP helpers for health checks, shutdown requests, JSON API calls, tunnel provider fetches, and system info fetches.
  - Owns local desktop bearer auth and managed CLI-instance UI password retry for control-plane requests.

- `cli-control.js`
  - Sends one typed action request to the authenticated OpenChamber control endpoint and maps HTTP failures to CLI exit behavior.
  - Must not reproduce session, scheduled-task, project-resolution, or wait orchestration.

- `cli-api-target.js`
  - Resolves the target OpenChamber runtime for control-plane commands, preferring desktop unless a port is explicit.

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
  - The service runs the CLI by its resolved path. A pnpm global install resolves into a versioned `.pnpm` store directory that an update leaves behind, so the entrypoint is mapped back to the stable `node_modules/@openchamber/web` link when it exists.
  - The macOS LaunchAgent leaves `ProcessType` unset so launchd does not force the managed OpenCode child into background-tier scheduling. Re-running `startup enable` replaces an existing plist.
  - The environment snapshot drops the variables a running OpenChamber put into the enabling shell, read from the `OPENCHAMBER_INJECTED_ENV` record (`server/lib/injected-env.js`), so a service enabled from the desktop app's terminal or an agent's shell does not inherit that instance's runtime flags, UI password, or managed OpenCode password (#4604). The user's own exports, `OPENCODE_HOST` included, still carry over. `cli-args.js` applies the same record to the `OPENCHAMBER_UI_PASSWORD` default.

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
