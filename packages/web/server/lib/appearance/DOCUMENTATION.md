# Appearance

## Ownership

This module owns what the server keeps and serves for how OpenChamber looks: custom themes, their folder watch and the theme catalog, project icons, provider logos and the PWA manifest. The themes are announced to clients on the control stream; the stream itself belongs to `../notifications`.

## Invariants

- Project-icon discovery resolves its settings update inside the write queue. A search can outlast project removal or a manual icon selection and must preserve the latest project list and chosen icon. Uploaded SVGs remain inert when opened as documents on the app origin.

## Modules

- `packages/web/server/lib/appearance/theme-runtime.js`: custom theme JSON validation and theme directory loading runtime for settings utility routes. A theme file that stops loading (a half-written save, a typo, an oversized or unreadable file) keeps serving the last version of that file this process loaded, so the theme on screen stays put while it is edited; a file that never loaded is skipped, and a removed file drops its theme at once.
- `packages/web/server/lib/appearance/theme-watch.js`: watches the custom themes folder and sends `openchamber:themes-changed` on the control stream, with nothing in it, once a `.json` file there was added, removed or rewritten and then held still for one check; every client reads `GET /api/config/themes` again. Imports and deletes through the routes are announced the same way, so other windows follow them. The first look is taken at creation, so a save right after start is announced. The feature routes runtime owns the one watch: registering routes again replaces it, and graceful shutdown stops it.

  ### Why themes use folder signals with a safety poll

  Node `fs.watch` signals coalesce into fingerprint checks after 1 second, with another check 1 second later to settle a change. The shared scheduler in `../fs/folder-change-watch.js` also checks and reopens the watcher every 30 seconds because Linux/Windows watchers can silently retain a deleted folder; pure watching misses recreation, while pure polling lists and stats themes every idle second. Missing folders and unavailable, errored or closed watchers retain the 1-second fallback until the safety poll restores the watcher. OpenCode's experimental file watch requires a project location and misses new files, so it cannot own the custom themes folder.

  `POST /api/config/themes` saves a converted VS Code palette. The runtime validates
  literal colors and required authored roles, assigns a content-derived filename,
  and publishes through a same-directory hard link so partial files and overwrites
  are impossible. Identical retries reuse the existing file; a manually edited
  collision returns 409. Temporary files are ignored by the loader and removed
  after publication or failure. Non-missing-directory read failures propagate to
  the route instead of returning an authoritative empty library.

  The common request middleware parses theme POST bodies before these routes;
  integration tests must use that middleware rather than an unrestricted test parser.
  `DELETE /api/config/themes/:id` finds a valid regular JSON file by its metadata ID
  inside the custom themes directory. IDs are never used as filenames. Hand-added
  themes are supported; symlinks and bundled themes are outside deletion ownership.
  Duplicate matching IDs fail explicitly. Missing themes are an idempotent success;
  filesystem failures remain errors.
  `theme-catalog.js` owns POST catalog search/package routes under
  `/api/config/themes/catalog/`. It fetches only Open VSX and its Eclipse CDN over
  HTTPS, validates redirects and checksums, and verifies packaged identity.
  An empty search query returns the most downloaded color themes; the catalog
  opens on them. The Themes category also holds icon themes, VS Code's built-ins
  and tools that ship a theme on the side, so the popular list keeps entries
  outside the `vscode` namespace whose name has no "icon" and whose name or
  description speaks of a theme or colors.
  `theme-archive.js` reads selected JSON entries in memory with bounded decompression.
  JSON includes and token references stay inside the package. Each failed variant
  is reported separately so valid siblings remain available. No extension code runs.
- `packages/web/server/lib/appearance/project-icon-routes.ts`: project icon upload/read/discovery route registration and icon storage orchestration.
- `packages/web/server/lib/appearance/provider-logo-routes.js`: a provider's uploaded logo, `GET/PUT/DELETE /api/provider/:providerId/logo`. PUT takes `{ dataUrl }` (PNG, JPEG, WebP or SVG, at most 1 MB decoded; anything else is 400) and writes `<data-dir>/provider-logos/provider-<sha1 of id>-<updatedAt>.<ext>`; the profile setting `customProviderLogos` holds only `{ mime, updatedAt }` per provider ID, written through `persistResolvedSettings`, and that pair names the file. The new file is written first, then the setting, then the provider's other files are removed. A settings write that fails, or resolves without the key because `preferences.json` is unreadable, removes the new file and answers 500, and the previous logo stays served: its file is never rewritten. DELETE drops the setting first, then the files, and answers 200 when nothing was stored. Uploads and removals for one provider run one at a time, so two clients saving at once cannot delete the file the other's setting names. GET serves the file the setting names with the same inert-image headers as project icons (`INERT_IMAGE_CSP`, `nosniff`, an immutable cache the client versions with `v=<updatedAt>`); for an SVG, `theme=light|dark` sets its CSS colour so `currentColor` reads on either background. The routes sit under `/api/provider`, which isolated spaces treat as host-only. Enterprise mode does not gate them: the bytes stay on this machine and no provider, key or endpoint is added.

  ### Why the logo is kept by provider ID and not removed with the provider

  The logo is keyed by provider ID like a chosen icon (`customProviderIcons`), and OpenChamber has no "remove provider" flow: a provider leaves when someone edits the OpenCode config, which OpenChamber does not watch for this. Deleting logos from a config diff would need a complete, authoritative provider list per directory; keeping them costs one small file, and a provider added again under the same ID gets its logo back. The logo goes when the user removes it, on the provider's page or with Remove in the custom-provider form before Save; an untouched form keeps it.
- `packages/web/server/lib/appearance/pwa-manifest-routes.ts`: PWA manifest route registration with recent-session shortcut resolution and short-lived caching.

## Public exports (theme-runtime.js)
- `createThemeRuntime(dependencies)`: creates custom theme runtime for on-disk theme discovery and JSON normalization/validation.
- Returned API:
  - `normalizeThemeJson(raw)`
  - `readCustomThemesFromDisk()`

## Public exports (project-icon-routes.ts)
- `registerProjectIconRoutes(app, dependencies)`: registers project icon routes and owns icon storage/discovery flow:
  - `GET /api/projects/:projectId/icon`
  - `PUT /api/projects/:projectId/icon`
  - `DELETE /api/projects/:projectId/icon`
  - `POST /api/projects/:projectId/icon/discover`: writes the icon through `persistResolvedSettings`, so a save that lands during the file search keeps its projects.

## Public exports (pwa-manifest-routes.ts)
- `registerPwaManifestRoute(app, dependencies)`: registers PWA manifest endpoint with dynamic app-name resolution and recent-session shortcuts:
  - `GET /manifest.webmanifest`: served without API auth (the browser fetches it with cookies, `crossorigin="use-credentials"`). Session shortcuts, which carry session titles, are added only for an authorized caller, and their directory is the one the UI last used, never one named in the request.

## Decisions

### Why project settings have separate read and saved shapes

Disk settings expose unchecked `projects`; the settings sanitizer establishes project IDs, paths and icon metadata before icon routes use them. The saved-settings response runs that sanitizer too. Its project list can therefore be typed, while the disk read remains unchecked.

### Why recent-session fields remain JSON values

The session endpoint supplies JSON without a session schema check. List members, IDs, directories and timestamps retain their existing checks before becoming shortcuts; a decoded JSON object alone does not establish a complete session.
