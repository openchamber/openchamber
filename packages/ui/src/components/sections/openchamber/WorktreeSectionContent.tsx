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
import { checkIsGitRepository, getWorktreeSetupLog, runWorktreeCommand } from '@/lib/gitApi';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import {
  getWorktreeSetupCommands,
  getWorktreeSetupWaitEnabled,
  getWorktreeShutdownCommands,
  getWorktreeStartCommands,
  saveWorktreeSetupCommands,
  saveWorktreeSetupWaitEnabled,
  saveWorktreeShutdownCommands,
  saveWorktreeStartCommands,
  substituteCommandVariables,
} from '@/lib/openchamberConfig';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import { sessionEvents } from '@/lib/sessionEvents';
import type { WorktreeMetadata } from '@/types/worktree';
import type { WorktreeCommandResult } from '@/lib/api/types';
import { formatPathForDisplay, cn } from '@/lib/utils';
import {
  PROJECT_SETTINGS_CONTROL_WIDTH,
  ProjectSettingsSubsection,
} from '@/components/sections/projects/ProjectSettingsSubsection';
import { useI18n } from '@/lib/i18n';
import { WorktreeCommandDialog } from './WorktreeCommandDialog';

export interface WorktreeSectionContentProps {
  projectRef?: { id: string; path: string } | null;
  /**
   * 'all' renders setup commands + the worktree list (settings panel);
   * 'list-only' renders just the list (the Worktrees page — setup commands
   * stay a settings concern).
   */
  sections?: 'all' | 'list-only';
}

const SETUP_COMMANDS_SAVE_DELAY_MS = 450;

type WorktreeCommandKind = 'start' | 'shutdown' | 'setup';

type WorktreeCommandDialogState = {
  worktree: WorktreeMetadata;
  kind: WorktreeCommandKind;
  running: boolean;
  result: WorktreeCommandResult | null;
};

/**
 * Presentational command rows editor: one input per command with add/remove.
 * The parent owns the command state and persistence (debounced on blur/change).
 */
const WorktreeCommandRows: React.FC<{
  commands: string[];
  onChange: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onBlur: () => void;
  placeholder: string;
  addLabel: string;
  removeAria: string;
  dataSettingsItem?: string;
}> = ({ commands, onChange, onAdd, onRemove, onBlur, placeholder, addLabel, removeAria, dataSettingsItem }) => (
  <div className={cn('space-y-2', PROJECT_SETTINGS_CONTROL_WIDTH)} data-settings-item={dataSettingsItem}>
    {commands.map((command, index) => (
      <div key={index} className="flex w-full gap-2">
        <Input
          value={command}
          onChange={(e) => onChange(index, e.target.value)}
          onBlur={onBlur}
          placeholder={placeholder}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => onRemove(index)}
          className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label={removeAria}
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
      onClick={onAdd}
    >
      <Icon name="add" className="h-3.5 w-3.5" />
      {addLabel}
    </Button>
  </div>
);

export const WorktreeSectionContent: React.FC<WorktreeSectionContentProps> = ({ projectRef: projectRefProp = null, sections = 'all' }) => {
  const { t } = useI18n();
  const { isMobile, isTablet } = useDeviceInfo();
  const runtimeGit = useRuntimeAPIs().git;
  const canRunWorktreeCommands = Boolean(runtimeGit?.getWorktreeSetupLog || runtimeGit?.runWorktreeCommand);
  const alwaysShowActions = isMobile || isTablet;
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectPath = projectRefProp?.path ?? activeProject?.path ?? null;

  const getWorktreeMetadata = useSessionUIStore((s) => s.getWorktreeMetadata);
  const sessions = useSessions();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const [setupCommands, setSetupCommands] = React.useState<string[]>([]);
  const [waitForSetupCommands, setWaitForSetupCommands] = React.useState(false);
  const [isLoadingCommands, setIsLoadingCommands] = React.useState(false);
  const [commandsSnapshot, setCommandsSnapshot] = React.useState<string | null>(null);
  const [startCommands, setStartCommands] = React.useState<string[]>([]);
  const [startCommandsSnapshot, setStartCommandsSnapshot] = React.useState<string | null>(null);
  const [shutdownCommands, setShutdownCommands] = React.useState<string[]>([]);
  const [shutdownCommandsSnapshot, setShutdownCommandsSnapshot] = React.useState<string | null>(null);
  const [commandDialog, setCommandDialog] = React.useState<WorktreeCommandDialogState | null>(null);
  const [isGitRepoLocal, setIsGitRepoLocal] = React.useState<boolean | null>(null);
  const [availableWorktrees, setAvailableWorktrees] = React.useState<WorktreeMetadata[]>([]);
  const [isLoadingWorktrees, setIsLoadingWorktrees] = React.useState(false);
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
        const [commands, waitForSetup, start, shutdown] = await Promise.all([
          getWorktreeSetupCommands(projectRef),
          getWorktreeSetupWaitEnabled(projectRef),
          getWorktreeStartCommands(projectRef),
          getWorktreeShutdownCommands(projectRef),
        ]);
        if (!cancelled) {
          const nextCommands = commands.length > 0 ? commands : [''];
          setSetupCommands(nextCommands);
          setCommandsSnapshot(JSON.stringify(nextCommands));
          setWaitForSetupCommands(waitForSetup);
          const nextStart = start.length > 0 ? start : [''];
          setStartCommands(nextStart);
          setStartCommandsSnapshot(JSON.stringify(nextStart));
          const nextShutdown = shutdown.length > 0 ? shutdown : [''];
          setShutdownCommands(nextShutdown);
          setShutdownCommandsSnapshot(JSON.stringify(nextShutdown));
        }
      } catch {
        if (!cancelled) {
          setSetupCommands(['']);
          setCommandsSnapshot(JSON.stringify(['']));
          setWaitForSetupCommands(false);
          setStartCommands(['']);
          setStartCommandsSnapshot(JSON.stringify(['']));
          setShutdownCommands(['']);
          setShutdownCommandsSnapshot(JSON.stringify(['']));
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

  const persistSetupCommands = React.useCallback(async (commands: string[]): Promise<boolean> => {
    if (!projectRef) {
      return false;
    }
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

  const persistStartCommands = React.useCallback(async (commands: string[]): Promise<boolean> => {
    if (!projectRef) {
      return false;
    }
    try {
      const ok = await saveWorktreeStartCommands(projectRef, commands);
      if (!ok) {
        toast.error(t('settings.openchamber.worktrees.start.toast.saveFailed'));
        return false;
      }
      setStartCommandsSnapshot(JSON.stringify(commands));
      return true;
    } catch {
      toast.error(t('settings.openchamber.worktrees.start.toast.saveFailed'));
      return false;
    }
  }, [projectRef, t]);

  const persistShutdownCommands = React.useCallback(async (commands: string[]): Promise<boolean> => {
    if (!projectRef) {
      return false;
    }
    try {
      const ok = await saveWorktreeShutdownCommands(projectRef, commands);
      if (!ok) {
        toast.error(t('settings.openchamber.worktrees.shutdown.toast.saveFailed'));
        return false;
      }
      setShutdownCommandsSnapshot(JSON.stringify(commands));
      return true;
    } catch {
      toast.error(t('settings.openchamber.worktrees.shutdown.toast.saveFailed'));
      return false;
    }
  }, [projectRef, t]);

  const startCommandsHaveChanges = React.useMemo(() => {
    if (startCommandsSnapshot === null) {
      return false;
    }
    return startCommandsSnapshot !== JSON.stringify(startCommands);
  }, [startCommands, startCommandsSnapshot]);

  const shutdownCommandsHaveChanges = React.useMemo(() => {
    if (shutdownCommandsSnapshot === null) {
      return false;
    }
    return shutdownCommandsSnapshot !== JSON.stringify(shutdownCommands);
  }, [shutdownCommands, shutdownCommandsSnapshot]);

  const runDebouncedPersist = React.useCallback((
    haveChanges: boolean,
    commands: string[],
    persist: (next: string[]) => Promise<boolean>,
  ) => {
    if (!haveChanges || isLoadingCommands || isSavingCommandsRef.current) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (isSavingCommandsRef.current) {
        return;
      }
      isSavingCommandsRef.current = true;
      void (async () => {
        try {
          await persist(commands);
        } finally {
          isSavingCommandsRef.current = false;
        }
      })();
    }, SETUP_COMMANDS_SAVE_DELAY_MS);
    return timer;
  }, [isLoadingCommands]);

  React.useEffect(() => {
    const timer = runDebouncedPersist(startCommandsHaveChanges, startCommands, persistStartCommands);
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [persistStartCommands, runDebouncedPersist, startCommands, startCommandsHaveChanges]);

  React.useEffect(() => {
    const timer = runDebouncedPersist(shutdownCommandsHaveChanges, shutdownCommands, persistShutdownCommands);
    return () => {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [persistShutdownCommands, runDebouncedPersist, shutdownCommands, shutdownCommandsHaveChanges]);

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

  const handleStartCommandChange = React.useCallback((index: number, value: string) => {
    setStartCommands((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const handleStartAdd = React.useCallback(() => {
    setStartCommands((prev) => [...prev, '']);
  }, []);

  const handleStartRemove = React.useCallback((index: number) => {
    setStartCommands((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [''];
    });
  }, []);

  const handleStartBlur = React.useCallback(() => {
    if (!startCommandsHaveChanges || isSavingCommandsRef.current) {
      return;
    }
    isSavingCommandsRef.current = true;
    void (async () => {
      try {
        await persistStartCommands(startCommands);
      } finally {
        isSavingCommandsRef.current = false;
      }
    })();
  }, [persistStartCommands, startCommands, startCommandsHaveChanges]);

  const handleShutdownCommandChange = React.useCallback((index: number, value: string) => {
    setShutdownCommands((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const handleShutdownAdd = React.useCallback(() => {
    setShutdownCommands((prev) => [...prev, '']);
  }, []);

  const handleShutdownRemove = React.useCallback((index: number) => {
    setShutdownCommands((prev) => {
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : [''];
    });
  }, []);

  const handleShutdownBlur = React.useCallback(() => {
    if (!shutdownCommandsHaveChanges || isSavingCommandsRef.current) {
      return;
    }
    isSavingCommandsRef.current = true;
    void (async () => {
      try {
        await persistShutdownCommands(shutdownCommands);
      } finally {
        isSavingCommandsRef.current = false;
      }
    })();
  }, [persistShutdownCommands, shutdownCommands, shutdownCommandsHaveChanges]);

  const resolveWorktreeCommandLabel = React.useCallback((worktree: WorktreeMetadata): string => (
    worktree.label || worktree.branch || worktree.name || worktree.path
  ), []);

  const openWorktreeCommandDialog = React.useCallback((state: WorktreeCommandDialogState) => {
    setCommandDialog(state);
  }, []);

  const runWorktreeScript = React.useCallback(async (worktree: WorktreeMetadata, kind: 'start' | 'shutdown') => {
    if (!projectPath) {
      return;
    }
    const configured = kind === 'start' ? startCommands : shutdownCommands;
    const command = configured
      .map((cmd) => substituteCommandVariables(cmd, { rootWorktreePath: projectPath }))
      .filter((cmd) => cmd.trim().length > 0)
      .join(' && ');
    if (!command) {
      toast.warning(t('settings.openchamber.worktrees.commands.noCommands', {
        kind: kind === 'start'
          ? t('settings.openchamber.worktrees.start.label')
          : t('settings.openchamber.worktrees.shutdown.label'),
      }));
      return;
    }

    openWorktreeCommandDialog({ worktree, kind, running: true, result: null });
    try {
      const result = await runWorktreeCommand(worktree.path, command);
      setCommandDialog((prev) => (prev ? { ...prev, running: false, result } : prev));
    } catch (error) {
      setCommandDialog((prev) => (prev ? {
        ...prev,
        running: false,
        result: {
          success: false,
          output: '',
          message: error instanceof Error ? error.message : String(error),
        },
      } : prev));
    }
  }, [openWorktreeCommandDialog, projectPath, shutdownCommands, startCommands, t]);

  const openSetupLog = React.useCallback(async (worktree: WorktreeMetadata) => {
    openWorktreeCommandDialog({ worktree, kind: 'setup', running: true, result: null });
    try {
      const log = await getWorktreeSetupLog(worktree.path);
      setCommandDialog((prev) => (prev ? {
        ...prev,
        running: false,
        result: log ?? { success: false, output: '', message: null },
      } : prev));
    } catch (error) {
      setCommandDialog((prev) => (prev ? {
        ...prev,
        running: false,
        result: {
          success: false,
          output: '',
          message: error instanceof Error ? error.message : String(error),
        },
      } : prev));
    }
  }, [openWorktreeCommandDialog]);

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
      {sections === 'all' ? (
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
        titleAccessory={setupTooltip}
      >
        {isLoadingCommands ? (
          <p className="typography-meta text-muted-foreground">{t('settings.openchamber.worktrees.setup.loading')}</p>
        ) : (
          <>
            <WorktreeCommandRows
              commands={setupCommands}
              onChange={handleSetupCommandChange}
              onAdd={handleAddCommand}
              onRemove={handleRemoveCommand}
              onBlur={handleCommandBlur}
              placeholder={t('settings.openchamber.worktrees.setup.commandPlaceholder')}
              addLabel={t('settings.openchamber.worktrees.setup.addCommand')}
              removeAria={t('settings.openchamber.worktrees.setup.removeCommandAria')}
            />
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
          </>
        )}
      </ProjectSettingsSubsection>
      ) : null}

      {sections === 'all' ? (
        <ProjectSettingsSubsection
          title={t('settings.openchamber.worktrees.start.label')}
          settingsItem="projects.worktree.start"
        >
          {isLoadingCommands ? (
            <p className="typography-meta text-muted-foreground">{t('settings.openchamber.worktrees.setup.loading')}</p>
          ) : (
            <WorktreeCommandRows
              commands={startCommands}
              onChange={handleStartCommandChange}
              onAdd={handleStartAdd}
              onRemove={handleStartRemove}
              onBlur={handleStartBlur}
              placeholder={t('settings.openchamber.worktrees.start.commandPlaceholder')}
              addLabel={t('settings.openchamber.worktrees.start.addCommand')}
              removeAria={t('settings.openchamber.worktrees.start.removeCommandAria')}
            />
          )}
        </ProjectSettingsSubsection>
      ) : null}

      {sections === 'all' ? (
        <ProjectSettingsSubsection
          title={t('settings.openchamber.worktrees.shutdown.label')}
          settingsItem="projects.worktree.shutdown"
        >
          {isLoadingCommands ? (
            <p className="typography-meta text-muted-foreground">{t('settings.openchamber.worktrees.setup.loading')}</p>
          ) : (
            <WorktreeCommandRows
              commands={shutdownCommands}
              onChange={handleShutdownCommandChange}
              onAdd={handleShutdownAdd}
              onRemove={handleShutdownRemove}
              onBlur={handleShutdownBlur}
              placeholder={t('settings.openchamber.worktrees.shutdown.commandPlaceholder')}
              addLabel={t('settings.openchamber.worktrees.shutdown.addCommand')}
              removeAria={t('settings.openchamber.worktrees.shutdown.removeCommandAria')}
            />
          )}
        </ProjectSettingsSubsection>
      ) : null}

      <ProjectSettingsSubsection
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
          // The settings panel keeps its narrow control column; the full-page
          // Worktrees surface lets rows use the whole content width.
          <div className={cn('space-y-1', sections === 'all' && PROJECT_SETTINGS_CONTROL_WIDTH)}>
            {availableWorktrees.map((worktree) => (
              <div
                key={worktree.path}
                className="group flex w-full items-center gap-1 py-1.5"
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
                {canRunWorktreeCommands ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void runWorktreeScript(worktree, 'start')}
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                        alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      )}
                      aria-label={t('settings.openchamber.worktrees.commands.runStartAria', { name: worktree.branch || worktree.label || worktree.path })}
                      title={t('settings.openchamber.worktrees.commands.runStartAria', { name: worktree.branch || worktree.label || worktree.path })}
                    >
                      <Icon name="play" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void runWorktreeScript(worktree, 'shutdown')}
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                        alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      )}
                      aria-label={t('settings.openchamber.worktrees.commands.runShutdownAria', { name: worktree.branch || worktree.label || worktree.path })}
                      title={t('settings.openchamber.worktrees.commands.runShutdownAria', { name: worktree.branch || worktree.label || worktree.path })}
                    >
                      <Icon name="stop" className="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void openSetupLog(worktree)}
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground/50 transition-opacity hover:bg-interactive-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                        alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                      )}
                      aria-label={t('settings.openchamber.worktrees.commands.viewSetupLogAria', { name: worktree.branch || worktree.label || worktree.path })}
                      title={t('settings.openchamber.worktrees.commands.viewSetupLogAria', { name: worktree.branch || worktree.label || worktree.path })}
                    >
                      <Icon name="terminal" className="h-4 w-4" />
                    </button>
                  </>
                ) : null}
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
      </ProjectSettingsSubsection>

      {commandDialog ? (
        <WorktreeCommandDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setCommandDialog(null);
            }
          }}
          title={t(`settings.openchamber.worktrees.commands.dialogTitle${commandDialog.kind === 'setup' ? 'Setup' : commandDialog.kind === 'start' ? 'Start' : 'Shutdown'}`, {
            name: resolveWorktreeCommandLabel(commandDialog.worktree),
          })}
          command={commandDialog.kind === 'setup'
            ? undefined
            : (commandDialog.kind === 'start' ? startCommands : shutdownCommands)
                .filter((cmd) => cmd.trim().length > 0)
                .join(' && ')}
          running={commandDialog.running}
          result={commandDialog.result}
        />
      ) : null}
    </>
  );
};
