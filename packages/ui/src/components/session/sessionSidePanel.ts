import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Opens a session as a chat tab in the side panel, next to the main chat.
 * The tab lives under the main chat's directory, which is the one the panel
 * reads; the session's own directory rides along so a chat from another
 * project (or Chat) still resolves itself.
 */
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
