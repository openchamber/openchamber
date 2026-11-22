# Environment

## Purpose

Environment variables the user gives OpenChamber for the processes it starts:
the managed OpenCode, Git, the terminal (and the project actions it runs),
worktree setup commands and `/api/fs/exec`. There are two layers:

- **user**: typed in Settings → General, for everything above;
- **project**: typed in Settings → Projects, plus an optional environment
  command (`direnv export json`, `devenv print-dev-env --json`, a script of
  `export` lines) whose output adds variables. Only for Git, the terminal,
  project actions, setup commands and exec in that project and its worktrees.

## Modules

- `variables.js`: pure helpers. The name rule (`isVariableName`), reading
  command output (`parseEnvironmentOutput`: devenv/nix JSON keeps only
  `exported` entries and drops the Nix build sandbox's HOME and temp
  directories; flat JSON from direnv; `NAME=value` lines; `env -0`), and
  `overlayEnvironment`, which puts PATH-like values in front of the inherited
  list and replaces everything else.
- `store.js`: `<dataDir>/environment.json`, mode 0600, written atomically and
  by one writer at a time in this process. A file that exists but cannot be
  read or parsed throws `EnvironmentStoreError`; it never reads as empty,
  because a write on top would erase every stored value. Reads go through the
  shared bounded reader under a 64 MiB cap (`MAX_ENVIRONMENT_FILE_BYTES`):
  the write side clamps each entry to roughly 6.5 MB at worst and the project
  count is unbounded, so the cap sits at about ten worst-case entries. An
  over-cap file or a non-regular file at the path throws the same
  `EnvironmentStoreError`, and a FIFO cannot block the synchronous read. Patches: a string
  sets, `null` removes, an absent name stays.
- `runtime.js`: `createEnvironmentRuntime` decides what each spawn gets.
  `forDirectory(dir)` finds the project (a configured project containing the
  directory, or for a linked worktree the project at the same place in the
  primary checkout, read from the `.git` file without running Git) and layers
  user variables, command output, then project variables. `forOpenCode()`
  answers `opencode service set env` variables under the user variables.
  `applyToDirectory(dir, env)` is the overlay consumers call. `forDirectory`
  reads vault references on a user action and otherwise uses the last value
  read. The environment command itself is spawned with the user variables
  after the same vault resolution, under the caller's `refresh` flag, so it
  receives the secret or no variable and never the literal `op://…` text.
  `forOpenCodeResolved()` is `forOpenCode()` with references read, for
  the launch itself; the launch fingerprint keeps the unresolved
  `forOpenCode()`, so no secret is hashed or stored and a changed reference
  still restarts OpenCode. `vaultStatus()` answers each reference's last read.
- `vault.js`: vault references. A value matching `op://<vault>/<item>/<field>`
  (optionally with a section) is read with `op read --no-newline` when a
  process needs it (`createVaultResolver().resolve(variables, { refresh })`).
  The secret stays in memory only. `refresh: true` re-reads every reference
  on every call, even one read moments ago, so a relaunch after a rotation
  gets the rotated value instead of the fresh cached one; `refresh: false`
  uses only what an earlier read left, fresh or stale, so Git status polling
  never starts `op`. `readSecret` keeps the five-minute TTL instead: it
  serves a fresh cached value and re-reads only once the entry is older
  than five minutes. A failed
  read leaves the variable out (a stale good value is kept instead when
  there is one) and records `{ state: 'failed', reason }` per variable:
  `op-not-installed`, `timeout` (30 s), `op-read-failed`, `empty`. It warns
  once per variable and reason, naming the variable only. A recorded
  outcome belongs to the reference it was recorded under: serving a
  variable from the cache records `resolved` for its current reference,
  and `status(variables)` answers only outcomes whose reference matches
  the one the variable currently holds, so a replaced reference never
  inherits the previous one's outcome.
- `opencode-service-env.js`: reads `env` from `service.json` in OpenCode's
  global config directory (the stable channel's file only). Not a published
  OpenCode contract. The shared bounded reader caps the file at 1 MiB and
  rejects non-regular files without blocking. Missing, unreadable, over-cap,
  non-regular or invalid files yield no variables; this file is read-only.
- `routes.js`: `/api/environment` (user) and `/api/environment/projects/:id`
  (+ `/reload`). On the JSON-body allowlist in `opencode/core-routes.js`.
  Every answer carries `references` (the variables whose value is a vault
  reference, with the reference) and `vault` (each reference's last read).
- The `openchamber` agent tool reaches the same store through
  `../openchamber-control/environment-actions.js`: names, references and
  their reads; it sets only a vault reference or removes a variable.

## Who receives what

| Process | Variables | Wired in |
|---|---|---|
| Managed OpenCode | service env, then user (none in enterprise mode) | `opencode/lifecycle.js` `getUserEnvironment` |
| Git commands in `git/service.js`, hooks included (push, pull and fetch run through `git/network-operations.js` with its own scrubbed environment and get none) | user, command output, project; minus the names simple-git refuses and the repository-location names | `git/service.js` `configureGitEnvironment` / `buildGitEnv(directory)` |
| Terminal, project actions | user, command output, project | `terminal/runtime.js` `environmentRuntime` |
| Worktree setup commands | same as Git | `git/service.js` `runWorktreeStartCommand` |
| `/api/fs/exec` | user, command output, project | `fs/routes.js` `environmentRuntime` |

One managed OpenCode serves every project, so project variables never reach
it. An external OpenCode is not started by OpenChamber and gets nothing.
OpenChamber's own keys for OpenCode (password, managed config, agent tool
token, PATH entries it needs) are applied after the user's variables and win.

## Invariants

- **Values never leave the server.** Routes answer names and the command,
  never a value. A vault reference is the one exception: it names where a
  secret is kept, not the secret, which is read by the server and never
  returned. Nothing logs a value, the command's stdout or its stderr; a
  failed run logs the project id and the reason only.
- **A spawn always goes ahead.** `forDirectory` never throws: a broken store,
  a failing command or a failed lookup applies what could be resolved and
  warns once per distinct message.
- **Failure is reported, not hidden.** A run that exits non-zero, times out
  (15 s), prints too much (4 MB) or prints nothing readable applies nothing
  from the command and is recorded for `projectStatus`, which Settings shows.
- **Only user actions run the command.** Work the user started (`refresh`):
  Git routes wrapped in `runAsUserAction` (commit, checkout, branch create,
  merge, rebase, cherry-pick, revert, worktree create, integrate), the
  terminal and project actions, exec other than cacheable Git reads, and
  Reload in Settings. Reads the UI repeats on its own (Git status polling) use
  the kept result and never start a run, so an idle project costs nothing.
  The first user action in a checkout waits for the run; a result older than
  five minutes is used by the next user action while a fresh run happens in
  the background. Editing the project's settings drops what was kept, and a
  run that started before the edit is not kept. A reload after the edit
  starts a fresh run; it never joins a run still in flight from before the
  edit, so the command that runs is the one just saved and the reload
  answers that run's outcome.
- `refresh-scope.js`: the AsyncLocalStorage flag behind `runAsUserAction` /
  `isUserAction`, so the Git service needs no extra argument between route
  and spawn.
- **The command is personal.** It is read only from `environment.json`, never
  from the repository's shared `.openchamber/project.json`, so a cloned
  repository cannot make the server run anything. Who can set it: anyone
  signed in to the UI, the same people who can open a terminal.
- **Git keeps its protections.** Names simple-git refuses in an environment
  (EDITOR, PAGER, GIT_SSH_COMMAND, GIT_ASKPASS, GIT_CONFIG_*, ...) are left
  out of the Git overlay, or every Git command would fail. So are the
  repository-location variables (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...):
  OpenChamber names the repository each command works on.
  `GIT_TERMINAL_PROMPT` stays `0`.
- **Enterprise mode** (`../enterprise-mode.js`): nothing from this module
  reaches OpenCode, since a variable can carry a provider key. Git, the
  terminal and exec still get the variables; they stay on this machine.

## Runtimes

| Runtime | Behavior |
|---|---|
| Web, hosted mobile, Capacitor | The server route; Settings sections render. |
| Electron | Same server, in process. |
| VS Code | No OpenChamber server: both Settings sections are hidden and nothing is applied to the processes the extension host starts. |
