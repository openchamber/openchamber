import React from 'react';
import { toast } from '@/components/ui';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncSessions } from '@/sync/sync-refs';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { sessionEvents } from '@/lib/sessionEvents';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { showOpenCodeStatus } from '@/lib/openCodeStatus';

const getActiveElementSelectedText = (): string => {
  if (typeof document === 'undefined') {
    return '';
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLTextAreaElement) {
    return activeElement.value.slice(activeElement.selectionStart ?? 0, activeElement.selectionEnd ?? 0);
  }

  if (activeElement instanceof HTMLInputElement) {
    const type = activeElement.type?.toLowerCase() ?? 'text';
    if (['text', 'search', 'url', 'tel', 'password'].includes(type)) {
      return activeElement.value.slice(activeElement.selectionStart ?? 0, activeElement.selectionEnd ?? 0);
    }
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return activeElement.ownerDocument.defaultView?.getSelection?.()?.toString() ?? '';
  }

  return '';
};

const copyCurrentSelectionFallback = async (): Promise<boolean> => {
  const selectionText = getActiveElementSelectedText() || window.getSelection()?.toString() || '';
  if (!selectionText.trim()) {
    return false;
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(selectionText);
      return true;
    }
  } catch {
    // Fall through to execCommand fallback when Clipboard API is unavailable.
  }

  return document.execCommand('copy');
};

const MENU_ACTION_EVENT = 'openchamber:menu-action';
const CHECK_FOR_UPDATES_EVENT = 'openchamber:check-for-updates';

type TauriEventApi = {
  listen?: (
    event: string,
    handler: (evt: { payload?: unknown }) => void
  ) => Promise<() => void>;
};

type TauriGlobal = {
  event?: TauriEventApi;
};

type MenuAction =
  | 'about'
  | 'settings'
  | 'command-palette'
  | 'quick-open'
  | 'new-session'
  | 'new-worktree-session'
  | 'change-workspace'
  | 'toggle-right-sidebar'
  | 'open-right-sidebar-git'
  | 'open-right-sidebar-files'
  | 'toggle-terminal'
  | 'toggle-terminal-expanded'
  | 'copy'
  | 'theme-light'
  | 'theme-dark'
  | 'theme-system'
  | 'toggle-sidebar'
  | 'toggle-memory-debug'
  | 'go-back'
  | 'go-forward'
  | 'previous-session'
  | 'next-session'
  | 'previous-project'
  | 'next-project'
  | 'help-dialog'
  | 'download-logs';

export const useMenuActions = (
  onToggleMemoryDebug?: () => void
) => {
  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const toggleHelpDialog = useUIStore((s) => s.toggleHelpDialog);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setAboutDialogOpen = useUIStore((s) => s.setAboutDialogOpen);
  const toggleRightSidebar = useUIStore((s) => s.toggleRightSidebar);
  const setRightSidebarOpen = useUIStore((s) => s.setRightSidebarOpen);
  const setRightSidebarTab = useUIStore((s) => s.setRightSidebarTab);
  const toggleBottomTerminal = useUIStore((s) => s.toggleBottomTerminal);
  const setBottomTerminalExpanded = useUIStore((s) => s.setBottomTerminalExpanded);
  const checkForUpdates = useUpdateStore((state) => state.checkForUpdates);
  const { setThemeMode } = useThemeSystem();
  const checkUpdatesInFlightRef = React.useRef(false);

  const handleCheckForUpdates = React.useCallback(() => {
    if (checkUpdatesInFlightRef.current) {
      return;
    }
    checkUpdatesInFlightRef.current = true;

    void checkForUpdates()
      .then(() => {
        const { available, error } = useUpdateStore.getState();
        if (error) {
          toast.error('Failed to check for updates', {
            description: error,
          });
          return;
        }

        if (!available) {
          toast.success('You are on the latest version');
        }
      })
      .finally(() => {
        checkUpdatesInFlightRef.current = false;
      });
  }, [checkForUpdates]);

  const handleChangeWorkspace = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

  const navigateSession = React.useCallback((direction: -1 | 1) => {
    const sessions = getSyncSessions();
    if (sessions.length === 0) return;

    const currentSessionId = useSessionUIStore.getState().currentSessionId;
    const currentIndex = sessions.findIndex((session) => session.id === currentSessionId);
    let nextIndex = direction > 0 ? 0 : sessions.length - 1;
    if (currentIndex >= 0) {
      nextIndex = (currentIndex + direction + sessions.length) % sessions.length;
    }
    const nextSession = sessions[nextIndex];
    if (!nextSession) return;

    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
    useSessionUIStore.getState().setCurrentSession(nextSession.id);
  }, [setActiveMainTab, setSessionSwitcherOpen]);

  const navigateProject = React.useCallback((direction: -1 | 1) => {
    const { activeProjectId, projects, setActiveProject } = useProjectsStore.getState();
    if (projects.length === 0) return;

    const currentIndex = projects.findIndex((project) => project.id === activeProjectId);
    let nextIndex = direction > 0 ? 0 : projects.length - 1;
    if (currentIndex >= 0) {
      nextIndex = (currentIndex + direction + projects.length) % projects.length;
    }
    const nextProject = projects[nextIndex];
    if (!nextProject) return;

    setActiveProject(nextProject.id);
  }, []);

  const handleAction = React.useCallback(
    (action: MenuAction) => {
      switch (action) {
        case 'about':
          setAboutDialogOpen(true);
          break;

        case 'settings':
          setSettingsDialogOpen(true);
          break;

        case 'command-palette':
          toggleCommandPalette();
          break;

        case 'quick-open':
          setCommandPaletteOpen(true);
          break;

        case 'new-session':
          setActiveMainTab('chat');
          setSessionSwitcherOpen(false);
          openNewSessionDraft();
          break;

        case 'new-worktree-session':
          setActiveMainTab('chat');
          setSessionSwitcherOpen(false);
          createWorktreeSession();
          break;

        case 'change-workspace':
          handleChangeWorkspace();
          break;

        case 'toggle-right-sidebar':
          toggleRightSidebar();
          break;

        case 'open-right-sidebar-git':
          setRightSidebarOpen(true);
          setRightSidebarTab('git');
          break;

        case 'open-right-sidebar-files':
          setRightSidebarOpen(true);
          setRightSidebarTab('files');
          break;

        case 'toggle-terminal':
          toggleBottomTerminal();
          break;

        case 'toggle-terminal-expanded':
          setBottomTerminalExpanded(!useUIStore.getState().isBottomTerminalExpanded);
          break;

        case 'copy': {
          const copyEvent = new Event('openchamber:copy', { cancelable: true });
          const wasHandled = !window.dispatchEvent(copyEvent);
          if (!wasHandled) {
            void copyCurrentSelectionFallback();
          }
          break;
        }

        case 'theme-light':
          setThemeMode('light');
          break;

        case 'theme-dark':
          setThemeMode('dark');
          break;

        case 'theme-system':
          setThemeMode('system');
          break;

        case 'toggle-sidebar':
          toggleSidebar();
          break;

        case 'toggle-memory-debug':
          onToggleMemoryDebug?.();
          break;

        case 'go-back':
          useDirectoryStore.getState().goBack();
          break;

        case 'go-forward':
          useDirectoryStore.getState().goForward();
          break;

        case 'previous-session':
          navigateSession(-1);
          break;

        case 'next-session':
          navigateSession(1);
          break;

        case 'previous-project':
          navigateProject(-1);
          break;

        case 'next-project':
          navigateProject(1);
          break;

        case 'help-dialog':
          toggleHelpDialog();
          break;

        case 'download-logs': {
          void showOpenCodeStatus().catch(() => {
            toast.error('Failed to collect OpenCode status');
          });
          break;
        }
      }
    },
    [
      handleChangeWorkspace,
      navigateProject,
      navigateSession,
      onToggleMemoryDebug,
      openNewSessionDraft,
      setAboutDialogOpen,
      setActiveMainTab,
      setSessionSwitcherOpen,
      setCommandPaletteOpen,
      setSettingsDialogOpen,
      setBottomTerminalExpanded,
      setRightSidebarOpen,
      setRightSidebarTab,
      setThemeMode,
      toggleBottomTerminal,
      toggleCommandPalette,
      toggleHelpDialog,
      toggleRightSidebar,
      toggleSidebar,
    ]
  );

  React.useEffect(() => {
    const handleMenuAction = (event: Event) => {
      const action = (event as CustomEvent<MenuAction>).detail;
      if (!action) return;
      handleAction(action);
    };

    const handleCheckForUpdatesEvent = () => {
      handleCheckForUpdates();
    };

    window.addEventListener(MENU_ACTION_EVENT, handleMenuAction);
    window.addEventListener(CHECK_FOR_UPDATES_EVENT, handleCheckForUpdatesEvent);
    return () => {
      window.removeEventListener(MENU_ACTION_EVENT, handleMenuAction);
      window.removeEventListener(CHECK_FOR_UPDATES_EVENT, handleCheckForUpdatesEvent);
    };
  }, [handleAction, handleCheckForUpdates]);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
    const listen = tauri?.event?.listen;
    if (typeof listen !== 'function') return;

    let unlistenMenu: null | (() => void | Promise<void>) = null;
    let unlistenUpdate: null | (() => void | Promise<void>) = null;

    listen('openchamber:menu-action', (evt) => {
      const action = evt?.payload;
      if (typeof action !== 'string') return;
      handleAction(action as MenuAction);
    })
      .then((fn) => {
        unlistenMenu = fn;
      })
      .catch(() => {
        // ignore
      });

    listen('openchamber:check-for-updates', () => {
      window.dispatchEvent(new Event(CHECK_FOR_UPDATES_EVENT));
    })
      .then((fn) => {
        unlistenUpdate = fn;
      })
      .catch(() => {
        // ignore
      });

    return () => {
      const cleanup = async () => {
        try {
          const a = unlistenMenu?.();
          if (a instanceof Promise) await a;
        } catch {
          // ignore
        }
        try {
          const b = unlistenUpdate?.();
          if (b instanceof Promise) await b;
        } catch {
          // ignore
        }
      };
      void cleanup();
    };
  }, [handleAction]);
};
