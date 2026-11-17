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

- `variables.js`: pure helpers. The name rule (`isVariableName`) refuses
  `__proto__`, which fits the pattern but replaces an object's prototype when
  assigned as a key, and which no tool reads. Reading command output
  (`parseEnvironmentOutput`) recognizes devenv/nix JSON, flat JSON from
  direnv, `NAME=value` lines, and `env -0`. Only entries typed `exported` in
  nix output become variables; the builder's `var`, `array` and hook entries
  are its own shell state (IFS, PS4), not a child's environment. direnv's
  `null` for an unset name is skipped because an overlay has nothing to
  remove. The Nix build sandbox's own values are dropped: `HOME` when it is
  `/homeless-shelter`, and the temp variables when they point at
  `NIX_BUILD_TOP`. devenv's shell hook repairs them in a shell and a plain
  spawn has no hook, so a user's own HOME or temp value is left alone.
  `$NAME` and `${NAME}` expand against earlier lines and then the base
  environment; an unknown reference stays literal so a value is never
  emptied by accident, and only `\$` is unescaped so a Windows path such as
  `C:\Tools` survives. Output with no recognized variable answers null, so
  Settings can say the output was not understood instead of applying
  nothing. `overlayEnvironment` puts PATH-like values in front of the
  inherited list (duplicates dropped) and replaces everything else. It
  reuses the inherited spelling of a list variable (`Path` on Windows), so
  the child never gets both `PATH` and `Path`.
- `store.js`: `<dataDir>/environment.json`, mode 0600, written atomically and
  by one writer at a time in this process. A write goes to a temporary file
  and is renamed, which keeps that file's mode, so a wider file left by an
  older version becomes 0600. Project ids are path-derived
  (`path_<base64url>`, `path_sha256_<hex>`); the id pattern also keeps
  `__proto__` out of the projects record. The parsed document stays in
  memory because Git reads it on every command, polling included. This
  module is the file's only writer, and a failed read is not kept and is
  retried on the next call. A file that exists but cannot be read or parsed
  throws `EnvironmentStoreError`; it never reads as empty, because a write
  on top would erase every stored value. Patches: a string sets, `null`
  removes, an absent name stays.
- `runtime.js`: `createEnvironmentRuntime` decides what each spawn gets.
  `forDirectory(dir)` finds the project (a configured project containing the
  directory, or for a linked worktree the project at the same place in the
  primary checkout, read from the `.git` file because Git itself asks this
  runtime for its environment) and layers user variables, command output,
  then project variables. The lookup runs only when the store holds a
  project entry, so the Git polling of a user who configured nothing pays
  nothing. `forOpenCode()` answers `opencode service set env` variables under
  the user variables. `applyToDirectory(dir, env)` is the overlay consumers
  call.
- `opencode-service-env.js`: reads `env` from `service.json` in OpenCode's
  global config directory (the stable channel's file only). Not a published
  OpenCode contract; anything unexpected reads as no variables.
- `routes.js`: `/api/environment` (user) and `/api/environment/projects/:id`
  (+ `/reload`). On the JSON-body allowlist in `opencode/core-routes.js`.

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
  never a value. Nothing logs a value, the command's stdout or its stderr; a
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
  run that started before the edit is not kept.
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
