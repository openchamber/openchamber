import React, { useEffect } from 'react';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { useGuestsStore } from '@/lib/guests/store';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { formatSessionWorktreeBadge } from '@/sync/session-worktree-contract';
import { useDirectoryStore as useAppDirectoryStore } from '@/stores/useDirectoryStore';
import { isChatDirectoryForHome } from '@/lib/chatDirectories';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { archiveUndoToastOptions, collectSessionSubtreeIds } from '@/components/session/sidebar/sessions/sessionSubtreeActions';
import { streamPerfCount } from '@/stores/utils/streamDebug';

import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { useDeviceInfo, useTabletStandalonePwaRuntime } from '@/lib/device';
import { cn } from '@/lib/utils';
import { useKeybinds } from '@/hooks/useKeybind';

import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { SessionSwitcherDropdown } from '@/components/session/SessionSwitcherDropdown';
import { SessionTabsStrip, type SessionTabMenuArgs } from './SessionTabsStrip';
import { SessionMenuItemHint } from '@/components/session/SessionMenuItemHint';
import { MoveSessionDialog } from '@/components/session/MoveSessionDialog';
import { HeaderSessionActionsMenuItems } from './HeaderSessionActionsMenuItems';
import { dropdownSessionMenuSlots } from '@/components/session/sidebar/sessions/sessionMenuSlots';
import { useSessionMarkdownExport } from '@/components/session/sidebar/sessions/useSessionMarkdownExport';
import { HeaderContextUsage } from './HeaderContextUsage';
import { HeaderProjectControls } from './HeaderProjectControls';
import { canUseElectronDesktopIPC, getMiniChatRuntimeArgs, invokeDesktop, isDesktopShell, isVSCodeRuntime, startDesktopWindowDrag } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { getInlineStartSide, useI18n } from '@/lib/i18n';
import { useShallow } from 'zustand/react/shallow';
import { toast } from '@/components/ui';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { useIsSessionAiRenamePending } from '@/sync/use-session-ai-rename';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useMultiRunTitle } from '@/lib/multirun/useMultiRuns';
import { titlebarControlsWidthReaderRef } from './titlebarControlsWidth';
import { useLayoutAnimationMs } from '@/hooks/useLayoutAnimationMs';
import { LAYOUT_ANIMATION_EASING } from '@/lib/layoutAnimation';
import { findWorktreeHoldingDirectory } from '@/lib/worktrees/worktreePaths';

// Like the icon rail: muted at rest, full strength on hover, while its menu is
// open or while what it controls is on, and no hover fill.
const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-6 w-6 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-muted-foreground hover:text-foreground data-[popup-open]:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 transition-colors';


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
};

export const Header: React.FC = () => {
  streamPerfCount('ui.header.render');
  const { t, direction } = useI18n();
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  // The spacers move with the sidebar, so they follow its animation setting.
  const layoutAnimationMs = useLayoutAnimationMs();
  const sessionTabsEnabled = useUIStore((state) => state.sessionTabsEnabled);

  const isNewSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
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
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
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
  const draftProjectId = useSessionUIStore((state) => state.newSessionDraft.selectedProjectId);
  const selectedSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const homeDirectory = useAppDirectoryStore((state) => state.homeDirectory);

  // A draft waiting for a new space shows the space's branch and actions once it runs, and none
  // of this computer's while it is made.
  const draftSpace = useDraftSpaceTarget();
  const openDirectory = React.useMemo(() => {
    return worktreeDirectory || sessionDirectory || (panelContentDirectory(draftSpace, draftDirectory) ?? '');
  }, [draftDirectory, draftSpace, sessionDirectory, worktreeDirectory]);

  const catalogWorktreeBranch = useSessionUIStore((state) => {
    const candidateDirectory = normalize(worktreeDirectory || sessionDirectory || '');
    if (!candidateDirectory) {
      return null;
    }

    for (const worktrees of state.availableWorktreesByProject.values()) {
      const match = findWorktreeHoldingDirectory(worktrees, candidateDirectory);
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
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const [isRenamingHeaderSession, setIsRenamingHeaderSession] = React.useState(false);
  const [isHeaderSessionMenuOpen, setIsHeaderSessionMenuOpen] = React.useState(false);
  /** Session id whose rename was requested from a tab menu; survives the
      activation that a Rename on an inactive tab performs first. */
  const pendingHeaderRenameRef = React.useRef<string | null>(null);
  const [headerSessionTitleDraft, setHeaderSessionTitleDraft] = React.useState('');
  const [moveSessionTarget, setMoveSessionTarget] = React.useState<{ sessionId: string; directory: string } | null>(null);
  const sessionExport = useSessionMarkdownExport();
  // Archive runs at once with Undo in its toast, as in the sidebar; only a
  // delete asks first.
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = React.useState<string | null>(null);
  const pendingDeleteSessionTitle = useGlobalSessionsStore((state) => (pendingDeleteSessionId
    ? state.entityById.get(pendingDeleteSessionId)?.title?.trim() || null
    : null)) ?? t('sessions.sidebar.session.untitled');
  const headerRenameFormRef = React.useRef<HTMLFormElement | null>(null);
  // Set as the rename starts, before the field renders: a tab menu closing in
  // the same pass must leave the focus to the field.
  const headerRenameOpenRef = React.useRef(false);
  headerRenameOpenRef.current = isRenamingHeaderSession;


  const beginHeaderSessionRename = React.useCallback(() => {
    if (!currentSessionId) return;
    headerRenameOpenRef.current = true;
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
    setPendingDeleteSessionId(null);
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

  const confirmHeaderDelete = React.useCallback(async () => {
    if (!pendingDeleteSessionId) return;
    setPendingDeleteSessionId(null);
    await runHeaderRetentionAction('delete', pendingDeleteSessionId);
  }, [pendingDeleteSessionId, runHeaderRetentionAction]);

  // Full-page surfaces (Scheduled, Archive, Worktrees, Spaces, run overview) replace the
  // chat area; while one is open the header shows the surface identity
  // instead of the session switcher.
  const openGuestPageId = useUIStore((state) => state.openGuestPageId);
  const guestPage = useGuestsStore((state) => state.guests.find((guest) => guest.id === openGuestPageId));
  const isScheduledSurfaceOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveSurfaceOpen = useUIStore((state) => state.isArchivePageOpen);
  const isIntegrationsCatalogSurfaceOpen = useUIStore((state) => state.isIntegrationsCatalogOpen);
  const isUsageStatsSurfaceOpen = useUIStore((state) => state.isUsageStatsPageOpen);
  const isSourceBoardSurfaceOpen = useUIStore((state) => state.isSourceBoardOpen);
  const isOverviewSurfaceOpen = useUIStore((state) => state.isOverviewOpen);
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
    if (isIntegrationsCatalogSurfaceOpen) {
      return { title: t('integrationsCatalog.page.title'), subtitle: null };
    }
    if (isUsageStatsSurfaceOpen) {
      return { title: t('usageStats.title'), subtitle: null };
    }
    if (isSourceBoardSurfaceOpen) {
      return { title: t('sourceBoard.title'), subtitle: null };
    }
    if (isOverviewSurfaceOpen) {
      return { title: t('overview.title'), subtitle: null };
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
  }, [guestPage, isArchiveSurfaceOpen, isIntegrationsCatalogSurfaceOpen, overviewRunTitle, runOverviewKey, isScheduledSurfaceOpen, isSourceBoardSurfaceOpen, isOverviewSurfaceOpen, isUsageStatsSurfaceOpen, spacesSurfaceProjectId, surfaceProjectLabel, t, worktreesSurfaceProjectId]);


  // The header's Mini Chat button opens whatever is on screen: the new-session
  // draft as a new Mini Chat, or the current session.
  const handleOpenDraftMiniChat = React.useCallback(() => {
    void invokeDesktop('desktop_open_draft_mini_chat_window', {
      directory: isChatContext ? '' : draftDirectory,
      projectId: isChatContext ? null : draftProjectId,
      ...getMiniChatRuntimeArgs(),
    }).catch((error) => {
      console.warn('[header] failed to open draft mini chat window', error);
    });
  }, [draftDirectory, draftProjectId, isChatContext]);

  const handleOpenCurrentMiniChat = React.useCallback(() => {
    if (isNewSessionDraftOpen) {
      handleOpenDraftMiniChat();
      return;
    }
    if (!currentSessionId) {
      return;
    }
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: currentSessionId,
      directory: sessionDirectory || normalize(selectedSessionDirectory || '') || worktreeDirectory,
      ...getMiniChatRuntimeArgs(),
    }).catch((error) => {
      console.warn('[header] failed to open session mini chat window', error);
    });
  }, [currentSessionId, handleOpenDraftMiniChat, isNewSessionDraftOpen, selectedSessionDirectory, sessionDirectory, worktreeDirectory]);
  const showMiniChatHeaderAction = hasElectronDesktopIPC && (isNewSessionDraftOpen || Boolean(currentSessionId));





  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;
  // Clearance for the OS window controls (macOS traffic lights /
  // window-controls-overlay) on each physical edge of the window. Those
  // controls never mirror, while the layout does: in a right-to-left locale the
  // sidebar sits on the right, so the left clearance moves to the header's end.
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
  // 10px, as the header's pe-2.5: the last 24px button's centre sits 22px
  // from the window edge, on the axis of the 44px icon rail below it. 12px
  // here put it 2px off that axis.
  const titlebarRightInset = (!isDesktopApp || usesFramelessChrome) && !isVSCode
    ? 'calc(0.625rem + var(--oc-wco-right-inset, 0px))'
    : '0.625rem';
  const isRtl = direction === 'rtl';
  // The edge the persistent TitlebarLeftControls overlay starts from. When the
  // sidebar is open this space is owned by the sidebar's top strip, so the header
  // drops back to its normal content padding there. Published as
  // `--oc-titlebar-start-inset` so the overlay and the sidebar strip share it.
  const titlebarStartInset = isRtl ? titlebarRightInset : titlebarLeftInset;
  const titlebarEndInset = isRtl ? titlebarLeftInset : titlebarRightInset;
  // Frameless in-window controls render on their physical side: in the overlay
  // cluster when that side is where the line starts, at the header's end otherwise.
  const endEdgeOwnedByInWindowControls = usesFramelessChrome && windowControlsSide !== getInlineStartSide(direction);

  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    document.documentElement.style.setProperty('--oc-titlebar-start-inset', titlebarStartInset);
  }, [titlebarStartInset]);

  // Space reserved at the header's start for the persistent overlay when the
  // sidebar is collapsed (the overlay sits over the header then). Split into two
  // spacers so the strip stays a window drag area while the buttons stay
  // clickable: a drag region for the window-controls inset (traffic lights) and
  // a no-drag carve under the control cluster. Both animate so the session title
  // slides in/out in lockstep with the sidebar. When the sidebar is open the
  // overlay is over the sidebar, so the header only keeps normal content padding.
  const headerInsetSpacerWidth = isSidebarOpen ? '0.75rem' : 'var(--oc-titlebar-start-inset, 0.75rem)';
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
  // pixel left inset above. macOS 26 centres its window
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
    // Electron with controls at the header's end keeps the pe-0 class and no
    // inline padding so the close button sits flush with the window corner.
    const sizesItsOwnHeader = (isDesktopApp && !usesFramelessChrome) || isVSCode;

    if (sizesItsOwnHeader && titlebarMinHeight === '0px') {
      return {};
    }

    const style: React.CSSProperties = { minHeight: height, height };
    // The start inset is handled by the no-drag spacer (see renderDesktop). The
    // end inset clears the window-controls overlay, and in a right-to-left
    // layout also the macOS traffic lights, which stay on the left.
    if (!endEdgeOwnedByInWindowControls && (!sizesItsOwnHeader || isRtl)) {
      style.paddingInlineEnd = titlebarEndInset;
    }
    return style;
  }, [endEdgeOwnedByInWindowControls, isDesktopApp, isMacPlatform, isRtl, isVSCode, titlebarEndInset, titlebarMinHeight, usesFramelessChrome]);

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
      void runHeaderRetentionAction('archive', currentSessionId);
    },
  });


  const requestSessionMove = React.useCallback((sessionId: string, directory: string) => {
    setMoveSessionTarget({ sessionId, directory });
  }, []);
  const exportSession = sessionExport.requestExport;

  const renderSessionTabMenu = React.useCallback(({ session, open, isActive, select, closeOtherTabs, components }: SessionTabMenuArgs) => {
    const { Item, Separator } = components;
    return (
      <>
        <SessionMenuItemHint hint={t('sessions.sidebar.session.menuHint.closeOtherTabs')}>
          <Item onClick={closeOtherTabs} className="[&>svg]:me-1">
            <Icon name="close-circle" className="me-1 h-4 w-4" />{t('header.sessionTabs.closeOtherTabs')}
          </Item>
        </SessionMenuItemHint>
        <Separator />
        <HeaderSessionActionsMenuItems
          sessionId={session.id}
          open={open}
          slots={components}
          onRename={() => { if (!isActive) select(); pendingHeaderRenameRef.current = session.id; }}
          onExport={exportSession}
          onMoveSession={requestSessionMove}
          onArchive={() => void runHeaderRetentionAction('archive', session.id)}
          onDelete={() => setPendingDeleteSessionId(session.id)}
        />
      </>
    );
  }, [exportSession, requestSessionMove, runHeaderRetentionAction, t]);

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-12 select-none items-center',
        // 10 px puts the last 24 px button's centre 22 px from the window edge,
        // on the axis of the 44 px icon rail below it.
        endEdgeOwnedByInWindowControls ? 'pe-0' : 'pe-2.5',
        macosHeaderSizeClass
      )}
      style={headerChromeStyle}
      role="tablist"
      aria-label={t('header.navigation.mainAria')}
    >
      {/* Drag region for the window-controls inset before the overlay buttons;
          stays a window drag area. */}
      <div
        aria-hidden
        className="shrink-0 self-stretch transition-[width] motion-reduce:transition-none"
        style={{ width: headerInsetSpacerWidth, transitionDuration: `${layoutAnimationMs}ms`, transitionTimingFunction: LAYOUT_ANIMATION_EASING }}
      />
      {/* No-drag carve under the persistent TitlebarLeftControls overlay so its
          buttons stay clickable. Width animates with the sidebar so the session
          title slides in lockstep instead of snapping. */}
      <div
        ref={titlebarControlsWidthReaderRef}
        aria-hidden
        className="app-region-no-drag shrink-0 self-stretch transition-[width] motion-reduce:transition-none"
        style={{ width: headerControlsSpacerWidth, transitionDuration: `${layoutAnimationMs}ms`, transitionTimingFunction: LAYOUT_ANIMATION_EASING }}
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
                className="app-region-no-drag me-1 size-6 text-muted-foreground hover:bg-transparent hover:text-foreground"
                aria-label={t('header.mainSurface.backToChat')}
                onClick={() => useUIStore.getState().closeMainSurfaces()}
              >
                <Icon name="arrow-left" className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('header.mainSurface.backToChat')}</TooltipContent>
          </Tooltip>
          <div className="me-3 flex min-w-0 flex-col items-start px-1 py-0.5 -my-0.5 text-start">
            <span className="truncate typography-ui-label text-[0.875rem] font-normal leading-tight text-foreground max-w-full">
              {activeSurfaceHeader.title}
            </span>
            {activeSurfaceHeader.subtitle ? (
              <span className="truncate typography-micro text-[0.65625rem] font-normal leading-tight text-muted-foreground max-w-full">
                {activeSurfaceHeader.subtitle}
              </span>
            ) : null}
          </div>
          </>
        ) : (isVSCode || !sessionTabsEnabled) ? (
          <div className="app-region-no-drag me-3 flex min-w-0 max-w-full items-center gap-0.5 py-0.5 -my-0.5 text-start">
            {isCurrentSessionAiRenaming ? <Icon name="loader-4" className="me-1 size-3 shrink-0 animate-spin text-primary" aria-label={t('sessions.aiRename.generating')} /> : null}
            {!isSidebarOpen ? (
              <Tooltip>
              <SessionSwitcherDropdown align="start">
                <TooltipTrigger asChild>
                <button
                  type="button"
                  className={desktopHeaderIconButtonClass}
                  aria-label={t('sessions.switcher.openAria')}
                >
                  <Icon name="history" className="h-4 w-4" />
                </button>
                </TooltipTrigger>
              </SessionSwitcherDropdown>
              <TooltipContent side="bottom"><TooltipLabelWithShortcut label={t('sessions.switcher.openAria')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('open_session_list', shortcutOverrides), '')} /></TooltipContent>
              </Tooltip>
            ) : null}
            <div className="flex min-w-0 flex-col justify-center px-1">
              {isRenamingHeaderSession ? (
                <form
                  ref={headerRenameFormRef}
                  data-session-rename-form="header"
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
                    className="min-w-0 flex-1 bg-transparent typography-ui-label text-[0.875rem] font-normal leading-tight outline-none placeholder:text-muted-foreground"
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
                <span dir="auto" className="oc-ui-start-align truncate typography-ui-label text-[0.875rem] font-normal leading-tight text-foreground max-w-full">
                  {currentSessionTitle}
                </span>
              )}
              {showHeaderMetaRow ? (
                // A draft has no title of its own, so its project and branch
                // are the title: title-sized, not a caption under nothing.
                <span className={cn(
                  'flex min-w-0 max-w-full items-center gap-1.5 truncate font-normal leading-tight',
                  isNewSessionDraftOpen
                    ? 'typography-ui-label text-[0.875rem] text-foreground'
                    : 'typography-micro text-[0.65625rem] text-muted-foreground',
                )}>
                  {activeProjectLabel ? <span dir="auto" className="truncate">{activeProjectLabel}</span> : null}
                  {currentBranchLabel ? (
                    <span className="inline-flex min-w-0 items-center gap-0.5">
                      <Icon name="git-branch" className={cn('flex-shrink-0 text-muted-foreground', isNewSessionDraftOpen ? 'h-3.5 w-3.5' : 'h-3 w-3')} />
                      <span dir="ltr" className={cn('truncate', isNewSessionDraftOpen && 'text-muted-foreground')}>{currentBranchLabel}</span>
                    </span>
                  ) : null}
                  {!isNewSessionDraftOpen && worktreeBadgeKind ? (
                    <span className={cn(
                      "inline-flex min-w-0 items-center gap-0.5",
                      worktreeBadgeKind === 'attention' || worktreeBadgeKind === 'invalid' || worktreeBadgeKind === 'missing' ? 'text-status-warning' : 'text-muted-foreground'
                    )}>
                      <Icon name="alert" className="h-3 w-3 flex-shrink-0" />
                      <span className="truncate">{worktreeBadge}</span>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className={cn(
              'flex h-[1.125rem] shrink-0 items-center justify-center',
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
                    <Button variant="ghost" size="xs" className="h-[1.125rem] w-6 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" aria-label={t('header.sessionActions.openAria')}>
                      <Icon name="more" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[190px]">
                    <HeaderSessionActionsMenuItems
                      sessionId={currentSessionId}
                      open={isHeaderSessionMenuOpen}
                      slots={dropdownSessionMenuSlots}
                      onRename={() => { pendingHeaderRenameRef.current = currentSessionId; }}
                      onExport={exportSession}
                      onMoveSession={requestSessionMove}
                      onArchive={() => void runHeaderRetentionAction('archive', currentSessionId)}
                      onDelete={() => setPendingDeleteSessionId(currentSessionId)}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="flex h-full min-w-0 flex-1 items-center gap-0.5 text-start">
            {/* No session switcher here: with the sidebar closed the tabs are
                the switcher, and a history button beside them said it twice. */}
            <SessionTabsStrip
              renderMenu={renderSessionTabMenu}
              suppressActiveTabControls={isRenamingHeaderSession}
              menuReturnsFocus={() => !headerRenameOpenRef.current}
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
                  data-session-rename-form="header"
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
                    className="min-w-0 flex-1 bg-transparent text-[0.8125rem] font-medium leading-4 outline-none placeholder:text-muted-foreground"
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
                <span dir="auto" className="block overflow-hidden whitespace-nowrap oc-ui-start-align text-[0.8125rem] font-medium leading-4 text-foreground max-w-full">
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
          {/* What people check or press all through a session sits here in
              every layout: the side panels come and go, these stay put. */}
          {!isVSCode && !activeSurfaceHeader ? (
            <>
              <HeaderContextUsage buttonClassName={DESKTOP_HEADER_ICON_BUTTON_CLASS} />
              <HeaderProjectControls buttonClassName={DESKTOP_HEADER_ICON_BUTTON_CLASS} />
            </>
          ) : null}
          {showMiniChatHeaderAction ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={isNewSessionDraftOpen ? t('header.actions.newMiniChatAria') : t('header.actions.openSessionMiniChatAria')}
                  onClick={handleOpenCurrentMiniChat}
                  className={DESKTOP_HEADER_ICON_BUTTON_CLASS}
                >
                  <Icon name="picture-in-picture-2" className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <TooltipLabelWithShortcut label={isNewSessionDraftOpen ? t('header.actions.newMiniChat') : t('header.actions.openSessionMiniChat')} shortcut={isNewSessionDraftOpen ? formatShortcutForDisplay(getEffectiveShortcutCombo('new_mini_chat', shortcutOverrides), '') : undefined} />
              </TooltipContent>
            </Tooltip>
          ) : null}
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
                    // On, it takes the neutral selected fill the rail's open
                    // surfaces have, so the card shows which toggle opened it.
                    workStatusToggleActive && 'bg-interactive-selection text-interactive-selection-foreground hover:text-interactive-selection-foreground',
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

          <WindowsWindowControls visible={endEdgeOwnedByInWindowControls} position={windowControlsSide} />
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
      {moveSessionTarget ? (
        <MoveSessionDialog
          open
          onOpenChange={(open) => { if (!open) setMoveSessionTarget(null); }}
          sessionId={moveSessionTarget.sessionId}
          sourceDirectory={moveSessionTarget.directory}
        />
      ) : null}
      {sessionExport.dialog}
      <Dialog open={pendingDeleteSessionId !== null} onOpenChange={(open) => { if (!open) setPendingDeleteSessionId(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{t('sessions.sidebar.dialogs.deleteSession.title')}</DialogTitle>
            <DialogDescription>{t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: pendingDeleteSessionTitle })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingDeleteSessionId(null)}>
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmHeaderDelete()}>
              {t('sessions.sidebar.bulkActions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
