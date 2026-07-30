# Context Surfaces

## Purpose

`packages/ui/src/lib/surfaces` owns the declarative registry of context panel
surfaces — the desktop workspaces switched by the vertical rail on the right
edge (`components/layout/ContextPanelRail.tsx`) and rendered by
`components/layout/ContextPanel.tsx`.

## Model

- A surface maps 1:1 to a `ContextPanelMode` tab mode in `useUIStore`.
- `availability: 'always'` surfaces are always present on the rail.
  `availability: 'has-content'` surfaces (preview, chat) are hidden from the
  rail until a tab of their mode exists, and stay visible for as long as one
  does — they must not disappear while in use.
- `defaultWidthFraction` is the panel width as a fraction of the content area,
  used until the user manually resizes that surface (manual widths are stored
  per mode in `useUIStore.contextPanelByDirectory[dir].widthByMode`).
- `defaultHeightFraction` is the same idea for the bottom dock, resolved against
  the content area height and stored per mode in the separate
  `heightByMode` map. It is required on every descriptor, and the two maps never
  seed each other: persisted widths are 380-1400px and would be absurd heights.
  Unlike widths, the defaults are uniform across all surfaces — bottom-dock
  surface switches happen in place, so differing defaults make the panel jump
  vertically under the chat.
- Dock edge is a global user preference, `useUIStore.contextPanelDock`
  (`'right' | 'bottom'`, default `'right'`). It moves the whole panel as one
  unit; there are no per-surface dock positions. The rail stays a vertical strip
  on the right in both docks, so a bottom-docked panel spans the chat column
  only — not the sessions sidebar or the rail.
- Rail order is user-reorderable and persisted globally in
  `useUIStore.contextRailOrder`; `sortContextSurfaces` applies it on top of the
  registry's default order and appends any missing surfaces.

## Adding a surface

1. Add a `ContextPanelMode` value in `useUIStore` (type union plus the
   sanitizer whitelist in `sanitizeContextPanelTabs` and `isContextPanelMode`).
2. Register a descriptor here (icon, label key, availability, width fraction,
   height fraction).
3. Render the mode in `ContextPanel.tsx` (content dispatch, label, icon).
4. Add label/hint i18n keys to every locale dictionary.

No new header buttons: the rail and `openContextSurface` are the only entry
points for opening surfaces directly; deep links from chat/palette go through
the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, or an in-content link.
- Multi-instance and session-holding surfaces (file/editor, chat, diff,
  browser, terminal) are keep-alive panes in `ContextPanel.tsx`: switching
  surfaces must not reset their state (open tabs, xterm session, scroll
  positions). Singleton surfaces (git, pr, notes, plan, context) and preview
  tabs intentionally remount on switch and must restore themselves from
  their stores/snapshots instead.
- Runtime scope: desktop/web `MainLayout` only. VS Code and the dedicated
  mobile shell have their own layouts and do not consume this registry.
