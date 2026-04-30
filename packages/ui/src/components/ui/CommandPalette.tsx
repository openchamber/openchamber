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
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitAllBranches, useGitStore } from '@/stores/useGitStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { toast } from '@/components/ui';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import {
  RiAddLine,
  RiChatAi3Line,
  RiGitBranchLine,
  RiLayoutLeftLine,
  RiLayoutRightLine,
  RiPieChartLine,
  RiSettings3Line,
  RiTerminalBoxLine,
} from '@remixicon/react';
import type { Session } from '@opencode-ai/sdk/v2';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { isDesktopShell, isVSCodeRuntime, isWebRuntime } from '@/lib/desktop';
import { SETTINGS_PAGE_METADATA, type SettingsRuntimeContext } from '@/lib/settings/metadata';
import { getSettingsNavIcon } from '@/components/views/SettingsView';
import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { truncatePathMiddle } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

type CommandEntry = {
  id: string;
  title: string;
  icon: React.ReactNode;
  shortcutId?: string;
  searchText: string;
  onSelect: () => void;
};

type FileHit = { path: string; name: string; relativePath: string };

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
  const setActiveMainTab = useUIStore((s) => s.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((s) => s.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((s) => s.setSettingsPage);
  const setSessionSwitcherOpen = useUIStore((s) => s.setSessionSwitcherOpen);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const toggleRightSidebar = useUIStore((s) => s.toggleRightSidebar);
  const toggleBottomTerminal = useUIStore((s) => s.toggleBottomTerminal);
  const openContextOverview = useUIStore((s) => s.openContextOverview);
  const openContextFile = useUIStore((s) => s.openContextFile);
  const shortcutOverrides = useUIStore((s) => s.shortcutOverrides);

  const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
  const setCurrentSession = useSessionUIStore((s) => s.setCurrentSession);

  const activeSessions = useGlobalSessionsStore((s) => s.activeSessions);
  const currentDirectory = useDirectoryStore((s) => s.currentDirectory);
  const effectiveDirectory = useEffectiveDirectory();
  const searchFiles = useFileSearchStore((s) => s.searchFiles);
  const { files: filesApi, git: gitApi } = useRuntimeAPIs();
  const ensureGitStatus = useGitStore((s) => s.ensureStatus);
  const { isMobile } = useDeviceInfo();

  const currentRoot = React.useMemo(
    () => (effectiveDirectory ? normalizePath(effectiveDirectory) : null),
    [effectiveDirectory],
  );

  const [query, setQuery] = React.useState('');
  const debouncedQuery = useDebouncedValue(query, 200);
  const trimmedQuery = debouncedQuery.trim();
  const liveTrimmed = query.trim();

  // Clear query on open (not close) so content stays visible through the
  // close animation instead of emptying mid-flight.
  React.useEffect(() => {
    if (isCommandPaletteOpen) setQuery('');
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
    (fn: () => void | Promise<void>) => () => {
      close();
      void fn();
    },
    [close],
  );

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  const commands = React.useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = [
      {
        id: 'new-session',
        title: t('commandPalette.item.newSession'),
        icon: <RiAddLine className="mr-2 h-4 w-4" />,
        shortcutId: 'new_chat',
        searchText: t('commandPalette.item.newSession'),
        onSelect: run(() => {
          setActiveMainTab('chat');
          setSessionSwitcherOpen(false);
          openNewSessionDraft();
        }),
      },
      {
        id: 'new-worktree',
        title: t('commandPalette.item.newWorktreeDraft'),
        icon: <RiGitBranchLine className="mr-2 h-4 w-4" />,
        shortcutId: 'new_chat_worktree',
        searchText: t('commandPalette.item.newWorktreeDraft'),
        onSelect: run(() => {
          void createWorktreeSession();
        }),
      },
      {
        id: 'toggle-sidebar',
        title: isMobile
          ? t('commandPalette.item.showSessionSwitcher')
          : t('commandPalette.item.toggleSidebar'),
        icon: <RiLayoutLeftLine className="mr-2 h-4 w-4" />,
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
        id: 'toggle-right-sidebar',
        title: t('commandPalette.item.toggleRightSidebar'),
        icon: <RiLayoutRightLine className="mr-2 h-4 w-4" />,
        shortcutId: 'toggle_right_sidebar',
        searchText: t('commandPalette.item.toggleRightSidebar'),
        onSelect: run(() => toggleRightSidebar()),
      },
      {
        id: 'toggle-terminal',
        title: t('commandPalette.item.toggleTerminal'),
        icon: <RiTerminalBoxLine className="mr-2 h-4 w-4" />,
        shortcutId: 'toggle_terminal',
        searchText: t('commandPalette.item.toggleTerminal'),
        onSelect: run(() => toggleBottomTerminal()),
      },
      {
        id: 'context-usage',
        title: t('commandPalette.item.showContextUsage'),
        icon: <RiPieChartLine className="mr-2 h-4 w-4" />,
        searchText: t('commandPalette.item.showContextUsage'),
        onSelect: run(() => {
          if (currentDirectory) openContextOverview(currentDirectory);
        }),
      },
      {
        id: 'open-settings',
        title: t('commandPalette.item.openSettings'),
        icon: <RiSettings3Line className="mr-2 h-4 w-4" />,
        shortcutId: 'open_settings',
        searchText: t('commandPalette.item.openSettings'),
        onSelect: run(() => setSettingsDialogOpen(true)),
      },
    ];
    return list;
  }, [
    t,
    run,
    isMobile,
    setActiveMainTab,
    setSessionSwitcherOpen,
    openNewSessionDraft,
    toggleSidebar,
    toggleRightSidebar,
    toggleBottomTerminal,
    currentDirectory,
    openContextOverview,
    setSettingsDialogOpen,
  ]);

  // ---------------------------------------------------------------------------
  // Settings sub-pages (only show when there's a query)
  // ---------------------------------------------------------------------------
  const settingsRuntimeCtx = React.useMemo<SettingsRuntimeContext>(() => {
    const isDesktop = isDesktopShell();
    return { isVSCode: isVSCodeRuntime(), isWeb: !isDesktop && isWebRuntime(), isDesktop };
  }, []);

  const settingsEntries = React.useMemo<CommandEntry[]>(() => {
    return SETTINGS_PAGE_METADATA
      .filter((p) => p.slug !== 'home')
      .filter((p) => (p.isAvailable ? p.isAvailable(settingsRuntimeCtx) : true))
      .map((page) => {
        const Icon = getSettingsNavIcon(page.slug) ?? RiSettings3Line;
        const keywords = (page.keywords ?? []).join(' ');
        return {
          id: `settings:${page.slug}`,
          title: page.title,
          icon: <Icon className="mr-2 h-4 w-4" />,
          searchText: `${page.title} ${page.group} ${keywords}`,
          onSelect: run(() => {
            setSettingsPage(page.slug);
            setSettingsDialogOpen(true);
          }),
        } satisfies CommandEntry;
      });
  }, [settingsRuntimeCtx, run, setSettingsPage, setSettingsDialogOpen]);

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------
  const sortedActiveSessions = React.useMemo(() => {
    const getUpdated = (s: Session) =>
      (typeof s.time?.updated === 'number' ? s.time.updated : 0) ||
      (typeof s.time?.created === 'number' ? s.time.created : 0);
    return [...activeSessions].sort((a, b) => getUpdated(b) - getUpdated(a));
  }, [activeSessions]);

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

  // ---------------------------------------------------------------------------
  // File search
  // ---------------------------------------------------------------------------
  const [fileResults, setFileResults] = React.useState<FileHit[]>([]);
  const [isSearchingFiles, setIsSearchingFiles] = React.useState(false);

  React.useEffect(() => {
    if (!isCommandPaletteOpen) {
      setFileResults([]);
      setIsSearchingFiles(false);
      return;
    }
    if (!currentRoot || trimmedQuery.length === 0) {
      setFileResults([]);
      setIsSearchingFiles(false);
      return;
    }
    let cancelled = false;
    setIsSearchingFiles(true);
    void searchFiles(currentRoot, trimmedQuery, 10, { type: 'file' })
      .then((results) => {
        if (cancelled) return;
        setFileResults(
          results.map((file) => ({
            path: normalizePath(file.path),
            name: file.name,
            relativePath: file.relativePath,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setFileResults([]);
      })
      .finally(() => {
        if (!cancelled) setIsSearchingFiles(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isCommandPaletteOpen, currentRoot, trimmedQuery, searchFiles]);

  // ---------------------------------------------------------------------------
  // Filter visible items
  // ---------------------------------------------------------------------------
  const hasQuery = liveTrimmed.length > 0;

  const scoredCommands = React.useMemo(() => {
    if (!hasQuery) return commands.map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(commands, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [commands, liveTrimmed, hasQuery]);

  const scoredSettings = React.useMemo(() => {
    if (!hasQuery) return [];
    return scoreByFuzzyQuery(settingsEntries, liveTrimmed, (c) => c.searchText, {
      limit: 7,
      noFuzzy: true,
    });
  }, [settingsEntries, liveTrimmed, hasQuery]);

  const scoredSessions = React.useMemo(() => {
    if (!hasQuery) return sortedActiveSessions.slice(0, 5).map((item) => ({ item, score: 0 }));
    return scoreByFuzzyQuery(sortedActiveSessions, liveTrimmed, (s) => s.title || '', {
      limit: 7,
      threshold: 0.2,
    });
  }, [sortedActiveSessions, liveTrimmed, hasQuery]);

  const scoredFiles = React.useMemo(() => {
    if (!hasQuery || fileResults.length === 0) return [];
    // Server already ranked by relevance; compute a comparable client score on
    // basename so we can decide file group placement vs sessions/commands.
    return scoreByFuzzyQuery(fileResults, liveTrimmed, (f) => f.name, {
      limit: 10,
      threshold: 0.4,
    });
  }, [fileResults, liveTrimmed, hasQuery]);

  const visibleCommands = scoredCommands.map((x) => x.item);
  const visibleSettings = scoredSettings.map((x) => x.item);
  const visibleSessions = scoredSessions.map((x) => x.item);
  const visibleFiles = hasQuery ? scoredFiles.map((x) => x.item) : [];

  const groupOrder = React.useMemo<('commands' | 'settings' | 'sessions' | 'files')[]>(() => {
    if (!hasQuery) return ['commands', 'sessions'];
    const best = (arr: { score: number }[]): number => (arr.length ? arr[0].score : Infinity);
    const groups: { key: 'commands' | 'settings' | 'sessions' | 'files'; score: number }[] = [
      { key: 'commands', score: best(scoredCommands) },
      { key: 'settings', score: best(scoredSettings) },
      { key: 'sessions', score: best(scoredSessions) },
      { key: 'files', score: best(scoredFiles) },
    ];
    groups.sort((a, b) => a.score - b.score);
    return groups.map((g) => g.key);
  }, [hasQuery, scoredCommands, scoredSettings, scoredSessions, scoredFiles]);

  const handleOpenSession = React.useCallback(
    (session: Session) => {
      close();
      setCurrentSession(session.id, resolveGlobalSessionDirectory(session));
    },
    [close, setCurrentSession],
  );

  const handleOpenFile = React.useCallback(
    async (filePath: string) => {
      if (!currentRoot) return;
      const validation = await validateContextFileOpen(filesApi, filePath);
      if (!validation.ok) {
        toast.error(getContextFileOpenFailureMessage(validation.reason));
        return;
      }
      openContextFile(currentRoot, filePath);
      close();
    },
    [currentRoot, filesApi, openContextFile, close],
  );

  const shortcut = React.useCallback(
    (actionId: string) =>
      formatShortcutForDisplay(getEffectiveShortcutCombo(actionId, shortcutOverrides)),
    [shortcutOverrides],
  );

  return (
    <Dialog open={isCommandPaletteOpen} onOpenChange={setCommandPaletteOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>{t('commandPalette.title')}</DialogTitle>
        <DialogDescription>{t('commandPalette.description')}</DialogDescription>
      </DialogHeader>
      <DialogContent className="overflow-hidden p-0" showCloseButton>
        <Command
          shouldFilter={false}
          className="[&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group]]:px-2 [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-input-wrapper]_svg]:h-4 [&_[cmdk-input-wrapper]_svg]:w-4 [&_[cmdk-input]]:h-8 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]_svg]:h-4 [&_[cmdk-item]_svg]:w-4 [&_[cmdk-item]]:typography-meta"
        >
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t('commandPalette.input.placeholder')}
          />
          <CommandList>
            <CommandEmpty>{t('commandPalette.empty.noResults')}</CommandEmpty>

            {groupOrder.map((groupKey) => {
              if (groupKey === 'commands' && visibleCommands.length > 0) {
                return (
                  <CommandGroup key="commands">
                    {visibleCommands.map((cmd) => (
                      <CommandItem key={cmd.id} value={cmd.id} onSelect={cmd.onSelect}>
                        {cmd.icon}
                        <span>{cmd.title}</span>
                        {cmd.shortcutId ? (
                          <CommandShortcut>{shortcut(cmd.shortcutId)}</CommandShortcut>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'settings' && visibleSettings.length > 0) {
                return (
                  <CommandGroup key="settings">
                    {visibleSettings.map((cmd) => (
                      <CommandItem key={cmd.id} value={cmd.id} onSelect={cmd.onSelect}>
                        {cmd.icon}
                        <span>{cmd.title}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              }
              if (groupKey === 'sessions' && visibleSessions.length > 0) {
                return (
                  <CommandGroup key="sessions">
                    {visibleSessions.map((session) => {
                      const title = session.title || t('commandPalette.session.untitled');
                      const dir = resolveGlobalSessionDirectory(session);
                      const branch = branchForSession(session.id, dir);
                      return (
                        <CommandItem
                          key={session.id}
                          value={`session:${session.id}`}
                          onSelect={() => handleOpenSession(session)}
                        >
                          <RiChatAi3Line className="mr-2 h-4 w-4" />
                          <span className="truncate">{title}</span>
                          {branch ? (
                            <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground typography-meta">
                              <RiGitBranchLine className="h-3 w-3" />
                              <span className="truncate max-w-[160px]">{branch}</span>
                            </span>
                          ) : null}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              if (groupKey === 'files' && visibleFiles.length > 0) {
                return (
                  <CommandGroup key="files">
                    {visibleFiles.map((file) => {
                      const display = truncatePathMiddle(file.relativePath || file.name, {
                        maxLength: 80,
                      });
                      return (
                        <CommandItem
                          key={`file:${file.path}`}
                          value={`file:${file.path}`}
                          onSelect={() => {
                            void handleOpenFile(file.path);
                          }}
                        >
                          <FileTypeIcon filePath={file.path} className="mr-2 size-4 shrink-0" />
                          <span className="truncate" aria-label={file.relativePath}>
                            {display}
                          </span>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                );
              }
              return null;
            })}

            {hasQuery && isSearchingFiles && visibleFiles.length === 0 ? (
              <div className="px-3 py-2 typography-meta text-muted-foreground">
                {t('commandPalette.empty.searchingFiles')}
              </div>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
