import React from 'react';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDeviceInfo } from '@/lib/device';
import { isDesktopShell } from '@/lib/desktop';
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { terminalSnapshotSize } from '@/lib/terminalApi';
import { extractAnnouncedUrls, extractProjectActionUrl, extractProxiedPorts } from '@/lib/terminalPreview';
import { setAnnouncedDevServers } from '@/lib/browser/announcedServers';
import { reachesDevServersThroughTunnel } from '@/lib/browser/devTunnel';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import {
  getProjectSetup,
  type OpenChamberProjectAction,
  type ProjectSetup,
  type ProjectRef,
} from '@/lib/openchamberConfig';
import { ensureSharedSetupTrusted } from '@/lib/sharedTrustConfirmation';
import {
  AUTO_DISCOVER_ACTION_ID,
  normalizeProjectActionDirectory,
  PROJECT_ACTIONS_UPDATED_EVENT,
  resolveProjectActionDesktopForwardUrl,
  toProjectActionRunKey,
} from '@/lib/projectActions';
import { detectDevServerCommand, readPackageJsonScripts } from '@/lib/detectDevServer';
import { hasOpenUrlTemplate, resolveOpenUrl } from '@/lib/projectActionOpenUrl';
import {
  createProjectActionTerminalSession,
  normalizeProjectActionCommand,
  reconcileTerminalSessionAuthority,
  stopProjectActionTerminalSession,
} from '@/lib/projectActionTerminal';
import { getSelectedProjectActionId, setSelectedProjectActionId } from '@/lib/projectActionSelection';
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
  /** Loopback ports portless put behind a named address in this run's output. */
  proxiedPorts: number[];
};

export type ProjectActionRunStatus = 'running' | 'waiting-for-preview' | 'stopping';

export interface ProjectActionRun {
  directory: string;
  actionId: string;
  tabId: string;
  sessionId: string;
  executionId: string;
  status: ProjectActionRunStatus;
}

export interface ProjectActionsRunnerOptions {
  projectRef: ProjectRef | null;
  directory: string;
  /** Test seam: the phone layout runs no actions. */
  allowMobile?: boolean;
}

export interface ProjectActionsRunner {
  /** False where actions cannot run: VS Code, phones, or no project. */
  available: boolean;
  /** The project's own actions, then auto-discovery where it is offered. */
  actions: OpenChamberProjectAction[];
  /** The action the Work Status row shows: a running one wins over the stored pick. */
  shown: OpenChamberProjectAction | null;
  isLoading: boolean;
  /**
   * Keeps run states current until the returned release is called: while any
   * view showing them asks, the server's terminals are listed every few
   * seconds, which picks up runs another client started or a process that
   * ended. Nothing polls while nothing shows.
   */
  observe: () => () => void;
  runOf: (action: OpenChamberProjectAction) => ProjectActionRun | null;
  /** Remembers the action as this project's pick. */
  select: (action: OpenChamberProjectAction) => void;
  /** Runs the action, through the shared-setup trust prompt when it comes from the repo. */
  run: (action: OpenChamberProjectAction) => void;
  stop: (action: OpenChamberProjectAction) => void;
  /** Stops a running action, runs an idle one, and ignores one already stopping. */
  toggle: (action: OpenChamberProjectAction) => void;
  openSettings: () => void;
}

const AUTO_DISCOVER_PREVIEW_WAIT_TIMEOUT_MS = 15_000;
/**
 * How long to keep listening after the first server announces itself. A project
 * that starts several at once staggers them by a second or two, and opening the
 * first to speak would just be a race.
 */
const AUTO_DISCOVER_SETTLE_MS = 3_000;


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


export const useProjectActionsRunner = ({
  projectRef,
  directory,
  allowMobile = false,
}: ProjectActionsRunnerOptions): ProjectActionsRunner => {
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const { terminal, runtime, git } = useRuntimeAPIs();
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
  // The last merged setup, for the trust check before a shared action runs.
  const setupRef = React.useRef<ProjectSetup | null>(null);
  const [selectedActionId, setSelectedActionId] = React.useState<string | null>(
    () => (projectRef?.id ? getSelectedProjectActionId(projectRef.id) : null),
  );
  const [isLoading, setIsLoading] = React.useState(false);
  const urlWatchByRunKeyRef = React.useRef<Record<string, UrlWatchEntry>>({});
  const streamCleanupByRunKeyRef = React.useRef<Record<string, () => void>>({});
  const previewWaitTimeoutByRunKeyRef = React.useRef<Record<string, number>>({});
  const startingRunKeysRef = React.useRef<Set<string>>(new Set());
  const loadRequestIdRef = React.useRef(0);
  const [waitingForPreviewByExecution, setWaitingForPreviewByExecution] = React.useState<Record<string, true>>({});

  const projectId = projectRef?.id ?? null;
  const projectPath = projectRef?.path ?? '';

  React.useEffect(() => {
    setSelectedActionId(projectId ? getSelectedProjectActionId(projectId) : null);
  }, [projectId]);

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
      const setup = await getProjectSetup(stableProjectRef);
      if (loadRequestIdRef.current !== requestId) {
        return;
      }
      setupRef.current = setup;
      const filtered = setup.projectActions;
      setActions(filtered);
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
    const runs: Record<string, ProjectActionRun> = {};
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

  const autoDiscoverAction = React.useMemo<OpenChamberProjectAction>(() => ({
    id: AUTO_DISCOVER_ACTION_ID,
    name: t('projectActions.actions.autoDiscover'),
    command: '',
    icon: 'scan-2',
    autoOpenUrl: true,
  }), [t]);

  const canUseAutoDiscover = !isMobile;
  // The project's own actions come first, so with nothing picked yet the
  // button offers the first of them; auto-discovery is the fallback.
  const displayActions = React.useMemo(
    () => canUseAutoDiscover ? [...actions, autoDiscoverAction] : actions,
    [actions, autoDiscoverAction, canUseAutoDiscover]
  );

  // A stored pick that no longer names an action, or one still loading, is
  // simply not found, and the button falls back to the first action.
  const selectedAction = React.useMemo(
    () => (selectedActionId ? displayActions.find((entry) => entry.id === selectedActionId) ?? null : null),
    [displayActions, selectedActionId]
  );

  React.useEffect(() => {
    void loadActions();
  }, [loadActions]);

  const [observerCount, setObserverCount] = React.useState(0);
  const observe = React.useCallback(() => {
    setObserverCount((count) => count + 1);
    return () => setObserverCount((count) => count - 1);
  }, []);
  const observed = observerCount > 0;

  React.useEffect(() => {
    if (!observed) return;
    const cleanups = watchedTerminalDirectories.map(executionDirectory => observeTerminalSessions(
      terminal, executionDirectory, captureStartedActionMutationRevisions,
      result => reconcileServerSessions(executionDirectory, result.sessions, {
        startedActionMutationRevisions: result.startedActionMutationRevisions,
      }),
    ));
    return () => { for (const close of cleanups) close(); };
  }, [captureStartedActionMutationRevisions, observed, reconcileServerSessions, terminal, watchedTerminalDirectories]);

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
              proxiedPorts: [],
            };
        urlWatchByRunKeyRef.current[runKey] = watch;
        const action = displayActions.find((item) => item.id === entry.actionId);
        const bufferChunks = terminalStore.getBuffer(entry.directory, entry.tabId).chunks;
        if (!action || bufferChunks.length === 0) continue;

        const nextChunks = bufferChunks.filter((chunk) => watch.lastSeenChunkId === null || chunk.id > watch.lastSeenChunkId);
        if (nextChunks.length === 0) continue;

        const combined = nextChunks.map((chunk) => chunk.data).join('');
        const textForScan = `${watch.tail}${combined}`;
        for (const port of extractProxiedPorts(textForScan)) {
          if (!watch.proxiedPorts.includes(port)) watch.proxiedPorts.push(port);
        }
        // Auto-discovery inferred the command; it must not also infer the
        // address. It collects what the servers announce and decides once they
        // have had a moment to all speak up.
        // Keep listening after the panel starts offering candidates: servers in
        // one project can be seconds apart, and a list that froze at whoever was
        // ready first would quietly omit the rest.
        if (watch.openInPreview && (!watch.openedUrl || watch.offering)) {
          const announced = extractAnnouncedUrls(textForScan, { proxiedPorts: watch.proxiedPorts, namedAddressesReachable: !reachesDevServersThroughTunnel() });
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
          ? extractProjectActionUrl(textForScan, { proxiedPorts: watch.proxiedPorts, namedAddressesReachable: !reachesDevServersThroughTunnel() })
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
              useTerminalStore.getState().replaceBuffer(tabDirectory, tab.id, event.data ?? '', event.sequence ?? 0, terminalSnapshotSize(event));
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
        }, tabDirectory);
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
        ? await (async (): Promise<OpenChamberProjectAction | null> => {
          // Settings and trust belong to the project, as the menu reads them:
          // in a worktree session the session's folder is another config id.
          // The dev server itself is detected in the session's folder.
          const setupTarget = stableProjectRef ?? { id: '', path: normalizedDirectory };
          const [setup, scripts] = await Promise.all([
            getProjectSetup(setupTarget),
            readPackageJsonScripts(normalizedDirectory),
          ]);
          const devServer = await detectDevServerCommand(normalizedDirectory, setup.projectActions, scripts);
          if (!devServer) {
            throw new Error(t('contextPanel.preview.noDevServer'));
          }
          const savedAction = setup.projectActions.find((entry) => entry.id === devServer.actionId);
          if (savedAction?.source === 'shared'
            && !(await ensureSharedSetupTrusted(setupTarget, setup))) {
            return null;
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
      if (!discovered) return;

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
      // `{worktree}` / `{branch}` name the checkout the action runs in.
      const openUrlTemplate = discovered.autoOpenUrl ? (discovered.openUrl || '') : '';
      let openUrlUnresolved = false;
      const resolvedOpenUrl = hasOpenUrlTemplate(openUrlTemplate)
        ? await resolveOpenUrl(git, openUrlTemplate, executionDirectory).catch(() => {
          openUrlUnresolved = true;
          return '';
        })
        : openUrlTemplate;
      const manualOpenUrl = discovered.autoOpenUrl ? normalizeManualOpenUrl(resolvedOpenUrl) : null;
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
        proxiedPorts: [],
      };

      const executionStateKey = executionKey(executionDirectory, discovered.id, adoptedExecutionId);
      setConnecting(executionDirectory, tabId, true, { expectedExecutionId: adoptedExecutionId });
      const subscription = terminal.connect(
          activeSessionId,
          { onEvent: (event) => {
            if (!matchesActionExecution(executionDirectory, tabId, adoptedExecutionId)) return;
            if (event.purpose?.type === 'project-action' && event.purpose.executionId !== adoptedExecutionId) return;
            if (event.type === 'snapshot') {
              useTerminalStore.getState().replaceBuffer(executionDirectory, tabId, event.data ?? '', event.sequence ?? 0, terminalSnapshotSize(event));
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
          executionDirectory,
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
      } else if (openUrlUnresolved) {
        setTabPreviewUrl(executionDirectory, tabId, null, { locked: true, expectedExecutionId: adoptedExecutionId });
        toast.error(t('projectActions.error.openUrlTemplateUnresolved'));
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
    git,
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
    stableProjectRef,
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

  // A shared action comes from the repo: the first time one would run, the
  // trust prompt shows the team's commands; "not this time" runs nothing.
  const runActionWithTrust = React.useCallback(async (action: OpenChamberProjectAction) => {
    if (action.source === 'shared' && stableProjectRef) {
      const setup = setupRef.current?.trust.trusted ? setupRef.current : await getProjectSetup(stableProjectRef);
      setupRef.current = setup;
      if (!(await ensureSharedSetupTrusted(stableProjectRef, setup))) {
        return;
      }
      setupRef.current = { ...setup, trust: { ...setup.trust, trusted: true } };
    }
    await runAction(action);
  }, [runAction, stableProjectRef]);

  // A running action wins over an idle pick: the row is where it gets stopped,
  // so it must not hide behind whichever action was chosen last.
  const runOf = React.useCallback((entry: OpenChamberProjectAction): ProjectActionRun | null => (
    projectActionRuns[toProjectActionRunKey(executionDirectoryFor(entry), entry.id)] ?? null
  ), [executionDirectoryFor, projectActionRuns]);
  const shown = (selectedAction && runOf(selectedAction) ? selectedAction : null)
    ?? displayActions.find((entry) => runOf(entry) !== null)
    ?? selectedAction
    ?? displayActions[0]
    ?? null;

  const toggle = React.useCallback((action: OpenChamberProjectAction) => {
    const runningEntry = runOf(action);
    if (runningEntry?.status === 'stopping') {
      return;
    }
    if (runningEntry) {
      void stopAction(action);
      return;
    }
    void runActionWithTrust(action);
  }, [runActionWithTrust, runOf, stopAction]);

  const run = React.useCallback((action: OpenChamberProjectAction) => {
    void runActionWithTrust(action);
  }, [runActionWithTrust]);

  const stop = React.useCallback((action: OpenChamberProjectAction) => {
    void stopAction(action);
  }, [stopAction]);

  const select = React.useCallback((action: OpenChamberProjectAction) => {
    setSelectedActionId(action.id);
    if (projectId) setSelectedProjectActionId(projectId, action.id);
  }, [projectId]);

  const openSettings = React.useCallback(() => {
    if (!stableProjectRef?.id) {
      return;
    }
    setSettingsProjectsSelectedId(stableProjectRef.id);
    setSettingsPage('projects');
    setSettingsDialogOpen(true);
  }, [setSettingsDialogOpen, setSettingsPage, setSettingsProjectsSelectedId, stableProjectRef?.id]);

  const available = !runtime.isVSCode && (allowMobile || !isMobile) && Boolean(stableProjectRef) && Boolean(normalizedDirectory);

  return React.useMemo<ProjectActionsRunner>(() => ({
    available,
    actions: available ? displayActions : [],
    shown: available ? shown : null,
    isLoading,
    observe,
    runOf,
    select,
    run,
    stop,
    toggle,
    openSettings,
  }), [available, displayActions, isLoading, observe, openSettings, run, runOf, select, shown, stop, toggle]);
};
