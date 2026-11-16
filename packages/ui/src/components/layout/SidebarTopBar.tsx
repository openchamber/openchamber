import React from 'react';
import { titlebarControlsWidthReaderRef } from './titlebarControlsWidth';

/**
 * Strip at the top of the desktop left sidebar that reserves room for the
 * persistent {@link TitlebarLeftControls} overlay (sidebar toggle), so the
 * session list starts below it. Its height tracks the
 * header via `--oc-header-height`.
 *
 * Split into regions so the strip stays a window drag area while the
 * overlay buttons remain clickable: a `no-drag` carve matching the overlay
 * footprint (the overlay sits on top of it; an OS drag region here would steal
 * the buttons' clicks, since a separate-subtree `no-drag` can't carve a drag
 * region in Electron/macOS) plus a `drag` remainder for window dragging.
 *
 * The remainder ends in a `no-drag` slot where the session list puts its own
 * controls (`actionsSlotRef`). They belong to the list, so they live in the
 * sidebar and slide away with it, unlike the overlay.
 */
export const SidebarTopBar: React.FC<{ actionsSlotRef: React.Ref<HTMLDivElement> }> = ({ actionsSlotRef }) => (
  <div
    className="flex shrink-0"
    style={{ height: 'var(--oc-header-height, 3rem)' }}
  >
    {/* Drag region for the window-controls inset (traffic lights). */}
    <div
      aria-hidden
      className="app-region-drag shrink-0"
      style={{ width: 'var(--oc-titlebar-start-inset, 0.75rem)' }}
    />
    {/* No-drag carve under the overlay buttons so they stay clickable. */}
    <div
      aria-hidden
      ref={titlebarControlsWidthReaderRef}
      className="app-region-no-drag shrink-0"
      style={{ width: 'calc(var(--oc-titlebar-controls-width, 5.5rem) + 0.5rem)' }}
    />
    {/* Draggable remainder of the strip, with the list's controls at its end. */}
    <div className="app-region-drag flex min-w-0 flex-1 items-center justify-end">
      <div ref={actionsSlotRef} className="app-region-no-drag flex items-center" />
    </div>
  </div>
);
