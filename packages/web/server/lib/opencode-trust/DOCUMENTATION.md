# OpenCode folder trust

## Ownership

Whether OpenCode may open a folder. OpenCode imports a folder's plugins and
starts the commands in its configuration (local MCP servers, language
servers, formatters, a custom shell) the first time any request names that
folder, before a prompt or a tool call. A cloned repository or a pull request
checked out for review would run its own code the moment OpenChamber shows it.
This module refuses such a folder until the user trusts exactly the
configuration it has, and asks again when that configuration changes.

- `assessment.js` finds what OpenCode would run from a folder, mirroring
  OpenCode 2.x discovery (`packages/core/src/config/discovery.ts` and
  `config/plugin/source.ts` in the OpenCode repository), and fingerprints it.
- `store.js` keeps the trusted fingerprints per repository in
  `<dataDir>/opencode-trust.json`.
- `index.js` decides per request (`refusalFor`) and serves
  `GET`/`POST /api/opencode/trust` (`handleRoute`) for every runtime.
- `fetch-guard.js` puts the same decision in front of every request the
  server process sends OpenCode itself.
- `session-directory.js` names the folder of a session whose route runs in
  the session's own location.

The prompt lives in the shared UI (`packages/ui/src/lib/opencodeTrust.ts`,
`components/projects/OpenCodeTrustDialog.tsx`): the OpenCode client hands a
refusal to it, shows what would run, saves a "trust" answer here and sends the
refused request again.

Session admission also uses this prompt before registering an unknown host
destination as a project. A configuration that runs nothing or whose current
fingerprint is trusted registers without another dialog. There is no separate
folder-consent store. The destination registration route and VS Code workspace
bridge recheck trust before changing the registry. Runtime switches dismiss
pending UI prompts and invalidate their continuations.

Where the check runs:

| Runtime | Path to OpenCode | Check |
|---|---|---|
| Web, desktop, hosted and Capacitor mobile | UI through the server proxy | `opencode/proxy.js` middleware |
| Same server | server features with their own clients | `guardOpenCodeFetch`, installed over `globalThis.fetch` in `server/index.js` |
| VS Code | webview through the extension bridge | `vscode/src/bridge-proxy-runtime.ts`, same answers file |
| An OpenCode the user runs on their own | not through OpenChamber | none; OpenCode itself has no trust prompt |

## Invariants

- A request that names a folder (`x-opencode-directory`, `?directory=`,
  `location[directory]`) or acts on a session reaches OpenCode only when that
  folder's configuration runs nothing or its current fingerprint is trusted.
  Routes that start no location (session list and detail, message pages, the
  event stream, credentials, deleting, moving or viewing a session, unloading a
  location) pass, so a paused folder still lists and shows its sessions. Any
  other route, including ones OpenCode adds later, is checked.
- A session route is checked against the session's folder as well, read from
  OpenCode's session record. The `global` owner is the exception: OpenCode
  files MCP elicitation forms under it, it has no session record, and its
  routes, such as a form's reply and cancel, run in the folder the request
  names, so only that folder is checked. A lookup of `global` answers 400, which would refuse
  every reply to such a form.
- Trust is per repository: every worktree of one repository shares the
  answers, and a worktree whose configuration differs from every trusted one
  asks. The latest 20 fingerprints per repository are kept, so switching
  between branches that each carry trusted plugins does not ask again.
- The projects already in the user's list when the check first runs are
  trusted as they are, once (`seeded` in the answers file). OpenCode ran
  their configuration before the check existed, so a prompt for each would
  protect nothing. A project added later, a worktree whose configuration
  differs, and any later change to a seeded project ask. A seeding that
  cannot read the project list records nothing and runs again on the next
  start. Every check waits for the seeding, so projects are read in parallel
  and one that takes over 2 seconds (a network share that stopped answering)
  is left out and asks when opened.

## Cost

Measured on an M-series Mac: one check reads a folder in 0.2 to 0.5 ms
without plugins and about 4 to 6 ms for 30 plugin files plus a configuration
and a 200-repository answers file. Requests that name no folder, or name only
global routes, read nothing.

The server reads a folder once each time OpenCode opens it. A trusted answer
holds until OpenCode reports the folder closed (`location.shutdown` on the
event stream, through `forget`); the next opening reads it again, which is
where a pull made while it was closed is caught. While the event stream is
down closings go unreported, so answers last 2 seconds, and a new connection
forgets them all (`followLocations`). Untrusted answers always last 2
seconds, so a folder whose plugin was removed opens without a prompt.

VS Code follows closings the same way: its global event watcher
(`vscode/src/sessionActivityWatcher.ts`) runs while the extension is
connected to OpenCode and reports `location.shutdown` to the shared instance
in `vscode/src/opencodeTrust.ts`.
- A store that cannot be read trusts nothing. The prompt returns rather than
  code running unasked; the next answer rewrites the file.
- `POST /api/opencode/trust` records only the fingerprint the user was shown.
  When the configuration changed since, nothing is recorded and the answer
  carries the current configuration to show instead.
- Startup warming and the directory server-side reads fall back to
  (`lifecycle.js` through `getWarmupDirectories` and `onLastDirectoryChanged`
  in `server/index.js`) are trusted folders only, so features that read
  OpenCode with no folder of their own keep working on a folder that may open.

## Decisions

### Why queued prompts read trust again

Several worktrees can have untrusted assessments before the user answers the
first prompt. Each queued prompt reads the server's current assessment when
its turn arrives, so the first saved answer also opens unchanged worktrees
without another confirmation. Already-trusted requests bypass the prompt queue;
a failed assessment still leaves its folder closed.

### Why a gate in OpenChamber and not a setting in OpenCode

OpenCode 2.1 has no per-folder trust: the only switch,
`OPENCODE_DISABLE_PROJECT_CONFIG`, turns off project configuration for every
folder at once, including the agents and skills users rely on. Upstream
reports of the same problem (#6361, #7163) were closed by a stale bot without
a fix. The gate goes when OpenCode asks before loading a folder's code itself.

### Why the fingerprint covers code, not the whole configuration

Only entries that run code count: plugin files and folders (content hashed),
configured plugins (local ones content hashed, packages by name), and the
commands of local MCP servers, language servers, formatters and the shell. A
folder with only models, agents or skills opens without a prompt, and editing
those never asks again. A configuration file that does not parse counts as
code, since OpenCode may still read what this parser rejects.

### Why a plugin's hash covers the local files it imports

A trusted plugin that imports `../../scripts/helper.js` runs whatever that
file holds, so a pull request could change the helper and keep the plugin's
own hash. The local files a plugin's scripts import, and the files those
import, are hashed into the plugin's hash, along with every local import that
names no file yet. A plugin that imports nothing local keeps the hash of its
own content, so answers given before imports were followed still hold.
Package imports are left out: `node_modules` is installed, not committed.

### Why the walk stops below home

Levels from the user's home up hold the user's own setup and OpenCode's global
configuration, which no repository writes. Counting them would ask about the
user's own plugins in every project.

### Why the server guards `fetch` globally

Server features call OpenCode with folders the UI hands them, each through a
client of its own (session titles, routing, dispatched sessions, scheduled
runs, the agent's OpenChamber tool). A check per feature missed the session
title lookup in testing and would miss the next feature too. One guard on the
process's `fetch` covers all of them; requests to any other origin pass
untouched. The proxy forwards through `http-proxy-middleware`, not `fetch`, so
it keeps its own middleware.

### Known limits

- A folder OpenCode already runs reloads its plugins when they change on disk.
  The gate decides when a location starts; switching a running folder to a
  branch with different plugins loads them as the OpenCode CLI would.
- A plugin's imports are followed when they name a file by a literal relative
  or absolute path. Package imports, `tsconfig` path aliases, computed import
  specifiers and files a plugin reads and evaluates itself are not, so a
  change behind one of them does not ask again.
- A plugin folder past 500 files or 16 MB is hashed by path and size beyond
  that budget, and its imports are followed within a budget of the same size.
