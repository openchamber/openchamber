**Plan**

**1) Dynamic Window Title (web + desktop)**
- Add `packages/ui/src/hooks/useWindowTitle.ts` and call it from `packages/ui/src/App.tsx`.
- Title parts: `[projectName] | [instanceName if non-local] | OpenChamber`.
- `projectName`: from `useProjectsStore` active project; prefer `label`, else basename of `path`.
- `instanceName` (desktop only): reuse `desktopHostsGet + locationMatchesHost` logic (same as `Header.tsx`), omit when local.
- Apply:
  - always set `document.title`
  - if Tauri: `@tauri-apps/api/window` → `getCurrentWindow().setTitle(title)` (best-effort)

**2) Custom Project Icons (PNG/JPEG/SVG) stored on server + persisted in `settings.json`**
- Extend project schema:
  - `packages/ui/src/lib/api/types.ts` `ProjectEntry` add `iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null`
  - Update UI+server sanitizers to preserve it:
    - `packages/ui/src/stores/useProjectsStore.ts` `sanitizeProjects`
    - `packages/ui/src/lib/persistence.ts` `sanitizeProjects`
    - `packages/web/server/index.js` `sanitizeProjects`
- Server storage + API (Express):
  - Add JSON parsing for `req.path.startsWith('/api/projects')` in the existing body-parser gate (`packages/web/server/index.js` around the `express.json` middleware switch).
  - Store icon files under `~/.config/openchamber/project-icons/` (i.e. `OPENCHAMBER_DATA_DIR/project-icons`), filename based on `sha1(projectId)` + extension (prevents path traversal / odd IDs).
  - New routes in `packages/web/server/index.js`:
    - `GET /api/projects/:projectId/icon` → serve file (Content-Type from stored mime, `Cache-Control: immutable` with `?v=updatedAt`)
    - `PUT /api/projects/:projectId/icon` body `{ dataUrl: string }` → validate mime, decode, write file, update `projects[].iconImage` in `settings.json` via `persistSettings`
    - `DELETE /api/projects/:projectId/icon` → delete file(s), clear `iconImage`, persist
    - `POST /api/projects/:projectId/icon/discover` → best-effort “try this first”: search project dir for `favicon.(ico|png|svg|jpg|jpeg|webp)` using existing `searchFilesystemFiles()`, pick shortest match, store it as `source:'auto'` (skip if `source:'custom'` unless `force=true`)
- UI wiring:
  - Add async actions in `packages/ui/src/stores/useProjectsStore.ts`: `uploadProjectIcon(id, file)`, `removeProjectIcon(id)`, `discoverProjectIcon(id)`
  - Update renderers to prefer `iconImage` over `PROJECT_ICON_MAP`:
    - `packages/ui/src/components/layout/NavRail.tsx`
    - `packages/ui/src/components/sections/projects/ProjectsSidebar.tsx`
    - `packages/ui/src/components/chat/MobileSessionStatusBar.tsx`
  - Add upload/remove/(discover) UI controls:
    - `packages/ui/src/components/sections/projects/ProjectsPage.tsx`
    - `packages/ui/src/components/layout/ProjectEditDialog.tsx`
  - `<img src={`/api/projects/${encodeURIComponent(id)}/icon?v=${updatedAt}`}>` (small size, fits existing tile layout)

**3) File Tree File-Type Icons (full icon pack)**
- Vendor the full directory from `/tmp/opencode/packages/ui/src/assets/icons/file-types` into `packages/ui/src/assets/icons/file-types/`.
- Add `packages/ui/src/lib/fileTypeIcons.ts`:
  - build an icon URL map with `import.meta.glob('../assets/icons/file-types/*.svg', { eager: true, as: 'url' })`
  - map filename/extension → icon key (use `getLanguageFromExtension()` + a small alias map, plus `_light` variant selection based on `useThemeSystem().currentTheme.metadata.variant`)
  - fallback to `document.svg`
- Add `packages/ui/src/components/icons/FileTypeIcon.tsx` (renders the resolved icon URL).
- Replace current generic file icons with `FileTypeIcon` (keep folder icons as-is):
  - `packages/ui/src/components/layout/SidebarFilesTree.tsx`
  - `packages/ui/src/components/views/FilesView.tsx`
  - `packages/ui/src/components/chat/ServerFilePicker.tsx`

**Verification (end of build mode)**
- `bun run type-check`
- `bun run lint`
- `bun run build`
