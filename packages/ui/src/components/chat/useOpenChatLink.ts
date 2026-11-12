import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useShowTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { openGuestCommit, readCurrentBranch } from '@/lib/guests/open-commit';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { commitShaOfUrl } from '@/lib/source-control/repositoryLinks';
import { openExternalUrl } from '@/lib/url';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSurfaceMode } from './useChatSurfaceMode';

/**
 * Where a plain click on a web link in chat content goes. On desktop, a link
 * to a commit that this project's repository has opens in the Diff view. With the
 * settings on, an issue, PR or tracker item link opens in the Tracker beside
 * the chat (on the phone, on the issues and PRs board), and any other link in
 * the built-in browser panel of `directory`; whatever they cannot show (no
 * panel here, no open project, a commit the repository does not have) opens
 * in the system browser.
 * Only the desktop panel can show any site: on the web it is an iframe, which
 * most sites refuse to load in, so links there keep opening in a new tab.
 * Modified clicks never come here: they keep the browser's own meaning, which
 * on desktop is the system browser.
 */
export function useOpenChatLink(directory: string) {
  const showTrackerItem = useShowTrackerItem();
  const mobile = useMobileAppActions();
  const descriptors = useSourceControlProviderRegistry((state) => state.ordered);
  // The mini chat window has neither the board nor the panel.
  const inWorkspace = useChatSurfaceMode() !== 'mini-chat';

  const openElsewhere = React.useCallback((url: string) => {
    const { openTrackerLinksOnBoard, openLinksInBrowserPanel, openContextPreview } = useUIStore.getState();
    if (inWorkspace && openTrackerLinksOnBoard && showTrackerItem(url, directory)) return;
    if (inWorkspace && openLinksInBrowserPanel && !mobile && isDesktopShell() && directory) {
      openContextPreview(directory, url);
      return;
    }
    void openExternalUrl(url);
  }, [directory, inWorkspace, mobile, showTrackerItem]);

  return React.useCallback((url: string) => {
    // Desktop only: whether the repository has the commit is known after a
    // git read, and a browser lets a new tab open only right inside the click,
    // so on the web a commit the repository lacked would open nowhere. The
    // desktop shell opens links through its own bridge at any time.
    const git = getRegisteredRuntimeAPIs()?.git ?? null;
    const local = inWorkspace && directory && git && !mobile && isDesktopShell() && !isVSCodeRuntime() && !isMobileSurfaceRuntime();
    const sha = local ? commitShaOfUrl(url, descriptors) : null;
    if (!sha || !git) {
      openElsewhere(url);
      return;
    }
    void openGuestCommit({
      sha,
      directory,
      git,
      currentBranch: (folder) => readCurrentBranch(git, folder),
      supported: true,
    }).then((result) => {
      if (!result.ok) openElsewhere(url);
    });
  }, [descriptors, directory, inWorkspace, mobile, openElsewhere]);
}
