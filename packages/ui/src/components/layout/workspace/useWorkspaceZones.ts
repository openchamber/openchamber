import React from 'react';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGuestSurfaces } from '@/hooks/useGuestSurfaces';
import {
  normalizeContextPanelDirectoryKey,
  useUIStore,
  type ContextPanelDirectoryState,
} from '@/stores/useUIStore';
import {
  mainChatZone,
  sanitizeWorkspaceLayout,
  zoneOfMode,
  type WorkspaceLayout,
  type WorkspaceZone,
} from '@/lib/workspace/layout';

export type WorkspaceZonesView = {
  directoryKey: string;
  layout: WorkspaceLayout;
  panel: ContextPanelDirectoryState | undefined;
  /**
   * Zones with something to draw. A zone holding no surface with an open tab
   * is absent here and renders nothing at all, so it takes no layout space and
   * leaves no blank column behind.
   */
  occupied: ReadonlySet<WorkspaceZone>;
};

/**
 * Shared reading of the workspace for the layout components.
 *
 * Installed guest panels are folded into the layout here rather than in the
 * store: the catalog arrives asynchronously and can change while the app runs,
 * so a plugin surface gets its placement the moment its descriptor exists
 * instead of waiting for the next write.
 */
export const useWorkspaceZones = (): WorkspaceZonesView => {
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const directoryKey = React.useMemo(
    () => normalizeContextPanelDirectoryKey(effectiveDirectory),
    [effectiveDirectory],
  );
  const storedLayout = useUIStore((state) => state.workspaceLayout);
  const panel = useUIStore((state) => (directoryKey ? state.contextPanelByDirectory[directoryKey] : undefined));
  const guestSurfaces = useGuestSurfaces();

  const layout = React.useMemo(
    () => (guestSurfaces.length === 0 ? storedLayout : sanitizeWorkspaceLayout(storedLayout, guestSurfaces)),
    [guestSurfaces, storedLayout],
  );

  const occupied = React.useMemo(() => occupiedZones(layout, panel), [layout, panel]);

  return { directoryKey, layout, panel, occupied };
};

/**
 * Zones with something to draw in this window.
 *
 * The session conversation always has something to show, so its zone counts
 * as occupied even before any panel tab exists. A hidden Files still occupies
 * its zone: the zone stays mounted, collapsed when nothing else is open there,
 * so the editor inside keeps its unsaved edits until Files reopens.
 */
export const occupiedZones = (
  layout: WorkspaceLayout,
  panel: Pick<ContextPanelDirectoryState, 'tabs' | 'hiddenFileTabs'> | undefined,
): Set<WorkspaceZone> => {
  const zones = new Set<WorkspaceZone>([mainChatZone(layout)]);
  for (const tab of [...(panel?.tabs ?? []), ...(panel?.hiddenFileTabs ?? [])]) {
    zones.add(zoneOfMode(layout, tab.mode));
  }
  return zones;
};

/**
 * Whether a zone is both occupied and not collapsed by the user.
 *
 * The center and the zone holding the session conversation are always drawn:
 * the center is what the others take space from, and collapsing the chat would
 * hide the thing the app is for with no obvious way back.
 */
export const isWorkspaceZoneVisible = (view: WorkspaceZonesView, zone: WorkspaceZone): boolean => {
  if (!view.occupied.has(zone)) return false;
  if (zone === 'center' || zone === mainChatZone(view.layout)) return true;
  return view.panel?.openZones.includes(zone) ?? false;
};
