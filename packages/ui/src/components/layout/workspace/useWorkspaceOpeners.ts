import React from 'react';

import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { registerBrowserOpener } from '@/lib/browser/controlClient';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Window-wide entry points that open panel tabs on someone else's behalf.
 *
 * Registered once per main window rather than by each zone's panel: the
 * browser opener is a single slot, so several panels registering it meant the
 * last one to unmount (a zone collapsing) cleared it for all of them, and each
 * panel handled every file-open request again.
 */
export const useWorkspaceOpeners = (): void => {
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const openContextBrowser = useUIStore((state) => state.openContextBrowser);
  const openContextFile = useUIStore((state) => state.openContextFile);

  // Lets an agent's browser.open create the tab it needs when none is open
  // yet. Opening a tab is panel state, not something the browser view itself
  // can do before it exists. Background on purpose: an agent working a page
  // must not pop a zone open or steal the active tab while the user reads
  // something else. The tab appears in the strip; browser.capture shows it
  // only for the moment of the screenshot.
  React.useEffect(() => {
    if (!effectiveDirectory) return undefined;
    return registerBrowserOpener((url) => openContextBrowser(effectiveDirectory, url, { reveal: false }));
  }, [effectiveDirectory, openContextBrowser]);

  // The agent asked for a file to be shown. It opens in front of whatever tab
  // the user had, on purpose: the agent is pointing at a result, and the
  // prior tab is one click away.
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type !== 'file-open-request') return;
    const directory = event.directory ?? effectiveDirectory;
    if (!directory) return;
    openContextFile(directory, event.path);
  }), [effectiveDirectory, openContextFile]);
};
