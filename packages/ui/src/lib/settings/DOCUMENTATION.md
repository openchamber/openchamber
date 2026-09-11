# Settings

## Purpose

`packages/ui/src/lib/settings` owns what an OpenChamber setting *is*: its key, its scope, how a value is parsed at the boundary, and where the UI keeps its live copy. The storage and sync mechanics (debounced writes, mirrors, bootstrap adoption) live in `lib/persistence.ts` and consume this module; the Settings pages consume the stores.

## Modules

- `registry.ts` — the settings registry. One `SETTINGS_REGISTRY` table plus two key lists (`LOCAL_DEVICE_KEYS`, `DESKTOP_SHELL_KEYS`) and the derived helpers other modules use: `DesktopSettings` (the document type), `parseSettingsDocument`, `applySettingsToStores`, `AUTO_SAVE_KEYS` / `readAutoSaveSnapshot`, `MIRRORED_KEYS`, `buildSettingsRegistrySnapshot`.
- `parsers.ts` — value-level boundary parsers (zod schemas wrapped as `SettingsParser<T>`). `undefined` means "reject", never "default".
- `registry-snapshot.ts` — renders the plain-JSON snapshot for the two consumers that cannot import the UI's TypeScript: the OpenChamber server (`packages/web/server/lib/opencode/settings-registry.json`) and the VS Code extension host (`packages/vscode/src/settings-registry.json`). Regenerate with `bun run settings-registry:generate`; `registry.test.ts` fails when a checked-in copy is stale.
- `metadata.ts`, `search.ts` — Settings page metadata and the search index (unchanged by the registry; see `.agents/skills/settings-ui-patterns`).

## Invariants

- **A key that is not in the registry does not persist.** `parseSettingsDocument` drops unknown keys on the way in; `updateDesktopSettings` sends only registry keys that are not `computed`; the server and the VS Code bridge drop anything the snapshot does not list.
- **Every key has exactly one scope.** `instance` (a fact about the machine the server runs on, never synced), `profile` (the person's preference, shared by every client of the instance), `device` (state of this install/surface). `LOCAL_DEVICE_KEYS` are device fields that only ever lived in `useUIStore`'s persisted slice; `DESKTOP_SHELL_KEYS` are instance facts the Electron main process writes straight into `settings.json` and no client reads.
- **Per-surface profile fields** (`perSurface: true`) are a fixed, owner-decided set: the theme ids and mode, the chat-layout switches that depend on screen size, and the typography sizes. A change made on one surface kind is stored for that kind only: every settings request carries the client's kind as the `surface` query parameter, never a header, so the request needs no CORS preflight from the cross-origin desktop and phone shells and works against older instances (`surface.ts`: `vscode`, `desktop`, `mobile` for the phone app and the hosted mobile shell alike, else `web`), the store writes the value under `fields[key].surfaces[<kind>]` and leaves the base untouched, and a read resolves that kind's value first, the base value otherwise, or nothing (the client keeps what it holds). Writes without a surface (migrations, the one-time seed) set the base. The Settings UI is unchanged; the difference is only where the value lands.
- **Missing is not default.** `applySettingsToStores` writes only the fields the snapshot carries; an omitted field leaves the store as it is. Defaults live in the stores' initial state, not in the registry.
- **Writes carry intent.** Fields with `ui.autoSave` are watched by `lib/appearanceAutoSave.ts`; changes made while `isApplyingServerSettings()` is true (a sync copying server values in) are a new baseline, not a write. The six model-preference fields are watched by `lib/modelPrefsAutoSave.ts` with its own debounce and are therefore `autoSave: false` here.
- **Sibling-dependent applies are explicit.** A `ui.write` receives the parsed snapshot as `SettingsSiblingView`, which names the only siblings a write may consult (`draftStarters*Added`, `workStatusHiddenSectionsExplicit`). Extend the view when a new field needs one.
- **Device fields never cross the wire.** `updateDesktopSettings` drops `device` keys before the debounce, the server and the VS Code bridge drop them again, and the mirror never held them. Their home is the local store (`useUIStore` persisted slice, `mobileKeyboardMode` browser storage, `desktopSplashColors` in the desktop shell's own store via the window-theme IPC). A server document that still carries device keys from before the split is applied exactly once per runtime as a seed (`openchamber.deviceSeeded.v1:<runtimeKey>` in browser storage) and ignored afterwards.
- **Two files on the instance.** `settings.json` keeps instance facts and legacy keys; `preferences.json` beside it holds every `profile` key as `{ value, updatedAt }` (`version: 1`). The server (`packages/web/server/lib/opencode/settings-files.js`) and the VS Code bridge (`packages/vscode/src/settings-files.ts`) seed `preferences.json` once from an existing `settings.json`, keep a copy of the profile's base values in `settings.json` on every write (a build from before the split reads only that file, so a rollback keeps the user's preferences; current builds ignore the copy because `preferences.json` wins), and never touch a `preferences.json` they cannot parse; clients see one merged document and never address the files. Server modules that read a profile key off the disk (small model, session goal/assist, walkthrough) use `readMergedSettingsSync`.
- **Markers, not code, carry the special cases.** `adopt: 'bootstrap-only'` (workspace pointers), `derived` (computed by the writer from other fields), `secret` (accepted on write, never returned), `computed` (server-emitted, never persisted), `surfaces` (which surface kinds have the field).

## Adding a setting

1. Add one entry to `SETTINGS_REGISTRY` with `scope`, a parser from `parsers.ts`, and a `ui` binding when a store holds the live value. Use an existing setter so its side effects run.
2. Run `bun run settings-registry:generate` and commit both JSON snapshots.
3. If the server must validate the value beyond the registry gate, add its branch to `sanitizeSettingsUpdate` in `packages/web/server/lib/opencode/settings-helpers.js`; the drift test in `settings-helpers.test.js` needs a valid sample value for the new key.
4. Add the Settings control and search entry per `.agents/skills/settings-ui-patterns`.

`DesktopSettings`, `SettingsPayload`, the client sanitizer, the mirror, the apply step and the auto-save all follow from step 1; there is no second list to update.
