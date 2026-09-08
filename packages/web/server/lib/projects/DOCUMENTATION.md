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

## Modules

- `project-id.js` — `createProjectIdFromPath` / `projectPathFromId`: the path-derived id (`path_<base64url>`) that names the file, and the checkout path back from it. The shared UI derives the same id (`packages/ui/src/lib/projectId.ts`); both sides must agree.
- `project-config.js` — `createProjectConfigRuntime`: raw read, atomic write, the cross-process file lock (Electron and a CLI `serve` can share one projects dir), scheduled-task normalization, and the project-setup read/update.
- `project-setup.js` — sanitizers, the shared-file parser (`parseSharedProjectConfig`, `normalizePlansDir`), the merge (`mergeProjectSetup`), and the personal view for the setup keys. Mirrored in the VS Code extension host (`packages/vscode/src/project-setup.ts`), which owns the same file when the webview has no OpenChamber server; keep the two in sync.
- `routes.js` — the setup routes. `/api/projects` is on the JSON-body allowlist in `opencode/core-routes.js`.

## Invariants

- **Every write is a locked read-modify-write of the whole document.** Keys the writer does not own, and keys from newer builds, come back out unchanged. A setup update and a scheduled-task update never clobber each other.
- **A wrongly shaped key is a 400, not a silent drop.** `projectSetupPatchToStored` throws; the file is untouched. Values inside a well-shaped key are sanitized (trimmed, capped, deduplicated) rather than rejected.
- **The client never composes the path.** `packages/ui/src/lib/openchamberConfig.ts` speaks only HTTP; the same code serves web, desktop, VS Code, and the phone, including a phone on a remote instance.
- **`OPENCHAMBER_DATA_DIR` moves this directory too.** Every OpenChamber folder hangs off the one root; a custom root gets `projects/`, `themes/`, and `speech-models/` copied in from `~/.config/openchamber` once at startup (copied, not moved: a second instance beside the default one must not strip it) (`lib/data-dir-migration.js`). A scratch server started with its own data dir therefore never touches the real project configs.
