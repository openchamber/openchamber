import React from 'react';
import { cn, truncatePathMiddle } from '@/lib/utils';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { ProjectFileSearchHit } from '@/lib/opencode/client';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from "@/components/icon/Icon";
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { isFileMissingError } from '@/lib/api/files-errors';
import {
  filterStaleRecentFiles,
  mentionListState,
  mentionSearchKey,
  mentionServerQuery,
  rankFileMentionResults,
  type FileMentionHit,
} from './fileMentionResults';
import { matchesRankQuery, rankByQuery } from '@/lib/search/fuzzySearch';
import { AutocompleteLoadingRow, AutocompleteRowDetail } from './composer/ui/AutocompleteRowParts';
import { rankSessionMentions } from './sessionMentionResults';
import type { Session } from '@/lib/opencode/model';
import { ensureGlobalSessionsLoaded, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useAutocompleteSelectionScroll } from './composer/ui/useAutocompleteSelectionScroll';
import { useHeightMorph } from '@/lib/motion/useSizeMorph';
import { guestsOfferMentions, searchGuestMentions, type GuestMention } from '@/lib/guests/mentions';
import { useGuestsStore } from '@/lib/guests/store';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { GuestIcon } from '@/components/layout/GuestRailIcon';

/** Subagents listed before the user types; the rest are a keystroke away. */
const AGENTS_SHOWN_WITHOUT_QUERY = 6;

type FileInfo = ProjectFileSearchHit;
type AgentInfo = {
  name: string;
  displayName: string;
  description?: string;
  mode?: string | null;
};

/** The rows the list shows, top to bottom, and the search they answer. */
type MentionRows = {
  key: string | null;
  agents: AgentInfo[];
  moreAgents: boolean;
  recentFiles: FileInfo[];
  results: FileMentionHit[];
  sessions: Session[];
  extensions: GuestMention[];
};

/** The extension's own mark, so a row says whose it is before it is read. */
const ExtensionMentionIcon = ({ guestId }: { guestId: string }) => {
  const icon = useGuestsStore((state) => state.guests.find((guest) => guest.id === guestId)?.icon) ?? '';
  const iconSrc = React.useMemo(
    () => guestPackageIconSrc(guestId, icon, getRuntimeUrlResolver().authenticatedAsset),
    [guestId, icon],
  );
  return <GuestIcon icon={resolveGuestIconName(icon)} iconSrc={iconSrc} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
};

const mentionRowIds = ({ agents, recentFiles, results, sessions, extensions }: MentionRows): string[] => [
  ...agents.map((agent) => `agent:${agent.name}`),
  ...recentFiles.map((file) => `file:${file.path}`),
  ...results.map((file) => `file:${file.path}`),
  ...sessions.map((session) => `session:${session.id}`),
  ...extensions.map((mention) => `extension:${mention.guestId}:${mention.id}`),
];

export interface FileMentionHandle {
  handleKeyDown: (key: string) => void;
}

interface FileMentionAutocompleteProps {
  searchQuery: string;
  onFileSelect: (file: FileInfo) => void;
  onAgentSelect?: (agentName: string) => void;
  /** Lists other sessions by title once the user types; without it, none. */
  onSessionSelect?: (session: Session) => void;
  /** Lists rows from extensions that answer `@`; without it, none. */
  onExtensionMentionSelect?: (mention: GuestMention) => void;
  /** The session being written in, which the session list leaves out. */
  currentSessionId?: string | null;
  onClose: () => void;
  style?: React.CSSProperties;
}

export const FileMentionAutocomplete = React.forwardRef<FileMentionHandle, FileMentionAutocompleteProps>(({
  searchQuery,
  onFileSelect,
  onAgentSelect,
  onSessionSelect,
  onExtensionMentionSelect,
  currentSessionId = null,
  onClose,
  style,
}, ref) => {
  const { t } = useI18n();
  const currentDirectory = useChatSearchDirectory() ?? '';
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const activeProjectPath = useProjectsStore(
    React.useCallback(
      (state) => state.projects.find((project) => project.id === activeProjectId)?.path ?? null,
      [activeProjectId],
    ),
  );
  const projectRoot = React.useMemo(() => {
    const candidate = activeProjectPath || currentDirectory;
    return candidate ? candidate.replace(/\\/g, '/').replace(/\/+$/, '') : null;
  }, [activeProjectPath, currentDirectory]);
  const projectTabs = useFilesViewTabsStore(
    React.useCallback(
      (state) => (projectRoot ? state.byRoot[projectRoot] : undefined),
      [projectRoot],
    ),
  );
  const { files: filesApi } = useRuntimeAPIs();
  const removeUnselectedOpenPath = useFilesViewTabsStore((state) => state.removeUnselectedOpenPath);
  const [staleRecentPaths, setStaleRecentPaths] = React.useState<ReadonlySet<string>>(() => new Set());
  const verifiedPathsRef = React.useRef<Set<string>>(new Set());
  // Subscribed, not read once: the session's directory may still be loading its agents.
  const configAgents = useConfigStore((state) => state.agents);
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const debouncedQuery = useDebouncedValue(searchQuery, 180);
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  // The server's hits, with the search they answer: rows from another query
  // are never shown as this one's.
  const [search, setSearch] = React.useState<{ key: string; files: FileInfo[]; directories: FileInfo[] } | null>(null);
  // Derived, not stored: the subagent list follows the registry, and only the
  // ranking follows the query, in the same render as the keystroke.
  const subagents = React.useMemo<AgentInfo[]>(() => filterVisibleAgents(configAgents)
    .filter((agent) => agent.mode && agent.mode !== 'primary')
    .map((agent) => ({
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      mode: agent.mode,
    }))
    .sort((a, b) => a.name.localeCompare(b.name)), [configAgents]);
  // The trigger lets a space through only for a session title; paths and
  // agent names hold none, so such a query lists sessions alone.
  const sessionsOnly = (searchQuery ?? '').includes(' ');
  const agents = React.useMemo(
    () => sessionsOnly ? [] : rankByQuery(subagents, searchQuery ?? '', (agent) => [agent.name, agent.displayName, agent.description]),
    [searchQuery, sessionsOnly, subagents],
  );
  const searchOptions = { includeHidden: showHidden, respectGitignore: !showGitignored };
  const wantedSearchKey = mentionSearchKey(currentDirectory, searchQuery ?? '', searchOptions);
  const debouncedSearchKey = mentionSearchKey(currentDirectory, debouncedQuery ?? '', searchOptions);
  // From the keystroke until its search answers, debounce included.
  const searchPending = wantedSearchKey !== null && search?.key !== wantedSearchKey;
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const previousViewRef = React.useRef<MentionRows | null>(null);
  const [marqueeWidth, setMarqueeWidth] = React.useState(360);
  // Only the selected row scrolls an overflowing path, so only it is measured.
  const [selectedOverflow, setSelectedOverflow] = React.useState<{ index: number; duration: number } | null>(null);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const { listRef, onKeyboardNavigate } = useAutocompleteSelectionScroll(selectedIndex, itemRefs);
  const labelRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const measureRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  // Narrowing as the user types, the box eases into its new height; its
  // bottom edge stays on the composer (`bottom-full`), so it moves upward.
  useHeightMorph(containerRef);
  const isMobile = useUIStore((state) => state.isMobile);
  // A caret placement brings its own max-height.
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, style?.maxHeight === undefined);
  const normalizedSearchQuery = (searchQuery ?? '').trim();

  React.useEffect(() => {
    setStaleRecentPaths(new Set());
    verifiedPathsRef.current.clear();
  }, [projectRoot]);

  React.useEffect(() => {
    if (currentDirectory) {
      useFileSearchStore.getState().invalidateDirectory(currentDirectory);
    }
  }, [currentDirectory]);

  const recentFiles = React.useMemo(() => {
    if (sessionsOnly || !projectRoot || !projectTabs) {
      return [] as FileInfo[];
    }

    const ordered = [
      projectTabs.selectedPath,
      ...projectTabs.openPaths.slice().reverse(),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    const seen = new Set<string>();
    const mapped = ordered
      .filter((filePath) => {
        if (seen.has(filePath)) return false;
        seen.add(filePath);
        const relative = filePath.startsWith(`${projectRoot}/`) ? filePath.slice(projectRoot.length + 1) : filePath;
        return matchesRankQuery([relative], normalizedSearchQuery);
      })
      .slice(0, 6)
      .map((filePath) => {
        const normalizedPath = filePath.replace(/\\/g, '/');
        const name = normalizedPath.split('/').filter(Boolean).pop() || normalizedPath;
        const relativePath = normalizedPath.startsWith(`${projectRoot}/`)
          ? normalizedPath.slice(projectRoot.length + 1)
          : normalizedPath;
        return {
          name,
          path: normalizedPath,
          relativePath,
          extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined,
        } satisfies FileInfo;
      });

    return mapped;
  }, [normalizedSearchQuery, projectRoot, projectTabs, sessionsOnly]);

  const recentCandidatePathsKey = React.useMemo(
    () => recentFiles.map((file) => file.path).join('\n'),
    [recentFiles],
  );

  React.useEffect(() => {
    if (!projectRoot || !filesApi?.statFile || recentCandidatePathsKey.length === 0) {
      return;
    }

    const candidatePaths = recentCandidatePathsKey.split('\n').filter(Boolean);
    const unverifiedCandidates = candidatePaths.filter((path) => !verifiedPathsRef.current.has(path));
    if (unverifiedCandidates.length === 0) {
      return;
    }

    let cancelled = false;

    void Promise.all(
      unverifiedCandidates.map(async (filePath) => {
        try {
          const stat = await filesApi.statFile?.(filePath, { directory: projectRoot });
          if (cancelled) return;
          verifiedPathsRef.current.add(filePath);
          if (stat && !stat.isFile) {
            setStaleRecentPaths((prev) => {
              if (prev.has(filePath)) return prev;
              const next = new Set(prev);
              next.add(filePath);
              return next;
            });
            removeUnselectedOpenPath(projectRoot, filePath);
          }
        } catch (error) {
          if (cancelled) return;
          verifiedPathsRef.current.add(filePath);
          if (isFileMissingError(error)) {
            setStaleRecentPaths((prev) => {
              if (prev.has(filePath)) return prev;
              const next = new Set(prev);
              next.add(filePath);
              return next;
            });
            removeUnselectedOpenPath(projectRoot, filePath);
          }
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [filesApi, projectRoot, recentCandidatePathsKey, removeUnselectedOpenPath]);

  const visibleAgents = React.useMemo(
    () => normalizedSearchQuery.length > 0 ? agents : agents.slice(0, AGENTS_SHOWN_WITHOUT_QUERY),
    [agents, normalizedSearchQuery.length],
  );
  // Ranked from a snapshot per query (and once more when the list arrives),
  // not the live list: other sessions update all the time, which must neither
  // re-rank thousands of titles nor move the row under the keyboard.
  const sessionsLoaded = useGlobalSessionsStore((state) => state.hasLoaded);
  const listsSessions = onSessionSelect !== undefined;
  React.useEffect(() => {
    if (listsSessions) void ensureGlobalSessionsLoaded().catch(() => undefined);
  }, [listsSessions]);
  const visibleSessions = React.useMemo(() => {
    if (!listsSessions || !sessionsLoaded) return [];
    const { activeSessions, archivedSessions } = useGlobalSessionsStore.getState();
    return rankSessionMentions([...activeSessions, ...archivedSessions], normalizedSearchQuery, { currentSessionId, projectRoot });
  }, [currentSessionId, listsSessions, normalizedSearchQuery, projectRoot, sessionsLoaded]);
  const visibleRecentFiles = React.useMemo(
    () => filterStaleRecentFiles(recentFiles, staleRecentPaths),
    [recentFiles, staleRecentPaths],
  );
  const settledSearch = wantedSearchKey !== null && search?.key === wantedSearchKey ? search : null;
  const visibleResults = React.useMemo(() => {
    if (!settledSearch) return [];
    const recentSet = new Set(visibleRecentFiles.map((file) => file.path));
    const files = settledSearch.files.filter((hit) => !recentSet.has(hit.path));
    return rankFileMentionResults(files, settledSearch.directories, normalizedSearchQuery, 20);
  }, [settledSearch, visibleRecentFiles, normalizedSearchQuery]);
  const settledSearchKey = settledSearch?.key ?? null;
  // Extensions answer on their own time: their rows join the list when they
  // arrive and never hold the files back.
  const asksExtensions = useGuestsStore((state) => onExtensionMentionSelect !== undefined && guestsOfferMentions(state.guests));
  const [extensionRows, setExtensionRows] = React.useState<GuestMention[]>([]);
  React.useEffect(() => {
    if (!asksExtensions) {
      setExtensionRows([]);
      return undefined;
    }
    const controller = new AbortController();
    void searchGuestMentions(debouncedQuery ?? '', currentDirectory || null, controller.signal).then((rows) => {
      if (!controller.signal.aborted) setExtensionRows(rows);
    });
    return () => controller.abort();
  }, [asksExtensions, currentDirectory, debouncedQuery]);
  const liveView = React.useMemo<MentionRows>(() => ({
    key: settledSearchKey,
    agents: visibleAgents,
    moreAgents: visibleAgents.length < agents.length,
    recentFiles: visibleRecentFiles,
    results: visibleResults,
    sessions: visibleSessions,
    extensions: extensionRows,
  }), [agents.length, extensionRows, settledSearchKey, visibleAgents, visibleRecentFiles, visibleResults, visibleSessions]);
  // While a query searches, the popup keeps the last settled rows, so it does
  // not collapse and regrow on every keystroke: its height changes once per
  // answer, by what the answer changed.
  const [heldView, setHeldView] = React.useState(liveView);
  if (!searchPending && heldView !== liveView) {
    setHeldView(liveView);
  }
  const view = searchPending ? heldView : liveView;
  const rowCount = view.agents.length + view.recentFiles.length + view.results.length + view.sessions.length + view.extensions.length;
  const listState = mentionListState(rowCount, searchPending);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) {
        return;
      }
      if (containerRef.current.contains(target)) {
        return;
      }
      onClose();
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  React.useEffect(() => {
    if (debouncedSearchKey === null) {
      return;
    }

    let cancelled = false;
    let answered = false;
    const serverQuery = mentionServerQuery(debouncedQuery ?? '');
    const options = { includeHidden: showHidden, respectGitignore: !showGitignored };
    // A failed kind lists nothing without taking the other kind's hits with it.
    const directorySearch = searchFiles(currentDirectory, serverQuery, 20, { ...options, type: 'directory' }).catch((): FileInfo[] => []);
    // OpenCode's index answers at once; the search behind the hidden and
    // gitignored toggles can walk the project for seconds. Its hits are shown
    // as soon as there are any, and the toggles' extra rows join them later.
    void Promise.all([
      searchFiles(currentDirectory, serverQuery, 80, { type: 'file' }).catch((): FileInfo[] => []),
      directorySearch,
    ]).then(([files, directories]) => {
      if (!cancelled && !answered && files.length + directories.length > 0) {
        setSearch({ key: debouncedSearchKey, files, directories });
      }
    });
    // A new query or a closed list stops that walk; nobody is left to read it.
    const walk = new AbortController();
    void Promise.all([
      searchFiles(currentDirectory, serverQuery, 80, { ...options, type: 'file', signal: walk.signal }).catch((): FileInfo[] => []),
      directorySearch,
    ]).then(([files, directories]) => {
      answered = true;
      if (!cancelled) {
        setSearch({ key: debouncedSearchKey, files, directories });
      }
    });

    return () => {
      cancelled = true;
      walk.abort();
    };
  }, [currentDirectory, debouncedQuery, debouncedSearchKey, searchFiles, showHidden, showGitignored]);

  // A new query's answer starts at its best match; rows held while a query
  // searches keep the selection where the keyboard put it, and new rows for
  // the same query leave it on the row the user is on. Before paint and the
  // next key, so Enter never reads the old position in the new rows.
  React.useLayoutEffect(() => {
    const previous = previousViewRef.current;
    previousViewRef.current = view;
    const selected = previous && view.key !== null && previous.key === view.key
      ? mentionRowIds(previous)[selectedIndexRef.current]
      : undefined;
    setSelectedIndex(selected === undefined ? 0 : Math.max(mentionRowIds(view).indexOf(selected), 0));
    setSelectedOverflow(null);
  }, [view]);

  React.useLayoutEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  React.useEffect(() => {
    let frameId: number | null = null;

    const updateOverflow = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        const node = labelRefs.current[selectedIndex];
        if (!node) {
          setSelectedOverflow(null);
          return;
        }
        const measureNode = measureRefs.current[selectedIndex];
        const fullWidth = measureNode?.offsetWidth ?? node.scrollWidth;
        const overflowPx = Math.max(0, fullWidth - node.clientWidth);
        const duration = Math.max(0.6, overflowPx / 110);
        setSelectedOverflow((current) => {
          if (overflowPx <= 8) return null;
          return current?.index === selectedIndex && current.duration === duration
            ? current
            : { index: selectedIndex, duration };
        });
      });
    };

    updateOverflow();
    window.addEventListener('resize', updateOverflow);

    return () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      window.removeEventListener('resize', updateOverflow);
    };
  }, [selectedIndex, view]);

  React.useEffect(() => {
    const labelNode = labelRefs.current[selectedIndex];
    if (!labelNode) {
      return;
    }

    const updateWidth = () => {
      const width = labelNode.clientWidth;
      if (width > 0) {
        setMarqueeWidth(width);
      }
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(updateWidth);
    observer.observe(labelNode);

    return () => {
      observer.disconnect();
    };
  }, [selectedIndex]);

  const handleFileSelect = React.useCallback((file: FileInfo) => {
    onFileSelect(file);
  }, [onFileSelect]);

  const handleAgentPick = React.useCallback((agentName: string) => {
    onAgentSelect?.(agentName);
  }, [onAgentSelect]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }

      const total = rowCount;
      if (total === 0) {
        return;
      }

      if (key === 'ArrowDown') {
        onKeyboardNavigate();
        setSelectedIndex((prev) => (prev + 1) % total);
        return;
      }

      if (key === 'ArrowUp') {
        onKeyboardNavigate();
        setSelectedIndex((prev) => (prev - 1 + total) % total);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndexRef.current % total) + total) % total;
        if (safeIndex < view.agents.length) {
          const agent = view.agents[safeIndex];
          if (agent) {
            handleAgentPick(agent.name);
          }
          return;
        }
        const recentIndex = safeIndex - view.agents.length;
        const fileCount = view.recentFiles.length + view.results.length;
        if (recentIndex >= fileCount + view.sessions.length) {
          const mention = view.extensions[recentIndex - fileCount - view.sessions.length];
          if (mention) onExtensionMentionSelect?.(mention);
          return;
        }
        if (recentIndex >= fileCount) {
          const session = view.sessions[recentIndex - fileCount];
          if (session) onSessionSelect?.(session);
          return;
        }
        const selectedFile = recentIndex < view.recentFiles.length
          ? view.recentFiles[recentIndex]
          : view.results[recentIndex - view.recentFiles.length];
        if (selectedFile) {
          handleFileSelect(selectedFile);
        }
      }
    }
  }), [view, rowCount, onClose, handleFileSelect, handleAgentPick, onSessionSelect, onExtensionMentionSelect, onKeyboardNavigate]);

  const getFileIcon = (file: FileInfo) => {
    const ext = file.extension?.toLowerCase();
    switch (ext) {
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
        return <Icon name="code" className="h-3.5 w-3.5 text-[var(--status-info)]" />;
      case 'json':
        return <Icon name="code" className="h-3.5 w-3.5 text-[var(--status-warning)]" />;
      case 'md':
      case 'mdx':
        return <Icon name="file" className="h-3.5 w-3.5 text-muted-foreground" />;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
        return <Icon name="file-image" className="h-3.5 w-3.5 text-[var(--status-success)]" />;
      default:
        return <Icon name="file-pdf" className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  return (
      <div
        ref={containerRef}
        className="absolute z-[100] min-w-0 w-full max-w-[560px] max-h-64 oc-glass-popover oc-glass-floating rounded-xl bottom-full mb-2 inset-s-0 flex flex-col"
        style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
      >
        <ScrollableOverlay ref={listRef} preventOverscroll outerClassName="flex-1 min-h-0" className="p-1">
        {listState === 'loading' ? (
          <AutocompleteLoadingRow />
        ) : listState === 'empty' ? (
          <div className="px-2 py-1.5 typography-ui-label text-muted-foreground">
            {t('chat.fileMentionAutocomplete.empty')}
          </div>
        ) : (
          // Rows held from the last query fade only when the search takes
          // long enough to notice; a quick answer just replaces them.
          <div
            data-mention-list=""
            aria-busy={searchPending || undefined}
            className={cn('transition-opacity duration-150', searchPending && 'opacity-60 delay-150')}
          >
            {view.agents.map((agent, index) => {
              const isSelected = selectedIndex === index;
              return (
                <div
                  key={`agent-${agent.name}`}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 cursor-pointer typography-ui-label rounded-lg',
                    isSelected && 'bg-interactive-selection',
                  )}
                  onClick={() => handleAgentPick(agent.name)}
                  onMouseMove={() => { setSelectedIndex(index); }}
                >
                  <span className="max-w-[60%] shrink-0 truncate font-semibold">@{agent.name}</span>
                  <AutocompleteRowDetail description={agent.description} />
                </div>
              );
            })}
            {view.moreAgents && (
              <div className="px-2 py-1 typography-meta text-muted-foreground">
                {t('chat.fileMentionAutocomplete.searchMoreAgents')}
              </div>
            )}
            {view.agents.length > 0 && (view.recentFiles.length > 0 || view.results.length > 0 || view.sessions.length > 0) && (
              <div className="my-1 border-t border-edge" />
            )}
            {view.recentFiles.map((file, index) => {
              const rowIndex = view.agents.length + index;
              const relativePath = file.relativePath || file.name;
              const displayPath = truncatePathMiddle(relativePath, { maxLength: 60 });
              const isSelected = selectedIndex === rowIndex;
              const isOverflowing = selectedOverflow?.index === rowIndex;
              const marqueeDuration = selectedOverflow?.index === rowIndex ? selectedOverflow.duration : 2.6;

              return (
                <div
                  key={`recent-${file.path}`}
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                  className={cn(
                    "flex items-center gap-2 px-2 py-1.5 cursor-pointer typography-ui-label rounded-lg",
                    isSelected && "bg-interactive-selection"
                  )}
                  onClick={() => handleFileSelect(file)}
                  onMouseMove={() => { setSelectedIndex(rowIndex); }}
                >
                  {getFileIcon(file)}
                  <span
                    ref={(el) => { labelRefs.current[rowIndex] = el; }}
                    // Paths read left to right in every language; the marquee and its fade assume it.
                    dir="ltr"
                    className="relative flex-1 min-w-0 overflow-hidden file-mention-marquee-container"
                    style={isSelected ? {
                      ['--file-mention-marquee-width' as string]: `${marqueeWidth}px`,
                      ['--file-mention-marquee-duration' as string]: `${marqueeDuration}s`
                    } : undefined}
                    aria-label={relativePath}
                  >
                    <span
                      ref={(el) => { measureRefs.current[rowIndex] = el; }}
                      className="absolute invisible whitespace-nowrap pointer-events-none"
                      aria-hidden
                    >
                      {relativePath}
                    </span>
                    {isOverflowing && isSelected ? (
                      <span className="inline-block whitespace-nowrap file-mention-marquee">
                        {relativePath}
                      </span>
                    ) : (
                      <span className="block truncate">
                        {displayPath}
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
            {view.recentFiles.length > 0 && view.results.length > 0 && (
              <div className="my-1 border-t border-edge" />
            )}
            {view.results.map((file, index) => {
              const rowIndex = view.agents.length + view.recentFiles.length + index;
              const relativePath = file.relativePath || file.name;
              const displayPath = truncatePathMiddle(relativePath, { maxLength: 60 });
              const isSelected = selectedIndex === rowIndex;
              const isOverflowing = selectedOverflow?.index === rowIndex;
              const marqueeDuration = selectedOverflow?.index === rowIndex ? selectedOverflow.duration : 2.6;

              const item = (
                <div
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 cursor-pointer typography-ui-label rounded-lg",
                      isSelected && "bg-interactive-selection"
                  )}
                  onClick={() => handleFileSelect(file)}
                  onMouseMove={() => { setSelectedIndex(rowIndex); }}
                >
                  {file.kind === 'directory'
                    ? <Icon name="folder-3-fill" className="h-3.5 w-3.5 text-primary/60" />
                    : getFileIcon(file)}
                  <span
                    ref={(el) => { labelRefs.current[rowIndex] = el; }}
                    // Paths read left to right in every language; the marquee and its fade assume it.
                    dir="ltr"
                    className="relative flex-1 min-w-0 overflow-hidden file-mention-marquee-container"
                    style={isSelected ? {
                      ['--file-mention-marquee-width' as string]: `${marqueeWidth}px`,
                      ['--file-mention-marquee-duration' as string]: `${marqueeDuration}s`
                    } : undefined}
                    aria-label={relativePath}
                  >
                    <span
                      ref={(el) => { measureRefs.current[rowIndex] = el; }}
                      className="absolute invisible whitespace-nowrap pointer-events-none"
                      aria-hidden
                    >
                      {relativePath}
                    </span>
                    {isOverflowing && isSelected ? (
                      <span className="inline-block whitespace-nowrap file-mention-marquee">
                        {relativePath}
                      </span>
                    ) : (
                      <span className="block truncate">
                        {displayPath}
                      </span>
                    )}
                  </span>
                </div>
              );

              return (
                <React.Fragment key={`${file.kind}-${file.path}`}>
                  {item}
                </React.Fragment>
              );
            })}
            {view.sessions.length > 0 && (view.recentFiles.length > 0 || view.results.length > 0) && (
              <div className="my-1 border-t border-edge" />
            )}
            {/* After the files: Enter on `@pack` keeps choosing the file it always did. */}
            {view.sessions.map((session, index) => {
              const rowIndex = view.agents.length + view.recentFiles.length + view.results.length + index;
              const directory = resolveGlobalSessionDirectory(session);
              const project = directory ? directory.split('/').filter(Boolean).pop() : null;
              const detail = [project, session.time.archived ? t('chat.fileMentionAutocomplete.sessionArchived') : null].filter(Boolean).join(' · ');
              return (
                <div
                  key={`session-${session.id}`}
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 cursor-pointer typography-ui-label rounded-lg',
                    selectedIndex === rowIndex && 'bg-interactive-selection',
                  )}
                  onClick={() => onSessionSelect?.(session)}
                  onMouseMove={() => { setSelectedIndex(rowIndex); }}
                >
                  <Icon name="chat-3" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="max-w-[60%] shrink-0 truncate font-medium">{session.title}</span>
                  <AutocompleteRowDetail description={detail} />
                </div>
              );
            })}
            {view.extensions.length > 0 && (view.agents.length > 0 || view.recentFiles.length > 0 || view.results.length > 0 || view.sessions.length > 0) && (
              <div className="my-1 border-t border-edge" />
            )}
            {view.extensions.map((mention, index) => {
              const rowIndex = view.agents.length + view.recentFiles.length + view.results.length + view.sessions.length + index;
              return (
                <div
                  key={`extension-${mention.guestId}-${mention.id}`}
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                  className={cn(
                    'flex items-center gap-2 px-2 py-1.5 cursor-pointer typography-ui-label rounded-lg',
                    selectedIndex === rowIndex && 'bg-interactive-selection',
                  )}
                  onClick={() => onExtensionMentionSelect?.(mention)}
                  onMouseMove={() => { setSelectedIndex(rowIndex); }}
                >
                  <ExtensionMentionIcon guestId={mention.guestId} />
                  <span className="max-w-[60%] shrink-0 truncate font-medium">{mention.title}</span>
                  <AutocompleteRowDetail description={mention.subtitle ?? mention.label} />
                </div>
              );
            })}
          </div>
        )}
        </ScrollableOverlay>
        {!isMobile && (
          <div className="px-3 py-1.5 border-t typography-meta text-muted-foreground">
            {t('chat.autocomplete.keyboardHint')}
          </div>
        )}
    </div>
  );
});
