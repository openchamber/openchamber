# CLI Module Map

This directory contains the command implementation for the OpenChamber CLI.
`bin/cli.js` registers checkout source resolution before dynamically loading
`bin/cli-runtime.ts`, which owns command wiring, dispatch and process handlers.
Domain logic belongs in these modules.

## Entrypoint Boundary

Checkout commands run `bin/cli.js` with Bun, including `start:web` and the
behavior-verification stand. Published commands run `build/bin/cli.js`.
Each CLI loads its own sibling server tree, so both paths work without a stale
build entering the development loop.
The package also ships `bin/cli.js` as a compatibility entry for startup
services created before the build directory existed. It forwards execution to
the built CLI so those services survive an upgrade.

- `../cli.js`
  - Keeps the package bin, shebang and legacy exports. Its static imports are Node builtins, so the source resolver runs before the CLI graph links.
- `../cli-runtime.ts`
  - Owns package/version lookup, command table wiring, signal handlers and top-level error handling. Execution detection uses the original `cli.js` URL, including symlinked `openchamber` executables.
  - Injects runtime dependencies into command factories, such as `serveCommand`, `stopCommand`, package-manager loading, cancel cleanup, and foreground server state setters.
  - Should not grow command-specific behavior. If a new branch needs more than dispatch/wiring, move it here into a command or helper module instead.
  - The Windows Bun probe uses `%BUN_INSTALL%\bin\bun.exe`. `spawnSync` does not append the extension to an explicit path, so a probe without it fails and the CLI silently falls back to Node.

- `../cli-output.js`
  - Terminal output adapter over `@clack/prompts`.
  - `canPrompt` requires both stdout and stdin to be TTYs: prompts must be disabled when stdin is piped (`--token-stdin`), even on a terminal stdout.

## Command Modules

Command modules implement user-facing commands and preserve output contracts across interactive, non-TTY, `--quiet`, and `--json` modes. They should use `../cli-output.js` for presentation helpers and keep safety validation in command logic, not prompts.

- `commands-serve.ts`
  - Implements `openchamber serve`.
  - Owns OpenCode CLI checks, port resolution, log rotation, PID/instance registry writes, foreground/background server launch, startup summaries, and foreground shutdown behavior.
  - The effective UI password is resolved before either launch path, so a password generated for `--ui-password` with no value is in the server environment before it spawns and in the instance state file that restart and status read.
  - In `--quiet`, a generated password is result data: it is part of the one-line output as `<port> pass:<password>`, the same token form `status --quiet` uses. A configured password is never echoed. In foreground `--quiet` mode the server's stdout/stderr go to the log file so runtime output cannot pollute that line, and CLI output writes through a saved reference to the real stream. Human mode leaves stdout/stderr inherited and closes the log fd.
  - A server started from another OpenChamber's shell does not record `OPENCODE_BINARY` as injected, so a startup service enabled from that terminal keeps the same OpenCode binary.

- `commands-lifecycle.ts`
  - Implements `openchamber stop` and `openchamber restart`.
  - Owns lifecycle stop/restart semantics, desktop-managed port rejection, unmanaged instance shutdown attempts, PID/instance cleanup, and restart reuse of stored instance options.
  - `restart` of a foreground instance stops it and records success. A process manager (systemd, Docker) starts it again; calling `serve()` here would race the manager with a second copy.

- `commands-status.ts`
  - Implements `openchamber status`.
  - Formats discovered instances and tunnel readiness/status for human, quiet, and JSON output.
  - `bindHost` is the address the server was asked to bind, not the host a probe answered on: a server bound to `0.0.0.0` also answers on loopback.

- `commands-session.ts`
  - Implements `openchamber session create`, `send`, `fork`, `list`, `status`, and `messages`.
  - Maps CLI options to shared control-service inputs and owns only human, quiet, and JSON presentation.
  - A `--wait` that ends because the session waits for the user exits non-zero, with a line on stderr outside `--json`.
  - Message projection matches Export Markdown semantics: only ordered `text` parts are exposed; tool, reasoning, file, and other parts are omitted.
  - The server control service owns create/worktree/prompt orchestration, official OpenCode reads, Goal Mode, wait semantics, and partial failures.

- `commands-schedule.ts`
  - Implements scheduled task status/list/create/update/run/delete/enable/disable.
  - Maps options to control-service inputs and renders results; project resolution, validation, persistence, and execution remain server-owned.
  - `update` sends only the flags given; `--goal` and `--disabled` go out only when present, as `true`. `--target-session` names an existing session on `create` and `update` only; on any other schedule action, or with a missing or empty inline value, it is a parse error. On `update`, a value flag given without a value (`--prompt`, `--name`, schedule selectors, `--model`, `--agent`, `--variant`, `--timezone`, `--goal-token-budget`) is a parse error rather than a dropped change.
  - `enable` and `disable` report the state the server saved, never the requested one.

- `commands-models.ts`
  - Prints OpenChamber default, favorite, and recent model settings.

- `commands-projects.ts`
  - Prints configured project labels, ids, and directories for later control-plane calls.

- `commands-logs.ts`
  - Implements `openchamber logs`.
  - Resolves log files, tails recent lines, and follows log output.

- `commands-startup.ts`
  - Implements `openchamber startup`.
  - Handles startup subcommand dispatch and presentation around the lower-level startup service helpers.

- `commands-connect-url.ts`
  - Implements `openchamber connect-url`.
  - Finds or starts a local instance and prints the browser/connect URL according to the selected output mode.
  - Emits a **pairing v2** link (`openchamber://connect?v=2&p=<base64url>`): it creates a one-time pairing session in the shared store (`client-pairing-sessions.json`) and encodes the pairing id + secret + transport candidates. The client redeems the secret over whichever candidate connects first (`/api/client-auth/pairing/redeem`). No standalone token is embedded — the QR itself is the single-use credential.
  - `encodePairingConnectUrl` mirrors `encodePairingConnectionPayload` in `@openchamber/ui`, which the bin cannot import. Keep the two in sync: the payload is base64url JSON in the link query, so the one-time secret travels in the link, never the network.
  - The default form advertises the resolved server URL as a direct (`lan`/`tunnel`) candidate and adds the relay transport as a fallback candidate, so one link works on-LAN and off-network. Candidate priorities make the client prefer the direct route and try the relay last, mirroring the UI's "Anywhere" pairing. `--relay` adds the relay candidate even when the host relay is not up yet (the demand-driven lifecycle starts it); otherwise the relay rides along only when it is already enabled. A pairing session that carries a relay candidate is marked `usesRelay`, like the server route, so the lifecycle keeps the relay up while the link is pending.
  - A localhost server URL does not establish how the server is bound, and localhost can be intentional (including Windows-to-WSL forwarding), so the command warns about a localhost link instead of treating it as a misconfiguration.
  - The relay endpoint follows the administrator's pin (`pinnedRelayUrl`: policy file, then `OPENCHAMBER_RELAY_URL`) / the stored setting / the default, matching the running host; the host must be running with the relay enabled to serve the redeem over the tunnel.

- `commands-update.ts`
  - Implements `openchamber update`.
  - Loads the package-manager helper, performs update flow, and coordinates restart behavior after updates.
  - Installs the exact version returned by the update check and verifies the globally installed version after the package manager exits; a zero exit status without the target version is a loud failure, not a success report (#3083).
  - The restart comes last: an update run from a terminal inside the service ends with it. The version wait then catches a unit that still points at the deleted install or the old release.
  - An instance that is the startup service is not stopped before the install: its process manager would start the old release again while the package manager replaces its files. The service keeps running through the install, then the manager restarts it: `systemctl --user restart` on Linux, `launchctl kickstart -k` on macOS, a stop of the task and its server with a detached helper issuing `schtasks /Run` on Windows (#2542). The command then waits for `/health` to report the target version and fails with a pointer to `openchamber startup enable` when it does not, which is what a unit written by an older release looks like (#5793).
  - Which instance is the service comes from `findStartupServiceInstance` in `cli-startup.js`: the pid the manager reports (systemd's `MainPID`, launchd's job `PID`) settles it on Linux and macOS, and a missing pid there means the service is not running, so a foreground server on those platforms is a plain CLI copy. On Windows an instance is the service only when its pid is a child of the wrapper the running task started. A task that is missing, stopped or disabled owns nothing, so a manual foreground server stays a plain CLI copy, and a running task is found beside other foreground servers. Without this, an update on macOS or Windows stopped the service and started a detached copy beside it while launchd or the task brought the old one back (#5793's Linux fix never reached those platforms).
  - The Windows lookup can fail: PowerShell errors, or the task runs and no instance matches it, an empty discovery included, since discovery skips a server that does not answer its probe. The update then stops before it stops any instance or installs anything, and points at `openchamber startup disable`, because a wrong guess either kills the service or leaves it on the old release.

- `commands-tunnel.ts`
  - Implements `openchamber tunnel` and its subcommands: `profile`, `providers`, `ready`, `doctor`, `status`, `start`, `stop`, and `completion`.
  - Owns tunnel-specific command flow, interactive prompt decisions, managed-local/managed-remote startup, QR display rules, tunnel start/stop API calls, and tunnel profile command handling.
  - A public tunnel refuses an instance without a UI password, so an instance this command starts gets a generated one and shows it once. `--ui-password` cannot change a server that is already running, so an existing passwordless instance is a loud error carrying the stop/retry command.
  - The spinner is cleared rather than completed before the structured success output, so a started tunnel produces one `Tunnel started` report.
  - Receives `serveCommand` and `stopCommand` by dependency injection. Do not reach back into `cli.js` command globals from this module.

## Shared Helper Modules

These modules hold reusable, non-presentational logic for commands.

- `cli-args.ts`
  - Argument parsing, defaults, help text, completion script generation, and typo suggestions.
  - `COMMAND_OWNED_FLAGS` lists flags only one family of commands reads (schedule, session, tunnel, logs). Such a flag on any other command is an `Unknown option for <command>` error in every output mode instead of being ignored; global and shared flags are not listed and stay accepted everywhere. Add a new command-specific flag there.
  - `--port` accepts a leading `-` (`-p -1`) so an out-of-range value reaches the range check and reports a clear error instead of `Unknown option`. `--daemon` stays accepted as a no-op because daemon mode is the default and older clients still pass it.
  - An inline empty `--target-session=` (an empty shell variable) is missing like a bare flag and must not consume the next word as the target.

- `cli-errors.ts`
  - CLI exit codes and typed tunnel CLI errors.

- `cli-paths.ts`
  - Data, run, log, settings, tunnel profile, and managed-local config paths.

- `cli-settings-accessors.ts`
  - Minimal settings.json read/write for CLI contexts that must not load the
    full web settings runtime (`connect-url` relay identity resolution).
  - Mirrors the settings runtime's guarantees so a CLI read-modify-write can
    never corrupt shared state: atomic tmp+rename writes (no concurrent reader
    in the running app can observe a torn file), a strict read that throws on
    corrupt/unreadable payloads, and the same `0600` file mode.
  - On Windows a transient sharing violation on the rename (`EPERM`, `EACCES`,
    `EBUSY`) is retried and then falls back to copying the complete temp file
    into place. That copy is not atomic and exists only so persistence never
    wedges; other platforms always rename.
  - The strict read gates relay identity regeneration exactly like the server
    runtime (`server/lib/relay/key-store.js`, which may still find legacy keys
    in settings.json): a swallowed read failure can never mint a replacement
    signing or encryption keypair, which would change `serverId` and orphan
    every paired device and push binding.

- `cli-process.ts`
  - PID files, instance registry files, process identity checks, runtime metadata checks, and process termination helpers.
  - An accepted HTTP shutdown gets `SERVER_SHUTDOWN_GRACE_MS` (30 seconds) before PID termination. Stop and plain CLI update still fall back to PID termination immediately when the shutdown endpoint is unreachable. Windows task restart retains its 5-second wait after `/End` when HTTP shutdown fails.
  - `isProcessRunning` answers liveness only: "some process with this pid is alive". It is for a pid known to be ours (a child just spawned, a process being stopped), never for a pid read from a pid file. After an ungraceful shutdown the file is stale and the kernel may have recycled the pid; a liveness-only check then reports "already running" and aborts startup, which loops forever under systemd `Restart=always` (#1721). Pid-file validation uses `isOpenchamberProcessRunning` / `getOpenchamberProcessState`.
  - Identity cannot be determined on Windows or when `/proc` and `ps` are unreadable; there the check falls back to liveness, so those platforms get no false negatives.
  - The identity match looks for the `openchamber` path segment, not a generic `cli.js`: the npm package and the source checkout both contain it for the foreground and daemon entrypoints, while a recycled `npm-cli.js` or `agentmemory` does not.

- `cli-lifecycle.ts`
  - Instance discovery, live health probing, attachability checks, provider discovery, and status aggregation used by lifecycle/status/tunnel commands.
  - A live pid file is only the right instance when the recorded port also answers as OpenChamber. Command-line identity alone can match a recycled pid from another OpenChamber process on a different port. Probe all plausible hosts; when identity is matched or unknown but the port still cannot be confirmed, keep the registry files and report the instance as not running.

- `cli-http.ts`
  - HTTP helpers for health checks, shutdown requests, JSON API calls, tunnel provider fetches, and system info fetches.
  - Owns local desktop bearer auth and managed CLI-instance UI password retry for control-plane requests.
  - `requestJson` passes only `method`, `headers` and `body` to `fetch`. Control commands hand it their parsed CLI options, and Bun, which runs the CLI in the Docker image, reads `session` as its own fetch option and rejects `--session`.

- `cli-control.ts`
  - Sends one typed action request to the authenticated OpenChamber control endpoint and maps HTTP failures to CLI exit behavior.
  - Must not reproduce session, scheduled-task, project-resolution, or wait orchestration.
  - Every session create reserves the 6-minute provisioning HTTP window, including a retry in an existing checkout, because it can still await checkout setup before selection. The server keeps provisioning after the client gives up, so a shorter client timeout reported a failure for a worktree that was in fact created; the server allows a minute for git and three more for the project's setup commands. With `--wait`, the wait window is added to that provisioning window rather than overlapping it, because the server provisions before it starts waiting for idle. An explicit HTTP timeout remains authoritative.

- `cli-shell.ts`
  - Quotes replay arguments for PowerShell on Windows and POSIX shells elsewhere. Session recovery and tunnel replay commands share this formatter.

- `cli-api-target.ts`
  - Resolves the target OpenChamber runtime for control-plane commands, preferring desktop unless a port is explicit.

- `cli-goal.ts`
  - Owns shared Goal Mode token-budget validation for session and schedule commands.

- `cli-network.ts`
  - Host resolution, URL building, LAN detection, unsafe browser port validation, and UI password/network exposure checks.
  - Generated UI passwords use an alphabet without ambiguous characters so the printed password is easy to type from a phone or another machine.

- `cli-ports.ts`
  - Port availability checks and available-port resolution.

- `cli-log-files.ts`
  - Log rotation, tail reads, and file-follow streaming.

- `cli-executables.ts`
  - Executable path resolution and PATH lookup helpers.

- `cli-startup.ts`
  - Native startup service detection, install/uninstall/status helpers, and platform-specific startup command execution.
  - The service runs the CLI by its resolved path. A pnpm global install resolves into a versioned `.pnpm` store directory that an update leaves behind, so the entrypoint is mapped back to the stable `node_modules/@openchamber/web` link when it exists.
  - pnpm 11 and later install every global update into a new `global/v11/<dir>` and delete the old one; the link `global/v11/<hash>` beside it moves to each new directory, and pnpm's shim starts the CLI through it. When the CLI was started through that link, the service keeps the unresolved path, so a pnpm upgrade does not leave the unit pointing at a deleted directory (#5727).
  - The Windows restart in `restartWindowsStartupTask` starts a detached hidden PowerShell helper, runs `schtasks /End`, asks the server to shut down, allows the shared 30-second shutdown grace and stops it by pid if it stays. The helper issues `/Run` once the server is gone and the task has stopped, and gives up after 60 seconds, longer than that exit wait. A `/Run` on a running task does nothing, and a `/Run` before the old server releases the port starts a process that cannot bind it, so the helper waits for both. `/End` covers the program the task started, which is the PowerShell wrapper, so the server can outlive it and keep the port. The helper owns `/Run` because an update run from a terminal of this server dies with the shutdown, and nothing else would start the task; `/End` runs first because after the server exits it would end the new run. A failed `/End` with the server still up, or a server that does not exit, ends the update with the commands to finish by hand. A `/Run` that fails shows up as the version wait in `commands-update.js` failing.
  - Task Scheduler has no pid to ask for, so the task's processes are read from the task's own arguments: its state, the PowerShell wrapper whose command line contains those arguments, then that wrapper's children. When more than one process matches the wrapper command line, the task's own cannot be told apart, and the lookup reports no processes instead of guessing.
  - launchd prints no `PID` key while a job is not running, so a missing key means the service is not running, not an unknown state.
  - On Linux, `startup enable` restarts the unit after rewriting it. `enable --now` leaves a running service alone, so it kept the old unit and release while reporting `service active` (#5793). macOS already reloads the agent with `kickstart -k`.
  - `startup enable` reports systemd lingering from `loginctl show-user <user> -p Linger`. A `--user` service stops at logout without lingering, so the command warns that it may not survive logout. An unknown state (no username, no `loginctl`, odd output) is reported as unknown, never as off.
  - The macOS LaunchAgent leaves `ProcessType` unset so launchd does not force the managed OpenCode child into background-tier scheduling. Re-running `startup enable` replaces an existing plist.
  - The environment snapshot drops the variables a running OpenChamber put into the enabling shell, read from the `OPENCHAMBER_INJECTED_ENV` record (`server/lib/injected-env.js`), so a service enabled from the desktop app's terminal or an agent's shell does not inherit that instance's runtime flags, UI password, or managed OpenCode password (#4604). The user's own exports, `OPENCODE_HOST` included, still carry over. `cli-args.js` applies the same record to the `OPENCHAMBER_UI_PASSWORD` default. Shell and session variables (`PS1`-style prompts, `TERM`, `PWD`, virtualenv and conda state) are implementation details, not app configuration, so the snapshot drops them too.
  - The snapshot never holds `PATH`. The service starts with the platform default, and the server puts the login shell's `PATH` in front at start (`server/lib/opencode/env-runtime.js`), so a toolchain the user installed or removed after `startup enable` shows up in the terminal and agent commands. A saved `PATH` stayed in every child's `PATH` long after its folders were gone, and when the login-shell probe failed it was the whole `PATH`. A user who needs a fixed `PATH` entry for the service sets it as a user variable in Environment settings. The OpenCode check in `../cli.js` runs before the server, so when `opencode` is not on the default `PATH` (a saved `OPENCODE_BINARY` that moved, or none saved) it applies the login shell's environment and looks again.

- `cli-tunnel-profiles.ts`
  - Tunnel profile normalization, token resolution/redaction, profile storage, migration, file-permission warnings, and managed-remote pair persistence.

- `cli-tunnel-utils.ts`
  - Tunnel-specific command string builders, TTL parsing/formatting, and replay command helpers.

- `cli-tunnel-capabilities.ts`
  - Built-in tunnel provider capability fallbacks used when a live server cannot provide tunnel metadata.

## Placement Rules

- Add new CLI commands as `commands-*.js` modules and wire them from `cli.js`.
- Add reusable logic to the narrow helper module that owns the domain. Create a new helper module before mixing unrelated domains into an existing one.
- Keep command modules responsible for user-visible behavior and mode-specific output. Keep helper modules mostly output-free unless the helper exists specifically for CLI rendering.
- Preserve the mode output contract when moving code (`clack-cli-patterns`, *Mode Contract*).
- Prefer dependency injection from `cli.js` for cross-command behavior, especially when one command needs another command's implementation.
- Do not import `cli.js` from modules in this directory. The dependency direction is `cli.js` -> command modules -> helper modules.

## Decisions

### Why scheduled-task output uses the project contract

Task rendering uses the project's scheduled-task types. Those task, execution
and state records use type aliases with unchanged fields, so JSON output accepts
them without an unchecked index signature. Schedule representation and finite
goal-budget checks remain at the display boundary.

### Why session display fields remain unchecked

Session list formatting checks text at each use. Model aliases, variants and
status fields retain optional unchecked values; a non-null field view preserves
JavaScript property access on scalar values. Text-message formatting uses the
control service's exported projection type, whose timestamps and text are
checked when that service constructs the message.

### Why accepted shutdown gets a separate host grace period

Managed OpenCode can use 5 seconds for stdin EOF, followed by tree termination
and port cleanup. The host gets 30 seconds to finish that sequence. A 5-second
host deadline interrupted cleanup on Windows and produced exit code 1 from
`TerminateProcess` while `stop` reported success. A stuck host still gets killed
after the longer deadline.

### Why startup error messages remain unchecked

Startup command failures and injected task callbacks can throw values other
than `Error`. Their `message` field stays unknown until string interpolation;
inherited and non-string messages keep their existing output. A null or
undefined failure still raises the original property-access `TypeError`.

### Why startup lookup accepts an instance without a pid

Discovery can return a live server with a null pid. Service ownership preserves
the supplied instance shape and compares only its pid with the manager's numeric
process ids. A null pid never matches the Windows task's process list.

### Why startup checks process text before parsing

An ignored or inherited child-process output stream can have null stdout.
The lingering parser retains its string check before using string methods.
The other process-output parsers keep their existing string coercion and regex
acceptance rules. Regex capture defaults cover only slots that their matching
patterns always populate.

Environment values retain their string checks before path normalization and
snapshot filtering. If `os.userInfo()` fails because the uid has no passwd entry,
the username lookup falls back to `USER` and `LOGNAME`.

### Why the startup uid accessor has no fallback

Node declares `getuid` optional for Windows. The macOS service paths require it;
an unavailable method keeps the original `TypeError` instead of writing a
launchd target containing an undefined uid.

### Why HTTP discovery types stop at the checked fields

System-info discovery checks a string runtime and a finite numeric pid. Negative
and fractional pids retain the old acceptance rule. Provider discovery checks
only that the provider list is an array; its entries remain unchecked. The JSON
request helper forwards arbitrary parsed JSON, including scalar responses, and
does not claim a route-specific response contract.

### Why HTTP headers keep the per-port cookie pattern

The server can name a UI session cookie `oc_ui_session` or append a port.
The CLI accepts both forms when retrying an authenticated request. Cookie
values, stored UI passwords and system-info fields retain their boundary checks.

### Why profile inputs and stored profiles have different types

Files supply unchecked fields. `TunnelProfilesInput` promises no element shape;
the sanitizer checks the list, each record, normalized text, and finite
timestamps before returning `TunnelProfile` entries. The list check also
rejects inherited object members such as `constructor`. Finite fractional and
negative timestamps remain valid. Redaction and token-status formatting also
accept unchecked token fields; revealing a token preserves its original value,
while masking and status formatting check it before using string methods.
Permission warnings ignore failed file stats because the profile file may not
exist yet.

### Why tunnel state keeps unchecked fields

The CLI reads only the saved config path and preserves every other property
when writing it back. Its state predicate establishes a non-array object, not
the type of that path. The string check stays at the read, and the spread keeps
unrecognized properties.

### Why CLI errors declare their exit code without emitting a field

The constructor assigns `name` before `exitCode`. A declaration-only field keeps
that own-property order and leaves the runtime constructor unchanged.

### Why parser defaults have required undefined-valued fields

`CliOptions` preserves the parser's object shape. Defaulted value flags are own
properties even when their value is `undefined`; `worktree`, `branch`,
`startRef`, `setUpstream` and `relay` are absent until their flag is handled.
An empty `--config` produces `null`, distinct from the default `undefined`.

### Why text guards remain on the exported argument helpers

Completion and typo-suggestion helpers are also called from JavaScript.
Their shared text predicate preserves rejection of non-string values before
using string methods. Parser-internal values already come from a string
argument vector and use undefined checks for missing values.

### Why edit-distance indexing checks occupancy

The edit-distance matrix allocates every row and cell before the loops use it.
Local accessors express that invariant under unchecked-index checking without
casts. They leave the matrix, loop order and first-match tie behavior intact.

### Why `schedule update` omits unset boolean flags instead of sending `false`

`parseArgs` defaults `goal` and `disabled` to `false`, and `schedule.update` treats any boolean as a change: `false` enables the task and turns Goal Mode off. Sending the defaults would do that on every update that did not name them, so `update` sends each only when its flag is present. `create` still sends both, because a new task has no state to keep.

### Why a missing `--target-session` value is an error and not ignored

Most value flags keep their old value when the value is missing. For `--target-session` that would let `create` make a task that opens a new session on every run, with no error. The parser reports it through `removedFlagErrors` rather than throwing, so it fails before any request and as a JSON payload under `--json`, which a throw from `parseArgs` cannot do because `main()` has not yet seen the options.

### Why a full URL in `--host` is used as the server URL

`--host https://devchamber.example.com` names a public server URL for a deployment behind a reverse proxy, not an address to bind. Feeding it to `buildLocalUrl` would produce `http://https://...:port`, so an http(s) URL is used directly as the advertised server URL.

### Why foreground serve stays in-process

Foreground mode imports and runs the server in the CLI process. Process managers such as systemd `Type=simple` track that direct child; a detached grandchild would escape them. Converting it to child-process orchestration also caused shell job-control suspension. Signal handlers are added without `removeAllListeners`, which would drop handlers other code registered in the same process.

### Why instance files retain their decoded JSON type

`readInstanceOptions` preserves every decoded JSON value, including scalar and
array roots. A successful read establishes JSON syntax only. `hasInstanceFields`
provides an optional-field view at each consumer without rejecting non-null
scalars or claiming that a port, host or password has been validated. Primitive
field access keeps JavaScript's boxing behavior. Password text and finite
timestamps retain their checks where they are used.

Thrown values retain unchecked `message` fields. A null or undefined value keeps
the property-access `TypeError` wording of the running Node or Bun runtime.

The instance writer accepts unchecked fields because it validates the host,
password, launch mode and timestamp itself. Serve also receives stored fields
from restart and update. Invalid hosts and ports retain their existing
environment/default fallback, and invalid passwords retain the existing
password-generation decision.

### Why native streams have local declarations

With an existing file descriptor, Node ignores the path passed to
`createWriteStream`; foreground quiet mode retains its null path. Writable
streams also accept a callback in the second argument or an explicit undefined
encoding. `node-streams.d.ts` describes these native calls without changing the
stream redirection wrappers.

### Why target discovery checks injected callbacks and results

Callers can inject discovery callbacks from JavaScript. The helper still
checks whether each override is callable, whether lifecycle discovery
returned an array, and whether each candidate is a bare port or a record.
The existing finite and positive checks still decide which lifecycle ports
qualify.

### Why lifecycle port probes pass saved hosts through

`discoverUnconfirmedRegistryInstanceOnPort` forwards a truthy saved `host`
directly to `isPortAvailable`, which passes it to Node's `net.Server.listen`.
Instance files validate JSON syntax only. Node rejects truthy non-string hosts
in its DNS lookup, while Bun can coerce them or emit a listen error. The local
declaration describes that call so the CLI preserves the result from the
runtime. HTTP host resolution still checks for text and falls back as before.

Restart uses the command receiver's callbacks only when the receiver is an
object and the properties are functions. These checks preserve detached calls
and injected JavaScript callers. Stop preserves thrown message formatting:
truthy messages are interpolated, and a missing message leaves out the detail.

### Why connect-url preserves the settings reader's JSON roots

The migrated reader preserves scalar and array JSON roots. The key store
spreads that value and reads only optional legacy key fields from the strict
reader. The CLI still checks URL text and the relay flag before use. QR
generation uses the installed package's `small` rendering option.

### Why doctor check labels are printed as text

`isValidTunnelDoctorResponse` establishes the provider-check and mode arrays
of a JSON-parsed response, but not the fields of each provider check. Each
check is read as a record of optional JSON values; a missing entry still
throws as a property read would. A failed check prints its label and detail
through template strings, so `logStatus` receives text. Every OpenChamber
tunnel provider declares string labels (`server/lib/tunnels/contracts.ts`),
so the output for any response a server produces is unchanged. A malformed
non-string label now prints its text form, where the JavaScript version
handed the raw value to Clack, which threw for a number.

### Why browser port and environment checks remain

The blocked-port set follows the
[Fetch port-blocking list](https://fetch.spec.whatwg.org/#port-blocking).
Environment hosts, stored passwords, process text, IPC readiness messages,
filesystem errors and optional profile/model fields retain their representation
checks. Internal optional callbacks and already parsed replay options use their
declared contracts. Injected environment names come from comma-separated strings;
the environment helper's explicit `Set<string>` return keeps the empty-set branch
usable as environment keys without changing its contents.

## Verification

For CLI behavior changes, run the focused CLI suite from `packages/web`:

```sh
bun run test -- bin/cli.test.js
```
