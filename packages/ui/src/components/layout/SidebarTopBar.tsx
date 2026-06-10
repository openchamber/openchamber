import React from 'react';

/**
 * Strip at the top of the desktop left sidebar that reserves room for the
 * persistent {@link TitlebarLeftControls} overlay (sidebar toggle + project
 * actions), so the session list starts below them. Its height tracks the
 * header via `--oc-header-height`.
 *
 * Split into two regions so the strip stays a window drag area while the
 * overlay buttons remain clickable: a `no-drag` carve matching the overlay
 * footprint (the overlay sits on top of it; an OS drag region here would steal
 * the buttons' clicks, since a separate-subtree `no-drag` can't carve a drag
 * region in Electron/macOS) plus a `drag` remainder for window dragging.
 */
export const SidebarTopBar: React.FC = () => (
  <div
    aria-hidden
    className="flex shrink-0"
    style={{ height: 'var(--oc-header-height, 3rem)' }}
  >
    {/* Drag region for the window-controls inset (traffic lights). */}
    <div
      className="app-region-drag shrink-0"
      style={{ width: 'var(--oc-titlebar-left-inset, 0.75rem)' }}
    />
    {/* No-drag carve under the overlay buttons so they stay clickable. */}
    <div
      className="app-region-no-drag shrink-0"
      style={{ width: 'calc(var(--oc-titlebar-controls-width, 5.5rem) + 0.5rem)' }}
    />
    {/* Draggable remainder of the strip. */}
    <div className="app-region-drag flex-1" />
  </div>
);
