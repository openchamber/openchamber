# Project Context

Server-owned storage for the Project Notes surface: free-form notes, todos, and
plan markdown files.

The managed Chats root (`~/.config/openchamber/chats`) is also one context owner. Every dated per-session directory beneath it resolves to that root, so Notes, Todo, Plans, pinned knowledge, and project memory are shared across ordinary chats without registering Chats as a user project.

## Ownership

| Path | Owner | Contents |
|---|---|---|
| `<projectsDir>/<projectId>.json` | `packages/web/server/lib/projects` (`project-setup.js` for the client-owned keys behind `/api/projects/:projectId/config`; `project-config.js` for `version` / `scheduledTasks`), one write lock for both | worktree setup, draft starters, project actions, scheduled tasks |
| `<projectsDir>/<projectId>/context.json` | **this module, exclusively** | notes, todos, plan manifest |
| `<projectsDir>/<projectId>/plans/*.md` | **this module, exclusively** | plan bodies |
| `<projectsDir>/<projectId>/memory.json` | `packages/web/server/lib/agent-memory` | what the agent chose to remember about the project |
| `<repo>/<plansDir>/*.md` | this module (read, edit, delete, move) when the team config names a `plansDir`; the folder is the team's, any tool may write there | shared plan bodies |

`<projectId>` in these paths is the bounded stem `projectConfigFileStemOf`
(`packages/web/server/lib/projects/project-id.js`) gives the id: the id itself
up to 200 characters, `path_sha256_<digest>` beyond that, so a deeply nested
checkout gets a folder the filesystem accepts. The folder, the config file,
and the memory file all share that one stem; nothing here composes a path from
the raw id. The legacy-migration read below looks at the bounded config file
for the same reason: a read of `<raw id>.json` would fail with ENAMETOOLONG
and turn an empty project into an error.

The split is the point. Both files were previously one, written by the client
with a whole-file read-modify-write. Adding a server writer to that file would
have made unrelated features (project actions, draft starters) clobber notes
across processes, with no lock able to span both sides. Separate files remove
the shared resource instead of trying to coordinate access to it.

Nothing outside this module may write `context.json` or the `plans` directory.

## Storage format

```json
{
  "version": 2,
  "notes": [{
    "id": "", "body": "", "createdAt": 0, "updatedAt": 0,
    "source": "manual | selection | agent",
    "origin": { "sessionId": "", "messageId": "" },
    "planId": ""
  }],
  "todos": [{ "id": "", "text": "", "completed": false, "createdAt": 0, "planId": "", "dependsOn": [""] }],
  "plans": [{ "id": "", "file": "1700000000-title.md", "title": "", "createdAt": 0 }],
  "planSessions": { "<planId>": { "sessionId": "", "linkedAt": 0 } }
}
```

Notes are entries, not one blob. Version 1 stored a single string; it converts
to a single `manual` note on read (an empty string converts to no notes at
all). The conversion lives in the read path rather than a separate migration
pass so that every reader — including one racing a writer — sees one shape.
Legacy `pinned` fields may remain in existing files but are ignored; attachment
ownership lives in each session's metadata.

`source` records where a note came from, and `origin` links it back to the
message it was distilled from, so a note taken off a chat selection can be
traced to its conversation.

Notes and todos are written through separate routes. That split is what stops a
todo toggle from persisting half-typed notes alongside it, and stops an
agent-authored note from clobbering a concurrent todo change.

Plan links store a **base name**, never a path. The file always lives in
`<projectId>/plans/`, so moving the project storage directory cannot invalidate
a reference and a caller can never address a file outside it. `title` is
denormalized into the manifest so listing plans costs one read rather than one
read per plan; `readPlan` returns the title parsed from the file, which wins if
the two ever disagree.

## Plan progress

A plan's progress is its `## Steps` checklist: the knowledge tool tells agents
to open every plan with one and to tick a step when it is done, and
`plan-progress.js` counts ticked and total items in that section only (later
checklists are detail). There is no separate status field to drift from the
file. Listed plans carry `progress: { done, total }`; a plan without the
section, or whose file cannot be read, carries none, and one unreadable plan
never fails the list. `knowledge.save` answers a plan saved without the
section with a `warning`, so the agent adds it in the same turn.

Agents tick steps with their own file tools, which announce nothing, so the
Plans tab re-reads the list while it is on screen. Listing therefore costs one
`stat` per plan: a file is read and parsed again only when its modification
time or size changed. Clients receive the counts, never the text.

`planSessions` records the session a plan was last sent to with Implement or
Improve (`PUT .../plans/:planId/session`), so its card leads there. It is a map
beside the manifest because a plan that only lives in the team's folder has no
link to carry it. Deleting a plan drops its entry; a `shared:` plan made
personal takes its entry to the new id. A `null` session id clears the entry;
an omitted one is a validation error.

## Plan links and dependencies

A note or todo may carry `planId`, and a todo may carry `dependsOn`, a list of
todo ids. Both are optional and absent when empty, so existing records need no
migration. On every create, patch and whole-list write an omitted field keeps
its stored value, `planId: null` removes the link and `dependsOn: []` removes
every dependency. The whole-list write reads omission per todo id, so a client
that does not know these fields reorders without erasing them.

Every todo write validates the full candidate list under the project lock:

- A dependency joins two todos with the same non-empty `planId`. Standalone
  todos have no dependencies, and moving or unlinking a todo that would leave
  an edge across plans is refused (`400`).
- Self-dependencies and cycles are refused (`400`). Two concurrent requests
  that each add one half of a cycle serialize on the lock, so the second sees
  the first edge and fails.
- A new `planId` must name a plan in this owner, and a new dependency an
  existing todo (`400`). A stored reference whose shared plan file or todo
  vanished outside the API stays as it is; nothing repairs it. A todo that
  keeps a dependency on a vanished todo also keeps its plan until that
  dependency is removed.
- Deleting a todo, by the item route or the whole-list write, drops its id
  from the todos that depended on it in the same write. Only ids the write
  removes are dropped; a stored reference to a todo that vanished outside the
  API stays.

Deleting a plan unlinks its notes and todos in the same write, and its todos
lose their dependencies, which could only name todos of that plan. When
`unsharePlan` gives a `shared:` plan a manifest id, linked notes and todos
move to that id in the same write as its session entry. Refused writes change
no file and announce nothing.

### Why deleting unlinks and not refuses

The panel has no control for links: a refusal left a user who deleted a plan
or a todo with a generic error and no way to clear what blocked it, and Clear
completed failed for every finished plan whose steps depended on each other.
A deleted dependency counts as met, the same as a completed one.

## Shared plans

Every `.md` file in the repository plans folder is a plan too: `.openchamber/plans`
by default, or the `plansDir` the team config (`<repo>/.openchamber/project.json`,
see `packages/web/server/lib/projects`) names instead of it (the custom folder
replaces the default outright; moving files between the two is the user's job). `readContext` appends them after the personal ones,
each marked `source: "shared"` (personal ones get `source: "personal"`), and
reports the folder as `sharedPlansDir`. A shared plan is addressed as
`shared:<file>` when no manifest entry claims it; its title is parsed from the
file on every list, and `readPlan` / `updatePlan` / `deletePlan` work on the
file directly (an update writes the raw document verbatim, so a plan another
tool wrote keeps its shape). `setPlanPinned` is `404` for such a plan.

A plan the user moves there keeps its id: `sharePlan` moves the markdown into
the folder and keeps the manifest entry with `shared: true` (the flag says
which folder holds the file), so a session that attached the plan still finds
it, and the file is listed under that id instead of `shared:<file>`.
`unsharePlan` moves it back and clears the flag; a plan that only ever lived
in the team's folder gets a manifest entry (and an id) on the way in. A name
collision gets a numeric suffix. Sharing is refused only when the checkout cannot be located.

## Routes

| Method | Route | Notes |
|---|---|---|
| GET | `/api/project-context/:projectId` | full context; missing file is `200` empty |
| PUT | `/api/project-context/:projectId/todos` | replaces the whole list (reorder, clear completed); returns committed context |
| POST | `/api/project-context/:projectId/todos` | `201`; takes `{text, id?}`, adds one open todo before the completed ones; the panel sends the id its row already shows, and a taken or missing id gets a fresh one; returns committed context |
| PATCH | `/api/project-context/:projectId/todos/:todoId` | takes `text` and/or `completed`; completing moves it last, reopening puts it before the completed ones; returns committed context; `404` when unknown |
| DELETE | `/api/project-context/:projectId/todos/:todoId` | returns committed context; `404` when unknown |
| POST | `/api/project-context/:projectId/notes` | `201`; takes `{body, source?, origin?}` |
| PATCH | `/api/project-context/:projectId/notes/:noteId` | patches `body`; legacy `pinned` input is ignored by session knowledge; `404` when unknown |
| DELETE | `/api/project-context/:projectId/notes/:noteId` | `404` when unknown |
| PATCH | `/api/project-context/:projectId/plans/:planId` | legacy project pin state only; session attachment uses session knowledge; `404` when unknown |
| GET | `/api/project-context/:projectId/plans/:planId` | `404` when the link or its markdown is gone; the answer carries `path`, the markdown's absolute path, so comments on the plan name the file to the agent (reads and writes stay id-addressed) |
| POST | `/api/project-context/:projectId/plans` | `201`; takes `{title, body}`, never a path |
| PUT | `/api/project-context/:projectId/plans/:planId` | takes the whole `{raw}` document; `404` when the link or its markdown is gone |
| DELETE | `/api/project-context/:projectId/plans/:planId` | `404` when unknown |
| POST | `/api/project-context/:projectId/plans/:planId/share` | moves the plan into the shared folder; `400` without one, `404` when unknown |
| POST | `/api/project-context/:projectId/plans/:planId/unshare` | moves a `shared:` plan back; `404` when unknown |
| PUT | `/api/project-context/:projectId/plans/:planId/session` | takes `{sessionId}`, the session the plan was just sent to; replaces the previous one; `404` when unknown |

**Body parsing is attached per route.** This server has no global JSON parser:
`core-routes` parses only an allowlist of `/api` path prefixes so the generic
OpenCode proxy keeps an unread request stream, and every other `/api` request
passes through untouched. A write route that forgets `express.json()` therefore
sees `req.body` as `undefined` and rejects every request as a malformed body —
which is exactly how this shipped once. `routes.http.test.js` mounts the routes
on a bare express app so that failure mode fails the suite instead of the user.

`projectId` is validated against `/^[a-zA-Z0-9._:-]+$/`, which rejects
separators and traversal. Validation failures are `400`; malformed stored data
and I/O failures are `500`.

## Change notifications

After `writeContext` atomically commits `context.json`, the runtime calls its optional `onChanged(projectId)` dependency. The server broadcasts `openchamber:project-context-changed` with `{ projectId }` on the existing OpenChamber control stream. It carries the path-derived owner id, not the bounded storage stem or any note content. Failed writes and missing-entry no-ops announce nothing. Updating or deleting a shared plan through the API announces the same way after the file write, since shared plans have no manifest entry.

Clients re-read authoritative context for the visible owner. This is a commit notification, not a filesystem watcher; direct changes to shared plan files outside the API retain their existing read-on-open behavior.

## Invariants

- **Missing is not malformed.** A missing `context.json` is authoritative empty
  data. Unparseable JSON is a failure that propagates as `500`, so the client
  preserves what it already has instead of rendering an empty panel over intact
  data on disk.
- **Writes are serialized per project** through an in-process lock, and land via
  write-to-temp + rename so a crash cannot leave a half-written file.
- **`readContext` never takes the lock.** Every mutator calls it while already
  holding the lock, so locking there would deadlock. The legacy migration it can
  trigger is safe unlocked: both writes are atomic renames of identical content.
- **Plan create writes markdown before the manifest entry**; delete removes the
  manifest entry before the file. Either partial failure leaves an unreferenced
  markdown file, which is inert. The reverse order would leave a manifest entry
  that renders as a plan and fails to open.
- **Plan update takes the raw document, not title + body.** The editor owns
  the file verbatim; reassembling it from parsed parts would rewrite the
  heading and reformat what the user typed. The manifest title is re-derived
  from the saved content, and the file name never changes with the title — it
  is the stable identity behind the link.
- **Plan update refuses to recreate a deleted file.** If the markdown vanished
  underneath an open editor the link is already dead; writing would resurrect
  content the user believes was discarded, so it returns `404` instead.
- **A note patch touches only the fields it names.** Pinning sends `pinned`
  alone, so it cannot roll back an edit that landed between the two requests,
  and editing does not reset a pin. Editing bumps `updatedAt`; pinning does not,
  because a pin is not a change to what the note says.
- **A note body can be clamped but never blanked.** An empty body is rejected
  rather than stored, since a note with nothing in it is indistinguishable from
  a delete the user did not ask for.
- **Panel item writes touch one todo.** The panel sends a check, uncheck,
  add or delete as one item route, applied to the list as it is on disk, so a
  todo an agent added since the panel's last read survives it. Only a reorder
  or "clear completed" sends the whole list.
- **Agents write conditionally; the panel does not.** `updateNote` and
  `updatePlan` take an optional `expectedBody` / `expectedRaw` and answer `409`
  without writing or announcing when the stored text differs. Only the agent
  tool passes them (`../openchamber-control/project-knowledge.js`): what the
  user types in the panel is saved over an agent's change, and an agent that
  read before the user's save is refused and reads again.
- **Notes are capped at 200 per project.** Past that, creation fails loudly
  instead of silently evicting the oldest entry.
- **Per-entry sanitization never fails the whole read.** A malformed todo or
  plan link is dropped; the rest of the context still loads.

## Legacy migration

`projectNotes`, `projectTodos`, and `projectPlanFiles` originally lived in
`<projectId>.json` (the bounded name, see Ownership). On the first read with
no `context.json`, those three keys are moved out and deleted from the
client-owned file; every other key is preserved untouched.

Plan links carried absolute paths. Migration converts each to a base name. A
file already in the plans directory is used in place; one referenced from
elsewhere — a stale path left by an earlier project id — is copied in rather
than dropped. A link whose markdown cannot be found at all is discarded, since
it could not have been opened either way.

The legacy keys are removed only after `context.json` is durably written, so any
failure simply leaves the migration to run again on the next read. Repeat and
concurrent reads converge on identical content.

## Cross-module contract

`packages/web/server/lib/opencode/settings-runtime.js` merges project storage
when a project id changes. Its `mergeProjectContextFiles` step must run before
`moveDirectoryContents`, because that mover only renames into a free
destination and would otherwise discard the old `context.json` whenever the
destination already had one.

`mergeProjectContextFiles` merges every list by identity and deliberately does
not convert a version 1 string note: this module owns that conversion, and
doing it in two places would mean two definitions of the same migration.

`mergeProjectConfigData` still merges the legacy `projectNotes` /
`projectTodos` / `projectPlanFiles` keys. That is deliberate: a project whose
context has not been migrated yet keeps its data in `<projectId>.json`, and the
migration picks it up from the merged destination afterwards.

## Tests

- `runtime.test.js` — storage, sanitization, migration, locking, plan lifecycle.
- `routes.test.js` — status-code mapping, payload validation, failure surfacing.
