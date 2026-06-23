import React from 'react';

import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { ProjectNotesTodoPanel } from '@/components/session/ProjectNotesTodoPanel';
import { GitView } from '@/components/views/GitView';
import { Icon } from "@/components/icon/Icon";
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { formatDirectoryName, cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { SidebarFilesTree } from './SidebarFilesTree';

type RightTab = 'git' | 'files' | 'context' | 'subagents';

const isRightTab = (value: string): value is RightTab =>
  value === 'git' || value === 'files' || value === 'context' || value === 'subagents';

const RIGHT_TAB_FALLBACK: RightTab = 'files';

const isBrowserActive = (): boolean => {
  if (typeof document !== 'undefined' && document.hidden) return false;
  if (typeof navigator !== 'undefined' && !navigator.onLine) return false;
  return true;
};

/**
 * Keeps git status fresh while the right sidebar's Git tab is the visible
 * consumer. Replaces the GitPollingProvider removed in commit b2d5ccb4.
 *
 * Gating rules (mirror the right-sidebar render policy):
 *   - sidebar must be open
 *   - right tab must be 'git' (otherwise GitView is not the visible consumer)
 *   - main tab must not be 'git' (otherwise secondaryView's GitView handles
 *     refresh and this poll would duplicate work)
 *   - browser must be visible + online
 *
 * Any condition flip resets the interval so the next tick starts fresh.
 */
function useRightSidebarGitSync(
  directory: string | undefined,
  isSidebarOpen: boolean,
  rightTab: RightTab | undefined,
  mainTab: string | undefined
) {
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);

  const shouldPoll = Boolean(
    directory && git && isSidebarOpen && rightTab === 'git' && mainTab !== 'git'
  );

  React.useEffect(() => {
    if (!shouldPoll || !directory || !git) return;

    void ensureStatus(directory, git);

    const POLL_INTERVAL = 10_000;
    const id = window.setInterval(() => {
      if (!isBrowserActive()) return;
      void ensureStatus(directory, git);
    }, POLL_INTERVAL);

    return () => window.clearInterval(id);
  }, [shouldPoll, directory, git, ensureStatus]);
}

export const ProjectContextPanel: React.FC = () => {
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
    <div className="h-full min-h-0 overflow-auto bg-background">
      <ProjectNotesTodoPanel
        projectRef={projectRef}
        projectLabel={projectLabel}
        canCreateWorktree={canCreateWorktree}
      />
    </div>
  );
};

export const RightSidebarTabs: React.FC = () => {
  const { t } = useI18n();
  const rightSidebarTab = useUIStore((state) => state.rightSidebarTab);
  const setRightSidebarTab = useUIStore((state) => state.setRightSidebarTab);
  const isRightSidebarOpen = useUIStore((state) => state.isRightSidebarOpen);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const directory = useEffectiveDirectory();

  useRightSidebarGitSync(directory, isRightSidebarOpen, rightSidebarTab, activeMainTab);

  // When the main view already hosts a right-tab equivalent (e.g. main tab
  // 'git' renders GitView in the secondary slot), the right sidebar's
  // matching tab is hidden to avoid two live GitView instances running
  // effects. The map is small and stable; expand it if more shared
  // secondary/right views are added.
  const hiddenRightTab: RightTab | null =
    activeMainTab === 'git'
      ? 'git'
      : activeMainTab === 'context'
        ? 'context'
        : null;

  // Persisted right sidebar tab can be stale across main-tab switches (e.g.
  // user opened main 'git' while right tab was 'git'). Snap to the fallback
  // so the visible tab never equals the hidden one.
  React.useEffect(() => {
    if (hiddenRightTab && rightSidebarTab === hiddenRightTab) {
      setRightSidebarTab(RIGHT_TAB_FALLBACK);
    }
  }, [hiddenRightTab, rightSidebarTab, setRightSidebarTab]);

  const tabItems = React.useMemo(() => [
    {
      id: 'git',
      label: t('layout.rightSidebar.git'),
      icon: <Icon name="git-branch" className="h-3.5 w-3.5" />,
    },
    {
      id: 'files',
      label: t('layout.rightSidebar.files'),
      icon: <Icon name="folder-3" className="h-3.5 w-3.5" />,
    },
    {
      id: 'context',
      label: t('layout.rightSidebar.context'),
      icon: <Icon name="file-list-2" className="h-3.5 w-3.5" />,
    },
  ], [t]);

  const visibleTabItems = React.useMemo(
    () => (hiddenRightTab ? tabItems.filter((item) => item.id !== hiddenRightTab) : tabItems),
    [tabItems, hiddenRightTab]
  );
  const isRightGitTabActive = isRightSidebarOpen && rightSidebarTab === 'git' && hiddenRightTab !== 'git';

  const handleTabSelect = React.useCallback(
    (tabID: string) => {
      if (isRightTab(tabID)) {
        setRightSidebarTab(tabID);
      }
    },
    [setRightSidebarTab]
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="h-9 bg-background pt-1 px-2">
        <SortableTabsStrip
          items={visibleTabItems}
          activeId={rightSidebarTab}
          onSelect={handleTabSelect}
          layoutMode="fit"
          variant="active-pill"
          className="h-full"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={cn('h-full', rightSidebarTab !== 'git' && 'hidden')}>
          <GitView isActive={isRightGitTabActive} />
        </div>
        <div className={cn('h-full', rightSidebarTab !== 'files' && 'hidden')}>
          <SidebarFilesTree />
        </div>
        <div className={cn('h-full', rightSidebarTab !== 'context' && 'hidden')}>
          <ProjectContextPanel />
        </div>
      </div>
    </div>
  );
};
