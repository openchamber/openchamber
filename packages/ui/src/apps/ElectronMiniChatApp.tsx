import React from 'react';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { MiniChatLayout } from '@/components/mini-chat/MiniChatLayout';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { opencodeClient } from '@/lib/opencode/client';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitStore } from '@/stores/useGitStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { SyncProvider, useSessions } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { SyncRuntimeEffects } from './AppEffects';
import { useAppFontEffects } from './useAppFontEffects';
import { useMiniChatKeyboardShortcuts } from '@/hooks/useMiniChatKeyboardShortcuts';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import type { WorktreeMetadata } from '@/types/worktree';

const MINI_CHAT_PRESENCE_CHANNEL = 'openchamber:mini-chat-presence';

type MiniChatMode = 'session' | 'draft';

type MiniChatConfig = {
  mode: MiniChatMode;
  sessionId: string | null;
  directory: string | null;
  projectId: string | null;
};

type ElectronMiniChatAppProps = {
  apis: RuntimeAPIs;
};

const readMiniChatConfig = (): MiniChatConfig => {
  const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const mode = params.get('mode') === 'session' ? 'session' : 'draft';
  const sessionId = params.get('sessionId')?.trim() || null;
  const directory = params.get('directory')?.trim() || null;
  const projectId = params.get('projectId')?.trim() || null;
  return { mode, sessionId, directory, projectId };
};

const MiniChatBootstrap: React.FC<{ config: MiniChatConfig }> = ({ config }) => {
  const sessions = useSessions();
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const setDirectory = useDirectoryStore((state) => state.setDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const draftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const draftDirectory = useSessionUIStore((state) => {
    if (!state.newSessionDraft?.open) return '';
    return state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride ?? '';
  });
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const initializeApp = useConfigStore((state) => state.initializeApp);
  const isInitialized = useConfigStore((state) => state.isInitialized);
  const isConnected = useConfigStore((state) => state.isConnected);
  const loadProviders = useConfigStore((state) => state.loadProviders);
  const loadAgents = useConfigStore((state) => state.loadAgents);
  const providersCount = useConfigStore((state) => state.providers.length);
  const agentsCount = useConfigStore((state) => state.agents.length);
  const sync = useSync();

  React.useEffect(() => {
    void initializeApp();
  }, [initializeApp]);

  React.useEffect(() => {
    if (isInitialized) return;
    let active = true;
    let retryCount = 0;
    const id = window.setInterval(() => {
      if (!active) return;
      retryCount += 1;
      if (retryCount > 10) {
        window.clearInterval(id);
        return;
      }
      if (!useConfigStore.getState().isInitialized) {
        void useConfigStore.getState().initializeApp();
      }
    }, 1000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [isInitialized]);

  const directoryBootstrappedRef = React.useRef(false);
  React.useEffect(() => {
    if (directoryBootstrappedRef.current) return;
    if (config.mode !== 'session') return;
    if (!config.directory) return;
    if (currentDirectory === config.directory) {
      directoryBootstrappedRef.current = true;
      return;
    }
    setDirectory(config.directory, { showOverlay: false });
    directoryBootstrappedRef.current = true;
  }, [config.directory, config.mode, currentDirectory, setDirectory]);

  React.useEffect(() => {
    if (config.mode !== 'draft' || !draftOpen || currentSessionId) return;
    if (!draftDirectory || currentDirectory === draftDirectory) return;
    setDirectory(draftDirectory, { showOverlay: false });
  }, [config.mode, currentDirectory, currentSessionId, draftDirectory, draftOpen, setDirectory]);

  React.useEffect(() => {
    if (!isConnected) return;
    if (providersCount === 0) void loadProviders({ source: 'electronMiniChat:recovery' });
    if (agentsCount === 0) void loadAgents({ source: 'electronMiniChat:recovery' });
  }, [agentsCount, isConnected, loadAgents, loadProviders, providersCount]);

  const sessionBootstrappedRef = React.useRef(false);
  React.useEffect(() => {
    if (sessionBootstrappedRef.current) return;
    if (config.mode !== 'session' || !config.sessionId) return;
    if (currentSessionId === config.sessionId) {
      sessionBootstrappedRef.current = true;
      return;
    }
    if (currentSessionId) {
      // User already has a different session selected (e.g. from a prior switch); don't override.
      sessionBootstrappedRef.current = true;
      return;
    }
    const session = sessions.find((entry) => entry.id === config.sessionId);
    if (!session) {
      void sync.ensureSessionRenderable(config.sessionId);
      return;
    }
    const directory = (session as { directory?: string | null }).directory ?? config.directory;
    setCurrentSession(config.sessionId, directory);
    sessionBootstrappedRef.current = true;
  }, [config, currentSessionId, sessions, setCurrentSession, sync]);

  // Switch this mini-chat to another session in place (e.g. picked from the
  // tray while this window was focused) instead of spawning a new window.
  React.useEffect(() => {
    const onOpenSession = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; directory?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) return;
      if (useSessionUIStore.getState().currentSessionId === sessionId) return;
      const directory = typeof detail?.directory === 'string' && detail.directory.trim().length > 0
        ? detail.directory.trim()
        : (sessions.find((entry) => entry.id === sessionId) as { directory?: string | null } | undefined)?.directory ?? null;
      void sync.ensureSessionRenderable(sessionId);
      setCurrentSession(sessionId, directory);
      sessionBootstrappedRef.current = true;
    };
    window.addEventListener('openchamber:open-session', onOpenSession);
    return () => window.removeEventListener('openchamber:open-session', onOpenSession);
  }, [sessions, setCurrentSession, sync]);

  React.useEffect(() => {
    if (config.mode !== 'draft' || draftOpen || currentSessionId) return;
    openNewSessionDraft({
      selectedProjectId: config.projectId,
      directoryOverride: config.directory,
      preserveDirectoryOverride: Boolean(config.directory),
    });
  }, [config, currentSessionId, draftOpen, openNewSessionDraft]);

  React.useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;

    const discoverWorktrees = async () => {
      const worktreesByProject = new Map<string, WorktreeMetadata[]>();
      const allWorktrees: WorktreeMetadata[] = [];

      await Promise.all(projects.map(async (project) => {
        const projectPath = project.path.replace(/\\/g, '/').replace(/\/+$/, '');
        if (!projectPath) return;
        try {
          const cachedIsGitRepo = useGitStore.getState().directories.get(projectPath)?.isGitRepo;
          const isGitRepo = cachedIsGitRepo ?? await import('@/lib/gitApi').then((m) => m.checkIsGitRepository(projectPath));
          if (!isGitRepo) return;
          const worktrees = await listProjectWorktrees({ id: project.id, path: projectPath });
          if (cancelled || worktrees.length === 0) return;
          worktreesByProject.set(projectPath, worktrees);
          allWorktrees.push(...worktrees);
        } catch {
          // Worktree discovery is best-effort; draft selector falls back to the project root.
        }
      }));

      if (cancelled) return;

      // Skip the store update if nothing actually changed. Each reference
      // change to availableWorktreesByProject triggers re-renders in 16+
      // subscribers, so avoiding unnecessary updates is worth the comparison.
      // listProjectWorktrees returns new array instances on each call, so
      // reference equality alone won't detect identical content. Compare
      // array lengths and element references instead.
      const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
      let changed = worktreesByProject.size !== currentByProject.size;
      if (!changed) {
        for (const [key, value] of worktreesByProject) {
          const existing = currentByProject.get(key);
          if (
            !existing ||
            existing.length !== value.length ||
            existing.some((item, i) => item !== value[i])
          ) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        useSessionUIStore.setState({
          availableWorktrees: allWorktrees,
          availableWorktreesByProject: worktreesByProject,
        });
      }
    };

    void discoverWorktrees();

    return () => {
      cancelled = true;
    };
  }, [projects]);

  // Dismiss the HTML splash (see mini-chat.html) once the real content is ready,
  // so the window doesn't flash through white/connecting states. Fades out when
  // the target session is active (or the draft is open); a grace timer ensures
  // it never hangs (e.g. an unavailable session renders its own state).
  const splashDismissedRef = React.useRef(false);
  React.useEffect(() => {
    if (splashDismissedRef.current || !isInitialized) return;
    const dismiss = () => {
      if (splashDismissedRef.current) return;
      splashDismissedRef.current = true;
      const el = typeof document !== 'undefined' ? document.getElementById('initial-loading') : null;
      if (el) {
        el.classList.add('fade-out');
        window.setTimeout(() => el.remove(), 300);
      }
    };
    const ready = config.mode === 'session'
      ? currentSessionId === config.sessionId
      : draftOpen;
    const timer = window.setTimeout(dismiss, ready ? 100 : 1500);
    return () => window.clearTimeout(timer);
  }, [isInitialized, config.mode, config.sessionId, currentSessionId, draftOpen]);

  return null;
};

const MiniChatPresencePublisher: React.FC = () => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  React.useEffect(() => {
    if (!currentSessionId || !currentDirectory || typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(MINI_CHAT_PRESENCE_CHANNEL);
    const postPresence = (viewed: boolean) => {
      channel.postMessage({
        type: 'mini-chat-session-presence',
        sessionId: currentSessionId,
        directory: currentDirectory,
        viewed,
      });
    };

    postPresence(true);
    const interval = window.setInterval(() => postPresence(true), 5_000);
    const handleBeforeUnload = () => postPresence(false);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      postPresence(false);
      channel.close();
    };
  }, [currentDirectory, currentSessionId]);

  return null;
};

const useSessionUnavailable = (config: MiniChatConfig): boolean => {
  const sessions = useSessions();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const [timedOut, setTimedOut] = React.useState(false);

  React.useEffect(() => {
    if (config.mode !== 'session' || !config.sessionId || currentSessionId === config.sessionId) {
      setTimedOut(false);
      return;
    }
    if (sessions.some((entry) => entry.id === config.sessionId)) {
      setTimedOut(false);
      return;
    }
    const timeout = window.setTimeout(() => setTimedOut(true), 5000);
    return () => window.clearTimeout(timeout);
  }, [config.mode, config.sessionId, currentSessionId, sessions]);

  return timedOut;
};

export function ElectronMiniChatApp({ apis }: ElectronMiniChatAppProps) {
  const config = React.useMemo(() => readMiniChatConfig(), []);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  React.useEffect(() => {
    opencodeClient.setDirectory(currentDirectory || config.directory || undefined);
  }, [config.directory, currentDirectory]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  useAppFontEffects();
  useMiniChatKeyboardShortcuts();
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();

  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || config.directory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <ElectronMiniChatContent config={config} />
              <Toaster />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}

const ElectronMiniChatContent: React.FC<{ config: MiniChatConfig }> = ({ config }) => {
  const sessionUnavailable = useSessionUnavailable(config);

  return (
    <>
      <MiniChatBootstrap config={config} />
      <MiniChatPresencePublisher />
      <SyncRuntimeEffects embeddedBackgroundWorkEnabled={true} />
      <MiniChatLayout mode={config.mode} autoOpenDraft={config.mode === 'draft'} unavailable={sessionUnavailable} />
    </>
  );
};
