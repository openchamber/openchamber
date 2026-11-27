# Settings

## Ownership

This module owns OpenChamber's settings persistence: the instance and profile files, their migrations, path and record normalization, request sanitizing and response shaping, and the generated registry snapshot `settings-registry.json` (`bun run settings-registry:generate` writes it from the UI registry). `GET` and `PUT /api/config/settings` are registered by `../opencode/routes.js`, which receives this runtime from server composition. What a setting means belongs to the feature that reads it.

## Invariants

- Settings callers that regenerate persisted identity use the strict reader: only ENOENT means first run. Corrupt JSON, non-object content, and I/O errors throw so a transient read failure cannot replace pairing keys and orphan devices.
- Feature switches that rewrite `settings.json` outside the save queue (GitHub's gh switches, Linear's session comments) read it with `settings-update-read.ts`: only ENOENT means an empty document, and any other failure rejects the change before anything is written, so a locked or torn file is never replaced by the one changed key.
- Settings writes replace complete files atomically because Electron and SSH readers can treat a partial JSON read as an empty document and then overwrite the user's settings. The temporary file is flushed to disk before the rename (here, in the VS Code extension host and in the Electron shell), so a machine that stops mid-write keeps the old file or the new one, never a file of NUL bytes. Only directories created by the write receive tightened permissions; existing administrator permissions and ACLs remain intact.
- Project validation preserves entries after permission or transient filesystem failures. Project context reconciliation merges lists by identity across ID changes because a directory move cannot merge two existing `context.json` files; version-1 string conversion stays owned by `project-context`, and the destination wins when both values remain strings.
- Project-folder migration also checks raw names that the filesystem can hold because older IDs can still have data there. Orphan recovery uses a unique setup-command match against an otherwise empty canonical project; an orphan's folder is named by its actual raw filename.
- Empty notification templates select language-aware defaults. Migration clears only the old seeded English set and preserves user-authored text. Splitting scheduled tasks from the control tool preserves an earlier choice to disable that tool.
- Settings logs contain changed field names only because values can include credentials. Device keys remain local to the client, and each failed queued save rejects only its own caller so later saves can still run.
- A missing model-variant entry means the client never sent a selection; explicit null means Default. A variant without its model is discarded, and an empty dreaming-model selection remains a choice of the default model. Model IDs can contain slashes after the provider separator.
- Sidebar-order saves from older clients preserve omitted built-in sections beside their stored neighbours (`settings-sidebar.ts`, which validates every sidebar section, pin list and Pages field). Page ids in `sidebarPageOrder` and `sidebarHiddenPages` run to 128 characters, since an extension page is `guest:` plus an extension id of up to 64. The generated settings registry remains authoritative for writable keys; its JSON snapshot is loaded with `createRequire` because the server runs plain ESM across Node versions with differing import-attribute support.
- `settings-file-state.ts` keeps independent last-valid snapshots of `settings.json` and v1 `preferences.json`. Malformed documents and invalid recognized values retain their previous snapshot and pause writes to that source: a save that needs the file fails and names it, and nothing overwrites it. A file that holds nothing but NUL bytes or whitespace is the exception: it is renamed to `<name>.damaged-<time>` beside it and read as missing (see *Why a blank settings file is moved aside*). A file that went missing after a valid read retains its snapshot, and the next save restores it from there. Initial absence permits preference seeding, but not while `settings.json` is unreadable: a seed from its empty snapshot would own the profile and hide the values the file holds once it is repaired. Atomic app publications acknowledge their exact source document. While either file is unreadable, reading settings serves the last valid snapshot with migrations applied in memory and writes nothing; the migration is written on the first read after a valid replacement.

## Decisions

### Why settings use the existing folder scheduler

Both files share the signal, settle and safety-check mechanism used by themes.
Semantic changes emit `openchamber:settings-changed` with only `source` and
recognized `changedKeys` through the authenticated control stream.
Native-shell-owned fields stay outside UI validation and notification.
Failed delivery remains retryable; shutdown suppresses pending announcements.

### Why a save takes in an outside edit and is not refused

Saves used to answer an error until the watcher had reconciled an edit made
outside, about two seconds. `settings-exclusive-save.ts` now reconciles first,
in the save's own queue turn, then applies the user's change to the result: the
user's keys win, every other outside key stays. When a file changes during the
write, the save starts over from a new snapshot, five times at most. An edit a
save took in is announced from there (`subscribeTakenInSettings`), because the
watcher no longer finds it pending. A mixed save with a broken
`preferences.json` writes its instance keys, then fails and names the profile
keys it did not save. The exception is an outside profile edit still pending in
`settings.json`: writing that file would mark the edit as seen and lose it, so
the whole save fails and nothing is written.

Saves, reconciliation and migration writes hold `settings.json.lock`
(`source-control/file-lock.ts`), so two OpenChamber servers on one data
directory do not overwrite each other. A program that does not take the lock
can still replace a file in the instant between a save's last check and its
rename; that edit is lost, as no file system offers compare and rename.

### Why a migrating read writes through the save queue

`settings-migrated-reader.ts` owns this. A read that migrates used to write on its own. A save overlapping it then failed
the revision check, and the user's change answered 500. The migration now takes
a queue turn and is recomputed there. A read made while the queue is busy serves
the migrated values and leaves the write to a later read: that read can come
from inside the running save, which would wait on itself.

### Why legacy profile edits are reconciled before notification

A valid `preferences.json` owns the whole profile. A changed profile key in
`settings.json` is explicit global intent, so reconciliation promotes that value
to the preference base and removes overrides for that key only. An explicit
`themeId` with system following off applies that mode globally. Omitted keys
preserve unrelated preferences. Direct preference edits retain their surface
scope, including light/dark selection hints.

Reconciliation uses the same write queue as user saves, project registration
and feature-owned updates. The watcher's keys are only a hint: when its turn in
the queue comes, reconciliation rereads both files and takes the changed keys
from that snapshot, so a second save made while it waited is promoted and
announced too. It publishes preferences before their legacy mirror and
acknowledges published files after both writes succeed. Revision and reread
checks reject detected intervening edits, and an edit that lands during
publication restarts reconciliation from a new snapshot, a few times at most;
the files are not a cross-process filesystem transaction. A failed mirror
retains retryable state. The result lists every source and key to announce. Simultaneous
preference deltas and live server callbacks apply before notification.
Restart-only settings remain restart-only.
`settings-reconciliation.ts` owns external profile reconciliation and the runtime
callback dispatch shared by file changes and user saves.

### Why settings preserve the transcription prompt as typed

`settings-dictation.ts` keeps `sttPrompt` untrimmed because the client applies
the save response to the field as the user types. Dictation trims it when
starting a transcription.

### Why request values and sanitized settings have separate types

`settings-helpers.ts` keeps unchecked settings fields schema-derived and unknown;
`SanitizedSettings` describes only the fields its checks establish. In particular,
notification templates are passed through after an object check that also accepts
arrays, and provider logo MIME types keep the schema's inferred string type.
Merged disk settings remain unchecked because migrations preserve legacy keys.
The path normalizers preserve non-string inputs unchanged. Their conditional
return types express that passthrough, while string callers receive strings.
Normalized projects, model references and skill catalogs are owned by
`settings-normalization-runtime.ts`; tunnel presets use the existing contract
from `tunnels/managed-config.ts`.

Usage-group property reads retain JavaScript's primitive boxing and nullish
`TypeError`. Optional unknown properties describe those
reads without claiming that unchecked entries are valid group configurations.
Falsy custom-group entries still short-circuit before reading their properties.

### Why Zod's undefined catch has a local declaration

Zod accepts `catch(undefined)` at runtime and returns undefined on failure, which
the effort sanitizer discards. `zod-catch.d.ts` adds that overload without changing
the schema. Its output includes undefined and keeps object fields optional;
it does not claim an optional inner schema or an `unwrap` result the runtime
does not provide.

### Why persistence readers keep unchecked field values

Instance reads accept non-array objects and preserve legacy and unknown keys.
Preference reads check the version and entry layout. The file-state boundary
validates recognized notifiable values with the settings sanitizer; native-shell
and unknown fields stay outside that validation. Both readers use the
schema-derived `SettingsDocument` fields, preserving the values as stored.

Property guards preserve primitive boxing where legacy code reads optional
properties. Null project entries and non-list tunnel presets still fail during
queued persistence. Array checks and own-property checks remain at dictionary
and file boundaries, including token string checks that reject inherited object
members. Internal migration inputs and sanitized project paths no longer need
object or string rechecks. Filesystem error-code guards retain the existing
object acceptance rule. Temporary-file cleanup and an invalid legacy directory
remain best-effort operations.

### Why a blank settings file is moved aside

A Windows machine that stops before a write reached the disk can leave `settings.json` or `preferences.json` at its new length and full of NUL bytes (#7761). Such a file failed to parse, so it paused writes like a hand-made typo, and every profile save answered "Save failed" until the user found and deleted the file. A file with no characters other than NUL bytes and whitespace holds no settings, so `settings-file-state.ts` renames it to `<name>.damaged-<time>` and reads it as missing: the next read seeds `preferences.json` from the profile copy in `settings.json`, or starts `settings.json` empty, and saves work again. Any other unreadable text still pauses writes, since it may hold settings the user can repair. The first `GET /api/config/settings` afterwards carries the renamed files in `settingsFilesSetAside`, once per server, and the UI shows one toast with their names; the VS Code extension host does the same through its `settings:get` bridge message. The writers now flush before the rename, which removes the usual way such a file appears. A rename racing another process that writes the file in the same instant could move that new file aside; it stays beside the original under the damaged name.

### Why a read of unchanged file text reuses the accepted document

`settings-file-state.ts` parses and validates a file only when its text differs from the text it last accepted; the same text returns a clone of the accepted document. Validation calls the sanitizer once per notifiable key, which costs about 30 ms on a real 85 KB `settings.json`, and the server reads settings many times per action: one project-knowledge sync before every prompt read them eight times, about 250 ms of a 330 ms sync. Caching by modification time was rejected because a write within the same timestamp tick would serve stale settings; comparing the text costs one file read and is exact.

### Why the file validator accepts a legacy key through its successor

`sanitizeSettingsUpdate` folds some legacy keys into their replacement instead of echoing them back: `queueModeEnabled` becomes `followUpBehavior`. The file validator accepts a recognized key only when the sanitizer returns it, so without an exception a profile that still holds `queueModeEnabled` was reported unreadable on every start, its projects disappeared and every save was refused (#7582). `LEGACY_SETTING_SUCCESSORS` in `settings-file-state.ts` lets such a key count as valid when the sanitizer produces its successor. Echoing the legacy key from the sanitizer instead was rejected because the sanitizer also shapes save payloads, which must not reintroduce the old key. A value the sanitizer cannot convert, such as a non-boolean `queueModeEnabled`, still fails validation.

### Why a mirror rewrite keeps a copy of hidden legacy profile values

A build affected by #7582 could seed an empty `preferences.json` while it read `settings.json` as unreadable. A valid `preferences.json` owns the profile, even an empty one, so once `settings.json` reads again its profile values are hidden, and the first write of the legacy mirror (a migrating read or any save) would erase them. Importing them automatically was rejected: an empty profile cannot be told apart from one the user cleared on purpose. Instead, before `settings.json` is replaced, `settings-legacy-profile-backup.ts` checks for profile keys the current file holds that the last valid `preferences.json` has no global value for (a surface-only override does not count), and whose value the new document drops or changes. Those keys and their values, and nothing else from `settings.json`, are written to `settings.legacy-profile.json` beside it (mode 0600) through a temporary file and an atomic replace, so a failed write leaves no partial copy and the mirror rewrite fails with it. A key already in the copy keeps its first value, the original; a later rewrite only adds keys the copy lacks. The server logs the key names. Instance data such as projects is unaffected either way.

To restore the old profile from that copy:

1. Quit OpenChamber completely (desktop: quit the app; web: stop the server).
2. In the settings folder, delete or move away `preferences.json`.
3. Copy the fields you want back (for example `fontSize`) from `settings.legacy-profile.json` into `settings.json`, keeping everything else in `settings.json` as it is.
4. Start OpenChamber. It seeds a new `preferences.json` from `settings.json`.

### Why orphan recovery runs once and not on every settings read

Unmatched orphan files remain on disk, so repeating the scan adds filesystem work without new evidence. The process remembers the first attempt, including before its first await, to prevent concurrent and frequent settings reads from repeating it.

### Why settings project validation runs only on project updates

Validation probes every project's filesystem path. Theme and window-state saves need no such work, so unrelated updates preserve the project list without revalidating it.

## Modules

- `packages/web/server/lib/settings/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization). With no project stored, the legacy migration turns a stored `lastDirectory` into the first project, except a folder inside the chats roots (`chatRoots` dep, compared lexically and by realpath): with no project open the UI's last directory is usually a chat's, and a chat belongs to no project.
- `packages/web/server/lib/settings/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep. `lastDirectory: ''` is kept as written: the UI sends it when the last project is removed, and every reader (the warm-up, the legacy last-directory-to-project migration, request directory resolution) treats it as unset.
- `packages/web/server/lib/settings/settings-legacy-profile-backup.js`: the copy of hidden legacy profile values taken before a mirror rewrite would erase profile values `preferences.json` does not hold (see *Why a mirror rewrite keeps a copy of hidden legacy profile values*).
- `packages/web/server/lib/settings/settings-normalization-runtime.js`: path/settings/tunnel normalization and sanitization helpers runtime used by settings/routes/config wiring. Project records keep `labelSource` beside `label` so every client can tell a derived label from one the user typed; an unknown value, or a source without a label, is dropped.

## Public exports (settings-runtime.js)
- `createSettingsRuntime(dependencies)`: creates settings lifecycle runtime for read/migrate/persist concerns.
- Returned API:
  - `readSettingsFromDisk()`
  - `readSettingsFromDiskMigrated()`
  - `writeSettingsToDisk(settings)`
  - `persistSettings(changes)`
  - `updateSettingsFromDisk(mutate)`: read-modify-write for a server-side feature
    writer that owns one field, such as the relay config or the VAPID keys. The
    mutation receives the current document inside the same write queue as
    `persistSettings`, so a feature write and a user save cannot revert each
    other. A mutation that returns the document it received writes nothing.
    Writing a whole document with `writeSettingsToDisk` outside that
    queue can overwrite a concurrent save.
  - `registerSessionProject(resolveProject)`: resolves one project against the
    latest registry inside the settings write queue and appends only if absent.
    It preserves unrelated keys and navigation pointers, writes only the instance
    document, rejects malformed input settings and reports success after the
    atomic write. Trust checking belongs to the session destination route.
  - `takeSetAsideSettingsFiles()`: names of blank settings files moved aside since the last call; the settings `GET` route hands them to the first client that reads.
- Persistent per-session permission modes are stored under `permissionAutoAccept`, and the mode for new sessions under `permissionDefaultMode`; execution ownership lives in `lib/permission-auto-accept/`.
- Queued follow-up messages live in `<data-dir>/message-queue.json`, not in settings; execution ownership lives in `lib/message-queue/`.
- Shared sidebar preferences are stored as validated top-level fields: `sidebarProjectDisplayMode`, `sidebarSessionGroupingMode`, `sidebarListSessionGrouping`, `sidebarProjectSortOrder`, `sidebarShowChatsSection`, `sidebarShowWorkSection`, `sidebarShowPinnedSection`, `sidebarDetailedZoneRows`, and `sidebarWorktreeNameByBranch`. Device-local picker selection and sticky-header state do not enter either settings file.
- Two files (`settings-files.js`): `settings.json` holds instance facts and any legacy or unknown keys; `preferences.json` beside it holds every key the generated registry snapshot (`settings-registry.json`) marks `profile`, as `{ version: 1, fields: { key: { value, updatedAt, surfaces? } } }`. Keys the snapshot marks `perSurface` are stored per surface kind: `GET`/`PUT /api/config/settings` read the client's kind from the `surface` query parameter (`settingsSurfaceOf`; the legacy `x-openchamber-surface` header is still honoured, but a header forces a CORS preflight that cross-origin shells and older instances refuse, so clients must not send one) (`web`, `desktop`, `vscode`, `mobile`; anything else means base), `persistSettings(changes, { surface })` writes a changed per-surface key under `surfaces[surface]` and never touches its base, and `readSettingsFromDisk({ surface })` resolves that kind's value first, the base otherwise. A write only clears a per-surface key its own view held: a key set from one kind alone has no base, so another kind's write or a base write never sees it and must keep it (`buildPreferencesFields`); dropping it there once wiped a fresh setting on every unrelated save. Callers without a surface (migrations, the seed, server-side feature writers) read and write the base. `readSettingsFromDisk()` returns the merged document and seeds `preferences.json` once from an existing `settings.json` (which it leaves intact). An existing `preferences.json` that fails to parse is a failure, not an empty profile, unless it is blank (moved aside, above): it is never seeded or overwritten, the merged read serves the instance part, and `persistSettings` drops profile keys with a warning until the file is fixed or removed. `writeSettingsToDisk(document)` splits by scope and writes `settings.json` as the instance part plus a copy of the profile's base values (`legacySettingsDocumentOf`): a build from before the split reads only that file, so a rollback keeps the user's preferences, while current builds ignore the copy because `preferences.json` wins in the merge; device keys are dropped from writes. Modules that read one profile key off the disk on a hot path use `readMergedSettingsSync`.

## Public exports (settings-files.js)
- `parsePreferencesDocument(raw)`, `serializePreferencesDocument(fields)`, `flattenPreferences(fields)`, `buildPreferencesFields(previousFields, document, now)`, `instancePartOf(document)`, `seedPreferencesFrom(document, now)`, `readMergedSettingsSync({ fs, path, settingsFilePath })`, `getSettingsScope(key)`, `isProfileSettingsKey(key)`, `isDeviceSettingsKey(key)`, `preferencesFilePathFor(settingsFilePath, path)`, `isBlankSettingsText(text)`.
- The VS Code extension host writes the same two files with the same shape (`packages/vscode/src/settings-files.ts`); format changes go to both.

## Public exports (settings-helpers.js)
- `createSettingsHelpers(dependencies)`: creates settings helper runtime for settings request/response shaping.
- Returned API:
  - `normalizePwaAppName(value, fallback?)`
  - `sanitizeSettingsUpdate(payload)`
  - `mergePersistedSettings(current, changes)`
  - `formatSettingsResponse(settings)`

## Public exports (settings-normalization-runtime.js)
- `createSettingsNormalizationRuntime(dependencies)`: creates normalization/sanitization runtime for shared settings and tunnel helper logic.
- Returned API:
  - `normalizeDirectoryPath(value)`
  - `normalizePathForPersistence(value)`
  - `normalizeSettingsPaths(input)`
  - `listSettingsPaths(input)`: every path in a settings document, spelled the way `canonicalPathOf` is asked for it
  - `normalizeTunnelBootstrapTtlMs(value)`
  - `normalizeTunnelSessionTtlMs(value)`
  - `normalizeManagedRemoteTunnelHostname(value)`
  - `normalizeManagedRemoteTunnelPresets(value)`
  - `normalizeManagedRemoteTunnelPresetTokens(value)`
  - `isUnsafeSkillRelativePath(value)`
  - `sanitizeTypographySizesPartial(input)`
  - `normalizeStringArray(input)`
  - `sanitizeModelRefs(input, limit)`
  - `sanitizeSkillCatalogs(input)`
  - `sanitizeProjects(input)`

### Why canonical paths are looked up before a settings read and not during it

`canonical-paths.ts` resolves symbolic links (the JavaScript `fs.realpath`, which keeps a Windows drive letter where the native one answers the UNC path) and, on `win32` and `darwin`, recovers the on-disk casing of each component by listing its ancestors, so a project stored in the wrong case still matches the directory OpenCode reports (#1913). An exact name wins, so case-sensitive volumes are never rewritten; a path that cannot be resolved stays as stored; a backslash is a legal name character on macOS. `readMigratedSettings`, `persistResolvedSettings` and `registerSessionProject` call `refresh` for every path in the document, then the synchronous normalizers read the answers through `canonicalPathOf`. The normalizers used to call `realpathSync` and `readdirSync` themselves, which froze the whole desktop app for the length of an SMB timeout on every settings read while a project's share was offline (#2096).

A refresh asks `../directory-reachability` first and never touches an unreachable path: its last canonical form, or the stored one, stays in use. It waits at most half a second; a later answer is used by the next read. Lookups run one at a time, so a share that dies mid-lookup holds one pool thread. One refresh lists each shared ancestor once (#6084), and nothing is cached between refreshes except the answers, which every reachable refresh replaces. Project validation likewise keeps an unreachable project: only a folder known to be gone is dropped.
