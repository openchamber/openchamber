import React from 'react';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Icon } from "@/components/icon/Icon";
import type { Session } from '@/lib/opencode/model';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDeviceInfo } from '@/lib/device';
import { checkIsGitRepository } from '@/lib/gitApi';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import { checkoutHoldsDirectory } from '@/lib/worktrees/worktreePaths';
import { sessionEvents } from '@/lib/sessionEvents';
import type { WorktreeMetadata } from '@/types/worktree';
import { formatPathForDisplay, cn } from '@/lib/utils';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useProjectWorktrees } from './useProjectWorktrees';

interface WorktreeSectionContentProps {
  projectRef?: { id: string; path: string } | null;
}

/**
 * The project's worktrees with a delete button each, for the Worktrees page.
 * Setup commands are edited on the project's Settings page.
 */
export const WorktreeSectionContent: React.FC<WorktreeSectionContentProps> = ({ projectRef: projectRefProp = null }) => {
  const { t } = useI18n();
  const { isMobile, isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectPath = projectRefProp?.path ?? activeProject?.path ?? null;

  const getWorktreeMetadata = useSessionUIStore((s) => s.getWorktreeMetadata);
  const sessions = useSessions();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const [isGitRepoLocal, setIsGitRepoLocal] = React.useState<boolean | null>(null);

  const projectRef = React.useMemo(() => {
    if (projectRefProp?.id && projectRefProp?.path) {
      return { id: projectRefProp.id, path: projectRefProp.path };
    }
    if (!activeProject?.id || !projectPath) {
      return null;
    }
    return { id: activeProject.id, path: projectPath };
  }, [activeProject?.id, projectPath, projectRefProp?.id, projectRefProp?.path]);

  React.useEffect(() => {
    if (!projectPath) return;

    let cancelled = false;
    setIsGitRepoLocal(null);

    (async () => {
      try {
        const repoStatus = await checkIsGitRepository(projectPath);
        if (cancelled) return;
        setIsGitRepoLocal(repoStatus);
      } catch {
        // Ignore errors
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const sessionsKey = React.useMemo(() => sessions.map(s => s.id).join(','), [sessions]);
  const { availableWorktrees, isLoadingWorktrees } = useProjectWorktrees(
    projectRef, isGitRepoLocal, sessionsKey, listProjectWorktrees,
  );

  const handleDeleteWorktree = React.useCallback((worktree: WorktreeMetadata) => {
    const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedWorktreePath = normalize(worktree.path);

    const directSessions = sessions.filter((session) => {
      const metadata = getWorktreeMetadata(session.id);
      if (metadata?.path && normalize(metadata.path) === normalizedWorktreePath) {
        return true;
      }

      const sessionDir = (session as { directory?: string }).directory;
      if (sessionDir) {
        const normalizedSessionDir = normalize(sessionDir);
        if (checkoutHoldsDirectory(normalizedWorktreePath, normalizedSessionDir)) {
          return true;
        }
      }

      return false;
    });

    const directSessionIds = new Set(directSessions.map((s) => s.id));

    const allKnownSessions = [
      ...useGlobalSessionsStore.getState().activeSessions,
      ...useGlobalSessionsStore.getState().archivedSessions,
    ];

    const findSubsessions = (parentIds: Set<string>): Session[] => {
      const subsessions = allKnownSessions.filter((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        return parentID && parentIds.has(parentID);
      });
      if (subsessions.length === 0) {
        return [];
      }
      const subsessionIds = new Set(subsessions.map((s) => s.id));
      return [...subsessions, ...findSubsessions(subsessionIds)];
    };

    const allSubsessions = findSubsessions(directSessionIds);

    const seenIds = new Set<string>();
    const allSessions = [...directSessions, ...allSubsessions].filter((session) => {
      if (seenIds.has(session.id)) {
        return false;
      }
      seenIds.add(session.id);
      return true;
    });

    sessionEvents.requestDelete({
      sessions: allSessions,
      mode: 'worktree',
      worktree,
    });
  }, [sessions, getWorktreeMetadata]);

  const listTooltip = (
    <SettingsInfoHint>
      {t('settings.openchamber.worktrees.list.tooltip')}
    </SettingsInfoHint>
  );

  if (!projectPath) {
    return (
      <SettingsSection
        title={t('settings.projects.page.section.worktree')}
      >
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.worktrees.state.selectProject')}
        </p>
      </SettingsSection>
    );
  }

  if (isGitRepoLocal === false) {
    return (
      <SettingsSection
        title={t('settings.projects.page.section.worktree')}
      >
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.worktrees.state.gitOnly')}
        </p>
      </SettingsSection>
    );
  }

  return (
      <SettingsSection
        title={t('settings.openchamber.worktrees.list.title')}
        titleAccessory={listTooltip}
      >
        {isLoadingWorktrees ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.worktrees.list.loading')}</p>
        ) : availableWorktrees.length === 0 ? (
          <p className="typography-meta text-muted-foreground/70">
            {t('settings.openchamber.worktrees.list.empty')}
          </p>
        ) : (
          <div className="space-y-1">
            {availableWorktrees.map((worktree) => (
              <div
                key={worktree.path}
                className="group flex w-full items-center gap-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="typography-meta min-w-0 truncate text-foreground">
                      {worktree.label || worktree.branch || t('settings.openchamber.worktrees.list.detachedHead')}
                    </p>
                  </div>
                  <p className="typography-micro truncate text-muted-foreground/60">
                    {formatPathForDisplay(worktree.path, homeDirectory)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteWorktree(worktree)}
                  className={cn(
                    'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  )}
                  aria-label={t('settings.openchamber.worktrees.list.deleteWorktreeAria', { name: worktree.branch || worktree.label || worktree.path })}
                >
                  <Icon name="delete-bin" className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
  );
};
