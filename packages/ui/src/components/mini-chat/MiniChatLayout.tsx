import React from 'react';
import { Button } from '@/components/ui/button';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatSurfaceProvider } from '@/components/chat/ChatSurfaceContext';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { SessionSwitcherDropdown } from '@/components/session/SessionSwitcherDropdown';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { useSessionMessages, useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel, useGitStore } from '@/stores/useGitStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { resolveSessionDiffStats } from '@/components/session/sidebar/utils';
import { Icon } from "@/components/icon/Icon";
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SessionContextUsage } from '@/stores/types/sessionTypes';

type MiniChatMode = 'session' | 'draft';

type MiniChatLayoutProps = {
  mode: MiniChatMode;
  autoOpenDraft?: boolean;
  unavailable?: boolean;
};

const compactPath = (value: string | null | undefined): string => {
  const path = typeof value === 'string' ? value.trim() : '';
  if (!path) return '';
  const home = typeof window !== 'undefined' ? window.__OPENCHAMBER_HOME__ : '';
  if (home && path === home) return '~';
  if (home && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
  const segments = path.split('/').filter(Boolean);
  if (segments.length <= 3) return path;
  return `.../${segments.slice(-3).join('/')}`;
};

const normalizePath = (value: string | null | undefined): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  const normalized = raw.replace(/\\/g, '/');
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '');
};

const MiniChatHeader: React.FC<{ mode: MiniChatMode }> = ({ mode }) => {
  const { t } = useI18n();
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const draftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const draftProjectId = useSessionUIStore((state) => state.newSessionDraft?.selectedProjectId ?? null);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const projects = useProjectsStore((state) => state.projects);
  const activeProject = useProjectsStore((state) => state.getActiveProject());
  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const providers = useConfigStore((state) => state.providers);
  const sessions = useSessions();
  const currentSessionMessages = useSessionMessages(currentSessionId ?? '');
  const runtimeApis = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((state) => state.ensureStatus);
  const worktreePath = useSessionUIStore((state) => currentSessionId ? state.worktreeMetadata.get(currentSessionId)?.path ?? '' : '');
  const worktreeMetadataBranch = useSessionUIStore((state) => currentSessionId ? state.worktreeMetadata.get(currentSessionId)?.branch?.trim() ?? null : null);
  const worktreeAttachment = useSessionWorktreeStore((state) => currentSessionId ? state.getAttachment(currentSessionId) : undefined);
  const draftDirectory = useSessionUIStore((state) => {
    if (!state.newSessionDraft?.open) return '';
    return normalizePath(state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride ?? '');
  });
  const [pinned, setPinned] = React.useState(false);
  const macosMajor = typeof window !== 'undefined' ? window.__OPENCHAMBER_MACOS_MAJOR__ ?? 0 : 0;
  const hasMacTrafficLights = Number.isFinite(macosMajor) && macosMajor > 0;
  const macosHeaderSizeClass = hasMacTrafficLights
    ? macosMajor >= 26
      ? 'h-12'
      : macosMajor <= 15
        ? 'h-14'
        : ''
    : '';

  const session = React.useMemo(
    () => currentSessionId ? sessions.find((entry) => entry.id === currentSessionId) ?? null : null,
    [currentSessionId, sessions],
  );
  const sessionWorktreeMetadata = (session as { worktreeMetadata?: { path?: string | null; branch?: string | null; projectDirectory?: string | null } } | null)?.worktreeMetadata ?? null;

  React.useEffect(() => {
    if (!isElectronShell()) return;
    void invokeDesktop<{ pinned?: boolean }>('desktop_get_window_pinned').then((result) => {
      if (typeof result?.pinned === 'boolean') setPinned(result.pinned);
    });
  }, []);

  const title = session?.title?.trim()
    || (draftOpen || mode === 'draft' ? t('miniChat.header.newSession') : t('miniChat.header.session'));
  const sessionDirectory = normalizePath((session as { directory?: string | null } | null)?.directory ?? null);
  const worktreeDirectory = normalizePath(worktreePath || sessionWorktreeMetadata?.path || worktreeAttachment?.cwd || worktreeAttachment?.worktreeRoot || '');
  const currentDirectoryNormalized = normalizePath(currentDirectory);
  const openDirectory = worktreeDirectory || sessionDirectory || draftDirectory || currentDirectoryNormalized;
  const directoryLabel = compactPath(openDirectory);
  const catalogWorktreeBranch = useSessionUIStore((state) => {
    const candidateDirectory = normalizePath(worktreeDirectory || sessionDirectory || '');
    if (!candidateDirectory) return null;
    for (const worktrees of state.availableWorktreesByProject.values()) {
      const match = worktrees.find((worktree) => normalizePath(worktree.path) === candidateDirectory);
      const branch = match?.branch?.trim();
      if (branch) return branch;
    }
    return null;
  });
  React.useEffect(() => {
    if (!openDirectory) return;
    void ensureGitStatus(openDirectory, runtimeApis.git).catch(() => {});
  }, [ensureGitStatus, openDirectory, runtimeApis.git]);

  const pathMatchedProject = React.useMemo(() => {
    const projectDirectory = normalizePath(sessionWorktreeMetadata?.projectDirectory ?? worktreeAttachment?.worktreeRoot ?? null);
    const candidateDirectory = projectDirectory || openDirectory;
    if (!candidateDirectory) return null;
    return projects
      .map((entry) => ({ ...entry, normalizedPath: normalizePath(entry.path) }))
      .filter((entry) => entry.normalizedPath && (entry.normalizedPath === candidateDirectory || candidateDirectory.startsWith(`${entry.normalizedPath}/`)))
      .sort((left, right) => right.path.length - left.path.length)[0] ?? null;
  }, [openDirectory, projects, sessionWorktreeMetadata?.projectDirectory, worktreeAttachment?.worktreeRoot]);
  const projectLabel = React.useMemo(() => {
    const project = pathMatchedProject ?? activeProject;
    if (!project) return directoryLabel || 'OpenChamber';
    const label = project.label?.trim();
    if (label) return label;
    const segments = project.path.split(/[\\/]/).filter(Boolean);
    return segments.at(-1) ?? project.path;
  }, [activeProject, directoryLabel, pathMatchedProject]);
  const gitBranchForDirectory = useGitBranchLabel(openDirectory || null);
  const rawBranchLabel = gitBranchForDirectory || worktreeMetadataBranch || sessionWorktreeMetadata?.branch?.trim() || worktreeAttachment?.branch?.trim() || catalogWorktreeBranch;
  const branchLabel = rawBranchLabel && rawBranchLabel !== 'HEAD' ? rawBranchLabel : null;
  const diffStats = React.useMemo(() => {
    return resolveSessionDiffStats(session?.summary as Parameters<typeof resolveSessionDiffStats>[0]);
  }, [session?.summary]);
  const changes = diffStats ?? { additions: 0, deletions: 0 };
  const hasChanges = changes.additions > 0 || changes.deletions > 0;
  const currentModel = getCurrentModel();
  const latestAssistantModel = React.useMemo(() => {
    for (let i = currentSessionMessages.length - 1; i >= 0; i -= 1) {
      const message = currentSessionMessages[i] as { role?: unknown; providerID?: unknown; modelID?: unknown };
      if (message.role !== 'assistant') continue;
      if (typeof message.providerID !== 'string' || typeof message.modelID !== 'string') continue;
      const provider = providers.find((entry) => entry.id === message.providerID);
      const model = provider?.models.find((entry) => entry.id === message.modelID);
      if (model) return model;
    }
    return undefined;
  }, [currentSessionMessages, providers]);
  const modelForLimits = currentModel?.limit ? currentModel : latestAssistantModel;
  const limit = modelForLimits && typeof modelForLimits.limit === 'object' && modelForLimits.limit !== null
    ? (modelForLimits.limit as Record<string, unknown>)
    : null;
  const contextLimit = limit && typeof limit.context === 'number' ? limit.context : 0;
  const outputLimit = limit && typeof limit.output === 'number' ? limit.output : 0;
  const contextUsage = React.useMemo<SessionContextUsage | null>(() => {
    if (!currentSessionId || currentSessionMessages.length === 0) {
      return null;
    }

    type AssistantTokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
    let lastTokens: AssistantTokens | undefined;
    let lastMessageId: string | undefined;

    for (let i = currentSessionMessages.length - 1; i >= 0; i -= 1) {
      const message = currentSessionMessages[i];
      if (message.role !== 'assistant') continue;
      const tokens = (message as { tokens?: AssistantTokens }).tokens;
      if (!tokens) continue;
      const total = tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
      if (total > 0) {
        lastTokens = tokens;
        lastMessageId = message.id;
        break;
      }
    }

    if (!lastTokens) {
      return null;
    }

    const totalTokens = lastTokens.input + lastTokens.output + lastTokens.reasoning + (lastTokens.cache?.read ?? 0) + (lastTokens.cache?.write ?? 0);
    const thresholdLimit = contextLimit > 0 ? contextLimit : 200000;
    const percentage = contextLimit > 0 ? Math.round((totalTokens / contextLimit) * 100) : 0;
    const normalizedOutput = outputLimit > 0 ? Math.round((lastTokens.output / outputLimit) * 100) : undefined;

    return {
      totalTokens,
      percentage,
      contextLimit: contextLimit || 0,
      outputLimit: outputLimit || undefined,
      normalizedOutput,
      thresholdLimit,
      lastMessageId,
    };
  }, [contextLimit, currentSessionId, currentSessionMessages, outputLimit]);
  const [stableContextUsage, setStableContextUsage] = React.useState<SessionContextUsage | null>(null);
  const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  React.useEffect(() => {
    if (!currentSessionId) {
      setStableContextUsage((prev) => (prev === null ? prev : null));
      return;
    }

    if (contextUsage && contextUsage.totalTokens > 0) {
      setStableContextUsage((prev) => {
        if (
          prev
          && prev.totalTokens === contextUsage.totalTokens
          && prev.percentage === contextUsage.percentage
          && prev.contextLimit === contextUsage.contextLimit
          && (prev.outputLimit ?? 0) === (contextUsage.outputLimit ?? 0)
          && (prev.normalizedOutput ?? 0) === (contextUsage.normalizedOutput ?? 0)
          && prev.thresholdLimit === contextUsage.thresholdLimit
          && prev.lastMessageId === contextUsage.lastMessageId
        ) {
          return prev;
        }
        return contextUsage;
      });
      return;
    }

    setStableContextUsage((prev) => (prev === null ? prev : null));
  }, [contextUsage, currentSessionId]);

  const displayContextPercentage = stableContextUsage && stableContextUsage.contextLimit > 0
    ? Math.min(999, (stableContextUsage.totalTokens / stableContextUsage.contextLimit) * 100)
    : 0;

  const handleTogglePinned = React.useCallback(() => {
    const nextPinned = !pinned;
    setPinned(nextPinned);
    void invokeDesktop('desktop_set_window_pinned', { pinned: nextPinned }).catch(() => {
      setPinned(!nextPinned);
    });
  }, [pinned]);

  const handleOpenMainApp = React.useCallback(() => {
    const payload = currentSessionId
      ? { sessionId: currentSessionId, directory: (session as { directory?: string | null } | null)?.directory ?? currentDirectory ?? '' }
      : { mode: 'draft', directory: openDirectory || currentDirectory || '', projectId: draftProjectId };
    void invokeDesktop<{ focused?: boolean }>('desktop_focus_main_window', payload)
      .then((result) => {
        if (result?.focused === true) {
          return invokeDesktop('desktop_close_current_window');
        }
        return null;
      });
  }, [currentDirectory, currentSessionId, draftProjectId, openDirectory, session]);

  return (
    <header
      className={cn(
        'flex items-center gap-3 border-b border-[var(--interactive-border)] bg-[var(--surface-background)] pr-3',
        hasMacTrafficLights ? 'pl-[5.5rem]' : 'pl-3',
        macosHeaderSizeClass || 'min-h-14',
      )}
      style={dragRegionStyle}
    >
      <SessionSwitcherDropdown>
        <button
          type="button"
          aria-label={t('sessions.switcher.openAria')}
          style={noDragRegionStyle}
          className="flex min-w-0 max-w-full flex-col items-start rounded-md px-1 py-0.5 text-left transition-colors hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:bg-interactive-hover/60"
        >
          <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
            {title}
          </span>
          <span className="flex min-w-0 max-w-full items-center gap-1.5 truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
            <span className="truncate">{projectLabel}</span>
            {branchLabel ? (
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                <span className="truncate">{branchLabel}</span>
              </span>
            ) : null}
            {hasChanges ? (
              <span className="inline-flex flex-shrink-0 items-center gap-0 text-[0.92em]">
                <span className="text-status-success/80">+{changes.additions}</span>
                <span className="text-muted-foreground/60">/</span>
                <span className="text-status-error/65">-{changes.deletions}</span>
              </span>
            ) : null}
          </span>
        </button>
      </SessionSwitcherDropdown>
      <div className="min-w-0 flex-1" />
      {stableContextUsage && stableContextUsage.totalTokens > 0 ? (
        <ContextUsageDisplay
          totalTokens={stableContextUsage.totalTokens}
          percentage={displayContextPercentage}
          colorPercentage={stableContextUsage.percentage}
          contextLimit={stableContextUsage.contextLimit}
          outputLimit={stableContextUsage.outputLimit ?? 0}
          className="h-9 shrink-0 pl-1 pr-1 typography-ui-label"
          valueClassName="font-semibold leading-none"
          hideIcon
          showPercentIcon
          percentIconClassName="h-5 w-5"
        />
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleTogglePinned}
        aria-label={pinned ? t('miniChat.actions.unpinAria') : t('miniChat.actions.pinAria')}
        title={pinned ? t('miniChat.actions.unpin') : t('miniChat.actions.pin')}
        style={noDragRegionStyle}
      >
        {pinned ? <Icon name="pushpin-2-fill" className="h-4 w-4" /> : <Icon name="pushpin-2" className="h-4 w-4" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleOpenMainApp}
        aria-label={t('miniChat.actions.openMainAria')}
        title={t('miniChat.actions.openMain')}
        style={noDragRegionStyle}
      >
        <Icon name="external-link" className="h-4 w-4" />
      </Button>
    </header>
  );
};

export const MiniChatLayout: React.FC<MiniChatLayoutProps> = ({ mode, autoOpenDraft = false, unavailable = false }) => {
  const { t } = useI18n();

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <MiniChatHeader mode={mode} />
      <main className="min-h-0 flex-1">
        {unavailable ? (
          <div className="flex h-full items-center justify-center px-6 text-center typography-ui-label text-muted-foreground">
            <div className="max-w-sm rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-4 py-3">
              <div className="font-medium text-foreground">{t('miniChat.unavailable.title')}</div>
              <div className="mt-1 typography-small text-muted-foreground">{t('miniChat.unavailable.description')}</div>
            </div>
          </div>
        ) : (
          <ChatSurfaceProvider mode="mini-chat">
            <ChatContainer autoOpenDraft={autoOpenDraft} />
          </ChatSurfaceProvider>
        )}
      </main>
    </div>
  );
};
