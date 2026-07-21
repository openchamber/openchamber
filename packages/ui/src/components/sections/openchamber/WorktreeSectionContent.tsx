import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Icon } from "@/components/icon/Icon";
import type { Session } from '@opencode-ai/sdk/v2';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDeviceInfo } from '@/lib/device';
import { checkIsGitRepository } from '@/lib/gitApi';
import {
  getWorktreeSetupCommands,
  getWorktreeSetupWaitEnabled,
  saveWorktreeSetupCommands,
  saveWorktreeSetupWaitEnabled,
  getArchivedWorktrees,
  addArchivedWorktree,
  removeArchivedWorktree,
} from '@/lib/openchamberConfig';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import { sessionEvents } from '@/lib/sessionEvents';
import type { WorktreeMetadata } from '@/types/worktree';
import { formatPathForDisplay, cn } from '@/lib/utils';
import {
  PROJECT_SETTINGS_CONTROL_WIDTH,
  ProjectSettingsSubsection,
} from '@/components/sections/projects/ProjectSettingsSubsection';
import { useI18n } from '@/lib/i18n';

export interface WorktreeSectionContentProps {
  projectRef?: { id: string; path: string } | null;
}

const SETUP_COMMANDS_SAVE_DELAY_MS = 450;

export const WorktreeSectionContent: React.FC<WorktreeSectionContentProps> = ({ projectRef: projectRefProp = null }) => {
  const { t } = useI18n();
  const { isMobile, isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectPath = projectRefProp?.path ?? activeProject?.path ?? null;

  const getWorktreeMetadata = useSessionUIStore((s) => s.getWorktreeMetadata);
  const archiveSessions = useSessionUIStore((s) => s.archiveSessions);
  const unarchiveSessions = useSessionUIStore((s) => s.unarchiveSessions);
  const sessions = useSessions();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const [setupCommands, setSetupCommands] = React.useState<string[]>([]);
  const [waitForSetupCommands, setWaitForSetupCommands] = React.useState(false);
  const [isLoadingCommands, setIsLoadingCommands] = React.useState(false);
  const [commandsSnapshot, setCommandsSnapshot] = React.useState<string | null>(null);
  const [isGitRepoLocal, setIsGitRepoLocal] = React.useState<boolean | null>(null);
  const [availableWorktrees, setAvailableWorktrees] = React.useState<WorktreeMetadata[]>([]);
  const [isLoadingWorktrees, setIsLoadingWorktrees] = React.useState(false);
  const [archivedWorktreePaths, setArchivedWorktreePaths] = React.useState<string[]>([]);
  const isSavingCommandsRef = React.useRef(false);

  const projectRef = React.useMemo(() => {
    if (projectRefProp?.id && projectRefProp?.path) {
      return { id: projectRefProp.id, path: projectRefProp.path };
    }
    if (!activeProject?.id || !projectPath) {
      return null;
    }
    return { id: activeProject.id, path: projectPath };
  }, [activeProject?.id, projectPath, projectRefProp?.id, projectRefProp?.path]);

  const refreshWorktrees = React.useCallback(async () => {
    if (!projectRef || isGitRepoLocal === false) return;

    try {
      const worktrees = await listProjectWorktrees(projectRef);
      setAvailableWorktrees(worktrees);
    } catch {
      // Ignore errors
    }
  }, [projectRef, isGitRepoLocal]);

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

  React.useEffect(() => {
    if (!projectRef) {
      setAvailableWorktrees([]);
      setIsLoadingWorktrees(false);
      return;
    }

    if (isGitRepoLocal === false) {
      setAvailableWorktrees([]);
      setIsLoadingWorktrees(false);
      return;
    }

    let cancelled = false;
    setIsLoadingWorktrees(true);
    setAvailableWorktrees([]);

    (async () => {
      try {
        const worktrees = await listProjectWorktrees(projectRef);
        if (cancelled) return;
        setAvailableWorktrees(worktrees);
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoadingWorktrees(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRef, isGitRepoLocal]);

  React.useEffect(() => {
    if (!projectRef) return;

    let cancelled = false;
    setIsLoadingCommands(true);

    (async () => {
      try {
        const [commands, waitForSetup] = await Promise.all([
          getWorktreeSetupCommands(projectRef),
          getWorktreeSetupWaitEnabled(projectRef),
        ]);
        if (!cancelled) {
          const nextCommands = commands.length > 0 ? commands : [''];
          setSetupCommands(nextCommands);
          setCommandsSnapshot(JSON.stringify(nextCommands));
          setWaitForSetupCommands(waitForSetup);
        }
      } catch {
        if (!cancelled) {
          setSetupCommands(['']);
          setCommandsSnapshot(JSON.stringify(['']));
          setWaitForSetupCommands(false);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCommands(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRef]);

  React.useEffect(() => {
    if (!projectRef) {
      setArchivedWorktreePaths([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const paths = await getArchivedWorktrees(projectRef);
        if (!cancelled) setArchivedWorktreePaths(paths);
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [projectRef]);

  const getWorktreeSessionIds = React.useCallback((worktree: WorktreeMetadata): string[] => {
    const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedWorktreePath = normalize(worktree.path);

    const directSessions = sessions.filter((session) => {
      const metadata = getWorktreeMetadata(session.id);
      if (metadata?.path && normalize(metadata.path) === normalizedWorktreePath) return true;
      const sessionDir = (session as { directory?: string }).directory;
      if (sessionDir && normalize(sessionDir) === normalizedWorktreePath) return true;
      return false;
    });

    const directSessionIds = new Set(directSessions.map((s) => s.id));

    const allKnownSessions = [
      ...useGlobalSessionsStore.getState().activeSessions,
      ...useGlobalSessionsStore.getState().archivedSessions,
    ];

    const findSubsessions = (parentIds: Set<string>): Session[] => {
      const subsessions = allKnownSessions.filter((s) => {
        const parentID = (s as Session & { parentID?: string | null }).parentID;
        return parentID && parentIds.has(parentID);
      });
      if (subsessions.length === 0) return [];
      return [...subsessions, ...findSubsessions(new Set(subsessions.map((s) => s.id)))];
    };

    const seenIds = new Set<string>();
    return [...directSessions, ...findSubsessions(directSessionIds)]
      .filter((s) => { if (seenIds.has(s.id)) return false; seenIds.add(s.id); return true; })
      .map((s) => s.id);
  }, [sessions, getWorktreeMetadata]);

  const handleArchiveWorktree = React.useCallback(async (worktree: WorktreeMetadata) => {
    if (!projectRef) return;
    const sessionIds = getWorktreeSessionIds(worktree);
    try {
      if (sessionIds.length > 0) await archiveSessions(sessionIds);
      await addArchivedWorktree(projectRef, worktree.path);
      setArchivedWorktreePaths((prev) => [...prev, worktree.path.replace(/\\/g, '/').replace(/\/+$/, '')]);
      toast.success(t('settings.openchamber.worktrees.list.archiveSuccess'));
    } catch {
      toast.error(t('settings.openchamber.worktrees.list.archiveFailed'));
    }
    refreshWorktrees();
  }, [projectRef, getWorktreeSessionIds, archiveSessions, t, refreshWorktrees]);

  const handleRestoreWorktree = React.useCallback(async (worktree: WorktreeMetadata) => {
    if (!projectRef) return;
    const sessionIds = getWorktreeSessionIds(worktree);
    try {
      await removeArchivedWorktree(projectRef, worktree.path);
      if (sessionIds.length > 0) await unarchiveSessions(sessionIds);
      setArchivedWorktreePaths((prev) => prev.filter((p) => p !== worktree.path.replace(/\\/g, '/').replace(/\/+$/, '')));
      toast.success(t('settings.openchamber.worktrees.archived.restoreSuccess'));
    } catch {
      toast.error(t('settings.openchamber.worktrees.archived.restoreFailed'));
    }
    refreshWorktrees();
  }, [projectRef, getWorktreeSessionIds, unarchiveSessions, t, refreshWorktrees]);

  const persistSetupCommands = React.useCallback(async (commands: string[]): Promise<boolean> => {
    if (!projectRef) return false;
    const filtered = commands.filter((cmd) => cmd.trim().length > 0);
    try {
      const ok = await saveWorktreeSetupCommands(projectRef, filtered);
      if (!ok) {
        toast.error(t('settings.openchamber.worktrees.setup.toast.saveFailed'));
        return false;
      }
      setCommandsSnapshot(JSON.stringify(commands));
      return true;
    } catch {
      toast.error(t('settings.openchamber.worktrees.setup.toast.saveFailed'));
      return false;
    }
  }, [projectRef, t]);

  const commandsHaveChanges = React.useMemo(() => {
    if (commandsSnapshot === null) {
      return false;
    }
    return commandsSnapshot !== JSON.stringify(setupCommands);
  }, [commandsSnapshot, setupCommands]);

  React.useEffect(() => {
    if (!commandsHaveChanges || isLoadingCommands || isSavingCommandsRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      if (isSavingCommandsRef.current) {
        return;
      }
      isSavingCommandsRef.current = true;
      void (async () => {
        try {
          await persistSetupCommands(setupCommands);
        } finally {
          isSavingCommandsRef.current = false;
        }
      })();
    }, SETUP_COMMANDS_SAVE_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [commandsHaveChanges, isLoadingCommands, persistSetupCommands, setupCommands]);

  const handleSetupCommandChange = React.useCallback((index: number, value: string) => {
    setSetupCommands((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const handleAddCommand = React.useCallback(() => {
    setSetupCommands((prev) => [...prev, '']);
  }, []);

  const handleRemoveCommand = React.useCallback((index: number) => {
    setSetupCommands((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [''];
    });
  }, []);

  const handleCommandBlur = React.useCallback(() => {
    if (!commandsHaveChanges || isSavingCommandsRef.current) {
      return;
    }
    isSavingCommandsRef.current = true;
    void (async () => {
      try {
        await persistSetupCommands(setupCommands);
      } finally {
        isSavingCommandsRef.current = false;
      }
    })();
  }, [commandsHaveChanges, persistSetupCommands, setupCommands]);

  const handleWaitForSetupCommandsChange = React.useCallback((enabled: boolean) => {
    setWaitForSetupCommands(enabled);
    if (projectRef) {
      void saveWorktreeSetupWaitEnabled(projectRef, enabled);
    }
  }, [projectRef]);

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
        if (normalizedSessionDir === normalizedWorktreePath) {
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

  const sessionsKey = React.useMemo(() => sessions.map(s => s.id).join(','), [sessions]);
  React.useEffect(() => {
    if (isGitRepoLocal && projectPath) {
      refreshWorktrees();
    }
  }, [sessionsKey, isGitRepoLocal, projectPath, refreshWorktrees]);

  const setupTooltip = (
    <SettingsInfoHint>
      {t('settings.openchamber.worktrees.setup.tooltipPrefix')}
      {' '}
      <code className="font-mono text-xs bg-sidebar-accent/50 px-1 rounded">$ROOT_PROJECT_PATH</code>
      {' '}
      {t('settings.openchamber.worktrees.setup.tooltipSuffix')}
    </SettingsInfoHint>
  );

  const listTooltip = (
    <SettingsInfoHint>
      {t('settings.openchamber.worktrees.list.tooltip')}
    </SettingsInfoHint>
  );

  if (!projectPath) {
    return (
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
      >
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.worktrees.state.selectProject')}
        </p>
      </ProjectSettingsSubsection>
    );
  }

  if (isGitRepoLocal === false) {
    return (
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
      >
        <p className="typography-meta text-muted-foreground">
          {t('settings.openchamber.worktrees.state.gitOnly')}
        </p>
      </ProjectSettingsSubsection>
    );
  }

  return (
    <>
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
        titleAccessory={setupTooltip}
      >
        {isLoadingCommands ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.worktrees.setup.loading')}</p>
        ) : (
          <div className={cn('space-y-2', PROJECT_SETTINGS_CONTROL_WIDTH)}>
            {setupCommands.map((command, index) => (
              <div key={index} className="flex w-full gap-2">
                <Input
                  value={command}
                  onChange={(e) => handleSetupCommandChange(index, e.target.value)}
                  onBlur={handleCommandBlur}
                  placeholder={t('settings.openchamber.worktrees.setup.commandPlaceholder')}
                  className="h-7 min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleRemoveCommand(index)}
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={t('settings.openchamber.worktrees.setup.removeCommandAria')}
                >
                  <Icon name="close" className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="!font-normal"
              onClick={handleAddCommand}
            >
              <Icon name="add" className="h-3.5 w-3.5" />
              {t('settings.openchamber.worktrees.setup.addCommand')}
            </Button>
            <label
              data-settings-item="projects.worktree.setup.wait"
              className="flex cursor-pointer items-center gap-2 py-1"
            >
              <Checkbox
                checked={waitForSetupCommands}
                onChange={handleWaitForSetupCommandsChange}
                ariaLabel={t('settings.openchamber.worktrees.setup.waitForCommandsAria')}
              />
              <span className={cn(
                'typography-ui-label font-normal',
                waitForSetupCommands ? 'text-foreground' : 'text-foreground/60'
              )}>
                {t('settings.openchamber.worktrees.setup.waitForCommands')}
              </span>
            </label>
          </div>
        )}
      </ProjectSettingsSubsection>

      <ProjectSettingsSubsection
        title={t('settings.openchamber.worktrees.list.title')}
        titleAccessory={listTooltip}
      >
        {isLoadingWorktrees ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.worktrees.list.loading')}</p>
        ) : (() => {
          const normalizePath = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
          const archivedSet = new Set(archivedWorktreePaths.map(normalizePath));
          const activeWorktrees = availableWorktrees.filter((w) => !archivedSet.has(normalizePath(w.path)));
          const archivedWorktreeList = availableWorktrees.filter((w) => archivedSet.has(normalizePath(w.path)));

          return (
            <>
              {activeWorktrees.length === 0 && archivedWorktreeList.length === 0 ? (
                <p className="typography-meta text-muted-foreground/70">
                  {t('settings.openchamber.worktrees.list.empty')}
                </p>
              ) : null}
              {activeWorktrees.length > 0 && (
                <div className={cn('space-y-1', PROJECT_SETTINGS_CONTROL_WIDTH)}>
                  {activeWorktrees.map((worktree) => (
                    <div
                      key={worktree.path}
                      className="group flex w-full items-center gap-2 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="typography-meta min-w-0 truncate text-foreground">
                            {worktree.label || worktree.branch || t('settings.openchamber.worktrees.list.detachedHead')}
                          </p>
                          <span className="typography-micro flex-shrink-0 self-center rounded bg-sidebar-accent/40 px-1.5 py-[1px] leading-none text-muted-foreground/60">
                            OpenCode
                          </span>
                        </div>
                        <p className="typography-micro truncate text-muted-foreground/60">
                          {formatPathForDisplay(worktree.path, homeDirectory)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => { void handleArchiveWorktree(worktree); }}
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        )}
                        aria-label={t('settings.openchamber.worktrees.list.archiveWorktreeAria', { name: worktree.branch || worktree.label || worktree.path })}
                      >
                        <Icon name="inbox-archive" className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteWorktree(worktree)}
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
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
              {archivedWorktreeList.length > 0 && (
                <div className={cn('mt-3 space-y-1', PROJECT_SETTINGS_CONTROL_WIDTH)}>
                  <p className="typography-ui-label mb-1 text-muted-foreground/70">
                    {t('settings.openchamber.worktrees.archived.title')}
                  </p>
                  {archivedWorktreeList.map((worktree) => (
                    <div
                      key={worktree.path}
                      className="group flex w-full items-center gap-2 py-1.5 opacity-60 hover:opacity-100 transition-opacity"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <p className="typography-meta min-w-0 truncate text-foreground">
                            {worktree.label || worktree.branch || t('settings.openchamber.worktrees.list.detachedHead')}
                          </p>
                          <span className="typography-micro flex-shrink-0 self-center rounded bg-sidebar-accent/40 px-1.5 py-[1px] leading-none text-muted-foreground/60">
                            {t('sessions.sidebar.bulkActions.archive')}
                          </span>
                        </div>
                        <p className="typography-micro truncate text-muted-foreground/60">
                          {formatPathForDisplay(worktree.path, homeDirectory)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => { void handleRestoreWorktree(worktree); }}
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                          alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                        )}
                        aria-label={t('settings.openchamber.worktrees.archived.restoreWorktreeAria', { name: worktree.branch || worktree.label || worktree.path })}
                      >
                        <Icon name="inbox-unarchive" className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteWorktree(worktree)}
                        className={cn(
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
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
            </>
          );
        })()}
      </ProjectSettingsSubsection>
    </>
  );
};
