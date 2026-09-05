import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from '@/components/icon/icons';
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { extractAnnouncedUrls, extractProjectActionUrl } from '@/lib/terminalPreview';
import { setAnnouncedDevServers } from '@/lib/browser/announcedServers';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import {
  getProjectActionsState,
  type OpenChamberProjectAction,
  type ProjectRef,
} from '@/lib/openchamberConfig';
import {
  normalizeProjectActionDirectory,
  PROJECT_ACTION_ICONS,
  PROJECT_ACTIONS_UPDATED_EVENT,
  resolveProjectActionDesktopForwardUrl,
  toProjectActionRunKey,
} from '@/lib/projectActions';
import { detectDevServerCommand, readPackageJsonScripts } from '@/lib/detectDevServer';
import {
  createProjectActionTerminalSession,
  normalizeProjectActionCommand,
  reconcileTerminalSessionAuthority,
  stopProjectActionTerminalSession,
} from '@/lib/projectActionTerminal';
import { observeTerminalSessions } from '@/lib/terminalSessionObserver';
import type { TerminalTab } from '@/stores/useTerminalStore';

type UrlWatchEntry = {
  hostDirectory: string;
  directory: string;
  tabId: string;
  actionId: string;
  executionId: string;
  lastSeenChunkId: number | null;
  openedUrl: boolean;
  tail: string;
  openInPreview: boolean;
  /** Addresses announced so far by an auto-discovery run, in announcement order. */
  announced: string[];
  /** Set once the panel is showing these candidates and wants later ones too. */
  offering: boolean;
};

interface ProjectActionsButtonProps {
  projectRef: ProjectRef | null;
  directory: string;
  className?: string;
  compact?: boolean;
  allowMobile?: boolean;
}

const AUTO_DISCOVER_ACTION_ID = '__openchamber_auto_discover_preview__';
const AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS = 15_000;
/**
 * How long to keep listening after the first server announces itself. A project
 * that starts several at once staggers them by a second or two, and opening the
 * first to speak would just be a race.
 */
const AUTO_DISCOVER_SETTLE_MS = 3_000;

const resolveProjectActionIconName = (action: Pick<OpenChamberProjectAction, 'id' | 'icon'>): IconName => {
  if (action.id === AUTO_DISCOVER_ACTION_ID) {
    return 'scan-2';
  }
  const matchedIcon = PROJECT_ACTION_ICONS.find((entry) => entry.key === action.icon);
  return matchedIcon?.Icon ?? 'play';
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


export const ProjectActionsButton = ({
  projectRef,
  directory,
  className,
  compact = false,
  allowMobile = false,
}: ProjectActionsButtonProps) => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { terminal, runtime } = useRuntimeAPIs();
  const effectiveDirectory = useEffectiveDirectory();
  const { isMobile } = useDeviceInfo();
  const isDesktopShellApp = React.useMemo(() => isDesktopShell(), []);
  const desktopSshInstances = useDesktopSshStore((state) => state.instances);
  const loadDesktopSsh = useDesktopSshStore((state) => state.load);

  const terminalShell = useUIStore((state) => state.terminalShell);
  const terminalLoginShell = useUIStore((state) => state.terminalLoginShells.includes(state.terminalShell));
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsProjectsSelectedId = useUIStore((state) => state.setSettingsProjectsSelectedId);
  const openContextPreview = useUIStore((state) => state.openContextPreview);

  const ensureDirectory = useTerminalStore((state) => state.ensureDirectory);
  const reconcileServerSessions = useTerminalStore((state) => state.reconcileServerSessions);
  const setTabLabel = useTerminalStore((state) => state.setTabLabel);
  const setTabIconKey = useTerminalStore((state) => state.setTabIconKey);
  const setActiveTab = useTerminalStore((state) => state.setActiveTab);
  const setConnecting = useTerminalStore((state) => state.setConnecting);
  const setTabSessionId = useTerminalStore((state) => state.setTabSessionId);
  const setTabPurpose = useTerminalStore((state) => state.setTabPurpose);
  const allocateActionExecution = useTerminalStore((state) => state.allocateActionExecution);
  const setTabLifecycle = useTerminalStore((state) => state.setTabLifecycle);
  const setTabPreviewUrl = useTerminalStore((state) => state.setTabPreviewUrl);
  const matchesActionExecution = useTerminalStore((state) => state.matchesActionExecution);
  const captureStartedActionMutationRevisions = useTerminalStore((state) => state.captureStartedActionMutationRevisions);

  const [actions, setActions] = React.useState<OpenChamberProjectAction[]>([]);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const urlWatchByRunKeyRef = React.useRef<Record<string, UrlWatchEntry>>({});
  const streamCleanupByRunKeyRef = React.useRef<Record<string, () => void>>({});
  const previewWaitTimeoutByRunKeyRef = React.useRef<Record<string, number>>({});
  const startingRunKeysRef = React.useRef<Set<string>>(new Set());
  const loadRequestIdRef = React.useRef(0);
  const [waitingForPreviewByExecution, setWaitingForPreviewByExecution] = React.useState<Record<string, true>>({});

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
    await openExternalUrl(url);
  }, []);

  const loadActions = React.useCallback(async () => {
    if (!stableProjectRef) {
      return;
    }

    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;

    setIsLoading(true);
    try {
      const state = await getProjectActionsState(stableProjectRef);
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      const filtered = state.actions;
      setActions(filtered);
      setSelectedActionId((current) => {
        if (current === AUTO_DISCOVER_ACTION_ID) {
          return current;
        }
        if (current && filtered.some((entry) => entry.id === current)) {
          return current;
        }
        return null;
      });
    } catch {
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      // Keep last known actions while next project loads or transient fetch fails.
    } finally {
      if (loadRequestIdRef.current === requestId) {
        setIsLoading(false);
      }
    }
  }, [stableProjectRef]);

  const normalizedDirectory = React.useMemo(() => {
    return normalizeProjectActionDirectory(directory || stableProjectRef?.path || '');
  }, [directory, stableProjectRef?.path]);

  const normalizedProjectDirectory = React.useMemo(() => {
    return normalizeProjectActionDirectory(stableProjectRef?.path || '');
  }, [stableProjectRef?.path]);

  const contextHostDirectory = React.useMemo(() => {
    return normalizeProjectActionDirectory(effectiveDirectory || '') || normalizedDirectory;
  }, [effectiveDirectory, normalizedDirectory]);
  const contextHostDirectoryRef = React.useRef(contextHostDirectory);
  React.useEffect(() => {
    contextHostDirectoryRef.current = contextHostDirectory;
  }, [contextHostDirectory]);

  // The store owns its directory key form; reading `sessions` directly with a
  // project-action-normalized path misses the entry whenever the two spellings
  // differ (Windows drive letters and separators).
  const directoryTerminalState = useTerminalStore((state) => (
    normalizedDirectory ? state.getDirectoryState(normalizedDirectory) : undefined
  ));

  const projectTerminalState = useTerminalStore((state) => (
    normalizedProjectDirectory && normalizedProjectDirectory !== normalizedDirectory
      ? state.getDirectoryState(normalizedProjectDirectory)
      : undefined
  ));

  const watchedTerminalStates = React.useMemo(() => {
    const states = normalizedDirectory
      ? [{ directory: normalizedDirectory, state: directoryTerminalState }]
      : [];
    if (normalizedProjectDirectory && normalizedProjectDirectory !== normalizedDirectory) {
      states.push({ directory: normalizedProjectDirectory, state: projectTerminalState });
    }
    return states;
  }, [directoryTerminalState, normalizedDirectory, normalizedProjectDirectory, projectTerminalState]);

  const watchedTerminalDirectories = React.useMemo(() => {
    const directories = normalizedDirectory ? [normalizedDirectory] : [];
    if (normalizedProjectDirectory && normalizedProjectDirectory !== normalizedDirectory) {
      directories.push(normalizedProjectDirectory);
    }
    return directories;
  }, [normalizedDirectory, normalizedProjectDirectory]);

  const executionDirectoryFor = React.useCallback((action: OpenChamberProjectAction): string => {
    if (action.id !== AUTO_DISCOVER_ACTION_ID && action.runIn === 'parent') {
      return normalizedProjectDirectory || normalizedDirectory;
    }
    return normalizedDirectory;
  }, [normalizedDirectory, normalizedProjectDirectory]);

  const executionKey = React.useCallback((executionDirectory: string, actionId: string, executionId: string) => (
    `${executionDirectory}::${actionId}::${executionId}`
  ), []);

  const getActionTab = React.useCallback((executionDirectory: string, actionId: string, state = useTerminalStore.getState()): TerminalTab | null => {
    if (!executionDirectory) return null;
    return state.getDirectoryState(executionDirectory)?.tabs.find((tab) => (
      tab.purpose.type === 'project-action' && tab.purpose.actionId === actionId
    )) ?? null;
  }, []);

  const projectActionRuns = React.useMemo(() => {
    const runs: Record<string, { directory: string; actionId: string; tabId: string; sessionId: string; executionId: string; status: 'running' | 'waiting-for-preview' | 'stopping' }> = {};
    for (const { directory: tabDirectory, state } of watchedTerminalStates) {
      for (const tab of state?.tabs ?? []) {
        if (tab.purpose.type !== 'project-action' || !tab.purpose.executionId || !tab.terminalSessionId) continue;
        if (tab.lifecycle === 'idle' || tab.lifecycle === 'exited') continue;
        const runKey = toProjectActionRunKey(tabDirectory, tab.purpose.actionId);
        const execKey = executionKey(tabDirectory, tab.purpose.actionId, tab.purpose.executionId);
        runs[runKey] = {
          directory: tabDirectory,
          actionId: tab.purpose.actionId,
          tabId: tab.id,
          sessionId: tab.terminalSessionId,
          executionId: tab.purpose.executionId,
          status: tab.lifecycle === 'stopping'
            ? 'stopping'
            : waitingForPreviewByExecution[execKey]
              ? 'waiting-for-preview'
              : 'running',
        };
      }
    }
    return runs;
  }, [executionKey, waitingForPreviewByExecution, watchedTerminalStates]);

  const clearExecutionUi = React.useCallback((executionDirectory: string, actionId: string, executionId: string) => {
    const actionRunKey = toProjectActionRunKey(executionDirectory, actionId);
    const executionStateKey = executionKey(executionDirectory, actionId, executionId);
    const watch = urlWatchByRunKeyRef.current[actionRunKey];
    const ownsActionScopedUi = watch?.executionId === executionId;
    const browserWindow = globalThis.window;
    const clearPreviewWaitTimeout = (key: string) => {
      browserWindow?.clearTimeout(previewWaitTimeoutByRunKeyRef.current[key]);
      delete previewWaitTimeoutByRunKeyRef.current[key];
    };

    if (ownsActionScopedUi) {
      delete urlWatchByRunKeyRef.current[actionRunKey];
      clearPreviewWaitTimeout(actionRunKey);
    }
    streamCleanupByRunKeyRef.current[executionStateKey]?.();
    delete streamCleanupByRunKeyRef.current[executionStateKey];
    clearPreviewWaitTimeout(executionStateKey);
    setWaitingForPreviewByExecution((current) => {
      if (!current[executionStateKey]) return current;
      const next = { ...current };
      delete next[executionStateKey];
      return next;
    });
  }, [executionKey]);

  const closeTrackedSubscription = React.useCallback((executionStateKey: string) => {
    streamCleanupByRunKeyRef.current[executionStateKey]?.();
    delete streamCleanupByRunKeyRef.current[executionStateKey];
  }, []);

  const clearTrackedPreviewTimeout = React.useCallback((executionStateKey: string) => {
    window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[executionStateKey]);
    delete previewWaitTimeoutByRunKeyRef.current[executionStateKey];
  }, []);

  React.useEffect(() => {
    // The refs hold mutable maps whose identity never changes; reading the
    // container once inside the effect keeps the latest entries visible to
    // the unmount cleanup without re-reading `.current` there.
    const trackedStreams = streamCleanupByRunKeyRef.current;
    const trackedTimeouts = previewWaitTimeoutByRunKeyRef.current;
    return () => {
      for (const executionStateKey of Object.keys(trackedStreams)) {
        closeTrackedSubscription(executionStateKey);
      }
      for (const executionStateKey of Object.keys(trackedTimeouts)) {
        clearTrackedPreviewTimeout(executionStateKey);
      }
    };
  }, [clearTrackedPreviewTimeout, closeTrackedSubscription]);

  React.useEffect(() => {
    const watchedDirectories = new Set(watchedTerminalDirectories);
    for (const watch of Object.values(urlWatchByRunKeyRef.current)) {
      if (!watchedDirectories.has(watch.directory)) clearExecutionUi(watch.directory, watch.actionId, watch.executionId);
    }
    for (const executionStateKey of Object.keys(streamCleanupByRunKeyRef.current)) {
      const executionDirectory = executionStateKey.split('::', 1)[0] ?? '';
      if (!watchedDirectories.has(executionDirectory)) {
        closeTrackedSubscription(executionStateKey);
      }
    }
  }, [clearExecutionUi, closeTrackedSubscription, watchedTerminalDirectories]);

  const revealProjectActionTerminal = React.useCallback((hostDirectory: string, executionDirectory: string) => {
    useUIStore.getState().openContextPanelTab(hostDirectory, {
      mode: 'terminal',
      targetDirectory: executionDirectory === hostDirectory ? null : executionDirectory,
    });
  }, []);

  const selectedAction = React.useMemo(() => {
    if (!selectedActionId) {
      return null;
    }
    return actions.find((entry) => entry.id === selectedActionId) ?? null;
  }, [actions, selectedActionId]);

  const autoDiscoverAction = React.useMemo<OpenChamberProjectAction>(() => ({
    id: AUTO_DISCOVER_ACTION_ID,
    name: t('projectActions.actions.autoDiscover'),
    command: '',
    icon: 'scan-2',
    autoOpenUrl: true,
  }), [t]);

  const canUseAutoDiscover = !isMobile;
  const displayActions = React.useMemo(
    () => canUseAutoDiscover ? [autoDiscoverAction, ...actions] : actions,
    [actions, autoDiscoverAction, canUseAutoDiscover]
  );

  React.useEffect(() => {
    void loadActions();
  }, [loadActions]);

  React.useEffect(() => {
    const cleanups = watchedTerminalDirectories.map(executionDirectory => observeTerminalSessions(
      terminal, executionDirectory, captureStartedActionMutationRevisions,
      result => reconcileServerSessions(executionDirectory, result.sessions, {
        startedActionMutationRevisions: result.startedActionMutationRevisions,
      }),
    ));
    return () => { for (const close of cleanups) close(); };
  }, [captureStartedActionMutationRevisions, reconcileServerSessions, terminal, watchedTerminalDirectories]);

  React.useEffect(() => {
    for (const { directory: tabDirectory, state } of watchedTerminalStates) {
      if (!tabDirectory) {
        continue;
      }
      for (const tab of state?.tabs ?? []) {
        if (tab.purpose.type !== 'project-action') continue;
        const actionId = tab.purpose.actionId;
        const action = displayActions.find((entry) => entry.id === actionId);
        const nextLabel = action?.name ?? actionId;
        const nextIcon = action?.icon || 'play';
        if (tab.label !== nextLabel) {
          setTabLabel(tabDirectory, tab.id, nextLabel);
        }
        if (tab.iconKey !== nextIcon) {
          setTabIconKey(tabDirectory, tab.id, nextIcon);
        }
      }
    }
  }, [displayActions, setTabIconKey, setTabLabel, watchedTerminalStates]);

  React.useEffect(() => {
    const browserWindow = globalThis.window;
    if (!browserWindow) {
      return;
    }

    const handler = (event: Event) => {
      // SAFETY: this event name is only dispatched by our own project-actions update helper with this detail payload.
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (!projectId) {
        return;
      }
      if (detail?.projectId && detail.projectId !== projectId) {
        return;
      }
      void loadActions();
    };

    browserWindow.addEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    return () => {
      browserWindow.removeEventListener(PROJECT_ACTIONS_UPDATED_EVENT, handler);
    };
  }, [loadActions, projectId]);

  React.useEffect(() => {
    if (!selectedActionId) {
      return;
    }
    if (selectedActionId === AUTO_DISCOVER_ACTION_ID && canUseAutoDiscover) {
      return;
    }
    if (!actions.some((entry) => entry.id === selectedActionId)) {
      setSelectedActionId(null);
    }
  }, [actions, canUseAutoDiscover, selectedActionId]);

  React.useEffect(() => {
    /**
     * Decides what an auto-discovery run found, once its servers have had a
     * moment to announce themselves. One address is opened; several are offered
     * in the browser panel, because choosing between them would be a guess
     * dressed up as a feature.
     */
    const settleAutoDiscovery = (runKey: string) => {
      delete previewWaitTimeoutByRunKeyRef.current[runKey];
      const watch = urlWatchByRunKeyRef.current[runKey];
      if (!watch || watch.openedUrl) return;

      const executionStateKey = executionKey(watch.directory, watch.actionId, watch.executionId);

      const candidates = watch.announced;
      if (candidates.length === 0) return;
      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[executionStateKey]);
      delete previewWaitTimeoutByRunKeyRef.current[executionStateKey];
      watch.openedUrl = true;
      setWaitingForPreviewByExecution((current) => {
        if (!current[executionStateKey]) return current;
        const next = { ...current };
        delete next[executionStateKey];
        return next;
      });

      if (candidates.length === 1) {
        setAnnouncedDevServers(watch.directory, []);
        setTabPreviewUrl(watch.directory, watch.tabId, candidates[0], { locked: false, autoOpened: true });
        openContextPreview(watch.directory, candidates[0]);
        return;
      }

      watch.offering = true;
      setAnnouncedDevServers(watch.directory, candidates);
      useUIStore.getState().openContextSurface(watch.directory, 'browser');
      toast.info(t('projectActions.toast.multipleServers'));
    };

    const monitorRuns = () => {
      const terminalStore = useTerminalStore.getState();
      const terminalSessions = terminalStore.sessions;
      const currentRuns = projectActionRuns;
      for (const [runKey, entry] of Object.entries(currentRuns)) {
        const directoryState = terminalSessions.get(entry.directory);
        const tab = directoryState?.tabs.find((item) => item.id === entry.tabId);
        if (!tab || tab.terminalSessionId !== entry.sessionId) {
          clearExecutionUi(entry.directory, entry.actionId, entry.executionId);
          continue;
        }

        const existingWatch = urlWatchByRunKeyRef.current[runKey];
        const watch = existingWatch?.executionId === entry.executionId
          ? existingWatch
          : {
              hostDirectory: contextHostDirectoryRef.current || entry.directory,
              directory: entry.directory,
              tabId: entry.tabId,
              actionId: entry.actionId,
              executionId: entry.executionId,
              lastSeenChunkId: null,
              openedUrl: true,
              tail: '',
              openInPreview: false,
              announced: [],
              offering: false,
            };
        urlWatchByRunKeyRef.current[runKey] = watch;
        const action = displayActions.find((item) => item.id === entry.actionId);
        const bufferChunks = terminalStore.getBuffer(entry.directory, entry.tabId).chunks;
        if (!action || bufferChunks.length === 0) continue;

        const nextChunks = bufferChunks.filter((chunk) => watch.lastSeenChunkId === null || chunk.id > watch.lastSeenChunkId);
        if (nextChunks.length === 0) continue;

        const combined = nextChunks.map((chunk) => chunk.data).join('');
        const textForScan = `${watch.tail}${combined}`;
        // Auto-discovery inferred the command; it must not also infer the
        // address. It collects what the servers announce and decides once they
        // have had a moment to all speak up.
        // Keep listening after the panel starts offering candidates: servers in
        // one project can be seconds apart, and a list that froze at whoever was
        // ready first would quietly omit the rest.
        if (watch.openInPreview && (!watch.openedUrl || watch.offering)) {
          const announced = extractAnnouncedUrls(textForScan);
          const before = watch.announced.length;
          for (const url of announced) {
            if (!watch.announced.includes(url)) watch.announced.push(url);
          }
          const added = watch.announced.length - before;

          if (watch.offering && added > 0) {
            setAnnouncedDevServers(entry.directory, watch.announced);
          } else if (!watch.openedUrl && before === 0 && watch.announced.length > 0) {
            window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
            previewWaitTimeoutByRunKeyRef.current[runKey] = window.setTimeout(
              () => settleAutoDiscovery(runKey),
              AUTO_DISCOVER_SETTLE_MS,
            );
          }
        }

        const maybeUrl = !watch.openedUrl && action.autoOpenUrl === true && !watch.openInPreview
          ? extractProjectActionUrl(textForScan)
          : null;
        const lastChunkId = nextChunks[nextChunks.length - 1]?.id ?? watch.lastSeenChunkId;

        watch.lastSeenChunkId = lastChunkId;
        watch.tail = textForScan.slice(-512);

        if (maybeUrl) {
          watch.openedUrl = true;
          if (watch.openInPreview) {
            const run = currentRuns[runKey];
            if (run) {
              setTabPreviewUrl(run.directory, run.tabId, maybeUrl, { locked: false, autoOpened: false, expectedExecutionId: run.executionId });
              if (run.status === 'waiting-for-preview') {
                setWaitingForPreviewByExecution((current) => {
                  const executionStateKey = executionKey(run.directory, run.actionId, run.executionId);
                  if (!current[executionStateKey]) return current;
                  const next = { ...current };
                  delete next[executionStateKey];
                  return next;
                });
              }
              window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
              delete previewWaitTimeoutByRunKeyRef.current[runKey];
              openContextPreview(run.directory, maybeUrl);
            }
          } else {
            void openExternal(maybeUrl);
            toast.success(t('projectActions.toast.openedUrlFromOutput'));
          }
        }
        urlWatchByRunKeyRef.current[runKey] = watch;
      }

      for (const runKey of Object.keys(urlWatchByRunKeyRef.current)) {
        if (!currentRuns[runKey]) {
          const watch = urlWatchByRunKeyRef.current[runKey];
          const currentTab = watch
            ? terminalSessions.get(watch.directory)?.tabs.find((tab) => tab.id === watch.tabId)
            : undefined;
          const watchStillOwnedByActiveExecution = currentTab?.purpose.type === 'project-action'
            && currentTab.purpose.executionId === watch?.executionId
            && Boolean(currentTab.terminalSessionId)
            && currentTab.lifecycle !== 'idle'
            && currentTab.lifecycle !== 'exited';
          if (watchStillOwnedByActiveExecution) {
            continue;
          }
          delete urlWatchByRunKeyRef.current[runKey];
          window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[runKey]);
          delete previewWaitTimeoutByRunKeyRef.current[runKey];
        }
      }
    };

    monitorRuns();
    return useTerminalStore.subscribe((state, previousState) => {
      if (state.sessions !== previousState.sessions || state.buffers !== previousState.buffers) monitorRuns();
    });
  }, [clearExecutionUi, contextHostDirectoryRef, displayActions, executionKey, openContextPreview, openExternal, projectActionRuns, setTabPreviewUrl, t]);

  React.useEffect(() => {
    for (const { directory: tabDirectory, state } of watchedTerminalStates) {
      for (const tab of state?.tabs ?? []) {
        if (tab.purpose.type !== 'project-action' || !tab.purpose.executionId || !tab.terminalSessionId) continue;
        if (tab.lifecycle !== 'running') continue;
        const actionId = tab.purpose.actionId;
        const currentExecutionId = tab.purpose.executionId;
        const streamKey = executionKey(tabDirectory, actionId, currentExecutionId);
        if (streamCleanupByRunKeyRef.current[streamKey]) continue;
        const subscription = terminal.connect(tab.terminalSessionId, {
          onEvent: (event) => {
            if (!matchesActionExecution(tabDirectory, tab.id, currentExecutionId)) return;
            if (event.type === 'snapshot') {
              useTerminalStore.getState().replaceBuffer(tabDirectory, tab.id, event.data ?? '', event.sequence ?? 0);
              if (event.status === 'running') {
                useTerminalStore.getState().setTabLifecycle(tabDirectory, tab.id, 'running', { expectedExecutionId: currentExecutionId });
              }
              if (event.status === 'exited') {
                useTerminalStore.getState().setTabLifecycle(tabDirectory, tab.id, 'exited', { expectedExecutionId: currentExecutionId });
                useTerminalStore.getState().setTabPurpose(tabDirectory, tab.id, { type: 'project-action', actionId, executionId: null });
                clearExecutionUi(tabDirectory, actionId, currentExecutionId);
              }
            }
            const output = event.type === 'data' ? (event.data ?? '') : '';
            if (output) {
              useTerminalStore.getState().appendToBuffer(tabDirectory, tab.id, output, event.sequence, event.replayData);
            }
            if (event.type === 'exit') {
              useTerminalStore.getState().setTabLifecycle(tabDirectory, tab.id, 'exited', { expectedExecutionId: currentExecutionId });
              useTerminalStore.getState().setTabPurpose(tabDirectory, tab.id, { type: 'project-action', actionId, executionId: null });
              clearExecutionUi(tabDirectory, actionId, currentExecutionId);
            }
          },
          onError: (_error, fatal) => {
            if (!fatal || !matchesActionExecution(tabDirectory, tab.id, currentExecutionId)) return;
            useTerminalStore.getState().setTabLifecycle(tabDirectory, tab.id, 'exited', { expectedExecutionId: currentExecutionId });
            useTerminalStore.getState().setTabSessionId(tabDirectory, tab.id, null, { expectedExecutionId: currentExecutionId });
            useTerminalStore.getState().setTabPurpose(tabDirectory, tab.id, { type: 'project-action', actionId, executionId: null });
            clearExecutionUi(tabDirectory, actionId, currentExecutionId);
          },
        });
        streamCleanupByRunKeyRef.current[streamKey] = subscription.close;
      }
    }
  }, [clearExecutionUi, executionKey, matchesActionExecution, terminal, watchedTerminalStates]);

  const getOrCreateActionTab = React.useCallback(async (action: OpenChamberProjectAction) => {
    const executionDirectory = executionDirectoryFor(action);
    if (!executionDirectory) {
      throw new Error(t('projectActions.error.noActiveDirectory'));
    }

    const key = toProjectActionRunKey(executionDirectory, action.id);
    ensureDirectory(executionDirectory);

    const currentStore = useTerminalStore.getState();
    const existingTab = getActionTab(executionDirectory, action.id, currentStore);
    const tabId = existingTab?.id ?? currentStore.createTab(executionDirectory);

    setTabLabel(executionDirectory, tabId, action.name);
    setTabIconKey(executionDirectory, tabId, action.icon || 'play');
    if (!existingTab) {
      setTabPurpose(executionDirectory, tabId, { type: 'project-action', actionId: action.id, executionId: null });
    }
    setActiveTab(executionDirectory, tabId);

    const stateAfterTab = useTerminalStore.getState().getDirectoryState(executionDirectory);
    const tab = stateAfterTab?.tabs.find((entry) => entry.id === tabId);
    return {
      executionDirectory,
      key,
      tabId,
      sessionId: tab?.terminalSessionId ?? null,
      executionId: tab?.purpose.type === 'project-action' ? tab.purpose.executionId : null,
    };
  }, [
    ensureDirectory,
    executionDirectoryFor,
    getActionTab,
    setActiveTab,
    setTabIconKey,
    setTabLabel,
    setTabPurpose,
    t,
  ]);

  const runAction = React.useCallback(async (action: OpenChamberProjectAction) => {
    if (runtime.isVSCode || (!allowMobile && isMobile)) {
      return;
    }

    if (!normalizedDirectory) {
      toast.error(t('projectActions.error.noActiveDirectoryForAction'));
      return;
    }

    const runKey = toProjectActionRunKey(executionDirectoryFor(action), action.id);
    const existingRun = projectActionRuns[runKey];
    if (existingRun && existingRun.status === 'running') {
      return;
    }
    if (startingRunKeysRef.current.has(runKey)) return;
    startingRunKeysRef.current.add(runKey);
    let requestedExecution: { directory: string; tabId: string; id: string } | null = null;

    try {
      const discovered = action.id === AUTO_DISCOVER_ACTION_ID
        ? await (async (): Promise<OpenChamberProjectAction> => {
          const [actionsState, scripts] = await Promise.all([
            getProjectActionsState({ id: stableProjectRef?.id ?? '', path: normalizedDirectory }),
            readPackageJsonScripts(normalizedDirectory),
          ]);
          const devServer = await detectDevServerCommand(normalizedDirectory, actionsState.actions, scripts);
          if (!devServer) {
            throw new Error(t('contextPanel.preview.noDevServer'));
          }
          return {
            id: AUTO_DISCOVER_ACTION_ID,
            name: t('projectActions.actions.autoDiscover'),
            command: devServer.command,
            icon: 'scan-2',
            autoOpenUrl: true,
            openUrl: devServer.previewUrlHint || '',
          };
        })()
        : action;

      const hasCustomOpenUrl = discovered.autoOpenUrl === true && (discovered.openUrl || '').trim().length > 0;
      const revealTerminal = !hasCustomOpenUrl && action.id !== AUTO_DISCOVER_ACTION_ID;
      const launchContextHostDirectory = contextHostDirectoryRef.current || normalizedDirectory;
      const { executionDirectory, key, tabId } = await getOrCreateActionTab(discovered);
      const normalizedCommand = normalizeProjectActionCommand(discovered.command);
      if (!normalizedCommand) {
        throw new Error(t('projectActions.error.failedToRunAction'));
      }

      const hasDesktopForwardSelection = discovered.autoOpenUrl === true
        && isDesktopShellApp
        && (discovered.desktopOpenSshForward || '').trim().length > 0;
      const manualOpenUrl = discovered.autoOpenUrl ? normalizeManualOpenUrl(discovered.openUrl) : null;
      const desktopForwardUrl = discovered.autoOpenUrl && isDesktopShellApp
        ? resolveProjectActionDesktopForwardUrl(discovered.desktopOpenSshForward, desktopSshInstances)
        : null;

      if (terminal.listSessions) {
        const currentTab = getActionTab(executionDirectory, discovered.id);
        if (currentTab?.purpose.type === 'project-action' && currentTab.purpose.executionId === null) {
          const result = await reconcileTerminalSessionAuthority(terminal, executionDirectory, {
            captureStartedActionMutationRevisions,
          });
          if (result) {
            reconcileServerSessions(executionDirectory, result.sessions, {
              startedActionMutationRevisions: result.startedActionMutationRevisions,
            });
          }
        }
      }

      const priorTab = getActionTab(executionDirectory, discovered.id);
      let activeSessionId: string;
      let adoptedExecutionId: string;
      if (priorTab?.lifecycle === 'running' && priorTab.terminalSessionId
        && priorTab.purpose.type === 'project-action' && priorTab.purpose.executionId) {
        activeSessionId = priorTab.terminalSessionId;
        adoptedExecutionId = priorTab.purpose.executionId;
      } else {
        const priorExecutionId = priorTab?.purpose.type === 'project-action' ? priorTab.purpose.executionId : null;
        if (priorExecutionId) clearExecutionUi(executionDirectory, discovered.id, priorExecutionId);
        const requestedExecutionId = allocateActionExecution(executionDirectory, tabId, discovered.id);
        if (!requestedExecutionId) throw new Error(t('projectActions.error.failedToCreateTerminalSession'));
        requestedExecution = { directory: executionDirectory, tabId, id: requestedExecutionId };
        setConnecting(executionDirectory, tabId, true, { expectedExecutionId: requestedExecutionId });
        const created = await createProjectActionTerminalSession({
          terminal,
          createOptions: {
            cwd: executionDirectory,
            shell: terminalShell,
            loginShell: terminalLoginShell,
            themeMode: currentTheme.metadata.variant === 'light' ? 'light' : 'dark',
            terminalBackground: currentTheme.colors.surface.background,
            terminalForeground: currentTheme.colors.syntax.base.foreground,
          },
          command: normalizedCommand,
          isRunStillExpected: () => matchesActionExecution(executionDirectory, tabId, requestedExecutionId),
          purpose: { type: 'project-action', actionId: discovered.id, executionId: requestedExecutionId },
        });
        if (!matchesActionExecution(executionDirectory, tabId, requestedExecutionId)) {
          if (created.sessionId === requestedExecutionId) await terminal.close(created.sessionId).catch(() => undefined);
          return;
        }
        adoptedExecutionId = created.purpose?.type === 'project-action' ? created.purpose.executionId : requestedExecutionId;
        activeSessionId = created.sessionId;
        setTabPurpose(executionDirectory, tabId, { type: 'project-action', actionId: discovered.id, executionId: adoptedExecutionId });
        setTabSessionId(executionDirectory, tabId, activeSessionId, { expectedExecutionId: adoptedExecutionId });
        setConnecting(executionDirectory, tabId, false, { expectedExecutionId: adoptedExecutionId });
      }

      if (revealTerminal && launchContextHostDirectory) {
        revealProjectActionTerminal(launchContextHostDirectory, executionDirectory);
      }

      urlWatchByRunKeyRef.current[key] = {
        hostDirectory: launchContextHostDirectory,
        directory: executionDirectory,
        tabId,
        actionId: discovered.id,
        executionId: adoptedExecutionId,
        lastSeenChunkId: null,
        openedUrl: Boolean(desktopForwardUrl) || Boolean(manualOpenUrl) || hasCustomOpenUrl,
        tail: '',
        openInPreview: discovered.id === AUTO_DISCOVER_ACTION_ID,
        announced: [],
        offering: false,
      };

      const executionStateKey = executionKey(executionDirectory, discovered.id, adoptedExecutionId);
      setConnecting(executionDirectory, tabId, true, { expectedExecutionId: adoptedExecutionId });
      const subscription = terminal.connect(
          activeSessionId,
          { onEvent: (event) => {
            if (!matchesActionExecution(executionDirectory, tabId, adoptedExecutionId)) return;
            if (event.purpose?.type === 'project-action' && event.purpose.executionId !== adoptedExecutionId) return;
            if (event.type === 'snapshot') {
              useTerminalStore.getState().replaceBuffer(executionDirectory, tabId, event.data ?? '', event.sequence ?? 0);
              useTerminalStore.getState().setConnecting(executionDirectory, tabId, false, { expectedExecutionId: adoptedExecutionId });
              if (event.purpose?.type === 'project-action') {
                useTerminalStore.getState().setTabPurpose(executionDirectory, tabId, { type: 'project-action', actionId: event.purpose.actionId, executionId: event.purpose.executionId });
              }
              if (event.status === 'running') {
                useTerminalStore.getState().setTabLifecycle(executionDirectory, tabId, 'running', { expectedExecutionId: adoptedExecutionId });
              }
              if (event.status === 'exited') {
                useTerminalStore.getState().setTabLifecycle(executionDirectory, tabId, 'exited', { expectedExecutionId: adoptedExecutionId });
                useTerminalStore.getState().setTabPurpose(executionDirectory, tabId, { type: 'project-action', actionId: discovered.id, executionId: null });
                clearExecutionUi(executionDirectory, discovered.id, adoptedExecutionId);
              }
            }
            const output = event.type === 'data' ? (event.data ?? '') : '';
            if (output) {
              useTerminalStore.getState().appendToBuffer(executionDirectory, tabId, output, event.sequence, event.replayData);
            }
            if (event.type === 'exit') {
              useTerminalStore.getState().setTabLifecycle(executionDirectory, tabId, 'exited', { expectedExecutionId: adoptedExecutionId });
              useTerminalStore.getState().setConnecting(executionDirectory, tabId, false, { expectedExecutionId: adoptedExecutionId });
              useTerminalStore.getState().setTabPurpose(executionDirectory, tabId, { type: 'project-action', actionId: discovered.id, executionId: null });
              clearExecutionUi(executionDirectory, discovered.id, adoptedExecutionId);
            }
          }, onError: (_error, fatal) => {
            if (!matchesActionExecution(executionDirectory, tabId, adoptedExecutionId)) return;
            useTerminalStore.getState().setConnecting(executionDirectory, tabId, false, { expectedExecutionId: adoptedExecutionId });
            if (fatal) {
              useTerminalStore.getState().setTabLifecycle(executionDirectory, tabId, 'exited', { expectedExecutionId: adoptedExecutionId });
              useTerminalStore.getState().setTabSessionId(executionDirectory, tabId, null, { expectedExecutionId: adoptedExecutionId });
              useTerminalStore.getState().setTabPurpose(executionDirectory, tabId, { type: 'project-action', actionId: discovered.id, executionId: null });
              clearExecutionUi(executionDirectory, discovered.id, adoptedExecutionId);
            }
          } },
        );
      if (!matchesActionExecution(executionDirectory, tabId, adoptedExecutionId)) {
        subscription.close();
        return;
      }
      streamCleanupByRunKeyRef.current[executionStateKey]?.();
      streamCleanupByRunKeyRef.current[executionStateKey] = subscription.close;

      window.clearTimeout(previewWaitTimeoutByRunKeyRef.current[executionStateKey]);
      delete previewWaitTimeoutByRunKeyRef.current[executionStateKey];
      if (discovered.id === AUTO_DISCOVER_ACTION_ID && !manualOpenUrl) {
        setWaitingForPreviewByExecution((current) => ({ ...current, [executionStateKey]: true }));
        previewWaitTimeoutByRunKeyRef.current[executionStateKey] = window.setTimeout(() => {
          delete previewWaitTimeoutByRunKeyRef.current[executionStateKey];
          const watch = urlWatchByRunKeyRef.current[key];
          if (!watch || watch.executionId !== adoptedExecutionId || watch.openedUrl || watch.offering) {
            return;
          }
          if (!matchesActionExecution(executionDirectory, tabId, adoptedExecutionId)) {
            return;
          }
          setWaitingForPreviewByExecution((current) => {
            if (!current[executionStateKey]) return current;
            const next = { ...current };
            delete next[executionStateKey];
            return next;
          });
          useTerminalStore.getState().setActiveTab(executionDirectory, tabId);
          revealProjectActionTerminal(watch.hostDirectory, executionDirectory);
        }, AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS);
      }


      if (desktopForwardUrl) {
        setTabPreviewUrl(executionDirectory, tabId, null, { locked: true, expectedExecutionId: adoptedExecutionId });
        void openExternal(desktopForwardUrl);
        toast.success(t('projectActions.toast.openedForwardedUrl'));
      } else if (manualOpenUrl) {
        setTabPreviewUrl(executionDirectory, tabId, manualOpenUrl, { locked: true, autoOpened: true, expectedExecutionId: adoptedExecutionId });
        openContextPreview(launchContextHostDirectory, manualOpenUrl);
        toast.success(t('projectActions.toast.openedActionUrl'));
      } else if (hasCustomOpenUrl) {
        setTabPreviewUrl(executionDirectory, tabId, null, { locked: true, expectedExecutionId: adoptedExecutionId });
        toast.error(t('projectActions.error.invalidCustomUrlFormat'));
      } else if (hasDesktopForwardSelection) {
        setTabPreviewUrl(executionDirectory, tabId, null, { locked: true, expectedExecutionId: adoptedExecutionId });
        toast.error(t('projectActions.error.selectedDesktopSshForwardUnavailable'));
      } else {
        setTabPreviewUrl(executionDirectory, tabId, null, { locked: false, autoOpened: false, expectedExecutionId: adoptedExecutionId });
      }

    } catch (error) {
      if (requestedExecution && matchesActionExecution(requestedExecution.directory, requestedExecution.tabId, requestedExecution.id)) {
        const { directory: failedDirectory, tabId: failedTabId, id } = requestedExecution;
        clearExecutionUi(failedDirectory, action.id, id);
        setTabLifecycle(failedDirectory, failedTabId, 'exited', { expectedExecutionId: id });
        setTabPurpose(failedDirectory, failedTabId, { type: 'project-action', actionId: action.id, executionId: null });
      }
      if (error instanceof Error && error.message === 'PROJECT_ACTION_RUN_CANCELLED') {
        return;
      }
      if (error instanceof Error && (error.message === 'COMMAND_MODE_UNSUPPORTED' || error.message === 'PROJECT_ACTION_PURPOSE_UNSUPPORTED')) {
        toast.error(t('projectActions.error.failedToCreateTerminalSession'));
        return;
      }
      toast.error(error instanceof Error ? error.message : t('projectActions.error.failedToRunAction'));
    } finally {
      startingRunKeysRef.current.delete(runKey);
    }
  }, [
    currentTheme.colors.surface.background,
    currentTheme.colors.syntax.base.foreground,
    currentTheme.metadata.variant,
    contextHostDirectoryRef,
    desktopSshInstances,
    getOrCreateActionTab,
    allowMobile,
    isMobile,
    isDesktopShellApp,
    normalizedDirectory,
    terminalLoginShell,
    terminalShell,
    openExternal,
    openContextPreview,
    projectActionRuns,
    revealProjectActionTerminal,
    runtime.isVSCode,
    executionDirectoryFor,
    matchesActionExecution,
    clearExecutionUi,
    executionKey,
    getActionTab,
    reconcileServerSessions,
    allocateActionExecution,
    captureStartedActionMutationRevisions,
    setConnecting,
    setTabLifecycle,
    setTabPurpose,
    setTabPreviewUrl,
    setTabSessionId,
    stableProjectRef?.id,
    t,
    terminal,
  ]);

  const stopAction = React.useCallback(async (action: OpenChamberProjectAction) => {
    const runKey = toProjectActionRunKey(executionDirectoryFor(action), action.id);
    const activeRun = projectActionRuns[runKey];
    if (!activeRun) {
      return;
    }

    await stopProjectActionTerminalSession({
      terminal,
      sessionId: activeRun.sessionId,
      isExecutionStillCurrent: () => matchesActionExecution(activeRun.directory, activeRun.tabId, activeRun.executionId),
      markStopping: () => {
        setTabLifecycle(activeRun.directory, activeRun.tabId, 'stopping', { expectedExecutionId: activeRun.executionId });
      },
      restoreRunning: () => {
        setTabLifecycle(activeRun.directory, activeRun.tabId, 'running', { expectedExecutionId: activeRun.executionId });
      },
      clearSession: () => {
        setTabSessionId(activeRun.directory, activeRun.tabId, null, { expectedExecutionId: activeRun.executionId });
      },
      finalizeExit: () => {
        setTabLifecycle(activeRun.directory, activeRun.tabId, 'exited', { expectedExecutionId: activeRun.executionId });
        setTabPurpose(activeRun.directory, activeRun.tabId, { type: 'project-action', actionId: activeRun.actionId, executionId: null });
        clearExecutionUi(activeRun.directory, activeRun.actionId, activeRun.executionId);
      },
    });
  }, [clearExecutionUi, executionDirectoryFor, matchesActionExecution, projectActionRuns, setTabLifecycle, setTabPurpose, setTabSessionId, terminal]);

  const handlePrimaryClick = React.useCallback(() => {
    const action = selectedAction ?? displayActions[0];
    if (!action) {
      return;
    }
    const runKey = toProjectActionRunKey(executionDirectoryFor(action), action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [displayActions, executionDirectoryFor, runAction, projectActionRuns, selectedAction, stopAction]);

  const handleSelectAction = React.useCallback((action: OpenChamberProjectAction, toggleStopIfRunning = false) => {
    setSelectedActionId(action.id);

    if (!toggleStopIfRunning) {
      void runAction(action);
      return;
    }

    const runKey = toProjectActionRunKey(executionDirectoryFor(action), action.id);
    const runningEntry = projectActionRuns[runKey];
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runAction(action);
  }, [executionDirectoryFor, runAction, projectActionRuns, stopAction]);

  const openProjectActionsSettings = React.useCallback(() => {
    if (!stableProjectRef?.id) {
      return;
    }
    setSettingsProjectsSelectedId(stableProjectRef.id);
    setSettingsPage('projects');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage, setSettingsProjectsSelectedId, stableProjectRef?.id]);

  const previewAction = selectedAction ?? displayActions[0] ?? null;
  const previewRun = previewAction ? projectActionRuns[toProjectActionRunKey(executionDirectoryFor(previewAction), previewAction.id)] : null;
  const selectedRunPreviewUrl = useTerminalStore((state) => {
    if (!previewRun) return null;
    return state.getDirectoryState(previewRun.directory)?.tabs.find((tab) => tab.id === previewRun.tabId)?.previewUrl ?? null;
  });

  if (runtime.isVSCode || (!allowMobile && isMobile) || !stableProjectRef || !normalizedDirectory) {
    return null;
  }

  const resolvedSelected = selectedAction ?? displayActions[0] ?? null;
  if (!resolvedSelected) {
    return null;
  }

  const selectedIconName = resolveProjectActionIconName(resolvedSelected);
  const selectedRunKey = toProjectActionRunKey(executionDirectoryFor(resolvedSelected), resolvedSelected.id);
  const selectedRunning = projectActionRuns[selectedRunKey];
  const isStoppingSelected = selectedRunning?.status === 'stopping';
  const isWaitingForSelectedPreview = selectedRunning?.status === 'waiting-for-preview';
  const showSelectedPreviewButton = Boolean(selectedRunning && selectedRunPreviewUrl);
  const handleOpenSelectedPreview = () => {
    if (!selectedRunning || !selectedRunPreviewUrl) {
      return;
    }
    openContextPreview(selectedRunning.directory, selectedRunPreviewUrl);
  };
  const isAutoDiscoverSelected = resolvedSelected.id === AUTO_DISCOVER_ACTION_ID;

  if (compact) {
    return (
      <div className="inline-flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={isLoading || isStoppingSelected}
              className={cn(
                'app-region-no-drag inline-flex h-9 w-9 items-center justify-center rounded-[10px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] p-2',
                'typography-ui-label font-medium text-muted-foreground hover:bg-interactive-hover hover:text-foreground transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                'disabled:cursor-not-allowed',
                className
              )}
              onClick={handlePrimaryClick}
              aria-label={selectedRunning
                ? t('projectActions.actions.stopNamedAria', { name: resolvedSelected.name })
                : t('projectActions.actions.runNamedAria', { name: resolvedSelected.name })}
            >
              {isStoppingSelected || isWaitingForSelectedPreview
                ? <Icon name="loader-4" className="h-5 w-5 animate-spin text-[var(--status-warning)]" />
                : selectedRunning
                  ? <Icon name="stop" className="h-5 w-5 text-[var(--status-warning)]" />
                  : <Icon name={selectedIconName} className="h-5 w-5" />}
            </button>
          </TooltipTrigger>
          {isAutoDiscoverSelected ? (
            <TooltipContent sideOffset={6}>{t('projectActions.actions.autoDiscoverTooltip')}</TooltipContent>
          ) : null}
        </Tooltip>
        {showSelectedPreviewButton ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="app-region-no-drag -ml-1 inline-flex h-9 w-7 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-label={t('projectActions.actions.openPreview')}
                onClick={handleOpenSelectedPreview}
              >
                <Icon name="global" className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('projectActions.actions.openPreview')}</TooltipContent>
          </Tooltip>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="app-region-no-drag -ml-1 inline-flex h-9 w-5 items-center justify-center rounded-[10px] text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label={t('projectActions.actions.chooseActionAria')}
            >
              <Icon name="arrow-down-s" className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52 max-h-[70vh] overflow-y-auto">
            <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
              <Icon name="add" className="h-4 w-4" />
              <span className="typography-ui-label text-foreground">{t('projectActions.actions.addNewAction')}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {displayActions.map((entry) => {
              const iconName = resolveProjectActionIconName(entry);
              const runKey = toProjectActionRunKey(executionDirectoryFor(entry), entry.id);
              const runState = projectActionRuns[runKey];
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
                  <Icon name={iconName} className="h-4 w-4" />
                  <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                  {isStopping || runState?.status === 'waiting-for-preview'
                    ? <Icon name="loader-4" className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                    : isRunning
                      ? <Icon name="stop" className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                      : null}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'app-region-no-drag inline-flex shrink-0 items-center self-center rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px]',
        'bg-[var(--surface-elevated)] overflow-hidden',
        'border border-border/60',
        compact ? 'h-9' : 'h-7',
        className
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handlePrimaryClick}
            disabled={isLoading || isStoppingSelected}
            className={cn(
              'inline-flex h-full items-center justify-center typography-ui-label font-medium text-foreground hover:bg-interactive-hover',
              compact ? 'w-9 px-0' : 'px-2.5',
              'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed'
            )}
            aria-label={selectedRunning
              ? t('projectActions.actions.stopNamedAria', { name: resolvedSelected.name })
              : t('projectActions.actions.runNamedAria', { name: resolvedSelected.name })}
          >
            <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center">
              {isStoppingSelected || isWaitingForSelectedPreview
                ? <Icon name="loader-4" className="h-4 w-4 animate-spin text-[var(--status-warning)]" />
                : selectedRunning
                  ? <Icon name="stop" className="h-4 w-4 text-[var(--status-warning)]" />
                  : <Icon name={selectedIconName} className="h-4 w-4" />}
            </span>
          </button>
        </TooltipTrigger>
        {isAutoDiscoverSelected ? (
          <TooltipContent sideOffset={6}>{t('projectActions.actions.autoDiscoverTooltip')}</TooltipContent>
        ) : null}
      </Tooltip>

      {showSelectedPreviewButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleOpenSelectedPreview}
              className={cn(
                compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
                'border-l border-[var(--interactive-border)] text-foreground',
                'hover:bg-interactive-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
              )}
              aria-label={t('projectActions.actions.openPreview')}
            >
              <Icon name="global" className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('projectActions.actions.openPreview')}</TooltipContent>
        </Tooltip>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              compact ? 'inline-flex h-full w-8 items-center justify-center' : 'inline-flex h-full w-7 items-center justify-center',
              'border-l border-[var(--interactive-border)] text-muted-foreground',
              'hover:bg-interactive-hover hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary'
            )}
            aria-label={t('projectActions.actions.chooseActionAria')}
          >
            <Icon name="arrow-down-s" className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52 max-h-[70vh] overflow-y-auto">
          <DropdownMenuItem className="flex items-center gap-2" onClick={openProjectActionsSettings}>
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">{t('projectActions.actions.addNewAction')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {displayActions.map((entry) => {
            const iconName = resolveProjectActionIconName(entry);
            const runKey = toProjectActionRunKey(executionDirectoryFor(entry), entry.id);
            const runState = projectActionRuns[runKey];
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
                <Icon name={iconName} className="h-4 w-4" />
                <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
                {isStopping || runState?.status === 'waiting-for-preview'
                  ? <Icon name="loader-4" className="ml-auto h-4 w-4 animate-spin text-[var(--status-warning)]" />
                  : isRunning
                    ? <Icon name="stop" className="ml-auto h-4 w-4 text-[var(--status-warning)]" />
                    : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
