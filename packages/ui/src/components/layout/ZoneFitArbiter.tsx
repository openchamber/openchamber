import React from 'react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { normalizeContextPanelDirectoryKey } from '@/stores/useUIStore';
import { watchZoneFit, type SidebarFoldReason } from './zoneFitWatch';

/**
 * Keeps the chat usable as zones open and expand around it (`watchZoneFit`)
 * for the project on screen. Renders nothing and reads the store outside
 * React, so it re-renders nothing either.
 */
export const ZoneFitArbiter: React.FC = () => {
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';

  // What was folded, so it can be undone exactly. The folded sidebar
  // outlives a project switch (the sidebar is not per project); a displaced
  // zone belongs to its project and is dropped with it. Memory only, except a
  // fold for an expanded zone: the zone comes back expanded after a restart,
  // and collapsing it then still brings the sidebar back.
  const sidebarFoldedByRef = React.useRef<SidebarFoldReason | null>(null);

  React.useEffect(() => {
    if (!directoryKey) return undefined;
    return watchZoneFit({
      directoryKey,
      folded: sidebarFoldedByRef,
      readRowWidth: () => document.querySelector<HTMLElement>('[data-workspace-row]')?.clientWidth,
    });
  }, [directoryKey]);

  return null;
};
