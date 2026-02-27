import React from 'react';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiLoader4Line,
  RiPlayLine,
  RiStopLine,
} from '@remixicon/react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import {
  getProjectActionsState,
  type OpenChamberProjectAction,
  type ProjectRef,
} from '@/lib/openchamberConfig';
import {
  normalizeProjectActionDirectory,
  PROJECT_ACTIONS_UPDATED_EVENT,
  PROJECT_ACTION_ICON_MAP,
  resolveProjectActionDesktopForwardUrl,
  toProjectActionRunKey,
} from '@/lib/projectActions';

type RunningEntry = {
  key: string;
  directory: string;
  actionId: string;
  tabId: string;
  sessionId: string;
  status: 'running' | 'stopping';
};

type UrlWatchEntry = {
  lastSeenChunkId: number | null;
  openedUrl: boolean;
  tail: string;
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
};

interface ProjectActionsButtonProps {
  projectRef: ProjectRef | null;
  directory: string;
  className?: string;
  compact?: boolean;
  allowMobile?: boolean;
}

const ANSI_ESCAPE_PREFIX = String.fromCharCode(27);
const ANSI_ESCAPE_PATTERN = new RegExp(`${ANSI_ESCAPE_PREFIX}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const URL_GLOBAL_PATTERN = /https?:\/\/[^\s<>'"`]+/gi;

const stripControlChars = (value: string): string => {
  let next = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const isControl = (code >= 0 && code <= 8)
      || code === 11
      || code === 12
      || (code >= 14 && code <= 31)
      || code === 127;
    if (!isControl) {
      next += value[index];
    }
  }
  return next;
};

const normalizeManualOpenUrl = (value: string | undefined): string | null => {
  const raw = (value || '').trim();
  if (!raw) {
    return null;
  }

  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
};

const extractBestUrl = (value: string): string | null => {
  const cleaned = value.replace(ANSI_ESCAPE_PATTERN, '');
  const matches = cleaned.match(URL_GLOBAL_PATTERN);
  if (!matches || matches.length === 0) {
    return null;
  }

  const normalized = matches
    .map((entry) => entry.replace(/[),.;]+$/, ''))
    .filter(Boolean);

  if (normalized.length === 0) {
    return null;
  }

  const portCandidates: Array<{ raw: string; parsed: URL }> = [];
  for (const candidate of normalized) {
    try {
      const parsed = new URL(candidate);
      if (parsed.port && parsed.port.length > 0) {
        portCandidates.push({ raw: candidate, parsed });
      }
    } catch {
      // noop
    }
  }

  if (portCandidates.length > 0) {
    const scoreCandidate = (entry: { raw: string; parsed: URL }): number => {
      const { parsed } = entry;
      const host = parsed.hostname.toLowerCase();
      const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
      const normalizedPath = parsed.pathname || '/';
      const pathSegments = normalizedPath.split('/').filter(Boolean).length;
      const hasRootPath = normalizedPath === '/' || normalizedPath === '';
      const hasQueryOrHash = Boolean(parsed.search || parsed.hash);

      let score = 0;
      if (isLocalHost) score += 50;
      if (hasRootPath) score += 30;
      score -= Math.min(pathSegments * 5, 20);
      if (hasQueryOrHash) score -= 10;
      return score;
    };

    portCandidates.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    return portCandidates[0]?.parsed.origin ?? portCandidates[0]?.raw ?? null;
  }

  return normalized[0] ?? null;
};

export const ProjectActionsButton = ({
  projectRef,
  directory,
  className,
  compact = false,
  allowMobile = false,
}: ProjectActionsButtonProps) => {
  const { terminal, runtime } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const isDesktopShellApp = React.useMemo(() => isDesktopShell(), []);
  const desktopSshInstances = useDesktopSshStore((state) => state.instances);
  const loadDesktopSsh = useDesktopSshStore((state) => state.load);

  const setBottomTerminalOpen = useUIStore((state) => state.setBottomTerminalOpen);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsProjectsSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);

  const terminalSessions = useTerminalStore((state) => state.sessions);
  const ensureDirectory = useTerminalStore((state) => state.ensureDirectory);
  const setTabLabel = useTerminalStore((state) => state.setTabLabel);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setConnecting = useTerminalStore((state) => state.setConnecting);
  const setTabSessionId = useTerminalStore((state) => state.setTabSessionId);

  const [actions, setActions] = React.useState<OpenChamberProjectAction[]>([]);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [runningByKey, setRunningByKey] = React.useState<Record<string, RunningEntry>>({});
  const tabByKeyRef = React.useRef<Record<string, string>>({});
  const urlWatchByRunKeyRef = React.useRef<Record<string, UrlWatchEntry>>({});

  const projectId = projectRef?.id ?? null;
  const projectPath = projectRef?.path ?? '';

  const stableProjectRef = React.useMemo(() => {
    if (!projectId) {
      return null;
    }
    return { id: projectId, path: projectPath };
  }, [projectId, projectPath]);

  React.useEffect(() => {
    if (!isDesktopShellApp) {
      return;
    }
    void loadDesktopSsh().catch(() => undefined);
  }, [isDesktopShellApp, loadDesktopSsh]);

  const openExternal = React.useCallback(async (url: string) => {
    try {
      const tauri = (window as unknown as {
        __TAURI__?: {
          shell?: {
            open?: (target: string) => Promise<unknown>;
          };
        };
      }).__TAURI__;
      if (tauri?.shell?.open) {
        await tauri.shell.open(url);
        return;
      }
    } catch {
      // noop
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const loadActions = React.useCallback(async () => {
    if (!stableProjectRef) {
      setActions([]);
      setSelectedActionId(null);
      return;
    }

    setIsLoading(true);
    try {
      const state = await getProjectActionsState(stableProjectRef);
      const filtered = state.actions;
      setActions(filtered);
      setSelectedActionId(filtered[0]?.id ?? null);
    } catch {
      setActions([]);
      setSelectedActionId(null);
    } finally {
      setIsLoading(false);
    }
  }, [stableProjectRef]);

  React.useEffect(() => {
    void loadActions();
  }, [loadActions]);

  React.useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!projectId) {
        return;
      }
      if (detail?.projectId && detail.projectId !== projectId) {
        return;
      }
      void loadActions();
    };

    window.addEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    };
  }, [loadActions, projectId]);

  React.useEffect(() => {
    if (!selectedActionId) {
      return;
    }
    if (!actions.some((entry) => entry.id === selectedActionId)) {
      setSelectedActionId(actions[0]?.id ?? null);
    }
  }, [actions, selectedActionId]);

  React.useEffect(() => {
    setRunningByKey((prev) => {
      let changed = false;
      const next: Record<string, RunningEntry> = {};

      for (const [key, entry] of Object.entries(prev)) {
        const directoryState = terminalSessions.get(entry.directory);
        const tab = directoryState?.tabs.find((item) => item.id === entry.tabId);
        if (!tab || tab.terminalSessionId !== entry.sessionId) {
          changed = true;
          continue;
        }
        next[key] = entry;
      }

      return changed ? next : prev;
    });
  }, [terminalSessions]);

  React.useEffect(() => {
    for (const [runKey, entry] of Object.entries(runningByKey)) {
      const watch = urlWatchByRunKeyRef.current[runKey] ?? { lastSeenChunkId: null, openedUrl: false, tail: '' };
      urlWatchByRunKeyRef.current[runKey] = watch;
      const action = actions.find((item) => item.id === entry.actionId);
      if (!action) {
        continue;
      }

      const directoryState = terminalSessions.get(entry.directory);
      const tab = directoryState?.tabs.find((item) => item.id === entry.tabId);
      if (!tab || !Array.isArray(tab.bufferChunks) || tab.bufferChunks.length === 0) {
        continue;
      }

      const nextChunks = tab.bufferChunks.filter((chunk) => {
        if (watch.lastSeenChunkId === null) {
          return true;
        }
        return chunk.id > watch.lastSeenChunkId;
      });

      if (nextChunks.length === 0) {
        continue;
      }

      const combined = nextChunks.map((chunk) => chunk.data).join('');
      const textForScan = `${watch.tail}${combined}`;
      const maybeUrl = !watch.openedUrl && action.autoOpenUrl === true ? extractBestUrl(textForScan) : null;
      const lastChunkId = nextChunks[nextChunks.length - 1]?.id ?? watch.lastSeenChunkId;

      watch.lastSeenChunkId = lastChunkId;
      watch.tail = textForScan.slice(-512);

      if (maybeUrl) {
        watch.openedUrl = true;
        void openExternal(maybeUrl);
        toast.success('Opened URL from action output');
      }
      urlWatchByRunKeyRef.current[runKey] = watch;
    }

    for (const runKey of Object.keys(urlWatchByRunKeyRef.current)) {
      if (!runningByKey[runKey]) {
        delete urlWatchByRunKeyRef.current[runKey];
      }
    }

  }, [actions, openExternal, runningByKey, terminalSessions]);

  const normalizedDirectory = React.useMemo(() => {
    return normalizeProjectActionDirectory(directory || stableProjectRef?.path || '');
  }, [directory, stableProjectRef?.path]);

  const selectedAction = React.useMemo(() => {
    if (!selectedActionId) {
      return actions[0] ?? null;
    }
    return actions.find((entry) => entry.id === selectedActionId) ?? actions[0] ?? null;
  }, [actions, selectedActionId]);

  const getOrCreateActionTab = React.useCallback(async (action: OpenChamberProjectAction) => {
    if (!normalizedDirectory) {
      throw new Error('No active directory');
    }

    const key = toProjectActionRunKey(normalizedDirectory, action.id);
    ensureDirectory(normalizedDirectory);

    const currentStore = useTerminalStore.getState();
    const existingDirectoryState = currentStore.getDirectoryState(normalizedDirectory);

    let tabId = tabByKeyRef.current[key] || null;
    const hasTab = tabId
      ? Boolean(existingDirectoryState?.tabs.some((entry) => entry.id === tabId))
      : false;

    if (!tabId || !hasTab) {
      tabId = currentStore.createTab(normalizedDirectory);
      tabByKeyRef.current[key] = tabId;
    }

    setTabLabel(normalizedDirectory, tabId, `Action: ${action.name}`);
    setActiveTab(normalizedDirectory, tabId);

    setBottomTerminalOpen(true);
    setActiveMainTab('terminal');

    const stateAfterTab = useTerminalStore.getState().getDirectoryState(normalizedDirectory);
    const tab = stateAfterTab?.tabs.find((entry) => entry.id === tabId);
    return {
      key,
      tabId,
      sessionId: tab?.terminalSessionId ?? null,
    };
  }, [
    ensureDirectory,
    normalizedDirectory,
    setActiveMainTab,
    setActiveTab,
    setBottomTerminalOpen,
    setTabLabel,
  ]);

  const runAction = React.useCallback(async (action: OpenChamberProjectAction) => {
    if (runtime.isVSCode || (!allowMobile && isMobile)) {
      return;
    }

    if (!normalizedDirectory) {
      toast.error('No active directory for action');
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const existingRun = runningByKey[runKey];
    if (existingRun && existingRun.status === 'running') {
      return;
    }

    try {
      const { key, tabId, sessionId } = await getOrCreateActionTab(action);
      let activeSessionId = sessionId;
      let createdSession = false;

      if (!activeSessionId) {
        setConnecting(normalizedDirectory, tabId, true);
        try {
          const created = await terminal.createSession({ cwd: normalizedDirectory });
          activeSessionId = created.sessionId;
          createdSession = true;
          setTabSessionId(normalizedDirectory, tabId, activeSessionId);
        } finally {
          setConnecting(normalizedDirectory, tabId, false);
        }
      }

      if (!activeSessionId) {
        throw new Error('Failed to create terminal session');
      }

      if (createdSession) {
        await sleep(350);
      }

      setRunningByKey((prev) => ({
        ...prev,
        [key]: {
          key,
          directory: normalizedDirectory,
          actionId: action.id,
          tabId,
          sessionId: activeSessionId,
          status: 'running',
        },
      }));

      const hasCustomOpenUrl = action.autoOpenUrl === true && (action.openUrl || '').trim().length > 0;
      const hasDesktopForwardSelection = action.autoOpenUrl === true
        && isDesktopShellApp
        && (action.desktopOpenSshForward || '').trim().length > 0;
      const manualOpenUrl = action.autoOpenUrl ? normalizeManualOpenUrl(action.openUrl) : null;
      const desktopForwardUrl = action.autoOpenUrl && isDesktopShellApp
        ? resolveProjectActionDesktopForwardUrl(action.desktopOpenSshForward, desktopSshInstances)
        : null;

      if (desktopForwardUrl) {
        void openExternal(desktopForwardUrl);
        toast.success('Opened forwarded URL');
      } else if (manualOpenUrl) {
        void openExternal(manualOpenUrl);
        toast.success('Opened action URL');
      } else if (hasCustomOpenUrl) {
        toast.error('Invalid custom URL format');
      } else if (hasDesktopForwardSelection) {
        toast.error('Selected desktop SSH forward is unavailable');
      }

      urlWatchByRunKeyRef.current[key] = {
        lastSeenChunkId: null,
        openedUrl: Boolean(desktopForwardUrl) || Boolean(manualOpenUrl) || hasCustomOpenUrl,
        tail: '',
      };

      const normalizedCommand = stripControlChars(action.command.trim().replace(/\r\n|\r/g, '\n'));
      await terminal.sendInput(activeSessionId, `${normalizedCommand}\n\u0004`);
    } catch (error) {
      setRunningByKey((prev) => {
        const next = { ...prev };
        delete next[runKey];
        return next;
      });
      delete urlWatchByRunKeyRef.current[runKey];
      toast.error(error instanceof Error ? error.message : 'Failed to run action');
    }
  }, [
    desktopSshInstances,
    getOrCreateActionTab,
    allowMobile,
    isMobile,
    isDesktopShellApp,
    normalizedDirectory,
    openExternal,
    runningByKey,
    runtime.isVSCode,
    setConnecting,
    setTabSessionId,
    terminal,
  ]);

  const stopAction = React.useCallback(async (action: OpenChamberProjectAction) => {
    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const activeRun = runningByKey[runKey];
    if (!activeRun) {
      return;
    }

    setRunningByKey((prev) => ({
      ...prev,
      [runKey]: {
        ...activeRun,
        status: 'stopping',
      },
    }));

    try {
      await terminal.sendInput(activeRun.sessionId, '\x03');
    } catch {
      // noop
    }

    await new Promise((resolve) => {
      window.setTimeout(resolve, 1000);
    });

    const afterTab = useTerminalStore.getState().getDirectoryState(activeRun.directory)?.tabs
      .find((entry) => entry.id === activeRun.tabId);

    const sessionStillSame = afterTab?.terminalSessionId === activeRun.sessionId;

    if (sessionStillSame) {
      if (typeof terminal.forceKill === 'function') {
        try {
          await terminal.forceKill({ sessionId: activeRun.sessionId });
        } catch {
          // noop
        }
      } else {
        try {
          await terminal.close(activeRun.sessionId);
        } catch {
          // noop
        }
      }
      setTabSessionId(activeRun.directory, activeRun.tabId, null);
    }

    setRunningByKey((prev) => {
      const next = { ...prev };
      delete next[runKey];
      return next;
    });
    delete urlWatchByRunKeyRef.current[runKey];
  }, [normalizedDirectory, runningByKey, setTabSessionId, terminal]);

  const handlePrimaryClick = React.useCallback(() => {
    if (!selectedAction) {
      return;
    }
    const runKey = toProjectActionRunKey(normalizedDirectory, selectedAction.id);
    const runningEntry = runningByKey[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(selectedAction);
      return;
    }
    void runAction(selectedAction);
  }, [normalizedDirectory, runAction, runningByKey, selectedAction, stopAction]);

  const handleSelectAction = React.useCallback((action: OpenChamberProjectAction, toggleStopIfRunning = false) => {
    setSelectedActionId(action.id);

    if (!toggleStopIfRunning) {
      void runAction(action);
      return;
    }

    const runKey = toProjectActionRunKey(normalizedDirectory, action.id);
    const runningEntry = runningByKey[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [normalizedDirectory, runAction, runningByKey, stopAction]);

  const openProjectActionsSettings = React.useCallback(() => {
    if (!stableProjectRef?.id) {
      return;
    }
    setSettingsProjectsSelectedId(stableProjectRef.id);
    setSettingsPage('projects');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage, setSettingsProjectsSelectedId, stableProjectRef?.id]);

  if (runtime.isVSCode || (!allowMobile && isMobile) || !stableProjectRef || !normalizedDirectory) {
    return null;
  }

  if (actions.length === 0) {
    if (compact) {
      return (
        <button
          type="button"
          disabled={isLoading}
          className={cn(
            'app-region-no-drag inline-flex h-9 w-9 items-center justify-center rounded-md p-2',
            'typography-ui-label font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            'disabled:opacity-50',
            className
          )}
          aria-label="Add action"
          onClick={openProjectActionsSettings}
        >
          <RiAddLine className="h-5 w-5" />
        </button>
      );
    }

    return (
      <button
        type="button"
        disabled={isLoading}
        className={cn(
          'app-region-no-drag inline-flex h-7 items-center gap-2 self-center rounded-md border border-[var(--interactive-border)]',
          'bg-[var(--surface-elevated)] pl-1.5 pr-2.5 typography-ui-label font-medium text-foreground hover:bg-interactive-hover transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
          'disabled:opacity-50',
          className
        )}
        onClick={openProjectActionsSettings}
      >
        <RiAddLine className="h-4 w-4 text-muted-foreground" />
        <span className="header-open-label">Add action</span>
      </button>
    );
  }

  const resolvedSelected = selectedAction ?? actions[0] ?? null;
  if (!resolvedSelected) {
    return null;
  }

  const selectedIconKey = (resolvedSelected.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
  const SelectedIcon = PROJECT_ACTION_ICON_MAP[selectedIconKey] || RiPlayLine;
  const selectedRunKey = toProjectActionRunKey(normalizedDirectory, resolvedSelected.id);
  const selectedRunning = runningByKey[selectedRunKey];
  const isStoppingSelected = selectedRunning?.status === 'stopping';

  if (compact) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={isLoading || isStoppingSelected}
            className={cn(
              'app-region-no-drag inline-flex h-9 w-9 items-center justify-center rounded-md p-2',
              'typography-ui-label font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
              'disabled:opacity-50',
              className
            )}
            aria-label={selectedRunning ? `Stop ${resolvedSelected.name}` : `Run ${resolvedSelected.name}`}
          >
            {isStoppingSelected
              ? <RiLoader4Line className="h-5 w-5 animate-spin text-[var(--status-warning)]" />
              : selectedRunning
                ? <RiStopLine className="h-5 w-5 text-[var(--status-warning)]" />
                : <SelectedIcon className="h-5 w-5" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52 max-h-[70vh] overflow-y-auto">
          <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
            <RiAddLine className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">Add new action</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {actions.map((entry) => {
            const iconKey = (entry.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
            const Icon = PROJECT_ACTION_ICON_MAP[iconKey] || RiPlayLine;
            const runKey = toProjectActionRunKey(normalizedDirectory, entry.id);
            const runState = runningByKey[runKey];
            const isRunning = Boolean(runState);
            const isStopping = runState?.status === 'stopping';

            return (
              <DropdownMenuItem
                key={entry.id}
                className="flex items-center gap-2"
                onClick={() => {
                  handleSelectAction(entry, true);
                }}
              >
                <Icon className="h-4 w-4" />
                <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                {isStopping
                  ? <RiLoader4Line className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                  : isRunning
                    ? <RiStopLine className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                    : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <div
      className={cn(
        'app-region-no-drag inline-flex items-center self-center rounded-md border border-[var(--interactive-border)]',
        'bg-[var(--surface-elevated)] shadow-none overflow-hidden',
        compact ? 'h-9' : 'h-7',
        className
      )}
    >
      <button
        type="button"
        onClick={handlePrimaryClick}
        disabled={isLoading || isStoppingSelected}
        className={cn(
          'inline-flex h-full items-center typography-ui-label font-medium text-foreground hover:bg-interactive-hover',
          compact ? 'w-9 justify-center px-0' : 'gap-2 pl-2 pr-3',
          'transition-colors disabled:opacity-50'
        )}
        aria-label={selectedRunning ? `Stop ${resolvedSelected.name}` : `Run ${resolvedSelected.name}`}
      >
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
          {isStoppingSelected
            ? <RiLoader4Line className="h-4 w-4 animate-spin text-[var(--status-warning)]" />
            : selectedRunning
              ? <RiStopLine className="h-4 w-4 text-[var(--status-warning)]" />
              : <SelectedIcon className="h-4 w-4" />}
        </span>
        {!compact ? <span className="header-open-label">{resolvedSelected.name}</span> : null}
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
              'border-l border-[var(--interactive-border)] text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground transition-colors'
            )}
            aria-label="Choose project action"
          >
            <RiArrowDownSLine className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center" alignOffset={8} className="w-52 max-h-[70vh] overflow-y-auto">
          <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
            <RiAddLine className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">Add new action</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {actions.map((entry) => {
            const iconKey = (entry.icon || 'play') as keyof typeof PROJECT_ACTION_ICON_MAP;
            const Icon = PROJECT_ACTION_ICON_MAP[iconKey] || RiPlayLine;
            const runKey = toProjectActionRunKey(normalizedDirectory, entry.id);
            const runState = runningByKey[runKey];
            const isRunning = Boolean(runState);
            const isStopping = runState?.status === 'stopping';

            return (
              <DropdownMenuItem
                key={entry.id}
                className="flex items-center gap-2"
                onClick={() => {
                  handleSelectAction(entry);
                }}
              >
                <Icon className="h-4 w-4" />
                <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                {isStopping
                  ? <RiLoader4Line className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                  : isRunning
                    ? <RiStopLine className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                    : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
