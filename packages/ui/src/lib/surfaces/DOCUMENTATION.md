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
- Rail order is user-reorderable and persisted globally in
  `useUIStore.contextRailOrder`; `sortContextSurfaces` applies it on top of the
  registry's default order and appends any missing surfaces.
- `getVisibleContextRailSurfaces` is the single visibility filter shared by the
  rail and the global surface-switch shortcut (`switch_context_surface` in
  `lib/shortcuts.ts`): it drops the plan surface unless plan mode is enabled,
  drops the walkthrough on VS Code and below `WALKTHROUGH_MIN_WIDTH`, and hides
  `has-content` surfaces until a tab of their mode exists. Both consumers use
  it so the digit shown on a rail badge always maps to the same surface the
  shortcut opens.

## Adding a surface

1. Add a `ContextPanelMode` value in `useUIStore` (type union plus the
   sanitizer whitelist in `sanitizeContextPanelTabs`).
2. Register a descriptor here (icon, label key, availability, width fraction).
3. Render the mode in `ContextPanel.tsx` (content dispatch, label, icon).
4. Add label/hint i18n keys to every locale dictionary.

No new header buttons: the rail and `openContextSurface` are the only entry
points for opening surfaces directly; deep links from chat/palette go through
the `openContext*` actions in `useUIStore`.

## Invariants

- Opening a surface must never require a control outside the rail, the
  command palette, or an in-content link.
- Multi-instance and session-holding surfaces (file/editor, diff, browser,
  terminal) are keep-alive panes in `ContextPanel.tsx`. Switching these
  surfaces must not reset their state (open tabs, xterm session, scroll
  positions). Chat tab records stay open, but only the active chat iframe is
  mounted while the panel is open. A selected chat restores its state from
  the session stores. A closed panel mounts no chat iframe.
  Singleton surfaces (git, pr, notes, plan, context) and preview tabs remount
  on switch. These surfaces must restore their state from stores or snapshots.
- Runtime scope: desktop/web `MainLayout` only. VS Code and the dedicated
  mobile shell have their own layouts and do not consume this registry.

## Layout animation invariant (migrated from the 1.17.2 repair, 2026-08)

A surface only provides a TARGET WIDTH; the panel's layout animation is
controlled by the single global resize transaction in `lib/resizeInteraction.ts`
and driven by `usePanelResize`'s `programmaticTarget` option:

- `usePanelResize` is the ONLY geometry writer. Panel components never write
  the root width, the width CSS variable or a width transition from React —
  even the closed state (`0px` is a legal close target and is never
  min-clamped; only positive widths are clamped to min/max/available). The
  root keeps a fixed structure (`flex: none`, width reads
  `var(--oc-left-sidebar-width, 0px)` / `var(--oc-context-panel-width, 0px)`);
  the content column is `width: 100%`. At most one width write happens per
  animation frame.
- `programmaticTarget { key, width, cause }`:
  - `cause: 'visibility' | 'mode'` — a fixed animation through the SAME
    per-frame writer as a pointer drag: CSS variable write →
    `notifyResizeFrame` → chat anchor commit, all before paint. A key change
    re-directs the animation from the current applied width in the same
    transaction.
  - `cause: 'parent-layout'` — per-frame FOLLOW (no animation clock). While a
    global transaction is active the panel rides its frames; otherwise a short
    transaction opens on the first real width change and closes once the width
    stabilizes. The ContextPanel's ResizeObserver writes the available width to
    a REF (no per-pixel React re-render) and wakes the follow loop via
    `notifyAvailableWidthChange`.
- Motion profiles: **standard = 200ms easeOutCubic; reduced motion = 120ms
  easeOutQuad** — reduced motion is a SHORT visible animation, NEVER a
  single-frame jump. The preference is read from a live MediaQueryList
  subscription (a system change mid-animation does not alter the running
  animation; it applies from the next open/close). The single-frame path is
  reserved for explicit test configuration (`programmaticDurationMs === 0`).
  First mount still writes the initial width silently (no animation, no
  transaction). No CSS width transition on the panel root — the JS animation
  is the single interpolator; only the content opacity transition remains.
- Persistence: `onUserCommitWidth` runs EXACTLY once, on pointerup, and is the
  only path that writes user settings (`sidebarWidth` +
  `hasManuallyResizedLeftSidebar`, `widthByMode`, default fractions).
  Programmatic open/close, mode switches and parent-layout follows NEVER
  persist — they only update the applied DOM width.
- Concurrent operations: a semantic target change mid-drag hands the pointer
  ownership over to the programmatic path WITHOUT releasing the global
  transaction (same anchor capture) and animates from the current applied
  width; the target is never marked handled before it is executed. A pointer
  drag takes over any running programmatic animation from the current width and
  reuses the transaction id.
- The chat conversation seam is anchored during the transaction
  (`useConversationResizeAnchor` + `conversationResizeLayout/Anchor`): the
  question-bubble top stays stable (delta vs the last committed frame; zero
  writes when nothing changed). Programmatic animation observability is
  emitted as `ui.panel.programmatic_end` (motionMode / configuredDurationMs /
  actualDurationMs / appliedFrameCount / distinctWidthCount / startWidth /
  finalWidth / reducedMotionAtStart — size and timing only).
