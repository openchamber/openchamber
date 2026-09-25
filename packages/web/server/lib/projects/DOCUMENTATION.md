# Projects

## Purpose

Server-owned storage for a project's per-user config file,
`~/.config/openchamber/projects/<projectId>.json`. The file holds two
families of keys with different writers, and this module is the only place
that writes it:

| Keys | Owner | Reached through |
|---|---|---|
| `version`, `scheduledTasks` | `project-config.js` (scheduled-task runtime) | `/api/projects/:projectId/scheduled-tasks/*` |
| `setup-worktree`, `setup-worktree-wait`, `projectActions`, `projectActionsPrimaryId`, `draftStarters`, `projectPath` | `project-setup.js` via `readProjectSetup` / `updateProjectSetup` on the same runtime | `GET/PUT /api/projects/:projectId/config` (`routes.js`) |
| `shellEnv` | `shell-env.js` (read) and `project-setup.js` (sanitize/write) | `GET/PUT /api/projects/:projectId/config` |

Notes, todos, and plans moved out of this file to `packages/web/server/lib/project-context`.

A second, optional source is the team's shared file, `<repo>/.openchamber/project.json`
(`version: 1`; `setupWorktree`, `setupWorktreeWait`, `projectActions`, `draftStarters`,
`plansDir`). The server reads it from the checkout the project id names
(`projectPathFromId`). `GET /api/projects/:projectId/config`
returns one merged view: what runs at the top level, plus `shared` and `personal`
blocks so a page can edit the personal file without copying a teammate's entry into it.

| Field | Merge rule |
|---|---|
| `setupWorktree` | shared first, then personal; personal `setupWorktreeMode: "replace"` uses the personal list only |
| `setupWorktreeWait` | personal when the personal file sets it, else shared, else `false` |
| `projectActions` | union by `id`; a personal action replaces the shared one with the same id; ids in personal `hiddenSharedActionIds` are dropped; every entry carries `source` |
| `projectActionsPrimaryId` | personal only |
| `draftStarters` | union by `type:name`, shared first, every entry carries `source` |
| `plansDir` | shared only |

A shared file that exists but cannot be parsed (or names a `plansDir` outside the
repo) is `shared.status: "invalid"` with a `reason`; the personal setup is still
served. It is never treated as "no shared setup".

### Writing the shared file

`PUT /api/projects/:projectId/config/shared` (`updateSharedProjectSetup`) is
the only writer. The patch replaces the keys it names over the current file
(a broken file counts as empty, so a write repairs it); the result is written
pretty-printed with `version` first and only the keys that carry something
(`serializeSharedProjectConfig`), because the file is committed and reviewed.
A result with nothing in it removes the file and the `.openchamber` folder
when that leaves it empty, so unsharing the last item leaves no trace. The
write refuses a checkout that does not exist and a `plansDir` outside the
repo. The writer has seen what it shared, so its personal trust record is set
to the new hash; teammates still get the prompt. The shared UI composes
"share" and "make personal" as a shared write followed by a personal write.

### Trust

Shared setup commands and shared actions run on the machine of whoever pulls
the repo, so they run only after the user has seen them. The view carries
`trust: { hash, trusted }`: `hash` is `sharedTrustHashOf(shared)`, a SHA-256
over the executable parts (`setupWorktree` and each action's `id`, `command`,
`runIn`, actions sorted by id; names and icons do not count), or `null` when
nothing executes. `trusted` is true when nothing executes or the personal
file's `sharedTrust.hash` equals the current hash, so a pull that changes a
command brings the prompt back. The client records an answer with a PUT of
`sharedTrustHash` (`null` forgets it). The prompt itself lives in the shared
UI (`packages/ui/src/lib/sharedTrustConfirmation.ts`).

## Per-project shell environment

A project may opt in to a development shell environment (devenv, direnv, a
plain `export NAME=value` script) that OpenChamber overlays onto every process
it spawns for the project: Git, the terminal (and therefore Project Actions,
which run through it), and `/api/fs/exec`. The key is `shellEnv` in the
personal file:

```json
{ "enabled": true, "command": "devenv print-dev-env --json", "vars": { "GOFLAGS": "-mod=vendor" }, "mode": "overlay" }
```

- `enabled` is the explicit opt-in. **The command is personal only**: it is
  never read from the shared `.openchamber/project.json`, because a repository
  that described a command running on every spawn would be a remote code
  execution path. Nothing runs while `enabled` is false.
- `command` is a shell command whose stdout describes the environment. The
  parser accepts `devenv print-dev-env --json` (`variables.NAME.value`),
  `direnv export json` (a flat object), `export NAME=value`, dotenv lines, and
  NUL-separated `env -0` output. Unrecognized output is an empty environment,
  never an error. The typed devenv shape is the derivation's whole environment,
  so only `type: "exported"` entries are adopted, and the Nix build sandbox's
  own identity — `HOME=/homeless-shelter`, `NIX_BUILD_TOP`, and a
  `TMP`/`TMPDIR`/`TEMP`/`TEMPDIR` pointing at it — is dropped rather than
  following every spawn. devenv's shell hook repairs those values for a shell;
  a spawn gets no hook, so OpenChamber drops them.
- `vars` are literal `NAME=value` overrides that win over parsed values.
- `mode` is `overlay` (default) or `replace`. In `overlay`, PATH-like keys
  (`PATH`, `CDPATH`, `*_PATH`) are prepended, deduplicated, so system tools
  stay reachable; `replace` sets them verbatim. Other keys always override.

`shell-env.js` owns parsing, the PATH-aware merge, and the resolver
(`createProjectShellEnvResolver`). `project-config.js` exposes
`readProjectShellEnv` for it; `project-setup.js` sanitizes and stores the key.
The resolver picks the project whose `shellEnv` applies and the directory the
command runs in:

- **A linked worktree inherits the primary project's settings but runs the
  command in its own checkout.** The checkout root is the nearest ancestor
  with a `.git` entry; when that entry is a file, its `gitdir:` names the
  primary repository, whose config is the source. So a `devenv
  print-dev-env --json` command runs in the worktree and sees this worktree's
  `devenv.nix`, while the settings come from the project the user configured.
- A worktree whose primary has no enabled config may use its own enabled
  config; the primary wins when both have one.
- A plain subdirectory runs the command in its checkout root (or, outside a
  repository, in the project root the config belongs to).

Runs the command once per directory, caches the result for
`PROJECT_SHELL_ENV_TTL_MS` (60 s), dedupes concurrent resolutions, and never
blocks a spawn for more than `PROJECT_SHELL_ENV_TIMEOUT_MS` (15 s). Any
failure — missing config, disabled, non-zero exit, timeout, unparseable output
— resolves to `null` and the spawn proceeds on its base environment. The
command runs with the same augmented PATH a terminal gets (`buildAugmentedPath`
in the composition root), not the server's own `process.env.PATH`: a packaged
server runs under a systemd user unit whose minimal PATH has no `devenv`,
`direnv`, or `nix`, so resolving with `process.env` alone would silently find
nothing. `baseEnv` is a getter, so that login-shell probe stays lazy. Values in
`export NAME=value` output are read literally (`$VAR` is not expanded;
`devenv`/`direnv` JSON carries final values). A config write calls
`invalidateProject(projectId)`, which also invalidates worktrees that inherit
that project, so a change applies on the next spawn rather than after the TTL;
a resolution already in flight is used for its one spawn but not cached.

The resolver is created once in the composition root (`server/index.js`) and
reaches Git through `setGitProjectShellEnvResolver` (Git functions are
module-level), the terminal through `createTerminalRuntime`, and fs exec
through `registerFsRoutes`. `lib/projects/shell-env.js` is deliberately free of
`node:child_process` module state: parsing and merging are pure and the
resolver takes its dependencies injected, so it is unit-tested without a server.

## Modules

- `project-id.js` — `createProjectIdFromPath` / `projectPathFromId`: the path-derived id (`path_<base64url>`) that names the file, and the checkout path back from it. The shared UI derives the same id (`packages/ui/src/lib/projectId.ts`); both sides must agree. `projectConfigFileStemOf`: the stem that names the file and the sibling folder for an id, see the file name invariant below.
- `project-config.js` — `createProjectConfigRuntime`: raw read, atomic write, the cross-process file lock (Electron and a CLI `serve` can share one projects dir), scheduled-task normalization, and the project-setup read/update.
- `project-setup.js` — sanitizers, the shared-file parser (`parseSharedProjectConfig`, `normalizePlansDir`), the merge (`mergeProjectSetup`), and the personal view for the setup keys. Mirrored in the VS Code extension host (`packages/vscode/src/project-setup.ts`), which owns the same file when the webview has no OpenChamber server; keep the two in sync.
- `shell-env.js` — the `shellEnv` shape (`sanitizeShellEnv`, `shellEnvToStored`), the tolerant output parser (`parseShellEnvOutput`), the PATH-aware merge (`applyShellEnv`), and the cached `createProjectShellEnvResolver`.
- `routes.js` — the setup routes. `/api/projects` is on the JSON-body allowlist in `opencode/core-routes.js`.

## Invariants

- **Every write is a locked read-modify-write of the whole document.** Keys the writer does not own, and keys from newer builds, come back out unchanged. A setup update and a scheduled-task update never clobber each other.
- **A wrongly shaped key is a 400, not a silent drop.** `projectSetupPatchToStored` throws; the file is untouched. Values inside a well-shaped key are sanitized (trimmed, capped, deduplicated) rather than rejected.
- **The file name is bounded, and so is the folder beside it.** The file is `<projectId>.json` and the per-project folder is `<projectId>/` while the id is at most 200 characters. A `path_<base64url>` id grows with the checkout path, so a deeply nested project (a path of roughly 150 characters or more) would otherwise get a name beyond the 255-byte limit and every write, lock, and temp file would fail with ENAMETOOLONG. Such an id is stored as `path_sha256_<hex digest of the id>.json` instead, with the folder `path_sha256_<digest>/` beside it (`projectConfigFileStemOf`; every composer of either path goes through it: `project-config.js`, `project-context/runtime.js`, `agent-memory/runtime.js`, and the id migration and orphan recovery in `opencode/settings-runtime.js`). The digest keeps the `path_` prefix so orphan recovery skips it. A file an older build managed to write under the long name is still read when the bounded file is missing and is moved to the bounded name by the next write; a malformed one is a read failure, not an empty project. A folder an older build created under the raw id (possible only for ids of 201 to 255 characters; longer names never got one) is moved into the bounded folder once at startup, by the project id migration in `opencode/settings-runtime.js`, with `context.json` merged by entry identity when both exist. The VS Code extension host mirrors both the naming rule and the legacy read-then-move for the file (`bridge-project-setup-runtime.ts`), because a VS Code-only user has no server to do it; it never touches the folder.
- **The client never composes the path.** `packages/ui/src/lib/openchamberConfig.ts` speaks only HTTP; the same code serves web, desktop, VS Code, and the phone, including a phone on a remote instance.
- **`OPENCHAMBER_DATA_DIR` moves this directory too.** Every OpenChamber folder hangs off the one root; a custom root gets `projects/`, `themes/`, and `speech-models/` copied in from `~/.config/openchamber` once at startup (copied, not moved: a second instance beside the default one must not strip it) (`lib/data-dir-migration.js`). A scratch server started with its own data dir therefore never touches the real project configs.
