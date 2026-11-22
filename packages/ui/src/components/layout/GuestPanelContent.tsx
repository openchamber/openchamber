import React from 'react';
import { GUEST_SURFACE_DOCK_SIZE_MIN } from '@openchamber/sdk';

import type { GuestSurfaceDocking } from '@/lib/guests/surfaces';
import type { PluginContextPanelMode } from '@/lib/surfaces/modes';
import { cn } from '@/lib/utils';

import { GuestSurfacePane } from './GuestSurfacePane';
import { PluginPane } from './PluginPane';

const DOCK_LAYOUT = {
  top: { container: 'flex-col', page: 'border-b border-border', vertical: true },
  bottom: { container: 'flex-col-reverse', page: 'border-t border-border', vertical: true },
  left: { container: 'flex-row', page: 'border-e border-border', vertical: false },
  right: { container: 'flex-row-reverse', page: 'border-s border-border', vertical: false },
} as const;

const DockedGuestPage: React.FC<{ mode: PluginContextPanelMode; docking: GuestSurfaceDocking; panelOpen: boolean }> = ({ mode, docking, panelOpen }) => {
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
      <PluginPane mode={mode} onResize={setRequested} panelOpen={panelOpen} />
    </div>
  );
};

type GuestPanelContentProps = {
  mode: PluginContextPanelMode;
  sharedSurface: boolean;
  docking: GuestSurfaceDocking | null;
  panelOpen?: boolean;
  surfaceMounted: boolean;
};

export const GuestPanelContent: React.FC<GuestPanelContentProps> = ({ mode, sharedSurface, docking, surfaceMounted, panelOpen = true }) => {
  if (!sharedSurface) return <PluginPane mode={mode} panelOpen={panelOpen} />;
  if (!docking) return surfaceMounted ? <GuestSurfacePane mode={mode} /> : null;
  return (
    <div className={cn('flex h-full', DOCK_LAYOUT[docking.dock].container)}>
      <DockedGuestPage mode={mode} docking={docking} panelOpen={panelOpen} />
      <div className="min-h-0 min-w-0 flex-1">
        {surfaceMounted ? <GuestSurfacePane mode={mode} /> : null}
      </div>
    </div>
  );
};
