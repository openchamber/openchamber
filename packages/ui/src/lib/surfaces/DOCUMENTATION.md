# Context Surfaces

## Purpose

`packages/ui/src/lib/surfaces` owns the declarative registry of context panel
surfaces — the desktop workspaces switched by the vertical rail on the right
edge (`components/layout/ContextPanelRail.tsx`) and rendered by
`components/layout/ContextPanel.tsx`.

## Model

- A surface maps 1:1 to a `ContextPanelMode` tab mode in `useUIStore`.
  Built-in modes stay a closed list. Installed guests add `plugin:${id}`
  surfaces through `extras` on `sortContextSurfaces` /
  `getVisibleContextRailSurfaces`. Do not copy guest types out of
  `@openchamber/sdk`.
- `availability: 'always'` surfaces are always present on the rail.
  `availability: 'has-content'` surfaces (chat) are hidden from the
  rail until a tab of their mode exists, and stay visible for as long as one
  does — they must not disappear while in use.
- `defaultWidthFraction` is the panel width as a fraction of the content area,
  used until the user manually resizes that surface. Manual widths are stored
  per mode in `useUIStore.contextPanelByDirectory[dir].widthFractionByMode`;
  `widthByMode` retains the last pixel size until the available area is known.
  Every surface, including walkthrough, restores both values on reload.
- Rail order is user-reorderable and persisted globally in
  `useUIStore.contextRailOrder`; `sortContextSurfaces` applies it on top of the
  registry's default order and appends any missing surfaces.
- `getVisibleContextRailSurfaces` is the single visibility filter shared by the
  rail and the global surface-switch shortcut (`switch_context_surface` in
  `lib/shortcuts`): it drops surfaces the user hid
  (`useUIStore.contextRailHiddenSurfaces`, edited from the rail's trailing
  configure button — `ContextRailSurfacesDialog`), drops the plan surface
  unless plan mode is enabled,
  drops the walkthrough on VS Code and below `WALKTHROUGH_MIN_WIDTH`, hides
  Linear unless a workspace is connected, hides the pull-request surface
  unless GitHub is connected (OAuth or `gh` CLI — signed in from Settings →
  Integrations), and hides `has-content` surfaces
  until a tab of their mode exists. Both consumers use it so the digit shown
  on a rail badge always maps to the same surface the shortcut opens.

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

No new header buttons: the rail, `openContextSurface`, the composer +
menu (`contributes.attach`), and New Worktree's guest icons are the entry
points for opening surfaces or the attach window directly; deep links from
chat/palette go through the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, an in-content link, a composer + menu row from
  `contributes.attach`, or New Worktree's guest icons for dialog attach.
- Multi-instance and session-holding surfaces (file/editor, diff, browser,
  terminal) are keep-alive panes in `ContextPanel.tsx`. Switching these
  surfaces must not reset their state (open tabs, xterm session, scroll
  positions). Chat tab records stay open, but only the active chat iframe is
  mounted while the panel is open. A selected chat restores its state from
  the session stores. A closed panel mounts no chat iframe.
  Singleton surfaces (git, pr, linear, notes, plan, context) remount on switch. These
  surfaces must restore their state from stores or snapshots.
- Runtime scope: desktop/web `MainLayout` only. VS Code and the dedicated
  mobile shell have their own layouts and do not consume this registry.
  Linear is a desktop/web singleton on this rail. VS Code and mobile omit it
  (no this registry, and VS Code has no `RuntimeAPIs.linear`). The Linear
  rail icon is hidden until a Linear workspace is connected. A persisted Linear
  tab stays open across reload until auth has resolved; only a confirmed
  disconnect closes the panel. The surface lists
  issues with status (All, Backlog, To Do, In Progress, In Review, Done, Canceled, Duplicate), assignee, team, and priority filters, can switch
  the current workspace, and keeps Start session in a footer on the issue card.
  Those filters restore from `useUIStore` when the surface remounts. Non-default
  status, assignee, team, priority, and search tint the filter icon `text-primary`,
  same as the context rail; one control clears them. Workspace switch is not a
  filter. Work-status Context sources
  can open a specific issue here through `linearIssueFocus`. Below 520px
  search and the filters other than status drop to icons; status keeps its label. The card
  shows priority and labels. Changing filters keeps the previous list
  until the next page arrives.
