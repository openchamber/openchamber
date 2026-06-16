import React from 'react';

import { toast } from '@/components/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStatus } from '@/stores/useGitStore';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { copyTextToClipboard } from '@/lib/clipboard';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { opencodeClient } from '@/lib/opencode/client';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { useI18n } from '@/lib/i18n';

type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

const sortNodes = (items: FileNode[]) =>
  items.slice().sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

const normalizePath = (value: string): string => {
  if (!value) return '';

  const raw = value.replace(/\\/g, '/');
  const hadUncPrefix = raw.startsWith('//');

  let normalized = raw.replace(/\/+$/g, '');
  normalized = normalized.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  if (normalized === '') {
    return raw.startsWith('/') ? '/' : '';
  }

  return normalized;
};

const getRelativePath = (root: string, path: string): string => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root).replace(/\/+$/, '');
  if (normalizedPath === normalizedRoot) {
    return '.';
  }
  if (!normalizedRoot || !normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath;
  }
  return normalizedPath.slice(normalizedRoot.length + 1);
};

const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value);
};

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};

// Module-level per-root cache for the file tree. After P1.1 the component
// stays mounted across right-sidebar tab switches, so the cache also stays
// warm during that flow. The cache also survives the close-and-reopen flow
// (the component remounts but the Map is module-scoped) — without this, every
// sidebar reopen would re-list every expanded directory.
//
// LRU by touchedAt; cap is generous because large repos can have hundreds
// of expanded directories and each FileNode is small (~80 bytes). Stale
// roots are evicted on the next touch.
type FileTreeCache = {
  childrenByDir: Record<string, FileNode[]>;
  loadErrorsByDir: Record<string, string>;
  loadedDirs: Set<string>;
  touchedAt: number;
};
const FILE_TREE_CACHE_MAX_ROOTS = 8;
const fileTreeCacheByRoot = new Map<string, FileTreeCache>();

const touchCache = (root: string): FileTreeCache | null => {
  const entry = fileTreeCacheByRoot.get(root);
  if (!entry) return null;
  entry.touchedAt = Date.now();
  // Touch on read promotes the key to the end of the Map's iteration order,
  // so the oldest (front) entry is the next eviction candidate.
  fileTreeCacheByRoot.delete(root);
  fileTreeCacheByRoot.set(root, entry);
  return entry;
};

const getOrCreateCache = (root: string): FileTreeCache => {
  const existing = fileTreeCacheByRoot.get(root);
  if (existing) {
    existing.touchedAt = Date.now();
    return existing;
  }
  if (fileTreeCacheByRoot.size >= FILE_TREE_CACHE_MAX_ROOTS) {
    const oldest = fileTreeCacheByRoot.keys().next().value;
    if (oldest !== undefined) {
      fileTreeCacheByRoot.delete(oldest);
    }
  }
  const created: FileTreeCache = {
    childrenByDir: {},
    loadErrorsByDir: {},
    loadedDirs: new Set(),
    touchedAt: Date.now(),
  };
  fileTreeCacheByRoot.set(root, created);
  return created;
};

const dropCacheForRoot = (root: string): void => {
  fileTreeCacheByRoot.delete(root);
};

const getFileIcon = (filePath: string, extension?: string): React.ReactNode => {
  return <FileTypeIcon filePath={filePath} extension={extension} />;
};

// --- Git status indicators (matching FilesView) ---

type FileStatus = 'open' | 'modified' | 'git-modified' | 'git-added' | 'git-deleted';

const FileStatusDot: React.FC<{ status: FileStatus }> = ({ status }) => {
  const color = {
    open: 'var(--status-info)',
    modified: 'var(--status-warning)',
    'git-modified': 'var(--status-warning)',
    'git-added': 'var(--status-success)',
    'git-deleted': 'var(--status-error)',
  }[status];

  return <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />;
};

// --- FileRow with context menu (matching FilesView) ---

interface FileRowProps {
  node: FileNode;
  root: string;
  isExpanded: boolean;
  isActive: boolean;
  status?: FileStatus | null;
  badge?: { modified: number; added: number } | null;
  permissions: {
    canRename: boolean;
    canCreateFile: boolean;
    canCreateFolder: boolean;
    canDelete: boolean;
    canReveal: boolean;
  };
  downloadFile?: (path: string) => Promise<void>;
  onSelect: (node: FileNode) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onOpenDialog: (type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => void;
}

const FileRow: React.FC<FileRowProps> = ({
  node,
  root,
  isExpanded,
  isActive,
  status,
  badge,
  permissions,
  downloadFile,
  onSelect,
  onToggle,
  onRevealPath,
  onOpenDialog,
}) => {
  const { t } = useI18n();
  const isDir = node.type === 'directory';
  const { canRename, canCreateFile, canCreateFolder, canDelete, canReveal } = permissions;

  // Menu open state is local to each row so opening a menu in one row
  // never re-renders its siblings. Previously this state lived on the
  // parent, which made every FileRow re-render whenever any menu toggled.
  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const [rightClickOpen, setRightClickOpen] = React.useState(false);

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!canRename && !canCreateFile && !canCreateFolder && !canDelete && !canReveal) return;
    event?.preventDefault();
    setRightClickOpen(true);
  }, [canRename, canCreateFile, canCreateFolder, canDelete, canReveal]);

  const handleInteraction = React.useCallback(() => {
    if (isDir) {
      onToggle(node.path);
    } else {
      onSelect(node);
    }
  }, [isDir, node, onSelect, onToggle]);

  const handleMenuButtonClick = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRightClickOpen(false);
    setContextMenuOpen(true);
  }, []);

  const renderMenuItems = ({
    Item,
    Separator,
  }: {
    Item: React.ElementType;
    Separator: React.ElementType;
  }) => (
    <>
      {canRename && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('rename', node); }}>
          <Icon name="edit" className="mr-2 h-4 w-4" /> {t('sidebarFilesTree.menu.rename')}
        </Item>
      )}
      <Item onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        void copyTextToClipboard(node.path).then((result) => {
          if (result.ok) {
            toast.success(t('sidebarFilesTree.toast.pathCopied'));
            return;
          }
          toast.error(t('sidebarFilesTree.toast.copyFailed'));
        });
      }}>
        <Icon name="file-copy" className="mr-2 h-4 w-4" /> {t('sidebarFilesTree.menu.copyPath')}
      </Item>
      {!isDir && downloadFile && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void downloadFile(node.path).catch((error) => {
            console.error('Download failed:', error);
            toast.error(t('sidebarFilesTree.toast.operationFailed'));
          });
        }}>
          <Icon name="download" className="mr-2 h-4 w-4" /> {t('sidebarFilesTree.menu.save')}
        </Item>
      )}
      {canReveal && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRevealPath(node.path); }}>
          <Icon name="folder-received" className="mr-2 h-4 w-4" /> {t(getRevealLabelKey())}
        </Item>
      )}
      {isDir && (canCreateFile || canCreateFolder) && (
        <>
          <Separator />
          {canCreateFile && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFile', node); }}>
              <Icon name="file-add" className="mr-2 h-4 w-4" /> {t('sidebarFilesTree.menu.newFile')}
            </Item>
          )}
          {canCreateFolder && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFolder', node); }}>
              <Icon name="folder-add" className="mr-2 h-4 w-4" /> {t('sidebarFilesTree.menu.newFolder')}
            </Item>
          )}
        </>
      )}
      {canDelete && (
        <>
          <Separator />
          <Item
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('delete', node); }}
            className="text-destructive focus:text-destructive"
          >
            <Icon name="delete-bin" className="mr-2 h-4 w-4" /> {t('sidebarFilesTree.menu.delete')}
          </Item>
        </>
      )}
    </>
  );

  const handleDragStart = React.useCallback((e: React.DragEvent) => {
    const path = getRelativePath(root, node.path);
    if (!path || path === '.') return;
    e.dataTransfer.setData('application/x-openchamber-file-path', path);
    e.dataTransfer.effectAllowed = 'copy';
  }, [node.path, root]);

  return (
    <ContextMenu open={rightClickOpen} onOpenChange={setRightClickOpen}>
      <ContextMenuTrigger render={<div className="group relative flex items-center" onContextMenu={handleContextMenu} />}>
      <button
        type="button"
        onClick={handleInteraction}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors pr-8 select-none',
          isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40',
          'cursor-grab active:cursor-grabbing'
        )}
      >
        {isDir ? (
          isExpanded ? (
            <Icon name="folder-open-fill" className="h-4 w-4 flex-shrink-0 text-primary/60" />
          ) : (
            <Icon name="folder-3-fill" className="h-4 w-4 flex-shrink-0 text-primary/60" />
          )
        ) : (
          getFileIcon(node.path, node.extension)
        )}
        <span className="min-w-0 flex-1 truncate typography-meta" title={node.path}>
          {node.name}
        </span>
        {!isDir && status && <FileStatusDot status={status} />}
        {isDir && badge && (
          <span className="text-xs flex items-center gap-1 ml-auto mr-1">
            {badge.modified > 0 && <span className="text-[var(--status-warning)]">M{badge.modified}</span>}
            {badge.added > 0 && <span className="text-[var(--status-success)]">+{badge.added}</span>}
          </span>
        )}
      </button>
      {(canRename || canCreateFile || canCreateFolder || canDelete || canReveal) && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <DropdownMenu
            open={contextMenuOpen}
            onOpenChange={setContextMenuOpen}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={handleMenuButtonClick}
                      title={t('sidebarFilesTree.actions.fileMenuTitle')}
                      aria-label={t('sidebarFilesTree.actions.fileMenuTitle')}
                    >
                      <Icon name="more-2-fill" className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>{t('sidebarFilesTree.actions.fileMenuTitle')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" side="bottom" onCloseAutoFocus={() => setContextMenuOpen(false)}>
              {renderMenuItems({ Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        {renderMenuItems({ Item: ContextMenuItem, Separator: ContextMenuSeparator })}
      </ContextMenuContent>
    </ContextMenu>
  );
};

const areFileRowPropsEqual = (prev: FileRowProps, next: FileRowProps): boolean => (
  prev.node === next.node
  && prev.root === next.root
  && prev.isExpanded === next.isExpanded
  && prev.isActive === next.isActive
  && prev.status === next.status
  && prev.badge === next.badge
  && prev.permissions === next.permissions
  && prev.downloadFile === next.downloadFile
  && prev.onSelect === next.onSelect
  && prev.onToggle === next.onToggle
  && prev.onRevealPath === next.onRevealPath
  && prev.onOpenDialog === next.onOpenDialog
);

const MemoizedFileRow = React.memo(FileRow, areFileRowPropsEqual);

// --- Main component ---

export const SidebarFilesTree: React.FC = () => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const currentDirectory = useEffectiveDirectory() ?? '';
  const root = normalizePath(currentDirectory.trim());
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const openContextFile = useUIStore((state) => state.openContextFile);
  const gitStatus = useGitStatus(currentDirectory);

  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const [searchResults, setSearchResults] = React.useState<FileNode[]>([]);
  const [searching, setSearching] = React.useState(false);

  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const [loadErrorsByDir, setLoadErrorsByDir] = React.useState<Record<string, string>>({});
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const inFlightDirsRef = React.useRef<Set<string>>(new Set());

  // Hydrate the per-root cache on mount or root change. The cache is
  // module-scoped so it survives close-and-reopen of the right sidebar;
  // expanded paths are already persisted via useFilesViewTabsStore, so
  // combining the two means the tree re-paints with cached data instead
  // of blanking out and re-listing every directory.
  React.useEffect(() => {
    if (!root) {
      setChildrenByDir({});
      setLoadErrorsByDir({});
      loadedDirsRef.current = new Set();
      return;
    }
    const cached = touchCache(root);
    if (cached) {
      // Shallow-clone so the state and cache hold independent references.
      // This protects the cache from accidental in-place mutation of state
      // (a future contributor could otherwise break the contract silently).
      setChildrenByDir({ ...cached.childrenByDir });
      setLoadErrorsByDir({ ...cached.loadErrorsByDir });
      loadedDirsRef.current = new Set(cached.loadedDirs);
    } else {
      setChildrenByDir({});
      setLoadErrorsByDir({});
      loadedDirsRef.current = new Set();
    }
  }, [root]);

  // Mirror local state into the per-root cache. Don't bump touchedAt here:
  // writes are frequent and the LRU should reflect user attention, not
  // background re-renders.
  React.useEffect(() => {
    if (!root) return;
    const cache = getOrCreateCache(root);
    cache.childrenByDir = childrenByDir;
  }, [root, childrenByDir]);

  React.useEffect(() => {
    if (!root) return;
    const cache = getOrCreateCache(root);
    cache.loadErrorsByDir = loadErrorsByDir;
  }, [root, loadErrorsByDir]);

  // The ref's contents must be persisted to the cache so a remount (e.g.
  // close-and-reopen of the right sidebar) skips re-listing already-known
  // directories. Mirror on every change of `root` so the ref → cache sync
  // happens once per directory; the ref itself updates synchronously inside
  // `loadDirectory` and isn't tracked by React otherwise.
  React.useEffect(() => {
    if (!root) return;
    const cache = getOrCreateCache(root);
    cache.loadedDirs = new Set(loadedDirsRef.current);
  }, [root, childrenByDir, loadErrorsByDir]);

  // Drop the cache entry for this root on unmount when no data was loaded
  // (e.g. user opened the tab and immediately switched projects before any
  // listDirectory round-trip). A populated entry stays so the next mount
  // rehydrates instantly.
  React.useEffect(() => () => {
    if (!root) return;
    const cache = fileTreeCacheByRoot.get(root);
    if (cache && cache.loadedDirs.size === 0 && Object.keys(cache.childrenByDir).length === 0) {
      dropCacheForRoot(root);
    }
  }, [root]);

  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const EMPTY_CONTEXT_TABS: Array<{ mode: string; targetPath: string | null }> = React.useMemo(() => [], []);
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const addOpenPath = useFilesViewTabsStore((state) => state.addOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const contextTabs = useUIStore((state) => (root ? (state.contextPanelByDirectory[root]?.tabs ?? EMPTY_CONTEXT_TABS) : EMPTY_CONTEXT_TABS));
  const openContextFilePaths = React.useMemo(() => new Set(
    contextTabs
      .map((tab) => (tab.mode === 'file' ? tab.targetPath : null))
      .filter((targetPath): targetPath is string => typeof targetPath === 'string' && targetPath.length > 0)
      .map((targetPath) => normalizePath(targetPath))
  ), [contextTabs]);

  // Dialog state for CRUD operations
  const [activeDialog, setActiveDialog] = React.useState<'createFile' | 'createFolder' | 'rename' | 'delete' | null>(null);
  const [dialogData, setDialogData] = React.useState<{ path: string; name?: string; type?: 'file' | 'directory' } | null>(null);
  const [dialogInputValue, setDialogInputValue] = React.useState('');
  const [isDialogSubmitting, setIsDialogSubmitting] = React.useState(false);

  const canCreateFile = Boolean(files.writeFile);
  const canCreateFolder = Boolean(files.createDirectory);
  const canRename = Boolean(files.rename);
  const canDelete = Boolean(files.delete);
  const canReveal = Boolean(files.revealPath);

  const fileRowPermissions = React.useMemo(
    () => ({ canRename, canCreateFile, canCreateFolder, canDelete, canReveal }),
    [canRename, canCreateFile, canCreateFolder, canDelete, canReveal]
  );

  const handleRevealPath = React.useCallback((targetPath: string) => {
    if (!files.revealPath) return;
    void files.revealPath(targetPath).catch(() => {
      toast.error(t('sidebarFilesTree.toast.revealFailed'));
    });
  }, [files, t]);

  const handleOpenDialog = React.useCallback((type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => {
    setActiveDialog(type);
    setDialogData(data);
    setDialogInputValue(type === 'rename' ? data.name || '' : '');
    setIsDialogSubmitting(false);
  }, []);

  const mapDirectoryEntries = React.useCallback((dirPath: string, entries: Array<{ name: string; path: string; isDirectory: boolean }>): FileNode[] => {
    const nodes = entries
      .filter((entry) => entry && typeof entry.name === 'string' && entry.name.length > 0)
      .filter((entry) => showHidden || !entry.name.startsWith('.'))
      .filter((entry) => showGitignored || !shouldIgnoreEntryName(entry.name))
      .map<FileNode>((entry) => {
        const name = entry.name;
        const normalizedEntryPath = normalizePath(entry.path || '');
        const path = normalizedEntryPath
          ? (isAbsolutePath(normalizedEntryPath)
            ? normalizedEntryPath
            : normalizePath(`${dirPath}/${normalizedEntryPath}`))
          : normalizePath(`${dirPath}/${name}`);
        const type = entry.isDirectory ? 'directory' : 'file';
        const extension = type === 'file' && name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
        return { name, path, type, extension };
      });

    return sortNodes(nodes);
  }, [showGitignored, showHidden]);

  const loadDirectory = React.useCallback(async (dirPath: string, isCancelled?: () => boolean) => {
    const normalizedDir = normalizePath(dirPath.trim());
    if (!normalizedDir) return;

    if (loadedDirsRef.current.has(normalizedDir) || inFlightDirsRef.current.has(normalizedDir)) return;

    inFlightDirsRef.current = new Set(inFlightDirsRef.current);
    inFlightDirsRef.current.add(normalizedDir);

    const listPromise = files.listDirectory
      ? files.listDirectory(normalizedDir).then((result) => result.entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
      })))
      : opencodeClient.listLocalDirectory(normalizedDir).then((result) => result.map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
      })));

    try {
      const entries = await listPromise;
      if (isCancelled?.()) return;
      const mapped = mapDirectoryEntries(normalizedDir, entries);

      loadedDirsRef.current = new Set(loadedDirsRef.current);
      loadedDirsRef.current.add(normalizedDir);
      setLoadErrorsByDir((prev) => {
        if (!prev[normalizedDir]) return prev;
        const next = { ...prev };
        delete next[normalizedDir];
        return next;
      });
      setChildrenByDir((prev) => ({ ...prev, [normalizedDir]: mapped }));
    } catch (error) {
      if (isCancelled?.()) return;
      const message = error instanceof Error ? error.message : String(error ?? '');
      console.error('Failed to load sidebar directory:', error);
      setLoadErrorsByDir((prev) => ({
        ...prev,
        [normalizedDir]: message,
      }));
    } finally {
      inFlightDirsRef.current = new Set(inFlightDirsRef.current);
      inFlightDirsRef.current.delete(normalizedDir);
    }
  }, [files, mapDirectoryEntries]);

  const refreshRoot = React.useCallback(async () => {
    if (!root) return;

    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    setLoadErrorsByDir({});
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));

    await loadDirectory(root);
  }, [loadDirectory, root]);

  /**
   * Incrementally refresh a single directory without nuking the rest of the
   * tree.  Only the given directory is reloaded in-place; every other expanded
   * directory keeps its cached children so the UI does not flash/reset.
   */
  const refreshDirectory = React.useCallback(async (dirPath: string) => {
    if (!dirPath) {
      await refreshRoot();
      return;
    }
    const normalized = normalizePath(dirPath);
    loadedDirsRef.current = new Set(loadedDirsRef.current);
    loadedDirsRef.current.delete(normalized);
    inFlightDirsRef.current = new Set(inFlightDirsRef.current);
    inFlightDirsRef.current.delete(normalized);
    await loadDirectory(normalized);
  }, [loadDirectory, refreshRoot]);

  React.useEffect(() => {
    if (!root) return;

    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    setLoadErrorsByDir({});
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    void loadDirectory(root);
  }, [loadDirectory, root, showHidden, showGitignored]);

  React.useEffect(() => {
    if (!root || expandedPaths.length === 0) return;

    // Sort by depth so parent dirs load before children
    const toLoad = expandedPaths
      .map((p) => normalizePath(p))
      .filter((normalized): normalized is string =>
        !!normalized &&
        normalized !== root &&
        normalized.startsWith(`${root}/`) &&
        !loadedDirsRef.current.has(normalized) &&
        !inFlightDirsRef.current.has(normalized),
      )
      .sort((a, b) => a.split('/').length - b.split('/').length);

    if (toLoad.length === 0) return;

    // Load with concurrency limit to avoid API stampede on startup.
    // Each per-dir fetch gets a cancellation predicate so the load stops
    // touching state once the effect tears down (e.g. user collapses the
    // directory or the directory list changes mid-flight).
    let cancelled = false;
    const isCancelled = () => cancelled;
    void (async () => {
      for (let i = 0; i < toLoad.length && !cancelled; i += 3) {
        const batch = toLoad.slice(i, i + 3);
        await Promise.all(batch.map((dir) => loadDirectory(dir, isCancelled)));
      }
    })();
    return () => { cancelled = true; };
  }, [expandedPaths, loadDirectory, root]);

  // --- Fuzzy search scoring (matching FilesView) ---

  React.useEffect(() => {
    if (!currentDirectory) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    const trimmedQuery = debouncedSearchQuery.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
      setSearching(false);
      return;
    }

    let cancelled = false;
    setSearching(true);

    searchFiles(currentDirectory, trimmedQuery, 150, {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
      type: 'file',
    })
      .then((hits) => {
        if (cancelled) return;

        const filtered = hits.filter((hit) => showGitignored || !shouldIgnorePath(hit.path));

        const mapped: FileNode[] = filtered.map((hit) => ({
          name: hit.name,
          path: normalizePath(hit.path),
          type: 'file',
          extension: hit.extension,
          relativePath: hit.relativePath,
        }));

        setSearchResults(mapped);
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
  }, [currentDirectory, debouncedSearchQuery, searchFiles, showHidden, showGitignored]);

  // --- Git status helpers (matching FilesView) ---
  //
  // statusByPath / badgeByDir are precomputed once per gitStatus change so the
  // tree render is O(1) per node instead of O(N) per node. Without these
  // maps, a deep tree with 200 files and 40 directories would do ~8000
  // string comparisons on every render.

  const statusByPath = React.useMemo(() => {
    const map = new Map<string, FileStatus>();
    if (!gitStatus?.files) return map;
    for (const file of gitStatus.files) {
      if (file.index === 'A' || file.working_dir === '?') {
        map.set(file.path, 'git-added');
      } else if (file.index === 'D') {
        map.set(file.path, 'git-deleted');
      } else if (file.index === 'M' || file.working_dir === 'M') {
        map.set(file.path, 'git-modified');
      }
    }
    return map;
  }, [gitStatus]);

  const badgeByDir = React.useMemo(() => {
    const map = new Map<string, { modified: number; added: number }>();
    if (!gitStatus?.files || !root) return map;
    for (const file of gitStatus.files) {
      const isModified = file.index === 'M' || file.working_dir === 'M';
      const isAdded = file.index === 'A' || file.working_dir === '?';
      if (!isModified && !isAdded) continue;
      const segments = file.path.split('/');
      if (segments.length <= 1) continue;
      let currentDir = root;
      for (let i = 0; i < segments.length - 1; i++) {
        currentDir = `${currentDir}/${segments[i]}`;
        let entry = map.get(currentDir);
        if (!entry) {
          entry = { modified: 0, added: 0 };
          map.set(currentDir, entry);
        }
        if (isModified) entry.modified++;
        if (isAdded) entry.added++;
      }
    }
    return map;
  }, [gitStatus, root]);

  const getFileStatus = React.useCallback((path: string): FileStatus | null => {
    if (openContextFilePaths.has(path)) return 'open';
    if (statusByPath.size === 0) return null;
    const relative = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
    return statusByPath.get(relative) ?? null;
  }, [openContextFilePaths, statusByPath, root]);

  const getFolderBadge = React.useCallback((dirPath: string): { modified: number; added: number } | null => {
    if (badgeByDir.size === 0) return null;
    const entry = badgeByDir.get(dirPath);
    if (!entry) return null;
    return entry.modified + entry.added > 0 ? entry : null;
  }, [badgeByDir]);

  // --- File operations ---

  const handleOpenFile = React.useCallback(async (node: FileNode) => {
    if (!root) return;

    const openValidation = await validateContextFileOpen(files, node.path);
    if (!openValidation.ok) {
      toast.error(getContextFileOpenFailureMessage(openValidation.reason));
      return;
    }

    setSelectedPath(root, node.path);
    addOpenPath(root, node.path);
    openContextFile(root, node.path);
  }, [addOpenPath, files, openContextFile, root, setSelectedPath]);

  const toggleDirectory = React.useCallback(async (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    if (!root) return;

    toggleExpandedPath(root, normalized);
    if (!loadedDirsRef.current.has(normalized)) {
      await loadDirectory(normalized);
    }
  }, [loadDirectory, root, toggleExpandedPath]);

  // --- Dialog submit (matching FilesView) ---

  const handleDialogSubmit = React.useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogData || !activeDialog) return;

    setIsDialogSubmitting(true);
    const done = () => setIsDialogSubmitting(false);
    const closeDialog = () => setActiveDialog(null);

    if (activeDialog === 'createFile') {
      if (!dialogInputValue.trim()) {
        toast.error(t('sidebarFilesTree.toast.filenameRequired'));
        done();
        return;
      }
      if (!files.writeFile) {
        toast.error(t('sidebarFilesTree.toast.writeNotSupported'));
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

      await files.writeFile(newPath, '')
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.fileCreated'));
            await refreshDirectory(parentPath);
          }
          closeDialog();
        })
        .catch(() => toast.error(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'createFolder') {
      if (!dialogInputValue.trim()) {
        toast.error(t('sidebarFilesTree.toast.folderNameRequired'));
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

      await files.createDirectory(newPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.folderCreated'));
            await refreshDirectory(parentPath);
          }
          closeDialog();
        })
        .catch(() => toast.error(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'rename') {
      if (!dialogInputValue.trim()) {
        toast.error(t('sidebarFilesTree.toast.nameRequired'));
        done();
        return;
      }
      if (!files.rename) {
        toast.error(t('sidebarFilesTree.toast.renameNotSupported'));
        done();
        return;
      }

      const oldPath = dialogData.path;
      const parentDir = oldPath.split('/').slice(0, -1).join('/');
      const prefix = parentDir ? `${parentDir}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

      await files.rename(oldPath, newPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.renamedSuccessfully'));
            await refreshDirectory(parentDir);
            if (root) {
              removeOpenPathsByPrefix(root, oldPath);
            }
            if (selectedPath === oldPath || (selectedPath && selectedPath.startsWith(`${oldPath}/`))) {
              setSelectedPath(root, null);
            }
          }
          closeDialog();
        })
        .catch(() => toast.error(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'delete') {
      if (!files.delete) {
        toast.error(t('sidebarFilesTree.toast.deleteNotSupported'));
        done();
        return;
      }

      const deletedPath = dialogData.path;
      const parentDir = deletedPath.split('/').slice(0, -1).join('/');
      await files.delete(deletedPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.deletedSuccessfully'));
            await refreshDirectory(parentDir);
            if (root) {
              removeOpenPathsByPrefix(root, deletedPath);
            }
            if (selectedPath === deletedPath || (selectedPath && selectedPath.startsWith(deletedPath + '/'))) {
              setSelectedPath(root, null);
            }
          }
          closeDialog();
        })
        .catch(() => toast.error(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    done();
  }, [activeDialog, dialogData, dialogInputValue, files, refreshDirectory, removeOpenPathsByPrefix, root, selectedPath, setSelectedPath, t]);

  // --- Tree rendering (matching FilesView with indent guides) ---

  function renderTree(dirPath: string, depth: number): React.ReactNode {
    const nodes = childrenByDir[dirPath] ?? [];

    return nodes.map((node, index) => {
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expandedPaths.includes(node.path);
      const isActive = selectedPath === node.path;
      const isLast = index === nodes.length - 1;

      return (
        <li key={node.path} className="relative">
          {depth > 0 && (
            <>
              <span className="absolute top-3.5 left-[-12px] w-3 h-px bg-border/40" />
              {isLast && (
                <span className="absolute top-3.5 bottom-0 left-[-13px] w-[2px] bg-sidebar/50" />
              )}
            </>
          )}
          <MemoizedFileRow
            node={node}
            root={root}
            isExpanded={isExpanded}
            isActive={isActive}
            status={!isDir ? getFileStatus(node.path) : undefined}
            badge={isDir ? getFolderBadge(node.path) : undefined}
            permissions={fileRowPermissions}
            downloadFile={files.downloadFile}
            onSelect={handleOpenFile}
            onToggle={toggleDirectory}
            onRevealPath={handleRevealPath}
            onOpenDialog={handleOpenDialog}
          />
          {isDir && isExpanded && (
            <ul className="flex flex-col gap-1 ml-3 pl-3 border-l border-border/40 relative">
              {loadErrorsByDir[node.path] ? (
                <li className="flex items-center gap-2 px-2 py-1 typography-meta text-muted-foreground">
                  <span className="min-w-0 flex-1 truncate text-[var(--status-error)]" title={loadErrorsByDir[node.path]}>{loadErrorsByDir[node.path]}</span>
                  <Button variant="ghost" size="xs" className="h-6 gap-1" onClick={() => void refreshDirectory(node.path)}>
                    <Icon name="refresh" className="h-3.5 w-3.5" />
                    {t('sidebarFilesTree.actions.refreshTitle')}
                  </Button>
                </li>
              ) : null}
              {renderTree(node.path, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }

  const hasTree = Boolean(root && childrenByDir[root]);
  const rootLoadError = root ? loadErrorsByDir[root] : null;

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('sidebarFilesTree.search.placeholder')}
            className="h-8 pl-8 pr-8 typography-meta"
          />
          {searchQuery.trim().length > 0 ? (
            <button
              type="button"
              aria-label={t('sidebarFilesTree.search.clearAria')}
              className="absolute right-2 top-2 inline-flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSearchQuery('');
                searchInputRef.current?.focus();
              }}
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        {canCreateFile && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleOpenDialog('createFile', { path: currentDirectory, type: 'directory' })}
                  className="h-8 w-8 p-0 flex-shrink-0"
                  title={t('sidebarFilesTree.actions.newFileTitle')}
                  aria-label={t('sidebarFilesTree.actions.newFileTitle')}
                >
                  <Icon name="file-add" className="h-4 w-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('sidebarFilesTree.actions.newFileTitle')}</TooltipContent>
          </Tooltip>
        )}
        {canCreateFolder && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleOpenDialog('createFolder', { path: currentDirectory, type: 'directory' })}
                  className="h-8 w-8 p-0 flex-shrink-0"
                  title={t('sidebarFilesTree.actions.newFolderTitle')}
                  aria-label={t('sidebarFilesTree.actions.newFolderTitle')}
                >
                  <Icon name="folder-add" className="h-4 w-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('sidebarFilesTree.actions.newFolderTitle')}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={() => void refreshRoot()} className="h-8 w-8 p-0 flex-shrink-0" title={t('sidebarFilesTree.actions.refreshTitle')} aria-label={t('sidebarFilesTree.actions.refreshTitle')}>
                <Icon name="refresh" className="h-4 w-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('sidebarFilesTree.actions.refreshTitle')}</TooltipContent>
        </Tooltip>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="p-2">
        <ul className="flex flex-col">
          {searching ? (
            <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" />
              {t('sidebarFilesTree.state.searching')}
            </li>
          ) : searchResults.length > 0 ? (
            searchResults.map((node) => {
              const isActive = selectedPath === node.path;
              return (
                <li key={node.path}>
                  <button
                    type="button"
                    onClick={() => handleOpenFile(node)}
                    draggable
                    onDragStart={(e) => {
                      const path = node.relativePath || getRelativePath(root ?? '', node.path);
                      if (!path || path === '.') return;
                      e.dataTransfer.setData('application/x-openchamber-file-path', path);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors cursor-grab active:cursor-grabbing',
                      isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40'
                    )}
                    title={node.path}
                  >
                    {getFileIcon(node.path, node.extension)}
                    <span
                      className="min-w-0 flex-1 truncate typography-meta"
                      style={{ direction: 'rtl', textAlign: 'left' }}
                    >
                      {node.relativePath ?? node.path}
                    </span>
                  </button>
                </li>
              );
            })
          ) : rootLoadError ? (
            <li className="flex flex-col gap-2 px-2 py-1 typography-meta text-muted-foreground">
              <span>{rootLoadError}</span>
              <Button variant="outline" size="xs" className="w-fit gap-1.5" onClick={() => void refreshRoot()}>
                <Icon name="refresh" className="h-3.5 w-3.5" />
                {t('sidebarFilesTree.actions.refreshTitle')}
              </Button>
            </li>
          ) : hasTree && root ? (
            renderTree(root, 0)
          ) : (
            <li className="px-2 py-1 typography-meta text-muted-foreground">{t('sidebarFilesTree.state.loading')}</li>
          )}
        </ul>
      </ScrollableOverlay>

      {/* CRUD dialogs (matching FilesView) */}
      <Dialog open={!!activeDialog} onOpenChange={(open) => !open && setActiveDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {activeDialog === 'createFile' && t('sidebarFilesTree.dialog.createFile.title')}
              {activeDialog === 'createFolder' && t('sidebarFilesTree.dialog.createFolder.title')}
              {activeDialog === 'rename' && t('sidebarFilesTree.dialog.rename.title')}
              {activeDialog === 'delete' && t('sidebarFilesTree.dialog.delete.title')}
            </DialogTitle>
            <DialogDescription>
              {activeDialog === 'createFile' && t('sidebarFilesTree.dialog.createFile.description', { path: dialogData?.path ?? t('sidebarFilesTree.dialog.rootFallback') })}
              {activeDialog === 'createFolder' && t('sidebarFilesTree.dialog.createFolder.description', { path: dialogData?.path ?? t('sidebarFilesTree.dialog.rootFallback') })}
              {activeDialog === 'rename' && t('sidebarFilesTree.dialog.rename.description', { name: dialogData?.name ?? '' })}
              {activeDialog === 'delete' && t('sidebarFilesTree.dialog.delete.description', { name: dialogData?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>

          {activeDialog !== 'delete' && (
            <div className="py-4">
              <Input
                value={dialogInputValue}
                onChange={(e) => setDialogInputValue(e.target.value)}
                placeholder={activeDialog === 'rename' ? t('sidebarFilesTree.dialog.rename.placeholder') : t('sidebarFilesTree.dialog.namePlaceholder')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleDialogSubmit();
                  }
                }}
                autoFocus
              />
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setActiveDialog(null)} disabled={isDialogSubmitting}>
              {t('sidebarFilesTree.dialog.cancel')}
            </Button>
            <Button
              variant={activeDialog === 'delete' ? 'destructive' : 'default'}
              onClick={() => void handleDialogSubmit()}
              disabled={isDialogSubmitting || (activeDialog !== 'delete' && !dialogInputValue.trim())}
            >
              {isDialogSubmitting ? <Icon name="loader-4" className="size-4 animate-spin" /> : (
                activeDialog === 'delete' ? t('sidebarFilesTree.dialog.delete.confirm') : t('sidebarFilesTree.dialog.confirm')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
