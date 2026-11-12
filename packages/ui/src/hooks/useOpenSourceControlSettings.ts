import React from 'react';
import { useUIStore } from '@/stores/useUIStore';

/** Opens the Settings dialog on the Integrations page, where provider accounts live. */
export const useOpenSourceControlSettings = (): (() => void) => {
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  return React.useCallback(() => {
    setSettingsPage('integrations');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage]);
};
