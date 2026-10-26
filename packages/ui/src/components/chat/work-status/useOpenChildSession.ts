import React from 'react';

import { isVSCodeRuntime } from '@/lib/desktop';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import { useLeaveWorkStatus } from './leaveWorkStatus';

/**
 * Opens a child session of the panel's session, the way the transcript's Task
 * tool does: a read-only chat tab beside the chat, or, on surfaces that cannot
 * host a side panel (mobile, VS Code), the session itself.
 */
export const useOpenChildSession = (directory: string | null): ((childId: string, label: string) => void) => {
  const isMobile = useUIStore((state) => state.isMobile);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const leaveWorkStatus = useLeaveWorkStatus();

  return React.useCallback((childId: string, label: string) => {
    if (!directory) return;
    if (isMobile || isVSCodeRuntime()) {
      setCurrentSession(childId, directory);
      leaveWorkStatus?.();
      return;
    }
    openContextPanelTab(directory, {
      mode: 'chat',
      dedupeKey: `session:${childId}`,
      label,
      readOnly: true,
    });
  }, [directory, isMobile, leaveWorkStatus, openContextPanelTab, setCurrentSession]);
};
