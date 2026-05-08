import React from 'react';
import { RiExternalLinkLine, RiGitBranchLine, RiPushpin2Fill, RiPushpin2Line } from '@remixicon/react';
import { Button } from '@/components/ui/button';
import { ChatContainer } from '@/components/chat/ChatContainer';
import { ChatSurfaceProvider } from '@/components/chat/ChatSurfaceContext';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel, useGitStore } from '@/stores/useGitStore';
import { resolveSessionDiffStats } from '@/components/session/sidebar/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';

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
  const sessions = useSessions();
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
  const branchLabel = gitBranchForDirectory || worktreeMetadataBranch || sessionWorktreeMetadata?.branch?.trim() || worktreeAttachment?.branch?.trim() || catalogWorktreeBranch;
  const diffStats = React.useMemo(() => {
    return resolveSessionDiffStats(session?.summary as Parameters<typeof resolveSessionDiffStats>[0]);
  }, [session?.summary]);
  const changes = diffStats ?? { additions: 0, deletions: 0 };
  const hasChanges = changes.additions > 0 || changes.deletions > 0;
  const dragRegionStyle = { WebkitAppRegion: 'drag' } as React.CSSProperties;
  const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

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
      <div className="min-w-0 flex-1">
        <div className="truncate pl-1 typography-ui-label text-[14px] font-normal leading-tight text-foreground">{title}</div>
        <div className="flex min-w-0 items-center gap-1.5 truncate pl-1 typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
          <span className="truncate">{projectLabel}</span>
          {branchLabel ? (
            <span className="inline-flex min-w-0 items-center gap-0.5">
              <RiGitBranchLine className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
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
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={handleTogglePinned}
        aria-label={pinned ? t('miniChat.actions.unpinAria') : t('miniChat.actions.pinAria')}
        title={pinned ? t('miniChat.actions.unpin') : t('miniChat.actions.pin')}
        style={noDragRegionStyle}
      >
        {pinned ? <RiPushpin2Fill className="h-4 w-4" /> : <RiPushpin2Line className="h-4 w-4" />}
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
        <RiExternalLinkLine className="h-4 w-4" />
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
