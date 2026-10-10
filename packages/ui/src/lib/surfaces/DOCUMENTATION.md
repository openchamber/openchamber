# Context Surfaces

## Purpose

`packages/ui/src/lib/surfaces` owns the declarative registry of context panel
surfaces — the desktop workspaces switched by the vertical rail on the right
edge (`components/layout/ContextPanelRail.tsx`) and rendered in the zones
around the chat by `components/layout/ContextPanel.tsx` (one per zone) and
`components/layout/ContextSurfacePanes.tsx`.

## Model

Full-screen extension pages are separate from this rail registry. `contributes.page` appears in one sidebar-header menu and uses `useUIStore.openGuestPageId`, the same mutually exclusive main-page lifecycle as Archive and Scheduled tasks. It mounts `PluginPane` with `surface="page"`, closes on runtime switch/uninstall/disable, and is not persisted. `openContextSurface` and the guest's `openSurface` cannot open a full-screen page. Work Status sections (`contributes.statusSection`) are not rail surfaces either: they mount `PluginPane` with `surface="status"` inside the chat's Work Status panel and never open a tab. The entry-point restrictions below describe context-rail surfaces only.

- A surface maps 1:1 to a `ContextPanelMode` tab mode in `useUIStore`.
  Built-in modes stay a closed list. Installed guests add `plugin:${id}`
  surfaces through `extras` on `sortContextSurfaces` /
  `getVisibleContextRailSurfaces`. Do not copy guest types out of
  `@openchamber/sdk`.
- `availability: 'always'` surfaces are always present on the rail.
  `availability: 'has-content'` surfaces (chat) are hidden from the
  rail until a tab of their mode exists, and stay visible for as long as one
  does — they must not disappear while in use.
- `defaultWidth` is the panel width in px, used until the user resizes that
  surface (640 for the wide surfaces, 540 for most, 480 for Git; guest panels
  540). A resize is remembered in px per mode in
  `useUIStore.contextPanelByDirectory[dir].widthByMode` and restored on reload.
  The width does not follow the chat area: a sidebar toggle or a window resize
  leaves it alone, and it only narrows when it would leave the chat less than
  its minimum column. `ContextPanel` keeps the chat area's width as state only
  while it decides something (expanded, or that ceiling binds), and applies a
  change that arrives during a side-column animation once it ends. Older
  builds also stored `widthFractionByMode`; hydration ignores it and keeps the
  pixel width the same resize stored.
  The file surface stores its full editor width under `file`. Without an
  editor, the panel uses `contextEditorTreeWidth`, the same pixel width as the
  docked file tree. Resizing the tree-only panel updates that shared tree width
  without changing the full editor width. Old `file-tree` width entries are
  discarded on hydration. Tree-only mode temporarily suspends panel expansion;
  reopening the editor restores its previous expanded state. The tree docks
  to the side `fileTreeSide` names (right by default, Settings › General ›
  Navigation) and stays aligned there at its saved width during the panel's
  collapse transition. The header's two layout icons keep their places and
  toggle whichever column stands on their side.
- Rail order is user-reorderable and persisted globally in
  `useUIStore.contextRailOrder`; `sortContextSurfaces` applies it on top of the
  registry's default order and appends any missing surfaces.
- `getVisibleContextRailSurfaces` is the single visibility filter shared by the
  rail and the global surface-switch shortcut (`switch_context_surface` in
  `lib/shortcuts`): it drops surfaces the user hid
  (`useUIStore.contextRailHiddenSurfaces`, edited from the rail's trailing
  configure button — `ContextRailSurfacesDialog`), drops the plan surface
  unless plan mode is enabled,
  drops the walkthrough on VS Code and below `WALKTHROUGH_MIN_WIDTH`, hides the pull-request surface
  unless GitHub is connected (OAuth or `gh` CLI — signed in from Settings →
  Integrations), and hides `has-content` surfaces
  until a tab of their mode exists. Both consumers use it so the digit shown
  on a rail badge always maps to the same surface the shortcut opens.

## Zones

Surfaces open in one of three zones around the chat (`lib/workspace/zones.ts`):
`right` (the context panel, and the default), `left` (between the session
sidebar and the chat) or `bottom` (under the chat column only; the side zones
keep the full height). The chat is always the centre and cannot move.

- Placement is per surface and per device: `useUIStore.contextSurfaceZones`
  maps a mode to `left` or `bottom`; a mode not in it is on the right. A user
  who never moves anything sees the single right panel as before.
- Each zone works like the right panel always has: the rail switches what it
  shows, multi-instance surfaces list their instances in its strip, and it
  closes, expands (one zone at a time) and resizes on its own. Per directory,
  the right zone keeps the panel's original top-level fields and the other two
  live in `zones`; read them through `getZoneView` / `resolveZoneActiveTab`,
  which never return a tab whose surface is placed elsewhere.
- A surface moves by dragging a rail icon out of the rail, a tab out of its
  strip (the zone's own, or a surface's own such as the terminal's, through
  `zoneSurfaceDragContext`), or a zone header anywhere no control takes the
  pointer (`components/layout/zoneDrag.ts`; a native listener, since surface
  toolbars are portalled into the header), or from "Move panel to …" on a
  tab's or rail icon's context menu. Targets are
  measured once at drag start; the layout changes once, on drop
  (`moveContextSurfaceToZone`). A surface that was on screen stays on screen
  in its new zone, in every project; one that was not is opened by the drop.
- Keep-alive surfaces mount once in `ContextSurfacePanes` and are portalled
  into the body of their zone (`MovablePane`), so a move keeps the editor's
  unsaved text and undo, the terminal session and the walkthrough's place. An
  Electron webview reloads whenever its element moves, so a browser tab
  reloads when its surface moves to another zone; nothing else moves it.
- In a narrow window the chat keeps 400 px: a side zone that opens without
  room folds the session sidebar, then closes the other side zone, and both
  come back when it closes (`ZoneFitArbiter`, `lib/workspace/zoneFit.ts`).
- Another window's move is adopted through the `storage` event
  (`zoneSync.ts`); each window keeps its own open zones.

## Adding a surface

1. Built-in: add a `ContextPanelMode` value in `packages/ui/src/lib/surfaces/modes.ts`
   (the sanitizer uses `isContextPanelMode`). Register a descriptor here.
   Render the mode in `ContextPanel.tsx`. Add label/hint i18n keys.
2. Guest panel: ship a package with `openchamber.contributes.panel`. The host
  lists it from `GET /api/guests` and renders `PluginPane`. Settings →
  Extensions installs a folder path on that OpenChamber instance. A runtime
  switch clears the catalog so a previous instance cannot leave a rail slot
  from the last host. The rail paints `panel.icon` as a Remixicon glyph.
  `contributes.attach: true` or `"panel"` puts a row on
   the desktop/web chat + menu that opens `plugin:${id}`. `"dialog"` opens a
   host window around the same iframe so the guest can pick an item and call
   `attach`. New Worktree also opens that window for dialog guests. The guest
   still owns the list and HTTP. VS Code and mobile omit the row. Do not add
   a built-in mode for that guest.

## Panel header

The panel has one header row. A single-instance surface with its own toolbar
(terminal, diff, walkthrough, plan, git's branch and sync controls, the notes
search, the context surface's session title) renders that toolbar through
`ContextPanelHeaderToolbar` (`components/layout/contextPanelHeaderSlot.tsx`)
instead of stacking a second row under the header: the toolbar replaces the
mode label and sits beside the fullscreen and close buttons. ContextPanel
provides the header element only to the surface on screen, so inactive tabs
and hosts outside the panel (the mobile workspace drawer) get no slot and
render the toolbar inline as before. A surface nested inside another one that
owns the header (the plan opened from the notes panel) is given a null slot. The label comes
back whenever no toolbar is mounted, so empty and loading states stay named.
Git moves only its first row: identity, pull request and upstream state stay
in the body below.

No new header buttons: the rail, `openContextSurface`, the composer +
menu (`contributes.attach`), and New Worktree's guest icons are the entry
points for opening surfaces or the attach window directly; deep links from
chat/palette go through the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, an in-content link, a composer + menu row from
  `contributes.attach`, or New Worktree's guest icons for dialog attach.
- Multi-instance and session-holding surfaces (file/editor, diff, browser,
  terminal) are keep-alive panes in `ContextSurfacePanes.tsx`. Switching these
  surfaces must not reset their state (open tabs, xterm session, scroll
  positions). Chat tab records stay open, but only the active chat tab's
  pinned chat column is mounted while the panel is open. A selected chat
  restores its state from the session stores. A closed panel mounts no chat.
  Singleton surfaces (git, pr, notes, plan, context) remount on switch. These
  surfaces must restore their state from stores or snapshots.
- Portalled menus and dialogs handle their own Escape key. The panel's capture
  handler ignores their events so dismissing an overlay does not close the panel.
  Escape closes the zone it was pressed in: the frame and each keep-alive pane
  run the same handler (`zoneEscape.ts`), since a pane's React events do not
  pass through its frame.
- Runtime scope: desktop/web `MainLayout` only. VS Code and the dedicated
  mobile shell have their own layouts and do not consume this registry.
  Linear has no rail surface: its issues list on the issues and PRs board
  (`components/sourceBoard`). A Linear tab persisted by an older version is
  dropped on load, like any unknown mode.
