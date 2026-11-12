import React from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useUIStore } from '@/stores/useUIStore';
import { useEnterpriseMode, useJevBlockedByEnterprise } from '@/stores/useEnterprisePolicyStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { orderVisibleRootSessions } from '@/lib/sessionListOrder';
import { settingsPageTitleKey } from '@/lib/settings/pageTitle';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import {
  EMPTY_SESSION_ORDER_RANKS,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitAllBranches, useGitStore } from '@/stores/useGitStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import {
  addProject,
  copyCurrentSessionId,
  openArchive,
  openMultiRun,
  openNewWorktreeDialog,
  openNotes,
  openOverview,
  openTodos,
  pinCurrentSession,
  reloadUi,
  restartOpenCode,
  showContextUsage,
  showDiagnosticTimeline,
} from '@/lib/paletteCommands';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { toastContextFileOpenFailure, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import type { Session } from '@/lib/opencode/model';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { formatShortcutForDisplay, getEffectiveShortcutCombo, shortcutRegistry, type ShortcutActionId } from '@/lib/shortcuts';
import { canUseElectronDesktopIPC, getMiniChatRuntimeArgs, invokeDesktop, isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { SETTINGS_PAGE_METADATA, type SettingsRuntimeContext } from '@/lib/settings/metadata';

const EMPTY_PINNED_SESSION_IDS = new Set<string>();
import { getSettingsNavIcon } from '@/lib/settings/metadata';
import { Icon } from "@/components/icon/Icon";
import { McpIcon } from '@/components/icons/McpIcon';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { rankBySubsequence } from '@/lib/search/subsequenceSearch';
import { matchSegments, type MatchRange } from '@/lib/search/matchSegments';
import { MatchHighlight } from './MatchHighlight';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { buildCommandPaletteFileSearchKey, scoreCommandPaletteFiles } from './commandPaletteFilesState';
import { fileRowMatchRanges, projectRowMatchRanges, splitRelativePath } from './commandPaletteMatches';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { useMessageSearch } from '@/hooks/useMessageSearch';
import { readMessageSearchStatus, type MessageSearchHit, type MessageSearchServerStatus } from '@/lib/messageSearch';
import { MessageHitItem } from './commandPaletteMessages';
import { requestReasoningReveal } from '@/components/chat/search/reasoningReveal';
import { useObserveProjectActionRuns, useProjectActions } from '@/components/layout/projectActionsRunnerContext';
import { resolveProjectActionIconName } from '@/lib/projectActions';
import { isSessionDirectoryAdmitted } from '@/sync/session-admission-rule';
import { useGuestActions, useGuestCommands } from '@/hooks/useGuestSurfaces';
import { useGuestsStore } from '@/lib/guests/store';
import { guestSessionActions, type GuestActionEntry } from '@/lib/guests/actions';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { runGuestSessionAction } from '@/lib/guests/session-action';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useComposerConfigDirectory } from '@/hooks/useComposerConfigDirectory';
import { selectCommandsForComposer, useCommandsStore } from '@/stores/useCommandsStore';
import { reservedComposerCommandNames } from '@/components/chat/composer/submit/guestCommands';
import { useInputStore } from '@/sync/input-store';
import { useSessionMessageRecordsForExport } from '@/sync/use-sync';
import { toast } from './toast';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { rankConversationMetadata } from '@/lib/search/conversationSearch';
import { Button } from './button';

type CommandEntry = {
  id: string;
  title: string;
  icon: React.ReactNode;
  shortcutId?: ShortcutActionId;
  searchText: string;
  /** Muted text after the title, such as the extension a command comes from. */
  detail?: string;
  /**
   * More words that find the entry (the extension's name, a description),
   * ranked below entries whose own text matches the query.
   */
  keywords?: string;
  /** Search-only command: reachable by typing, hidden from the initial list
      so the first screen stays scroll-free. */
  secondary?: boolean;
  onSelect: () => void;
};

type FileHit = { path: string; name: string; relativePath: string };
const EMPTY_SESSIONS: Session[] = [];
const NO_RANGES: MatchRange[] = [];
// Message hits shown among everything else; "Show all" opens the full list.
const MESSAGE_PREVIEW_LIMIT = 3;
const MESSAGE_PAGE_SIZE = 30;
// Archived sessions follow the active ones as a short group of their own.
const ARCHIVED_SESSION_LIMIT = 3;

/**
 * Commands, Settings pages and projects match a query only at word starts, so a short
 * query like "ts" finds "TypeScript" but not the tail of "Agents". The query
 * splits the way the text does, so "/task" finds the extension command `/task`.
 */
const WORD_SEPARATOR = /[^\p{L}\p{N}]+/u;
const matchesWordStarts = (text: string, query: string): boolean => {
  const words = text.toLowerCase().split(WORD_SEPARATOR).filter(Boolean);
  const tokens = query.toLowerCase().split(WORD_SEPARATOR).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => words.some((word) => word.startsWith(token)));
};

// Left-to-right marks keep a path's leading "." or trailing "/" in place
// inside the right-to-left box that moves the ellipsis to the start.
const LRM = '\u200E';

/** Text with the ranges the palette's matcher matched marked. */
const Matched: React.FC<{ text: string; ranges: ReadonlyArray<MatchRange> }> = ({ text, ranges }) => (
  ranges.length > 0 ? <MatchHighlight segments={matchSegments(text, ranges)} /> : <>{text}</>
);

/** Secondary text that loses its start, not its end, when it does not fit. */
const LeadingTruncated: React.FC<{ text: string; ranges: ReadonlyArray<MatchRange>; className?: string }> = ({ text, ranges, className }) => (
  <span
    className={cn('oc-ui-start-align min-w-0 truncate text-muted-foreground', className)}
    style={{ direction: 'rtl' }}
    title={text}
  >
    {LRM}<Matched text={text} ranges={ranges} />{LRM}
  </span>
);

const normalizePath = (value: string): string => {
  if (!value) return '';
  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');
  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) normalized = `/${normalized}`;
  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) normalized = normalized.replace(/\/+$/, '');
  return normalized;
};

export const CommandPalette: React.FC = () => {
  const { t } = useI18n();

  const isCommandPaletteOpen = useUIStore((s) => s.isCommandPaletteOpen);
  const setCommandPaletteOpen = useUIStore((s) => s.setCommandPaletteOpen);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((s) => s.setSettingsPage);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const openContextSurface = useUIStore((s) => s.openContextSurface);
  const openContextFile = useUIStore((s) => s.openContextFile);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);

  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);

  const activeSessions = useGlobalSessionsStore(React.useCallback(
    (state) => isCommandPaletteOpen ? state.activeSessions : EMPTY_SESSIONS,
    [isCommandPaletteOpen],
  ));
  const archivedSessions = useGlobalSessionsStore(React.useCallback(
    (state) => isCommandPaletteOpen ? state.archivedSessions : EMPTY_SESSIONS,
    [isCommandPaletteOpen],
  ));
  const pinnedSessionIds = useSessionPinnedStore(React.useCallback(
    (state) => isCommandPaletteOpen ? state.ids : EMPTY_PINNED_SESSION_IDS,
    [isCommandPaletteOpen],
  ));
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => isCommandPaletteOpen ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [isCommandPaletteOpen],
  ));
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const activeProject = useProjectsStore((s) => s.getActiveProject());
  const projects = useProjectsStore((s) => s.projects);
  const effectiveDirectory = useEffectiveDirectory();
  const searchFiles = useFileSearchStore((s) => s.searchFiles);
  const { files: filesApi, git: gitApi } = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((s) => s.ensureStatus);
  const { isMobile } = useDeviceInfo();
  const projectActions = useProjectActions();
  // Run or Stop must match what the action is doing now.
  useObserveProjectActionRuns(isCommandPaletteOpen);

  const currentRoot = React.useMemo(
    () => (effectiveDirectory ? normalizePath(effectiveDirectory) : null),
    [effectiveDirectory],
  );

  const inputRef = React.useRef<HTMLInputElement>(null);
  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const trimmedQuery = debouncedQuery.trim();
  const liveTrimmed = query.trim();
  // "Show all" on the Messages group drills into message hits only, with paging.
  const [view, setView] = React.useState<'all' | 'messages'>('all');
  const leaveMessagesView = React.useCallback(() => {
    setView('all');
    inputRef.current?.focus();
  }, []);

  // Clear query on open (not close) so content stays visible through the
  // close animation instead of emptying mid-flight.
  React.useEffect(() => {
    if (isCommandPaletteOpen) {
      setQuery('');
      setView('all');
    }
  }, [isCommandPaletteOpen]);

  // Lazy-load git status for every session directory we plan to display so that
  // branch labels become available across all projects, not only the active one.
  // Deferred to idle to keep the first render (and the file-search effect) free
  // from a flood of git store updates.
  React.useEffect(() => {
    if (!isCommandPaletteOpen || !gitApi) return;
    const handle = setTimeout(() => {
      const seen = new Set<string>();
      for (const session of activeSessions) {
        const dir = resolveGlobalSessionDirectory(session);
        if (!dir || seen.has(dir)) continue;
        seen.add(dir);
        void ensureGitStatus(dir, gitApi);
      }
    }, 0);
    return () => clearTimeout(handle);
  }, [isCommandPaletteOpen, activeSessions, gitApi, ensureGitStatus]);

  const close = React.useCallback(() => setCommandPaletteOpen(false), [setCommandPaletteOpen]);
  const run = React.useCallback(
    (fn: () => void | boolean | Promise<void>) => () => {
      close();
      void fn();
    },
    [close],
  );

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  const overviewAvailable = useUIStore((state) => state.overviewFeatureAvailable);
  const commands = React.useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = [
      {
        id: 'new-session',
        title: t('commandPalette.item.newSession'),
        icon: <Icon name="add" className="me-2 h-4 w-4" />,
        shortcutId: 'new_chat',
        searchText: t('commandPalette.item.newSession'),
        onSelect: run(() => {
          setSessionSwitcherOpen(false);
          openNewSessionDraft();
        }),
      },
      {
        id: 'new-worktree',
        title: t('commandPalette.item.quickWorktree'),
        icon: <Icon name="flashlight" className="me-2 h-4 w-4" />,
        shortcutId: 'new_chat_worktree',
        searchText: t('commandPalette.item.quickWorktree'),
        onSelect: run(() => {
          void createWorktreeSession();
        }),
      },
      {
        id: 'new-worktree-dialog',
        title: t('commandPalette.item.newWorktreeDialog'),
        icon: <Icon name="worktree" className="me-2 h-4 w-4" />,
        shortcutId: 'open_new_worktree_dialog',
        searchText: t('commandPalette.item.newWorktreeDialog'),
        onSelect: run(openNewWorktreeDialog),
      },
      {
        id: 'add-project',
        title: t('commandPalette.item.addProject'),
        icon: <Icon name="folder-add" className="me-2 h-4 w-4" />,
        shortcutId: 'add_project',
        searchText: t('commandPalette.item.addProject'),
        onSelect: run(addProject),
      },
      {
        id: 'toggle-sidebar',
        title: isMobile
          ? t('commandPalette.item.showSessionSwitcher')
          : t('commandPalette.item.toggleSidebar'),
        icon: <Icon name="layout-left" className="me-2 h-4 w-4" />,
        shortcutId: 'toggle_sidebar',
        searchText: isMobile
          ? t('commandPalette.item.showSessionSwitcher')
          : t('commandPalette.item.toggleSidebar'),
        onSelect: run(() => {
          if (isMobile) {
            const { isSessionSwitcherOpen } = useUIStore.getState();
            setSessionSwitcherOpen(!isSessionSwitcherOpen);
          } else {
            toggleSidebar();
          }
        }),
      },
      {
        id: 'toggle-terminal',
        title: t('commandPalette.item.toggleTerminal'),
        icon: <Icon name="terminal-box" className="me-2 h-4 w-4" />,
        shortcutId: 'toggle_terminal',
        searchText: t('commandPalette.item.toggleTerminal'),
        onSelect: run(() => {
          if (currentDirectory) openContextSurface(currentDirectory, 'terminal');
        }),
      },
      {
        id: 'context-usage',
        title: t('commandPalette.item.showContextUsage'),
        icon: <Icon name="pie-chart" className="me-2 h-4 w-4" />,
        shortcutId: 'show_context_usage',
        searchText: t('commandPalette.item.showContextUsage'),
        onSelect: run(showContextUsage),
      },
      {
        id: 'cycle-theme',
        secondary: true,
        title: t('commandPalette.item.cycleTheme'),
        icon: <Icon name="palette" className="me-2 h-4 w-4" />,
        shortcutId: 'cycle_theme',
        searchText: t('commandPalette.item.cycleTheme'),
        onSelect: run(() => {
          shortcutRegistry.invoke('cycle_theme');
        }),
      },
      {
        id: 'open-status',
        secondary: true,
        title: t('commandPalette.item.showOpenCodeStatus'),
        icon: <Icon name="pulse" className="me-2 h-4 w-4" />,
        shortcutId: 'show_opencode_status',
        searchText: t('commandPalette.item.showOpenCodeStatus'),
        onSelect: run(showDiagnosticTimeline),
      },
      {
        id: 'open-settings',
        title: t('commandPalette.item.openSettings'),
        icon: <Icon name="settings-3" className="me-2 h-4 w-4" />,
        shortcutId: 'open_settings',
        searchText: t('commandPalette.item.openSettings'),
        onSelect: run(() => setSettingsDialogOpen(true)),
      },
    ];
    if (!isVSCodeRuntime() && overviewAvailable) {
      list.push({
        id: 'open-overview',
        secondary: true,
        title: t('overview.title'),
        icon: <Icon name="compass-3" className="me-2 h-4 w-4" />,
        shortcutId: 'open_overview',
        searchText: t('overview.title'),
        onSelect: run(openOverview),
      });
    }
    if (!isVSCodeRuntime()) {
      list.push({
        id: 'open-source-board',
        secondary: true,
        title: t('sourceBoard.title'),
        icon: <Icon name="git-pull-request" className="me-2 h-4 w-4" />,
        shortcutId: 'toggle_source_board',
        searchText: t('sourceBoard.title'),
        onSelect: run(() => useUIStore.getState().setSourceBoardOpen(true)),
      });
      // Reloading the window restarts only the interface: sessions and the
      // agents running in them live in the server and continue.
      list.push({
        id: 'reload-ui',
        secondary: true,
        title: t('commandPalette.item.reloadUi'),
        icon: <Icon name="refresh" className="me-2 h-4 w-4" />,
        shortcutId: 'reload_ui',
        searchText: t('commandPalette.item.reloadUi'),
        onSelect: run(reloadUi),
      });
    }
    list.push(
      {
        id: 'collapse-sessions-all',
        secondary: true,
        title: t('sessions.sidebar.header.displayMode.collapseAll'),
        icon: <Icon name="contract-up-down" className="me-2 h-4 w-4" />,
        shortcutId: 'collapse_sessions_all',
        searchText: t('sessions.sidebar.header.displayMode.collapseAll'),
        onSelect: run(() => {
          // The sidebar handler acts on hidden sidebars too; opening it shows the result.
          setSidebarOpen(true);
          shortcutRegistry.invoke('collapse_sessions_all');
        }),
      },
      {
        id: 'expand-sessions-all',
        secondary: true,
        title: t('sessions.sidebar.header.displayMode.expandAll'),
        icon: <Icon name="expand-up-down" className="me-2 h-4 w-4" />,
        shortcutId: 'expand_sessions_all',
        searchText: t('sessions.sidebar.header.displayMode.expandAll'),
        onSelect: run(() => {
          // The sidebar handler acts on hidden sidebars too; opening it shows the result.
          setSidebarOpen(true);
          shortcutRegistry.invoke('expand_sessions_all');
        }),
      },
      {
        id: 'pin-session',
        secondary: true,
        title: t('commandPalette.item.pinSession'),
        icon: <Icon name="pushpin" className="me-2 h-4 w-4" />,
        shortcutId: 'pin_current_session',
        searchText: t('commandPalette.item.pinSession'),
        onSelect: run(pinCurrentSession(t)),
      },
      {
        id: 'copy-session-id',
        secondary: true,
        title: t('commandPalette.item.copySessionId'),
        icon: <Icon name="file-copy" className="me-2 h-4 w-4" />,
        shortcutId: 'copy_current_session_id',
        searchText: t('commandPalette.item.copySessionId'),
        onSelect: run(copyCurrentSessionId(t)),
      },
      {
        id: 'open-multi-run',
        secondary: true,
        title: t('commandPalette.item.openMultiRun'),
        icon: <ArrowsMerge className="me-2 h-4 w-4" />,
        shortcutId: 'open_multi_run',
        searchText: t('commandPalette.item.openMultiRun'),
        onSelect: run(openMultiRun),
      },
      {
        id: 'open-archive',
        secondary: true,
        title: t('commandPalette.item.openArchive'),
        icon: <Icon name="archive" className="me-2 h-4 w-4" />,
        shortcutId: 'open_archive',
        searchText: t('commandPalette.item.openArchive'),
        onSelect: run(openArchive),
      },
      {
        id: 'open-notes',
        secondary: true,
        title: t('commandPalette.item.openNotes'),
        icon: <Icon name="sticky-note" className="me-2 h-4 w-4" />,
        shortcutId: 'open_notes',
        searchText: t('commandPalette.item.openNotes'),
        onSelect: run(openNotes),
      },
      {
        id: 'open-todos',
        secondary: true,
        title: t('commandPalette.item.openTodos'),
        icon: <Icon name="checkbox-circle" className="me-2 h-4 w-4" />,
        shortcutId: 'open_todos',
        searchText: t('commandPalette.item.openTodos'),
        onSelect: run(openTodos),
      },
    );
    if (!isVSCodeRuntime()) {
      list.push({
        id: 'restart-opencode',
        secondary: true,
        title: t('commandPalette.item.restartOpenCode'),
        icon: <Icon name="restart" className="me-2 h-4 w-4" />,
        shortcutId: 'restart_opencode',
        searchText: t('commandPalette.item.restartOpenCode'),
        onSelect: run(restartOpenCode(t)),
      });
    }
    list.push({
      id: 'toggle-memory-debug',
      secondary: true,
      title: t('commandPalette.item.toggleMemoryDebug'),
      icon: <Icon name="bug" className="me-2 h-4 w-4" />,
      searchText: t('commandPalette.item.toggleMemoryDebug'),
      onSelect: run(() => {
        window.dispatchEvent(new CustomEvent('openchamber:memory-debug-toggle'));
      }),
    });
    // Search-only: typing "run", "stop" or an action's name finds them.
    if (projectActions?.available) {
      list.push({
        id: 'open-project-actions',
        secondary: true,
        title: t('commandPalette.item.openProjectActions'),
        icon: <Icon name="play" className="me-2 h-4 w-4" />,
        shortcutId: 'open_project_actions',
        searchText: t('commandPalette.item.openProjectActions'),
        onSelect: run(() => useUIStore.getState().setProjectActionsDialogOpen(true)),
      });
      for (const action of projectActions.actions) {
        const actionRun = projectActions.runOf(action);
        if (actionRun?.status === 'stopping') continue;
        const title = actionRun
          ? t('commandPalette.item.stopProjectAction', { name: action.name })
          : t('commandPalette.item.runProjectAction', { name: action.name });
        list.push({
          id: `project-action:${action.id}`,
          secondary: true,
          title,
          icon: <Icon name={actionRun ? 'stop' : resolveProjectActionIconName(action)} className="me-2 h-4 w-4" />,
          searchText: title,
          onSelect: run(() => {
            if (actionRun) {
              projectActions.stop(action);
              return;
            }
            projectActions.select(action);
            projectActions.run(action);
          }),
        });
      }
    }
    if (canUseElectronDesktopIPC()) {
      list.splice(1, 0, {
        id: 'new-mini-chat',
        title: t('commandPalette.item.newMiniChat'),
        icon: <Icon name="window" className="me-2 h-4 w-4" />,
        shortcutId: 'new_mini_chat',
        searchText: t('commandPalette.item.newMiniChat'),
        onSelect: run(() => {
          void invokeDesktop('desktop_open_draft_mini_chat_window', {
            directory: normalizePath(currentDirectory || activeProject?.path || ''),
            projectId: activeProject?.id ?? null,
            ...getMiniChatRuntimeArgs(),
          }).catch((error) => {
            console.warn('[command-palette] failed to open draft mini chat window', error);
          });
        }),
      });
    }
    return list;
  }, [
    t,
    run,
    isMobile,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    toggleSidebar,
    setSidebarOpen,
    openContextSurface,
    currentDirectory,
    setSettingsDialogOpen,
    activeProject?.id,
    activeProject?.path,
    projectActions,
    overviewAvailable,
  ]);

  // ---------------------------------------------------------------------------
  // Extensions: session actions on the current session, and slash commands.
  // Search-only. Message, selection, file and diff actions stay in their own
  // menus: the palette has no message, selection or lines to give them.
  // ---------------------------------------------------------------------------
  const hasCurrentSession = useSessionUIStore((s) => Boolean(s.currentSessionId));
  const guestActions = useGuestActions();
  const guestGuests = useGuestsStore((s) => s.guests);
  // The same reserved names as the composer's slash menu, so the palette never
  // offers a command the composer would hand to OpenCode instead.
  const composerCommandsTarget = useComposerConfigDirectory(effectiveDirectory);
  const composerCommands = useCommandsStore((s) => selectCommandsForComposer(s, composerCommandsTarget));
  const reservedCommandNames = React.useMemo(() => reservedComposerCommandNames(composerCommands), [composerCommands]);
  const guestCommands = useGuestCommands(reservedCommandNames);
  const loadSessionRecords = useSessionMessageRecordsForExport();

  // The current session as the session header menu gives it; read when the action runs.
  const runCurrentSessionGuestAction = React.useCallback((entry: GuestActionEntry) => {
    const { currentSessionId: sessionId, currentSessionDirectory } = useSessionUIStore.getState();
    if (!sessionId) return;
    const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
    const directory = (session ? resolveGlobalSessionDirectory(session) : null) ?? currentSessionDirectory;
    void runGuestSessionAction({
      entry,
      t,
      session: { id: sessionId, title: session?.title, directory },
      loadRecords: async () => {
        if (!directory) return null;
        try {
          return await loadSessionRecords({ sessionID: sessionId, directory });
        } catch {
          return null;
        }
      },
      onLoadFailed: () => toast.error(t('sessions.sidebar.session.export.failedLoadHistory')),
    });
  }, [loadSessionRecords, t]);

  const extensionCommands = React.useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = [];
    if (hasCurrentSession) {
      for (const entry of guestSessionActions(guestActions)) {
        list.push({
          id: `extension-action:${entry.guest.id}:${entry.action.id}`,
          secondary: true,
          title: entry.action.label,
          detail: entry.guest.name,
          icon: <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="me-2 h-4 w-4" />,
          searchText: entry.action.label,
          keywords: entry.guest.name,
          onSelect: run(() => runCurrentSessionGuestAction(entry)),
        });
      }
    }
    if (guestCommands.length > 0) {
      const authenticatedAsset = getRuntimeUrlResolver().authenticatedAsset;
      const guestsById = new Map(guestGuests.map((guest) => [guest.id, guest]));
      for (const entry of guestCommands) {
        const guestIcon = guestsById.get(entry.guestId)?.icon ?? '';
        const title = `/${entry.command.name}`;
        list.push({
          id: `extension-command:${entry.guestId}:${entry.command.name}`,
          secondary: true,
          title,
          detail: entry.guestName,
          icon: <GuestIcon icon={resolveGuestIconName(guestIcon)} iconSrc={guestPackageIconSrc(entry.guestId, guestIcon, authenticatedAsset)} className="me-2 h-4 w-4" />,
          searchText: title,
          keywords: `${entry.guestName} ${entry.command.description ?? ''}`,
          // Like picking it in the composer's slash menu: the command waits
          // in the composer for its argument and runs when the user sends.
          // Settings or a page covering the chat closes, so the composer can be seen.
          onSelect: run(() => {
            const ui = useUIStore.getState();
            ui.setSettingsDialogOpen(false);
            ui.closeMainSurfaces();
            useInputStore.getState().setPendingInputText(entry.command.name, 'slash-command');
          }),
        });
      }
    }
    return list;
  }, [guestActions, guestCommands, guestGuests, hasCurrentSession, run, runCurrentSessionGuestAction]);

  // ---------------------------------------------------------------------------
  // Settings sub-pages (only show when there's a query)
  // ---------------------------------------------------------------------------
  const routingAvailable = useUIStore((state) => state.routingFeatureAvailable);
  const enterpriseMode = useEnterpriseMode();
  const jevBlockedByEnterprise = useJevBlockedByEnterprise();
  const settingsRuntimeCtx = React.useMemo<SettingsRuntimeContext>(() => {
    const isDesktop = isDesktopShell();
    return { isVSCode: isVSCodeRuntime(), isWeb: !isDesktop && isWebRuntime(), isDesktop, isMobile, routingAvailable, enterpriseMode, jevBlockedByEnterprise };
  }, [isMobile, routingAvailable, enterpriseMode, jevBlockedByEnterprise]);

  const settingsEntries = React.useMemo<CommandEntry[]>(() => {
    return SETTINGS_PAGE_METADATA
      .filter((p) => p.slug !== 'home')
      .filter((p) => (p.isAvailable ? p.isAvailable(settingsRuntimeCtx) : true))
      .map((page) => {
        const iconName = getSettingsNavIcon(page.slug) ?? 'settings-3';
        const keywords = (page.keywords ?? []).join(' ');
        const title = t(settingsPageTitleKey(page.slug));
        return {
          id: `settings:${page.slug}`,
          title,
          icon: page.slug === 'mcp'
            ? <McpIcon className="me-2 h-4 w-4" />
            : <Icon name={iconName} className="me-2 h-4 w-4" />,
          // The English title stays searchable next to the translated one.
          searchText: `${title} ${page.title} ${page.group} ${keywords}`,
          onSelect: run(() => {
            setSettingsPage(page.slug);
            setSettingsDialogOpen(true);
          }),
        } satisfies CommandEntry;
      });
  }, [settingsRuntimeCtx, run, setSettingsPage, setSettingsDialogOpen, t]);

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------
  const worktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const archivedSessionIds = React.useMemo(() => new Set(archivedSessions.map((session) => session.id)), [archivedSessions]);
  const activeSessionIds = React.useMemo(() => new Set(activeSessions.map((session) => session.id)), [activeSessions]);
  const orderedActiveSessions = React.useMemo(
    () => orderVisibleRootSessions(activeSessions.filter((session) => (
      isSessionDirectoryAdmitted(resolveGlobalSessionDirectory(session), projects, worktreesByProject)
    )), pinnedSessionIds, sessionOrderRanks),
    [activeSessions, pinnedSessionIds, projects, sessionOrderRanks, worktreesByProject],
  );
  const orderedArchivedSessions = React.useMemo(
    () => orderVisibleRootSessions(archivedSessions.filter((session) => (
      isSessionDirectoryAdmitted(resolveGlobalSessionDirectory(session), projects, worktreesByProject)
    )), pinnedSessionIds, sessionOrderRanks),
    [archivedSessions, pinnedSessionIds, projects, sessionOrderRanks, worktreesByProject],
  );

  const allBranches = useGitAllBranches();
  const worktreeMetadata = useSessionUIStore((s) => s.worktreeMetadata);

  const branchForSession = React.useCallback(
    (sessionId: string, dir: string | null): string | null => {
      const meta = worktreeMetadata.get(sessionId);
      if (meta?.branch) return meta.branch.trim() || null;
      if (dir) return allBranches.get(dir)?.trim() || null;
      return null;
    },
    [worktreeMetadata, allBranches],
  );

  const registeredWorktreeText = React.useCallback((directory: string | null): string => {
    if (!directory) return '';
    const normalized = normalizePath(directory);
    let best: { path: string; branch: string; label: string } | null = null;
    for (const worktrees of worktreesByProject.values()) {
      for (const worktree of worktrees) {
        const path = normalizePath(worktree.path);
        if (normalized !== path && !normalized.startsWith(`${path}/`)) continue;
        if (best && best.path.length >= path.length) continue;
        best = { path, branch: worktree.branch, label: worktree.label };
      }
    }
    return best ? `${best.branch} ${best.label}` : '';
  }, [worktreesByProject]);

  const projectLabelForDirectory = React.useCallback((directory: string | null): string | null => {
    if (!directory) return null;
    const normalized = normalizePath(directory);
    const project = resolveProjectForSessionDirectory(projects, worktreesByProject, normalized);
    if (!project) return null;
    const root = normalizePath(project.path);
    return project.label || root.split('/').pop() || root;
  }, [projects, worktreesByProject]);

  const sessionMetadata = React.useCallback((session: Session, archived: boolean) => {
    const directory = resolveGlobalSessionDirectory(session);
    return {
      sessionId: session.id,
      title: session.title ?? '',
      projectLabel: projectLabelForDirectory(directory),
      worktreeLabel: branchForSession(session.id, directory) ?? registeredWorktreeText(directory),
      directory,
      archived,
      updatedAt: (archived ? session.time?.archived : undefined) ?? session.time?.updated,
    };
  }, [projectLabelForDirectory, branchForSession, registeredWorktreeText]);
  const activeSessionMetadata = React.useMemo(
    () => orderedActiveSessions.map((session) => sessionMetadata(session, false)),
    [orderedActiveSessions, sessionMetadata],
  );
  const archivedSessionMetadata = React.useMemo(
    () => orderedArchivedSessions.map((session) => sessionMetadata(session, true)),
    [orderedArchivedSessions, sessionMetadata],
  );
  const sessionsById = React.useMemo(
    () => new Map([...orderedActiveSessions, ...orderedArchivedSessions].map((session) => [session.id, session])),
    [orderedActiveSessions, orderedArchivedSessions],
  );

  // ---------------------------------------------------------------------------
  // File search
  // ---------------------------------------------------------------------------
  const [fileResults, setFileResults] = React.useState<FileHit[]>([]);
  const [fileResultsKey, setFileResultsKey] = React.useState('');

  const fileSearchKey = buildCommandPaletteFileSearchKey(currentRoot, trimmedQuery);

  // Other worktrees of the repository that live inside the project folder
  // (for example agent worktrees under .claude/worktrees) hold copies of the
  // same files. Opening one of those copies from here is almost always a
  // miss, so their files are left out.
  const availableWorktrees = useSessionUIStore((s) => s.availableWorktrees);
  const nestedWorktreePrefixes = React.useMemo(() => {
    if (!currentRoot) return [];
    return availableWorktrees
      .map((worktree) => normalizePath(worktree.path))
      .filter((path) => path.startsWith(`${currentRoot}/`))
      .map((path) => `${path}/`);
  }, [availableWorktrees, currentRoot]);
  const nestedWorktreePrefixesRef = React.useRef(nestedWorktreePrefixes);
  nestedWorktreePrefixesRef.current = nestedWorktreePrefixes;

  // ---------------------------------------------------------------------------
  // Message search (server index, opt-in; VS Code has no OpenChamber server)
  // ---------------------------------------------------------------------------
  const messageSearchEnabled = useUIStore((state) => state.messageSearchEnabled);
  const messageSearchSupported = messageSearchEnabled && !isVSCodeRuntime();
  // Reasoning hits only while it is indexed and shown in the chat: a hit in
  // hidden reasoning would lead nowhere visible.
  const reasoningIndexed = useUIStore((state) => state.messageSearchReasoningEnabled);
  const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
  const reasoningSearchable = reasoningIndexed && showReasoningTraces;
  // Archived conversations are always searched. A hit is listed when its folder
  // is admitted; the session caches say whether it is archived, and a server
  // that sends no lifecycle leaves the rest unmarked, shown as active.
  const { state: messageSearch, loadMore: loadMoreMessages } = useMessageSearch({
    query: trimmedQuery,
    enabled: isCommandPaletteOpen && messageSearchSupported,
    limit: view === 'messages' ? MESSAGE_PAGE_SIZE : MESSAGE_PREVIEW_LIMIT,
    includeReasoning: showReasoningTraces,
    lifecycle: 'all',
  });
  // Hits come newest first, and archived conversations are usually the oldest:
  // asked for on their own, they are listed at once instead of pages below.
  const { state: archivedMessageSearch, loadMore: loadMoreArchivedMessages } = useMessageSearch({
    query: trimmedQuery,
    enabled: isCommandPaletteOpen && messageSearchSupported,
    limit: view === 'messages' ? MESSAGE_PAGE_SIZE : MESSAGE_PREVIEW_LIMIT,
    includeReasoning: showReasoningTraces,
    lifecycle: 'archived',
  });
  const [unavailableStatus, setUnavailableStatus] = React.useState<MessageSearchServerStatus['state'] | null>(null);
  const [runtimeGeneration, setRuntimeGeneration] = React.useState(0);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => setRuntimeGeneration((generation) => generation + 1)), []);
  const runtimeKey = getRuntimeKey();
  const unavailableProbeKey = `${runtimeKey}\u0000${runtimeGeneration}\u0000${debouncedQuery}\u0000${showReasoningTraces}`;
  const unavailableProbeKeyRef = React.useRef(unavailableProbeKey);
  unavailableProbeKeyRef.current = unavailableProbeKey;
  React.useEffect(() => {
    if (!isCommandPaletteOpen || !messageSearchSupported || messageSearch.status !== 'unavailable') {
      setUnavailableStatus(null);
      return;
    }
    const controller = new AbortController();
    const probeKey = unavailableProbeKey;
    setUnavailableStatus(null);
    void readMessageSearchStatus(controller.signal)
      .then((status) => {
        if (!controller.signal.aborted && unavailableProbeKeyRef.current === probeKey) setUnavailableStatus(status.state);
      })
      .catch(() => {
        if (!controller.signal.aborted && unavailableProbeKeyRef.current === probeKey) setUnavailableStatus('unsupported');
      });
    return () => controller.abort();
  }, [isCommandPaletteOpen, messageSearch.status, messageSearchSupported, unavailableProbeKey]);
  const messageHits = ('hits' in messageSearch ? messageSearch.hits : []).flatMap((hit) => {
    if (!isSessionDirectoryAdmitted(hit.directory, projects, worktreesByProject)) return [];
    if (hit.role === 'reasoning' && !reasoningSearchable) return [];
    if (archivedSessionIds.has(hit.sessionId)) return [{ ...hit, archived: true }];
    if (activeSessionIds.has(hit.sessionId)) return [{ ...hit, archived: false }];
    return [hit];
  });
  // A server that ignores the lifecycle parameter answers the archived request
  // with everything, unmarked: its answer then says nothing about the archive.
  const archivedAnswer = 'hits' in archivedMessageSearch ? archivedMessageSearch.hits : [];
  const archivedAnswerUsable = archivedAnswer.every((hit) => hit.archived === true);
  const listedMessageKeys = new Set(messageHits.map((hit) => `${hit.role}:${hit.id}`));
  // Under the hits of every conversation: the archived ones those have not reached yet.
  const archivedMessageHits = archivedAnswerUsable ? archivedAnswer.filter((hit) => (
    !listedMessageKeys.has(`${hit.role}:${hit.id}`)
    // Restored a moment ago: the active cache already knows.
    && !activeSessionIds.has(hit.sessionId)
    && isSessionDirectoryAdmitted(hit.directory, projects, worktreesByProject)
    && (hit.role !== 'reasoning' || reasoningSearchable)
  )) : [];
  const moreArchivedMessages = archivedAnswerUsable && archivedMessageSearch.status === 'ready' && archivedMessageSearch.next !== null;

  React.useEffect(() => {
    if (!isCommandPaletteOpen) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    if (!fileSearchKey) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    if (!currentRoot) {
      setFileResults([]);
      setFileResultsKey('');
      return;
    }
    let cancelled = false;
    const excludedPrefixes = nestedWorktreePrefixesRef.current;
    // Worktree copies take result slots before they are dropped, so ask for
    // more when there are any.
    const limit = excludedPrefixes.length > 0 ? 100 : 40;
    void searchFiles(currentRoot, trimmedQuery, limit, { type: 'file' })
      .then((results) => {
        if (cancelled) return;
        setFileResults(
          results
            .map((file) => ({
              path: normalizePath(file.path),
              name: file.name,
              relativePath: file.relativePath,
            }))
            .filter((file) => !excludedPrefixes.some((prefix) => file.path.startsWith(prefix))),
        );
        setFileResultsKey(fileSearchKey);
      })
      .catch(() => {
        if (!cancelled) {
          setFileResults([]);
          setFileResultsKey(fileSearchKey);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isCommandPaletteOpen, currentRoot, trimmedQuery, fileSearchKey, searchFiles]);

  // ---------------------------------------------------------------------------
  // Filter visible items
  // ---------------------------------------------------------------------------
  const hasQuery = liveTrimmed.length > 0;

  const scoredCommands = React.useMemo(() => {
    if (!hasQuery) {
      return commands.filter((item) => !item.secondary).map((item) => ({ item, score: 0, ranges: NO_RANGES }));
    }
    const all = [...commands, ...extensionCommands];
    const candidates = all.filter((item) => matchesWordStarts(item.searchText, liveTrimmed));
    // "task" means the command `/task` before an action found through its
    // extension's name, Task Board.
    const byKeywords = all.filter((item) => item.keywords
      && !matchesWordStarts(item.searchText, liveTrimmed)
      && matchesWordStarts(`${item.searchText} ${item.keywords}`, liveTrimmed));
    return [
      ...rankBySubsequence(candidates, liveTrimmed, (c) => c.searchText),
      ...rankBySubsequence(byKeywords, liveTrimmed, (c) => `${c.searchText} ${c.keywords}`),
    ].slice(0, 7);
  }, [commands, extensionCommands, liveTrimmed, hasQuery]);

  const scoredSettings = React.useMemo(() => {
    if (!hasQuery) return [];
    const candidates = settingsEntries.filter((item) => matchesWordStarts(item.searchText, liveTrimmed));
    return rankBySubsequence(candidates, liveTrimmed, (c) => c.searchText, { limit: 7 });
  }, [settingsEntries, liveTrimmed, hasQuery]);

  const rankSessions = React.useCallback((metadata: Parameters<typeof rankConversationMetadata>[0], options: { limit: number; titlesOnly?: boolean }) => (
    rankConversationMetadata(metadata, liveTrimmed, options).flatMap((match) => {
      const item = sessionsById.get(match.sessionId);
      // Metadata ranks lower-is-better; the groups compare higher-is-better
      // scores, and a project or folder hit stays below every name hit.
      return item ? [{ item, score: -match.score, ranges: match.titleRanges }] : [];
    })
  ), [liveTrimmed, sessionsById]);

  const scoredSessions = React.useMemo(() => {
    if (!hasQuery) return orderedActiveSessions.slice(0, 5).map((item) => ({ item, score: 0, ranges: NO_RANGES }));
    return rankSessions(activeSessionMetadata, { limit: 7 });
  }, [hasQuery, orderedActiveSessions, activeSessionMetadata, rankSessions]);

  // An archived session is found by its title only: its project's name would
  // otherwise fill the group with every archived session of that project.
  const scoredArchivedSessions = React.useMemo(
    () => (hasQuery ? rankSessions(archivedSessionMetadata, { limit: ARCHIVED_SESSION_LIMIT, titlesOnly: true }) : []),
    [hasQuery, archivedSessionMetadata, rankSessions],
  );

  const scoredFiles = React.useMemo(() => {
    if (!isCommandPaletteOpen) return [];
    return scoreCommandPaletteFiles(fileResults, trimmedQuery, fileSearchKey, fileResultsKey);
  }, [isCommandPaletteOpen, fileResults, fileResultsKey, fileSearchKey, trimmedQuery]);

  const isFileSearchStale = isCommandPaletteOpen && fileSearchKey.length > 0 && fileResultsKey !== fileSearchKey;

  // ---------------------------------------------------------------------------
  // Projects
  // ---------------------------------------------------------------------------
  const scoredProjects = React.useMemo(() => {
    if (!hasQuery) return [];
    const projectEntries = projects.map((project) => ({
      ...project,
      displayName: project.label || project.path.split('/').pop() || project.path,
      searchText: `${project.label || ''} ${project.path}`,
    }));
    const candidates = projectEntries.filter((project) => matchesWordStarts(project.searchText, liveTrimmed));
    return rankBySubsequence(candidates, liveTrimmed, (p) => p.searchText, { limit: 7 }).map(({ item, score, ranges }) => ({ item, score, ...projectRowMatchRanges(item, ranges) }));
  }, [projects, liveTrimmed, hasQuery]);

  // With an empty query the files already open in the editor come first:
  // switching between them is the most common reason to open the palette.
  const contextTabs = useUIStore((s) => (isCommandPaletteOpen && currentRoot ? s.contextPanelByDirectory[currentRoot]?.tabs : undefined));
  const openFiles = React.useMemo<FileHit[]>(() => {
    if (!currentRoot || !contextTabs) return [];
    return contextTabs
      .filter((tab) => tab.mode === 'file' && tab.targetPath)
      .sort((a, b) => b.touchedAt - a.touchedAt)
      .slice(0, 5)
      .flatMap((tab) => {
        const path = normalizePath(tab.targetPath ?? '');
        if (!path) return [];
        const relativePath = path.startsWith(`${currentRoot}/`) ? path.slice(currentRoot.length + 1) : path;
        return [{ path, name: splitRelativePath(relativePath).name, relativePath }];
      });
  }, [contextTabs, currentRoot]);

  const visibleFiles = hasQuery ? scoredFiles : [];
  const visibleProjects = hasQuery ? scoredProjects : [];

  const visibleOpenFiles = hasQuery ? [] : openFiles;

  const groupOrder = React.useMemo<('openFiles' | 'commands' | 'settings' | 'sessions' | 'files' | 'projects' | 'messages')[]>(() => {
    if (!hasQuery) return ['openFiles', 'sessions', 'commands'];
    // Sessions list newest first among equal matches, so the best score is not always the first.
    const best = (arr: { score: number }[]): number => arr.reduce((top, entry) => Math.max(top, entry.score), Number.NEGATIVE_INFINITY);
    const groups: { key: 'commands' | 'settings' | 'sessions' | 'files' | 'projects'; score: number }[] = [
      { key: 'commands', score: best(scoredCommands) },
      { key: 'settings', score: best(scoredSettings) },
      // Archived sessions sit under the active ones, wherever those rank.
      { key: 'sessions', score: best(scoredSessions.length > 0 ? scoredSessions : scoredArchivedSessions) },
      { key: 'files', score: best(scoredFiles) },
      { key: 'projects', score: best(scoredProjects) },
    ];
    groups.sort((a, b) => b.score - a.score);
    // Text inside conversations answers after names do: a session or file
    // called what you typed is the likelier target.
    return [...groups.map((g) => g.key), 'messages'];
  }, [hasQuery, scoredCommands, scoredSettings, scoredSessions, scoredArchivedSessions, scoredFiles, scoredProjects]);

  const handleOpenMessage = React.useCallback(
    (hit: MessageSearchHit) => {
      close();
      requestReasoningReveal(hit.role === 'reasoning' ? hit.id : null);
      void openSessionLink(hit.sessionId, hit.id);
    },
    [close],
  );

  const handleOpenSession = React.useCallback(
    (session: Session) => {
      close();
      setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    },
    [close, setCurrentSession],
  );

  // The same route a link takes: it selects the session and leaves it archived.
  const handleOpenArchivedSession = React.useCallback(
    (session: Session) => {
      close();
      void openSessionLink(session.id, null);
    },
    [close],
  );

  const handleOpenFile = React.useCallback(
    async (filePath: string) => {
      if (!currentRoot) return;
      const validation = await validateContextFileOpen(filesApi, filePath, { directory: currentRoot });
      if (!validation.ok) {
        toastContextFileOpenFailure(filePath, validation);
        return;
      }
      openContextFile(currentRoot, filePath);
      close();
    },
    [currentRoot, filesApi, openContextFile, close],
  );

  const handleOpenProject = React.useCallback(
    (projectId: string, projectPath: string) => {
      close();
      openNewSessionDraft({ selectedProjectId: projectId, directoryOverride: projectPath });
    },
    [close, openNewSessionDraft],
  );

  const shortcut = React.useCallback(
    (actionId: ShortcutActionId) =>
      formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides)),
    [shortcutOverrides],
  );

  // `ranges` are offsets in `relativePath || name`, the text the file matcher ran on.
  const renderFileItem = (file: FileHit, keyPrefix: string, ranges: ReadonlyArray<MatchRange>) => {
    const { name, directory, nameRanges, directoryRanges } = fileRowMatchRanges(file.relativePath || file.name, ranges);
    return (
      <CommandItem
        key={`${keyPrefix}:${file.path}`}
        value={`${keyPrefix}:${file.path}`}
        onSelect={() => {
          void handleOpenFile(file.path);
        }}
      >
        <FileTypeIcon filePath={file.path} className="me-2 size-4 shrink-0" />
        <span className="shrink-0 truncate" aria-label={file.relativePath}>
          <Matched text={name} ranges={nameRanges} />
        </span>
        {directory ? <LeadingTruncated text={directory} ranges={directoryRanges} className="flex-1" /> : null}
      </CommandItem>
    );
  };
  // Message search is opt-in. While it is off the palette says nothing about
  // messages: a line about a feature the user never turned on, on every query,
  // is noise.
  const messageSearchOff = !messageSearchEnabled || (messageSearch.status === 'unavailable' && unavailableStatus === 'off');
  const messageUnavailableStatus = messageSearchOff
    ? null
    : isVSCodeRuntime()
      ? t('search.omni.status.unsupported')
      : messageSearch.status === 'idle' || messageSearch.status === 'too-short'
        ? t('search.omni.status.tooShort')
        : messageSearch.status === 'loading' && messageHits.length === 0
          ? t('search.omni.status.searching')
          : messageSearch.status === 'error' || (messageSearch.status === 'ready' && messageSearch.pageError)
            || archivedMessageSearch.status === 'error' || (archivedMessageSearch.status === 'ready' && archivedMessageSearch.pageError)
            ? t('search.omni.status.error')
            : messageSearch.status === 'unavailable'
              ? unavailableStatus === 'failed'
                ? t('search.omni.status.failed')
                : t('search.omni.status.unsupported')
              : null;
  const messageIndexing = messageSearch.status === 'ready' && messageSearch.index?.backfill.state === 'running'
    ? t('commandPalette.messages.indexing', { done: messageSearch.index.backfill.done, total: messageSearch.index.backfill.total })
    : null;
  const noMessageHits = messageSearch.status === 'ready' && messageHits.length === 0 && archivedMessageHits.length === 0;
  // "No results" would be a claim about messages too, which these states cannot make.
  const messageContentBlocksGlobalEmpty = hasQuery
    && !messageSearchOff
    && (isVSCodeRuntime()
      || messageSearch.status === 'loading'
      || messageSearch.status === 'error'
      || messageSearch.status === 'unavailable'
      || messageIndexing !== null);

  const renderSessionItem = (session: Session, ranges: ReadonlyArray<MatchRange>, onSelect: (session: Session) => void) => {
    // Untitled sessions never match, so their ranges are empty.
    const title = session.title || t('commandPalette.session.untitled');
    const dir = resolveGlobalSessionDirectory(session);
    const branch = branchForSession(session.id, dir);
    const projectLabel = projectLabelForDirectory(dir);
    return (
      <CommandItem key={session.id} value={`session:${session.id}`} onSelect={() => onSelect(session)}>
        <Icon name="chat-ai-3" className="me-2 h-4 w-4" />
        <span dir="auto" className="min-w-0 flex-1 truncate oc-ui-start-align"><Matched text={title} ranges={ranges} /></span>
        {projectLabel ? (
          <span dir="auto" className="max-w-[180px] shrink-0 truncate text-muted-foreground typography-meta">{projectLabel}</span>
        ) : null}
        {branch ? (
          <span className="inline-flex max-w-[160px] shrink-0 items-center gap-1 text-muted-foreground typography-meta">
            <Icon name="git-branch" className="h-3 w-3" />
            <span dir="ltr" className="truncate">{branch}</span>
          </span>
        ) : null}
      </CommandItem>
    );
  };

  return (
    <Dialog
      open={isCommandPaletteOpen}
      onOpenChange={(nextOpen, details) => {
        // Esc leaves the messages view first; a second Esc closes the palette.
        if (!nextOpen && view === 'messages' && details.reason === 'escape-key') {
          details.cancel();
          leaveMessagesView();
          return;
        }
        setCommandPaletteOpen(nextOpen);
      }}
    >
      <DialogHeader className="sr-only">
        <DialogTitle>{t('commandPalette.title')}</DialogTitle>
        <DialogDescription>{t('commandPalette.description')}</DialogDescription>
      </DialogHeader>
      {/* Anchored near the top with a fixed height, so typing never moves the
          input: only the list below it changes. */}
      <DialogContent
        className="gap-0 overflow-hidden p-0 max-w-[min(720px,calc(100vw-2rem))]"
        layerClassName="items-start pt-[12vh]"
        showCloseButton={false}
      >
        <Command
          loop
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:!text-[0.6875rem] [&_[cmdk-group-heading]]:!leading-4 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4 [&_[cmdk-item]]:typography-meta"
        >
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            placeholder={view === 'messages' ? t('commandPalette.messages.placeholder') : t('commandPalette.input.placeholder')}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || view !== 'messages') return;
              if (event.key === 'Escape' || (event.key === 'Backspace' && query.length === 0)) {
                event.preventDefault();
                leaveMessagesView();
              }
            }}
          />
          {view === 'messages' ? (
            <div className="flex items-center border-b border-border px-2 py-1.5">
              <Button type="button" variant="ghost" size="xs" data-palette-messages-back onClick={leaveMessagesView}>
                <Icon name="arrow-left" className="h-3.5 w-3.5 rtl:rotate-180" />
                {t('search.omni.palette.back')}
              </Button>
            </div>
          ) : null}
          {/* The back row takes its height from the list, so the palette keeps its size. */}
          <div className={cn('min-h-0', view === 'messages' ? 'h-[min(403px,calc(60vh-37px))]' : 'h-[min(440px,60vh)]')}>
          <CommandList>
            {view === 'messages' ? (
              <>
                {messageHits.map((hit) => (
                  <MessageHitItem key={`${hit.role}:${hit.id}`} hit={hit} projectLabel={projectLabelForDirectory(hit.directory)} onSelect={handleOpenMessage} />
                ))}
                {messageSearch.status === 'ready' && messageSearch.next ? (
                  <CommandItem value="message:load-more" onSelect={loadMoreMessages} disabled={messageSearch.loadingMore}>
                    <Icon name="more" className="me-2 h-4 w-4" />
                    <span className="truncate text-muted-foreground">{t('commandPalette.messages.loadMore')}</span>
                  </CommandItem>
                ) : null}
                {archivedMessageHits.length > 0 || moreArchivedMessages ? (
                  <CommandGroup heading={t('search.omni.result.archivedTag')}>
                    {archivedMessageHits.map((hit) => (
                      <MessageHitItem key={`${hit.role}:${hit.id}`} hit={hit} projectLabel={projectLabelForDirectory(hit.directory)} onSelect={handleOpenMessage} />
                    ))}
                    {moreArchivedMessages ? (
                      <CommandItem value="message:load-more-archived" onSelect={loadMoreArchivedMessages} disabled={archivedMessageSearch.status === 'ready' && archivedMessageSearch.loadingMore}>
                        <Icon name="more" className="me-2 h-4 w-4" />
                        <span className="truncate text-muted-foreground">{t('commandPalette.messages.loadMore')}</span>
                      </CommandItem>
                    ) : null}
                  </CommandGroup>
                ) : null}
                <div className="px-4 py-2 typography-meta text-muted-foreground" role="status">
                  {messageUnavailableStatus ?? (noMessageHits ? t('search.omni.empty') : null)}
                  {messageIndexing ? ` ${messageIndexing}` : null}
                </div>
              </>
            ) : (
            <>
            {messageContentBlocksGlobalEmpty ? null : <CommandEmpty>{t('commandPalette.empty.noResults')}</CommandEmpty>}

            {groupOrder.map((groupKey) => {
              if (groupKey === 'messages') {
                const canShowAll = messageHits.length > 0 || archivedMessageHits.length > 0 || moreArchivedMessages || (messageSearch.status === 'ready' && messageSearch.next !== null);
                if (!canShowAll && !messageUnavailableStatus && !messageIndexing) return null;
                return (
                  <CommandGroup key="messages" heading={t('commandPalette.group.messages')}>
                    {[...messageHits, ...archivedMessageHits].map((hit) => (
                      <MessageHitItem key={`${hit.role}:${hit.id}`} hit={hit} projectLabel={projectLabelForDirectory(hit.directory)} onSelect={handleOpenMessage} />
                    ))}
                    {canShowAll ? (
                      <CommandItem value="message:show-all" onSelect={() => setView('messages')}>
                        <Icon name="search" className="me-2 h-4 w-4" />
                        <span className="truncate text-muted-foreground">{t('commandPalette.messages.showAll')}</span>
                      </CommandItem>
                    ) : null}
                    {messageUnavailableStatus || messageIndexing ? (
                      <div className="px-2 py-1 typography-meta text-muted-foreground" role="status">
                        {messageUnavailableStatus}
                        {messageIndexing ? ` ${messageIndexing}` : null}
                      </div>
                    ) : null}
                  </CommandGroup>
                );
              }
              if (groupKey === 'openFiles' && visibleOpenFiles.length > 0) {
                return (
                  <CommandGroup key="openFiles" heading={t('commandPalette.group.openFiles')}>
                    {visibleOpenFiles.map((file) => renderFileItem(file, 'open-file', NO_RANGES))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'commands' && scoredCommands.length > 0) {
                return (
                  <CommandGroup key="commands" heading={t('commandPalette.group.commands')}>
                    {scoredCommands.map(({ item: cmd, ranges }) => (
                      <CommandItem key={cmd.id} value={cmd.id} onSelect={cmd.onSelect}>
                        {cmd.icon}
                        <span className="truncate"><Matched text={cmd.title} ranges={ranges} /></span>
                        {cmd.detail ? (
                          <span dir="auto" className="max-w-[180px] shrink-0 truncate text-muted-foreground typography-meta">{cmd.detail}</span>
                        ) : null}
                        {cmd.shortcutId ? (
                          <CommandShortcut>{shortcut(cmd.shortcutId)}</CommandShortcut>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'settings' && scoredSettings.length > 0) {
                return (
                  <CommandGroup key="settings" heading={t('commandPalette.group.settings')}>
                    {/* The matcher ran on "<title> <group> <keywords>"; a match
                        only in the group or keywords leaves the title plain. */}
                    {scoredSettings.map(({ item: cmd, ranges }) => (
                      <CommandItem key={cmd.id} value={cmd.id} onSelect={cmd.onSelect}>
                        {cmd.icon}
                        <span className="truncate"><Matched text={cmd.title} ranges={ranges} /></span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'sessions') {
                return (
                  <React.Fragment key="sessions">
                    {scoredSessions.length > 0 ? (
                      <CommandGroup heading={t('commandPalette.group.sessions')}>
                        {scoredSessions.map(({ item, ranges }) => renderSessionItem(item, ranges, handleOpenSession))}
                      </CommandGroup>
                    ) : null}
                    {scoredArchivedSessions.length > 0 ? (
                      <CommandGroup heading={t('search.omni.result.archivedTag')}>
                        {scoredArchivedSessions.map(({ item, ranges }) => renderSessionItem(item, ranges, handleOpenArchivedSession))}
                      </CommandGroup>
                    ) : null}
                  </React.Fragment>
                );
              }
              if (groupKey === 'files' && visibleFiles.length > 0) {
                return (
                  <CommandGroup key="files" heading={t('commandPalette.group.files')}>
                    {visibleFiles.map(({ item, ranges }) => renderFileItem(item, 'file', ranges))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'projects' && visibleProjects.length > 0) {
                return (
                  <CommandGroup key="projects" heading={t('commandPalette.group.projects')}>
                    {visibleProjects.map(({ item: project, nameRanges, pathRanges }) => (
                      <CommandItem
                        key={`project:${project.id}`}
                        value={`project:${project.id}`}
                        onSelect={() => handleOpenProject(project.id, project.path)}
                      >
                        <Icon name="folder" className="me-2 h-4 w-4" />
                        <span dir="auto" className="shrink-0 truncate"><Matched text={project.displayName} ranges={nameRanges} /></span>
                        <LeadingTruncated text={project.path} ranges={pathRanges} className="flex-1" />
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              return null;
            })}

            {isFileSearchStale ? (
              <div className="px-4 py-2 typography-meta text-muted-foreground">
                {t('commandPalette.empty.searchingFiles')}
              </div>
            ) : null}
            </>
            )}
          </CommandList>
          </div>
          {isMobile ? null : (
          <div className="flex items-center gap-4 border-t border-border px-3 py-1.5 typography-micro text-muted-foreground" aria-hidden="true">
            <span><kbd className="font-sans">↑↓</kbd> {t('commandPalette.footer.navigate')}</span>
            <span><kbd className="font-sans">↵</kbd> {t('commandPalette.footer.open')}</span>
            <span><kbd className="font-sans">esc</kbd> {t('commandPalette.footer.close')}</span>
          </div>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  );
};
