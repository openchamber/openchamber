import React from 'react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { normalizeContextPanelDirectoryKey } from '@/stores/useUIStore';
import { watchZoneFit, type SidebarFoldReason } from './zoneFitWatch';

export const ZoneFitArbiter: React.FC = () => {
  const effectiveDirectory = useEffectiveDirectory();
  const directoryKey = effectiveDirectory ? normalizeContextPanelDirectoryKey(effectiveDirectory) : '';

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
