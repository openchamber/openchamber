# Local issues tracker

The design and requirements live in `issue-local-spec/本地Issue管理需求与设计方案.md` (repo root); this document describes the server module as it is now.

## Ownership

This module is the `local` tracker in the tracker registry (`../trackers/registry.js`, id `local`). It owns the markdown issue files under each project's issues directory — `<project.path>/<issuesDir ?? '.issues'>/LOCAL-<n>-<slug>.md` — and everything derived from them: the frontmatter fields, the body, the `## Comments` section, per-project preferences (`preferences.js`, stored in the OpenChamber data dir) and the session-status comment posts. The issues directory default and the per-project `issuesDir` override belong to the settings layer (`server/index.js` sanitizes the `projects` array; the module only reads it through the `listProjects` it is given).

It is deliberately remote-free: no account, credential, or network call. `tracker.js` maps the scanner's shapes onto the neutral tracker contract (`../trackers/tracker-contract.d.ts`); `index.js` is the registry entry and takes the settings reader by injection (see *Decisions*).

Routes answered (through the shared `/api/tracker/local/*` routes, host-only in `spaces/dispatcher.js`): `GET providers` includes the descriptor; `GET auth/status` (always connected as `Local`; `auth/start`, `auth/activate`, `DELETE auth` answer 404 — there is nothing to authenticate); `GET items/list`, `GET items/get`, `POST items/update` (state only), `POST items/create`, `POST items/edit` (fields present in the body only), `GET states` (the descriptor's `create`/`edit` capabilities are true); `GET|PUT preferences` (`{ sessionComments }`); `POST session-status` (the runtime posts comments on OpenCode session events, and the UI can post the same shape directly). `mapping` is not offered (`projectMapping: false`).

## Invariants

- **Identifiers are immutable.** `LOCAL-<n>` is assigned at create time from the per-project counter, becomes the file name, and never changes. The number restarts at 1 per project; the project is what makes an issue unique. A file whose parsed identifier disagrees with its file name, or a duplicated identifier in one project, is skipped with a warning, never served.
- **Six states, exactly:** `triage`, `backlog`, `todo`, `in-progress`, `done`, `canceled` (`files.js` `STATES`). An unknown state in a file is skipped at parse; an update to an unknown state is rejected.
- **The scan cache is per-file `mtimeMs`+`size`.** Parsed issues are reused while both match the directory stat; any outside writer (the user in an editor, this module's own `writeIssue`) invalidates the file on the next scan. The cache is per project and lives for the server run.
- **Writes are atomic: tmp file + rename** (`writeIssue`). `writeIssue` does not create the directory — callers guarantee it exists (`scanner.create` does); a caller that does not fails with the rename error rather than silently writing elsewhere.
- **The `## Comments` section format:** entries are `### <iso> · <source>` headings followed by body lines. The section is rebuilt in normalized form on every comment append; the head (everything above it) is preserved verbatim. `updatedAt` is bumped by the append.

## Decisions

### Why the settings reader is injected instead of imported

`settings-runtime.js` exports only the `createSettingsRuntime` factory; the runtime instance (and with it the migrated settings state) belongs to `server/index.js`, which builds it from server-level paths and sanitizers. Importing the factory here would build a second runtime over the same settings file — two caches and two writers racing. So `index.js` exports `configureLocalTracker({ readSettings })`, called once at startup before the registry can load the tracker, and `load()` refuses to run before that with a loud error rather than serving an empty project list.

### Why the session-comment link and dedupe maps are in memory only

`sessionLinks` (session id → `{ identifier, sessionOrigin }`, recovered from the `started` post because OpenCode events carry neither) and `postedStatuses` (dedupe key `sessionId:kind`, FIFO cap 500) live for the server run. A restart loses in-flight links and dedupe markers: the `started` comment on the issue file already records the link for humans, and the maps refill on the next post. Linear persists a records file; if duplicates appear in practice, revisiting that is an M2 decision, not a default.

### Why `appendComment` drops content below a second `## ` heading under `## Comments`

`splitComments` reads the section as `###` entries only. A second `## ` heading inside the section (user-added structure under the comments) is not an entry, so the rebuilt section drops it. Everything above `## Comments` survives verbatim; the drop is confined to content that the format cannot represent.

### Why issue files live outside the OpenChamber data dir

The spec puts issues in each project so they version with the project and travel with a checkout. The cost — scan caching by stat, path traversal care, slug sanitizing — is owned here; no other module writes into `issuesDir`.
