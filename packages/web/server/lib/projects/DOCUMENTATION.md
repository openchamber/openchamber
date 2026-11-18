# Projects

## Purpose

Project directory activation and server-owned project config storage.
`POST /api/openchamber/directory` validates a path, adds it to OpenChamber's
project list if needed, and saves `activeProjectId` and `lastDirectory`.
`{ create: true }` creates the directory before validation, including outside
the previously active workspace. It does not restart OpenCode. If creation
succeeds but validation or settings persistence fails, the directory remains;
the route reports failure rather than removing files it may not own.

Server-owned storage for a project's per-user config file,
`~/.config/openchamber/projects/<projectId>.json`. The file holds two
families of keys with different writers, and this module is the only place
that writes it:

| Keys | Owner | Reached through |
|---|---|---|
| `version`, `scheduledTasks`, `scheduledWorktreeCleanups` | `project-config.js` (scheduled-task runtime) | `/api/projects/:projectId/scheduled-tasks/*` and internal cleanup recovery |
| `setup-worktree`, `setup-worktree-wait`, `teardownWorktree`, `createWorktreeCommand`, `projectActions`, `projectActionsPrimaryId`, `draftStarters`, `notesTodosInRepository`, `projectPath` | `project-setup.js` via `readProjectSetup` / `updateProjectSetup` on the same runtime | `GET/PUT /api/projects/:projectId/config` (`routes.js`) |

Notes, todos, and plans moved out of this file to `packages/web/server/lib/project-context`.
`notesTodosInRepository` (personal only, absent when off) tells that module to keep notes and todos in `<repo>/.openchamber/notes-todos.json`; `resolveNotesTodosFile` answers the path, and `updateProjectSetup` calls `onNotesTodosStorageChanged` when the value flips.
A project's environment variables and environment command are not in this file either: values can be secrets, so they live in `environment.json` (mode 0600, `packages/web/server/lib/environment`).

A second, optional source is the team's shared file, `<repo>/.openchamber/project.json`
(`version: 1`; `setupWorktree`, `setupWorktreeWait`, `teardownWorktree`, `projectActions`, `draftStarters`,
`plansDir`, and `magicPrompts`, which `../magic-prompts` owns). The server reads it from the checkout the project id names
(`projectPathFromId`). `GET /api/projects/:projectId/config`
returns one merged view: what runs at the top level, plus `shared` and `personal`
blocks so a page can edit the personal file without copying a teammate's entry into it.

| Field | Merge rule |
|---|---|
| `setupWorktree` | shared first, then personal; personal `setupWorktreeMode: "replace"` uses the personal list only |
| `setupWorktreeWait` | personal when the personal file sets it, else shared, else `false` |
| `teardownWorktree` | shared first, then personal; `setupWorktreeMode` does not apply, so a user who skips the team's setup still stops what the team's setup may have started |
| `projectActions` | union by `id`; a personal action replaces the shared one with the same id; ids in personal `hiddenSharedActionIds` are dropped; every entry carries `source` |
| `projectActionsPrimaryId` | personal only |
| `createWorktreeCommand` | personal only (`personal.createWorktreeCommand`, `''` when unset); see below |
| `draftStarters` | union by `type:name`, shared first, every entry carries `source` |
| `plansDir` | shared only |

`createWorktreeCommand` replaces `git worktree add` for this project's new
worktrees (`../git/DOCUMENTATION.md`, *Worktree create command*). Clients send
it with each creation as `createCommand`; the server's own creations
(`session.create`, `session.moveToWorktree`) take it from `worktreeSetupOf`.

### Why the create command is personal only

It names a tool installed on one machine, such as a copy-on-write worktree
tool. A shared value would make every teammate who pulls the repository create
worktrees with a command they may not have, and every creation would fail for
them. Personal only also keeps it out of the trust prompt: nothing a `git pull`
brings in can change how worktrees are made.

A shared file that exists but cannot be parsed (or names a `plansDir` outside the
repo) is `shared.status: "invalid"` with a `reason`; the personal setup is still
served. It is never treated as "no shared setup".

### Writing the shared file

The file has two writers: `updateSharedProjectSetup` for the setup keys and
`updateSharedProjectEntry` for one key it does not own (`magicPrompts`). Both
take the project's write lock (the in-process chain and the
`<projectsDir>/<id>.json.lock` file) and replace the file through a temporary
sibling, so a setup save and a prompt save never clobber each other. The lock
covers only writers sharing one projects dir and project id; a server with
another data dir, the VS Code extension host and a hand edit are last write wins.

`PUT /api/projects/:projectId/config/shared` (`updateSharedProjectSetup`) writes
the setup keys. The patch replaces the keys it names over the current file
(a broken file counts as empty, so a write repairs it); the result is written
pretty-printed with `version` first and only the setup keys that carry something
(`serializeSharedProjectConfig`), because the file is committed and reviewed.
Every other key follows unchanged, also through a repair; only unparsable JSON,
a non-object or another version is replaced whole. A result with nothing in it
and no other key removes the file and the `.openchamber` folder
when that leaves it empty, so unsharing the last item leaves no trace. The
write refuses a checkout that does not exist and a `plansDir` outside the
repo. The writer has seen what it shared, so its personal trust record is set
to the new hash; teammates still get the prompt. The shared UI moves an
entry between the files as a write to the destination followed by a removal
from the source (`packages/ui/src/components/sections/projects/projectSetupModel.ts`),
so a failed second write leaves the entry in both files, never in neither.

`updateSharedProjectEntry` never repairs. It refuses any file that is not valid
version-1 setup (`shared_config_invalid`) and leaves its bytes, writes the rest
of the document as read, never touches the personal file or its trust record,
and removes the file when only `version` is left.

### Trust

Shared setup commands and shared actions run on the machine of whoever pulls
the repo, so they run only after the user has seen them. The view carries
`trust: { hash, trusted }`: `hash` is `sharedTrustHashOf(shared)`, a SHA-256
over the executable parts (`setupWorktree`, `teardownWorktree` when it is not
empty, and each action's `id`, `command`, `runIn`, actions sorted by id; names
and icons do not count), or `null` when nothing executes. An empty teardown list
stays out of the hashed document, so an answer recorded before teardown
commands existed still matches. `trusted` is true when nothing executes or the personal
file's `sharedTrust.hash` equals the current hash, so a pull that changes a
command brings the prompt back. The client records an answer with a PUT of
`sharedTrustHash` (`null` forgets it). The prompt itself lives in the shared
UI (`packages/ui/src/lib/sharedTrustConfirmation.ts`). A worktree the server
makes for an agent has no client to ask, so `worktree-setup.js` gives the
prompt's "skip" answer when the shared commands are not trusted: it leaves
them out and returns them for the caller to report. It resolves the same
commands as the client's New worktree dialog (`resolveWorktreeSetupCommands`
in `packages/ui/src/lib/sharedTrustConfirmation.ts`).

## Modules

`session-directory.js` serves `POST /api/projects/session-directory` for a
session's unregistered host destination. It validates the directory, verifies
the session still lives there, and checks the existing OpenCode fingerprint
trust before appending. Empty configurations and already trusted fingerprints
need no new answer. Untrusted code answers 403 `opencode_trust_required`; a
changed destination answers 409; failed writes answer 503. A session OpenCode
recorded under a symlinked spelling of the folder (`/tmp` for `/private/tmp`)
is no changed destination: after registering, the route moves it in OpenCode
to the canonical folder. The answer always names the session's canonical
folder as `directory`. It creates no folder,
runs no project code, and never changes active-project or directory pointers.
A destination inside a registered project returns that project. A linked
worktree whose repository (the trust assessment's `repositoryKey`) matches a
registered project's also returns that project, appends nothing, and emits
`openchamber:worktree-changed` so clients list the worktree. That match
assesses each registered project inside the settings write queue, so a project
whose assessment takes over 2 seconds (a hung mount) counts as no match instead
of holding the queue. A folder beside a registered project in the same checkout
shares the repository but is no worktree that project lists, so it registers as
its own project. Trust is assessed once before the settings write queue, so
one-time seeding runs outside it, and again at the write boundary, because the
answer can change between the dialog and the registration. A move made during
registration wins: the route re-reads the session's directory before moving it
and answers 409 instead of undoing the newer move. Moving a running session
takes effect at its next step boundary. Web, desktop and both mobile surfaces use the active server. VS Code registers
through its workspace-folder bridge instead.

`project-directory-runtime.js` resolves and validates the project directory of
a request, from the request itself or from settings.

### Why registration uses the settings write queue

A background session and another window can update settings together. Resolving
the project against the latest registry inside its write queue preserves other
projects and metadata. Reading settings before enqueueing a whole replacement
would lose an intervening append. A malformed registry fails without repair.

- `project-id.js` — `createProjectIdFromPath` / `projectPathFromId`: the path-derived id (`path_<base64url>`) that names the file, and the checkout path back from it. The shared UI derives the same id (`packages/ui/src/lib/projectId.ts`); both sides must agree. `projectConfigFileStemOf`: the stem that names the file and the sibling folder for an id, see the file name invariant below.
- `project-config.js` — `createProjectConfigRuntime`: raw read, atomic write, the cross-process file lock (Electron and a CLI `serve` can share one projects dir), scheduled-task normalization, and the project-setup read/update.
- `project-setup.js` — sanitizers, the shared-file parser (`parseSharedProjectConfig`, `normalizePlansDir`), the merge (`mergeProjectSetup`), and the personal view for the setup keys. Mirrored in the VS Code extension host (`packages/vscode/src/project-setup.ts`), which owns the same file when the webview has no OpenChamber server; keep the two in sync.
- `routes.js` — directory activation and setup routes. `/api/openchamber/directory` and `/api/projects` are on the JSON-body allowlist in `server-frame/core-routes.js`. Both register before the generic OpenCode proxy. Web, Electron, hosted mobile, and Capacitor use the server route. VS Code handles the directory route locally through `api:openchamber/directory` and keeps its existing manager-owned directory selection.

## Invariants

- `project-id`, `project-setup`, `worktree-setup`, `session-directory`, `routes`, and `project-directory-runtime` have TypeScript
  implementations and retain their `.js` import specifiers. Setup contracts live
  in `contracts.ts`. Raw shared documents have arbitrary, unvalidated values;
  only the sanitized setup view carries the executable setup contract.

- Scheduled worktree cleanup records are keyed by session id and survive task deletion. Each captures the created branch and directory identity. Scanning the project config files recovers runs even when their project is no longer registered; an unreadable file or malformed record does not erase other records. Claims and journal changes use the project lock, but Git removal runs outside it. A `removing` record carries both `ownerPID` and the native `ownerInstance` creation fingerprint until completion; PID reuse does not retain ownership. Failure releases ownership and a dead instance can be reclaimed. Unreadable process identity fails closed. Successful cleanup clears only that run's record. See `../scheduled-tasks/DOCUMENTATION.md` for the execution, goal and background-command gates.
- Cleanup finalization accepts an abort signal and checks it after acquiring the project lock, after awaited claim checks, and before clearing the journal. An aborted claimed operation releases ownership without discarding the record; that release is allowed to finish after cancellation.

- **Every write is a locked read-modify-write of the whole document.** Keys the writer does not own, and keys from newer builds, come back out unchanged. A setup update and a scheduled-task update never clobber each other.
- **The project file lock recovers from a dead or unreadable owner, and only its owner removes it.** A lock whose PID is not running, or that is older than 60 seconds, is removed and retried; a process that answers EPERM is alive because it exists and belongs to another user. A lock file left unparseable by a crash between create and write falls back to its modification time. Release unlinks the file only while it still names this process, because a stale-recovery steal may have replaced it.
- **A key named `__proto__` in a shared file is data.** Every shared key is set with `defineOwnEntry`; plain assignment would change the object's prototype and `JSON.stringify` would then drop the key, so a foreign `__proto__` entry would disappear on the next write.
- **Enabling or disabling `notesTodosInRepository` moves the entries and commits the option through `switchNotesTodosStorage`.** That module holds its own lock while it moves the entries and calls back to write the option, so a write cannot land between the two.
- **A wrongly shaped key is a 400, not a silent drop.** `projectSetupPatchToStored` throws; the file is untouched. Values inside a well-shaped key are sanitized (trimmed, capped, deduplicated) rather than rejected.
- **The file name is bounded, and so is the folder beside it.** The file is `<projectId>.json` and the per-project folder is `<projectId>/` while the id is at most 200 characters. The 200-character ceiling leaves room in the 255-byte name limit for the atomic-write `.tmp-<pid>-<ms>-<random>` suffix and the `.json.lock` sibling; ids are ASCII, so characters are bytes. A `path_<base64url>` id grows with the checkout path, so a deeply nested project (a path of roughly 150 characters or more) would otherwise get a name beyond the 255-byte limit and every write, lock, and temp file would fail with ENAMETOOLONG. Such an id is stored as `path_sha256_<hex digest of the id>.json` instead, with the folder `path_sha256_<digest>/` beside it (`projectConfigFileStemOf`; every composer of either path goes through it: `project-config.js`, `project-context/runtime.js`, `agent-memory/runtime.js`, and the id migration and orphan recovery in `settings/settings-runtime.js`). The digest keeps the `path_` prefix so orphan recovery skips it. A file an older build managed to write under the long name is still read when the bounded file is missing and is moved to the bounded name by the next write; a malformed one is a read failure, not an empty project. Reading that legacy name treats ENAMETOOLONG as "no such file", because the name may be longer than the filesystem accepts; on the bounded path the same error is a real failure of the projects directory. A folder an older build created under the raw id (possible only for ids of 201 to 255 characters; longer names never got one) is moved into the bounded folder once at startup, by the project id migration in `settings/settings-runtime.js`, with `context.json` merged by entry identity when both exist. The VS Code extension host mirrors both the naming rule and the legacy read-then-move for the file (`bridge-project-setup-runtime.ts`), because a VS Code-only user has no server to do it; it never touches the folder.
- **The client never composes the path.** `packages/ui/src/lib/openchamberConfig.ts` speaks only HTTP; the same code serves web, desktop, VS Code, and the phone, including a phone on a remote instance.
- **`OPENCHAMBER_DATA_DIR` moves this directory too.** Every OpenChamber folder hangs off the one root; a custom root gets `projects/`, `themes/`, and `speech-models/` copied in from `~/.config/openchamber` once at startup (copied, not moved: a second instance beside the default one must not strip it) (`lib/data-dir-migration.js`). A scratch server started with its own data dir therefore never touches the real project configs.
- An explicit project directory retains its pre-realpath spelling alongside the canonical directory because file-tree requests can name paths under a symlinked project root. With no explicit directory, the UI's `lastDirectory` precedes the sidebar's active project because navigation can leave that project selection stale.

## TypeScript boundaries

### Why setup parsers retain their sanitizers

The setup readers accept malformed file fields and patches. Schema transforms
retain the existing sanitization, defaults and thrown errors, including unknown
entries that other shared-file writers preserve. The record guard narrows only
the document container; it does not claim its values are validated setup fields.

### Why session registration retains a mutable match

The settings write queue calls the registration resolver before returning the
project. A nullable project field carries the linked-worktree match across that
callback without asserting that a callback-assigned local has changed.
Registration uses the trust owner's full assessment contract. Thrown values
remain unchecked until their error code is read; both objects and callable
errors can carry the trust refusal code.

### Why the directory schema has a dependency augmentation

`routes.ts` retains `z.literal(true).catch(false)`. Zod returns the fallback
without validating it against the literal, although its published declarations
require a fallback of `true`. `dependencies.d.ts` adds the `false` overload with
the original output unioned with `false`; the runtime schema stays unchanged.
Other truthy inputs still do not request directory creation.

The active id of a newly appended project comes from the same pure path-to-id
function as its stored id, avoiding an unchecked array index. Directory errors
retain their original message-property behavior, including inherited properties,
primitive values and the TypeError raised when a dependency throws null or
undefined.

### Why the project config runtime remains JavaScript

`project-config.js` imports Luxon without installed declarations; a local
dependency declaration can cover that boundary. The unresolved consumer is
`SharedProjectFileOwner` in `../magic-prompts/runtime.ts`: its
`readSharedProjectFile` result and `updateSharedProjectEntry` callback require
JSON values, while `parseSharedProjectConfig` establishes only
`SharedProjectDocument`, whose entries remain unknown.

Both `SharedProjectFileOwner` members reject the schema-derived contract with
TS2322. Correcting their declarations to accept unchecked values also requires
correcting `parseProjectOverrides` and its object guard: the parser already
checks every entry at runtime, but its declared input accepts only JSON values.
The resulting unchecked callback input and output violate
`anti-slop/no-unknown-parameters` and `anti-slop/no-unknown-returns`.
`parseProjectOverrides(value: unknown)` independently violates the parameter
rule. A raw dictionary declaration violates
`anti-slop/no-unsafe-dictionary-type`; changing `hasOwn` to accept `object`
violates `anti-slop/no-object-parameters`.

Type-only corrections, exported types, a small helper conversion, and dependency
augmentations cannot move this existing parser to an allowed parsing boundary.
Completion requires restructuring the parser/callback in `magic-prompts` or
changing lint policy. The shared parser's result stays schema-derived, and
unchecked values stay explicit rather than hidden behind aliases. Luxon's
missing declarations are a separate, locally declarable dependency boundary.

### Why directory resolution keeps external checks

Directory candidates and settings are JSON inputs. The runtime checks strings
before trimming directory values or comparing the active project id, and checks
thrown values for an object before reading their error code. Those guards retain
inherited properties and do not require errors to be `Error` instances.
Repeated query parameters still select the first array entry.

The filesystem, path, realpath cache, normalization and project sanitizer are
injected internal contracts. The optional request getter and settings-reader
getter have function types; their availability checks remain, while redundant
function-type checks are removed. The directory-refusal callback returns a
string or null, so only its non-null and non-empty checks remain.
The settings-reader contract requires either the direct reader or its deferred
getter, preserving late binding during server startup.

## Public exports (project-directory-runtime.js)
- `createProjectDirectoryRuntime(dependencies)`: creates runtime for request/project directory candidate normalization and validation. `dependencies.refuseDirectory(candidate)` answers the reason a resolved directory may not be used on this host, or null; `validateDirectoryPath` asks it before it looks at the disk, so a refused directory is never touched and never falls back to another one. The isolated-spaces host refuses `/spaces/...` through it while its switch is on.
- Returned API:
  - `resolveDirectoryCandidate(value)`
  - `validateDirectoryPath(candidate)`
  - `resolveProjectDirectory(req)`
  - `resolveOptionalProjectDirectory(req)`
