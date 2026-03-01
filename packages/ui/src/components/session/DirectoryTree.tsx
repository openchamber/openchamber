import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { RiAddLine, RiArrowDownSLine, RiArrowRightSLine, RiCheckLine, RiCloseLine, RiFolder6Line, RiPushpin2Line, RiPushpinLine } from '@remixicon/react';
import { cn, formatPathForDisplay } from '@/lib/utils';
import { opencodeClient } from '@/lib/opencode/client';
import { useDeviceInfo } from '@/lib/device';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { buildRuntimeApiHeaders, resolveRuntimeApiEndpoint } from '@/lib/instances/runtimeApiBaseUrl';

interface DirectoryItem {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: DirectoryItem[];
  isExpanded?: boolean;
}

interface DirectoryTreeProps {
  currentPath: string;
  onSelectPath: (path: string) => void;
  triggerClassName?: string;
  variant?: 'dropdown' | 'inline';
  className?: string;
  selectionBehavior?: 'immediate' | 'deferred';
  onDoubleClickPath?: (path: string) => void;
  showHidden?: boolean;
  rootDirectory?: string | null;
  isRootReady?: boolean;
  /** Always show action icons (add, pin) instead of only on hover */
  alwaysShowActions?: boolean;
}

export const DirectoryTree: React.FC<DirectoryTreeProps> = ({
  currentPath,
  onSelectPath,
  triggerClassName,
  variant = 'dropdown',
  className,
  selectionBehavior = 'immediate',
  onDoubleClickPath,
  showHidden = false,
  rootDirectory = null,
  isRootReady,
  alwaysShowActions = false,
}) => {
  const { isMobile } = useDeviceInfo();
  const [directories, setDirectories] = React.useState<DirectoryItem[]>([]);
  const [expandedPaths, setExpandedPaths] = React.useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = React.useState(true);
  const [isOpen, setIsOpen] = React.useState(false);
  const [homeDirectory, setHomeDirectory] = React.useState<string>('');
  const [pinnedPaths, setPinnedPaths] = React.useState<Set<string>>(new Set());
  const [creatingInPath, setCreatingInPath] = React.useState<string | null>(null);
  const [newDirName, setNewDirName] = React.useState('');
  const [isPinnedExpanded, setIsPinnedExpanded] = React.useState(true);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const { requestAccess, startAccessing, isDesktop } = useFileSystemAccess();
  const previousShowHidden = React.useRef(showHidden);

  const stripTrailingSlashes = React.useCallback((value: string | null | undefined) => {
    if (!value) {
      return value;
    }
    if (value === '/' || value.length === 0) {
      return '/';
    }
    let trimmed = value;
    while (trimmed.length > 1 && trimmed.endsWith('/')) {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed.length === 0 ? '/' : trimmed;
  }, []);

  const normalizedHomeDirectory = React.useMemo(() => {
    if (!homeDirectory) {
      return null;
    }
    const normalized = homeDirectory.replace(/\\/g, '/');
    return stripTrailingSlashes(normalized) as string;
  }, [homeDirectory, stripTrailingSlashes]);

  const effectiveRoot = React.useMemo(() => {
    if (typeof rootDirectory === 'string' && rootDirectory.length > 0) {
      const normalized = rootDirectory.replace(/\\/g, '/');
      const stripped = stripTrailingSlashes(normalized);
      if (stripped && stripped !== '/') {
        return stripped as string;
      }
    }
    if (normalizedHomeDirectory && normalizedHomeDirectory !== '/') {
      return normalizedHomeDirectory;
    }
    return null;
  }, [rootDirectory, normalizedHomeDirectory, stripTrailingSlashes]);

  const rootReady = React.useMemo(() => {
    if (typeof isRootReady === 'boolean') {
      return Boolean(isRootReady && effectiveRoot);
    }
    return Boolean(effectiveRoot);
  }, [isRootReady, effectiveRoot]);

  React.useEffect(() => {
    if (!rootReady) {
      setIsLoading(true);
      setDirectories([]);
    }
  }, [rootReady]);

  const isPathWithinHome = React.useCallback(
    (targetPath: string | null | undefined): boolean => {
      if (!targetPath) {
        return false;
      }
      if (!rootReady || !effectiveRoot) {
        return false;
      }
      const normalizedTargetRaw = targetPath.replace(/\\/g, '/');
      const normalizedTarget =
        (stripTrailingSlashes(normalizedTargetRaw) as string) ?? normalizedTargetRaw;
      if (normalizedTarget === effectiveRoot) {
        return true;
      }
      const prefix = `${effectiveRoot}/`;
      return normalizedTarget.startsWith(prefix);
    },
    [rootReady, effectiveRoot, stripTrailingSlashes]
  );

  const handleDirectorySelect = async (path: string) => {
    if (!rootReady) {
      return;
    }

    if (selectionBehavior === 'deferred') {
      onSelectPath(path);
      return;
    }

    if (isDesktop) {

      const accessResult = await requestAccess(path);
      if (accessResult.success && accessResult.path) {

        await startAccessing(accessResult.path);
        onSelectPath(accessResult.path);
      } else {
        console.error('Failed to get directory access:', accessResult.error);

        onSelectPath(path);
      }
    } else {
      onSelectPath(path);
    }
  };

  React.useEffect(() => {
    let cancelled = false;

    const applyRootDirectory = (candidate: string | null | undefined) => {
      if (!candidate) {
        return false;
      }
      const normalized = stripTrailingSlashes(candidate.replace(/\\/g, '/'));
      if (!normalized || normalized === '/') {
        return false;
      }
      setHomeDirectory(typeof normalized === 'string' ? normalized : candidate.replace(/\\/g, '/'));
      return true;
    };

    const appliedInitialRoot = rootDirectory ? applyRootDirectory(rootDirectory) : false;

    const resolveHomeDirectory = async () => {
      try {
        const fsHome = await opencodeClient.getFilesystemHome();
        if (!cancelled && applyRootDirectory(fsHome)) {
          return;
        }
      } catch (error) {
        console.warn('Failed to resolve filesystem home directory:', error);
      }

      try {
        const info = await opencodeClient.getSystemInfo();
        if (!cancelled && applyRootDirectory(info?.homeDirectory)) {
          return;
        }
      } catch (error) {
        console.warn('Failed to resolve home directory from system info:', error);
      }
    };

    if (!appliedInitialRoot) {
      resolveHomeDirectory();
    }

    return () => {
      cancelled = true;
    };
  }, [rootDirectory, stripTrailingSlashes]);

  React.useEffect(() => {
    let cancelled = false;

    const applyPinned = (paths: string[]) => {
      if (cancelled) {
        return;
      }
      const normalized = paths
        .filter((path): path is string => typeof path === 'string' && path.length > 0)
        .map((path) => {
          const normalizedPath = path.replace(/\\/g, '/');
          return (stripTrailingSlashes(normalizedPath) as string) ?? normalizedPath;
        });
      setPinnedPaths(new Set(normalized));
    };

    const loadFromLocalStorage = () => {
      try {
        const raw = localStorage.getItem('pinnedDirectories');
        if (!raw) {
          return;
        }
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          applyPinned(parsed);
        }
      } catch (error) {
        console.warn('Failed to load pinned directories from local storage:', error);
      }
    };

        const loadPinnedDirectories = async () => {
          try {
            let pinned: string[] = [];

        const response = await fetch(resolveRuntimeApiEndpoint('/config/settings'), {
          method: 'GET',
          headers: buildRuntimeApiHeaders(),
        });
        if (response.ok) {
          const data = await response.json();
          pinned = Array.isArray(data?.pinnedDirectories) ? data.pinnedDirectories : [];
        }

        if (cancelled) {
          return;
        }

        applyPinned(pinned);
      } catch (error) {
        console.warn('Failed to load pinned directories:', error);
      }
    };

    loadFromLocalStorage();

    const handleSettingsSynced = (event: Event) => {
      const detail = (event as CustomEvent<DesktopSettings>).detail;
      if (detail && Array.isArray(detail.pinnedDirectories)) {
        applyPinned(detail.pinnedDirectories);
      }
    };
    window.addEventListener('openchamber:settings-synced', handleSettingsSynced);

    void loadPinnedDirectories();

    return () => {
      cancelled = true;
      window.removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    };
  }, [stripTrailingSlashes]);

  const isInitialPinnedSync = React.useRef(true);

  React.useEffect(() => {
    if (isInitialPinnedSync.current) {
      isInitialPinnedSync.current = false;
      return;
    }

    const payload = {
      pinnedDirectories: Array.from(pinnedPaths),
    };

    void updateDesktopSettings(payload);
  }, [pinnedPaths]);

  React.useEffect(() => {
    if (!effectiveRoot) {
      return;
    }
    setPinnedPaths((prev) => {
      const filtered = Array.from(prev)
        .map((path) => (stripTrailingSlashes(path.replace(/\\/g, '/')) as string) ?? path)
        .filter((path) => isPathWithinHome(path));
      return new Set(filtered);
    });
  }, [effectiveRoot, isPathWithinHome, stripTrailingSlashes]);

  // Reload directories when showHidden changes, but keep expanded state
  React.useEffect(() => {
    if (previousShowHidden.current !== showHidden) {
      previousShowHidden.current = showHidden;
      // Silently reload without clearing state - loadInitialDirectories will be called
      // via its dependency on loadDirectory which depends on showHidden
    }
  }, [showHidden]);

  const togglePin = (path: string) => {
    setPinnedPaths(prev => {
      if (!isPathWithinHome(path)) {
        return prev;
      }
      const normalizedPath =
        (stripTrailingSlashes(path.replace(/\\/g, '/')) as string) ?? path.replace(/\\/g, '/');
      const newSet = new Set(prev);
      if (newSet.has(normalizedPath)) {
        newSet.delete(normalizedPath);
      } else {
        newSet.add(normalizedPath);
      }
      return newSet;
    });
  };

  const pinnedDirectories = React.useMemo(() => {
    return Array.from(pinnedPaths)
      .map((rawPath) => {
        const normalizedPath = stripTrailingSlashes(rawPath.replace(/\\/g, '/')) ?? rawPath;
        return normalizedPath;
      })
      .filter((path) => isPathWithinHome(path))
      .map((path) => ({
        path,
        name: path.split('/').pop() || path
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [pinnedPaths, isPathWithinHome, stripTrailingSlashes]);

  const loadDirectory = React.useCallback(async (path: string): Promise<DirectoryItem[]> => {
    const shouldInclude = (name: string) => showHidden || !name.startsWith('.');
    const normalizedHome = effectiveRoot;

    if (!rootReady || !normalizedHome) {
      return [];
    }

    const normalizedPathRaw = path && path.length > 0 ? path : normalizedHome;
    const normalizedPath = normalizedPathRaw ? normalizedPathRaw.replace(/\\/g, '/') : null;
    const normalizedTarget = normalizedPath
      ? stripTrailingSlashes(normalizedPath) ?? normalizedPath
      : null;

    if (normalizedTarget) {
      const homePrefix = `${normalizedHome}/`;
      const withinHome = normalizedTarget === normalizedHome || normalizedTarget.startsWith(homePrefix);
      if (!withinHome) {
        return [];
      }
    }

    try {
      const filesystemEntries = await opencodeClient.listLocalDirectory(path);
      return filesystemEntries
        .filter((entry) => {
          if (!entry.isDirectory) {
            return false;
          }
          if (!shouldInclude(entry.name)) {
            return false;
          }
          const normalizedEntryRaw = entry.path.replace(/\\/g, '/');
          const normalizedEntryPath = stripTrailingSlashes(normalizedEntryRaw) ?? normalizedEntryRaw;
          const entryPrefix = normalizedEntryPath === normalizedHome ? normalizedHome : `${normalizedHome}/`;
          return normalizedEntryPath === normalizedHome || normalizedEntryPath.startsWith(entryPrefix);
        })
        .map((entry) => ({
          name: entry.name,
          path: entry.path.replace(/\\/g, '/'),
          isDirectory: true
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      try {

        const tempClient = opencodeClient.getApiClient();
        const response = await tempClient.file.list({
          path: '.',
          directory: path
        });

        if (!response.data) {
          return [];
        }

        return response.data
          .filter((item: { type?: string; name?: string; absolute?: string; path?: string }) => {
            if (item.type !== 'directory') {
              return false;
            }
            if (!item.name || !shouldInclude(item.name)) {
              return false;
            }
            const rawPath = String(item.absolute || item.path || item.name).replace(/\\/g, '/');
            const absolutePath = stripTrailingSlashes(rawPath) ?? rawPath;
            const entryPrefix = absolutePath === normalizedHome ? normalizedHome : `${normalizedHome}/`;
            return absolutePath === normalizedHome || absolutePath.startsWith(entryPrefix);
          })
          .map((item: { name?: string; absolute?: string; path?: string }) => ({
            name: item.name || '',
            path: String(item.absolute || item.path || item.name).replace(/\\/g, '/'),
            isDirectory: true
          }))
          .filter((item): item is DirectoryItem => item.name !== '')
          .sort((a: DirectoryItem, b: DirectoryItem) => a.name.localeCompare(b.name));
      } catch {
        return [];
      }
    }
  }, [showHidden, effectiveRoot, stripTrailingSlashes, rootReady]);

  const hasLoadedOnce = React.useRef(false);

  const loadInitialDirectories = React.useCallback(async () => {
    if (!rootReady || !effectiveRoot) {
      setIsLoading(true);
      setDirectories([]);
      return;
    }

    // Only show loading on initial load, not on refreshes (e.g., showHidden toggle)
    if (!hasLoadedOnce.current) {
      setIsLoading(true);
    }
    try {
      const homeContents = await loadDirectory(effectiveRoot);
      setDirectories(homeContents);
      hasLoadedOnce.current = true;
    } catch { /* ignored */ } finally {
      setIsLoading(false);
    }
  }, [rootReady, effectiveRoot, loadDirectory]);

  React.useEffect(() => {
    if (!rootReady) {
      return;
    }
    if ((variant === 'inline' || isOpen)) {
      loadInitialDirectories();
    }
  }, [variant, isOpen, rootReady, loadInitialDirectories]);

  const toggleExpanded = async (item: DirectoryItem) => {
    if (!rootReady) {
      return;
    }
    const isCurrentlyExpanded = expandedPaths.has(item.path);
    const newExpanded = new Set(expandedPaths);

    if (isCurrentlyExpanded) {
      newExpanded.delete(item.path);
      setExpandedPaths(newExpanded);
      return;
    }

    newExpanded.add(item.path);
    setExpandedPaths(newExpanded);

    const children = await loadDirectory(item.path);
    const updateItems = (items: DirectoryItem[]): DirectoryItem[] => {
      return items.map((i) => {
        if (i.path === item.path) {
          return { ...i, children };
        }
        if (i.children) {
          return { ...i, children: updateItems(i.children) };
        }
        return i;
      });
    };
    setDirectories((prev) => updateItems(prev));
  };

  React.useEffect(() => {
    if (creatingInPath && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [creatingInPath]);

  const generateUniqueDirName = (parentPath: string, children: DirectoryItem[] = []): string => {
    const baseName = 'new_directory';
    const existingNames = children.map(child => child.name);

    if (!existingNames.includes(baseName)) {
      return baseName;
    }

    let maxNumber = 1;
    const numberPattern = new RegExp(`^${baseName}(\\d+)$`);

    for (const name of existingNames) {
      const match = name.match(numberPattern);
      if (match) {
        const num = parseInt(match[1], 10);
        if (num > maxNumber) {
          maxNumber = num;
        }
      }
    }

    let counter = 2;
    while (existingNames.includes(`${baseName}${counter}`)) {
      counter++;
    }

    return `${baseName}${Math.max(counter, maxNumber + 1)}`;
  };

  const startCreatingDirectory = async (parentItem: DirectoryItem) => {
    if (!rootReady) {
      return;
    }

    if (!expandedPaths.has(parentItem.path)) {
      const newExpanded = new Set(expandedPaths);
      newExpanded.add(parentItem.path);
      setExpandedPaths(newExpanded);

      if (!parentItem.children) {
        const children = await loadDirectory(parentItem.path);
        const updateItems = (items: DirectoryItem[]): DirectoryItem[] => {
          return items.map(i => {
            if (i.path === parentItem.path) {
              return { ...i, children };
            }
            if (i.children) {
              return { ...i, children: updateItems(i.children) };
            }
            return i;
          });
        };
        setDirectories((prev) => updateItems(prev));

        const uniqueName = generateUniqueDirName(parentItem.path, children);
        setNewDirName(uniqueName);
      } else {
        const uniqueName = generateUniqueDirName(parentItem.path, parentItem.children);
        setNewDirName(uniqueName);
      }
    } else {
      const uniqueName = generateUniqueDirName(parentItem.path, parentItem.children);
      setNewDirName(uniqueName);
    }

    setCreatingInPath(parentItem.path);
  };

  const createDirectory = async () => {
    if (!creatingInPath || !rootReady) return;

    const dirName = newDirName.trim() || 'new_directory';
    const fullPath = `${creatingInPath}/${dirName}`;

    try {
      await opencodeClient.createDirectory(fullPath, { allowOutsideWorkspace: true });

      const children = await loadDirectory(creatingInPath);
      const updateItems = (items: DirectoryItem[]): DirectoryItem[] => {
        return items.map(i => {
          if (i.path === creatingInPath) {
            return { ...i, children };
          }
          if (i.children) {
            return { ...i, children: updateItems(i.children) };
          }
          return i;
        });
      };
      setDirectories((prev) => updateItems(prev));

      setCreatingInPath(null);
      setNewDirName('');
    } catch (error) {
      console.error('Failed to create directory:', error);

    }
  };

  const cancelCreatingDirectory = () => {
    setCreatingInPath(null);
    setNewDirName('');
  };

  const renderTreeItem = (item: DirectoryItem, level: number = 0) => {
    const isExpanded = expandedPaths.has(item.path);
    const hasChildren = item.isDirectory;
    const isPinned = pinnedPaths.has(item.path);
    const isSelected = currentPath === item.path;
    const isInlineVariant = variant === 'inline';

    const rowContent = (
      <>
        {hasChildren && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleExpanded(item);
            }}
            className={cn("hover:bg-interactive-hover rounded", isMobile ? "p-0.5" : "p-0.5")}
          >
            {isExpanded ? (
              <RiArrowDownSLine className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} />
            ) : (
              <RiArrowRightSLine className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} />
            )}
          </button>
        )}
        {!hasChildren && <div className={isMobile ? "w-4.5" : "w-4"} />}

        <button
          onClick={(e) => {
            e.stopPropagation();
            handleDirectorySelect(item.path);
            if (variant === 'dropdown' && selectionBehavior === 'immediate') {
              setIsOpen(false);
            }
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (onDoubleClickPath) {
              onDoubleClickPath(item.path);
            }
          }}
          className={cn(
            'flex items-center flex-1 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 rounded',
            isMobile ? 'gap-1.5' : 'gap-1.5',
            isInlineVariant ? (isSelected ? 'text-primary' : 'text-foreground') : 'text-foreground'
          )}
        >
          <RiFolder6Line
            className={cn(
              'text-muted-foreground flex-shrink-0',
              isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5',
              isInlineVariant && isSelected && 'text-primary'
            )}
          />
          <span
            className={cn(
              'font-medium truncate',
              isMobile ? 'typography-ui-label' : 'typography-ui-label',
              isInlineVariant && isSelected ? 'text-primary' : 'text-foreground'
            )}
          >
            {item.name}
          </span>
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            startCreatingDirectory(item);
          }}
          className={cn(
            "hover:bg-interactive-hover rounded transition-opacity",
            isMobile ? "p-1.5" : "p-1",
            alwaysShowActions ? "opacity-60" : "opacity-0 group-hover:opacity-100"
          )}
          title="Create new directory"
        >
          <RiAddLine className={cn("text-muted-foreground", isMobile ? "h-3.5 w-3.5" : "h-3 w-3")} />
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            togglePin(item.path);
          }}
          className={cn(
            "hover:bg-interactive-hover rounded transition-opacity",
            isMobile ? "p-1.5" : "p-1",
            alwaysShowActions ? "opacity-60" : "opacity-0 group-hover:opacity-100"
          )}
          title={isPinned ? "Unpin directory" : "Pin directory"}
        >
          {isPinned ? (
            <RiPushpin2Line className={cn("text-primary", isMobile ? "h-3.5 w-3.5" : "h-3 w-3")} />
          ) : (
            <RiPushpinLine className={cn("text-muted-foreground", isMobile ? "h-3.5 w-3.5" : "h-3 w-3")} />
          )}
        </button>
      </>
    );

    if (variant === 'inline') {
      return (
        <div key={item.path}>
          <div
            className={cn(
              'group flex items-center gap-1 rounded-lg mx-1 text-left transition-colors',
              isMobile ? 'px-1.5 py-1' : 'px-2 py-1.5',
              isSelected 
                ? 'bg-primary/10 text-primary' 
                : 'hover:bg-interactive-hover/50 text-foreground'
            )}
            style={{ paddingLeft: `${level * (isMobile ? 12 : 14) + (isMobile ? 4 : 6)}px` }}
          >
            {rowContent}
          </div>
          {isExpanded && (
            <>
              {creatingInPath === item.path && (
                <div
                  className="flex items-center gap-1 mx-1 px-2 py-1.5"
                  style={{ paddingLeft: `${(level + 1) * 14 + 6}px` }}
                >
                  <div className="w-4" />
                  <RiFolder6Line className="h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    ref={inputRef}
                    value={newDirName}
                    onChange={(e) => setNewDirName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        createDirectory();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        cancelCreatingDirectory();
                      }
                    }}
                    onBlur={createDirectory}
                    className="h-6 typography-meta flex-1 selection:bg-interactive-selection selection:text-interactive-selection-foreground"
                    placeholder="new_directory"
                  />
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      createDirectory();
                    }}
                    className="p-1 hover:bg-interactive-hover rounded"
                    title="Create directory"
                  >
                    <RiCheckLine className="h-3 w-3 text-green-600" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelCreatingDirectory();
                    }}
                    className="p-1 hover:bg-interactive-hover rounded"
                    title="Cancel"
                  >
                    <RiCloseLine className="h-3 w-3 text-muted-foreground" />
                  </button>
                </div>
              )}
              {item.children && item.children.map((child) => renderTreeItem(child, level + 1))}
            </>
          )}
        </div>
      );
    }

    return (
      <div key={item.path}>
        <DropdownMenuItem
          className={cn(
            'flex items-center gap-1 cursor-pointer group',
            currentPath === item.path && 'bg-interactive-selection'
          )}
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onSelect={(e) => {
            e.preventDefault();
          }}
        >
          {hasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                toggleExpanded(item);
              }}
              className="p-0.5 hover:bg-interactive-hover rounded"
            >
              {isExpanded ? (
                <RiArrowDownSLine className="h-3 w-3" />
              ) : (
                <RiArrowRightSLine className="h-3 w-3" />
              )}
            </button>
          )}
          {!hasChildren && <div className="w-4" />}
          {rowContent}
        </DropdownMenuItem>
        {isExpanded && (
          <div>
            {creatingInPath === item.path && (
              <div
                className="flex items-center gap-1 px-2 py-1.5"
                style={{ paddingLeft: `${(level + 1) * 12 + 8}px` }}
              >
                <div className="w-4" />
                <RiFolder6Line className="h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  ref={inputRef}
                  value={newDirName}
                  onChange={(e) => setNewDirName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      createDirectory();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      e.stopPropagation();
                      cancelCreatingDirectory();
                    }
                  }}
                  onBlur={createDirectory}
                  className="h-6 typography-meta flex-1 selection:bg-interactive-selection selection:text-interactive-selection-foreground"
                  placeholder="new_directory"
                />
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    createDirectory();
                  }}
                  className="p-1 hover:bg-interactive-hover rounded"
                  title="Create directory"
                >
                  <RiCheckLine className="h-3 w-3 text-green-600" />
                </button>
                <button
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    cancelCreatingDirectory();
                  }}
                  className="p-1 hover:bg-interactive-hover rounded"
                  title="Cancel"
                >
                  <RiCloseLine className="h-3 w-3 text-muted-foreground" />
                </button>
              </div>
            )}
            {item.children && item.children.map((child) => renderTreeItem(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  const renderPinnedRow = (name: string, path: string) => {
    if (variant === 'inline') {
      const isSelected = currentPath === path;
      return (
        <div
          key={path}
          className={cn(
            'group flex items-center gap-2 mx-1 rounded-lg transition-colors',
            isMobile ? 'px-1.5 py-1' : 'px-2 py-1.5',
            isSelected 
              ? 'bg-primary/10' 
              : 'hover:bg-interactive-hover/50'
          )}
        >
          <button
            onClick={() => handleDirectorySelect(path)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              if (onDoubleClickPath) {
                onDoubleClickPath(path);
              }
            }}
            className={cn(
              'flex flex-1 items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60 rounded min-w-0',
              isSelected ? 'text-primary' : 'text-foreground'
            )}
          >
            <RiFolder6Line
              className={cn(
                'flex-shrink-0',
                isMobile ? 'h-4 w-4' : 'h-3.5 w-3.5',
                isSelected ? 'text-primary' : 'text-muted-foreground'
              )}
            />
            <span
              className={cn(
                'typography-ui-label font-medium truncate flex-shrink-0',
                isSelected ? 'text-primary' : 'text-foreground'
              )}
            >
              {name}
            </span>
            <span className="typography-meta text-muted-foreground/60 truncate">
              {formatPathForDisplay(path, homeDirectory)}
            </span>
          </button>
          <button
            onClick={() => togglePin(path)}
            className={cn(
              "hover:bg-interactive-hover rounded-md transition-opacity",
              isMobile ? "p-1.5 opacity-60" : "p-1 opacity-0 group-hover:opacity-100"
            )}
            title="Unpin directory"
          >
            <RiPushpin2Line className={cn("text-primary", isMobile ? "h-3.5 w-3.5" : "h-3.5 w-3.5")} />
          </button>
        </div>
      );
    }

    return (
      <DropdownMenuItem
        key={path}
        onSelect={(e) => {
          e.preventDefault();
          handleDirectorySelect(path);
          if (selectionBehavior === 'immediate') {
            setIsOpen(false);
          }
        }}
        className={cn(
          'flex items-start gap-2 cursor-pointer group py-2',
          currentPath === path && 'bg-interactive-selection'
        )}
      >
        <RiFolder6Line className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="typography-ui-label font-medium">{name}</div>
          <div className="typography-meta text-muted-foreground">
            {formatPathForDisplay(path, homeDirectory)}
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            togglePin(path);
          }}
          className="p-1 opacity-0 group-hover:opacity-100 hover:bg-interactive-hover rounded transition-opacity"
          title="Unpin directory"
        >
          <RiPushpin2Line className="h-3 w-3 text-primary" />
        </button>
      </DropdownMenuItem>
    );
  };

  const directoryContent = (
    <>
      {!rootReady ? (
        <div className="px-3 py-2 typography-ui-label text-muted-foreground">
          Locating home directory...
        </div>
      ) : (
        <>
          {pinnedDirectories.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => setIsPinnedExpanded(prev => !prev)}
                className={cn(
                  "flex w-full items-center gap-1.5 typography-meta font-medium text-muted-foreground/80 hover:bg-interactive-hover/30 rounded transition-colors uppercase tracking-wide",
                  isMobile ? "px-1.5 py-1" : "px-2 py-1.5"
                )}
              >
                {isPinnedExpanded ? (
                  <RiArrowDownSLine className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} />
                ) : (
                  <RiArrowRightSLine className={isMobile ? "h-3.5 w-3.5" : "h-3 w-3"} />
                )}
                <span>Pinned</span>
                <span className="ml-auto typography-micro text-muted-foreground/60 normal-case tracking-normal">
                  {pinnedDirectories.length}
                </span>
              </button>
              {isPinnedExpanded && pinnedDirectories.map(({ name, path }) => renderPinnedRow(name, path))}
              {variant === 'dropdown' && <DropdownMenuSeparator />}
              {variant === 'inline' && isPinnedExpanded && (
                <div className="mx-3 my-2 border-t border-border/40" />
              )}
            </>
          )}

          <div className={cn(
            "typography-meta font-medium text-muted-foreground/80 flex items-center gap-1.5 uppercase tracking-wide",
            isMobile ? "px-1.5 py-1" : "px-2 py-1.5"
          )}>
            Browse
          </div>

          {isLoading ? (
            <div className="px-3 py-2 typography-ui-label text-muted-foreground">
              Loading...
            </div>
          ) : (
            directories.map((item) => renderTreeItem(item))
          )}

          {!isLoading && directories.length === 0 && (
            <div className="px-3 py-2 typography-ui-label text-muted-foreground">
              No directories found
            </div>
          )}
        </>
      )}
    </>
  );

  if (variant === 'inline') {
    return (
      <div className={cn('overflow-hidden flex flex-col', className)}>
        <ScrollableOverlay outerClassName="flex-1 min-h-0" className="w-full py-1">
          {directoryContent}
        </ScrollableOverlay>
      </div>
    );
  }

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          className={cn(
            'w-full h-8 px-2.5 justify-between items-center rounded-lg border border-transparent bg-sidebar-accent/40 text-foreground/90 hover:bg-sidebar-accent/60 typography-meta',
            triggerClassName
          )}
          aria-label="Select working directory"
        >
          <span className="flex items-center gap-1.5 min-w-0 flex-1">
            <RiFolder6Line className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            <span className="truncate" title={currentPath}>
              {formatPathForDisplay(currentPath, homeDirectory)}
            </span>
          </span>
          <RiArrowDownSLine className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[350px]">
        <ScrollableOverlay outerClassName="h-full" className="w-full">
          {directoryContent}
        </ScrollableOverlay>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
