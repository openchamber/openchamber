import React from 'react';
import { GUEST_SURFACE_DOCK_SIZE_MIN } from '@openchamber/sdk';

import type { GuestSurfaceDocking } from '@/lib/guests/surfaces';
import type { PluginContextPanelMode } from '@/lib/surfaces/modes';
import { cn } from '@/lib/utils';

import { GuestSurfacePane } from './GuestSurfacePane';
import { PluginPane } from './PluginPane';

// How an extension page sits beside its shared surface: flex direction puts
// the page first on top/left and last on bottom/right; the page's size is
// fixed across the docked edge and the picture takes the rest.
const DOCK_LAYOUT = {
  top: { container: 'flex-col', page: 'border-b border-border', vertical: true },
  bottom: { container: 'flex-col-reverse', page: 'border-t border-border', vertical: true },
  left: { container: 'flex-row', page: 'border-e border-border', vertical: false },
  right: { container: 'flex-row-reverse', page: 'border-s border-border', vertical: false },
} as const;

/**
 * A shared-surface extension's own page, docked to one edge of the picture.
 * It starts at the manifest's `panel.size` and follows the page's
 * `host.setHeight` after that (the thickness across its edge, so a width
 * for a left or right dock), never below the manifest minimum and never past
 * half the panel, so the picture always stays in view.
 */
const DockedGuestPage: React.FC<{ mode: PluginContextPanelMode; docking: GuestSurfaceDocking }> = ({ mode, docking }) => {
  const [requested, setRequested] = React.useState<number | null>(null);
  const layout = DOCK_LAYOUT[docking.dock];
  const size = Math.max(GUEST_SURFACE_DOCK_SIZE_MIN, requested ?? docking.size);
  return (
    <div
      className={cn(
        'shrink-0 overflow-hidden duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        layout.vertical ? 'max-h-[50%] transition-[height]' : 'max-w-[50%] transition-[width]',
        layout.page,
      )}
      style={layout.vertical ? { height: size } : { width: size }}
    >
      <PluginPane mode={mode} onResize={setRequested} />
    </div>
  );
};

type GuestPanelContentProps = {
  mode: PluginContextPanelMode;
  /** The panel is a host-drawn shared surface (`service.surface`). */
  sharedSurface: boolean;
  /** Where the extension's page docks to that surface, or null when the surface is the whole panel. */
  docking: GuestSurfaceDocking | null;
  /**
   * The panel is on screen. The picture is mounted only then, so an unwatched
   * surface holds no socket and its service can idle out; the extension's
   * own page stays mounted like any panel frame.
   */
  surfaceMounted: boolean;
};

/**
 * An extension's panel as the desktop rail zone and the phone's workspace tab
 * both show it: its page, its live screen, or the screen with the page docked
 * to one edge. The page mounts `PluginPane` with the default `panel` surface,
 * so an item parked for the guest reaches it.
 */
export const GuestPanelContent: React.FC<GuestPanelContentProps> = ({ mode, sharedSurface, docking, surfaceMounted }) => {
  if (!sharedSurface) return <PluginPane mode={mode} />;
  if (!docking) return surfaceMounted ? <GuestSurfacePane mode={mode} /> : null;
  return (
    <div className={cn('flex h-full', DOCK_LAYOUT[docking.dock].container)}>
      <DockedGuestPage mode={mode} docking={docking} />
      <div className="min-h-0 min-w-0 flex-1">
        {surfaceMounted ? <GuestSurfacePane mode={mode} /> : null}
      </div>
    </div>
  );
};
