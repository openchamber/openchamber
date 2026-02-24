import React from 'react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDeviceInfo } from '@/lib/device';
import { RiAddLine, RiChatAi3Line, RiCheckLine, RiCodeLine, RiComputerLine, RiGitBranchLine, RiLayoutLeftLine, RiLayoutRightLine, RiMoonLine, RiQuestionLine, RiSettings3Line, RiSunLine, RiTerminalBoxLine, RiTimeLine } from '@remixicon/react';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { SETTINGS_PAGE_METADATA, SETTINGS_GROUP_LABELS, type SettingsRuntimeContext } from '@/lib/settings/metadata';

export const CommandPalette: React.FC = () => {
  const {
    isCommandPaletteOpen,
    setCommandPaletteOpen,
    setHelpDialogOpen,
    setActiveMainTab,
    setSettingsDialogOpen,
    setSettingsPage,
    setSessionSwitcherOpen,
    setTimelineDialogOpen,
    toggleSidebar,
    toggleRightSidebar,
    setRightSidebarOpen,
    setRightSidebarTab,
    toggleBottomTerminal,
    setBottomTerminalExpanded,
    isBottomTerminalExpanded,
    shortcutOverrides,
  } = useUIStore();

  const {
    openNewSessionDraft,
    setCurrentSession,
    getSessionsByDirectory,
  } = useSessionStore();

  const settingsAutoCreateWorktree = useConfigStore((state) => state.settingsAutoCreateWorktree);

  const { currentDirectory } = useDirectoryStore();
  const { themeMode, setThemeMode } = useThemeSystem();

  const handleClose = () => {
    setCommandPaletteOpen(false);
  };

  const handleCreateSession = async () => {
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
    openNewSessionDraft();
    handleClose();
  };

  const handleOpenSession = (sessionId: string) => {
    setCurrentSession(sessionId);
    handleClose();
  };

  const handleSetThemeMode = (mode: 'light' | 'dark' | 'system') => {
    setThemeMode(mode);
    handleClose();
  };

  const handleShowHelp = () => {
    setHelpDialogOpen(true);
    handleClose();
  };

  const handleCreateWorktreeSession = () => {
    handleClose();
    createWorktreeSession();
  };

  const { isMobile } = useDeviceInfo();

  const handleOpenSessionList = () => {
    if (isMobile) {
      const { isSessionSwitcherOpen } = useUIStore.getState();
      setSessionSwitcherOpen(!isSessionSwitcherOpen);
    } else {
      toggleSidebar();
    }
    handleClose();
  };

  const handleOpenDiffPanel = () => {
    setActiveMainTab('diff');
    handleClose();
  };

  const handleOpenGitPanel = () => {
    setActiveMainTab('git');
    handleClose();
  };

  const handleOpenTerminal = () => {
    setActiveMainTab('terminal');
    handleClose();
  };

  const handleOpenSettings = () => {
    setSettingsDialogOpen(true);
    handleClose();
  };

  const handleOpenSettingsPage = (slug: string) => {
    setSettingsPage(slug);
    setSettingsDialogOpen(true);
    handleClose();
  };

  const settingsRuntimeCtx = React.useMemo<SettingsRuntimeContext>(() => {
    const isDesktop = typeof window !== 'undefined' && Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__);
    return { isVSCode: isVSCodeRuntime(), isWeb: isWebRuntime(), isDesktop };
  }, []);

  const settingsPages = React.useMemo(() => {
    return SETTINGS_PAGE_METADATA
      .filter((p) => p.slug !== 'home')
      .filter((p) => (p.isAvailable ? p.isAvailable(settingsRuntimeCtx) : true));
  }, [settingsRuntimeCtx]);

  const settingsItems = React.useMemo(() => {
    const groupLabel = (group: string) => (SETTINGS_GROUP_LABELS as Record<string, string>)[group] ?? group;
    return settingsPages
      .slice()
      .sort((a, b) => {
        const g = groupLabel(a.group).localeCompare(groupLabel(b.group));
        if (g !== 0) return g;
        return a.title.localeCompare(b.title);
      });
  }, [settingsPages]);

  const handleToggleRightSidebar = () => {
    toggleRightSidebar();
    handleClose();
  };

  const handleOpenRightSidebarGit = () => {
    setRightSidebarOpen(true);
    setRightSidebarTab('git');
    handleClose();
  };

  const handleOpenRightSidebarFiles = () => {
    setRightSidebarOpen(true);
    setRightSidebarTab('files');
    handleClose();
  };

  const handleToggleTerminalDock = () => {
    toggleBottomTerminal();
    handleClose();
  };

  const handleToggleTerminalExpanded = () => {
    setBottomTerminalExpanded(!isBottomTerminalExpanded);
    handleClose();
  };

  const handleOpenTimeline = () => {
    setTimelineDialogOpen(true);
    handleClose();
  };

  const directorySessions = getSessionsByDirectory(currentDirectory ?? '');
  const currentSessions = React.useMemo(() => {
    return directorySessions.slice(0, 5);
  }, [directorySessions]);

  const shortcut = React.useCallback((actionId: string) => {
    return formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides));
  }, [shortcutOverrides]);

  return (
    <CommandDialog open={isCommandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>

        <CommandGroup heading="Actions">
          <CommandItem onSelect={handleOpenSessionList}>
            <RiLayoutLeftLine className="mr-2 h-4 w-4" />
            <span>Open Session List</span>
            <CommandShortcut>{shortcut('toggle_sidebar')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleCreateSession}>
            <RiAddLine className="mr-2 h-4 w-4" />
            <span>New Session</span>
            <CommandShortcut>
              {settingsAutoCreateWorktree ? shortcut('new_chat_worktree') : shortcut('new_chat')}
            </CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleCreateWorktreeSession}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>New Session with Worktree</span>
            <CommandShortcut>
              {settingsAutoCreateWorktree ? shortcut('new_chat') : shortcut('new_chat_worktree')}
            </CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleRightSidebar}>
            <RiLayoutRightLine className="mr-2 h-4 w-4" />
            <span>Toggle Right Sidebar</span>
            <CommandShortcut>{shortcut('toggle_right_sidebar')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenRightSidebarGit}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>Open Right Sidebar Git</span>
            <CommandShortcut>{shortcut('open_right_sidebar_git')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenRightSidebarFiles}>
            <RiLayoutRightLine className="mr-2 h-4 w-4" />
            <span>Open Right Sidebar Files</span>
            <CommandShortcut>{shortcut('open_right_sidebar_files')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleTerminalDock}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>Toggle Terminal Dock</span>
            <CommandShortcut>{shortcut('toggle_terminal')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleTerminalExpanded}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>Toggle Terminal Expanded</span>
            <CommandShortcut>{shortcut('toggle_terminal_expanded')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleShowHelp}>
            <RiQuestionLine className="mr-2 h-4 w-4" />
            <span>Keyboard Shortcuts</span>
            <CommandShortcut>{shortcut('open_help')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenDiffPanel}>
            <RiCodeLine className="mr-2 h-4 w-4" />
            <span>Open Diff Panel</span>
            <CommandShortcut>{shortcut('open_diff_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenTerminal}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>Open Terminal</span>
            <CommandShortcut>{shortcut('open_terminal_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenGitPanel}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>Open Git Panel</span>
            <CommandShortcut>{shortcut('open_git_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenTimeline}>
            <RiTimeLine className="mr-2 h-4 w-4" />
            <span>Open Timeline</span>
            <CommandShortcut>{shortcut('open_timeline')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenSettings}>
            <RiSettings3Line className="mr-2 h-4 w-4" />
            <span>Open Settings</span>
            <CommandShortcut>{shortcut('open_settings')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => handleOpenSettingsPage('skills.catalog')}>
            <RiSettings3Line className="mr-2 h-4 w-4" />
            <span>Open Skills Catalog</span>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading="Settings">
          {settingsItems.map((page) => (
            <CommandItem key={page.slug} onSelect={() => handleOpenSettingsPage(page.slug)}>
              <RiSettings3Line className="mr-2 h-4 w-4" />
              <span>{SETTINGS_GROUP_LABELS[page.group]}: {page.title}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Theme">
          <CommandItem onSelect={() => handleSetThemeMode('light')}>
            <RiSunLine className="mr-2 h-4 w-4" />
            <span>Light Theme</span>
            {themeMode === 'light' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
          <CommandItem onSelect={() => handleSetThemeMode('dark')}>
            <RiMoonLine className="mr-2 h-4 w-4" />
            <span>Dark Theme</span>
            {themeMode === 'dark' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
          <CommandItem onSelect={() => handleSetThemeMode('system')}>
            <RiComputerLine className="mr-2 h-4 w-4" />
            <span>System Theme</span>
            {themeMode === 'system' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
        </CommandGroup>

        {currentSessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Recent Sessions">
              {currentSessions.map((session) => (
                <CommandItem
                  key={session.id}
                  onSelect={() => handleOpenSession(session.id)}
                >
                  <RiChatAi3Line className="mr-2 h-4 w-4" />
                  <span className="truncate">
                    {session.title || 'Untitled Session'}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {}
      </CommandList>
    </CommandDialog>
  );
};
