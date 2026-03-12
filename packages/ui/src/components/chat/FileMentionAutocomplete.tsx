import React from 'react';
import { RiCodeLine, RiFileImageLine, RiFileLine, RiFilePdfLine, RiRefreshLine } from '@remixicon/react';
import { cn, truncatePathMiddle } from '@/lib/utils';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import type { ProjectFileSearchHit } from '@/lib/opencode/client';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';

type FileInfo = ProjectFileSearchHit;
type AgentInfo = {
  name: string;
  description?: string;
  mode?: string | null;
};

export interface FileMentionHandle {
  handleKeyDown: (key: string) => void;
}

type AutocompleteTab = 'commands' | 'agents' | 'files';

interface FileMentionAutocompleteProps {
  searchQuery: string;
  onFileSelect: (file: FileInfo) => void;
  onAgentSelect?: (agentName: string) => void;
  onClose: () => void;
  showTabs?: boolean;
  activeTab?: AutocompleteTab;
  onTabSelect?: (tab: AutocompleteTab) => void;
  style?: React.CSSProperties;
}

export const FileMentionAutocomplete = React.forwardRef<FileMentionHandle, FileMentionAutocompleteProps>(({
  searchQuery,
  onFileSelect,
  onAgentSelect,
  onClose,
  showTabs,
  activeTab = 'files',
  onTabSelect,
  style,
}, ref) => {
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
  const { getVisibleAgents } = useConfigStore();
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const debouncedQuery = useDebouncedValue(searchQuery, 180);
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const [files, setFiles] = React.useState<FileInfo[]>([]);
  const [agents, setAgents] = React.useState<AgentInfo[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const [marqueeWidth, setMarqueeWidth] = React.useState(360);
  const [overflowMap, setOverflowMap] = React.useState<Record<number, boolean>>({});
  const [marqueeDurations, setMarqueeDurations] = React.useState<Record<number, number>>({});
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const labelRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const measureRefs = React.useRef<(HTMLSpanElement | null)[]>([]);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const ignoreTabClickRef = React.useRef(false);
  const normalizedSearchQuery = (searchQuery ?? '').trim();
  const visibleAgents = normalizedSearchQuery.length > 0 ? agents : agents.slice(0, 2);

  const recentFiles = React.useMemo(() => {
    if (!projectRoot || !projectTabs) {
      return [] as FileInfo[];
    }

    const ordered = [
      projectTabs.selectedPath,
      ...projectTabs.openPaths.slice().reverse(),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);

    const seen = new Set<string>();
    const queryLower = normalizedSearchQuery.toLowerCase();
    const mapped = ordered
      .filter((filePath) => {
        if (seen.has(filePath)) return false;
        seen.add(filePath);
        const relative = filePath.startsWith(`${projectRoot}/`) ? filePath.slice(projectRoot.length + 1) : filePath;
        if (!queryLower) return true;
        return relative.toLowerCase().includes(queryLower);
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
  }, [normalizedSearchQuery, projectRoot, projectTabs]);

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
    if (!currentDirectory) {
      setFiles([]);
      setLoading(false);
      return;
    }

    const normalizedQuery = (debouncedQuery ?? '').trim();
    const normalizedQueryLower = normalizedQuery
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .toLowerCase();

    if (!normalizedQueryLower) {
      setFiles([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    searchFiles(currentDirectory, normalizedQueryLower, 80, {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
      type: 'file',
    })
      .then((hits) => {
        if (cancelled) {
          return;
        }

        const recentSet = new Set(recentFiles.map((file) => file.path));
        setFiles(hits.filter((hit) => !recentSet.has(hit.path)).slice(0, 15));
      })
      .catch(() => {
        if (!cancelled) {
          setFiles([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentDirectory, debouncedQuery, recentFiles, searchFiles, showHidden, showGitignored]);

  React.useEffect(() => {
    const visibleAgents = getVisibleAgents();
    const normalizedQuery = (searchQuery ?? '').trim().toLowerCase();
    const filtered = visibleAgents
      .filter((agent) => agent.mode && agent.mode !== 'primary')
      .filter((agent) => {
        if (!normalizedQuery) return true;
        const haystack = `${agent.name} ${agent.description ?? ''}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      })
      .map((agent) => ({
        name: agent.name,
        description: agent.description,
        mode: agent.mode,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    setAgents(filtered);
  }, [getVisibleAgents, searchQuery]);

  React.useEffect(() => {
    setSelectedIndex(0);
    setOverflowMap({});
    setMarqueeDurations({});
  }, [files, recentFiles.length, visibleAgents.length]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest'
    });
  }, [selectedIndex]);

  React.useEffect(() => {
    let frameId: number | null = null;

    const updateOverflow = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(() => {
        const next: Record<number, boolean> = {};
        const durations: Record<number, number> = {};
        labelRefs.current.forEach((node, index) => {
          if (!node) {
            return;
          }
          const measureNode = measureRefs.current[index];
          const fullWidth = measureNode?.offsetWidth ?? node.scrollWidth;
          const overflowPx = Math.max(0, fullWidth - node.clientWidth);
          const isOverflowing = overflowPx > 8;
          next[index] = isOverflowing;
          if (isOverflowing) {
            const duration = Math.max(0.6, overflowPx / 110);
            durations[index] = duration;
          }
        });
        setOverflowMap(next);
        setMarqueeDurations(durations);
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
  }, [files]);

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

      const total = visibleAgents.length + recentFiles.length + files.length;
      if (total === 0) {
        return;
      }

      if (key === 'ArrowDown') {
        setSelectedIndex((prev) => (prev + 1) % total);
        return;
      }

      if (key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + total) % total);
        return;
      }

      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndex % total) + total) % total;
        if (safeIndex < visibleAgents.length) {
          const agent = visibleAgents[safeIndex];
          if (agent) {
            handleAgentPick(agent.name);
          }
          return;
        }
        const fileIndex = safeIndex - visibleAgents.length;
        const selectedFile = fileIndex < recentFiles.length
          ? recentFiles[fileIndex]
          : files[fileIndex - recentFiles.length];
        if (selectedFile) {
          handleFileSelect(selectedFile);
        }
      }
    }
  }), [files, recentFiles, visibleAgents, selectedIndex, onClose, handleFileSelect, handleAgentPick]);

  const getFileIcon = (file: FileInfo) => {
    const ext = file.extension?.toLowerCase();
    switch (ext) {
      case 'ts':
      case 'tsx':
      case 'js':
      case 'jsx':
        return <RiCodeLine className="h-3.5 w-3.5 text-[var(--status-info)]" />;
      case 'json':
        return <RiCodeLine className="h-3.5 w-3.5 text-[var(--status-warning)]" />;
      case 'md':
      case 'mdx':
        return <RiFileLine className="h-3.5 w-3.5 text-muted-foreground" />;
      case 'png':
      case 'jpg':
      case 'jpeg':
      case 'gif':
      case 'svg':
        return <RiFileImageLine className="h-3.5 w-3.5 text-[var(--status-success)]" />;
      default:
        return <RiFilePdfLine className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  return (
      <div
        ref={containerRef}
        className="absolute z-[100] min-w-0 w-full max-w-[640px] max-h-64 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col"
        style={style}
      >
        {showTabs ? (
          <div className="px-2 pt-2 pb-1 border-b border-border/60">
            <div className="flex items-center gap-1 rounded-lg bg-[var(--surface-elevated)] p-1">
              {([
                { id: 'commands' as const, label: 'Commands' },
                { id: 'agents' as const, label: 'Agents' },
                { id: 'files' as const, label: 'Files' },
              ]).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={cn(
                    'flex-1 px-2.5 py-1 rounded-md typography-meta font-semibold transition-none',
                    activeTab === tab.id
                      ? 'bg-interactive-selection text-interactive-selection-foreground shadow-none'
                      : 'text-muted-foreground hover:bg-interactive-hover/50'
                  )}
                  onPointerDown={(event) => {
                    if (event.pointerType !== 'touch') {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    ignoreTabClickRef.current = true;
                    onTabSelect?.(tab.id);
                  }}
                  onClick={() => {
                    if (ignoreTabClickRef.current) {
                      ignoreTabClickRef.current = false;
                      return;
                    }
                    onTabSelect?.(tab.id);
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <ScrollableOverlay outerClassName="flex-1 min-h-0" className="px-0">
        {loading ? (
          <div className="flex items-center justify-center py-4">
            <RiRefreshLine className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="pb-2">
            {visibleAgents.map((agent, index) => {
              const isSelected = selectedIndex === index;
              return (
                <div
                  key={`agent-${agent.name}`}
                  ref={(el) => { itemRefs.current[index] = el; }}
                  className={cn(
                    'flex items-start gap-2 px-3 py-1.5 cursor-pointer typography-ui-label rounded-lg',
                    isSelected && 'bg-interactive-selection',
                  )}
                  onClick={() => handleAgentPick(agent.name)}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate">@{agent.name}</div>
                    {agent.description ? (
                      <div className="typography-meta text-muted-foreground truncate">{agent.description}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
            {visibleAgents.length === 2 && normalizedSearchQuery.length === 0 && agents.length > 2 && (
              <div className="px-3 py-1 typography-meta text-muted-foreground">
                Type to search more agents
              </div>
            )}
            {visibleAgents.length > 0 && (recentFiles.length > 0 || files.length > 0) && (
              <div className="my-1 border-t border-border/60" />
            )}
            {recentFiles.map((file, index) => {
              const rowIndex = visibleAgents.length + index;
              const relativePath = file.relativePath || file.name;
              const displayPath = truncatePathMiddle(relativePath, { maxLength: 60 });
              const isSelected = selectedIndex === rowIndex;
              const isOverflowing = overflowMap[rowIndex] ?? false;
              const marqueeDuration = marqueeDurations[rowIndex] ?? 2.6;

              return (
                <div
                  key={`recent-${file.path}`}
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 cursor-pointer typography-ui-label rounded-lg",
                    isSelected && "bg-interactive-selection"
                  )}
                  onClick={() => handleFileSelect(file)}
                  onMouseEnter={() => setSelectedIndex(rowIndex)}
                >
                  {getFileIcon(file)}
                  <span
                    ref={(el) => { labelRefs.current[rowIndex] = el; }}
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
            {recentFiles.length > 0 && files.length > 0 && (
              <div className="my-1 border-t border-border/60" />
            )}
            {files.map((file, index) => {
              const rowIndex = visibleAgents.length + recentFiles.length + index;
              const relativePath = file.relativePath || file.name;
              const displayPath = truncatePathMiddle(relativePath, { maxLength: 60 });
              const isSelected = selectedIndex === rowIndex;
              const isOverflowing = overflowMap[rowIndex] ?? false;
              const marqueeDuration = marqueeDurations[rowIndex] ?? 2.6;

              const item = (
                <div
                  ref={(el) => { itemRefs.current[rowIndex] = el; }}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 cursor-pointer typography-ui-label rounded-lg",
                      isSelected && "bg-interactive-selection"
                    )}
                  onClick={() => handleFileSelect(file)}
                  onMouseEnter={() => setSelectedIndex(rowIndex)}
                >
                  {getFileIcon(file)}
                  <span
                    ref={(el) => { labelRefs.current[rowIndex] = el; }}
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
                <React.Fragment key={file.path}>
                  {item}
                </React.Fragment>
              );
            })}
            {files.length === 0 && recentFiles.length === 0 && visibleAgents.length === 0 && (
              <div className="px-3 py-2 typography-ui-label text-muted-foreground">
                No matches found
              </div>
            )}
          </div>
        )}
        </ScrollableOverlay>
        <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
        ↑↓ navigate • Enter select • Esc close
      </div>
    </div>
  );
});
