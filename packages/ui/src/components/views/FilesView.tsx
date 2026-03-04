import React from 'react';

import {
  RiArrowLeftSLine,
  RiArrowDownSLine,
  RiClipboardLine,
  RiCloseLine,
  RiFileCopy2Line,
  RiCheckLine,
  RiFolder3Fill,
  RiFolderOpenFill,
  RiFolderReceivedLine,
  RiFullscreenExitLine,
  RiFullscreenLine,
  RiLoader4Line,
  RiRefreshLine,
  RiSearchLine,
  RiSave3Line,
  RiTextWrap,
  RiMore2Fill,
  RiFileAddLine,
  RiFolderAddLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFileCopyLine,
  RiUploadCloud2Line,
  RiDragMove2Fill,
  RiFileTransferLine,
  RiDownloadLine,
} from '@remixicon/react';
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { triggerFileDownload } from '@/lib/fileDownload';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CodeMirrorEditor } from '@/components/ui/CodeMirrorEditor';
import { PreviewToggleButton } from './PreviewToggleButton';
import { MediaViewer } from './MediaViewer';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { languageByExtension, loadLanguageByExtension } from '@/lib/codemirror/languageByExtension';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { File as PierreFile } from '@pierre/diffs/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDeviceInfo } from '@/lib/device';
import { cn, getModifierLabel, hasModifier } from '@/lib/utils';
import { getLanguageFromExtension, getImageMimeType, isImageFile } from '@/lib/toolHelpers';
import { getFileTypeInfo, getBinaryFileWarning, getFileCategory, looksLikeBinaryContent } from '@/lib/fileHelpers';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useUIStore } from '@/stores/useUIStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useGitStatus } from '@/stores/useGitStore';
import { buildCodeMirrorCommentWidgets, normalizeLineRange, useInlineCommentController } from '@/components/comments';
import { opencodeClient } from '@/lib/opencode/client';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { getDefaultTheme } from '@/lib/theme/themes';
import { openDesktopPath, openDesktopProjectInApp } from '@/lib/desktop';
import { OPEN_DIRECTORY_APP_IDS } from '@/lib/openInApps';
import { useOpenInAppsStore } from '@/stores/useOpenInAppsStore';

type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
  modifiedTime?: number;
};

type SelectedLineRange = {
  start: number;
  end: number;
};

const getParentDirectoryPath = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized) return '';
  if (normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)) {
    return normalized;
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash < 0) {
    return normalized;
  }
  if (lastSlash === 0) {
    return '/';
  }

  const parent = normalized.slice(0, lastSlash);
  if (/^[A-Za-z]:$/.test(parent)) {
    return `${parent}/`;
  }
  return parent;
};

const OpenInAppListIcon = ({ label, iconDataUrl }: { label: string; iconDataUrl?: string }) => {
  const [failed, setFailed] = React.useState(false);
  const initial = label.trim().slice(0, 1).toUpperCase() || '?';

  if (iconDataUrl && !failed) {
    return (
      <img
        src={iconDataUrl}
        alt=""
        className="h-4 w-4 rounded-sm"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        'h-4 w-4 rounded-sm flex items-center justify-center',
        'bg-[var(--surface-muted)] text-[9px] font-medium text-muted-foreground'
      )}
    >
      {initial}
    </span>
  );
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

  let normalized = raw.replace(/\/+/g, '/');
  if (hadUncPrefix && !normalized.startsWith('//')) {
    normalized = `/${normalized}`;
  }

  const isUnixRoot = normalized === '/';
  const isWindowsDriveRoot = /^[A-Za-z]:\/$/.test(normalized);
  if (!isUnixRoot && !isWindowsDriveRoot) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
};

const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value);
};

const toComparablePath = (value: string): string => {
  if (/^[A-Za-z]:\//.test(value)) {
    return value.toLowerCase();
  }
  return value;
};

const isPathWithinRoot = (path: string, root: string): boolean => {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (!normalizedRoot || !normalizedPath) return false;

  const comparableRoot = toComparablePath(normalizedRoot);
  const comparablePath = toComparablePath(normalizedPath);
  return comparablePath === comparableRoot || comparablePath.startsWith(`${comparableRoot}/`);
};

const getAncestorPaths = (filePath: string, root: string): string[] => {
  const normalizedRoot = normalizePath(root);
  const normalizedFile = normalizePath(filePath);

  // Ensure file is within root
  if (!isPathWithinRoot(normalizedFile, normalizedRoot)) return [];

  const relative = normalizedFile.slice(normalizedRoot.length).replace(/^\//, '');
  const parts = relative.split('/');
  const ancestors: string[] = [];
  let current = normalizedRoot;

  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    ancestors.push(current);
  }
  return ancestors;
};

const getDisplayPath = (root: string | null, path: string): string => {
  if (!path) {
    return '';
  }

  const normalizedFilePath = normalizePath(path);
  if (!root || !isPathWithinRoot(normalizedFilePath, root)) {
    return normalizedFilePath;
  }

  const relative = normalizedFilePath.slice(root.length);
  return relative.startsWith('/') ? relative.slice(1) : relative;
};

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

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

const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};

const isDirectoryReadError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();
  return normalized.includes('is a directory') || normalized.includes('eisdir');
};

const MAX_VIEW_CHARS = 200_000;
const FILE_CONTENT_CACHE_LIMIT = 64;
const FILE_STAT_CACHE_LIMIT = 256;
const FILE_STAT_CACHE_TTL_MS = 10_000;

type FileContentCacheEntry = {
  content: string;
  type: 'text' | 'binary' | 'media';
  loadedAt: number;
  sourceModifiedTime?: number;
};

type FileStatCacheEntry = {
  loadedAt: number;
  modifiedTime?: number;
};

const getFileIcon = (filePath: string, extension?: string): React.ReactNode => {
  return <FileTypeIcon filePath={filePath} extension={extension} />;
};

const isMarkdownFile = (path: string): boolean => {
  if (!path) return false;
  const ext = path.toLowerCase().split('.').pop();
  return ext === 'md' || ext === 'markdown';
};

interface FileRowProps {
  node: FileNode;
  isExpanded: boolean;
  isActive: boolean;
  isMobile: boolean;
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
  onDragStart?: (node: FileNode, event: React.DragEvent) => void;
  isUploadDropTarget?: boolean;
  onUploadDropTargetEnter?: (e: React.DragEvent, path: string) => void;
  onUploadDropTargetLeave?: (e: React.DragEvent) => void;
  // Internal DnD props
  isDndDragging?: boolean;
  isDndDropTarget?: boolean;
}

// Draggable wrapper for internal DnD
const DraggableFileRow: React.FC<{
  node: FileNode;
  children: React.ReactNode;
}> = ({ node, children }) => {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `file-drag:${node.path}`,
    data: { type: 'file-move', node },
  });

  const handlePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (listeners?.onPointerDown) {
        (listeners.onPointerDown as (event: React.PointerEvent) => void)(e);
      }
    },
    [listeners],
  );

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      onPointerDown={handlePointerDown}
      className={isDragging ? 'opacity-30' : undefined}
    >
      {children}
    </div>
  );
};

// Droppable wrapper for directories
const DroppableDirectoryRow: React.FC<{
  dirPath: string;
  children: (isOver: boolean, setNodeRef: (el: HTMLElement | null) => void) => React.ReactNode;
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
  isMobile,
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
  onDragStart,
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
  const [isNativeDragging, setIsNativeDragging] = React.useState(false);

  const canOpenContextMenu = canRename
    || canCreateFile
    || canCreateFolder
    || canDelete
    || canReveal
    || (!isDir && canDownload)
    || (isDir && canUpload);

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

  // Native drag for file export (drag-out to desktop)
  const handleNativeDragStart = React.useCallback((event: React.DragEvent) => {
    // Only enable native drag for files on desktop (for drag-out feature)
    if (isDir) {
      event.preventDefault();
      return;
    }
    setIsNativeDragging(true);
    onDragStart?.(node, event);
  }, [isDir, node, onDragStart]);

  const handleNativeDragEnd = React.useCallback(() => {
    setIsNativeDragging(false);
  }, []);

  // Upload drop target handlers (for external file drops)
  const handleUploadDragEnter = React.useCallback((e: React.DragEvent) => {
    if (isDir && onUploadDropTargetEnter) {
      onUploadDropTargetEnter(e, node.path);
    }
  }, [isDir, node.path, onUploadDropTargetEnter]);

  const handleUploadDragLeave = React.useCallback((e: React.DragEvent) => {
    if (isDir && onUploadDropTargetLeave) {
      onUploadDropTargetLeave(e);
    }
  }, [isDir, onUploadDropTargetLeave]);

  const isDragging = isDndDragging || isNativeDragging;
  const isDropTarget = isUploadDropTarget || isDndDropTarget;

  // Disable native drag when internal DnD (dnd-kit) is enabled to prevent conflicts
  const enableNativeDrag = !isDir && Boolean(onDragStart) && !isMobile && !permissions.canRename;

  return (
    <div
      className={cn(
        "group relative flex items-center",
        isDragging && "opacity-50"
      )}
      onContextMenu={!isMobile ? handleContextMenu : undefined}
      // Native drag for desktop file export only (disabled when internal DnD is active)
      draggable={enableNativeDrag}
      onDragStart={enableNativeDrag ? handleNativeDragStart : undefined}
      onDragEnd={enableNativeDrag ? handleNativeDragEnd : undefined}
      // Upload drop target (for external files)
      onDragEnter={isDir ? handleUploadDragEnter : undefined}
      onDragLeave={isDir ? handleUploadDragLeave : undefined}
    >
      <button
        type="button"
        onClick={handleInteraction}
        onContextMenu={!isMobile ? handleContextMenu : undefined}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-foreground transition-colors pr-8 select-none',
          isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40',
          !isDir && !isMobile && 'cursor-grab',
          isDragging && 'cursor-grabbing',
          isDropTarget && 'ring-2 ring-primary ring-offset-2 ring-offset-background bg-primary/10',
          // Ensure touch targets meet minimum size (36px)
          isMobile && 'min-h-9'
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
        <span
          className="min-w-0 flex-1 truncate typography-meta"
          title={node.path}
        >
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
        <div className={cn(
          "absolute right-1 top-1/2 -translate-y-1/2",
          !isMobile && "opacity-0 focus-within:opacity-100 group-hover:opacity-100",
          isMobile && "opacity-100"
        )}>
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
            <DropdownMenuContent align="end" side={isMobile ? "bottom" : "bottom"} onCloseAutoFocus={() => setContextMenuPath(null)}>
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

// Helper to check if dropping source into target would create a cycle
const isDescendantPath = (sourcePath: string, targetPath: string): boolean => {
  const normalizedSource = normalizePath(sourcePath);
  const normalizedTarget = normalizePath(targetPath);
  // Check if target is the source itself or a descendant of source
  return normalizedTarget === normalizedSource || normalizedTarget.startsWith(`${normalizedSource}/`);
};

interface FilesViewProps {
  mode?: 'full' | 'editor-only';
}

export const FilesView: React.FC<FilesViewProps> = ({ mode = 'full' }) => {
  const { files, runtime } = useRuntimeAPIs();
  const { currentTheme, availableThemes, lightThemeId, darkThemeId } = useThemeSystem();
  const { isMobile, screenWidth } = useDeviceInfo();
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();

  const currentDirectory = useEffectiveDirectory() ?? '';
  const root = normalizePath(currentDirectory.trim());
  const showEditorTabsRow = isMobile || mode !== 'editor-only';
  const suppressFileLoadingIndicator = mode === 'editor-only' && !isMobile;
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const gitStatus = useGitStatus(currentDirectory);

  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const fileUploadInputRef = React.useRef<HTMLInputElement>(null);
  const contextUploadInputRef = React.useRef<HTMLInputElement>(null);

  const [showMobilePageContent, setShowMobilePageContent] = React.useState(false);
  const [wrapLines, setWrapLines] = React.useState(isMobile);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [isSearchOpen, setIsSearchOpen] = React.useState(false);
  const [textViewMode, setTextViewMode] = React.useState<'view' | 'edit'>('edit');
  const [mdViewMode, setMdViewMode] = React.useState<'preview' | 'edit'>('edit');

  const lightTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? getDefaultTheme(false),
    [availableThemes, lightThemeId],
  );
  const darkTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? getDefaultTheme(true),
    [availableThemes, darkThemeId],
  );

  React.useEffect(() => {
    ensurePierreThemeRegistered(lightTheme);
    ensurePierreThemeRegistered(darkTheme);
  }, [lightTheme, darkTheme]);

  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const openPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.openPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const addOpenPath = useFilesViewTabsStore((state) => state.addOpenPath);
  const removeOpenPath = useFilesViewTabsStore((state) => state.removeOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const expandPaths = useFilesViewTabsStore((state) => state.expandPaths);

  const toFileNode = React.useCallback((path: string): FileNode => {
    const normalized = normalizePath(path);
    const parts = normalized.split('/');
    const name = parts[parts.length - 1] || normalized;
    const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
    return {
      name,
      path: normalized,
      type: 'file',
      extension,
    };
  }, []);

  const openFiles = React.useMemo(() => openPaths.map(toFileNode), [openPaths, toFileNode]);
  const effectiveSelectedPath = React.useMemo(() => selectedPath ?? openPaths[0] ?? null, [openPaths, selectedPath]);
  const selectedFile = React.useMemo(() => (effectiveSelectedPath ? toFileNode(effectiveSelectedPath) : null), [effectiveSelectedPath, toFileNode]);

  // Editor tabs horizontal scroll fades
  const editorTabsScrollRef = React.useRef<HTMLDivElement>(null);
  const [editorTabsOverflow, setEditorTabsOverflow] = React.useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const updateEditorTabsOverflow = React.useCallback(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    setEditorTabsOverflow({
      left: el.scrollLeft > 2,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);
  React.useEffect(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    updateEditorTabsOverflow();
    el.addEventListener('scroll', updateEditorTabsOverflow, { passive: true });
    const ro = new ResizeObserver(updateEditorTabsOverflow);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateEditorTabsOverflow);
      ro.disconnect();
    };
  }, [updateEditorTabsOverflow, openFiles.length]);

  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const inFlightDirsRef = React.useRef<Set<string>>(new Set());

  const [searchResults, setSearchResults] = React.useState<FileNode[]>([]);
  const [searching, setSearching] = React.useState(false);

  const [fileContent, setFileContent] = React.useState<string>('');
  const [fileLoading, setFileLoading] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [desktopImageSrc, setDesktopImageSrc] = React.useState<string>('');

  const [loadedFilePath, setLoadedFilePath] = React.useState<string | null>(null);
  const fileContentCacheRef = React.useRef<Map<string, FileContentCacheEntry>>(new Map());
  const fileStatCacheRef = React.useRef<Map<string, FileStatCacheEntry>>(new Map());
  const selectionValidationRef = React.useRef(0);
  const activeFileLoadRequestRef = React.useRef(0);

  const clearFileContentCache = React.useCallback(() => {
    fileContentCacheRef.current = new Map();
    fileStatCacheRef.current = new Map();
  }, []);

  const setCachedFileEntry = React.useCallback((path: string, entry: Omit<FileContentCacheEntry, 'loadedAt'>) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return;
    }

    const cache = fileContentCacheRef.current;
    cache.set(normalizedPath, {
      ...entry,
      loadedAt: Date.now(),
    });

    if (cache.size > FILE_CONTENT_CACHE_LIMIT) {
      let oldestPath: string | null = null;
      let oldestTimestamp = Number.POSITIVE_INFINITY;

      for (const [cachePath, cacheEntry] of cache.entries()) {
        if (cacheEntry.loadedAt < oldestTimestamp) {
          oldestPath = cachePath;
          oldestTimestamp = cacheEntry.loadedAt;
        }
      }

      if (oldestPath) {
        cache.delete(oldestPath);
      }
    }
  }, []);

  const getCachedFileEntry = React.useCallback((path: string): FileContentCacheEntry | null => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return null;
    }

    const existing = fileContentCacheRef.current.get(normalizedPath);
    if (!existing) {
      return null;
    }

    const refreshed = {
      ...existing,
      loadedAt: Date.now(),
    };

    fileContentCacheRef.current.set(normalizedPath, refreshed);
    return refreshed;
  }, []);

  const setCachedFileStat = React.useCallback((path: string, modifiedTime: number | undefined) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return;
    }

    const cache = fileStatCacheRef.current;
    cache.set(normalizedPath, {
      loadedAt: Date.now(),
      modifiedTime,
    });

    if (cache.size > FILE_STAT_CACHE_LIMIT) {
      let oldestPath: string | null = null;
      let oldestTimestamp = Number.POSITIVE_INFINITY;

      for (const [cachePath, cacheEntry] of cache.entries()) {
        if (cacheEntry.loadedAt < oldestTimestamp) {
          oldestPath = cachePath;
          oldestTimestamp = cacheEntry.loadedAt;
        }
      }

      if (oldestPath) {
        cache.delete(oldestPath);
      }
    }
  }, []);

  const getCachedFileStat = React.useCallback((path: string): FileStatCacheEntry | null => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return null;
    }

    const existing = fileStatCacheRef.current.get(normalizedPath);
    if (!existing) {
      return null;
    }

    const now = Date.now();
    if (now - existing.loadedAt > FILE_STAT_CACHE_TTL_MS) {
      fileStatCacheRef.current.delete(normalizedPath);
      return null;
    }

    const refreshed = {
      ...existing,
      loadedAt: now,
    };

    fileStatCacheRef.current.set(normalizedPath, refreshed);
    return refreshed;
  }, []);

  const invalidateCachedPath = React.useCallback((path: string) => {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath) {
      return;
    }
    fileContentCacheRef.current.delete(normalizedPath);
    fileStatCacheRef.current.delete(normalizedPath);
  }, []);

  const invalidateCachedPathPrefix = React.useCallback((prefixPath: string) => {
    const normalizedPrefix = normalizePath(prefixPath);
    if (!normalizedPrefix) {
      return;
    }

    const prefixWithSlash = `${normalizedPrefix}/`;
    for (const cachePath of Array.from(fileContentCacheRef.current.keys())) {
      if (cachePath === normalizedPrefix || cachePath.startsWith(prefixWithSlash)) {
        fileContentCacheRef.current.delete(cachePath);
      }
    }

    for (const cachePath of Array.from(fileStatCacheRef.current.keys())) {
      if (cachePath === normalizedPrefix || cachePath.startsWith(prefixWithSlash)) {
        fileStatCacheRef.current.delete(cachePath);
      }
    }
  }, []);

  const resolveNodeModifiedTime = React.useCallback((node: Pick<FileNode, 'path' | 'modifiedTime'>): number | undefined => {
    if (typeof node.modifiedTime === 'number') {
      return node.modifiedTime;
    }

    for (const nodes of Object.values(childrenByDir)) {
      const match = nodes.find((candidate) => candidate.path === node.path);
      if (match && typeof match.modifiedTime === 'number') {
        return match.modifiedTime;
      }
    }

    return undefined;
  }, [childrenByDir]);

  const resolveCurrentModifiedTime = React.useCallback(async (node: Pick<FileNode, 'path' | 'modifiedTime'>): Promise<number | undefined> => {
    // Prefer fresh stat call with TTL cache over stale node.modifiedTime
    if (files.stat) {
      const cachedStat = getCachedFileStat(node.path);
      if (cachedStat) {
        return cachedStat.modifiedTime;
      }

      try {
        const stat = await files.stat(node.path);
        const modifiedTime = typeof stat?.modifiedTime === 'number' ? stat.modifiedTime : undefined;
        setCachedFileStat(node.path, modifiedTime);
        return modifiedTime;
      } catch {
        // Fall through to node baseline if stat fails
      }
    }

    // Fall back to node.modifiedTime from directory listing as baseline
    const fromNode = resolveNodeModifiedTime(node);
    if (typeof fromNode === 'number') {
      return fromNode;
    }

    return undefined;
  }, [files, getCachedFileStat, resolveNodeModifiedTime, setCachedFileStat]);

  const isCacheEntryFresh = React.useCallback((
    cacheEntry: FileContentCacheEntry,
    currentModifiedTime: number | undefined,
  ): boolean => {
    if (typeof currentModifiedTime !== 'number') {
      return true;
    }

    if (typeof cacheEntry.sourceModifiedTime !== 'number') {
      return false;
    }

    return Math.abs(cacheEntry.sourceModifiedTime - currentModifiedTime) < 1;
  }, []);

  const [draftContent, setDraftContent] = React.useState('');
  const [draftContentByPath, setDraftContentByPath] = React.useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = React.useState(false);

  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);
  const pendingSelectFileRef = React.useRef<FileNode | null>(null);
  const pendingTabRef = React.useRef<import('@/stores/useUIStore').MainTab | null>(null);
  const pendingClosePathRef = React.useRef<string | null>(null);
  const skipDirtyOnceRef = React.useRef(false);
  const copiedContentTimeoutRef = React.useRef<number | null>(null);
  const copiedPathTimeoutRef = React.useRef<number | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorViewsByPathRef = React.useRef<Map<string, EditorView>>(new Map());
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [editorViewReadyNonce, setEditorViewReadyNonce] = React.useState(0);
  const pendingNavigationRafRef = React.useRef<number | null>(null);
  const pendingNavigationCycleRef = React.useRef<{ key: string; attempts: number }>({ key: '', attempts: 0 });

  const setDraftForPath = React.useCallback((path: string, value: string) => {
    setDraftContentByPath((previous) => {
      if (previous[path] === value) {
        return previous;
      }

      return {
        ...previous,
        [path]: value,
      };
    });
  }, []);

  React.useEffect(() => {
    const openPathSet = new Set(openFiles.map((file) => file.path));
    setDraftContentByPath((previous) => {
      let hasChanges = false;
      const next: Record<string, string> = {};

      for (const [path, value] of Object.entries(previous)) {
        if (openPathSet.has(path)) {
          next[path] = value;
        } else {
          hasChanges = true;
        }
      }

      return hasChanges ? next : previous;
    });
  }, [openFiles]);

  React.useEffect(() => {
    return () => {
      if (pendingNavigationRafRef.current !== null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(pendingNavigationRafRef.current);
        pendingNavigationRafRef.current = null;
      }
    };
  }, []);

  const [activeDialog, setActiveDialog] = React.useState<'createFile' | 'createFolder' | 'rename' | 'delete' | null>(null);
  const [dialogData, setDialogData] = React.useState<{ path: string; name?: string; type?: 'file' | 'directory' } | null>(null);
  const [dialogInputValue, setDialogInputValue] = React.useState('');
  const [isDialogSubmitting, setIsDialogSubmitting] = React.useState(false);
  const [contextMenuPath, setContextMenuPath] = React.useState<string | null>(null);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [copiedPath, setCopiedPath] = React.useState(false);

  const canCreateFile = Boolean(files.writeFile);
  const canCreateFolder = Boolean(files.createDirectory);
  const canRename = Boolean(files.rename);
  const canDelete = Boolean(files.delete);
  const canReveal = runtime.isDesktop && Boolean(files.revealPath);
  const openInApps = useOpenInAppsStore((state) => state.availableApps);
  const openInCacheStale = useOpenInAppsStore((state) => state.isCacheStale);
  const initializeOpenInApps = useOpenInAppsStore((state) => state.initialize);
  const loadOpenInApps = useOpenInAppsStore((state) => state.loadInstalledApps);

  React.useEffect(() => {
    initializeOpenInApps();
  }, [initializeOpenInApps]);

  const handleRevealPath = React.useCallback((targetPath: string) => {
    if (!runtime.isDesktop || !files.revealPath) {
      return;
    }
    void files.revealPath(targetPath).catch(() => {
      toast.error('Failed to reveal path');
    });
  }, [files, runtime.isDesktop]);

  const handleOpenInApp = React.useCallback(async (app: { id: string; appName: string }) => {
    if (!selectedFile?.path || !root) {
      return;
    }

    const fileDirectory = getParentDirectoryPath(selectedFile.path) || root;

    if (OPEN_DIRECTORY_APP_IDS.has(app.id)) {
      const openedDirectory = await openDesktopPath(fileDirectory, app.appName);
      if (!openedDirectory) {
        toast.error(`Failed to open in ${app.appName}`);
      }
      return;
    }

    const openedInApp = await openDesktopProjectInApp(root, app.id, app.appName, selectedFile.path);
    if (openedInApp) {
      return;
    }

    const openedFile = await openDesktopPath(selectedFile.path, app.appName);
    if (openedFile) {
      return;
    }

    const openedDirectory = await openDesktopPath(fileDirectory, app.appName);
    if (!openedDirectory) {
      toast.error(`Failed to open in ${app.appName}`);
    }
  }, [root, selectedFile?.path]);

  const handleOpenDialog = React.useCallback((type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => {
    setActiveDialog(type);
    setDialogData(data);
    setDialogInputValue(type === 'rename' ? data.name || '' : '');
    setIsDialogSubmitting(false);
  }, []);

  // Line selection state for commenting
  const [lineSelection, setLineSelection] = React.useState<SelectedLineRange | null>(null);
  const isSelectingRef = React.useRef(false);
  const selectionStartRef = React.useRef<number | null>(null);
  const [isDragging, setIsDragging] = React.useState(false);

  // Drag-and-drop upload state
  const [isDraggingFiles, setIsDraggingFiles] = React.useState(false);
  const [dropTargetPath, setDropTargetPath] = React.useState<string | null>(null);
  const [contextUploadTargetPath, setContextUploadTargetPath] = React.useState<string | null>(null);
  const [isUploading, setIsUploading] = React.useState(false);
  const dragCounterRef = React.useRef(0);

  // Internal DnD state (for moving files/folders)
  const [activeDndNode, setActiveDndNode] = React.useState<FileNode | null>(null);
  const [dndDropTargetPath, setDndDropTargetPath] = React.useState<string | null>(null);
  const [moveConfirmDialog, setMoveConfirmDialog] = React.useState<{
    source: FileNode;
    targetDir: string;
  } | null>(null);
  const [isMoving, setIsMoving] = React.useState(false);

  // Binary file warning dialog state
  const [binaryWarningDialog, setBinaryWarningDialog] = React.useState<{
    node: FileNode;
    title: string;
    message: string;
  } | null>(null);
  const [externalChangeDialog, setExternalChangeDialog] = React.useState<{
    node: FileNode;
    cachedEntry: FileContentCacheEntry;
    modifiedTime?: number;
  } | null>(null);
  const [contentDetectedBinaryPath, setContentDetectedBinaryPath] = React.useState<string | null>(null);

  // Configure DnD sensors - different for desktop vs mobile
  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: {
      distance: 8, // Require 8px of movement before drag starts
    },
  });
  const touchSensor = useSensor(TouchSensor, {
    activationConstraint: {
      delay: 400, // Long press delay
      tolerance: 5, // Allow slight movement during delay
    },
  });
  const dndSensors = useSensors(
    isMobile ? touchSensor : pointerSensor
  );

  // Session/config for sending comments
  const setMainTabGuard = useUIStore((state) => state.setMainTabGuard);
  const pendingFileNavigation = useUIStore((state) => state.pendingFileNavigation);
  const setPendingFileNavigation = useUIStore((state) => state.setPendingFileNavigation);
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const setPendingFileFocusPath = useUIStore((state) => state.setPendingFileFocusPath);

  // Global mouseup to end drag selection
  React.useEffect(() => {
    const handleGlobalMouseUp = () => {
      isSelectingRef.current = false;
      selectionStartRef.current = null;
      setIsDragging(false);
    };
    document.addEventListener('mouseup', handleGlobalMouseUp);
    return () => document.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  React.useEffect(() => {
    return () => {
      if (copiedContentTimeoutRef.current !== null) {
        window.clearTimeout(copiedContentTimeoutRef.current);
      }
      if (copiedPathTimeoutRef.current !== null) {
        window.clearTimeout(copiedPathTimeoutRef.current);
      }
    };
  }, []);

  // Extract selected code
  const extractSelectedCode = React.useCallback((content: string, range: SelectedLineRange): string => {
    const lines = content.split('\n');
    const startLine = Math.max(1, range.start);
    const endLine = Math.min(lines.length, range.end);
    if (startLine > endLine) return '';
    return lines.slice(startLine - 1, endLine).join('\n');
  }, []);

  const fileCommentController = useInlineCommentController<SelectedLineRange>({
    source: 'file',
    fileLabel: selectedFile?.path ?? null,
    language: selectedFile?.path ? getLanguageFromExtension(selectedFile.path) || 'text' : 'text',
    getCodeForRange: (range) => extractSelectedCode(fileContent, normalizeLineRange(range)),
    toStoreRange: (range) => ({ startLine: range.start, endLine: range.end }),
    fromDraftRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
  });

  const {
    drafts: filesFileDrafts,
    commentText,
    editingDraftId,
    setSelection: setCommentSelection,
    saveComment,
    cancel,
    reset,
    startEdit,
    deleteDraft,
  } = fileCommentController;

  React.useEffect(() => {
    setLineSelection(null);
    reset();
    setMainTabGuard(null);
    setIsSaving(false);
  }, [selectedFile?.path, reset, setMainTabGuard]);

  React.useEffect(() => {
    setCommentSelection(lineSelection);
  }, [lineSelection, setCommentSelection]);

  React.useEffect(() => {
    if (!lineSelection && !editingDraftId) return;

    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      if (target.closest('[data-comment-input="true"]') || target.closest('[data-comment-card="true"]')) return;
      if (target.closest('.cm-gutterElement')) return;
      if (target.closest('[data-sonner-toast]') || target.closest('[data-sonner-toaster]')) return;

      setLineSelection(null);
      cancel();
    };

    const timeoutId = setTimeout(() => {
      document.addEventListener('click', handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('click', handleClickOutside);
    };
  }, [cancel, editingDraftId, lineSelection]);

  const handleSaveComment = React.useCallback((text: string, range?: { start: number; end: number }) => {
    const finalRange = range ?? lineSelection ?? undefined;
    if (range) {
      setLineSelection(range);
    }
    saveComment(text, finalRange);
    setLineSelection(null);
  }, [lineSelection, saveComment]);

  const mapDirectoryEntries = React.useCallback((
    dirPath: string,
    entries: Array<{ name: string; path: string; isDirectory: boolean; modifiedTime?: number }>,
  ): FileNode[] => {
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
        return {
          name,
          path,
          type,
          extension,
          modifiedTime: typeof entry.modifiedTime === 'number' ? entry.modifiedTime : undefined,
        };
      });

    return sortNodes(nodes);
  }, [showGitignored, showHidden]);

  const loadDirectory = React.useCallback(async (dirPath: string) => {
    const normalizedDir = normalizePath(dirPath.trim());
    if (!normalizedDir) {
      return;
    }

    if (loadedDirsRef.current.has(normalizedDir) || inFlightDirsRef.current.has(normalizedDir)) {
      return;
    }

    inFlightDirsRef.current = new Set(inFlightDirsRef.current);
    inFlightDirsRef.current.add(normalizedDir);

    const respectGitignore = !showGitignored;
    const listPromise = runtime.isDesktop
      ? files.listDirectory(normalizedDir, { respectGitignore }).then((result) => result.entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
        modifiedTime: entry.modifiedTime,
      })))
      : opencodeClient.listLocalDirectory(normalizedDir, { respectGitignore }).then((result) => result.map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
        modifiedTime: entry.modifiedTime,
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
    if (!root) {
      return;
    }

    clearFileContentCache();
    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));

    await loadDirectory(root);
  }, [clearFileContentCache, loadDirectory, root]);

  const lastFilesViewDirRef = React.useRef<string>('');
  const lastFilesViewTreeKeyRef = React.useRef<string>('');

  React.useEffect(() => {
    if (!root) {
      return;
    }

    const treeKey = `${root}|h${showHidden ? '1' : '0'}|g${showGitignored ? '1' : '0'}`;
    const dirChanged = lastFilesViewDirRef.current !== root;
    const treeKeyChanged = lastFilesViewTreeKeyRef.current !== treeKey;

    if (!dirChanged && !treeKeyChanged) {
      return;
    }

    if (dirChanged) {
      lastFilesViewDirRef.current = root;
      clearFileContentCache();
      setFileContent('');
      setDraftContentByPath({});
      setFileError(null);
      setDesktopImageSrc('');
      setLoadedFilePath(null);
      setShowMobilePageContent(false);
    }

    if (treeKeyChanged) {
      lastFilesViewTreeKeyRef.current = treeKey;
      loadedDirsRef.current = new Set();
      inFlightDirsRef.current = new Set();
      setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      void loadDirectory(root);
    }
  }, [clearFileContentCache, loadDirectory, root, showGitignored, showHidden]);

  const handleDialogSubmit = React.useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogData || !activeDialog) return;

    setIsDialogSubmitting(true);
    const finishDialogOperation = () => {
      setActiveDialog(null);
    };

    const failDialogOperation = (message: string) => {
      toast.error(message);
    };

    const done = () => {
      setIsDialogSubmitting(false);
    };

    if (activeDialog === 'createFile') {
      if (!dialogInputValue.trim()) {
        failDialogOperation('Filename is required');
        done();
        return;
      }
      if (!files.writeFile) {
        failDialogOperation('Write not supported');
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);
      await files.writeFile(newPath, '')
        .then(async (result) => {
          if (result.success) {
            invalidateCachedPath(newPath);
            toast.success('File created');
            await refreshRoot();
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation('Operation failed'))
        .finally(done);
      return;
    }

    if (activeDialog === 'createFolder') {
      if (!dialogInputValue.trim()) {
        failDialogOperation('Folder name is required');
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
          finishDialogOperation();
        })
        .catch(() => failDialogOperation('Operation failed'))
        .finally(done);
      return;
    }

    if (activeDialog === 'rename') {
      if (!dialogInputValue.trim()) {
        failDialogOperation('Name is required');
        done();
        return;
      }

      if (!files.rename) {
        failDialogOperation('Rename not supported');
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
            invalidateCachedPathPrefix(oldPath);
            invalidateCachedPathPrefix(newPath);
            toast.success('Renamed successfully');
            await refreshRoot();
            if (root) {
              removeOpenPathsByPrefix(root, oldPath);
            }
            if (selectedFile?.path === oldPath || selectedFile?.path.startsWith(`${oldPath}/`)) {
              if (root) {
                setSelectedPath(root, null);
              }
              setFileContent('');
              setFileError(null);
              setDesktopImageSrc('');
              setLoadedFilePath(null);
              if (isMobile) {
                setShowMobilePageContent(false);
              }
            }
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation('Operation failed'))
        .finally(done);
      return;
    }

    if (activeDialog === 'delete') {
      if (!files.delete) {
        failDialogOperation('Delete not supported');
        done();
        return;
      }

      await files.delete(dialogData.path)
        .then(async (result) => {
          if (result.success) {
            invalidateCachedPathPrefix(dialogData.path);
            toast.success('Deleted successfully');
            await refreshRoot();
            if (root) {
              removeOpenPathsByPrefix(root, dialogData.path);
            }
            if (selectedFile?.path === dialogData.path || selectedFile?.path.startsWith(`${dialogData.path}/`)) {
              if (root) {
                setSelectedPath(root, null);
              }
              setFileContent('');
              setFileError(null);
              setDesktopImageSrc('');
              setLoadedFilePath(null);
              if (isMobile) {
                setShowMobilePageContent(false);
              }
            }
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation('Operation failed'))
        .finally(done);
      return;
    }

    done();
  }, [activeDialog, dialogData, dialogInputValue, files, invalidateCachedPath, invalidateCachedPathPrefix, refreshRoot, isMobile, removeOpenPathsByPrefix, root, selectedFile?.path, setSelectedPath]);

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
        if (cancelled) {
          return;
        }

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

  const readFile = React.useCallback(async (path: string): Promise<string> => {
    if (files.readFile) {
      const result = await files.readFile(path);
      return result.content ?? '';
    }

    const response = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: response.statusText }));
      throw new Error((error as { error?: string }).error || 'Failed to read file');
    }
    return response.text();
  }, [files]);

  const displayedContent = React.useMemo(() => {
    return fileContent.length > MAX_VIEW_CHARS
      ? `${fileContent.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`
      : fileContent;
  }, [fileContent]);

  const isDirty = React.useMemo(() => draftContent !== displayedContent, [draftContent, displayedContent]);

  const saveDraft = React.useCallback(async () => {
    if (!selectedFile || !files.writeFile) {
      toast.error('Saving not supported');
      return;
    }

    if (!isDirty) {
      return;
    }

    setIsSaving(true);

    await files.writeFile(selectedFile.path, draftContent)
      .then(async (result) => {
        if (!result?.success) {
          toast.error('Failed to write file');
          return;
        }

        const sourceModifiedTime = await resolveCurrentModifiedTime(selectedFile);
        setFileContent(draftContent);
        setDraftForPath(selectedFile.path, draftContent);
        setCachedFileEntry(selectedFile.path, {
          content: draftContent,
          type: 'text',
          sourceModifiedTime,
        });
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : 'Save failed');
      })
      .finally(() => {
        setIsSaving(false);
      });
  }, [draftContent, files, isDirty, resolveCurrentModifiedTime, selectedFile, setCachedFileEntry, setDraftForPath]);

  const applyCachedFileState = React.useCallback((path: string, cacheEntry: FileContentCacheEntry) => {
    setFileError(null);
    setDesktopImageSrc('');

    if (cacheEntry.type === 'binary') {
      setFileContent('');
      setDraftContent('');
      setDraftForPath(path, '');
      setContentDetectedBinaryPath(path);
    } else if (cacheEntry.type === 'media') {
      setFileContent('');
      setDraftContent('');
      setDraftForPath(path, '');
      setContentDetectedBinaryPath(null);
    } else {
      const nextDraft = cacheEntry.content.length > MAX_VIEW_CHARS
        ? `${cacheEntry.content.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`
        : cacheEntry.content;
      setContentDetectedBinaryPath(null);
      setFileContent(cacheEntry.content);
      setDraftContent(nextDraft);
      setDraftForPath(path, nextDraft);
    }

    setFileLoading(false);
    setLoadedFilePath(path);

    if (isMobile) {
      setShowMobilePageContent(true);
    }
  }, [isMobile, setDraftForPath]);

  React.useEffect(() => {
    if (!isDirty) {
      setMainTabGuard(null);
      return;
    }

    const guard = (_nextTab: import('@/stores/useUIStore').MainTab) => {
      if (skipDirtyOnceRef.current) {
        skipDirtyOnceRef.current = false;
        return true;
      }
      setConfirmDiscardOpen(true);
      pendingTabRef.current = _nextTab;
      return false;
    };

    setMainTabGuard(guard);

    return () => {
      const currentGuard = useUIStore.getState().mainTabGuard;
      if (currentGuard === guard) {
        setMainTabGuard(null);
      }
    };
  }, [isDirty, setMainTabGuard]);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!hasModifier(e)) {
        return;
      }

      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (!isSaving) {
          void saveDraft();
        }
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSaving, saveDraft]);

  const loadSelectedFile = React.useCallback(async (node: FileNode) => {
    const requestId = ++activeFileLoadRequestRef.current;
    const isCurrentRequest = () => requestId === activeFileLoadRequestRef.current;

    setFileError(null);
    setDesktopImageSrc('');
    setContentDetectedBinaryPath(null);
    setLoadedFilePath(null);

    const selectedIsImage = isImageFile(node.path);
    const isSvg = node.path.toLowerCase().endsWith('.svg');
    const fileCategory = getFileCategory(node.path);
    const isMediaFile = fileCategory === 'pdf' || fileCategory === 'audio' || fileCategory === 'video';

    if (isMobile) {
      setShowMobilePageContent(true);
    }

    // Desktop: binary images are loaded via readFileBinary (data URL).
    if (runtime.isDesktop && selectedIsImage && !isSvg) {
      setFileContent('');
      setDraftContent('');
      setFileLoading(true);
      return;
    }

    // Web: binary images should not be read as utf8.
    if (!runtime.isDesktop && selectedIsImage && !isSvg) {
      setFileContent('');
      setDraftContent('');
      setDraftForPath(node.path, '');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      return;
    }

    // PDF, audio, and video files are displayed via the /api/fs/raw endpoint
    // and should not be read as text content.
    if (isMediaFile) {
      const sourceModifiedTime = resolveNodeModifiedTime(node);
      setFileContent('');
      setDraftContent('');
      setDraftForPath(node.path, '');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      setCachedFileEntry(node.path, {
        content: '',
        type: 'media',
        sourceModifiedTime,
      });
      return;
    }

    // Non-displayable binary files (archives, executables, fonts, etc.)
    // should not be read as UTF-8 text.
    const fileTypeInfo = getFileTypeInfo(node.path);
    if (fileTypeInfo.isBinary && !fileTypeInfo.canDisplay) {
      const sourceModifiedTime = await resolveCurrentModifiedTime(node);
      if (!isCurrentRequest()) {
        return;
      }

      setFileContent('');
      setDraftContent('');
      setDraftForPath(node.path, '');
      setLoadedFilePath(node.path);
      setFileLoading(false);
      setCachedFileEntry(node.path, {
        content: '',
        type: 'binary',
        sourceModifiedTime,
      });
      return;
    }

    setFileLoading(true);

    await readFile(node.path)
      .then(async (content) => {
        if (!isCurrentRequest()) {
          return;
        }

        if (looksLikeBinaryContent(content)) {
          const sourceModifiedTime = await resolveCurrentModifiedTime(node);
          if (!isCurrentRequest()) {
            return;
          }

          setFileContent('');
          setDraftContent('');
          setDraftForPath(node.path, '');
          setContentDetectedBinaryPath(node.path);
          setLoadedFilePath(node.path);
          setCachedFileEntry(node.path, {
            content: '',
            type: 'binary',
            sourceModifiedTime,
          });
          return;
        }

        const sourceModifiedTime = await resolveCurrentModifiedTime(node);
        if (!isCurrentRequest()) {
          return;
        }

        const nextDraft = content.length > MAX_VIEW_CHARS
          ? `${content.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`
          : content;

        setFileContent(content);
        setDraftContent(nextDraft);
        setDraftForPath(node.path, nextDraft);
        setLoadedFilePath(node.path);
        setCachedFileEntry(node.path, {
          content,
          type: 'text',
          sourceModifiedTime,
        });
      })
      .catch((error) => {
        if (!isCurrentRequest()) {
          return;
        }

        invalidateCachedPath(node.path);
        if (isDirectoryReadError(error)) {
          if (root) {
            setSelectedPath(root, null);
          }
          setFileError(null);
          setFileContent('');
          setDraftContent('');
          setDraftForPath(node.path, '');
          setLoadedFilePath(null);
          if (searchQuery.trim().length > 0) {
            setSearchQuery('');
          }
          if (isMobile) {
            setShowMobilePageContent(false);
          }
          if (root) {
            const ancestors = getAncestorPaths(node.path, root);
            const pathsToExpand = [...ancestors, node.path];
            if (pathsToExpand.length > 0) {
              expandPaths(root, pathsToExpand);
            }
            for (const path of pathsToExpand) {
              if (!loadedDirsRef.current.has(path)) {
                void loadDirectory(path);
              }
            }
          }
          return;
        }
        setFileContent('');
        setDraftContent('');
        setDraftForPath(node.path, '');
        setFileError(error instanceof Error ? error.message : 'Failed to read file');
      })
      .finally(() => {
        if (!isCurrentRequest()) {
          return;
        }
        setFileLoading(false);
      });
  }, [
    expandPaths,
    invalidateCachedPath,
    isMobile,
    loadDirectory,
    readFile,
    resolveCurrentModifiedTime,
    resolveNodeModifiedTime,
    root,
    runtime.isDesktop,
    searchQuery,
    setCachedFileEntry,
    setDraftForPath,
    setSelectedPath,
  ]);

  const ensurePathVisible = React.useCallback(async (targetPath: string, includeTarget: boolean) => {
    if (!root) {
      return;
    }

    const ancestors = getAncestorPaths(targetPath, root);
    const pathsToExpand = includeTarget ? [...ancestors, targetPath] : ancestors;

    if (pathsToExpand.length > 0) {
      expandPaths(root, pathsToExpand);
    }

    for (const path of pathsToExpand) {
      if (!loadedDirsRef.current.has(path)) {
        await loadDirectory(path);
      }
    }
  }, [expandPaths, loadDirectory, root]);

  const getNextOpenFile = React.useCallback((path: string, filesList: FileNode[]) => {
    const index = filesList.findIndex((file) => file.path === path);
    if (index === -1 || filesList.length <= 1) {
      return null;
    }
    return filesList[index + 1] ?? filesList[index - 1] ?? null;
  }, []);

  const handleSelectFile = React.useCallback(async (node: FileNode, skipBinaryCheck = false) => {
    if (skipDirtyOnceRef.current) {
      skipDirtyOnceRef.current = false;
    } else if (isDirty) {
      setConfirmDiscardOpen(true);
      pendingSelectFileRef.current = node;
      return;
    }

    const selectionToken = ++selectionValidationRef.current;

    // Check if this is a binary file that cannot be displayed
    // Skip check for images (they have a viewer) and SVGs (text-based)
    if (!skipBinaryCheck && node.type === 'file') {
      const fileInfo = getFileTypeInfo(node.path);
      const selectedIsImage = isImageFile(node.path);

      // Only warn for binary files that cannot be displayed
      // Images can be displayed, so don't warn about them
      if (fileInfo.isBinary && !fileInfo.canDisplay && !selectedIsImage) {
        const warning = getBinaryFileWarning(node.path);

        // Update selection state so the file shows as selected in the tree
        if (root) {
          setSelectedPath(root, node.path);
          addOpenPath(root, node.path);
          void ensurePathVisible(node.path, false);
        }

        // Clear file content since we're not loading it
        setFileError(null);
        setDesktopImageSrc('');
        setFileContent('');
        setDraftContent('');
        setDraftForPath(node.path, '');
        setContentDetectedBinaryPath(null);
        setLoadedFilePath(null);
        if (isMobile) {
          setShowMobilePageContent(true);
        }

        // Show warning dialog
        setBinaryWarningDialog({
          node,
          title: warning.title,
          message: warning.message,
        });
        return;
      }
    }

    if (root) {
      setSelectedPath(root, node.path);
      addOpenPath(root, node.path);
      void ensurePathVisible(node.path, false);
    }

    if (node.type === 'file') {
      const cachedEntry = getCachedFileEntry(node.path);
      if (cachedEntry) {
        const currentModifiedTime = await resolveCurrentModifiedTime(node);
        if (selectionToken !== selectionValidationRef.current) {
          return;
        }

        if (isCacheEntryFresh(cachedEntry, currentModifiedTime)) {
          applyCachedFileState(node.path, cachedEntry);
          return;
        }

        // If we can now resolve mtime for a cache entry that previously had none,
        // hydrate the cache baseline without prompting.
        if (typeof cachedEntry.sourceModifiedTime !== 'number' && typeof currentModifiedTime === 'number') {
          const hydratedEntry: FileContentCacheEntry = {
            ...cachedEntry,
            loadedAt: Date.now(),
            sourceModifiedTime: currentModifiedTime,
          };
          setCachedFileEntry(node.path, {
            content: hydratedEntry.content,
            type: hydratedEntry.type,
            sourceModifiedTime: hydratedEntry.sourceModifiedTime,
          });
          applyCachedFileState(node.path, hydratedEntry);
          return;
        }

        setExternalChangeDialog({
          node,
          cachedEntry,
          modifiedTime: currentModifiedTime,
        });
        return;
      }
    }

    if (selectionToken !== selectionValidationRef.current) {
      return;
    }

    setFileError(null);
    setDesktopImageSrc('');
    setFileContent('');
    setDraftContent('');
    setDraftForPath(node.path, '');
    setContentDetectedBinaryPath(null);
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(true);
    }
  }, [
    addOpenPath,
    applyCachedFileState,
    ensurePathVisible,
    getCachedFileEntry,
    isCacheEntryFresh,
    isDirty,
    isMobile,
    resolveCurrentModifiedTime,
    root,
    setCachedFileEntry,
    setDraftForPath,
    setExternalChangeDialog,
    setSelectedPath,
  ]);

  const keepLoadedVersion = React.useCallback(() => {
    if (!externalChangeDialog) {
      return;
    }

    const nextSourceModifiedTime = externalChangeDialog.modifiedTime;
    setCachedFileEntry(externalChangeDialog.node.path, {
      content: externalChangeDialog.cachedEntry.content,
      type: externalChangeDialog.cachedEntry.type,
      sourceModifiedTime: nextSourceModifiedTime,
    });

    applyCachedFileState(externalChangeDialog.node.path, {
      ...externalChangeDialog.cachedEntry,
      loadedAt: Date.now(),
      sourceModifiedTime: nextSourceModifiedTime,
    });

    setExternalChangeDialog(null);
  }, [applyCachedFileState, externalChangeDialog, setCachedFileEntry]);

  const reloadFromDiskAfterExternalChange = React.useCallback(() => {
    if (!externalChangeDialog) {
      return;
    }

    const nextNode = externalChangeDialog.node;
    setExternalChangeDialog(null);
    invalidateCachedPath(nextNode.path);
    setLoadedFilePath(null);
    void loadSelectedFile(nextNode);
  }, [externalChangeDialog, invalidateCachedPath, loadSelectedFile]);

  React.useEffect(() => {
    if (!selectedFile?.path) {
      return;
    }

    void ensurePathVisible(selectedFile.path, false);
  }, [ensurePathVisible, selectedFile?.path]);

  React.useEffect(() => {
    if (!selectedFile) {
      return;
    }

    if (externalChangeDialog?.node.path === selectedFile.path) {
      return;
    }

    if (loadedFilePath === selectedFile.path) {
      return;
    }

    // Selection changes are guarded; this effect is also what restores persisted tabs on mount.
    void loadSelectedFile(selectedFile);
  }, [externalChangeDialog?.node.path, loadSelectedFile, loadedFilePath, selectedFile]);

  const discardAndContinue = React.useCallback(() => {
    const nextFile = pendingSelectFileRef.current;
    const nextTab = pendingTabRef.current;
    const closePath = pendingClosePathRef.current;

    pendingSelectFileRef.current = null;
    pendingTabRef.current = null;
    pendingClosePathRef.current = null;

    // Allow one guarded navigation (tab/file) without re-opening dialog.
    skipDirtyOnceRef.current = true;

    setConfirmDiscardOpen(false);

    // Discard draft by reverting back to last loaded content
    setDraftContent(displayedContent);
    if (selectedFile?.path) {
      setDraftForPath(selectedFile.path, displayedContent);
    }

    if (closePath) {
      if (root) {
        removeOpenPath(root, closePath);
      }
      if (selectedFile?.path === closePath) {
        if (nextFile) {
          void handleSelectFile(nextFile);
        } else {
          if (root) {
            setSelectedPath(root, null);
          }
          setFileContent('');
          setFileError(null);
          setDesktopImageSrc('');
          setLoadedFilePath(null);
          if (isMobile) {
            setShowMobilePageContent(false);
          }
        }
      }
      return;
    }

    if (nextFile) {
      void handleSelectFile(nextFile);
      return;
    }

    if (nextTab) {
      setMainTabGuard(null);
      useUIStore.getState().setActiveMainTab(nextTab);
    }
  }, [displayedContent, handleSelectFile, isMobile, removeOpenPath, root, selectedFile?.path, setDraftForPath, setMainTabGuard, setSelectedPath]);

  const saveAndContinue = React.useCallback(async () => {
    const nextFile = pendingSelectFileRef.current;
    const nextTab = pendingTabRef.current;
    const closePath = pendingClosePathRef.current;

    pendingSelectFileRef.current = null;
    pendingTabRef.current = null;
    pendingClosePathRef.current = null;

    // We'll proceed after saving; suppress guard reopening.
    skipDirtyOnceRef.current = true;

    setConfirmDiscardOpen(false);

    await saveDraft();

    if (closePath) {
      if (root) {
        removeOpenPath(root, closePath);
      }
      if (selectedFile?.path === closePath) {
        if (nextFile) {
          await handleSelectFile(nextFile);
        } else {
          if (root) {
            setSelectedPath(root, null);
          }
          setFileContent('');
          setFileError(null);
          setDesktopImageSrc('');
          setLoadedFilePath(null);
          if (isMobile) {
            setShowMobilePageContent(false);
          }
        }
      }
      return;
    }

    if (nextFile) {
      await handleSelectFile(nextFile);
      return;
    }

    if (nextTab) {
      setMainTabGuard(null);
      useUIStore.getState().setActiveMainTab(nextTab);
    }
  }, [handleSelectFile, isMobile, removeOpenPath, root, saveDraft, selectedFile?.path, setMainTabGuard, setSelectedPath]);

  const handleCloseFile = React.useCallback((path: string) => {
    const isActive = selectedFile?.path === path;
    const nextFile = getNextOpenFile(path, openFiles);

    if (isActive && isDirty) {
      setConfirmDiscardOpen(true);
      pendingSelectFileRef.current = nextFile;
      pendingClosePathRef.current = path;
      return;
    }

    if (root) {
      removeOpenPath(root, path);
    }

    if (!isActive) {
      return;
    }

    if (nextFile) {
      void handleSelectFile(nextFile);
      return;
    }

    if (root) {
      setSelectedPath(root, null);
    }
    setFileContent('');
    setFileError(null);
    setDesktopImageSrc('');
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(false);
    }
  }, [getNextOpenFile, handleSelectFile, isDirty, isMobile, openFiles, removeOpenPath, root, selectedFile?.path, setSelectedPath]);

  const getFileStatus = React.useCallback((path: string): FileStatus | null => {
    // Check open status
    if (openPaths.includes(path)) return 'open';
    
    // Check git status
    if (gitStatus?.files) {
      const relative = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
      const file = gitStatus.files.find(f => f.path === relative);
      if (file) {
        if (file.index === 'A' || file.working_dir === '?') return 'git-added';
        if (file.index === 'D') return 'git-deleted';
        if (file.index === 'M' || file.working_dir === 'M') return 'git-modified';
      }
    }
    return null;
  }, [openPaths, gitStatus, root]);

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

  const toggleDirectory = React.useCallback(async (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    if (!root) return;

    toggleExpandedPath(root, normalized);

    if (!loadedDirsRef.current.has(normalized)) {
      await loadDirectory(normalized);
    }
  }, [loadDirectory, root, toggleExpandedPath]);

  // Helper to construct proper file:// URLs for native drag-out
  const pathToFileUrl = React.useCallback((filePath: string): string => {
    // Normalize path separators to forward slashes
    let normalized = filePath.replace(/\\/g, '/');

    // For Windows paths, ensure drive letter format is correct
    // Convert C: to /C: for proper file URL format
    if (/^[A-Za-z]:/.test(normalized)) {
      normalized = '/' + normalized;
    }

    // Ensure path starts with /
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }

    // URI-encode the path components while preserving slashes
    const encoded = normalized
      .split('/')
      .map(segment => encodeURIComponent(segment))
      .join('/');

    // Construct file:// URL with three slashes (file:// + /)
    return `file://${encoded}`;
  }, []);

  // Drag-out download handler: allows dragging files to desktop/file manager
  const handleFileDragStart = React.useCallback((node: FileNode, event: React.DragEvent) => {
    if (node.type === 'directory') {
      event.preventDefault();
      return;
    }

    const fileName = node.name;
    const mimeType = isImageFile(node.path) ? getImageMimeType(node.path) : 'application/octet-stream';

    // Set drag effect
    event.dataTransfer.effectAllowed = 'copy';

    // Create a custom drag image
    const dragImage = document.createElement('div');
    dragImage.textContent = fileName;
    dragImage.style.cssText = 'position: absolute; left: -9999px; padding: 8px 12px; background: var(--background); border: 1px solid var(--border); border-radius: 6px; font-size: 13px; color: var(--foreground); white-space: nowrap;';
    document.body.appendChild(dragImage);
    event.dataTransfer.setDragImage(dragImage, 0, 0);
    setTimeout(() => document.body.removeChild(dragImage), 0);

    // Set text fallback with file path
    event.dataTransfer.setData('text/plain', node.path);

    // For desktop platform, use file:// URL for native drag
    if (runtime.isDesktop) {
      const fileUrl = pathToFileUrl(node.path);
      event.dataTransfer.setData('text/uri-list', fileUrl);
      // Set DownloadURL format for cross-platform compatibility
      // Format: mime:filename:url
      event.dataTransfer.setData('DownloadURL', `${mimeType}:${fileName}:${fileUrl}`);
    } else {
      // Web platform: create download URL using the API endpoint
      const downloadUrl = `/api/fs/raw?path=${encodeURIComponent(node.path)}`;
      const absoluteUrl = `${window.location.origin}${downloadUrl}`;
      event.dataTransfer.setData('text/uri-list', absoluteUrl);
      event.dataTransfer.setData('DownloadURL', `${mimeType}:${fileName}:${absoluteUrl}`);
    }
  }, [pathToFileUrl, runtime.isDesktop]);

  // Download button handler (selected file)
  const handleDownloadFile = React.useCallback(() => {
    if (!selectedFile) {
      return;
    }
    triggerFileDownload(selectedFile.path, selectedFile.name);
  }, [selectedFile]);

  // Context menu handler (any file)
  const handleContextMenuDownloadFile = React.useCallback((node: FileNode) => {
    if (node.type !== 'file') {
      return;
    }
    triggerFileDownload(node.path, node.name);
  }, []);

  // Drag-and-drop upload helpers
  const hasDraggedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): boolean => {
    if (!dataTransfer) return false;
    // Check for actual files
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;
    if (dataTransfer.types) {
      const types = Array.from(dataTransfer.types);
      // 'Files' type indicates actual files from the OS
      if (types.includes('Files')) return true;
    }
    return false;
  }, []);

  const collectDroppedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): File[] => {
    if (!dataTransfer) return [];
    const directFiles = Array.from(dataTransfer.files || []);
    if (directFiles.length > 0) {
      return directFiles;
    }
    const fromItems = Array.from(dataTransfer.items || [])
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    return fromItems;
  }, []);

  const uploadFile = React.useCallback(async (file: File, targetDir: string): Promise<boolean> => {
    if (!files.writeFile) {
      toast.error('File upload not supported');
      return false;
    }

    const filePath = normalizePath(`${targetDir}/${file.name}`);

    try {
      // Use getFileCategory for more robust file type detection
      const category = getFileCategory(file.name);
      const isTextFile = category === 'text';

      // Read file content
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);

        if (isTextFile) {
          reader.onload = () => resolve(reader.result as string);
          reader.readAsText(file);
        } else {
          // For binary files, read as data URL and extract base64 content
          // This is more robust and performant than manual ArrayBuffer to base64 conversion
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const content = dataUrl.substring(dataUrl.indexOf(',') + 1);
            resolve(content);
          };
          reader.readAsDataURL(file);
        }
      });

      const result = await files.writeFile(filePath, content);
      return result.success;
    } catch (error) {
      console.error('Failed to upload file:', error);
      return false;
    }
  }, [files]);

  const handleFileDrop = React.useCallback(async (droppedFiles: File[], targetDir: string) => {
    if (droppedFiles.length === 0 || !files.writeFile) return;

    setIsUploading(true);
    let successCount = 0;
    let failCount = 0;

    for (const file of droppedFiles) {
      const success = await uploadFile(file, targetDir);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }
    }

    setIsUploading(false);

    if (successCount > 0) {
      for (const uploadedFile of droppedFiles) {
        invalidateCachedPath(normalizePath(`${targetDir}/${uploadedFile.name}`));
      }
      await refreshRoot();
      if (successCount === 1 && failCount === 0) {
        toast.success('File uploaded successfully');
      } else if (failCount === 0) {
        toast.success(`${successCount} files uploaded successfully`);
      } else {
        toast.warning(`${successCount} uploaded, ${failCount} failed`);
      }
    } else if (failCount > 0) {
      toast.error(`Failed to upload ${failCount} file${failCount > 1 ? 's' : ''}`);
    }
  }, [files.writeFile, invalidateCachedPath, refreshRoot, uploadFile]);

  const handleFileUploadFromDialog = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0 || !dialogData) return;

    const targetDir = dialogData.path;
    const fileArray = Array.from(selectedFiles);

    // Close the dialog first
    setActiveDialog(null);

    // Upload the files
    await handleFileDrop(fileArray, targetDir);

    // Reset the input
    if (fileUploadInputRef.current) {
      fileUploadInputRef.current.value = '';
    }
  }, [dialogData, handleFileDrop]);

  const handleUploadToFolder = React.useCallback((targetPath: string) => {
    if (!files.writeFile) {
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
  }, [files.writeFile]);

  const handleContextUploadInputChange = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = event.target.files;
    const targetPath = contextUploadTargetPath;

    if (!selectedFiles || selectedFiles.length === 0 || !targetPath) {
      event.target.value = '';
      setContextUploadTargetPath(null);
      return;
    }

    await handleFileDrop(Array.from(selectedFiles), targetPath);
    event.target.value = '';
    setContextUploadTargetPath(null);
  }, [contextUploadTargetPath, handleFileDrop]);

  const handleTreeDragEnter = React.useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer) || !files.writeFile) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current++;
    if (!isDraggingFiles) {
      setIsDraggingFiles(true);
      setDropTargetPath(currentDirectory);
    }
  }, [hasDraggedFiles, files.writeFile, isDraggingFiles, currentDirectory]);

  const handleTreeDragOver = React.useCallback((e: React.DragEvent) => {
    if (!hasDraggedFiles(e.dataTransfer) || !files.writeFile) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  }, [hasDraggedFiles, files.writeFile]);

  const handleTreeDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) {
      setIsDraggingFiles(false);
      setDropTargetPath(null);
    }
  }, []);

  const handleTreeDrop = React.useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = 0;
    setIsDraggingFiles(false);

    const targetDir = dropTargetPath || currentDirectory;
    setDropTargetPath(null);

    if (!hasDraggedFiles(e.dataTransfer) || !files.writeFile || !targetDir) return;

    const droppedFiles = collectDroppedFiles(e.dataTransfer);
    await handleFileDrop(droppedFiles, targetDir);
  }, [hasDraggedFiles, files.writeFile, collectDroppedFiles, handleFileDrop, dropTargetPath, currentDirectory]);

  const handleDirectoryDragEnter = React.useCallback((e: React.DragEvent, dirPath: string) => {
    if (!hasDraggedFiles(e.dataTransfer) || !files.writeFile) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTargetPath(dirPath);
  }, [hasDraggedFiles, files.writeFile]);

  const handleDirectoryDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Reset to current directory when leaving a specific folder
    if (isDraggingFiles) {
      setDropTargetPath(currentDirectory);
    }
  }, [isDraggingFiles, currentDirectory]);

  // Internal DnD handlers (for moving files/folders within the tree)
  const handleDndDragStart = React.useCallback((event: DragStartEvent) => {
    const data = event.active.data.current as { type?: string; node?: FileNode } | undefined;
    if (data?.type === 'file-move' && data.node) {
      setActiveDndNode(data.node);
      // Haptic feedback on mobile
      if (isMobile && typeof navigator !== 'undefined' && navigator.vibrate) {
        try {
          navigator.vibrate(15);
        } catch {
          // Ignore vibration errors
        }
      }
    }
  }, [isMobile]);

  const handleDndDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    setActiveDndNode(null);
    setDndDropTargetPath(null);

    if (!over) return;

    const activeData = active.data.current as { type?: string; node?: FileNode } | undefined;
    const overData = over.data.current as { type?: string; path?: string } | undefined;

    if (activeData?.type !== 'file-move' || !activeData.node) return;
    if (overData?.type !== 'directory' || !overData.path) return;

    const sourceNode = activeData.node;
    const targetDir = overData.path;

    // Prevent dropping a folder into itself or its descendants
    if (sourceNode.type === 'directory' && isDescendantPath(sourceNode.path, targetDir)) {
      toast.error('Cannot move a folder into itself');
      return;
    }

    // Prevent moving to the same directory
    const sourceParent = sourceNode.path.split('/').slice(0, -1).join('/');
    if (normalizePath(sourceParent) === normalizePath(targetDir)) {
      return; // No-op, same directory
    }

    // Show confirmation dialog
    setMoveConfirmDialog({ source: sourceNode, targetDir });
  }, []);

  const handleDndDragOver = React.useCallback((event: DragOverEvent) => {
    const overData = event.over?.data?.current as { type?: string; path?: string } | undefined;
    if (overData?.type === 'directory' && overData.path) {
      setDndDropTargetPath(overData.path);
    } else {
      setDndDropTargetPath(null);
    }
  }, []);

  // Perform the actual move operation
  const performMove = React.useCallback(async (source: FileNode, targetDir: string) => {
    if (!files.rename) {
      toast.error('Move operation not supported');
      return;
    }

    setIsMoving(true);
    const newPath = normalizePath(`${targetDir}/${source.name}`);

    try {
      const result = await files.rename(source.path, newPath);
      if (result.success) {
        invalidateCachedPathPrefix(source.path);
        invalidateCachedPathPrefix(newPath);
        toast.success(`Moved ${source.name} to ${targetDir.split('/').pop() || 'target folder'}`);
        await refreshRoot();

        // Update open paths if the moved item was open
        if (root) {
          removeOpenPathsByPrefix(root, source.path);
        }

        // Clear selection if the selected file was moved
        if (selectedFile?.path === source.path || selectedFile?.path.startsWith(`${source.path}/`)) {
          if (root) {
            setSelectedPath(root, null);
          }
          setFileContent('');
          setFileError(null);
          setDesktopImageSrc('');
          setLoadedFilePath(null);
          if (isMobile) {
            setShowMobilePageContent(false);
          }
        }
      } else {
        toast.error('Move failed');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Move failed');
    } finally {
      setIsMoving(false);
      setMoveConfirmDialog(null);
    }
  }, [files, invalidateCachedPathPrefix, refreshRoot, removeOpenPathsByPrefix, root, selectedFile?.path, setSelectedPath, isMobile]);

  const handleConfirmMove = React.useCallback(() => {
    if (moveConfirmDialog) {
      void performMove(moveConfirmDialog.source, moveConfirmDialog.targetDir);
    }
  }, [moveConfirmDialog, performMove]);

  const handleCancelMove = React.useCallback(() => {
    setMoveConfirmDialog(null);
  }, []);

  function renderTree(dirPath: string, depth: number): React.ReactNode {
    const nodes = childrenByDir[dirPath] ?? [];

    return nodes.map((node, index) => {
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expandedPaths.includes(node.path);
      const isActive = selectedFile?.path === node.path;
      const isLast = index === nodes.length - 1;
      const nodeIsUploadDropTarget = isDir && isDraggingFiles && dropTargetPath === node.path;
      const nodeIsDndDropTarget = isDir && dndDropTargetPath === node.path;
      const nodeIsDndDragging = activeDndNode?.path === node.path;

      // Check if this directory is a valid drop target (not the source or its descendant)
      const isValidDropTarget = isDir && (!activeDndNode || (
        activeDndNode.path !== node.path &&
        !isDescendantPath(activeDndNode.path, node.path)
      ));

      // Shared props for FileRow - only isDndDropTarget varies based on context
      const fileRowProps = {
        node,
        isExpanded,
        isActive,
        isMobile,
        status: !isDir ? getFileStatus(node.path) : undefined,
        badge: isDir ? getFolderBadge(node.path) : undefined,
        permissions: {
          canRename,
          canCreateFile,
          canCreateFolder,
          canDelete,
          canReveal,
          canUpload: Boolean(files.writeFile),
          canDownload: true,
        },
        contextMenuPath,
        setContextMenuPath,
        onSelect: handleSelectFile,
        onToggle: toggleDirectory,
        onRevealPath: handleRevealPath,
        onDownloadFile: handleContextMenuDownloadFile,
        onUploadToFolder: handleUploadToFolder,
        onOpenDialog: handleOpenDialog,
        onDragStart: handleFileDragStart,
        isUploadDropTarget: nodeIsUploadDropTarget,
        onUploadDropTargetEnter: handleDirectoryDragEnter,
        onUploadDropTargetLeave: handleDirectoryDragLeave,
        isDndDragging: nodeIsDndDragging,
      };

      // Helper to render FileRow with the appropriate isDndDropTarget value
      const renderFileRow = (isDndDropTarget: boolean) => (
        <FileRow {...fileRowProps} isDndDropTarget={isDndDropTarget} />
      );

      const fileRowElement = renderFileRow(nodeIsDndDropTarget && isValidDropTarget);

      // Wrap all items in DraggableFileRow for internal DnD (if rename permission exists)
      // Directories also wrap in DroppableDirectoryRow to receive drops
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
                <span className="absolute top-3.5 bottom-0 left-[-13px] w-[2px] bg-background" />
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

  const isSelectedImage = Boolean(selectedFile?.path && isImageFile(selectedFile.path));
  const isSelectedSvg = Boolean(selectedFile?.path && selectedFile.path.toLowerCase().endsWith('.svg'));
  const selectedFileCategory = selectedFile?.path ? getFileCategory(selectedFile.path) : null;
  const isSelectedPdf = selectedFileCategory === 'pdf';
  const isSelectedAudio = selectedFileCategory === 'audio';
  const isSelectedVideo = selectedFileCategory === 'video';
  const isSelectedMedia = isSelectedPdf || isSelectedAudio || isSelectedVideo;
  const selectedFilePath = selectedFile?.path ?? '';
  const pendingNavigationTargetPath = React.useMemo(
    () => normalizePath(pendingFileNavigation?.path ?? ''),
    [pendingFileNavigation?.path],
  );
  const shouldMaskEditorForPendingNavigation = Boolean(
    pendingFileNavigation
      && pendingNavigationTargetPath
      && selectedFilePath
      && selectedFilePath === pendingNavigationTargetPath
      && !fileLoading
      && !fileError
      && !isSelectedImage,
  );

  const displaySelectedPath = React.useMemo(() => {
    return getDisplayPath(root, selectedFilePath);
  }, [selectedFilePath, root]);

  const selectedFileTypeInfo = React.useMemo(
    () => (selectedFile?.path ? getFileTypeInfo(selectedFile.path) : null),
    [selectedFile?.path],
  );
  const isBinaryDetectedFromContent = Boolean(selectedFile?.path && contentDetectedBinaryPath === selectedFile.path);
  const isBinaryNonDisplayable = Boolean(
    (selectedFileTypeInfo?.isBinary && !selectedFileTypeInfo?.canDisplay)
    || isBinaryDetectedFromContent,
  );
  const nonDisplayableBinaryDescription = isBinaryDetectedFromContent
    ? 'Binary file'
    : (selectedFileTypeInfo?.description ?? 'Binary file');

  const canCopy = Boolean(selectedFile && (!isSelectedImage || isSelectedSvg) && !isSelectedMedia && !isBinaryNonDisplayable && fileContent.length > 0);
  const canCopyPath = Boolean(selectedFile && displaySelectedPath.length > 0);
  const canEdit = Boolean(selectedFile && !isSelectedImage && !isSelectedMedia && !isBinaryNonDisplayable && files.writeFile && fileContent.length <= MAX_VIEW_CHARS);
  const isMarkdown = Boolean(selectedFile?.path && isMarkdownFile(selectedFile.path));
  const isTextFile = Boolean(selectedFile && !isSelectedImage && !isSelectedMedia && !isBinaryNonDisplayable);
  const canUseShikiFileView = isTextFile && !isMarkdown;
  const isSelectedMarkdownPreview = isMarkdown && mdViewMode === 'preview';
  const isSelectedShikiView = canUseShikiFileView && textViewMode === 'view';
  const isSelectedTextEditor = Boolean(
    selectedFile
    && !isSelectedImage
    && !isSelectedMedia
    && !isBinaryNonDisplayable
    && !isSelectedMarkdownPreview
    && !isSelectedShikiView,
  );
  const shouldShowTextEditorOverlay = Boolean(isSelectedTextEditor && !fileLoading && !fileError && !isFullscreen);
  const openTextEditorFiles = React.useMemo(
    () => openFiles.filter((file) => {
      const category = getFileCategory(file.path);
      if (category === 'image' || category === 'pdf' || category === 'audio' || category === 'video') {
        return false;
      }

      const info = getFileTypeInfo(file.path);
      return !(info.isBinary && !info.canDisplay);
    }),
    [openFiles],
  );
  const getEditorDraftForPath = React.useCallback((path: string): string => {
    if (selectedFile?.path === path) {
      return draftContent;
    }

    const existingDraft = draftContentByPath[path];
    if (typeof existingDraft === 'string') {
      return existingDraft;
    }

    const cached = fileContentCacheRef.current.get(path);
    if (cached?.type === 'text') {
      return cached.content.length > MAX_VIEW_CHARS
        ? `${cached.content.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`
        : cached.content;
    }

    return '';
  }, [draftContent, draftContentByPath, selectedFile?.path]);
  const handleEditorDraftChange = React.useCallback((path: string, nextValue: string) => {
    setDraftForPath(path, nextValue);
    if (selectedFile?.path === path) {
      setDraftContent(nextValue);
    }
  }, [selectedFile?.path, setDraftForPath]);
  const staticLanguageExtension = React.useMemo(
    () => (selectedFilePath ? languageByExtension(selectedFilePath) : null),
    [selectedFilePath],
  );
  const [dynamicLanguageExtension, setDynamicLanguageExtension] = React.useState<Extension | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const selectedPath = selectedFile?.path;

    if (!selectedPath || staticLanguageExtension) {
      setDynamicLanguageExtension(null);
      return;
    }

    setDynamicLanguageExtension(null);
    void loadLanguageByExtension(selectedPath).then((extension) => {
      if (!cancelled) {
        setDynamicLanguageExtension(extension);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [selectedFile?.path, staticLanguageExtension]);

  React.useEffect(() => {
    if (!canEdit && textViewMode === 'edit') {
      setTextViewMode('view');
    }
  }, [canEdit, textViewMode]);

  React.useEffect(() => {
    setTextViewMode('edit');
  }, [selectedFile?.path]);

  const MD_VIEWER_MODE_KEY = 'openchamber:files:md-viewer-mode';

  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(MD_VIEWER_MODE_KEY);
      if (stored === 'preview') {
        setMdViewMode('preview');
      } else if (stored === 'edit') {
        setMdViewMode('edit');
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const saveMdViewMode = React.useCallback((mode: 'preview' | 'edit') => {
    setMdViewMode(mode);
    try {
      localStorage.setItem(MD_VIEWER_MODE_KEY, mode);
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  const getMdViewMode = React.useCallback((): 'preview' | 'edit' => {
    return mdViewMode;
  }, [mdViewMode]);

  React.useEffect(() => {
    if (!pendingFileNavigation || !root) {
      return;
    }

    const scheduleNavigationRetry = () => {
      if (typeof window === 'undefined') {
        return;
      }
      if (pendingNavigationRafRef.current !== null) {
        return;
      }

      pendingNavigationRafRef.current = window.requestAnimationFrame(() => {
        pendingNavigationRafRef.current = null;
        setEditorViewReadyNonce((value) => value + 1);
      });
    };

    const isEditorSyncedWithDraft = (view: EditorView, expectedContent: string): boolean => {
      if (view.state.doc.length !== expectedContent.length) {
        return false;
      }

      if (expectedContent.length === 0) {
        return true;
      }

      const sampleSize = Math.min(128, expectedContent.length);
      const startSample = view.state.sliceDoc(0, sampleSize);
      if (startSample !== expectedContent.slice(0, sampleSize)) {
        return false;
      }

      const endFrom = Math.max(0, expectedContent.length - sampleSize);
      const endSample = view.state.sliceDoc(endFrom, expectedContent.length);
      return endSample === expectedContent.slice(endFrom);
    };

    const targetPath = normalizePath(pendingFileNavigation.path);
    if (!targetPath) {
      setPendingFileNavigation(null);
      pendingNavigationCycleRef.current = { key: '', attempts: 0 };
      return;
    }

    const navigationKey = `${targetPath}:${pendingFileNavigation.line}:${pendingFileNavigation.column ?? 1}`;
    if (pendingNavigationCycleRef.current.key !== navigationKey) {
      pendingNavigationCycleRef.current = { key: navigationKey, attempts: 0 };
    }

    if (selectedFile?.path !== targetPath) {
      if (selectedPath !== targetPath) {
        setSelectedPath(root, targetPath);
      }
      return;
    }

    if (fileLoading || loadedFilePath !== targetPath) {
      return;
    }

    if (fileError || isSelectedImage) {
      setPendingFileNavigation(null);
      pendingNavigationCycleRef.current = { key: '', attempts: 0 };
      return;
    }

    if (!canEdit) {
      return;
    }

    if (textViewMode !== 'edit') {
      setTextViewMode('edit');
      return;
    }

    const view = editorViewRef.current;
    if (!view) {
      scheduleNavigationRetry();
      return;
    }

    if (!isEditorSyncedWithDraft(view, draftContent)) {
      scheduleNavigationRetry();
      return;
    }

    const targetLineNumber = Math.max(1, Math.min(pendingFileNavigation.line, view.state.doc.lines));
    const targetLine = view.state.doc.line(targetLineNumber);
    const targetColumn = Math.max(1, pendingFileNavigation.column || 1);
    const lineLength = Math.max(0, targetLine.to - targetLine.from);
    const clampedColumnOffset = Math.min(lineLength, targetColumn - 1);
    const targetPosition = targetLine.from + clampedColumnOffset;
    const isAtTarget = view.state.selection.main.head === targetPosition;
    const shouldDispatch = !isAtTarget || pendingNavigationCycleRef.current.attempts === 0;

    if (shouldDispatch) {
      pendingNavigationCycleRef.current.attempts += 1;
      view.dispatch({
        selection: { anchor: targetPosition },
        effects: EditorView.scrollIntoView(targetPosition, { y: 'center' }),
      });
      view.focus();
      scheduleNavigationRetry();
      return;
    }

    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        const syncedView = editorViewRef.current;
        if (!syncedView) {
          return;
        }

        syncedView.dispatch({
          selection: { anchor: targetPosition },
          effects: EditorView.scrollIntoView(targetPosition, { y: 'center' }),
        });
        syncedView.focus();
      });
    }

    setPendingFileNavigation(null);
    pendingNavigationCycleRef.current = { key: '', attempts: 0 };
  }, [
    canEdit,
    draftContent,
    editorViewReadyNonce,
    fileError,
    fileLoading,
    isSelectedImage,
    loadedFilePath,
    pendingFileNavigation,
    root,
    selectedFile?.path,
    selectedPath,
    setPendingFileNavigation,
    setSelectedPath,
    textViewMode,
  ]);

  React.useEffect(() => {
    if (!pendingFileFocusPath || !root) {
      return;
    }

    const targetPath = normalizePath(pendingFileFocusPath);
    if (!targetPath) {
      setPendingFileFocusPath(null);
      return;
    }

    if (selectedFile?.path !== targetPath) {
      if (selectedPath !== targetPath) {
        setSelectedPath(root, targetPath);
      }
      return;
    }

    if (fileLoading || loadedFilePath !== targetPath || fileError || isSelectedImage) {
      return;
    }

    if (canEdit && textViewMode !== 'edit') {
      setTextViewMode('edit');
      return;
    }

    if (canEdit) {
      const view = editorViewRef.current;
      if (!view) {
        return;
      }
      view.focus();
    }

    setPendingFileFocusPath(null);
  }, [
    canEdit,
    fileError,
    fileLoading,
    isSelectedImage,
    loadedFilePath,
    pendingFileFocusPath,
    root,
    selectedFile?.path,
    selectedPath,
    setPendingFileFocusPath,
    setSelectedPath,
    textViewMode,
  ]);
  const nudgeEditorSelectionAboveKeyboard = React.useCallback((view: EditorView | null) => {
    if (!isMobile || !view || !view.hasFocus || typeof window === 'undefined') {
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      return;
    }

    const rootStyles = getComputedStyle(document.documentElement);
    const keyboardInset = Number.parseFloat(rootStyles.getPropertyValue('--oc-keyboard-inset')) || 0;
    const keyboardHomeIndicator = Number.parseFloat(rootStyles.getPropertyValue('--oc-keyboard-home-indicator')) || 0;
    const occludedBottom = keyboardInset + keyboardHomeIndicator;
    if (occludedBottom <= 0) {
      return;
    }

    const head = view.state.selection.main.head;
    const cursorRect = view.coordsAtPos(head);
    if (!cursorRect) {
      return;
    }

    const visibleBottom = Math.round(viewport.offsetTop + viewport.height);
    const clearance = 20;
    const overlap = cursorRect.bottom + clearance - visibleBottom;
    if (overlap <= 0) {
      return;
    }

    view.scrollDOM.scrollTop += overlap;
  }, [isMobile]);

  const handleCodeMirrorViewReady = React.useCallback((path: string, view: EditorView) => {
    editorViewsByPathRef.current.set(path, view);

    if (selectedFile?.path !== path) {
      return;
    }

    editorViewRef.current = view;
    setEditorViewReadyNonce((value) => value + 1);
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        nudgeEditorSelectionAboveKeyboard(view);
      });
    }
  }, [nudgeEditorSelectionAboveKeyboard, selectedFile?.path]);

  const handleCodeMirrorViewDestroy = React.useCallback((path: string) => {
    editorViewsByPathRef.current.delete(path);

    if (selectedFile?.path !== path) {
      return;
    }

    if (editorViewRef.current) {
      editorViewRef.current = null;
    }
    setEditorViewReadyNonce((value) => value + 1);
  }, [selectedFile?.path]);

  React.useEffect(() => {
    if (!selectedFile?.path) {
      if (editorViewRef.current) {
        editorViewRef.current = null;
      }
      setEditorViewReadyNonce((value) => value + 1);
      return;
    }

    const nextView = editorViewsByPathRef.current.get(selectedFile.path) ?? null;
    if (editorViewRef.current !== nextView) {
      editorViewRef.current = nextView;
      setEditorViewReadyNonce((value) => value + 1);
    }

    if (nextView && typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        nudgeEditorSelectionAboveKeyboard(nextView);
      });
    }
  }, [nudgeEditorSelectionAboveKeyboard, selectedFile?.path]);

  React.useEffect(() => {
    if (!isMobile || typeof window === 'undefined') {
      return;
    }

    const runNudge = () => {
      window.requestAnimationFrame(() => {
        nudgeEditorSelectionAboveKeyboard(editorViewRef.current);
      });
    };

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', runNudge);
    viewport?.addEventListener('scroll', runNudge);
    document.addEventListener('selectionchange', runNudge);

    return () => {
      viewport?.removeEventListener('resize', runNudge);
      viewport?.removeEventListener('scroll', runNudge);
      document.removeEventListener('selectionchange', runNudge);
    };
  }, [isMobile, nudgeEditorSelectionAboveKeyboard]);

  const editorExtensions = React.useMemo(() => {
    if (!selectedFile?.path) {
      return [createFlexokiCodeMirrorTheme(currentTheme)];
    }

    const extensions = [createFlexokiCodeMirrorTheme(currentTheme)];
    const language = staticLanguageExtension ?? dynamicLanguageExtension;
    if (language) {
      extensions.push(language);
    }
    if (wrapLines) {
      extensions.push(EditorView.lineWrapping);
    }
    if (isMobile) {
      extensions.push(EditorView.updateListener.of((update) => {
        if (!update.view.hasFocus) {
          return;
        }
        if (!(update.selectionSet || update.focusChanged || update.viewportChanged || update.geometryChanged)) {
          return;
        }

        window.requestAnimationFrame(() => {
          nudgeEditorSelectionAboveKeyboard(update.view);
        });
      }));
    }
    return extensions;
  }, [currentTheme, selectedFile?.path, staticLanguageExtension, dynamicLanguageExtension, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard]);

  const inactiveEditorExtensions = React.useMemo(
    () => [createFlexokiCodeMirrorTheme(currentTheme)],
    [currentTheme],
  );

  const pierreTheme = React.useMemo(
    () => ({ light: lightTheme.metadata.id, dark: darkTheme.metadata.id }),
    [lightTheme.metadata.id, darkTheme.metadata.id],
  );

  const imageSrc = selectedFile?.path && isSelectedImage
    ? (runtime.isDesktop
      ? (isSelectedSvg
        ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
        : desktopImageSrc)
      : (isSelectedSvg
        ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
        : `/api/fs/raw?path=${encodeURIComponent(selectedFile.path)}`))
    : '';

  const rawFileSrcForPath = React.useCallback(
    (filePath: string) => `/api/fs/raw?path=${encodeURIComponent(filePath)}`,
    [],
  );

  const mediaSourceForPath = React.useCallback((filePath: string) => {
    if (!runtime.isDesktop) {
      return rawFileSrcForPath(filePath);
    }

    try {
      return convertFileSrc(filePath, 'asset');
    } catch {
      return rawFileSrcForPath(filePath);
    }
  }, [rawFileSrcForPath, runtime.isDesktop]);

  const openMediaFiles = React.useMemo(
    () => openFiles.filter((file) => {
      const category = getFileCategory(file.path);
      return category === 'pdf' || category === 'audio' || category === 'video';
    }),
    [openFiles],
  );

  const mediaSrcByPath = React.useMemo(() => {
    const entries = new Map<string, string>();
    for (const file of openMediaFiles) {
      entries.set(file.path, mediaSourceForPath(file.path));
    }
    return entries;
  }, [mediaSourceForPath, openMediaFiles]);

  React.useEffect(() => {
    let cancelled = false;

    const resolveDesktopImage = async () => {
      if (!runtime.isDesktop || !selectedFile?.path || !isSelectedImage || isSelectedSvg) {
        setDesktopImageSrc('');
        return;
      }

      setFileError(null);

      const srcPromise = files.readFileBinary
        ? files.readFileBinary(selectedFile.path).then((result) => result.dataUrl)
        : Promise.resolve(convertFileSrc(selectedFile.path, 'asset'));

      await srcPromise
        .then((src) => {
          if (!cancelled) {
            setDesktopImageSrc(src);
            setLoadedFilePath(selectedFile.path);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setDesktopImageSrc('');
            setFileError(error instanceof Error ? error.message : 'Failed to read file');
            setLoadedFilePath(null);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setFileLoading(false);
          }
        });
    };

    void resolveDesktopImage();

    return () => {
      cancelled = true;
    };
  }, [files, isSelectedImage, isSelectedSvg, runtime.isDesktop, selectedFile?.path]);

  const renderDialogs = () => (
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
                  id="dialog-file-upload"
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
    );

  const blockWidgets = React.useMemo(() => {
    return buildCodeMirrorCommentWidgets({
      drafts: filesFileDrafts,
      editingDraftId,
      commentText,
      selection: lineSelection,
      isDragging,
      fileLabel: selectedFile?.path ?? '',
      newWidgetId: 'files-new-comment-input',
      mapDraftToRange: (draft) => ({ start: draft.startLine, end: draft.endLine }),
      onSave: handleSaveComment,
      onCancel: () => {
        setLineSelection(null);
        cancel();
      },
      onEdit: (draft) => {
        startEdit(draft);
        setLineSelection({ start: draft.startLine, end: draft.endLine });
      },
      onDelete: deleteDraft,
    });
  }, [cancel, commentText, deleteDraft, editingDraftId, filesFileDrafts, handleSaveComment, isDragging, lineSelection, selectedFile?.path, startEdit]);

  const renderShikiFileView = React.useCallback((file: FileNode, content: string) => {
    return (
      <div className="h-full">
        <PierreFile
          file={{
            name: file.name,
            contents: content,
            lang: getLanguageFromExtension(file.path) || undefined,
          }}
          options={{
            disableFileHeader: true,
            overflow: wrapLines ? 'wrap' : 'scroll',
            theme: pierreTheme,
            themeType: currentTheme.metadata.variant === 'dark' ? 'dark' : 'light',
          }}
          className="block h-full w-full"
          style={{ height: '100%' }}
        />
      </div>
    );
  }, [currentTheme.metadata.variant, pierreTheme, wrapLines]);

  const fileViewer = (
    <div
      className="relative flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden"
    >
      <Dialog open={confirmDiscardOpen} onOpenChange={(open) => {
        // Intentionally no "cancel" action. Keep dialog modal.
        if (!open) {
          setConfirmDiscardOpen(true);
        }
      }}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <DialogTitle>Unsaved changes</DialogTitle>
            <DialogDescription>
              Save your edits before continuing?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => void saveAndContinue()}
              disabled={isSaving}
              className="border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success)] hover:bg-[rgb(var(--status-success)/0.2)]"
            >
              Save changes
            </Button>
            <Button variant="destructive" onClick={discardAndContinue}>Discard</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Binary file warning dialog */}
      <Dialog open={binaryWarningDialog !== null} onOpenChange={(open) => {
        if (!open) {
          setBinaryWarningDialog(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{binaryWarningDialog?.title || 'Binary File'}</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap">
              {binaryWarningDialog?.message || 'This file cannot be displayed.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setBinaryWarningDialog(null)}
            >
              Cancel
            </Button>
            {binaryWarningDialog?.node && (
              <Button
                variant="default"
                onClick={() => {
                  if (binaryWarningDialog.node) {
                    void handleSelectFile(binaryWarningDialog.node, true);
                  }
                  setBinaryWarningDialog(null);
                }}
              >
                View Details
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={externalChangeDialog !== null} onOpenChange={(open) => {
        if (!open) {
          setExternalChangeDialog(null);
        }
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>File changed on disk</DialogTitle>
            <DialogDescription className="whitespace-pre-wrap">
              {externalChangeDialog?.node?.name
                ? `${externalChangeDialog.node.name} was modified outside OpenChamber.`
                : 'This file was modified outside OpenChamber.'}
              {' '}
              Reload from disk or keep the currently loaded version?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={keepLoadedVersion}
            >
              Keep loaded version
            </Button>
            <Button
              variant="default"
              onClick={reloadFromDiskAfterExternalChange}
            >
              Reload from disk
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="flex flex-col border-b border-border/40 flex-shrink-0">
        {/* Row 1: Tabs */}
        {showEditorTabsRow ? (
        <div className="flex min-w-0 items-center px-3 py-1.5">
          {isMobile && showMobilePageContent && (
            <button
              type="button"
              onClick={() => setShowMobilePageContent(false)}
              aria-label="Back"
              className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center mr-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RiArrowLeftSLine className="h-5 w-5" />
            </button>
          )}

          {isMobile ? (
            selectedFile ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex min-w-0 max-w-full items-center gap-1 text-left typography-ui-label font-medium"
                    aria-label="Open files"
                  >
                    <FileTypeIcon filePath={selectedFile.path} extension={selectedFile.extension} className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{selectedFile.name}</span>
                    <RiArrowDownSLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[16rem]">
                  {openFiles.map((file) => {
                    const isActive = selectedFile?.path === file.path;
                    return (
                      <DropdownMenuItem
                        key={file.path}
                        onSelect={(event) => {
                          const target = event.target as HTMLElement;
                          if (target.closest('[data-close-open-file]')) {
                            event.preventDefault();
                            return;
                          }
                          if (!isActive) {
                            void handleSelectFile(file);
                          }
                        }}
                        className={cn(
                          'flex items-center justify-between gap-2',
                          isActive && 'bg-[var(--interactive-selection)] text-[var(--interactive-selection-foreground)]'
                        )}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                          <FileTypeIcon filePath={file.path} extension={file.extension} className="h-3.5 w-3.5 flex-shrink-0" />
                          <span className="min-w-0 flex-1 truncate">{file.name}</span>
                        </span>
                        <button
                          type="button"
                          data-close-open-file
                          onPointerDown={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleCloseFile(file.path);
                          }}
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]"
                          aria-label={`Close ${file.name}`}
                        >
                          <RiCloseLine className="h-3.5 w-3.5" />
                        </button>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <div className="typography-ui-label font-medium truncate">Select a file</div>
            )
          ) : (
            openFiles.length > 0 ? (
              <div className="relative min-w-0 flex-1">
                {editorTabsOverflow.left && (
                  <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-r from-background to-transparent" />
                )}
                {editorTabsOverflow.right && (
                  <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 z-10 bg-gradient-to-l from-background to-transparent" />
                )}
                <div
                  ref={editorTabsScrollRef}
                  className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-none"
                  style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
                >
                  {openFiles.map((file) => {
                    const isActive = selectedFile?.path === file.path;
                    return (
                      <div
                        key={file.path}
                        title={getDisplayPath(root, file.path)}
                        className={cn(
                          'group inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-ui-label transition-colors whitespace-nowrap',
                          isActive
                            ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                            : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]'
                        )}
                      >
                        <FileTypeIcon filePath={file.path} extension={file.extension} className="h-3.5 w-3.5 flex-shrink-0" />
                        <button
                          type="button"
                          onClick={() => {
                            if (!isActive) {
                              void handleSelectFile(file);
                            }
                          }}
                          className="max-w-[12rem] truncate text-left"
                        >
                          {file.name}
                        </button>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handleCloseFile(file.path);
                          }}
                          className={cn(
                            'rounded-sm p-0.5 text-[var(--surface-muted-foreground)] hover:text-[var(--surface-foreground)]',
                            !isActive && 'opacity-0 group-hover:opacity-100'
                          )}
                          aria-label={`Close ${file.name}`}
                        >
                          <RiCloseLine size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="typography-ui-label font-medium truncate">Select a file</div>
            )
          )}
        </div>
        ) : null}

        {/* Row 2: Actions (right-aligned) */}
        {selectedFile && (
          <div className={cn('flex items-center justify-end gap-1 px-3 pb-1.5', !showEditorTabsRow && 'pt-1.5')}>
            {canEdit && textViewMode === 'edit' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void saveDraft()}
                disabled={!isDirty || isSaving}
                className="h-5 w-5 p-0 text-[color:var(--status-success)] opacity-70 hover:opacity-100"
                title={`Save (${getModifierLabel()}+S)`}
                aria-label={`Save (${getModifierLabel()}+S)`}
              >
                {isSaving ? (
                  <RiLoader4Line className="h-4 w-4 animate-spin" />
                ) : (
                  <RiSave3Line className="h-4 w-4" />
                )}
              </Button>
            )}

            {runtime.isDesktop && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 p-0 text-muted-foreground opacity-70 hover:opacity-100"
                  title="Open in desktop app"
                  aria-label="Open in desktop app"
                >
                  <RiFileTransferLine className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
                {openInApps.map((app) => (
                  <DropdownMenuItem
                    key={app.id}
                    className="flex items-center gap-2"
                    onClick={() => void handleOpenInApp(app)}
                  >
                    <OpenInAppListIcon label={app.label} iconDataUrl={app.iconDataUrl} />
                    <span className="typography-ui-label text-foreground">{app.label}</span>
                  </DropdownMenuItem>
                ))}
                {openInCacheStale ? (
                  <DropdownMenuItem
                    className="flex items-center gap-2"
                    onClick={() => void loadOpenInApps(true)}
                  >
                    <RiRefreshLine className="h-4 w-4" />
                    <span className="typography-ui-label text-foreground">Refresh Apps</span>
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            )}

            {!runtime.isDesktop && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDownloadFile}
                className="h-5 w-5 p-0 text-muted-foreground opacity-70 hover:opacity-100"
                title="Download file"
                aria-label="Download file"
              >
                <RiDownloadLine className="h-4 w-4" />
              </Button>
            )}

            {canEdit && !isSelectedImage && (
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
            )}
            {!isSelectedImage && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setWrapLines(!wrapLines)}
                  className={cn(
                    'h-5 w-5 p-0 transition-opacity',
                    wrapLines ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-60 hover:opacity-100'
                  )}
                  title={wrapLines ? 'Disable line wrap' : 'Enable line wrap'}
                >
                  <RiTextWrap className="size-4" />
                </Button>
                {textViewMode === 'edit' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setIsSearchOpen(!isSearchOpen)}
                    className={cn(
                      'h-5 w-5 p-0 transition-opacity',
                      isSearchOpen ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-60 hover:opacity-100'
                    )}
                    title="Find in file"
                  >
                    <RiSearchLine className="size-4" />
                  </Button>
                )}
              </>
            )}

            {(canCopy || canCopyPath || isMarkdown) && (canEdit || !isSelectedImage) && (
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
            )}

            {isMarkdown && (
              <PreviewToggleButton
                currentMode={getMdViewMode()}
                onToggle={() => saveMdViewMode(getMdViewMode() === 'preview' ? 'edit' : 'preview')}
              />
            )}

            {canCopy && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const result = await copyTextToClipboard(fileContent);
                  if (result.ok) {
                    setCopiedContent(true);
                    if (copiedContentTimeoutRef.current !== null) {
                      window.clearTimeout(copiedContentTimeoutRef.current);
                    }
                    copiedContentTimeoutRef.current = window.setTimeout(() => {
                      setCopiedContent(false);
                    }, 1200);
                  } else {
                    toast.error('Copy failed');
                  }
                }}
                className="h-5 w-5 p-0"
                title="Copy file contents"
                aria-label="Copy file contents"
              >
                {copiedContent ? (
                  <RiCheckLine className="h-4 w-4 text-[color:var(--status-success)]" />
                ) : (
                  <RiClipboardLine className="h-4 w-4" />
                )}
              </Button>
            )}

            {canCopyPath && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const result = await copyTextToClipboard(displaySelectedPath);
                  if (result.ok) {
                    setCopiedPath(true);
                    if (copiedPathTimeoutRef.current !== null) {
                      window.clearTimeout(copiedPathTimeoutRef.current);
                    }
                    copiedPathTimeoutRef.current = window.setTimeout(() => {
                      setCopiedPath(false);
                    }, 1200);
                  } else {
                    toast.error('Copy failed');
                  }
                }}
                className="h-5 w-5 p-0"
                title={`Copy file path (${displaySelectedPath})`}
                aria-label={`Copy file path (${displaySelectedPath})`}
              >
                {copiedPath ? (
                  <RiCheckLine className="h-4 w-4 text-[color:var(--status-success)]" />
                ) : (
                  <RiFileCopy2Line className="h-4 w-4" />
                )}
              </Button>
            )}

            {!isMobile && mode === 'full' && (
              <>
                <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setIsFullscreen(!isFullscreen)}
                  className="h-5 w-5 p-0"
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? (
                    <RiFullscreenExitLine className="h-4 w-4" />
                  ) : (
                    <RiFullscreenLine className="h-4 w-4" />
                  )}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 min-w-0 relative">
        <ScrollableOverlay outerClassName="h-full min-w-0" className="relative h-full min-w-0">
          {openMediaFiles.length > 0 && (
            <div className={cn('absolute inset-0 z-10', isSelectedMedia ? 'block' : 'hidden')} aria-hidden={!isSelectedMedia}>
              {openMediaFiles.map((file) => {
                const category = getFileCategory(file.path);
                if (category !== 'pdf' && category !== 'audio' && category !== 'video') {
                  return null;
                }

                const isActiveMediaTab = selectedFile?.path === file.path;
                const src = mediaSrcByPath.get(file.path) ?? rawFileSrcForPath(file.path);

                return (
                  <div
                    key={file.path}
                    className={cn('absolute inset-0', isActiveMediaTab ? 'block' : 'hidden')}
                    aria-hidden={!isActiveMediaTab}
                  >
                    <MediaViewer
                      category={category}
                      src={src}
                      fileName={file.name}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {openTextEditorFiles.length > 0 && !isFullscreen && (
            <div className={cn('absolute inset-0 z-20', shouldShowTextEditorOverlay ? 'block' : 'hidden')} aria-hidden={!shouldShowTextEditorOverlay}>
              {openTextEditorFiles.map((file) => {
                const isActiveTextTab = Boolean(isSelectedTextEditor && selectedFile?.path === file.path);
                const draftValue = getEditorDraftForPath(file.path);

                return (
                  <div
                    key={file.path}
                    className={cn('absolute inset-0', isActiveTextTab ? 'block' : 'hidden')}
                    aria-hidden={!isActiveTextTab}
                  >
                    <div
                      className={cn('relative h-full', isActiveTextTab && shouldMaskEditorForPendingNavigation && 'overflow-hidden')}
                      ref={isActiveTextTab ? editorWrapperRef : undefined}
                      data-keyboard-avoid="none"
                      style={isActiveTextTab && isMobile ? { height: 'calc(100% - var(--oc-keyboard-inset, 0px))' } : undefined}
                    >
                      <div className={cn('h-full', isActiveTextTab && shouldMaskEditorForPendingNavigation && 'invisible')}>
                        <CodeMirrorEditor
                          value={draftValue}
                          onChange={(nextValue) => handleEditorDraftChange(file.path, nextValue)}
                          extensions={isActiveTextTab ? editorExtensions : inactiveEditorExtensions}
                          className="h-full"
                          blockWidgets={isActiveTextTab ? blockWidgets : undefined}
                          onViewReady={(view) => {
                            handleCodeMirrorViewReady(file.path, view);
                          }}
                          onViewDestroy={() => {
                            handleCodeMirrorViewDestroy(file.path);
                          }}
                          enableSearch={isActiveTextTab}
                          searchOpen={isActiveTextTab ? isSearchOpen : false}
                          onSearchOpenChange={isActiveTextTab ? setIsSearchOpen : undefined}
                          highlightLines={isActiveTextTab && lineSelection
                            ? {
                              start: Math.min(lineSelection.start, lineSelection.end),
                              end: Math.max(lineSelection.start, lineSelection.end),
                            }
                            : undefined}
                          lineNumbersConfig={isActiveTextTab
                            ? {
                              domEventHandlers: {
                                mousedown: (view: EditorView, line: { from: number; to: number }, event: Event) => {
                                  if (!(event instanceof MouseEvent)) {
                                    return false;
                                  }
                                  if (event.button !== 0) {
                                    return false;
                                  }
                                  event.preventDefault();

                                  const lineNumber = view.state.doc.lineAt(line.from).number;

                                  if (isMobile && lineSelection && !event.shiftKey) {
                                    const start = Math.min(lineSelection.start, lineSelection.end, lineNumber);
                                    const end = Math.max(lineSelection.start, lineSelection.end, lineNumber);
                                    setLineSelection({ start, end });
                                    isSelectingRef.current = false;
                                    selectionStartRef.current = null;
                                    setIsDragging(false);
                                    return true;
                                  }

                                  isSelectingRef.current = true;
                                  selectionStartRef.current = lineNumber;
                                  setIsDragging(true);

                                  if (lineSelection && event.shiftKey) {
                                    const start = Math.min(lineSelection.start, lineNumber);
                                    const end = Math.max(lineSelection.end, lineNumber);
                                    setLineSelection({ start, end });
                                  } else {
                                    setLineSelection({ start: lineNumber, end: lineNumber });
                                  }

                                  return true;
                                },
                                mouseover: (view: EditorView, line: { from: number; to: number }, event: Event) => {
                                  if (!(event instanceof MouseEvent)) {
                                    return false;
                                  }
                                  if (event.buttons !== 1) {
                                    return false;
                                  }
                                  if (!isSelectingRef.current || selectionStartRef.current === null) {
                                    return false;
                                  }

                                  const lineNumber = view.state.doc.lineAt(line.from).number;
                                  const start = Math.min(selectionStartRef.current, lineNumber);
                                  const end = Math.max(selectionStartRef.current, lineNumber);
                                  setLineSelection({ start, end });
                                  setIsDragging(true);
                                  return false;
                                },
                                mouseup: () => {
                                  isSelectingRef.current = false;
                                  selectionStartRef.current = null;
                                  setIsDragging(false);
                                  return false;
                                },
                              },
                            }
                            : undefined}
                        />
                      </div>
                      {isActiveTextTab && shouldMaskEditorForPendingNavigation && (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background">
                          <div className="flex items-center gap-2 typography-ui text-muted-foreground">
                            <RiLoader4Line className="h-4 w-4 animate-spin" />
                            Opening file at change...
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!selectedFile ? (
            <div className="p-3 typography-ui text-muted-foreground">Pick a file from the tree.</div>
          ) : fileLoading ? (
            suppressFileLoadingIndicator
              ? <div className="p-3" />
              : (
                <div className="p-3 flex items-center gap-2 typography-ui text-muted-foreground">
                  <RiLoader4Line className="h-4 w-4 animate-spin" />
                  Loading…
                </div>
              )
          ) : fileError ? (
            <div className="p-3 typography-ui text-[color:var(--status-error)]">{fileError}</div>
          ) : isSelectedImage ? (
            <div className="flex h-full items-center justify-center p-3">
              <img
                src={imageSrc}
                alt={selectedFile?.name ?? 'Image'}
                className="max-w-full max-h-[70vh] object-contain rounded-md border border-border/30 bg-primary/10"
              />
            </div>
          ) : isSelectedMedia ? (
            <div className="h-full" />
          ) : isBinaryNonDisplayable && selectedFile ? (
            <div className="flex h-full items-center justify-center p-3">
              <div className="flex flex-col items-center gap-3 text-center">
                <FileTypeIcon filePath={selectedFile.path} extension={selectedFile.extension} className="h-10 w-10 text-muted-foreground" />
                <div className="typography-ui font-medium text-foreground">{selectedFile.name}</div>
                <div className="typography-ui text-muted-foreground max-w-xs">
                  {nonDisplayableBinaryDescription}. This file cannot be displayed as text.
                </div>
                {!runtime.isDesktop && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDownloadFile}
                    className="mt-1"
                  >
                    <RiDownloadLine className="mr-2 h-4 w-4" />
                    Download File
                  </Button>
                )}
              </div>
            </div>
          ) : selectedFile && isMarkdown && getMdViewMode() === 'preview' ? (
            <div className="h-full overflow-auto p-3">
              {fileContent.length > 500 * 1024 && (
                <div className="mb-3 rounded-md border border-status-warning/20 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
                  This file is large ({Math.round(fileContent.length / 1024)}KB). Preview may be limited.
                </div>
              )}
              <ErrorBoundary
                fallback={
                  <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                    <div className="mb-1 font-medium text-destructive">Preview unavailable</div>
                    <div className="text-sm text-muted-foreground">
                      Switch to edit mode to fix the issue.
                    </div>
                  </div>
                }
              >
                <SimpleMarkdownRenderer
                  content={fileContent}
                  className="typography-markdown-body"
                  stripFrontmatter
                />
              </ErrorBoundary>
            </div>
          ) : selectedFile && canUseShikiFileView && textViewMode === 'view' ? (
            renderShikiFileView(selectedFile, draftContent)
          ) : (
            <div className="h-full" />
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );

  const hasTree = Boolean(root && childrenByDir[root]);

  const treePanel = (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden relative",
        isMobile ? "h-full w-full bg-background" : "h-full rounded-xl border border-border/60 bg-background/70",
        isDraggingFiles && !dropTargetPath && "ring-2 ring-primary ring-inset"
      )}
      onDragEnter={handleTreeDragEnter}
      onDragOver={handleTreeDragOver}
      onDragLeave={handleTreeDragLeave}
      onDrop={handleTreeDrop}
    >
      {/* Drop overlay */}
      {isDraggingFiles && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-none">
          <div className="text-center">
            <RiUploadCloud2Line className="h-12 w-12 mx-auto mb-2 text-primary" />
            <div className="typography-ui font-medium text-foreground">
              {dropTargetPath && dropTargetPath !== currentDirectory
                ? `Drop to upload to ${dropTargetPath.split('/').pop()}`
                : 'Drop files to upload'}
            </div>
            <div className="typography-meta text-muted-foreground mt-1">
              {isUploading ? 'Uploading...' : 'Release to upload'}
            </div>
          </div>
        </div>
      )}
      <div className={cn("flex flex-col gap-2 py-2", isMobile ? "px-3" : "px-2")}>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <RiSearchLine className="pointer-events-none absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
            <Input
              ref={searchInputRef}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search files…"
              className="h-8 pl-8 pr-8 typography-meta"
            />
            {searchQuery.trim().length > 0 && (
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
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpenDialog('createFile', { path: currentDirectory, type: 'directory' })}
            className="h-8 w-8 p-0 flex-shrink-0"
            title="New File"
          >
            <RiFileAddLine className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpenDialog('createFolder', { path: currentDirectory, type: 'directory' })}
            className="h-8 w-8 p-0 flex-shrink-0"
            title="New Folder"
          >
            <RiFolderAddLine className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refreshRoot()} className="h-8 w-8 p-0 flex-shrink-0">
            <RiRefreshLine className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollableOverlay outerClassName="flex-1 min-h-0" className={cn("py-2", isMobile ? "px-3" : "px-2")}>
        <DndContext
          sensors={dndSensors}
          collisionDetection={closestCenter}
          onDragStart={handleDndDragStart}
          onDragOver={handleDndDragOver}
          onDragEnd={handleDndDragEnd}
        >
          <ul className="flex flex-col">
            {searching ? (
              <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
                <RiLoader4Line className="h-4 w-4 animate-spin" />
                Searching…
              </li>
            ) : searchResults.length > 0 ? (
              searchResults.map((node) => {
                const isActive = selectedFile?.path === node.path;
                return (
                  <li key={node.path}>
                    <button
                      type="button"
                      onClick={() => void handleSelectFile(node)}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-foreground transition-colors',
                        isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40',
                        isMobile && 'min-h-9'
                      )}
                    >
                      {getFileIcon(node.path, node.extension)}
                      <span
                        className="min-w-0 flex-1 truncate typography-meta"
                        style={{ direction: 'rtl', textAlign: 'left' }}
                        title={node.path}
                      >
                        {node.relativePath ?? node.path}
                      </span>
                    </button>
                  </li>
                );
              })
            ) : hasTree ? (
              renderTree(root, 0)
            ) : (
              <li className="px-2 py-1 typography-meta text-muted-foreground">Loading…</li>
            )}
          </ul>
          <DragOverlay>
            {activeDndNode && (
              <div className="flex items-center gap-1.5 rounded-md border border-primary bg-background px-2 py-1.5 shadow-lg">
                <RiDragMove2Fill className="h-4 w-4 text-primary" />
                {activeDndNode.type === 'directory' ? (
                  <RiFolder3Fill className="h-4 w-4 flex-shrink-0 text-primary/60" />
                ) : (
                  getFileIcon(activeDndNode.path, activeDndNode.extension)
                )}
                <span className="typography-meta text-foreground truncate max-w-[200px]">
                  {activeDndNode.name}
                </span>
              </div>
            )}
          </DragOverlay>
        </DndContext>
      </ScrollableOverlay>
    </section>
  );

  // Fullscreen file viewer overlay
  const fullscreenViewer = mode === 'full' && isFullscreen && selectedFile && (
    <div className="absolute inset-0 z-50 flex flex-col bg-background">
      {/* Fullscreen header */}
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-4 py-2 flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="typography-ui-label font-medium truncate">
            {selectedFile.name}
          </div>
          <div className="typography-meta text-muted-foreground truncate" title={displaySelectedPath}>
            {displaySelectedPath}
          </div>
        </div>

        <div className="flex items-center gap-1">
          {canEdit && textViewMode === 'edit' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void saveDraft()}
              disabled={!isDirty || isSaving}
              className="h-6 w-6 p-0 text-[color:var(--status-success)] opacity-70 hover:opacity-100"
              title={`Save (${getModifierLabel()}+S)`}
              aria-label={`Save (${getModifierLabel()}+S)`}
            >
              {isSaving ? (
                <RiLoader4Line className="h-4 w-4 animate-spin" />
              ) : (
                <RiSave3Line className="h-4 w-4" />
              )}
            </Button>
          )}

          {runtime.isDesktop && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-muted-foreground opacity-70 hover:opacity-100"
                title="Open in desktop app"
                aria-label="Open in desktop app"
              >
                <RiFileTransferLine className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56 max-h-[70vh] overflow-y-auto">
              {openInApps.map((app) => (
                <DropdownMenuItem
                  key={app.id}
                  className="flex items-center gap-2"
                  onClick={() => void handleOpenInApp(app)}
                >
                  <OpenInAppListIcon label={app.label} iconDataUrl={app.iconDataUrl} />
                  <span className="typography-ui-label text-foreground">{app.label}</span>
                </DropdownMenuItem>
              ))}
              {openInCacheStale ? (
                <DropdownMenuItem
                  className="flex items-center gap-2"
                  onClick={() => void loadOpenInApps(true)}
                >
                  <RiRefreshLine className="h-4 w-4" />
                  <span className="typography-ui-label text-foreground">Refresh Apps</span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          )}

          {canEdit && !isSelectedImage && (
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
          )}

          {!isSelectedImage && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setWrapLines(!wrapLines)}
              className={cn(
                'h-6 w-6 p-0 transition-opacity',
                wrapLines ? 'text-foreground opacity-100' : 'text-muted-foreground opacity-60 hover:opacity-100'
              )}
              title={wrapLines ? 'Disable line wrap' : 'Enable line wrap'}
            >
              <RiTextWrap className="size-4" />
            </Button>
          )}

          {(canCopy || canCopyPath || isMarkdown) && (canEdit || !isSelectedImage) && (
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
          )}

          {isMarkdown && (
            <PreviewToggleButton
              currentMode={getMdViewMode()}
              onToggle={() => saveMdViewMode(getMdViewMode() === 'preview' ? 'edit' : 'preview')}
            />
          )}

          {canCopy && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(fileContent);
                if (result.ok) {
                  setCopiedContent(true);
                  if (copiedContentTimeoutRef.current !== null) {
                    window.clearTimeout(copiedContentTimeoutRef.current);
                  }
                  copiedContentTimeoutRef.current = window.setTimeout(() => {
                    setCopiedContent(false);
                  }, 1200);
                } else {
                  toast.error('Copy failed');
                }
              }}
              className="h-6 w-6 p-0"
              title="Copy file contents"
              aria-label="Copy file contents"
            >
              {copiedContent ? (
                <RiCheckLine className="h-4 w-4 text-[color:var(--status-success)]" />
              ) : (
                <RiClipboardLine className="h-4 w-4" />
              )}
            </Button>
          )}

          {canCopyPath && (
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                const result = await copyTextToClipboard(displaySelectedPath);
                if (result.ok) {
                  setCopiedPath(true);
                  if (copiedPathTimeoutRef.current !== null) {
                    window.clearTimeout(copiedPathTimeoutRef.current);
                  }
                  copiedPathTimeoutRef.current = window.setTimeout(() => {
                    setCopiedPath(false);
                  }, 1200);
                } else {
                  toast.error('Copy failed');
                }
              }}
              className="h-6 w-6 p-0"
              title={`Copy file path (${displaySelectedPath})`}
              aria-label={`Copy file path (${displaySelectedPath})`}
            >
              {copiedPath ? (
                <RiCheckLine className="h-4 w-4 text-[color:var(--status-success)]" />
              ) : (
                <RiFileCopy2Line className="h-4 w-4" />
              )}
            </Button>
          )}

          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setIsFullscreen(false)}
            className="h-6 w-6 p-0"
            title="Exit fullscreen"
            aria-label="Exit fullscreen"
          >
            <RiFullscreenExitLine className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Fullscreen content */}
      <div className="flex-1 min-h-0 min-w-0 relative">
        <ScrollableOverlay outerClassName="h-full min-w-0" className="relative h-full min-w-0">
          {openMediaFiles.length > 0 && (
            <div className={cn('absolute inset-0 z-10', isSelectedMedia ? 'block' : 'hidden')} aria-hidden={!isSelectedMedia}>
              {openMediaFiles.map((file) => {
                const category = getFileCategory(file.path);
                if (category !== 'pdf' && category !== 'audio' && category !== 'video') {
                  return null;
                }

                const isActiveMediaTab = selectedFile.path === file.path;
                const src = mediaSrcByPath.get(file.path) ?? rawFileSrcForPath(file.path);

                return (
                  <div
                    key={file.path}
                    className={cn('absolute inset-0', isActiveMediaTab ? 'block' : 'hidden')}
                    aria-hidden={!isActiveMediaTab}
                  >
                    <MediaViewer
                      category={category}
                      src={src}
                      fileName={file.name}
                      fullscreen
                    />
                  </div>
                );
              })}
            </div>
          )}
          {fileLoading ? (
            suppressFileLoadingIndicator
              ? <div className="p-4" />
              : (
                <div className="p-4 flex items-center gap-2 typography-ui text-muted-foreground">
                  <RiLoader4Line className="h-4 w-4 animate-spin" />
                  Loading…
                </div>
              )
          ) : fileError ? (
            <div className="p-4 typography-ui text-[color:var(--status-error)]">{fileError}</div>
          ) : isSelectedImage ? (
            <div className="flex h-full items-center justify-center p-4">
              <img
                src={imageSrc}
                alt={selectedFile.name}
                className="max-w-full max-h-full object-contain rounded-md border border-border/30 bg-primary/10"
              />
            </div>
          ) : isSelectedMedia ? (
            <div className="h-full" />
          ) : isBinaryNonDisplayable ? (
            <div className="flex h-full items-center justify-center p-4">
              <div className="flex flex-col items-center gap-3 text-center">
                <FileTypeIcon filePath={selectedFile.path} extension={selectedFile.extension} className="h-10 w-10 text-muted-foreground" />
                <div className="typography-ui font-medium text-foreground">{selectedFile.name}</div>
                <div className="typography-ui text-muted-foreground max-w-xs">
                  {nonDisplayableBinaryDescription}. This file cannot be displayed as text.
                </div>
                {!runtime.isDesktop && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDownloadFile}
                    className="mt-1"
                  >
                    <RiDownloadLine className="mr-2 h-4 w-4" />
                    Download File
                  </Button>
                )}
              </div>
            </div>
          ) : isMarkdown && getMdViewMode() === 'preview' ? (
            <div className="h-full overflow-auto p-4">
              {fileContent.length > 500 * 1024 && (
                <div className="mb-3 rounded-md border border-status-warning/20 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
                  This file is large ({Math.round(fileContent.length / 1024)}KB). Preview may be limited.
                </div>
              )}
              <ErrorBoundary
                fallback={
                  <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2">
                    <div className="mb-1 font-medium text-destructive">Preview unavailable</div>
                    <div className="text-sm text-muted-foreground">
                      Switch to edit mode to fix the issue.
                    </div>
                  </div>
                }
              >
                <SimpleMarkdownRenderer
                  content={fileContent}
                  className="typography-markdown-body"
                  stripFrontmatter
                />
              </ErrorBoundary>
            </div>
          ) : canUseShikiFileView && textViewMode === 'view' ? (
            renderShikiFileView(selectedFile, draftContent)
          ) : (
            <div className={cn('relative h-full', shouldMaskEditorForPendingNavigation && 'overflow-hidden')}>
              <div className={cn('h-full', shouldMaskEditorForPendingNavigation && 'invisible')}>
              <CodeMirrorEditor
                value={draftContent}
                onChange={(nextValue) => {
                  if (selectedFile?.path) {
                    handleEditorDraftChange(selectedFile.path, nextValue);
                    return;
                  }
                  setDraftContent(nextValue);
                }}
                extensions={editorExtensions}
                className="h-full"
                onViewReady={(view) => {
                  editorViewRef.current = view;
                  window.requestAnimationFrame(() => {
                    nudgeEditorSelectionAboveKeyboard(view);
                  });
                }}
                onViewDestroy={() => {
                  if (editorViewRef.current) {
                    editorViewRef.current = null;
                  }
                }}
              />
              </div>
              {shouldMaskEditorForPendingNavigation && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background">
                  <div className="flex items-center gap-2 typography-ui text-muted-foreground">
                    <RiLoader4Line className="h-4 w-4 animate-spin" />
                    Opening file at change...
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );

  // Move confirmation dialog
  const moveConfirmDialogElement = (
    <Dialog open={!!moveConfirmDialog} onOpenChange={(open) => !open && handleCancelMove()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {moveConfirmDialog?.source.type === 'directory' ? 'Folder' : 'File'}</DialogTitle>
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
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background relative">
      {renderDialogs()}
      <input
        ref={contextUploadInputRef}
        type="file"
        multiple
        onChange={handleContextUploadInputChange}
        className="hidden"
      />
      {moveConfirmDialogElement}
      {fullscreenViewer}
      {isMobile ? (
        showMobilePageContent ? (
          fileViewer
        ) : (
          treePanel
        )
       ) : mode === 'editor-only' ? (
         <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden bg-background">
             {fileViewer}
            </div>
          </div>
       ) : (
         <div className="flex flex-1 min-h-0 min-w-0 gap-3 px-3 pb-3 pt-2">
            {screenWidth >= 700 && (
              <div className="w-72 flex-shrink-0 min-h-0 overflow-hidden">
               {treePanel}
             </div>
           )}
           <div className="flex-1 min-h-0 min-w-0 overflow-hidden rounded-xl border border-border/60 bg-background">
             {fileViewer}
           </div>
         </div>
       )}
    </div>
  );
};
