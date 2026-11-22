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

export function useOpenChatLink(directory: string) {
  const showTrackerItem = useShowTrackerItem();
  const mobile = useMobileAppActions();
  const descriptors = useSourceControlProviderRegistry((state) => state.ordered);
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
