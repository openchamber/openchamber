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
import { SETTINGS_PAGE_METADATA, SETTINGS_GROUP_LABELS, type SettingsRuntimeContext } from '@/lib/settings/metadata';
import { useTranslation } from 'react-i18next';

export const CommandPalette: React.FC = () => {
  const { t } = useTranslation();
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
      <CommandInput placeholder={t('commandPalette.searchPlaceholder')} />
      <CommandList>
        <CommandEmpty>{t('commandPalette.noResults')}</CommandEmpty>

        <CommandGroup heading={t('commandPalette.groups.actions')}>
          <CommandItem onSelect={handleOpenSessionList}>
            <RiLayoutLeftLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openSessionList')}</span>
            <CommandShortcut>{shortcut('toggle_sidebar')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleCreateSession}>
            <RiAddLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.newSession')}</span>
            <CommandShortcut>
              {shortcut('new_chat')}
            </CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleCreateWorktreeSession}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.newWorktreeDraft')}</span>
            <CommandShortcut>
              {shortcut('new_chat_worktree')}
            </CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleRightSidebar}>
            <RiLayoutRightLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.toggleRightSidebar')}</span>
            <CommandShortcut>{shortcut('toggle_right_sidebar')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenRightSidebarGit}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openRightSidebarGit')}</span>
            <CommandShortcut>{shortcut('open_right_sidebar_git')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenRightSidebarFiles}>
            <RiLayoutRightLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openRightSidebarFiles')}</span>
            <CommandShortcut>{shortcut('open_right_sidebar_files')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleTerminalDock}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.toggleTerminalDock')}</span>
            <CommandShortcut>{shortcut('toggle_terminal')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleToggleTerminalExpanded}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.toggleTerminalExpanded')}</span>
            <CommandShortcut>{shortcut('toggle_terminal_expanded')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleShowHelp}>
            <RiQuestionLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.keyboardShortcuts')}</span>
            <CommandShortcut>{shortcut('open_help')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenDiffPanel}>
            <RiCodeLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openDiffPanel')}</span>
            <CommandShortcut>{shortcut('open_diff_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenTerminal}>
            <RiTerminalBoxLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openTerminal')}</span>
            <CommandShortcut>{shortcut('open_terminal_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenGitPanel}>
            <RiGitBranchLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openGitPanel')}</span>
            <CommandShortcut>{shortcut('open_git_panel')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenTimeline}>
            <RiTimeLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openTimeline')}</span>
            <CommandShortcut>{shortcut('open_timeline')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={handleOpenSettings}>
            <RiSettings3Line className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openSettings')}</span>
            <CommandShortcut>{shortcut('open_settings')}</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => handleOpenSettingsPage('skills.catalog')}>
            <RiSettings3Line className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.actions.openSkillsCatalog')}</span>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading={t('commandPalette.groups.settings')}>
          {settingsItems.map((page) => (
            <CommandItem key={page.slug} onSelect={() => handleOpenSettingsPage(page.slug)}>
              <RiSettings3Line className="mr-2 h-4 w-4" />
              <span>{t(SETTINGS_GROUP_LABELS[page.group])}: {t(page.title)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading={t('commandPalette.groups.theme')}>
          <CommandItem onSelect={() => handleSetThemeMode('light')}>
            <RiSunLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.themes.light')}</span>
            {themeMode === 'light' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
          <CommandItem onSelect={() => handleSetThemeMode('dark')}>
            <RiMoonLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.themes.dark')}</span>
            {themeMode === 'dark' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
          <CommandItem onSelect={() => handleSetThemeMode('system')}>
            <RiComputerLine className="mr-2 h-4 w-4" />
            <span>{t('commandPalette.themes.system')}</span>
            {themeMode === 'system' && <RiCheckLine className="ml-auto h-4 w-4" />}
          </CommandItem>
        </CommandGroup>

        {currentSessions.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading={t('commandPalette.groups.recentSessions')}>
              {currentSessions.map((session) => (
                <CommandItem
                  key={session.id}
                  onSelect={() => handleOpenSession(session.id)}
                >
                  <RiChatAi3Line className="mr-2 h-4 w-4" />
                  <span className="truncate">
                    {session.title || t('header.untitledSession')}
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
