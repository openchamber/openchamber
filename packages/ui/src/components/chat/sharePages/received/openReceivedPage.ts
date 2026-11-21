import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

export function useOpenReceivedPage() {
  const mobile = useMobileAppActions();
  return React.useCallback((receivedId: string, title: string) => {
    if (mobile) {
      mobile.openReceivedPage({ receivedId, title });
      return;
    }
    const directory = resolveEffectiveDirectory();
    if (!directory) return;
    useUIStore.getState().openContextPanelTab(directory, { mode: 'pages', targetPath: receivedId, dedupeKey: receivedId, label: title });
  }, [mobile]);
}

export function useReceivedPageTabTitle(receivedId: string, title: string | null) {
  const mobile = useMobileAppActions();
  React.useEffect(() => {
    if (mobile || !title) return;
    const directory = resolveEffectiveDirectory();
    if (!directory) return;
    const tabs = useUIStore.getState().contextPanelByDirectory[normalizeContextPanelDirectoryKey(directory)]?.tabs ?? [];
    const tab = tabs.find((entry) => entry.mode === 'pages' && entry.targetPath === receivedId);
    if (!tab || tab.label === title) return;
    useUIStore.getState().openContextPanelTab(directory, { mode: 'pages', targetPath: receivedId, dedupeKey: receivedId, label: title }, { reveal: false });
  }, [mobile, receivedId, title]);
}
