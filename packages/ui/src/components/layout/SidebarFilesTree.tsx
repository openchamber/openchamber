import React from 'react';
import {
  RiCloseLine,
  RiDeleteBinLine,
  RiDownloadLine,
  RiDragMove2Fill,
  RiEditLine,
  RiFileAddLine,
  RiFileCopyLine,
  RiFolder3Fill,
  RiFolderAddLine,
  RiFolderOpenFill,
  RiFolderReceivedLine,
  RiLoader4Line,
  RiMore2Fill,
  RiRefreshLine,
  RiSearchLine,
  RiUploadCloud2Line,
} from '@remixicon/react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

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
import { FileDropOverlay } from '@/components/ui/FileDropOverlay';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDeviceInfo } from '@/lib/device';
import { isTauriShell } from '@/lib/desktop';
import { collectDesktopDroppedPaths, readDesktopDroppedFile } from '@/lib/desktopDroppedFiles';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStatus } from '@/stores/useGitStore';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { copyTextToClipboard } from '@/lib/clipboard';
import { triggerFileDownload } from '@/lib/fileDownload';
import { notifyFileContentInvalidated } from '@/lib/fileContentInvalidation';
import { uploadFileWithFallback, type UploadAttemptResult, type UploadProgressUpdate } from '@/lib/fileUpload';
import { cn } from '@/lib/utils';
import { opencodeClient } from '@/lib/opencode/client';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { getContextFileOpenFailureMessage, validateContextFileOpen } from '@/lib/contextFileOpenGuard';

type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

type UploadPlaceholderStatus = 'queued' | 'reading' | 'writing' | 'error';

type UploadPlaceholder = {
  id: string;
  targetDir: string;
  path: string;
  name: string;
  extension?: string;
  status: UploadPlaceholderStatus;
  progress: number;
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

const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value);
};

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};

const isDescendantPath = (sourcePath: string, targetPath: string): boolean => {
  const normalizedSource = normalizePath(sourcePath);
  const normalizedTarget = normalizePath(targetPath);
  return normalizedTarget === normalizedSource || normalizedTarget.startsWith(`${normalizedSource}/`);
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
    canUpload: boolean;
    canDownload: boolean;
  };
  contextMenuPath: string | null;
  setContextMenuPath: (path: string | null) => void;
  onSelect: (node: FileNode) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onDownloadFile: (node: FileNode) => void;
  onUploadToFolder: (targetPath: string) => void;
  onOpenDialog: (type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => void;
  isUploadDropTarget?: boolean;
  onUploadDropTargetEnter?: (event: React.DragEvent, path: string) => void;
  onUploadDropTargetLeave?: (event: React.DragEvent) => void;
  isDndDragging?: boolean;
  isDndDropTarget?: boolean;
}

const DraggableFileRow: React.FC<{
  node: FileNode;
  children: React.ReactNode;
}> = ({ node, children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `file-drag:${node.path}`,
    data: { type: 'file-move', node },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={isDragging ? 'opacity-30' : undefined}
    >
      {children}
    </div>
  );
};

const DroppableDirectoryRow: React.FC<{
  dirPath: string;
  children: (isOver: boolean, setNodeRef: (element: HTMLElement | null) => void) => React.ReactNode;
}> = ({ dirPath, children }) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `dir-drop:${dirPath}`,
    data: { type: 'directory', path: dirPath },
  });

  return <>{children(isOver, setNodeRef)}</>;
};

const FileRow: React.FC<FileRowProps> = ({
  node,
  isExpanded,
  isActive,
  status,
  badge,
  permissions,
  contextMenuPath,
  setContextMenuPath,
  onSelect,
  onToggle,
  onRevealPath,
  onDownloadFile,
  onUploadToFolder,
  onOpenDialog,
  isUploadDropTarget,
  onUploadDropTargetEnter,
  onUploadDropTargetLeave,
  isDndDragging,
  isDndDropTarget,
}) => {
  const isDir = node.type === 'directory';
  const {
    canRename,
    canCreateFile,
    canCreateFolder,
    canDelete,
    canReveal,
    canUpload,
    canDownload,
  } = permissions;

  const canOpenContextMenu = canRename
    || canCreateFile
    || canCreateFolder
    || canDelete
    || canReveal
    || (!isDir && canDownload)
    || (isDir && canUpload);

  const handleUploadDragEnter = React.useCallback((event: React.DragEvent) => {
    if (isDir && onUploadDropTargetEnter) {
      onUploadDropTargetEnter(event, node.path);
    }
  }, [isDir, node.path, onUploadDropTargetEnter]);

  const handleUploadDragLeave = React.useCallback((event: React.DragEvent) => {
    if (isDir && onUploadDropTargetLeave) {
      onUploadDropTargetLeave(event);
    }
  }, [isDir, onUploadDropTargetLeave]);

  const isDragging = Boolean(isDndDragging);
  const isDropTarget = Boolean(isUploadDropTarget || isDndDropTarget);

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!canOpenContextMenu) {
      return;
    }
    event?.preventDefault();
    setContextMenuPath(node.path);
  }, [canOpenContextMenu, node.path, setContextMenuPath]);

  const handleInteraction = React.useCallback(() => {
    if (isDir) {
      onToggle(node.path);
    } else {
      onSelect(node);
    }
  }, [isDir, node, onSelect, onToggle]);

  const handleMenuButtonClick = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setContextMenuPath(node.path);
  }, [node.path, setContextMenuPath]);

  return (
    <div
      data-sidebar-upload-dir={isDir ? node.path : undefined}
      className={cn('group relative flex items-center', isDragging && 'opacity-50')}
      onContextMenu={handleContextMenu}
      onDragEnter={isDir ? handleUploadDragEnter : undefined}
      onDragLeave={isDir ? handleUploadDragLeave : undefined}
    >
      <button
        type="button"
        onClick={handleInteraction}
        onContextMenu={handleContextMenu}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors pr-8 select-none',
          isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40',
          isDropTarget && 'ring-2 ring-primary ring-offset-2 ring-offset-background bg-primary/10'
        )}
      >
        {isDir ? (
          isExpanded ? (
            <RiFolderOpenFill className="h-4 w-4 flex-shrink-0 text-primary/60" />
          ) : (
            <RiFolder3Fill className="h-4 w-4 flex-shrink-0 text-primary/60" />
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
      {canOpenContextMenu && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          <DropdownMenu
            open={contextMenuPath === node.path}
            onOpenChange={(open) => setContextMenuPath(open ? node.path : null)}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={handleMenuButtonClick}
              >
                <RiMore2Fill className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" onCloseAutoFocus={() => setContextMenuPath(null)}>
              {canRename && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onOpenDialog('rename', node); }}>
                  <RiEditLine className="mr-2 h-4 w-4" /> Rename
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={(e) => {
                e.stopPropagation();
                void copyTextToClipboard(node.path).then((result) => {
                  if (result.ok) {
                    toast.success('Path copied');
                    return;
                  }
                  toast.error('Copy failed');
                });
              }}>
                <RiFileCopyLine className="mr-2 h-4 w-4" /> Copy Path
              </DropdownMenuItem>
              {!isDir && canDownload && (
                <DropdownMenuItem onClick={(e) => {
                  e.stopPropagation();
                  onDownloadFile(node);
                }}>
                  <RiDownloadLine className="mr-2 h-4 w-4" /> Download File
                </DropdownMenuItem>
              )}
              {isDir && canUpload && (
                <DropdownMenuItem onClick={(e) => {
                  e.stopPropagation();
                  onUploadToFolder(node.path);
                }}>
                  <RiUploadCloud2Line className="mr-2 h-4 w-4" /> Upload Files
                </DropdownMenuItem>
              )}
              {canReveal && (
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRevealPath(node.path); }}>
                  <RiFolderReceivedLine className="mr-2 h-4 w-4" /> Reveal in Finder
                </DropdownMenuItem>
              )}
              {isDir && (canCreateFile || canCreateFolder) && (
                <>
                  <DropdownMenuSeparator />
                  {canCreateFile && (
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onOpenDialog('createFile', node); }}>
                      <RiFileAddLine className="mr-2 h-4 w-4" /> New File
                    </DropdownMenuItem>
                  )}
                  {canCreateFolder && (
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onOpenDialog('createFolder', node); }}>
                      <RiFolderAddLine className="mr-2 h-4 w-4" /> New Folder
                    </DropdownMenuItem>
                  )}
                </>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => { e.stopPropagation(); onOpenDialog('delete', node); }}
                    className="text-destructive focus:text-destructive"
                  >
                    <RiDeleteBinLine className="mr-2 h-4 w-4" /> Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
};

const UploadPlaceholderRow: React.FC<{ item: UploadPlaceholder }> = ({ item }) => {
  const statusLabel = item.status === 'queued'
    ? 'Queued...'
    : item.status === 'reading'
      ? `${Math.max(0, Math.min(100, item.progress))}%`
      : item.status === 'writing'
        ? 'Writing...'
        : 'Failed';

  return (
    <div className="group relative flex items-center">
      <div
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 pr-2 text-left',
          item.status === 'error'
            ? 'bg-destructive/10'
            : 'bg-interactive-hover/20'
        )}
      >
        {getFileIcon(item.path, item.extension)}
        <span className="min-w-0 flex-1 truncate typography-meta" title={item.path}>
          {item.name}
        </span>
        <span className={cn(
          'typography-meta',
          item.status === 'error' ? 'text-destructive' : 'text-muted-foreground'
        )}>
          {statusLabel}
        </span>
        {item.status !== 'error' ? <RiLoader4Line className="h-3.5 w-3.5 animate-spin text-primary/80" /> : null}
      </div>
    </div>
  );
};

// --- Main component ---

export const SidebarFilesTree: React.FC = () => {
  const { files, runtime } = useRuntimeAPIs();
  const { isMobile } = useDeviceInfo();
  const currentDirectory = useEffectiveDirectory() ?? '';
  const root = normalizePath(currentDirectory.trim());
  const normalizedCurrentDirectory = root || normalizePath(currentDirectory);
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const openContextFile = useUIStore((state) => state.openContextFile);
  const gitStatus = useGitStatus(currentDirectory);

  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const fileUploadInputRef = React.useRef<HTMLInputElement>(null);
  const contextUploadInputRef = React.useRef<HTMLInputElement>(null);
  const [searchResults, setSearchResults] = React.useState<FileNode[]>([]);
  const [searching, setSearching] = React.useState(false);

  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const inFlightDirsRef = React.useRef<Set<string>>(new Set());

  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const EMPTY_CONTEXT_TABS: Array<{ mode: string; targetPath: string | null }> = React.useMemo(() => [], []);
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const addOpenPath = useFilesViewTabsStore((state) => state.addOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const expandPaths = useFilesViewTabsStore((state) => state.expandPaths);
  const contextTabs = useUIStore((state) => (root ? (state.contextPanelByDirectory[root]?.tabs ?? EMPTY_CONTEXT_TABS) : EMPTY_CONTEXT_TABS));
  const openContextFilePaths = React.useMemo(() => new Set(
    contextTabs
      .map((tab) => (tab.mode === 'file' ? tab.targetPath : null))
      .filter((targetPath): targetPath is string => typeof targetPath === 'string' && targetPath.length > 0)
      .map((targetPath) => normalizePath(targetPath))
  ), [contextTabs]);

  // Context menu state
  const [contextMenuPath, setContextMenuPath] = React.useState<string | null>(null);
  const [contextUploadTargetPath, setContextUploadTargetPath] = React.useState<string | null>(null);

  const [isDraggingFiles, setIsDraggingFiles] = React.useState(false);
  const [dropTargetPath, setDropTargetPath] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const [uploadPlaceholders, setUploadPlaceholders] = React.useState<UploadPlaceholder[]>([]);
  const dragCounterRef = React.useRef(0);
  const treeSectionRef = React.useRef<HTMLElement>(null);
  const nativeDragInsideTreeRef = React.useRef(false);
  const failedUploadCleanupTimeoutIdsRef = React.useRef<Set<number>>(new Set());

  const [activeDndNode, setActiveDndNode] = React.useState<FileNode | null>(null);
  const [dndDropTargetPath, setDndDropTargetPath] = React.useState<string | null>(null);
  const [moveConfirmDialog, setMoveConfirmDialog] = React.useState<{
    source: FileNode;
    targetDir: string;
  } | null>(null);
  const [isMoving, setIsMoving] = React.useState(false);

  // Dialog state for CRUD operations
  const [activeDialog, setActiveDialog] = React.useState<'createFile' | 'createFolder' | 'rename' | 'delete' | null>(null);
  const [dialogData, setDialogData] = React.useState<{ path: string; name?: string; type?: 'file' | 'directory' } | null>(null);
  const [dialogInputValue, setDialogInputValue] = React.useState('');
  const [isDialogSubmitting, setIsDialogSubmitting] = React.useState(false);

  const uploadPlaceholdersByDir = React.useMemo(() => {
    const byDir: Record<string, UploadPlaceholder[]> = {};
    for (const item of uploadPlaceholders) {
      const targetDir = normalizePath(item.targetDir);
      if (!targetDir) {
        continue;
      }
      const existing = byDir[targetDir] ?? [];
      existing.push(item);
      byDir[targetDir] = existing;
    }

    for (const items of Object.values(byDir)) {
      items.sort((a, b) => a.name.localeCompare(b.name));
    }

    return byDir;
  }, [uploadPlaceholders]);

  const canCreateFile = Boolean(files.writeFile);
  const canCreateFolder = Boolean(files.createDirectory);
  const canRename = Boolean(files.rename);
  const canDelete = Boolean(files.delete);
  const canReveal = runtime.isDesktop && Boolean(files.revealPath);
  const canUploadFiles = Boolean(files.uploadFile || files.writeFile);
  const hasNativeDesktopDrop = isTauriShell();

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: { delay: 400, tolerance: 5 },
  });
  const dndSensors = useSensors(isMobile ? touchSensor : pointerSensor);

  const handleRevealPath = React.useCallback((targetPath: string) => {
    if (!runtime.isDesktop || !files.revealPath) {
      return;
    }
    void files.revealPath(targetPath).catch(() => {
      toast.error('Failed to reveal path');
    });
  }, [files, runtime.isDesktop]);

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

  const loadDirectory = React.useCallback(async (dirPath: string) => {
    const normalizedDir = normalizePath(dirPath.trim());
    if (!normalizedDir) return;

    if (loadedDirsRef.current.has(normalizedDir) || inFlightDirsRef.current.has(normalizedDir)) return;

    inFlightDirsRef.current = new Set(inFlightDirsRef.current);
    inFlightDirsRef.current.add(normalizedDir);

    const respectGitignore = !showGitignored;
    const listPromise = runtime.isDesktop
      ? files.listDirectory(normalizedDir, { respectGitignore }).then((result) => result.entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
      })))
      : opencodeClient.listLocalDirectory(normalizedDir, { respectGitignore }).then((result) => result.map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
      })));

    await listPromise
      .then((entries) => {
        const mapped = mapDirectoryEntries(normalizedDir, entries);

        loadedDirsRef.current = new Set(loadedDirsRef.current);
        loadedDirsRef.current.add(normalizedDir);
        setChildrenByDir((prev) => ({ ...prev, [normalizedDir]: mapped }));
      })
      .catch(() => {
        setChildrenByDir((prev) => ({
          ...prev,
          [normalizedDir]: prev[normalizedDir] ?? [],
        }));
      })
      .finally(() => {
        inFlightDirsRef.current = new Set(inFlightDirsRef.current);
        inFlightDirsRef.current.delete(normalizedDir);
      });
  }, [files, mapDirectoryEntries, runtime.isDesktop, showGitignored]);

  const refreshRoot = React.useCallback(async () => {
    if (!root) return;

    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));

    await loadDirectory(root);
  }, [loadDirectory, root]);

  React.useEffect(() => {
    if (!root) return;

    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    void loadDirectory(root);
  }, [loadDirectory, root, showHidden, showGitignored]);

  React.useEffect(() => {
    if (!root || expandedPaths.length === 0) return;

    for (const expandedPath of expandedPaths) {
      const normalized = normalizePath(expandedPath);
      if (!normalized || normalized === root) continue;
      if (!normalized.startsWith(`${root}/`)) continue;
      if (loadedDirsRef.current.has(normalized) || inFlightDirsRef.current.has(normalized)) continue;
      void loadDirectory(normalized);
    }
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

  const getFileStatus = React.useCallback((path: string): FileStatus | null => {
    if (openContextFilePaths.has(path)) return 'open';

    if (gitStatus?.files) {
      const relative = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
      const file = gitStatus.files.find((f) => f.path === relative);
      if (file) {
        if (file.index === 'A' || file.working_dir === '?') return 'git-added';
        if (file.index === 'D') return 'git-deleted';
        if (file.index === 'M' || file.working_dir === 'M') return 'git-modified';
      }
    }
    return null;
  }, [openContextFilePaths, gitStatus, root]);

  const getFolderBadge = React.useCallback((dirPath: string): { modified: number; added: number } | null => {
    if (!gitStatus?.files) return null;
    const relativeDir = dirPath.startsWith(root + '/') ? dirPath.slice(root.length + 1) : dirPath;
    const prefix = relativeDir ? `${relativeDir}/` : '';

    let modified = 0, added = 0;
    for (const f of gitStatus.files) {
      if (f.path.startsWith(prefix)) {
        if (f.index === 'M' || f.working_dir === 'M') modified++;
        if (f.index === 'A' || f.working_dir === '?') added++;
      }
    }
    return modified + added > 0 ? { modified, added } : null;
  }, [gitStatus, root]);

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

  const handleContextMenuDownloadFile = React.useCallback((node: FileNode) => {
    if (node.type !== 'file') {
      return;
    }
    triggerFileDownload(node.path, node.name);
  }, []);

  const toggleDirectory = React.useCallback(async (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    if (!root) return;

    toggleExpandedPath(root, normalized);
    if (!loadedDirsRef.current.has(normalized)) {
      await loadDirectory(normalized);
    }
  }, [loadDirectory, root, toggleExpandedPath]);

  const getAncestorPaths = React.useCallback((targetPath: string): string[] => {
    if (!root) {
      return [];
    }

    const normalizedTargetPath = normalizePath(targetPath);
    if (!normalizedTargetPath || normalizedTargetPath === root) {
      return [];
    }

    if (!normalizedTargetPath.startsWith(`${root}/`)) {
      return [];
    }

    const relative = normalizedTargetPath.slice(root.length + 1);
    const segments = relative.split('/').filter(Boolean);
    if (segments.length === 0) {
      return [];
    }

    const ancestors: string[] = [];
    let current = root;
    for (const segment of segments) {
      current = normalizePath(`${current}/${segment}`);
      ancestors.push(current);
    }

    return ancestors;
  }, [root]);

  const ensurePathVisible = React.useCallback(async (targetPath: string) => {
    if (!root) {
      return;
    }

    const ancestors = getAncestorPaths(targetPath);
    if (ancestors.length === 0) {
      return;
    }

    expandPaths(root, ancestors);
    for (const ancestor of ancestors) {
      if (loadedDirsRef.current.has(ancestor) || inFlightDirsRef.current.has(ancestor)) {
        continue;
      }
      await loadDirectory(ancestor);
    }
  }, [expandPaths, getAncestorPaths, loadDirectory, root]);

  const updateUploadPlaceholder = React.useCallback((id: string, updates: Partial<UploadPlaceholder>) => {
    setUploadPlaceholders((previous) => previous.map((item) => (item.id === id ? { ...item, ...updates } : item)));
  }, []);

  const removeUploadPlaceholders = React.useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    const idSet = new Set(ids);
    setUploadPlaceholders((previous) => previous.filter((item) => !idSet.has(item.id)));
  }, []);

  React.useEffect(() => {
    const timeoutIds = failedUploadCleanupTimeoutIdsRef.current;

    return () => {
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
      timeoutIds.clear();
    };
  }, []);

  const uploadFile = React.useCallback(async (
    file: File,
    targetDir: string,
    onProgress?: (update: UploadProgressUpdate) => void
  ): Promise<UploadAttemptResult> => {
    return uploadFileWithFallback({
      files,
      file,
      targetDir,
      normalizePath,
      onProgress,
    });
  }, [files]);

  const handleFileDrop = React.useCallback(async (droppedFiles: File[], targetDir: string) => {
    if (droppedFiles.length === 0 || (!files.uploadFile && !files.writeFile)) {
      return;
    }

    const normalizedTargetDir = normalizePath(targetDir);
    if (!normalizedTargetDir) {
      return;
    }

    try {
      await ensurePathVisible(normalizedTargetDir);
    } catch {
      toast.error('Failed to prepare upload target');
      return;
    }

    const startedAt = Date.now();
    const placeholders: UploadPlaceholder[] = droppedFiles.map((file, index) => {
      const path = normalizePath(`${normalizedTargetDir}/${file.name}`);
      const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
      return {
        id: `${path}:${startedAt}:${index}`,
        targetDir: normalizedTargetDir,
        path,
        name: file.name,
        extension,
        status: 'queued',
        progress: 0,
      };
    });
    setUploadPlaceholders((previous) => [...previous, ...placeholders]);

    setIsUploading(true);
    let successCount = 0;
    let failCount = 0;
    const uploadedPaths: string[] = [];
    const successfulPlaceholderIds: string[] = [];
    const failedPlaceholderIds: string[] = [];
    let firstFailureMessage: string | null = null;
    let unexpectedError = false;

    try {
      for (const [index, file] of droppedFiles.entries()) {
        const placeholder = placeholders[index];
        if (!placeholder) {
          continue;
        }

        updateUploadPlaceholder(placeholder.id, { status: 'reading', progress: 0 });
        const result = await uploadFile(file, normalizedTargetDir, ({ phase, progress }) => {
          updateUploadPlaceholder(placeholder.id, {
            status: phase === 'reading' ? 'reading' : 'writing',
            progress,
          });
        });

        if (result.success) {
          successCount += 1;
          uploadedPaths.push(placeholder.path);
          successfulPlaceholderIds.push(placeholder.id);
        } else {
          failCount += 1;
          if (!firstFailureMessage) {
            firstFailureMessage = result.error;
          }
          failedPlaceholderIds.push(placeholder.id);
          updateUploadPlaceholder(placeholder.id, { status: 'error' });
        }
      }

      if (successCount > 0) {
        notifyFileContentInvalidated(uploadedPaths);
        await refreshRoot();
        if (successCount === 1 && failCount === 0) {
          toast.success('File uploaded successfully');
        } else if (failCount === 0) {
          toast.success(`${successCount} files uploaded successfully`);
        } else {
          toast.warning(firstFailureMessage ?? `${successCount} uploaded, ${failCount} failed`);
        }
      } else if (failCount > 0) {
        toast.error(firstFailureMessage ?? `Failed to upload ${failCount} file${failCount === 1 ? '' : 's'}`);
      }
    } catch {
      unexpectedError = true;
      toast.error('An unexpected error occurred while uploading files');
    } finally {
      setIsUploading(false);

      if (unexpectedError) {
        removeUploadPlaceholders(placeholders.map((placeholder) => placeholder.id));
      } else {
        removeUploadPlaceholders(successfulPlaceholderIds);
        if (failedPlaceholderIds.length > 0) {
          const timeoutId = window.setTimeout(() => {
            removeUploadPlaceholders(failedPlaceholderIds);
            failedUploadCleanupTimeoutIdsRef.current.delete(timeoutId);
          }, 2500);
          failedUploadCleanupTimeoutIdsRef.current.add(timeoutId);
        }
      }
    }
  }, [ensurePathVisible, files.uploadFile, files.writeFile, refreshRoot, removeUploadPlaceholders, updateUploadPlaceholder, uploadFile]);

  const handleFileUploadFromDialog = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0 || !dialogData || !canUploadFiles) {
      return;
    }

    const targetDir = dialogData.path;
    setIsDialogSubmitting(true);
    setActiveDialog(null);
    await handleFileDrop(Array.from(selectedFiles), targetDir);
    setIsDialogSubmitting(false);

    if (fileUploadInputRef.current) {
      fileUploadInputRef.current.value = '';
    }
  }, [canUploadFiles, dialogData, handleFileDrop]);

  const handleUploadToFolder = React.useCallback((targetPath: string) => {
    if (!canUploadFiles) {
      toast.error('File upload not supported');
      return;
    }

    setContextUploadTargetPath(targetPath);

    const uploadInput = contextUploadInputRef.current;
    if (!uploadInput) {
      setContextUploadTargetPath(null);
      toast.error('Upload input unavailable');
      return;
    }

    uploadInput.value = '';
    uploadInput.click();
  }, [canUploadFiles]);

  const handleContextUploadInputChange = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    const targetDir = contextUploadTargetPath;

    if (!selectedFiles || selectedFiles.length === 0 || !targetDir || !canUploadFiles) {
      event.target.value = '';
      setContextUploadTargetPath(null);
      return;
    }

    await handleFileDrop(Array.from(selectedFiles), targetDir);

    event.target.value = '';
    setContextUploadTargetPath(null);
  }, [canUploadFiles, contextUploadTargetPath, handleFileDrop]);

  const hasDraggedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): boolean => {
    if (!dataTransfer) {
      return false;
    }

    if (dataTransfer.files && dataTransfer.files.length > 0) {
      return true;
    }

    const types = dataTransfer.types ? Array.from(dataTransfer.types) : [];
    return types.includes('Files');
  }, []);

  const collectDroppedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): File[] => {
    if (!dataTransfer) {
      return [];
    }

    const directFiles = Array.from(dataTransfer.files || []);
    if (directFiles.length > 0) {
      return directFiles;
    }

    return Array.from(dataTransfer.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  }, []);

  const resolveTreeDropPoint = React.useCallback((x: number | undefined, y: number | undefined) => {
    if (typeof x !== 'number' || typeof y !== 'number') {
      return null;
    }

    const treeSection = treeSectionRef.current;
    if (!treeSection) {
      return null;
    }

    const rect = treeSection.getBoundingClientRect();
    const pointCandidates: Array<{ x: number; y: number }> = [{ x, y }];
    if (typeof window !== 'undefined' && window.devicePixelRatio > 1) {
      pointCandidates.push({ x: x / window.devicePixelRatio, y: y / window.devicePixelRatio });
    }

    for (const candidate of pointCandidates) {
      const inside = candidate.x >= rect.left
        && candidate.x <= rect.right
        && candidate.y >= rect.top
        && candidate.y <= rect.bottom;
      if (inside) {
        return { ...candidate, inside: true as const };
      }
    }

    return { x, y, inside: false as const };
  }, []);

  const resolveDropTargetFromPoint = React.useCallback((x: number, y: number): string => {
    const pointCandidates: Array<{ x: number; y: number }> = [{ x, y }];
    if (typeof window !== 'undefined' && window.devicePixelRatio > 1) {
      pointCandidates.push({ x: x / window.devicePixelRatio, y: y / window.devicePixelRatio });
    }

    for (const candidate of pointCandidates) {
      const hit = document.elementFromPoint(candidate.x, candidate.y);
      const dropTarget = hit instanceof Element
        ? hit.closest('[data-sidebar-upload-dir]')
        : null;
      const dropPath = dropTarget?.getAttribute('data-sidebar-upload-dir') || '';
      const normalizedDropPath = normalizePath(dropPath);
      if (normalizedDropPath) {
        return normalizedDropPath;
      }
    }

    return normalizedCurrentDirectory;
  }, [normalizedCurrentDirectory]);

  const handleDesktopNativeDrop = React.useCallback(async (rawPaths: string[], targetDir: string) => {
    if (rawPaths.length === 0) {
      return;
    }

    const droppedFiles: File[] = [];
    let failedCount = 0;
    let firstFailureMessage: string | null = null;

    for (const rawPath of rawPaths) {
      try {
        const { file } = await readDesktopDroppedFile(rawPath);
        droppedFiles.push(file);
      } catch (error) {
        failedCount += 1;
        if (!firstFailureMessage) {
          firstFailureMessage = error instanceof Error ? error.message : 'Failed to read dropped file';
        }
      }
    }

    if (failedCount > 0) {
      if (droppedFiles.length === 0) {
        toast.error(firstFailureMessage ?? `Failed to read ${failedCount} dropped file${failedCount === 1 ? '' : 's'}`);
      } else {
        toast.warning(firstFailureMessage ?? `Skipped ${failedCount} dropped file${failedCount === 1 ? '' : 's'}`);
      }
    }

    if (droppedFiles.length === 0) {
      return;
    }

    await handleFileDrop(droppedFiles, targetDir);
  }, [handleFileDrop]);

  React.useEffect(() => {
    if (!hasNativeDesktopDrop) {
      return;
    }

    let cancelled = false;
    let unlisten: null | (() => void) = null;

    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const webviewWindow = getCurrentWebviewWindow();
        const removeListener = await webviewWindow.onDragDropEvent(async (event) => {
          if (!canUploadFiles) {
            return;
          }

          const payload = (event as { payload?: unknown }).payload;
          if (!payload || typeof payload !== 'object') {
            return;
          }

          const typedPayload = payload as {
            type?: string;
            paths?: unknown;
            position?: { x?: number; y?: number };
          };

          const point = resolveTreeDropPoint(typedPayload.position?.x, typedPayload.position?.y);
          const inTree = point?.inside ?? null;
          const targetFromPoint = point?.inside ? resolveDropTargetFromPoint(point.x, point.y) : null;

          if (typedPayload.type === 'enter' || typedPayload.type === 'over') {
            if (inTree !== null) {
              nativeDragInsideTreeRef.current = inTree;
            }

            if (nativeDragInsideTreeRef.current) {
              setIsDraggingFiles(true);
              setDropTargetPath(targetFromPoint || normalizedCurrentDirectory);
            } else {
              setIsDraggingFiles(false);
              setDropTargetPath(null);
            }
            return;
          }

          if (typedPayload.type === 'leave') {
            nativeDragInsideTreeRef.current = false;
            setIsDraggingFiles(false);
            setDropTargetPath(null);
            return;
          }

          if (typedPayload.type !== 'drop') {
            return;
          }

          const shouldHandleDrop = inTree ?? nativeDragInsideTreeRef.current;
          nativeDragInsideTreeRef.current = false;
          setIsDraggingFiles(false);
          setDropTargetPath(null);

          if (!shouldHandleDrop) {
            return;
          }

          const targetDir = targetFromPoint || normalizedCurrentDirectory;
          const rawPaths = collectDesktopDroppedPaths(typedPayload.paths);
          if (rawPaths.length === 0 || !targetDir) {
            return;
          }

          await handleDesktopNativeDrop(rawPaths, targetDir);
        });

        if (cancelled) {
          removeListener();
          return;
        }

        unlisten = removeListener;
      } catch (error) {
        if (!cancelled) {
          console.warn('Failed to register sidebar desktop drag-drop listener:', error);
        }
      }
    })();

    return () => {
      cancelled = true;
      nativeDragInsideTreeRef.current = false;
      if (unlisten) {
        unlisten();
      }
    };
  }, [
    canUploadFiles,
    handleDesktopNativeDrop,
    hasNativeDesktopDrop,
    normalizedCurrentDirectory,
    resolveDropTargetFromPoint,
    resolveTreeDropPoint,
  ]);

  const handleTreeDragEnter = React.useCallback((event: React.DragEvent) => {
    if (hasNativeDesktopDrop) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!hasDraggedFiles(event.dataTransfer) || !canUploadFiles) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const currentTarget = event.currentTarget as unknown as Node | null;
    const previousTarget = event.relatedTarget as Node | null;
    if (currentTarget && previousTarget && currentTarget.contains(previousTarget)) {
      return;
    }

    dragCounterRef.current += 1;

    if (!isDraggingFiles) {
      setIsDraggingFiles(true);
      setDropTargetPath(normalizedCurrentDirectory);
    }
  }, [canUploadFiles, hasDraggedFiles, hasNativeDesktopDrop, isDraggingFiles, normalizedCurrentDirectory]);

  const handleTreeDragOver = React.useCallback((event: React.DragEvent) => {
    if (hasNativeDesktopDrop) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (!hasDraggedFiles(event.dataTransfer) || !canUploadFiles) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }, [canUploadFiles, hasDraggedFiles, hasNativeDesktopDrop]);

  const handleTreeDragLeave = React.useCallback((event: React.DragEvent) => {
    if (hasNativeDesktopDrop) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const currentTarget = event.currentTarget as unknown as Node | null;
    const nextTarget = event.relatedTarget as Node | null;
    if (currentTarget && nextTarget && currentTarget.contains(nextTarget)) {
      return;
    }

    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);

    if (dragCounterRef.current === 0) {
      setIsDraggingFiles(false);
      setDropTargetPath(null);
    }
  }, [hasNativeDesktopDrop]);

  const handleTreeDrop = React.useCallback(async (event: React.DragEvent) => {
    if (hasNativeDesktopDrop) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingFiles(false);

    const targetDir = dropTargetPath || normalizedCurrentDirectory;
    setDropTargetPath(null);

    if (!hasDraggedFiles(event.dataTransfer) || !canUploadFiles || !targetDir) {
      return;
    }

    const droppedFiles = collectDroppedFiles(event.dataTransfer);
    await handleFileDrop(droppedFiles, targetDir);
  }, [canUploadFiles, collectDroppedFiles, dropTargetPath, handleFileDrop, hasDraggedFiles, hasNativeDesktopDrop, normalizedCurrentDirectory]);

  const handleDirectoryDragEnter = React.useCallback((event: React.DragEvent, dirPath: string) => {
    if (!hasDraggedFiles(event.dataTransfer) || !canUploadFiles) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setDropTargetPath(dirPath);
  }, [canUploadFiles, hasDraggedFiles]);

  const handleDirectoryDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();

    const currentTarget = event.currentTarget as unknown as Node | null;
    const nextTarget = event.relatedTarget as Node | null;
    if (currentTarget && nextTarget && currentTarget.contains(nextTarget)) {
      return;
    }

    if (isDraggingFiles) {
      setDropTargetPath(normalizedCurrentDirectory);
    }
  }, [isDraggingFiles, normalizedCurrentDirectory]);

  const handleDndDragStart = React.useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as { type?: string; node?: FileNode } | undefined;
    if (data?.type !== 'file-move' || !data.node) {
      return;
    }

    setActiveDndNode(data.node);
    if (isMobile && typeof navigator !== 'undefined' && navigator.vibrate) {
      try {
        navigator.vibrate(15);
      } catch {
        // Ignore vibration errors.
      }
    }
  }, [isMobile]);

  const handleDndDragOver = React.useCallback((event: DragOverEvent) => {
    const overData = event.over?.data?.current as { type?: string; path?: string } | undefined;
    if (overData?.type === 'directory' && overData.path) {
      setDndDropTargetPath(overData.path);
      return;
    }

    setDndDropTargetPath(null);
  }, []);

  const handleDndDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDndNode(null);
    setDndDropTargetPath(null);

    if (!over) {
      return;
    }

    const activeData = active.data.current as { type?: string; node?: FileNode } | undefined;
    const overData = over.data.current as { type?: string; path?: string } | undefined;
    if (activeData?.type !== 'file-move' || !activeData.node) {
      return;
    }
    if (overData?.type !== 'directory' || !overData.path) {
      return;
    }

    const sourceNode = activeData.node;
    const targetDir = overData.path;
    if (sourceNode.type === 'directory' && isDescendantPath(sourceNode.path, targetDir)) {
      toast.error('Cannot move a folder into itself');
      return;
    }

    const sourceParent = sourceNode.path.split('/').slice(0, -1).join('/');
    if (normalizePath(sourceParent) === normalizePath(targetDir)) {
      return;
    }

    setMoveConfirmDialog({ source: sourceNode, targetDir });
  }, []);

  const performMove = React.useCallback(async (source: FileNode, targetDir: string) => {
    if (!files.rename) {
      toast.error('Move operation not supported');
      return;
    }

    setIsMoving(true);
    const newPath = normalizePath(`${targetDir}/${source.name}`);

    try {
      const result = await files.rename(source.path, newPath);
      if (!result.success) {
        toast.error('Move failed');
        return;
      }

      notifyFileContentInvalidated({
        paths: [source.path, newPath],
        prefixes: source.type === 'directory' ? [source.path, newPath] : [],
      });

      toast.success(`Moved ${source.name} to ${targetDir.split('/').pop() || 'target folder'}`);
      await refreshRoot();

      if (root) {
        removeOpenPathsByPrefix(root, source.path);
      }

      if (selectedPath === source.path || (selectedPath && selectedPath.startsWith(`${source.path}/`))) {
        if (root) {
          setSelectedPath(root, null);
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Move failed');
    } finally {
      setIsMoving(false);
      setMoveConfirmDialog(null);
    }
  }, [files, refreshRoot, removeOpenPathsByPrefix, root, selectedPath, setSelectedPath]);

  const handleConfirmMove = React.useCallback(() => {
    if (moveConfirmDialog) {
      void performMove(moveConfirmDialog.source, moveConfirmDialog.targetDir);
    }
  }, [moveConfirmDialog, performMove]);

  const handleCancelMove = React.useCallback(() => {
    setMoveConfirmDialog(null);
  }, []);

  // --- Dialog submit (matching FilesView) ---

  const handleDialogSubmit = React.useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogData || !activeDialog) return;

    setIsDialogSubmitting(true);
    const done = () => setIsDialogSubmitting(false);
    const closeDialog = () => setActiveDialog(null);

    if (activeDialog === 'createFile') {
      if (!dialogInputValue.trim()) {
        toast.error('Filename is required');
        done();
        return;
      }
      if (!files.writeFile) {
        toast.error('Write not supported');
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

      await files.writeFile(newPath, '')
        .then(async (result) => {
          if (result.success) {
            toast.success('File created');
            await refreshRoot();
          }
          closeDialog();
        })
        .catch(() => toast.error('Operation failed'))
        .finally(done);
      return;
    }

    if (activeDialog === 'createFolder') {
      if (!dialogInputValue.trim()) {
        toast.error('Folder name is required');
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

      await files.createDirectory(newPath)
        .then(async (result) => {
          if (result.success) {
            toast.success('Folder created');
            await refreshRoot();
          }
          closeDialog();
        })
        .catch(() => toast.error('Operation failed'))
        .finally(done);
      return;
    }

    if (activeDialog === 'rename') {
      if (!dialogInputValue.trim()) {
        toast.error('Name is required');
        done();
        return;
      }
      if (!files.rename) {
        toast.error('Rename not supported');
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
            toast.success('Renamed successfully');
            await refreshRoot();
            if (root) {
              removeOpenPathsByPrefix(root, oldPath);
            }
            if (selectedPath === oldPath || (selectedPath && selectedPath.startsWith(`${oldPath}/`))) {
              setSelectedPath(root, null);
            }
          }
          closeDialog();
        })
        .catch(() => toast.error('Operation failed'))
        .finally(done);
      return;
    }

    if (activeDialog === 'delete') {
      if (!files.delete) {
        toast.error('Delete not supported');
        done();
        return;
      }

      await files.delete(dialogData.path)
        .then(async (result) => {
          if (result.success) {
            toast.success('Deleted successfully');
            await refreshRoot();
            if (root) {
              removeOpenPathsByPrefix(root, dialogData.path);
            }
            if (selectedPath === dialogData.path || (selectedPath && selectedPath.startsWith(dialogData.path + '/'))) {
              setSelectedPath(root, null);
            }
          }
          closeDialog();
        })
        .catch(() => toast.error('Operation failed'))
        .finally(done);
      return;
    }

    done();
  }, [activeDialog, dialogData, dialogInputValue, files, refreshRoot, removeOpenPathsByPrefix, root, selectedPath, setSelectedPath]);

  // --- Tree rendering (matching FilesView with indent guides) ---

  function renderTree(dirPath: string, depth: number): React.ReactNode {
    const nodes = childrenByDir[dirPath] ?? [];
    const placeholders = uploadPlaceholdersByDir[dirPath] ?? [];

    const entries: Array<
      { kind: 'node'; node: FileNode }
      | { kind: 'upload'; upload: UploadPlaceholder }
    > = [
      ...nodes.map((node) => ({ kind: 'node' as const, node })),
      ...placeholders.map((upload) => ({ kind: 'upload' as const, upload })),
    ];

    return entries.map((entry, index) => {
      const isLast = index === entries.length - 1;

      if (entry.kind === 'upload') {
        return (
          <li key={`upload:${entry.upload.id}`} className="relative">
            {depth > 0 && (
              <>
                <span className="absolute top-3.5 left-[-12px] w-3 h-px bg-border/40" />
                {isLast && (
                  <span className="absolute top-3.5 bottom-0 left-[-13px] w-[2px] bg-sidebar/50" />
                )}
              </>
            )}
            <UploadPlaceholderRow item={entry.upload} />
          </li>
        );
      }

      const { node } = entry;
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expandedPaths.includes(node.path);
      const isActive = selectedPath === node.path;

      const nodeIsUploadDropTarget = isDir && isDraggingFiles && dropTargetPath === node.path;
      const nodeIsDndDropTarget = isDir && dndDropTargetPath === node.path;
      const nodeIsDndDragging = activeDndNode?.path === node.path;

      const isValidDropTarget = isDir && (!activeDndNode || (
        activeDndNode.path !== node.path
        && !isDescendantPath(activeDndNode.path, node.path)
      ));

      const fileRowProps = {
        node,
        isExpanded,
        isActive,
        status: !isDir ? getFileStatus(node.path) : undefined,
        badge: isDir ? getFolderBadge(node.path) : undefined,
        permissions: {
          canRename,
          canCreateFile,
          canCreateFolder,
          canDelete,
          canReveal,
          canUpload: canUploadFiles,
          canDownload: true,
        },
        contextMenuPath,
        setContextMenuPath,
        onSelect: handleOpenFile,
        onToggle: toggleDirectory,
        onRevealPath: handleRevealPath,
        onDownloadFile: handleContextMenuDownloadFile,
        onUploadToFolder: handleUploadToFolder,
        onOpenDialog: handleOpenDialog,
        isUploadDropTarget: nodeIsUploadDropTarget,
        onUploadDropTargetEnter: handleDirectoryDragEnter,
        onUploadDropTargetLeave: handleDirectoryDragLeave,
        isDndDragging: nodeIsDndDragging,
      };

      const renderFileRow = (isDndDropTarget: boolean) => (
        <FileRow
          {...fileRowProps}
          isDndDropTarget={isDndDropTarget}
        />
      );

      const fileRowElement = renderFileRow(nodeIsDndDropTarget && isValidDropTarget);

      let wrappedRow: React.ReactNode;
      if (canRename) {
        if (isDir && isValidDropTarget) {
          wrappedRow = (
            <DraggableFileRow node={node}>
              <DroppableDirectoryRow dirPath={node.path}>
                {(isOver, setNodeRef) => (
                  <div ref={setNodeRef}>
                    {renderFileRow(isOver)}
                  </div>
                )}
              </DroppableDirectoryRow>
            </DraggableFileRow>
          );
        } else {
          wrappedRow = (
            <DraggableFileRow node={node}>
              {fileRowElement}
            </DraggableFileRow>
          );
        }
      } else {
        wrappedRow = fileRowElement;
      }

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
          {wrappedRow}
          {isDir && isExpanded && (
            <ul className="flex flex-col gap-1 ml-3 pl-3 border-l border-border/40 relative">
              {renderTree(node.path, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }

  const hasTree = Boolean(root && childrenByDir[root]);

  return (
    <section
      ref={treeSectionRef}
      className={cn(
        'flex h-full min-h-0 flex-col overflow-hidden bg-transparent relative',
        isDraggingFiles && !dropTargetPath && 'ring-2 ring-primary ring-inset'
      )}
      onDragEnter={handleTreeDragEnter}
      onDragOver={handleTreeDragOver}
      onDragLeave={handleTreeDragLeave}
      onDrop={handleTreeDrop}
    >
      <input
        ref={contextUploadInputRef}
        type="file"
        multiple
        onChange={handleContextUploadInputChange}
        className="hidden"
      />
      {isDraggingFiles && (
        <FileDropOverlay
          pointerEventsNone
          icon={<RiUploadCloud2Line className="mx-auto mb-2 h-12 w-12 text-primary" />}
          title={dropTargetPath && dropTargetPath !== normalizedCurrentDirectory
            ? `Drop to upload to ${dropTargetPath.split('/').pop()}`
            : 'Drop files to upload'}
          subtitle={isUploading ? 'Uploading...' : 'Release to upload'}
        />
      )}

      <div className="flex items-center gap-2 border-b border-border/40 px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <RiSearchLine className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search files..."
            className="h-8 pl-8 pr-8 typography-meta"
          />
          {searchQuery.trim().length > 0 ? (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute right-2 top-2 inline-flex h-4 w-4 items-center justify-center text-muted-foreground hover:text-foreground"
              onClick={() => {
                setSearchQuery('');
                searchInputRef.current?.focus();
              }}
            >
              <RiCloseLine className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        {canCreateFile && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpenDialog('createFile', { path: currentDirectory, type: 'directory' })}
            className="h-8 w-8 p-0 flex-shrink-0"
            title="New File"
          >
            <RiFileAddLine className="h-4 w-4" />
          </Button>
        )}
        {canCreateFolder && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpenDialog('createFolder', { path: currentDirectory, type: 'directory' })}
            className="h-8 w-8 p-0 flex-shrink-0"
            title="New Folder"
          >
            <RiFolderAddLine className="h-4 w-4" />
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={() => void refreshRoot()} className="h-8 w-8 p-0 flex-shrink-0" title="Refresh">
          <RiRefreshLine className="h-4 w-4" />
        </Button>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="p-2">
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragStart={handleDndDragStart}
          onDragOver={handleDndDragOver}
          onDragEnd={handleDndDragEnd}
        >
          <ul className="flex flex-col">
            {searchQuery.trim().length > 0 && uploadPlaceholders.length > 0 ? (
              <li className="px-2 py-1 mb-1 border-b border-border/40">
                <div className="typography-meta text-muted-foreground mb-1">Uploading</div>
                <div className="flex flex-col gap-1">
                  {uploadPlaceholders.map((item) => (
                    <div key={`search-upload:${item.id}`}>
                      <UploadPlaceholderRow item={item} />
                    </div>
                  ))}
                </div>
              </li>
            ) : null}
            {searching ? (
              <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
                <RiLoader4Line className="h-4 w-4 animate-spin" />
                Searching...
              </li>
            ) : searchResults.length > 0 ? (
              searchResults.map((node) => {
                const isActive = selectedPath === node.path;
                return (
                  <li key={node.path}>
                    <button
                      type="button"
                      onClick={() => handleOpenFile(node)}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors',
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
            ) : hasTree && root ? (
              renderTree(root, 0)
            ) : (
              <li className="px-2 py-1 typography-meta text-muted-foreground">Loading...</li>
            )}
          </ul>

          <DragOverlay>
            {activeDndNode && (
              <div className="flex items-center gap-1.5 rounded-md border border-primary bg-background px-2 py-1 shadow-lg">
                <RiDragMove2Fill className="h-4 w-4 text-primary" />
                {activeDndNode.type === 'directory' ? (
                  <RiFolder3Fill className="h-4 w-4 flex-shrink-0 text-primary/60" />
                ) : (
                  getFileIcon(activeDndNode.path, activeDndNode.extension)
                )}
                <span className="typography-meta text-foreground truncate max-w-[220px]">
                  {activeDndNode.name}
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </ScrollableOverlay>

      <Dialog open={Boolean(moveConfirmDialog)} onOpenChange={(open) => !open && handleCancelMove()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Move {moveConfirmDialog?.source.type === 'directory' ? 'Folder' : 'File'}
            </DialogTitle>
            <DialogDescription>
              Move <strong>{moveConfirmDialog?.source.name}</strong> to{' '}
              <strong>{moveConfirmDialog?.targetDir.split('/').pop() || 'target folder'}</strong>?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelMove} disabled={isMoving}>
              Cancel
            </Button>
            <Button onClick={handleConfirmMove} disabled={isMoving}>
              {isMoving ? <RiLoader4Line className="animate-spin" /> : 'Move'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* CRUD dialogs (matching FilesView) */}
      <Dialog open={!!activeDialog} onOpenChange={(open) => !open && setActiveDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {activeDialog === 'createFile' && 'Create File'}
              {activeDialog === 'createFolder' && 'Create Folder'}
              {activeDialog === 'rename' && 'Rename'}
              {activeDialog === 'delete' && 'Delete'}
            </DialogTitle>
            <DialogDescription>
              {activeDialog === 'createFile' && `Create a new file in ${dialogData?.path ?? 'root'}`}
              {activeDialog === 'createFolder' && `Create a new folder in ${dialogData?.path ?? 'root'}`}
              {activeDialog === 'rename' && `Rename ${dialogData?.name}`}
              {activeDialog === 'delete' && `Are you sure you want to delete ${dialogData?.name}? This action cannot be undone.`}
            </DialogDescription>
          </DialogHeader>

          {activeDialog !== 'delete' && (
            <div className="py-4 space-y-4">
              <Input
                value={dialogInputValue}
                onChange={(e) => setDialogInputValue(e.target.value)}
                placeholder={activeDialog === 'rename' ? 'New name' : 'Name'}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleDialogSubmit();
                  }
                }}
                autoFocus
              />

              {activeDialog === 'createFile' && files.writeFile && (
                <>
                  <div className="relative flex items-center gap-2">
                    <div className="flex-1 h-px bg-border" />
                    <span className="text-xs text-muted-foreground">or</span>
                    <div className="flex-1 h-px bg-border" />
                  </div>

                  <input
                    ref={fileUploadInputRef}
                    type="file"
                    multiple
                    onChange={handleFileUploadFromDialog}
                    className="hidden"
                    id="sidebar-dialog-file-upload"
                  />

                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => fileUploadInputRef.current?.click()}
                  >
                    <RiUploadCloud2Line className="mr-2 h-4 w-4" />
                    Upload File
                  </Button>
                </>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setActiveDialog(null)} disabled={isDialogSubmitting}>
              Cancel
            </Button>
            <Button
              variant={activeDialog === 'delete' ? 'destructive' : 'default'}
              onClick={() => void handleDialogSubmit()}
              disabled={isDialogSubmitting || (activeDialog !== 'delete' && !dialogInputValue.trim())}
            >
              {isDialogSubmitting ? <RiLoader4Line className="animate-spin" /> : (
                activeDialog === 'delete' ? 'Delete' : 'Confirm'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
};
