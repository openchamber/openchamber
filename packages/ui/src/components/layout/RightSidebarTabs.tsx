import React from 'react';
import { RiBookletLine, RiFolder3Line, RiGitBranchLine, RiInboxArchiveLine } from '@remixicon/react';

import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { ProjectNotesTodoPanel } from '@/components/session/ProjectNotesTodoPanel';
import { GitView } from '@/components/views';
import { InboxView } from '@/features/github-inbox';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { formatDirectoryName } from '@/lib/utils';
import { SidebarFilesTree } from './SidebarFilesTree';

type RightTab = 'git' | 'files' | 'context';

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

const ContextSidebarPanel: React.FC = () => {
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const projects = useProjectsStore((state) => state.projects);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const gitDirectories = useGitStore((state) => state.directories);

  const activeProject = React.useMemo(() => {
    if (activeProjectId) {
      return projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null;
    }
    return projects[0] ?? null;
  }, [activeProjectId, projects]);

  const projectRef = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return {
      id: activeProject.id,
      path: activeProject.path,
    };
  }, [activeProject]);

  const projectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }
    return activeProject.label?.trim()
      || formatDirectoryName(activeProject.path, homeDirectory)
      || activeProject.path;
  }, [activeProject, homeDirectory]);

  const canCreateWorktree = React.useMemo(() => {
    if (!activeProject) {
      return false;
    }
    return gitDirectories.get(activeProject.path)?.isGitRepo === true;
  }, [activeProject, gitDirectories]);

  return (
    <div className="h-full min-h-0 overflow-auto bg-sidebar">
      <ProjectNotesTodoPanel
        projectRef={projectRef}
        projectLabel={projectLabel}
        canCreateWorktree={canCreateWorktree}
      />
    </div>
  );
};

export const RightSidebarTabs: React.FC = () => {
  const rightSidebarTab = useUIStore((state) => state.rightSidebarTab);
  const setRightSidebarTab = useUIStore((state) => state.setRightSidebarTab);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const directory = useEffectiveDirectory();

  useRightSidebarGitSync(directory, isRightSidebarOpen);

  const tabItems = React.useMemo(() => [
    {
      id: 'git',
      label: 'Git',
      icon: <RiGitBranchLine className="h-3.5 w-3.5" />,
    },
    {
      id: 'inbox',
      label: 'Inbox',
      icon: <RiInboxArchiveLine className="h-3.5 w-3.5" />,
    },
    {
      id: 'files',
      label: 'Files',
      icon: <RiFolder3Line className="h-3.5 w-3.5" />,
    },
    {
      id: 'context',
      label: 'Context',
      icon: <RiBookletLine className="h-3.5 w-3.5" />,
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
        {rightSidebarTab === 'inbox' && <InboxView />}
        {rightSidebarTab === 'files' && <SidebarFilesTree />}
        {rightSidebarTab === 'context' && <ContextSidebarPanel />}
      </div>
    </div>
  );
};
