import React, { useEffect } from 'react';
import { useGuestsStore } from '@/lib/guests/store';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { formatSessionWorktreeBadge } from '@/sync/session-worktree-contract';
import { useGlobalSessionStatus } from '@/sync/sync-context';
import { useDirectoryStore as useAppDirectoryStore } from '@/stores/useDirectoryStore';
import { isChatDirectoryForHome } from '@/lib/chatDirectories';
import { useSessionMessageRecordsForExport } from '@/sync/use-sync';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { archiveUndoToastOptions, collectSessionSubtreeIds } from '@/components/session/sidebar/sessions/sessionSubtreeActions';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';

import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { useDeviceInfo, useTabletStandalonePwaRuntime } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useKeybinds } from '@/hooks/useKeybind';
import {
} from '@/lib/quota/model-families';

import {
} from '@/components/ui/collapsible';
import { SpaceAccessButton } from '@/components/session/spaces/SpaceAccessButton';
import { SpaceApplyButton } from '@/components/session/spaces/SpaceApplyButton';
import { SessionSwitcherDropdown } from '@/components/session/SessionSwitcherDropdown';
import { SessionTabsStrip, type SessionTabMenuArgs } from './SessionTabsStrip';
import { SessionMenuItemHint } from '@/components/session/SessionMenuItemHint';
import { MoveChatToProjectDialog } from '@/components/session/MoveChatToProjectDialog';
import { HeaderSessionArchiveMenuItem } from './HeaderSessionArchiveMenuItem';
import { canUseElectronDesktopIPC, invokeDesktop, isDesktopShell, isVSCodeRuntime, startDesktopWindowDrag } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { useShallow } from 'zustand/react/shallow';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { guestSessionActions, type GuestActionEntry } from '@/lib/guests/actions';
import { runGuestSessionAction } from '@/lib/guests/session-action';
import { SessionAiRenameMenuItem } from '@/components/session/SessionAiRenameMenuItem';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { useIsSessionAiRenamePending } from '@/sync/use-session-ai-rename';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useMultiRunTitle } from '@/lib/multirun/useMultiRuns';
import { buildSessionTreeMoveMessages, requestSessionTreeMove, useIsSessionWorktreeMovePending } from '@/lib/worktrees/sessionWorktreeMove';
import { titlebarControlsWidthReaderRef } from './titlebarControlsWidth';

const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-6 w-6 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';


const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};



type HeaderSessionSnapshot = {
  title: string | null;
  directory: string | null;
  created: number | null;
  slug: string | null;
  parentId: string | null;
};

export const Header: React.FC = () => {
  streamPerfCount('ui.header.render');
  const { t } = useI18n();
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const sessionTabsEnabled = useUIStore((state) => state.sessionTabsEnabled);

  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionStatus = useGlobalSessionStatus(currentSessionId ?? '');
  const isCurrentSessionMovingToWorktree = useIsSessionWorktreeMovePending(currentSessionId ?? '');
  const currentGlobalSession = useGlobalSessionsStore(useShallow(React.useCallback(
    (state): HeaderSessionSnapshot | null => {
      if (!currentSessionId) return null;
       const session = [...state.activeSessions, ...state.archivedSessions]
         .find((candidate) => candidate.id === currentSessionId);
      if (!session) return null;
      const record = session as typeof session & { directory?: string | null; slug?: string | null };
      return {
        title: session.title ?? null,
        directory: record.directory ?? null,
        created: session.time?.created ?? null,
        slug: record.slug ?? null,
        parentId: session.parentID ?? null,
      };
    },
    [currentSessionId],
  )));
  const activeProject = useProjectsStore(useShallow((state) => {
    if (!state.activeProjectId) {
      return null;
    }
    const project = state.projects.find((candidate) => candidate.id === state.activeProjectId);
    return project ? { id: project.id, path: project.path, label: project.label } : null;
  }));
  const activeProjectLabel = React.useMemo(() => {
    if (!activeProject) {
      return null;
    }

    const trimmedLabel = activeProject.label?.trim();
    if (trimmedLabel) {
      return trimmedLabel;
    }

    const pathSegments = activeProject.path.split(/[\\/]/).filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? null;
  }, [activeProject]);
  const loadQuotaSettings = useQuotaStore((state) => state.loadSettings);

  const { isMobile } = useDeviceInfo();
  const headerRef = React.useRef<HTMLElement | null>(null);

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });
  const hasElectronDesktopIPC = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const isTabletStandalonePwa = useTabletStandalonePwaRuntime();
  const [isDesktopWindowFullscreen, setIsDesktopWindowFullscreen] = React.useState(false);

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __OPENCHAMBER_MACOS_MAJOR__?: unknown }).__OPENCHAMBER_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    // Fallback: WebKit reports "Mac OS X 10_15_7" format where 10 is legacy prefix
    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
    return first === 10 ? second : first;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  // While the work-status panel is on screen it already reports the project
  // and the branch — three paces away in the same window. The meta row under
  // the title yields to it rather than saying the same thing twice, and
  // returns the moment the panel is switched off or squeezed out.
  const workStatusPanelVisible = useUIStore((state) => state.workStatusPanelVisible);
  const workStatusPanelEnabled = useUIStore((state) => state.workStatusPanelEnabled);
  const setWorkStatusPanelEnabled = useUIStore((state) => state.setWorkStatusPanelEnabled);
  const workStatusPanelFits = useUIStore((state) => state.workStatusPanelFits);
  const workStatusOverlayOpen = useUIStore((state) => state.workStatusOverlayOpen);
  const setWorkStatusOverlayOpen = useUIStore((state) => state.setWorkStatusOverlayOpen);

  // Two meanings for one button. With room beside the chat it switches the
  // panel on and off. Without room it cannot be shown inline at all, so it
  // reads as off and opens the panel over the chat instead — the stored
  // preference is left alone, so the panel comes back on its own once the
  // window is wide enough again.
  const workStatusPanelShownInline = workStatusPanelEnabled && workStatusPanelFits;
  const workStatusToggleActive = workStatusPanelShownInline || workStatusOverlayOpen;
  const handleWorkStatusToggle = React.useCallback(() => {
    if (workStatusPanelEnabled && !workStatusPanelFits) {
      setWorkStatusOverlayOpen(!workStatusOverlayOpen);
      return;
    }
    setWorkStatusPanelEnabled(!workStatusPanelEnabled);
  }, [setWorkStatusOverlayOpen, setWorkStatusPanelEnabled, workStatusOverlayOpen, workStatusPanelEnabled, workStatusPanelFits]);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    void loadQuotaSettings();
  }, [loadQuotaSettings]);


  const currentSessionSnapshot = currentSessionId
    ? currentGlobalSession ?? null
    : null;

  const lastResolvedSessionRef = React.useRef<{
    sessionId: string;
    session: HeaderSessionSnapshot;
    expiresAt: number;
  } | null>(null);
  const [sessionFallbackVersion, setSessionFallbackVersion] = React.useState(0);

  React.useEffect(() => {
    if (!currentSessionId) {
      if (lastResolvedSessionRef.current) {
        lastResolvedSessionRef.current = null;
        setSessionFallbackVersion((value) => value + 1);
      }
      return;
    }

    if (currentSessionSnapshot) {
      lastResolvedSessionRef.current = {
        sessionId: currentSessionId,
        session: currentSessionSnapshot,
        expiresAt: Date.now() + 2000,
      };
      return;
    }

    const cached = lastResolvedSessionRef.current;
    if (!cached || cached.sessionId !== currentSessionId) {
      return;
    }

    const remainingMs = cached.expiresAt - Date.now();
    if (remainingMs <= 0) {
      lastResolvedSessionRef.current = null;
      setSessionFallbackVersion((value) => value + 1);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (lastResolvedSessionRef.current?.sessionId === currentSessionId) {
        lastResolvedSessionRef.current = null;
      }
      setSessionFallbackVersion((value) => value + 1);
    }, remainingMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [currentSessionId, currentSessionSnapshot]);

  void sessionFallbackVersion;
  const currentSession = (() => {
    if (currentSessionSnapshot) {
      return currentSessionSnapshot;
    }

    if (!currentSessionId) {
      return null;
    }

    const cached = lastResolvedSessionRef.current;
    if (cached && cached.sessionId === currentSessionId && cached.expiresAt > Date.now()) {
      return cached.session;
    }

    return null;
  })();

  const worktreePath = useSessionUIStore((state) => {
    if (!currentSessionId) return '';
    return state.worktreeMetadata.get(currentSessionId)?.path ?? '';
  });
  const currentSessionWorktreeBranch = useSessionUIStore((state) => {
    if (!currentSessionId) return null;
    return state.worktreeMetadata.get(currentSessionId)?.branch?.trim() ?? null;
  });

  // Authoritative session↔worktree attachment from session-worktree-store
  const worktreeAttachment = useSessionWorktreeStore((state) =>
    currentSessionId ? state.getAttachment(currentSessionId) : undefined
  );

  const worktreeBadge = React.useMemo(() => {
    if (!worktreeAttachment) return null;
    return formatSessionWorktreeBadge(worktreeAttachment, {
      pending: t('gitView.empty.worktreeSetupInProgress'),
      missing: t('sessions.sidebar.group.worktreeMissing'),
    });
  }, [t, worktreeAttachment]);

  const worktreeBadgeKind = React.useMemo(() => {
    if (!worktreeAttachment) return null;
    if (worktreeAttachment.legacy) return 'legacy';
    if (worktreeAttachment.degraded) return 'degraded';
    if (worktreeAttachment.worktreeStatus === 'pending') return 'pending';
    if (worktreeAttachment.worktreeStatus === 'missing') return 'missing';
    if (worktreeAttachment.worktreeStatus === 'invalid') return 'invalid';
    if (worktreeAttachment.attentionReason) return 'attention';
    return null;
  }, [worktreeAttachment]);
  const worktreeDirectory = React.useMemo(() => {
    return normalize(worktreePath || '');
  }, [worktreePath]);

  const sessionDirectory = React.useMemo(() => {
    const raw = typeof currentSession?.directory === 'string' ? currentSession.directory : '';
    return normalize(raw || '');
  }, [currentSession?.directory]);
  const isCurrentSessionAiRenaming = useIsSessionAiRenamePending(currentSessionId ?? '', sessionDirectory);

  const draftDirectory = useSessionUIStore((state) => {
    if (!state.newSessionDraft?.open) {
      return '';
    }
    return normalize(state.newSessionDraft.bootstrapPendingDirectory ?? state.newSessionDraft.directoryOverride ?? '');
  });
  const draftTarget = useSessionUIStore((state) => state.newSessionDraft.target);
  const selectedSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const homeDirectory = useAppDirectoryStore((state) => state.homeDirectory);

  const openDirectory = React.useMemo(() => {
    return worktreeDirectory || sessionDirectory || draftDirectory;
  }, [draftDirectory, sessionDirectory, worktreeDirectory]);

  const catalogWorktreeBranch = useSessionUIStore((state) => {
    const candidateDirectory = normalize(worktreeDirectory || sessionDirectory || '');
    if (!candidateDirectory) {
      return null;
    }

    for (const worktrees of state.availableWorktreesByProject.values()) {
      const match = worktrees.find((worktree) => normalize(worktree.path) === candidateDirectory);
      const branch = match?.branch?.trim();
      if (branch) {
        return branch;
      }
    }

    return null;
  });

  const gitBranchForDirectory = useGitBranchLabel(openDirectory || null);
  const currentBranchLabel = gitBranchForDirectory || currentSessionWorktreeBranch || catalogWorktreeBranch;
  const isChatContext = isNewSessionDraftOpen
    ? draftTarget === 'chat'
    : isChatDirectoryForHome(sessionDirectory || selectedSessionDirectory, homeDirectory);

  // Whether the title carries a second line under it. Hoisted because the
  // session menu's vertical alignment depends on the same answer.
  const showHeaderMetaRow = !isChatContext && !workStatusPanelVisible
    && Boolean(activeProjectLabel || currentBranchLabel || (!isNewSessionDraftOpen && worktreeBadgeKind));



  const currentSessionTitle = React.useMemo(() => {
    if (!currentSessionId) {
      return activeProjectLabel ?? 'OpenChamber';
    }
    const trimmedTitle = currentSession?.title?.trim();
    return trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : 'Untitled Session';
  }, [activeProjectLabel, currentSession?.title, currentSessionId]);
  const loadSessionRecords = useSessionMessageRecordsForExport();
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const [isRenamingHeaderSession, setIsRenamingHeaderSession] = React.useState(false);
  const [isHeaderSessionMenuOpen, setIsHeaderSessionMenuOpen] = React.useState(false);
  /** Session id whose rename was requested from a tab menu; survives the
      activation that a Rename on an inactive tab performs first. */
  const pendingHeaderRenameRef = React.useRef<string | null>(null);
  const [headerSessionTitleDraft, setHeaderSessionTitleDraft] = React.useState('');
  const [moveChatDialogOpen, setMoveChatDialogOpen] = React.useState(false);
  const hasProjects = useProjectsStore((state) => state.projects.length > 0);
  const [pendingHeaderRetentionAction, setPendingHeaderRetentionAction] = React.useState<{ action: 'archive' | 'delete'; sessionId: string } | null>(null);
  const headerRenameFormRef = React.useRef<HTMLFormElement | null>(null);


  const beginHeaderSessionRename = React.useCallback(() => {
    if (!currentSessionId) return;
    setHeaderSessionTitleDraft(currentSession?.title?.trim() || currentSessionTitle);
    setIsRenamingHeaderSession(true);
  }, [currentSession?.title, currentSessionId, currentSessionTitle]);

  const beginHeaderSessionRenameRef = React.useRef(beginHeaderSessionRename);
  beginHeaderSessionRenameRef.current = beginHeaderSessionRename;

  // The rename field opens with the whole title selected, so the first
  // keystroke replaces it. Stable ref callback: an inline one would re-run on
  // every render and re-select the text mid-edit.
  const focusHeaderRenameInput = React.useCallback((node: HTMLInputElement | null) => {
    if (!node) return;
    node.focus();
    node.select();
  }, []);

  React.useEffect(() => {
    setIsHeaderSessionMenuOpen(false);
    setPendingHeaderRetentionAction(null);
    if (currentSessionId && pendingHeaderRenameRef.current === currentSessionId) {
      // Rename on an inactive tab activates it first; the switch itself is
      // when the rename can begin (the menu may close before or after it).
      pendingHeaderRenameRef.current = null;
      beginHeaderSessionRenameRef.current();
      return;
    }
    setIsRenamingHeaderSession(false);
    setHeaderSessionTitleDraft('');
  }, [currentSessionId]);

  const saveHeaderSessionRename = React.useCallback(async () => {
    if (!currentSessionId) return;
    const title = headerSessionTitleDraft.trim();
    if (title && title !== currentSession?.title?.trim()) {
      await updateSessionTitle(currentSessionId, title);
    }
    setIsRenamingHeaderSession(false);
  }, [currentSession?.title, currentSessionId, headerSessionTitleDraft, updateSessionTitle]);

  React.useEffect(() => {
    if (!isRenamingHeaderSession) return;
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || !headerRenameFormRef.current?.contains(target)) {
        void saveHeaderSessionRename();
      }
    };
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [isRenamingHeaderSession, saveHeaderSessionRename]);

  const copySessionIdFor = React.useCallback((sessionId: string) => {
    if (!sessionId) return;
    void copyTextToClipboard(sessionId).then((result) => {
      toast[result.ok ? 'success' : 'error'](t(result.ok
        ? 'sessions.sidebar.session.copyId.success'
        : 'sessions.sidebar.session.copyId.error'));
    }).catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
  }, [t]);

  const exportCurrentSession = React.useCallback(async () => {
    if (!currentSessionId || !openDirectory) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }
    const records = await loadSessionRecords({ sessionID: currentSessionId, directory: openDirectory }).catch(() => null);
    if (!records) {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
      return;
    }
    if (records.length === 0) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }
    const markdown = formatSessionAsMarkdown(records, currentSession?.title ?? null);
    const filename = buildExportFilename(currentSession?.title ?? null);
    const savedPath = await saveAsMarkdownDesktop(markdown, filename);
    if (!savedPath) downloadAsMarkdown(markdown, filename);
    toast.success(t('sessions.sidebar.session.export.success'));
  }, [currentSession?.title, currentSessionId, loadSessionRecords, openDirectory, t]);

  // Extension session actions on the current session. The conversation is
  // loaded the same way Export as Markdown loads it.
  const guestActionEntries = useGuestActions();
  const guestSessionActionEntries = React.useMemo(() => guestSessionActions(guestActionEntries), [guestActionEntries]);
  const runCurrentSessionGuestAction = React.useCallback((entry: GuestActionEntry) => {
    if (!currentSessionId) return;
    void runGuestSessionAction({
      entry,
      t,
      session: { id: currentSessionId, title: currentSession?.title, directory: sessionDirectory ?? openDirectory },
      loadRecords: async () => {
        if (!openDirectory) return null;
        try {
          return await loadSessionRecords({ sessionID: currentSessionId, directory: openDirectory });
        } catch {
          return null;
        }
      },
      onLoadFailed: () => toast.error(t('sessions.sidebar.session.export.failedLoadHistory')),
    });
  }, [currentSession?.title, currentSessionId, loadSessionRecords, openDirectory, sessionDirectory, t]);
  const renderGuestSessionActionItems = React.useCallback((Item: React.ElementType) => guestSessionActionEntries.map((entry) => (
    <Item key={`${entry.guest.id}:${entry.action.id}`} onClick={() => runCurrentSessionGuestAction(entry)}>
      <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="mr-1 size-4" />{entry.action.label}
    </Item>
  )), [guestSessionActionEntries, runCurrentSessionGuestAction]);

  const isCurrentSessionActive = currentSessionStatus?.type === 'busy' || currentSessionStatus?.type === 'retry';
  const moveCurrentSessionToWorktree = React.useCallback(() => {
    if (!currentSessionId || !sessionDirectory || isCurrentSessionActive || isCurrentSessionMovingToWorktree) return;
    const sessions = useGlobalSessionsStore.getState().activeSessions;
    const root = sessions.find((session) => session.id === currentSessionId);
    if (!root) return;

    const descendants: typeof sessions = [];
    const pendingParentIds = [currentSessionId];
    for (let index = 0; index < pendingParentIds.length; index += 1) {
      const parentId = pendingParentIds[index];
      for (const session of sessions) {
        if (session.parentID !== parentId) continue;
        descendants.push(session);
        pendingParentIds.push(session.id);
      }
    }

    requestSessionTreeMove({
      kind: 'quick',
      root,
      descendants,
      sourceDirectory: sessionDirectory,
      messages: buildSessionTreeMoveMessages(t, {
        success: 'sessions.sidebar.session.moveToWorktree.success',
        failure: 'sessions.sidebar.session.moveToWorktree.failed',
      }),
    });
  }, [currentSessionId, isCurrentSessionActive, isCurrentSessionMovingToWorktree, sessionDirectory, t]);

  // A chat promoted into a project: the same tree move as "Move to worktree",
  // with the project's root folder as the destination.
  const moveCurrentChatToProject = React.useCallback((projectDirectory: string) => {
    if (!currentSessionId || !sessionDirectory || isCurrentSessionActive || isCurrentSessionMovingToWorktree) return;
    const sessions = useGlobalSessionsStore.getState().activeSessions;
    const root = sessions.find((session) => session.id === currentSessionId);
    if (!root) return;
    const descendants: typeof sessions = [];
    const pendingParentIds = [currentSessionId];
    for (let index = 0; index < pendingParentIds.length; index += 1) {
      for (const session of sessions) {
        if (session.parentID !== pendingParentIds[index]) continue;
        descendants.push(session);
        pendingParentIds.push(session.id);
      }
    }
    requestSessionTreeMove({
      kind: 'project',
      root,
      descendants,
      sourceDirectory: sessionDirectory,
      projectDirectory,
      messages: buildSessionTreeMoveMessages(t, {
        success: 'sessions.moveChatToProject.success',
        failure: 'sessions.moveChatToProject.failed',
      }),
    });
  }, [currentSessionId, isCurrentSessionActive, isCurrentSessionMovingToWorktree, sessionDirectory, t]);

  const runHeaderRetentionAction = React.useCallback(async (action: 'archive' | 'delete', sessionId: string) => {
    const ids = [sessionId, ...collectSessionSubtreeIds(sessionId, [], action === 'delete')];
    const reopenId = useSessionUIStore.getState().currentSessionId === sessionId ? sessionId : null;
    if (action === 'delete') {
      const { failedIds } = await deleteSessions(ids);
      if (failedIds.length > 0) toast.error(t('sessions.sidebar.session.delete.error'));
      else toast.success(t('sessions.sidebar.session.delete.success'));
      return;
    }
    const { archivedIds, failedIds } = await archiveSessions(ids);
    if (failedIds.length > 0) {
      toast.error(t('sessions.sidebar.session.archive.error'));
      return;
    }
    toast.success(t('sessions.sidebar.session.archive.success'), archiveUndoToastOptions(archivedIds, reopenId, t));
  }, [archiveSessions, deleteSessions, t]);

  const confirmHeaderRetentionAction = React.useCallback(async () => {
    if (!pendingHeaderRetentionAction) return;
    const { action, sessionId } = pendingHeaderRetentionAction;
    setPendingHeaderRetentionAction(null);
    await runHeaderRetentionAction(action, sessionId);
  }, [pendingHeaderRetentionAction, runHeaderRetentionAction]);

  // Full-page surfaces (Scheduled, Archive, Worktrees, Spaces, run overview) replace the
  // chat area; while one is open the header shows the surface identity
  // instead of the session switcher.
  const openGuestPageId = useUIStore((state) => state.openGuestPageId);
  const guestPage = useGuestsStore((state) => state.guests.find((guest) => guest.id === openGuestPageId));
  const isScheduledSurfaceOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveSurfaceOpen = useUIStore((state) => state.isArchivePageOpen);
  const isUsageStatsSurfaceOpen = useUIStore((state) => state.isUsageStatsPageOpen);
  const isSourceBoardSurfaceOpen = useUIStore((state) => state.isSourceBoardOpen);
  const worktreesSurfaceProjectId = useUIStore((state) => state.worktreesPageProjectId);
  const spacesSurfaceProjectId = useUIStore((state) => (state.isolatedSpacesEnabled ? state.spacesPageProjectId : null));
  const runOverviewKey = useUIStore((state) => state.runOverviewKey);
  const overviewRunTitle = useMultiRunTitle(runOverviewKey);
  const surfaceProjectId = worktreesSurfaceProjectId ?? spacesSurfaceProjectId;
  const surfaceProjectLabel = useProjectsStore((state) => {
    if (!surfaceProjectId) return null;
    const project = state.projects.find((entry) => entry.id === surfaceProjectId);
    return project?.label?.trim() || project?.path?.split('/').pop() || null;
  });
  const activeSurfaceHeader = React.useMemo<{ title: string; subtitle: string | null } | null>(() => {
    if (guestPage) return { title: guestPage.pageTitle ?? guestPage.name, subtitle: null };
    if (isScheduledSurfaceOpen) {
      return { title: t('sessions.scheduledTasks.dialog.title'), subtitle: null };
    }
    if (isArchiveSurfaceOpen) {
      return { title: t('sessions.archivePage.title'), subtitle: null };
    }
    if (isUsageStatsSurfaceOpen) {
      return { title: t('usageStats.title'), subtitle: null };
    }
    if (isSourceBoardSurfaceOpen) {
      return { title: t('sourceBoard.title'), subtitle: null };
    }
    if (worktreesSurfaceProjectId) {
      return {
        title: t('sessions.worktreesPage.title', { project: surfaceProjectLabel ?? '' }),
        subtitle: null,
      };
    }
    if (spacesSurfaceProjectId) {
      return { title: t('spaces.page.title', { project: surfaceProjectLabel ?? '' }), subtitle: null };
    }
    if (runOverviewKey) {
      return { title: overviewRunTitle ?? t('multirun.overview.headerTitle'), subtitle: t('multirun.overview.headerTitle') };
    }
    return null;
  }, [guestPage, isArchiveSurfaceOpen, overviewRunTitle, runOverviewKey, isScheduledSurfaceOpen, isSourceBoardSurfaceOpen, isUsageStatsSurfaceOpen, spacesSurfaceProjectId, surfaceProjectLabel, t, worktreesSurfaceProjectId]);


  const planModeEnabled = useFeatureFlagsStore((state) => state.planModeEnabled);
  const isSessionPlanAvailable = useSessionUIStore((state) => state.isSessionPlanAvailable);
  const planTabAvailable = planModeEnabled && currentSessionId ? isSessionPlanAvailable(currentSessionId) : false;
  const lastPlanSessionKeyRef = React.useRef<string>('');

  // Reset plan tab availability when session changes
  React.useEffect(() => {
    if (!planModeEnabled) {
      return;
    }

    if (!currentSessionId) return;

    const sessionKey = `${currentSessionId || 'none'}:${sessionDirectory || 'none'}:${currentSession?.created || 0}:${currentSession?.slug || 'none'}`;
    if (lastPlanSessionKeyRef.current !== sessionKey) {
      lastPlanSessionKeyRef.current = sessionKey;
    }
  }, [
    planModeEnabled,
    planTabAvailable,
    currentSession?.slug,
    currentSession?.created,
    currentSessionId,
    sessionDirectory,
  ]);

  const currentSessionOpenDirectory = sessionDirectory || normalize(selectedSessionDirectory || '') || worktreeDirectory;

  const openSessionInMiniChat = React.useCallback((sessionId: string, directory: string) => {
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId,
      directory,
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[header] failed to open session mini chat window', error);
    });
  }, []);




  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;
  // Left padding the header needs to clear the OS window controls (macOS
  // traffic lights / window-controls-overlay). When the sidebar is open this
  // space is owned by the sidebar's top strip instead, so the header drops back
  // to its normal content padding. The full value is published as
  // `--oc-titlebar-left-inset` so the sidebar strip can mirror it.
  const titlebarLeftInset = React.useMemo(() => {
    if (isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) {
      // Native traffic lights have a fixed physical footprint. Keep this
      // clearance in pixels so shrinking the interface cannot overlap them.
      return '88px';
    }
    if (isTabletStandalonePwa) {
      return 'max(calc(0.75rem + var(--oc-wco-left-inset, 0px)), 5.5rem)';
    }
    if ((!isDesktopApp || usesFramelessChrome) && !isVSCode) {
      return 'calc(0.75rem + var(--oc-wco-left-inset, 0px))';
    }
    return '0.75rem';
  }, [isDesktopApp, isDesktopWindowFullscreen, isMacPlatform, isTabletStandalonePwa, isVSCode, usesFramelessChrome]);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.style.setProperty('--oc-titlebar-left-inset', titlebarLeftInset);
  }, [titlebarLeftInset]);

  // Space reserved on the header's left for the persistent overlay when the
  // sidebar is collapsed (the overlay sits over the header then). Split into two
  // spacers so the strip stays a window drag area while the buttons stay
  // clickable: a drag region for the window-controls inset (traffic lights) and
  // a no-drag carve under the control cluster. Both animate so the session title
  // slides in/out in lockstep with the sidebar. When the sidebar is open the
  // overlay is over the sidebar, so the header only keeps normal content padding.
  const headerInsetSpacerWidth = isSidebarOpen ? '0.75rem' : 'var(--oc-titlebar-left-inset, 0.75rem)';
  const headerControlsSpacerWidth = isSidebarOpen
    ? '0px'
    : 'calc(var(--oc-titlebar-controls-width, 5.5rem) + 0.5rem)';

  useEffect(() => {
    if (!isDesktopApp || !isMacPlatform) {
      setIsDesktopWindowFullscreen(false);
      return;
    }

    let disposed = false;

    const syncFullscreenState = async () => {
      try {
        const fullscreen = await invokeDesktop<boolean>('desktop_is_window_fullscreen');
        if (!disposed) {
          setIsDesktopWindowFullscreen(fullscreen === true);
        }
      } catch {
        if (!disposed) {
          setIsDesktopWindowFullscreen(false);
        }
      }
    };

    const onResize = () => {
      void syncFullscreenState();
    };

    void syncFullscreenState();
    window.addEventListener('openchamber:window-resized', onResize);

    return () => {
      disposed = true;
      window.removeEventListener('openchamber:window-resized', onResize);
    };
  }, [isDesktopApp, isMacPlatform]);

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-11';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  // Native window controls keep a fixed physical footprint, so their clearance
  // must be expressed in pixels. The interface font-size setting scales the
  // root rem unit, so a rem-based height floor collapses with it and lets
  // sidebar content slide underneath the macOS traffic lights. Mirrors the
  // pixel `--oc-titlebar-left-inset` above. macOS 26 centres its window
  // controls in 44px and macOS <= 15 in 56px (`macTrafficLightPosition` in the
  // Electron shell); `macosHeaderSizeClass` encodes the same heights.
  const titlebarMinHeight = React.useMemo(() => {
    if (isDesktopApp && isMacPlatform && !isDesktopWindowFullscreen) {
      return macosMajorVersion !== null && macosMajorVersion <= 15 ? '56px' : '44px';
    }
    return '0px';
  }, [isDesktopApp, isDesktopWindowFullscreen, isMacPlatform, macosMajorVersion]);

  const headerChromeStyle = React.useMemo<React.CSSProperties>(() => {
    // Height is owned by the native chrome floor plus the browser's
    // window-controls overlay. The rem term keeps the header growing with the
    // interface scale on runtimes that have no native controls to clear.
    // The macOS floor is a little lower so the 44px titlebar is not lifted
    // back to 3rem; it still grows with the interface scale past that.
    const remFloor = isDesktopApp && isMacPlatform ? '2.75rem' : '3rem';
    const height = `max(${remFloor}, ${titlebarMinHeight}, var(--oc-wco-titlebar-height, 0px))`;

    // VS Code and non-frameless desktop size their own header, and frameless
    // Electron with right-side controls keeps the pr-0 class and no inline
    // padding so the close button sits flush with the window corner.
    const sizesItsOwnHeader = (isDesktopApp && !usesFramelessChrome) || isVSCode;
    const rightEdgeOwnedByInWindowControls = usesFramelessChrome && windowControlsSide === 'right';

    if (sizesItsOwnHeader && titlebarMinHeight === '0px') {
      return {};
    }

    const style: React.CSSProperties = { minHeight: height, height };
    if (!sizesItsOwnHeader && !rightEdgeOwnedByInWindowControls) {
      // Left inset is handled by the no-drag spacer (see renderDesktop); only
      // the right inset is owned by the window-controls overlay.
      style.paddingRight = 'calc(0.75rem + var(--oc-wco-right-inset, 0px))';
    }
    return style;
  }, [isDesktopApp, isMacPlatform, isVSCode, titlebarMinHeight, usesFramelessChrome, windowControlsSide]);

  // Written on the root, where every element inherits it: written only when
  // the height changed, since a new value restyles the whole document.
  const publishedHeaderHeightRef = React.useRef<number | null>(null);
  const publishHeaderHeight = React.useCallback((height: number | undefined) => {
    if (!height || height === publishedHeaderHeightRef.current) {
      return;
    }
    publishedHeaderHeightRef.current = height;
    document.documentElement.style.setProperty('--oc-header-height', `${height}px`);
  }, []);
  const updateHeaderHeight = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }
    publishHeaderHeight(headerRef.current?.getBoundingClientRect().height);
  }, [publishHeaderHeight]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    updateHeaderHeight();

    const node = headerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return () => { };
    }

    let rafId = 0;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateHeaderHeight();
      });
    };

    // The header's width follows every sidebar animation frame; its height
    // comes from the observer entry, so those frames force no layout.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      publishHeaderHeight(entry?.borderBoxSize?.[0]?.blockSize ?? entry?.target.getBoundingClientRect().height);
    });

    observer.observe(node);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [publishHeaderHeight, updateHeaderHeight]);

  useEffect(() => {
    updateHeaderHeight();
  }, [updateHeaderHeight, isMobile, macosHeaderSizeClass]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);




  useKeybinds({
    rename_current_session: () => {
      if (!currentSessionId || isMobile) return false;
      beginHeaderSessionRename();
    },
    archive_current_session: () => {
      if (!currentSessionId || isMobile) return false;
      if (useGlobalSessionsStore.getState().entityById.get(currentSessionId)?.time.archived) return false;
      if (useUIStore.getState().showDeletionDialog) {
        setPendingHeaderRetentionAction({ action: 'archive', sessionId: currentSessionId });
        return;
      }
      void runHeaderRetentionAction('archive', currentSessionId);
    },
  });

  const desktopSidebarActions = (
    <>
      <SpaceApplyButton directory={openDirectory} className={cn(DESKTOP_HEADER_ICON_BUTTON_CLASS, 'text-muted-foreground hover:text-foreground')} iconClassName="h-4 w-4" />
      <SpaceAccessButton directory={openDirectory} className={cn(DESKTOP_HEADER_ICON_BUTTON_CLASS, 'text-muted-foreground hover:text-foreground')} iconClassName="h-4 w-4" />
    </>
  );


  const renderSessionTabMenu = React.useCallback(({ session, open, isActive, select, closeOtherTabs, components }: SessionTabMenuArgs) => {
    const { Item, Separator } = components;
    const canMoveToWorktree = isActive && !isVSCode && !isChatContext && currentSession && !currentSession.parentId;
    const canMoveToProject = isActive && !isVSCode && isChatContext && currentSession && !currentSession.parentId && hasProjects;
    return (
      <>
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.rename')}>
          <Item onClick={() => { if (!isActive) select(); pendingHeaderRenameRef.current = session.id; }}>
            <Icon name="pencil-ai" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.rename')}
          </Item>
        </SessionMenuItemHint>
        <SessionAiRenameMenuItem sessionID={session.id} directory={session.directory} open={open} Item={Item} />
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.copyId')}>
          <Item onClick={() => copySessionIdFor(session.id)}>
            <Icon name="file-copy" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.copyId')}
          </Item>
        </SessionMenuItemHint>
        <Separator />
        {isActive ? (
          <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.exportMarkdown')}>
            <Item onClick={() => void exportCurrentSession()}>
              <Icon name="download" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.exportMarkdown')}
            </Item>
          </SessionMenuItemHint>
        ) : null}
        {hasElectronDesktopIPC ? (
          <Item onClick={() => openSessionInMiniChat(session.id, isActive ? currentSessionOpenDirectory : session.directory ?? '')}>
            <Icon name="picture-in-picture-2" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.openInMiniChat')}
          </Item>
        ) : null}
        {isActive ? renderGuestSessionActionItems(Item) : null}
        {canMoveToWorktree ? (
          <SessionMenuItemHint hint={isCurrentSessionMovingToWorktree
            ? t('sessions.sidebar.session.moveToWorktree.tooltipMoving')
            : isCurrentSessionActive
              ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy')
              : t('sessions.sidebar.session.moveToWorktree.tooltip')}>
            <span className="block">
              <Item
                disabled={!sessionDirectory || isCurrentSessionActive || isCurrentSessionMovingToWorktree}
                onClick={moveCurrentSessionToWorktree}
                className="w-full"
              >
                <Icon name="folder-shared" className="mr-1 size-4" />
                {t('sessions.sidebar.session.menu.moveToWorktree')}
              </Item>
            </span>
          </SessionMenuItemHint>
        ) : null}
        {canMoveToProject ? (
          <SessionMenuItemHint hint={isCurrentSessionActive
            ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy')
            : t('sessions.moveChatToProject.hint')}>
            <span className="block">
              <Item
                disabled={!sessionDirectory || isCurrentSessionActive || isCurrentSessionMovingToWorktree}
                onClick={() => setMoveChatDialogOpen(true)}
                className="w-full"
              >
                <Icon name="folder-shared" className="mr-1 size-4" />
                {t('sessions.moveChatToProject.menu')}
              </Item>
            </span>
          </SessionMenuItemHint>
        ) : null}
        <Separator />
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.closeOtherTabs')}>
          <Item onClick={closeOtherTabs}>
            <Icon name="close-circle" className="mr-1 size-4" />{t('header.sessionTabs.closeOtherTabs')}
          </Item>
        </SessionMenuItemHint>
        <Separator />
        <HeaderSessionArchiveMenuItem
          sessionId={session.id}
          Item={Item}
          onArchive={() => setPendingHeaderRetentionAction({ action: 'archive', sessionId: session.id })}
        />
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.delete')}>
          <Item className="text-destructive focus:text-destructive" onClick={() => setPendingHeaderRetentionAction({ action: 'delete', sessionId: session.id })}>
            <Icon name="delete-bin" className="mr-1 size-4" />{t('sessions.sidebar.bulkActions.delete')}
          </Item>
        </SessionMenuItemHint>
      </>
    );
  }, [copySessionIdFor, currentSession, currentSessionOpenDirectory, exportCurrentSession, hasElectronDesktopIPC, hasProjects, isChatContext, isCurrentSessionActive, isCurrentSessionMovingToWorktree, isVSCode, moveCurrentSessionToWorktree, openSessionInMiniChat, renderGuestSessionActionItems, sessionDirectory, t]);

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 select-none items-center',
        usesFramelessChrome && windowControlsSide === 'right' ? 'pr-0' : 'pr-3',
        macosHeaderSizeClass
      )}
      style={headerChromeStyle}
      role="tablist"
      aria-label={t('header.navigation.mainAria')}
    >
      {/* Drag region for the window-controls inset (traffic lights) to the left
          of the overlay buttons — stays a window drag area. */}
      <div
        aria-hidden
        className="shrink-0 self-stretch transition-[width] duration-[120ms] ease-out motion-reduce:transition-none"
        style={{ width: headerInsetSpacerWidth }}
      />
      {/* No-drag carve under the persistent TitlebarLeftControls overlay so its
          buttons stay clickable. Width animates with the sidebar so the session
          title slides in lockstep instead of snapping. */}
      <div
        ref={titlebarControlsWidthReaderRef}
        aria-hidden
        className="app-region-no-drag shrink-0 self-stretch transition-[width] duration-[120ms] ease-out motion-reduce:transition-none"
        style={{ width: headerControlsSpacerWidth }}
      />
      {/* Sidebar toggle + project actions live in the persistent
          TitlebarLeftControls overlay; the spacers above reserve its footprint
          while the sidebar is closed. */}
      <div className="flex min-w-0 flex-1 items-center">
        {activeSurfaceHeader ? (
          <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="app-region-no-drag mr-1 size-6 text-muted-foreground hover:bg-transparent hover:text-foreground"
                aria-label={t('header.mainSurface.backToChat')}
                onClick={() => useUIStore.getState().closeMainSurfaces()}
              >
                <Icon name="arrow-left" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('header.mainSurface.backToChat')}</TooltipContent>
          </Tooltip>
          <div className="mr-3 flex min-w-0 flex-col items-start px-1 py-0.5 -my-0.5 text-left">
            <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
              {activeSurfaceHeader.title}
            </span>
            {activeSurfaceHeader.subtitle ? (
              <span className="truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75 max-w-full">
                {activeSurfaceHeader.subtitle}
              </span>
            ) : null}
          </div>
          </>
        ) : (isVSCode || !sessionTabsEnabled) ? (
          <div className="app-region-no-drag mr-3 flex min-w-0 max-w-full items-center gap-0.5 py-0.5 -my-0.5 text-left">
            {isCurrentSessionAiRenaming ? <Icon name="loader-4" className="mr-1 size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} /> : null}
            {!isSidebarOpen ? (
              <SessionSwitcherDropdown align="start">
                <button
                  type="button"
                  className={desktopHeaderIconButtonClass}
                  aria-label={t('sessions.switcher.openAria')}
                >
                  <Icon name="history" className="h-4 w-4" />
                </button>
              </SessionSwitcherDropdown>
            ) : null}
            <div className="flex min-w-0 flex-col justify-center px-1">
              {isRenamingHeaderSession ? (
                <form
                  ref={headerRenameFormRef}
                  className="flex w-full min-w-0 items-center gap-2 leading-tight"
                  onPointerDown={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveHeaderSessionRename();
                  }}
                >
                  <input
                    ref={focusHeaderRenameInput}
                    value={headerSessionTitleDraft}
                    onChange={(event) => setHeaderSessionTitleDraft(event.target.value)}
                    onKeyDown={(event) => handleSessionRenameKeyDown(event, () => setIsRenamingHeaderSession(false))}
                    placeholder={t('sessions.sidebar.session.menu.rename')}
                    className="min-w-0 flex-1 bg-transparent typography-ui-label text-[14px] font-normal leading-tight outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="submit"
                    aria-label={t('sessions.sidebar.session.rename.save')}
                    title={t('sessions.sidebar.session.rename.save')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsRenamingHeaderSession(false)}
                    aria-label={t('sessions.sidebar.session.rename.cancel')}
                    title={t('sessions.sidebar.session.rename.cancel')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </form>
              ) : isNewSessionDraftOpen ? null : (
                <span dir="auto" className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
                  {currentSessionTitle}
                </span>
              )}
              {showHeaderMetaRow ? (
                // A draft has no title of its own, so its project and branch
                // are the title: title-sized, not a caption under nothing.
                <span className={cn(
                  'flex min-w-0 max-w-full items-center gap-1.5 truncate font-normal leading-tight',
                  isNewSessionDraftOpen
                    ? 'typography-ui-label text-[14px] text-foreground'
                    : 'typography-micro text-[10.5px] text-muted-foreground/75',
                )}>
                  {activeProjectLabel ? <span className="truncate">{activeProjectLabel}</span> : null}
                  {currentBranchLabel ? (
                    <span className="inline-flex min-w-0 items-center gap-0.5">
                      <Icon name="git-branch" className={cn('flex-shrink-0 text-muted-foreground/70', isNewSessionDraftOpen ? 'h-3.5 w-3.5' : 'h-3 w-3')} />
                      <span className={cn('truncate', isNewSessionDraftOpen && 'text-muted-foreground')}>{currentBranchLabel}</span>
                    </span>
                  ) : null}
                  {!isNewSessionDraftOpen && worktreeBadgeKind ? (
                    <span className={cn(
                      "inline-flex min-w-0 items-center gap-0.5",
                      worktreeBadgeKind === 'attention' || worktreeBadgeKind === 'invalid' || worktreeBadgeKind === 'missing' ? 'text-status-warning' : 'text-muted-foreground/60'
                    )}>
                      <Icon name="alert" className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate">{worktreeBadge}</span>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className={cn(
              'flex h-[18px] shrink-0 items-center justify-center',
              // Top-aligned only when the title has a metadata line under it;
              // alone, the title is centred and the button must follow.
              showHeaderMetaRow ? 'self-start' : 'self-center',
            )}>
              {currentSessionId && !isNewSessionDraftOpen && !isRenamingHeaderSession ? (
                <DropdownMenu
                  open={isHeaderSessionMenuOpen}
                  onOpenChange={setIsHeaderSessionMenuOpen}
                  onOpenChangeComplete={(open) => {
                    if (!open && pendingHeaderRenameRef.current && pendingHeaderRenameRef.current === currentSessionId) {
                      pendingHeaderRenameRef.current = null;
                      beginHeaderSessionRename();
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="xs" className="h-[18px] w-6 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" aria-label={t('header.sessionActions.openAria')}>
                      <Icon name="more" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[190px]">
                    <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.rename')}><DropdownMenuItem onClick={() => { pendingHeaderRenameRef.current = currentSessionId; }}><Icon name="pencil-ai" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.rename')}</DropdownMenuItem></SessionMenuItemHint>
                    <SessionAiRenameMenuItem sessionID={currentSessionId} directory={sessionDirectory} open={isHeaderSessionMenuOpen} Item={DropdownMenuItem} />
                    <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.copyId')}><DropdownMenuItem onClick={() => currentSessionId && copySessionIdFor(currentSessionId)}><Icon name="file-copy" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.copyId')}</DropdownMenuItem></SessionMenuItemHint>
                    <DropdownMenuSeparator />
                    <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.exportMarkdown')}><DropdownMenuItem onClick={() => void exportCurrentSession()}><Icon name="download" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.exportMarkdown')}</DropdownMenuItem></SessionMenuItemHint>
                    {hasElectronDesktopIPC ? (
                      <DropdownMenuItem onClick={() => openSessionInMiniChat(currentSessionId, currentSessionOpenDirectory)}>
                        <Icon name="picture-in-picture-2" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.openInMiniChat')}
                      </DropdownMenuItem>
                    ) : null}
                    {renderGuestSessionActionItems(DropdownMenuItem)}
                    {!isVSCode && !isChatContext && currentSession && !currentSession.parentId ? (
                      <SessionMenuItemHint hint={isCurrentSessionMovingToWorktree
                        ? t('sessions.sidebar.session.moveToWorktree.tooltipMoving')
                        : isCurrentSessionActive
                          ? t('sessions.sidebar.session.moveToWorktree.tooltipBusy')
                          : t('sessions.sidebar.session.moveToWorktree.tooltip')}>
                        <span className="block">
                          <DropdownMenuItem
                            disabled={!sessionDirectory || isCurrentSessionActive || isCurrentSessionMovingToWorktree}
                            onClick={moveCurrentSessionToWorktree}
                            className="w-full"
                          >
                            <Icon name="folder-shared" className="mr-1 size-4" />
                            {t('sessions.sidebar.session.menu.moveToWorktree')}
                          </DropdownMenuItem>
                        </span>
                      </SessionMenuItemHint>
                    ) : null}
                    <DropdownMenuSeparator />
                    <HeaderSessionArchiveMenuItem
                      sessionId={currentSessionId}
                      Item={DropdownMenuItem}
                      onArchive={() => setPendingHeaderRetentionAction({ action: 'archive', sessionId: currentSessionId })}
                    />
                    <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.delete')}><DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => { if (currentSessionId) setPendingHeaderRetentionAction({ action: 'delete', sessionId: currentSessionId }); }}><Icon name="delete-bin" className="mr-1 size-4" />{t('sessions.sidebar.bulkActions.delete')}</DropdownMenuItem></SessionMenuItemHint>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex h-full min-w-0 flex-1 items-center gap-0.5 text-left">
            {/* No session switcher here: with the sidebar closed the tabs are
                the switcher, and a history button beside them said it twice. */}
            <SessionTabsStrip
              renderMenu={renderSessionTabMenu}
              suppressActiveTabControls={isRenamingHeaderSession}
              onMenuOpenChangeComplete={(open) => {
                if (!open && pendingHeaderRenameRef.current && pendingHeaderRenameRef.current === currentSessionId) {
                  pendingHeaderRenameRef.current = null;
                  beginHeaderSessionRename();
                }
              }}
            >
            <div className="flex min-w-0 flex-col justify-center">
              {isRenamingHeaderSession ? (
                <form
                  ref={headerRenameFormRef}
                  className="flex w-full min-w-0 items-center gap-2 leading-tight"
                  onPointerDown={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveHeaderSessionRename();
                  }}
                >
                  <input
                    ref={focusHeaderRenameInput}
                    value={headerSessionTitleDraft}
                    onChange={(event) => setHeaderSessionTitleDraft(event.target.value)}
                    onKeyDown={(event) => handleSessionRenameKeyDown(event, () => setIsRenamingHeaderSession(false))}
                    placeholder={t('sessions.sidebar.session.menu.rename')}
                    className="min-w-0 flex-1 bg-transparent text-[13px] font-medium leading-4 outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="submit"
                    aria-label={t('sessions.sidebar.session.rename.save')}
                    title={t('sessions.sidebar.session.rename.save')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsRenamingHeaderSession(false)}
                    aria-label={t('sessions.sidebar.session.rename.cancel')}
                    title={t('sessions.sidebar.session.rename.cancel')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </form>
              ) : (
                <span dir="auto" className="block overflow-hidden whitespace-nowrap text-left text-[13px] font-medium leading-4 text-foreground max-w-full">
                  {isNewSessionDraftOpen ? t('sessions.switcher.draftTitle') : currentSessionTitle}
                </span>
              )}
            </div>
            </SessionTabsStrip>
          </div>
        )}

        {activeSurfaceHeader || isVSCode || !sessionTabsEnabled ? <div className="flex-1" /> : null}

        {/* Spacing comes from the gap only, so whichever control ends up last
            sits on the header's own right padding with no trailing margin. */}
        <div className="flex shrink-0 items-center gap-2">
          {!isVSCode ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  data-work-status-toggle="true"
                  aria-pressed={workStatusToggleActive}
                  aria-label={t('header.workStatusPanel.toggleAria')}
                  onClick={handleWorkStatusToggle}
                  className={cn(
                    DESKTOP_HEADER_ICON_BUTTON_CLASS,
                    // On is the resting state and carries no chrome; off is the
                    // one worth signalling, so it dims instead of filling.
                    workStatusToggleActive ? 'text-foreground' : 'text-muted-foreground/50',
                  )}
                >
                  <Icon name="list-indefinite" className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {workStatusPanelEnabled && !workStatusPanelFits
                  ? (workStatusOverlayOpen
                    ? t('header.workStatusPanel.hide')
                    : t('header.workStatusPanel.showOverlay'))
                  : workStatusPanelEnabled
                    ? t('header.workStatusPanel.hide')
                    : t('header.workStatusPanel.show')}
              </TooltipContent>
            </Tooltip>
          ) : null}

          {desktopSidebarActions}
          <WindowsWindowControls visible={usesFramelessChrome && windowControlsSide === 'right'} position="right" />
        </div>
      </div>
    </div>
  );

  // No divider under the header: it, the chat and the window read as one
  // surface, and the context panel separates itself as a framed card.
  const headerClassName = 'header-safe-area relative z-10 bg-background';

  return (
    <>
      <header
        ref={headerRef}
        className={headerClassName}
        style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
      >
        {renderDesktop()}
      </header>
      <MoveChatToProjectDialog
        open={moveChatDialogOpen}
        onOpenChange={setMoveChatDialogOpen}
        onPick={moveCurrentChatToProject}
      />
      <Dialog open={pendingHeaderRetentionAction !== null} onOpenChange={(open) => { if (!open) setPendingHeaderRetentionAction(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{pendingHeaderRetentionAction?.action === 'delete'
              ? t('sessions.sidebar.dialogs.deleteSession.title')
              : t('sessions.sidebar.dialogs.archiveSession.title')}</DialogTitle>
            <DialogDescription>{pendingHeaderRetentionAction?.action === 'delete'
              ? t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: currentSessionTitle })
              : t('sessions.sidebar.dialogs.archiveSession.single', { sessionTitle: currentSessionTitle })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingHeaderRetentionAction(null)}>
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmHeaderRetentionAction()}>
              {pendingHeaderRetentionAction?.action === 'delete'
                ? t('sessions.sidebar.bulkActions.delete')
                : t('sessions.sidebar.bulkActions.archive')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
