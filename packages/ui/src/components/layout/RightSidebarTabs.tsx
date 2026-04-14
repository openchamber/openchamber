import React from 'react';
import { RiFolder3Line, RiGitBranchLine } from '@remixicon/react';

import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { GitView } from '@/components/views';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStore } from '@/stores/useGitStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { SidebarFilesTree } from './SidebarFilesTree';
import { sidebarTabGit, sidebarTabFiles } from '@/lib/i18n/messages';

type RightTab = 'git' | 'files';

/**
 * Keeps git status fresh while the right sidebar is open.
 * Replaces the GitPollingProvider removed in commit b2d5ccb4.
 * The previous polling ran globally; now we only refresh when the sidebar is open.
 */
function useRightSidebarGitSync(directory: string | undefined, isSidebarOpen: boolean) {
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);

  React.useEffect(() => {
    if (!directory || !git || !isSidebarOpen) return;

    void ensureStatus(directory, git);

    const POLL_INTERVAL = 10_000;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void ensureStatus(directory, git);
    }, POLL_INTERVAL);

    return () => clearInterval(id);
  }, [directory, git, isSidebarOpen, ensureStatus]);
}

export const RightSidebarTabs: React.FC = () => {
  const rightSidebarTab = useUIStore((state) => state.rightSidebarTab);
  const setRightSidebarTab = useUIStore((state) => state.setRightSidebarTab);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const directory = useEffectiveDirectory();

  useRightSidebarGitSync(directory, isRightSidebarOpen);

  const tabItems = React.useMemo(() => [
    {
      id: 'git',
      label: sidebarTabGit(),
      icon: <RiGitBranchLine className="h-3.5 w-3.5" />,
    },
    {
      id: 'files',
      label: sidebarTabFiles(),
      icon: <RiFolder3Line className="h-3.5 w-3.5" />,
    },
  ], []);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-sidebar">
      <div className="h-9 bg-sidebar pt-1 px-2">
        <SortableTabsStrip
          items={tabItems}
          activeId={rightSidebarTab}
          onSelect={(tabID) => setRightSidebarTab(tabID as RightTab)}
          layoutMode="fit"
          variant="active-pill"
          className="h-full"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {rightSidebarTab === 'git' && <GitView />}
        {rightSidebarTab === 'files' && <SidebarFilesTree />}
      </div>
    </div>
  );
};