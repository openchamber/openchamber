import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';

export const openSessionInSidePanel = (sessionId: string, sessionDirectory: string, title: string): void => {
  const panelDirectory = resolveEffectiveDirectory() ?? sessionDirectory;
  useUIStore.getState().openContextPanelTab(panelDirectory, {
    mode: 'chat',
    dedupeKey: `session:${sessionId}`,
    label: title,
    sessionTitleFallback: title,
    targetDirectory: sessionDirectory,
  });
};
