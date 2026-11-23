import React from 'react';
import { startContextWindowPanel } from '@/lib/contextWindow/panel';
import { panelWindowPlacedModes } from '@/lib/contextWindow/storage';
import { zoneOfMode } from '@/lib/workspace/zones';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import { getSafeStorage } from '@/stores/utils/safeStorage';
import { useUIStore } from '@/stores/useUIStore';

export const useContextWindowPanel = (): void => {
  React.useLayoutEffect(() => startContextWindowPanel(), []);
  const surfaces = useGuestSurfaces();
  React.useEffect(() => {
    const placed = panelWindowPlacedModes(getSafeStorage());
    const ui = useUIStore.getState();
    for (const surface of surfaces) {
      if (placed.has(surface.mode) || zoneOfMode(ui.contextSurfaceZones, surface.mode) !== 'right') continue;
      ui.moveContextSurfaceToZone(surface.mode, 'bottom');
    }
  }, [surfaces]);
};
