import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { resolveEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';

/**
 * Opens a received page full size: a tab of the context panel's `pages`
 * surface on the desktop and the web, a full-screen page with Back to the
 * chat in the phone app. One tab per page; opening it again shows that tab.
 */
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

/**
 * A tab opened before its page was (named by its host) takes the page's
 * title once the PIN opens it. The phone's full-screen page has no tab.
 */
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
