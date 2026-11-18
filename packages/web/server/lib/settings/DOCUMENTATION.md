# Settings

## Ownership

This module owns OpenChamber's settings persistence: the instance and profile files, their migrations, path and record normalization, request sanitizing and response shaping, and the generated registry snapshot `settings-registry.json` (`bun run settings-registry:generate` writes it from the UI registry). `GET` and `PUT /api/config/settings` are registered by `../opencode/routes.js`, which receives this runtime from server composition. What a setting means belongs to the feature that reads it.

## Invariants

- Settings callers that regenerate persisted identity use the strict reader: only ENOENT means first run. Corrupt JSON, non-object content, and I/O errors throw so a transient read failure cannot replace pairing keys and orphan devices.
- Settings writes replace complete files atomically because Electron and SSH readers can treat a partial JSON read as an empty document and then overwrite the user's settings. Only directories created by the write receive tightened permissions; existing administrator permissions and ACLs remain intact.
- Project validation preserves entries after permission or transient filesystem failures. Project context reconciliation merges lists by identity across ID changes because a directory move cannot merge two existing `context.json` files; version-1 string conversion stays owned by `project-context`, and the destination wins when both values remain strings.
- Project-folder migration also checks raw names that the filesystem can hold because older IDs can still have data there. Orphan recovery uses a unique setup-command match against an otherwise empty canonical project; an orphan's folder is named by its actual raw filename.
- Empty notification templates select language-aware defaults. Migration clears only the old seeded English set and preserves user-authored text. Splitting scheduled tasks from the control tool preserves an earlier choice to disable that tool.
- Settings logs contain changed field names only because values can include credentials. Device keys remain local to the client, and each failed queued save rejects only its own caller so later saves can still run.
- A missing model-variant entry means the client never sent a selection; explicit null means Default. A variant without its model is discarded, and an empty dreaming-model selection remains a choice of the default model. Model IDs can contain slashes after the provider separator.
- Sidebar-order saves from older clients preserve omitted built-in sections beside their stored neighbours. The generated settings registry remains authoritative for writable keys; its JSON snapshot is loaded with `createRequire` because the server runs plain ESM across Node versions with differing import-attribute support.

## Decisions

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

### Why orphan recovery runs once and not on every settings read

Unmatched orphan files remain on disk, so repeating the scan adds filesystem work without new evidence. The process remembers the first attempt, including before its first await, to prevent concurrent and frequent settings reads from repeating it.

### Why settings project validation runs only on project updates

Validation probes every project's filesystem path. Theme and window-state saves need no such work, so unrelated updates preserve the project list without revalidating it.

## Modules

- `packages/web/server/lib/settings/settings-runtime.js`: Settings persistence runtime (disk IO, migrations, normalization, project validation, and persisted update serialization). With no project stored, the legacy migration turns a stored `lastDirectory` into the first project, except a folder inside the chats roots (`chatRoots` dep, compared lexically and by realpath): with no project open the UI's last directory is usually a chat's, and a chat belongs to no project.
- `packages/web/server/lib/settings/settings-helpers.js`: Settings payload sanitization/format helpers runtime for response shaping and persisted merge prep. `lastDirectory: ''` is kept as written: the UI sends it when the last project is removed, and every reader (the warm-up, the legacy last-directory-to-project migration, request directory resolution) treats it as unset.
- `packages/web/server/lib/settings/settings-normalization-runtime.js`: path/settings/tunnel normalization and sanitization helpers runtime used by settings/routes/config wiring. Project records keep `labelSource` beside `label` so every client can tell a derived label from one the user typed; an unknown value, or a source without a label, is dropped.

## Public exports (settings-runtime.js)
- `createSettingsRuntime(dependencies)`: creates settings lifecycle runtime for read/migrate/persist concerns.
- Returned API:
  - `readSettingsFromDisk()`
  - `readSettingsFromDiskMigrated()`
  - `writeSettingsToDisk(settings)`
  - `persistSettings(changes)`
  - `registerSessionProject(resolveProject)`: resolves one project against the
    latest registry inside the settings write queue and appends only if absent.
    It preserves unrelated keys and navigation pointers, writes only the instance
    document, rejects malformed input settings and reports success after the
    atomic write. Trust checking belongs to the session destination route.
- Persistent per-session permission modes are stored under `permissionAutoAccept`, and the mode for new sessions under `permissionDefaultMode`; execution ownership lives in `lib/permission-auto-accept/`.
- Queued follow-up messages live in `<data-dir>/message-queue.json`, not in settings; execution ownership lives in `lib/message-queue/`.
- Shared sidebar preferences are stored as validated top-level fields: `sidebarProjectDisplayMode`, `sidebarSessionGroupingMode`, `sidebarListSessionGrouping`, `sidebarProjectSortOrder`, `sidebarShowChatsSection`, `sidebarShowWorkSection`, `sidebarShowPinnedSection`, `sidebarDetailedZoneRows`, and `sidebarWorktreeNameByBranch`. Device-local picker selection and sticky-header state do not enter either settings file.
- Two files (`settings-files.js`): `settings.json` holds instance facts and any legacy or unknown keys; `preferences.json` beside it holds every key the generated registry snapshot (`settings-registry.json`) marks `profile`, as `{ version: 1, fields: { key: { value, updatedAt, surfaces? } } }`. Keys the snapshot marks `perSurface` are stored per surface kind: `GET`/`PUT /api/config/settings` read the client's kind from the `surface` query parameter (`settingsSurfaceOf`; the legacy `x-openchamber-surface` header is still honoured, but a header forces a CORS preflight that cross-origin shells and older instances refuse, so clients must not send one) (`web`, `desktop`, `vscode`, `mobile`; anything else means base), `persistSettings(changes, { surface })` writes a changed per-surface key under `surfaces[surface]` and never touches its base, and `readSettingsFromDisk({ surface })` resolves that kind's value first, the base otherwise. A write only clears a per-surface key its own view held: a key set from one kind alone has no base, so another kind's write or a base write never sees it and must keep it (`buildPreferencesFields`); dropping it there once wiped a fresh setting on every unrelated save. Callers without a surface (migrations, the seed, server-side feature writers) read and write the base. `readSettingsFromDisk()` returns the merged document and seeds `preferences.json` once from an existing `settings.json` (which it leaves intact). An existing `preferences.json` that fails to parse is a failure, not an empty profile: it is never seeded or overwritten, the merged read serves the instance part, and `persistSettings` drops profile keys with a warning until the file is fixed or removed. `writeSettingsToDisk(document)` splits by scope and writes `settings.json` as the instance part plus a copy of the profile's base values (`legacySettingsDocumentOf`): a build from before the split reads only that file, so a rollback keeps the user's preferences, while current builds ignore the copy because `preferences.json` wins in the merge; device keys are dropped from writes. Modules that read one profile key off the disk on a hot path use `readMergedSettingsSync`.

## Public exports (settings-files.js)
- `parsePreferencesDocument(raw)`, `serializePreferencesDocument(fields)`, `flattenPreferences(fields)`, `buildPreferencesFields(previousFields, document, now)`, `instancePartOf(document)`, `seedPreferencesFrom(document, now)`, `readMergedSettingsSync({ fs, path, settingsFilePath })`, `getSettingsScope(key)`, `isProfileSettingsKey(key)`, `isDeviceSettingsKey(key)`, `preferencesFilePathFor(settingsFilePath, path)`.
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

Persistence path normalization (`normalizePathForPersistence` / `normalizeSettingsPaths` / `sanitizeProjects`, reached via the `readSettingsFromDiskMigrated` migration and `persistSettings`) resolves symlinks with `realpathSync` and, on case-insensitive filesystems (`win32`, `darwin`), also recovers the on-disk casing of each path component via `readdirSync` (exact-name match preferred so case-sensitive volumes are never rewritten). `realpathSync` alone does not report on-disk casing on these volumes, so without the readdir step a project stored with the wrong case would never match the real-case `directory` opencode reports for its sessions (issue #1913). A corrected path is flagged `changed` and written back to `settings.json`. A path `realpathSync` cannot resolve (missing, no permission) is kept exactly as stored, so case recovery can never swap in a different existing sibling. On macOS only `/` separates components; a backslash is a legal name character. Every settings read runs `sanitizeProjects` three times, so one pass over the project list reads each directory at most once: projects share their ancestors, and reading `/`, `/Users` and the rest again per project made a 71-project settings read about 1,280 synchronous readdirs (#6084). The listings live only for that one synchronous pass, so a later read always sees the disk as it is; a longer-lived cache would need invalidation on a case rename and was not needed once a pass reads each folder once.
