import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { RiCloseLine, RiFolder6Line, RiSearchLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn, truncatePathMiddle } from '@/lib/utils';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import { useDeviceInfo } from '@/lib/device';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
interface FileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  extension?: string;
  relativePath?: string;
}

interface ServerFilePickerProps {
  onFilesSelected: (files: FileInfo[]) => void;
  multiSelect?: boolean;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  presentation?: 'dropdown' | 'modal';
}

export const ServerFilePicker: React.FC<ServerFilePickerProps> = ({
  onFilesSelected,
  multiSelect = false,
  children,
  open: controlledOpen,
  onOpenChange,
  presentation = 'dropdown',
}) => {
  const { isMobile } = useDeviceInfo();
  // Only use mobile panels on actual mobile devices, VSCode uses desktop dropdowns
  const isCompact = isMobile;
  const { currentDirectory } = useDirectoryStore();
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false);
  const [cacheNonce, setCacheNonce] = React.useState(0);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const [selectedFiles, setSelectedFiles] = React.useState<Set<string>>(new Set());
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(new Set());
  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileInfo[]>>({});
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const inFlightDirsRef = React.useRef<Set<string>>(new Set());
  const [inFlightDirs, setInFlightDirs] = React.useState<Set<string>>(new Set());
  const [searchResults, setSearchResults] = React.useState<FileInfo[]>([]);
  const [searching, setSearching] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [attaching, setAttaching] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const open = controlledOpen ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;

  const updateInFlightDirs = React.useCallback((next: Set<string>) => {
    inFlightDirsRef.current = next;
    setInFlightDirs(next);
  }, []);

  const sortDirectoryItems = React.useCallback((items: FileInfo[]) => (
    items.slice().sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    })
  ), []);

  const mapFilesystemEntries = React.useCallback((dirPath: string, entries: Array<{ name: string; path: string; isDirectory: boolean }>): FileInfo[] => (
    sortDirectoryItems(entries
      .filter((item) => showHidden || !item.name.startsWith('.'))
      .map((item) => {
        const name = item.name;
        const extension = !item.isDirectory && name.includes('.')
          ? name.split('.').pop()?.toLowerCase()
          : undefined;
        return {
          name,
          path: item.path || `${dirPath}/${name}`,
          type: item.isDirectory ? 'directory' : 'file',
          size: 0,
          extension,
        };
      }))
  ), [sortDirectoryItems, showHidden]);

  const loadDirectory = React.useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    await opencodeClient.listLocalDirectory(dirPath, { respectGitignore: !showGitignored })
      .then((entries) => {
        const items = mapFilesystemEntries(dirPath, entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
        })));

        loadedDirsRef.current = new Set([dirPath]);
        updateInFlightDirs(new Set());
        setChildrenByDir({ [dirPath]: items });
        setExpandedDirs(new Set());
      })
      .catch(() => {
        setError('Failed to load directory contents');
        loadedDirsRef.current = new Set([dirPath]);
        updateInFlightDirs(new Set());
        setChildrenByDir({ [dirPath]: [] });
        setExpandedDirs(new Set());
      })
      .finally(() => {
        setLoading(false);
      });
  }, [mapFilesystemEntries, showGitignored, updateInFlightDirs]);

  const loadDirectoryChildren = React.useCallback(async (dirPath: string) => {
    const normalizedDir = dirPath.trim();
    if (!normalizedDir) {
      return;
    }
    const cacheKey = `${normalizedDir}::${cacheNonce}`;
    if (loadedDirsRef.current.has(cacheKey)) {
      return;
    }
    if (inFlightDirsRef.current.has(cacheKey)) {
      return;
    }

    const nextInFlight = new Set(inFlightDirsRef.current);
    nextInFlight.add(cacheKey);
    updateInFlightDirs(nextInFlight);

    await opencodeClient.listLocalDirectory(normalizedDir, { respectGitignore: !showGitignored })
      .then((entries) => {
        const items = mapFilesystemEntries(normalizedDir, entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
        })));

        loadedDirsRef.current = new Set(loadedDirsRef.current);
        loadedDirsRef.current.add(cacheKey);
        setChildrenByDir((prev) => ({
          ...prev,
          [normalizedDir]: items,
        }));
      })
      .catch(() => {
        setChildrenByDir((prev) => {
          if (prev[normalizedDir]) {
            return prev;
          }
          return {
            ...prev,
            [normalizedDir]: [],
          };
        });
      })
      .finally(() => {
        const updatedInFlightDirs = new Set(inFlightDirsRef.current);
        updatedInFlightDirs.delete(cacheKey);
        updateInFlightDirs(updatedInFlightDirs);
      });
  }, [mapFilesystemEntries, showGitignored, cacheNonce, updateInFlightDirs]);

  React.useEffect(() => {
    if ((open || mobileOpen) && currentDirectory) {
      void loadDirectory(currentDirectory);
    }
  }, [open, mobileOpen, currentDirectory, loadDirectory]);

  React.useEffect(() => {
    setCacheNonce((prev) => prev + 1);
  }, [showHidden, showGitignored]);

  React.useEffect(() => {
    if (!(open || mobileOpen) || !currentDirectory) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const trimmedQuery = debouncedSearchQuery
      .trim()
      .replace(/^\.\//, '')
      .replace(/^\/+/, '');
    if (!trimmedQuery) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const normalizedQuery = trimmedQuery.toLowerCase();

    let cancelled = false;
    setSearching(true);

    searchFiles(currentDirectory, normalizedQuery, 150, {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
    })
      .then((hits) => {
        if (cancelled) {
          return;
        }
        const mappedHits: FileInfo[] = hits.map((hit) => ({
          name: hit.name,
          path: hit.path,
          type: 'file',
          extension: hit.extension,
          relativePath: hit.relativePath,
          size: 0,
        }));
        setSearchResults(mappedHits);
      })
      .catch(() => {
        if (!cancelled) {
          setSearchResults([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, mobileOpen, currentDirectory, debouncedSearchQuery, searchFiles, showHidden, showGitignored]);

  React.useEffect(() => {
    if (!open && !mobileOpen) {
      setSelectedFiles(new Set());
      setSearchQuery('');
      setSearchResults([]);
      setSearching(false);
      loadedDirsRef.current = new Set();
      updateInFlightDirs(new Set());
      setChildrenByDir({});
      setExpandedDirs(new Set());
    }
  }, [open, mobileOpen, updateInFlightDirs]);

  const getFileIcon = (file: FileInfo) => {
    if (file.type === 'directory') {
      return expandedDirs.has(file.path) ? (
        <RiFolder6Line className="h-3.5 w-3.5 text-primary/60" />
      ) : (
        <RiFolder6Line className="h-3.5 w-3.5 text-primary/60" />
      );
    }

    return <FileTypeIcon filePath={file.path} extension={file.extension} className="h-3.5 w-3.5" />;
  };

  const toggleDirectory = async (dirPath: string) => {
    const isExpanded = expandedDirs.has(dirPath);

    if (isExpanded) {
      setExpandedDirs(prev => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    } else {
      setExpandedDirs((prev) => {
        const next = new Set(prev);
        next.add(dirPath);
        return next;
      });

      await loadDirectoryChildren(dirPath);
    }
  };

  const toggleFileSelection = (filePath: string) => {
    if (multiSelect) {
      setSelectedFiles(prev => {
        const next = new Set(prev);
        if (next.has(filePath)) {
          next.delete(filePath);
        } else {
          next.add(filePath);
        }
        return next;
      });
    } else {
      setSelectedFiles(new Set([filePath]));
    }
  };

  const handleConfirm = async () => {
    const treeFileMap = new Map<string, FileInfo>();
    Object.values(childrenByDir).forEach((items) => {
      items.forEach((file) => {
        if (file.type === 'file') {
          treeFileMap.set(file.path, file);
        }
      });
    });
    const searchFileMap = new Map(searchResults.map((file) => [file.path, file]));

    const selected = Array.from(selectedFiles)
      .map((filePath) => treeFileMap.get(filePath) ?? searchFileMap.get(filePath))
      .filter((file): file is FileInfo => Boolean(file));

    setAttaching(true);
    await Promise.resolve(onFilesSelected(selected))
      .then(() => {
        setSelectedFiles(new Set());
        setOpen(false);
        setMobileOpen(false);
      })
      .finally(() => {
        setAttaching(false);
      });
  };

  const rootItems = React.useMemo(() => {
    if (!currentDirectory) {
      return [];
    }
    return childrenByDir[currentDirectory] ?? [];
  }, [childrenByDir, currentDirectory]);

  const isSearchActive = searchQuery.trim().length > 0;

  const getChildItems = (parentPath: string) => {
    return childrenByDir[parentPath] ?? [];
  };

  const getRelativePath = (fullPath: string) => {
    if (currentDirectory && fullPath.startsWith(currentDirectory)) {
      const relativePath = fullPath.substring(currentDirectory.length);
      return relativePath.startsWith('/') ? relativePath.substring(1) : relativePath;
    }
    return fullPath.split('/').pop() || fullPath;
  };

  const renderFileItem = (file: FileInfo, level: number) => {
    const rawLabel = isSearchActive
      ? file.relativePath || getRelativePath(file.path)
      : file.name;
    const shouldCompact = isSearchActive && rawLabel.includes('/') && rawLabel.length > 45;
    const displayLabel = shouldCompact
      ? truncatePathMiddle(rawLabel, { maxLength: isCompact ? 42 : 48 })
      : rawLabel;

    const row = (
      <div
        className={cn(
          "flex w-full items-center justify-start gap-1 px-2 py-1.5 rounded hover:bg-interactive-hover cursor-pointer typography-ui-label text-foreground text-left",
          file.type === 'file' && selectedFiles.has(file.path) && "bg-primary/10"
        )}
        style={{ paddingLeft: `${level * 12}px` }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (file.type === 'file') {
            toggleFileSelection(file.path);
          }
        }}
      >
        <div className="flex flex-1 items-center justify-start gap-1">
          <span className="text-muted-foreground">{getFileIcon(file)}</span>
          <span className="flex-1 truncate text-foreground text-left max-w-[360px]" aria-label={rawLabel}>
            {displayLabel}
          </span>
        </div>
        {file.type === 'file' && selectedFiles.has(file.path) && (
          <div className="h-1.5 w-1.5 rounded-full bg-primary" />
        )}
      </div>
    );

    if (!shouldCompact) {
      return React.cloneElement(row, { key: file.path });
    }

    return (
      <Tooltip key={file.path} delayDuration={120}>
        <TooltipTrigger asChild>{row}</TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <span className="typography-meta text-foreground/80 whitespace-pre-wrap break-all">
            {rawLabel}
          </span>
        </TooltipContent>
      </Tooltip>
    );
  };

  const renderFileTree = (file: FileInfo, level: number): React.ReactNode => {
    const isDirectory = file.type === 'directory';
    const children = isDirectory ? getChildItems(file.path) : [];
    const isExpanded = expandedDirs.has(file.path);
    const isLoadingChildren = isDirectory && isExpanded && inFlightDirs.has(file.path) && children.length === 0;

    return (
      <div key={file.path}>
        <button
          type="button"
        className={cn(
            'flex w-full items-center justify-start gap-1 px-2 py-1.5 rounded cursor-pointer typography-ui-label text-foreground text-left',
            !isDirectory && selectedFiles.has(file.path) && 'bg-primary/10'
          )}
          style={{ paddingLeft: `${level * 12}px` }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (isDirectory) {
              void toggleDirectory(file.path);
            } else {
              toggleFileSelection(file.path);
            }
          }}
        >
          <span className="text-muted-foreground">{getFileIcon(file)}</span>
          <span className="flex-1 truncate text-foreground text-left">
            {file.name}
          </span>
          {!isDirectory && selectedFiles.has(file.path) && (
            <div className="h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </button>

        {isDirectory && isExpanded && children.length > 0 && (
          <div>
            {children.map((child) => renderFileTree(child, level + 1))}
          </div>
        )}

        {isDirectory && isExpanded && isLoadingChildren && (
          <div
            className="px-2 py-1.5 typography-ui-label text-muted-foreground"
            style={{ paddingLeft: `${(level + 1) * 12}px` }}
          >
            Loading…
          </div>
        )}
      </div>
    );
  };

  const summaryLabel = selectedFiles.size > 0
    ? `${selectedFiles.size} file${selectedFiles.size !== 1 ? 's' : ''} selected`
    : 'No files selected';

  const summarySection = (
    <div className="flex items-center justify-between px-3 py-2 shrink-0">
      <div className="typography-meta text-muted-foreground">{summaryLabel}</div>
      <Button
        size="sm"
        onClick={handleConfirm}
        disabled={selectedFiles.size === 0 || attaching}
        className="h-6 typography-meta"
      >
        {attaching ? 'Attaching...' : 'Attach Files'}
      </Button>
    </div>
  );

  const scrollAreaClass = isCompact ? 'flex-1 min-h-[240px]' : 'h-[300px]';

  const pickerBody = (
    <>
      <div className="px-3 py-2 border-b shrink-0">
        <div className="font-medium typography-ui-label text-foreground">Select Project Files</div>
      </div>
      <div className="px-3 py-2 border-b shrink-0">
        <div className="relative">
          <RiSearchLine className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search files..."
            className="pl-7 h-6 typography-ui-label"
            onClick={(e) => e.stopPropagation()}
          />
          {searchQuery && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setSearchQuery('');
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-interactive-hover rounded"
            >
              <RiCloseLine className="h-3 w-3"/>
            </button>
          )}
        </div>
      </div>
      <ScrollArea className={scrollAreaClass}>
        {loading && (
          <div className="flex items-center justify-center py-8">
            <div className="typography-ui-label text-muted-foreground">Loading files...</div>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center py-8">
            <div className="typography-ui-label text-destructive">{error}</div>
          </div>
        )}

        {!loading && !error && (
          <div className="py-1 px-2">
            {isSearchActive ? (
              searching ? (
                <div className="px-3 py-4 typography-ui-label text-muted-foreground text-center">
                  Searching files…
                </div>
              ) : (
                searchResults.map((file) => renderFileItem(file, 0))
              )
            ) : (
              rootItems.map((file) => renderFileTree(file, 0))
            )}

            {!isSearchActive && rootItems.length === 0 && (
              <div className="px-3 py-4 typography-ui-label text-muted-foreground text-center">
                No files in this directory
              </div>
            )}

            {isSearchActive && !searching && searchResults.length === 0 && (
              <div className="px-3 py-4 typography-ui-label text-muted-foreground text-center">
                No files found
              </div>
            )}
          </div>
        )}
      </ScrollArea>
    </>
  );

  const mobileTrigger = (
    <span
      className="inline-flex cursor-pointer"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        setMobileOpen(true);
      }}
    >
      {children}
    </span>
  );

  if (presentation === 'modal') {
    return (
      <>
        {children ? (
          <span
            className="inline-flex cursor-pointer"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setOpen(true);
            }}
          >
            {children}
          </span>
        ) : null}

        <MobileOverlayPanel
          open={open}
          onClose={() => setOpen(false)}
          title="Select Project Files"
          footer={summarySection}
        >
          <div className="flex flex-col gap-0">{pickerBody}</div>
        </MobileOverlayPanel>
      </>
    );
  }

  if (isCompact) {
    return (
      <>
        {mobileTrigger}
        <MobileOverlayPanel
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          title="Select Project Files"
          footer={summarySection}
        >
          <div className="flex flex-col gap-0">{pickerBody}</div>
        </MobileOverlayPanel>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        {children}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className={cn(
          'p-0 overflow-hidden flex flex-col',
          'w-[min(520px,calc(100vw-24px))]'
        )}
        align="start"
        sideOffset={5}
        collisionPadding={12}
      >
        {pickerBody}
        <DropdownMenuSeparator />
        {summarySection}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
