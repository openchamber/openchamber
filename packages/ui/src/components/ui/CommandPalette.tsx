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
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDeviceInfo } from '@/lib/device';
import { RiAddLine, RiChatAi3Line, RiCheckLine, RiCodeLine, RiComputerLine, RiGitBranchLine, RiLayoutLeftLine, RiLayoutRightLine, RiMoonLine, RiQuestionLine, RiSettings3Line, RiSunLine, RiTerminalBoxLine, RiTimeLine } from '@remixicon/react';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import {
  SETTINGS_PAGE_METADATA,
  type SettingsPageGroup,
  type SettingsPageSlug,
  type SettingsRuntimeContext,
} from '@/lib/settings/metadata';
import { useLanguage } from '@/hooks/useLanguage';

export const CommandPalette: React.FC = () => {
  const { t } = useLanguage();
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
    const isDesktop = isDesktopShell();
    return { isVSCode: isVSCodeRuntime(), isWeb: !isDesktop && isWebRuntime(), isDesktop };
  }, []);

  const settingsPages = React.useMemo(() => {
    return SETTINGS_PAGE_METADATA
      .filter((p) => p.slug !== 'home')
      .filter((p) => (p.isAvailable ? p.isAvailable(settingsRuntimeCtx) : true));
  }, [settingsRuntimeCtx]);

  const getSettingsGroupLabel = React.useCallback((group: SettingsPageGroup): string => {
    switch (group) {
      case 'appearance':
        return t('settingsGroups.appearance');
      case 'projects':
        return t('settingsGroups.projects');
      case 'general':
        return t('settingsGroups.general');
      case 'opencode':
        return t('settingsGroups.opencode');
      case 'git':
        return t('settingsGroups.git');
      case 'skills':
        return t('settingsGroups.skills');
      case 'usage':
        return t('settingsGroups.usage');
      case 'advanced':
        return t('settingsGroups.advanced');
      default:
        return group;
    }
  }, [t]);

  const getSettingsPageTitle = React.useCallback((slug: SettingsPageSlug): string => {
    switch (slug) {
      case 'appearance':
        return t('settingsNav.appearance');
      case 'chat':
        return t('settingsNav.chat');
      case 'notifications':
        return t('settingsNav.notifications');
      case 'sessions':
        return t('settingsNav.sessions');
      case 'shortcuts':
        return t('settingsNav.shortcuts');
      case 'git':
        return t('settingsNav.git');
      case 'projects':
        return t('settingsNav.projects');
      case 'remote-instances':
        return t('settingsNav.remoteInstances');
      case 'agents':
        return t('settingsNav.agents');
      case 'commands':
        return t('settingsNav.commands');
      case 'mcp':
        return t('settingsNav.mcp');
      case 'providers':
        return t('settingsNav.providers');
      case 'usage':
        return t('settingsNav.usage');
      case 'skills.installed':
        return t('settingsNav.skills');
      case 'skills.catalog':
        return t('settingsNav.skillsCatalog');
      case 'voice':
        return t('settingsNav.voice');
      case 'tunnel':
        return t('settingsNav.remoteTunnel');
      case 'home':
        return t('settings.title');
      default:
        return t('settings.title');
    }
  }, [t]);

  const settingsItems = React.useMemo(() => {
    return settingsPages
      .slice()
      .sort((a, b) => {
        const g = getSettingsGroupLabel(a.group).localeCompare(getSettingsGroupLabel(b.group));
        if (g !== 0) return g;
        return getSettingsPageTitle(a.slug).localeCompare(getSettingsPageTitle(b.slug));
      });
  }, [getSettingsGroupLabel, getSettingsPageTitle, settingsPages]);

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
      <CommandInput placeholder={t('commandPalette.typeCommandOrSearch')} />
      <CommandList>
        <CommandEmpty>{t('commandPalette.noResultsFound')}</CommandEmpty>

        <CommandGroup heading={t('commandPalette.actions')}>
          <CommandItem onSelect={handleOpenSessionList}>
            <RiLayoutLeftLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openSessionList')}</span>
            <CommandShortcut>{shortcut('toggle_sidebar')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleCreateSession}>
            <RiAddLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.newSession')}</span>
            <CommandShortcut>
              {shortcut('new_chat')}
            </CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleCreateWorktreeSession}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>New Worktree Draft</span>
            <CommandShortcut>
              {shortcut('new_chat_worktree')}
            </CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleRightSidebar}>
            <RiLayoutRightLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.toggleRightSidebar')}</span>
            <CommandShortcut>{shortcut('toggle_right_sidebar')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenRightSidebarGit}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openRightSidebarGit')}</span>
            <CommandShortcut>{shortcut('open_right_sidebar_git')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenRightSidebarFiles}>
            <RiLayoutRightLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openRightSidebarFiles')}</span>
            <CommandShortcut>{shortcut('open_right_sidebar_files')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleTerminalDock}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.toggleTerminalDock')}</span>
            <CommandShortcut>{shortcut('toggle_terminal')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleTerminalExpanded}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.toggleTerminalExpanded')}</span>
            <CommandShortcut>{shortcut('toggle_terminal_expanded')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleShowHelp}>
            <RiQuestionLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.keyboardShortcuts')}</span>
            <CommandShortcut>{shortcut('open_help')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenDiffPanel}>
            <RiCodeLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openDiffPanel')}</span>
            <CommandShortcut>{shortcut('open_diff_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenTerminal}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openTerminal')}</span>
            <CommandShortcut>{shortcut('open_terminal_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenGitPanel}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openGitPanel')}</span>
            <CommandShortcut>{shortcut('open_git_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenTimeline}>
            <RiTimeLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openTimeline')}</span>
            <CommandShortcut>{shortcut('open_timeline')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenSettings}>
            <RiSettings3Line className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openSettings')}</span>
            <CommandShortcut>{shortcut('open_settings')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => handleOpenSettingsPage('skills.catalog')}>
            <RiSettings3Line className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.openSkillsCatalog')}</span>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading={t('commandPalette.settings')}>
          {settingsItems.map((page) => (
            <CommandItem key={page.slug} onSelect={() => handleOpenSettingsPage(page.slug)}>
              <RiSettings3Line className="mr-2 h-4 w-4" />
              <span>{getSettingsGroupLabel(page.group)}: {getSettingsPageTitle(page.slug)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t('commandPalette.theme')}>
          <CommandItem onSelect={() => handleSetThemeMode('light')}>
            <RiSunLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.lightTheme')}</span>
            {themeMode === 'light' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
          <CommandItem onSelect={() => handleSetThemeMode('dark')}>
            <RiMoonLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.darkTheme')}</span>
            {themeMode === 'dark' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
          <CommandItem onSelect={() => handleSetThemeMode('system')}>
            <RiComputerLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.systemTheme')}</span>
            {themeMode === 'system' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
        </CommandGroup>

        {currentSessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('commandPalette.recentSessions')}>
              {currentSessions.map((session) => (
                <CommandItem
                  key={session.id}
                  onSelect={() => handleOpenSession(session.id)}
                >
                  <RiChatAi3Line className="mr-2 h-4 w-4" />
                  <span className="truncate">
                    {session.title || t('commandPalette.untitledSession')}
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
