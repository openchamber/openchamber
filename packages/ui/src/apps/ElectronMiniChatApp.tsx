import React from 'react';
import { z } from 'zod';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { MiniChatLayout } from '@/components/mini-chat/MiniChatLayout';
import { AppLinkConfirmDialog } from '@/components/chat/AppLinkConfirmDialog';
import { SnippetQuickCreateDialog } from '@/components/snippets/SnippetQuickCreateDialog';
import { GlobalQuestionDialogs } from '@/components/layout/GlobalQuestionDialogs';
import { OpenCodeTrustDialog } from '@/components/projects/OpenCodeTrustDialog';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import { useRoutingSync } from '@/hooks/useRoutingSync';
import { useRootScrollLock } from '@/hooks/useRootScrollLock';
import { opencodeClient } from '@/lib/opencode/client';
import { openSession } from '@/lib/router/openSessionFromRoute';
import type { RuntimeAPIs } from '@/lib/api/types';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitStore } from '@/stores/useGitStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { seedGlobalSessionStatusFromHost } from '@/sync/host-session-status-seed';
import { refreshRecentGlobalSessions } from '@/stores/useGlobalSessionsStore';
import { subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { SyncProvider, useSessions } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { SyncRuntimeEffects } from './AppEffects';
import { useAppFontEffects } from './useAppFontEffects';
import { useMiniChatKeyboardShortcuts } from '@/hooks/useMiniChatKeyboardShortcuts';
import {
  listProjectWorktrees,
  partitionWorktreesByRegisteredProject,
  worktreeMapsEqual,
} from '@/lib/worktrees/worktreeManager';
import { refreshWorktreeTopologyForChange } from '@/lib/worktrees/worktreeTopologyRefresh';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import type { WorktreeMetadata } from '@/types/worktree';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { openSessionInOwningHostWindow } from '@/lib/desktop';
import { readMiniChatConfig, type MiniChatConfig } from './miniChatConfig';

const MINI_CHAT_PRESENCE_CHANNEL = 'openchamber:mini-chat-presence';

type ElectronMiniChatAppProps = {
  apis: RuntimeAPIs;
};

const optionalTrimmedString = z.string().trim().optional().catch(undefined);
const openSessionDetailSchema = z.object({
  sessionId: z.string().trim().min(1),
  directory: optionalTrimmedString,
  messageId: optionalTrimmedString,
  runtimeKey: optionalTrimmedString,
});

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

  React.useEffect(() => {
    const onOpenSession = (event: Event) => {
      const parsed = openSessionDetailSchema.safeParse(event instanceof CustomEvent ? event.detail : null);
      if (!parsed.success) return;
      const { sessionId, messageId, runtimeKey } = parsed.data;
      if (openSessionInOwningHostWindow(sessionId, runtimeKey || null, messageId || null)) return;
      const sessionDirectory = (sessions.find((entry) => entry.id === sessionId) as { directory?: string | null } | undefined)?.directory?.trim();
      const directory = sessionDirectory || parsed.data.directory || null;
      void sync.ensureSessionRenderable(sessionId);
      void openSession(sessionId, { directory, messageId: messageId || null });
      sessionBootstrappedRef.current = true;
    };
    window.addEventListener('openchamber:open-session', onOpenSession);
    return () => window.removeEventListener('openchamber:open-session', onOpenSession);
  }, [sessions, sync]);

  React.useEffect(() => {
    if (config.mode !== 'draft' || draftOpen || currentSessionId) return;
    const hasProjectTarget = Boolean(config.projectId || config.directory);
    openNewSessionDraft({
      target: hasProjectTarget ? 'project' : 'chat',
      selectedProjectId: hasProjectTarget ? config.projectId : CHAT_DRAFT_PROJECT_ID,
      directoryOverride: hasProjectTarget ? config.directory : null,
      preserveDirectoryOverride: Boolean(config.directory),
    });
  }, [config, currentSessionId, draftOpen, openNewSessionDraft]);

  React.useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;

    const discoverWorktrees = async () => {
      const worktreesByProject = new Map<string, WorktreeMetadata[]>();

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
        } catch {
          // Worktree discovery is best-effort; draft selector falls back to the project root.
        }
      }));

      if (cancelled) return;

      const partitionedWorktreesByProject = partitionWorktreesByRegisteredProject(projects, worktreesByProject);

      const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
      if (!worktreeMapsEqual(partitionedWorktreesByProject, currentByProject)) {
        useSessionUIStore.setState({
          availableWorktrees: [...partitionedWorktreesByProject.values()].flat(),
          availableWorktreesByProject: partitionedWorktreesByProject,
        });
      }
    };

    void discoverWorktrees();

    return () => {
      cancelled = true;
    };
  }, [projects]);

  React.useEffect(() => {
    if (projects.length === 0) return;
    let cancelled = false;
    const unsubscribe = subscribeOpenchamberEvents((event) => {
      if (event.type !== 'worktree-changed') return;
      void refreshWorktreeTopologyForChange(projects, event.directories, () => cancelled);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projects]);

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
  const draftOpen = useSessionUIStore((state) => state.newSessionDraft.open);
  const [timedOut, setTimedOut] = React.useState(false);

  React.useEffect(() => {
    if (draftOpen || config.mode !== 'session' || !config.sessionId || currentSessionId) {
      setTimedOut(false);
      return;
    }
    if (sessions.some((entry) => entry.id === config.sessionId)) {
      setTimedOut(false);
      return;
    }
    const timeout = window.setTimeout(() => setTimedOut(true), 5000);
    return () => window.clearTimeout(timeout);
  }, [config.mode, config.sessionId, currentSessionId, draftOpen, sessions]);

  return timedOut;
};

const useRecentSessions = (): void => {
  React.useEffect(() => {
    const load = () => {
      void refreshRecentGlobalSessions().then(() => seedGlobalSessionStatusFromHost()).catch(() => undefined);
    };
    load();
    return subscribeRuntimeEndpointChanged(load);
  }, []);
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
  usePushVisibilityBeacon({ enabled: true });
  useWindowTitle();
  useRoutingSync();
  useRootScrollLock();
  useRecentSessions();

  return (
    <ErrorBoundary>
      <SyncProvider sdk={opencodeClient.getSdkClient()} directory={currentDirectory || config.directory || ''}>
        <RuntimeAPIProvider apis={apis}>
          <TooltipProvider delayDuration={300} skipDelayDuration={150}>
            <div className="h-full text-foreground bg-background">
              <ElectronMiniChatContent config={config} />
              <AppLinkConfirmDialog />
              <SnippetQuickCreateDialog />
              <GlobalQuestionDialogs />
              <OpenCodeTrustDialog />
              <Toaster />
            </div>
          </TooltipProvider>
        </RuntimeAPIProvider>
      </SyncProvider>
    </ErrorBoundary>
  );
}

const MiniChatKeyboardShortcuts: React.FC = () => {
  useMiniChatKeyboardShortcuts();
  return null;
};

const ElectronMiniChatContent: React.FC<{ config: MiniChatConfig }> = ({ config }) => {
  const sessionUnavailable = useSessionUnavailable(config);

  return (
    <>
      <MiniChatKeyboardShortcuts />
      <MiniChatBootstrap config={config} />
      <MiniChatPresencePublisher />
      <SyncRuntimeEffects backgroundWorkEnabled={true} />
      <MiniChatLayout mode={config.mode} autoOpenDraft={config.mode === 'draft'} unavailable={sessionUnavailable} />
    </>
  );
};
