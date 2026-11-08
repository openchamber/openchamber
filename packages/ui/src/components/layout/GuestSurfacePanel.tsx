import React from 'react';
import { GUEST_SURFACE_DOCK_SIZE_MIN } from '@openchamber/sdk';

import { guestHasSharedSurface, guestSurfaceDocking, type GuestSurfaceDocking } from '@/lib/guests/surfaces';
import { useGuestsStore } from '@/lib/guests/store';
import { pluginIdFromMode, type PluginContextPanelMode } from '@/lib/surfaces/modes';
import { cn } from '@/lib/utils';

const PluginPane = React.lazy(() => import('./PluginPane').then((module) => ({ default: module.PluginPane })));
const GuestSurfacePane = React.lazy(() => import('./GuestSurfacePane').then((module) => ({ default: module.GuestSurfacePane })));

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

/**
 * An extension's panel: its own page, or the host-drawn shared surface with
 * the page docked to it. The desktop rail and the phone's workspace drawer
 * share this composition so both show the same thing.
 *
 * `surfaceMounted` keeps the host-drawn picture down until the panel is on
 * screen; a docked page stays mounted beside it.
 */
export const GuestSurfacePanel: React.FC<{ mode: PluginContextPanelMode; surfaceMounted?: boolean }> = ({
  mode,
  surfaceMounted = true,
}) => {
  const guest = useGuestsStore((state) => state.guests.find((entry) => entry.id === pluginIdFromMode(mode)) ?? null);
  if (!guest || !guestHasSharedSurface(guest)) return <PluginPane mode={mode} />;
  const docking = guestSurfaceDocking(guest);
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
