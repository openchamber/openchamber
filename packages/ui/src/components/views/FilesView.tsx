import React from 'react';

import {
  RiArrowLeftSLine,
  RiArrowDownSLine,
  RiClipboardLine,
  RiCloseLine,
  RiCodeLine,
  RiFileImageLine,
  RiFileTextLine,
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
} from '@remixicon/react';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';

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
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { languageByExtension } from '@/lib/codemirror/languageByExtension';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { generateSyntaxTheme } from '@/lib/theme/syntaxThemeGenerator';
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
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { EditorView } from '@codemirror/view';
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

type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  extension?: string;
  relativePath?: string;
};

type SelectedLineRange = {
  start: number;
  end: number;
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

const CODE_EXTENSIONS = new Set([
  // JavaScript/TypeScript
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  // Web
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl', 'stylus',
  'vue', 'svelte', 'astro',
  // Shell/Scripts
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  // Python
  'py', 'pyw', 'pyx', 'pxd', 'pxi',
  // Ruby
  'rb', 'erb', 'rake', 'gemspec',
  // PHP
  'php', 'phtml', 'php3', 'php4', 'php5', 'phps',
  // Java/JVM
  'java', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gradle',
  // C/C++/Objective-C
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'hh', 'm', 'mm',
  // C#/F#/.NET
  'cs', 'fs', 'fsx', 'fsi',
  // Go
  'go',
  // Rust
  'rs',
  // Swift
  'swift',
  // Dart
  'dart',
  // Lua
  'lua',
  // Perl
  'pl', 'pm', 'pod',
  // R
  'r', 'R', 'rmd',
  // Julia
  'jl',
  // Haskell
  'hs', 'lhs',
  // Elixir/Erlang
  'ex', 'exs', 'erl', 'hrl',
  // Clojure
  'clj', 'cljs', 'cljc', 'edn',
  // Lisp/Scheme
  'lisp', 'cl', 'el', 'scm', 'ss', 'rkt',
  // OCaml/ReasonML
  'ml', 'mli', 're', 'rei',
  // Nim
  'nim',
  // Zig
  'zig',
  // V
  'v',
  // Crystal
  'cr',
  // Kotlin Script
  'main.kts',
  // SQL
  'sql', 'psql', 'plsql',
  // GraphQL
  'graphql', 'gql',
  // Solidity
  'sol',
  // Assembly
  'asm', 's', 'S',
  // Makefile variants
  'mk',
  // Nix
  'nix',
  // Terraform
  'tf', 'tfvars',
  // Puppet
  'pp',
  // Ansible
  'ansible',
]);

const DATA_EXTENSIONS = new Set([
  // JSON variants
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'geojson',
  // YAML
  'yaml', 'yml',
  // TOML
  'toml',
  // XML variants
  'xml', 'xsl', 'xslt', 'xsd', 'dtd', 'plist',
  // Config files
  'ini', 'cfg', 'conf', 'config', 'env', 'properties',
  // CSV/TSV
  'csv', 'tsv',
  // Lock files
  'lock',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'icns',
  'bmp', 'tiff', 'tif', 'psd', 'ai', 'eps', 'raw', 'cr2', 'nef',
  'heic', 'heif', 'avif', 'jxl',
]);

const DOCUMENT_EXTENSIONS = new Set([
  // Markdown
  'md', 'mdx', 'markdown', 'mdown', 'mkd',
  // Text
  'txt', 'text', 'rtf',
  // Docs
  'doc', 'docx', 'odt', 'pdf',
  // ReStructuredText
  'rst',
  // AsciiDoc
  'adoc', 'asciidoc',
  // Org
  'org',
  // LaTeX
  'tex', 'latex', 'bib',
]);

const getFileIcon = (extension?: string): React.ReactNode => {
  const ext = extension?.toLowerCase();

  if (ext && CODE_EXTENSIONS.has(ext)) {
    return <RiCodeLine className="h-4 w-4 flex-shrink-0 text-[var(--status-info)]" />;
  }
  if (ext && DATA_EXTENSIONS.has(ext)) {
    return <RiCodeLine className="h-4 w-4 flex-shrink-0 text-[var(--status-warning)]" />;
  }
  if (ext && IMAGE_EXTENSIONS.has(ext)) {
    return <RiFileImageLine className="h-4 w-4 flex-shrink-0 text-[var(--status-success)]" />;
  }
  if (ext && DOCUMENT_EXTENSIONS.has(ext)) {
    return <RiFileTextLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
  }
  return <RiFileTextLine className="h-4 w-4 flex-shrink-0 text-muted-foreground" />;
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
  };
  contextMenuPath: string | null;
  setContextMenuPath: (path: string | null) => void;
  onSelect: (node: FileNode) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onOpenDialog: (type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => void;
}

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
  onOpenDialog,
}) => {
  const isDir = node.type === 'directory';
  const { canRename, canCreateFile, canCreateFolder, canDelete, canReveal } = permissions;

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!canRename && !canCreateFile && !canCreateFolder && !canDelete && !canReveal) {
      return;
    }
    event?.preventDefault();
    setContextMenuPath(node.path);
  }, [canRename, canCreateFile, canCreateFolder, canDelete, canReveal, node.path, setContextMenuPath]);

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
      className="group relative flex items-center"
      onContextMenu={!isMobile ? handleContextMenu : undefined}
    >
      <button
        type="button"
        onClick={handleInteraction}
        onContextMenu={!isMobile ? handleContextMenu : undefined}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors pr-8 select-none',
          isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40'
        )}
      >
        {isDir ? (
          isExpanded ? (
            <RiFolderOpenFill className="h-4 w-4 flex-shrink-0 text-primary/60" />
          ) : (
            <RiFolder3Fill className="h-4 w-4 flex-shrink-0 text-primary/60" />
          )
        ) : (
          getFileIcon(node.extension)
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
      {(canRename || canCreateFile || canCreateFolder || canDelete || canReveal) && (
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

interface FilesViewProps {
  mode?: 'full' | 'editor-only';
}

export const FilesView: React.FC<FilesViewProps> = ({ mode = 'full' }) => {
  const { files, runtime } = useRuntimeAPIs();
  const { currentTheme } = useThemeSystem();
  React.useMemo(() => generateSyntaxTheme(currentTheme), [currentTheme]);
  const { isMobile, screenWidth } = useDeviceInfo();
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();

  const currentDirectory = useEffectiveDirectory() ?? '';
  const root = normalizePath(currentDirectory.trim());
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const gitStatus = useGitStatus(currentDirectory);

  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const [showMobilePageContent, setShowMobilePageContent] = React.useState(false);
  const [wrapLines, setWrapLines] = React.useState(isMobile);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [isSearchOpen, setIsSearchOpen] = React.useState(false);

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

  const [draftContent, setDraftContent] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);

  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);
  const pendingSelectFileRef = React.useRef<FileNode | null>(null);
  const pendingTabRef = React.useRef<import('@/stores/useUIStore').MainTab | null>(null);
  const pendingClosePathRef = React.useRef<string | null>(null);
  const skipDirtyOnceRef = React.useRef(false);
  const copiedContentTimeoutRef = React.useRef<number | null>(null);
  const copiedPathTimeoutRef = React.useRef<number | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);

  const [activeDialog, setActiveDialog] = React.useState<'createFile' | 'createFolder' | 'rename' | 'delete' | null>(null);
  const [dialogData, setDialogData] = React.useState<{ path: string; name?: string; type?: 'file' | 'directory' } | null>(null);
  const [dialogInputValue, setDialogInputValue] = React.useState('');
  const [isDialogSubmitting, setIsDialogSubmitting] = React.useState(false);
  const [contextMenuPath, setContextMenuPath] = React.useState<string | null>(null);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [copiedPath, setCopiedPath] = React.useState(false);

  // Markdown view mode (global, not per-file)
  const [mdViewMode, setMdViewMode] = React.useState<'preview' | 'edit'>('edit');

  const canCreateFile = Boolean(files.writeFile);
  const canCreateFolder = Boolean(files.createDirectory);
  const canRename = Boolean(files.rename);
  const canDelete = Boolean(files.delete);
  const canReveal = Boolean(files.revealPath);

  const handleRevealPath = React.useCallback((targetPath: string) => {
    if (!files.revealPath) return;
    void files.revealPath(targetPath).catch(() => {
      toast.error('Failed to reveal path');
    });
  }, [files]);

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

  // Session/config for sending comments
  const setMainTabGuard = useUIStore((state) => state.setMainTabGuard);

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
    setDraftContent('');
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
        return {
          name,
          path,
          type,
          extension,
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

    try {
      const respectGitignore = !showGitignored;
      let entries: Array<{ name: string; path: string; isDirectory: boolean }>;
      if (runtime.isDesktop) {
        const result = await files.listDirectory(normalizedDir, { respectGitignore });
        entries = result.entries.map((entry) => ({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
        }));
      } else {
        const result = await opencodeClient.listLocalDirectory(normalizedDir, { respectGitignore });
        entries = result.map((entry) => ({
          name: entry.name,
          path: entry.path,
          isDirectory: entry.isDirectory,
        }));
      }
      
      const mapped = mapDirectoryEntries(normalizedDir, entries);

      loadedDirsRef.current = new Set(loadedDirsRef.current);
      loadedDirsRef.current.add(normalizedDir);
      setChildrenByDir((prev) => ({ ...prev, [normalizedDir]: mapped }));
    } catch {
      setChildrenByDir((prev) => ({
        ...prev,
        [normalizedDir]: prev[normalizedDir] ?? [],
      }));
    } finally {
      inFlightDirsRef.current = new Set(inFlightDirsRef.current);
      inFlightDirsRef.current.delete(normalizedDir);
    }
  }, [files, mapDirectoryEntries, runtime.isDesktop, showGitignored]);

  const refreshRoot = React.useCallback(async () => {
    if (!root) {
      return;
    }

    loadedDirsRef.current = new Set();
    inFlightDirsRef.current = new Set();
    setChildrenByDir((prev) => (Object.keys(prev).length === 0 ? prev : {}));

    await loadDirectory(root);
  }, [loadDirectory, root]);

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
      setFileContent('');
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
  }, [loadDirectory, root, showGitignored, showHidden]);

  const MD_VIEWER_MODE_KEY = 'openchamber:files:md-viewer-mode';

  // Load markdown view mode preference from localStorage on mount
  React.useEffect(() => {
    try {
      const stored = localStorage.getItem(MD_VIEWER_MODE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed === 'preview' || parsed === 'edit') {
          setMdViewMode(parsed);
        }
      }
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Save markdown view mode preference to localStorage
  const saveMdViewMode = React.useCallback((mode: 'preview' | 'edit') => {
    setMdViewMode(mode);
    try {
      localStorage.setItem(MD_VIEWER_MODE_KEY, JSON.stringify(mode));
    } catch {
      // Ignore localStorage errors
    }
  }, []);

  // Get the view mode for a markdown file (from state, default to 'edit')
  const getMdViewMode = React.useCallback((): 'preview' | 'edit' => {
    return mdViewMode;
  }, [mdViewMode]);

  const handleDialogSubmit = React.useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogData || !activeDialog) return;

    setIsDialogSubmitting(true);
    try {
      if (activeDialog === 'createFile') {
        if (!dialogInputValue.trim()) throw new Error('Filename is required');
        const parentPath = dialogData.path;
        // Handle root path or empty path
        const prefix = parentPath ? `${parentPath}/` : '';
        const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

        if (!files.writeFile) throw new Error('Write not supported');
        const result = await files.writeFile(newPath, '');
        if (result.success) {
          toast.success('File created');
          await refreshRoot();
        }
      } else if (activeDialog === 'createFolder') {
        if (!dialogInputValue.trim()) throw new Error('Folder name is required');
        const parentPath = dialogData.path;
        const prefix = parentPath ? `${parentPath}/` : '';
        const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

        const result = await files.createDirectory(newPath);
        if (result.success) {
          toast.success('Folder created');
          await refreshRoot();
        }
      } else if (activeDialog === 'rename') {
        if (!dialogInputValue.trim()) throw new Error('Name is required');
        const oldPath = dialogData.path;
        const parentDir = oldPath.split('/').slice(0, -1).join('/');
        const prefix = parentDir ? `${parentDir}/` : '';
        const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

        if (files.rename) {
             const result = await files.rename(oldPath, newPath);
             if (result.success) {
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
        } else {
            toast.error("Rename not supported");
        }
      } else if (activeDialog === 'delete') {
        if (files.delete) {
             const result = await files.delete(dialogData.path);
             if (result.success) {
                 toast.success('Deleted successfully');
                 await refreshRoot();
                 if (root) {
                   removeOpenPathsByPrefix(root, dialogData.path);
                 }
                 if (selectedFile?.path === dialogData.path || selectedFile?.path.startsWith(dialogData.path + '/')) {
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
        } else {
             toast.error("Delete not supported");
        }
      }
      setActiveDialog(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Operation failed');
    } finally {
      setIsDialogSubmitting(false);
    }
  }, [activeDialog, dialogData, dialogInputValue, files, refreshRoot, isMobile, removeOpenPathsByPrefix, root, selectedFile?.path, setSelectedPath]);

  const fuzzyScore = React.useCallback((query: string, candidate: string): number | null => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return 0;
    }

    const c = candidate.toLowerCase();
    let score = 0;
    let lastIndex = -1;
    let consecutive = 0;

    for (let i = 0; i < q.length; i += 1) {
      const ch = q[i];
      if (!ch || ch === ' ') {
        continue;
      }

      const idx = c.indexOf(ch, lastIndex + 1);
      if (idx === -1) {
        return null;
      }

      const gap = idx - lastIndex - 1;
      if (gap === 0) {
        consecutive += 1;
      } else {
        consecutive = 0;
      }

      score += 10;
      score += Math.max(0, 18 - idx);
      score -= Math.max(0, gap);

      if (idx === 0) {
        score += 12;
      } else {
        const prev = c[idx - 1];
        if (prev === '/' || prev === '_' || prev === '-' || prev === '.' || prev === ' ') {
          score += 10;
        }
      }

      score += consecutive > 0 ? 12 : 0;
      lastIndex = idx;
    }

    score += Math.max(0, 24 - Math.round(c.length / 3));
    return score;
  }, []);

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

    const normalizedQueryLower = trimmedQuery.toLowerCase();
    let cancelled = false;
    setSearching(true);

    searchFiles(currentDirectory, trimmedQuery, 150, {
      includeHidden: showHidden,
      respectGitignore: !showGitignored,
    })
      .then((hits) => {
        if (cancelled) {
          return;
        }

        const filtered = hits.filter((hit) => showGitignored || !shouldIgnorePath(hit.path));

        // Apply fuzzy scoring and sort by score
        const ranked = filtered
          .map((hit) => {
            const label = hit.relativePath || hit.name || hit.path;
            const score = fuzzyScore(normalizedQueryLower, label);
            return score === null ? null : { hit, score, labelLength: label.length };
          })
          .filter(Boolean) as Array<{ hit: typeof hits[0]; score: number; labelLength: number }>;

        ranked.sort((a, b) => (
          b.score - a.score
          || a.labelLength - b.labelLength
          || a.hit.path.localeCompare(b.hit.path)
        ));

        const mapped: FileNode[] = ranked.map(({ hit }) => ({
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
  }, [currentDirectory, debouncedSearchQuery, fuzzyScore, searchFiles, showHidden, showGitignored]);

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

    try {
      const result = await files.writeFile(selectedFile.path, draftContent);
      if (!result?.success) {
        throw new Error('Failed to write file');
      }
      setFileContent(draftContent);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }, [draftContent, files, isDirty, selectedFile]);

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
    setFileError(null);
    setDesktopImageSrc('');
    setLoadedFilePath(node.path);

    const selectedIsImage = isImageFile(node.path);
    const isSvg = node.path.toLowerCase().endsWith('.svg');

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
      setFileLoading(false);
      return;
    }

    setFileLoading(true);

    try {
      const content = await readFile(node.path);
      setFileContent(content);
      setDraftContent(content.length > MAX_VIEW_CHARS
        ? `${content.slice(0, MAX_VIEW_CHARS)}\n\n… truncated …`
        : content);
    } catch (error) {
      if (isDirectoryReadError(error)) {
        if (root) {
          setSelectedPath(root, null);
        }
        setFileError(null);
        setFileContent('');
        setDraftContent('');
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
      setFileError(error instanceof Error ? error.message : 'Failed to read file');
    } finally {
      setFileLoading(false);
    }
  }, [expandPaths, isMobile, loadDirectory, readFile, root, runtime.isDesktop, searchQuery, setSelectedPath]);

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

  const handleSelectFile = React.useCallback(async (node: FileNode) => {
    if (skipDirtyOnceRef.current) {
      skipDirtyOnceRef.current = false;
    } else if (isDirty) {
      setConfirmDiscardOpen(true);
      pendingSelectFileRef.current = node;
      return;
    }

    if (root) {
      setSelectedPath(root, node.path);
      addOpenPath(root, node.path);
      void ensurePathVisible(node.path, false);
    }

    setFileError(null);
    setDesktopImageSrc('');
    setFileContent('');
    setDraftContent('');
    setLoadedFilePath(null);
    if (isMobile) {
      setShowMobilePageContent(true);
    }
  }, [addOpenPath, ensurePathVisible, isDirty, isMobile, root, setSelectedPath]);

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

    if (loadedFilePath === selectedFile.path) {
      return;
    }

    // Selection changes are guarded; this effect is also what restores persisted tabs on mount.
    void loadSelectedFile(selectedFile);
  }, [loadSelectedFile, loadedFilePath, selectedFile]);

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
  }, [displayedContent, handleSelectFile, isMobile, removeOpenPath, root, selectedFile?.path, setMainTabGuard, setSelectedPath]);

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

  const renderTree = React.useCallback((dirPath: string, depth: number): React.ReactNode => {
    const nodes = childrenByDir[dirPath] ?? [];

    return nodes.map((node, index) => {
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expandedPaths.includes(node.path);
      const isActive = selectedFile?.path === node.path;
      const isLast = index === nodes.length - 1;

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
          <FileRow
            node={node}
            isExpanded={isExpanded}
            isActive={isActive}
            isMobile={isMobile}
            status={!isDir ? getFileStatus(node.path) : undefined}
            badge={isDir ? getFolderBadge(node.path) : undefined}
            permissions={{ canRename, canCreateFile, canCreateFolder, canDelete, canReveal }}
            contextMenuPath={contextMenuPath}
            setContextMenuPath={setContextMenuPath}
            onSelect={handleSelectFile}
            onToggle={toggleDirectory}
            onRevealPath={handleRevealPath}
            onOpenDialog={handleOpenDialog}
          />
          {isDir && isExpanded && (
            <ul className="flex flex-col gap-1 ml-3 pl-3 border-l border-border/40 relative">
              {renderTree(node.path, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }, [childrenByDir, expandedPaths, handleSelectFile, selectedFile?.path, toggleDirectory, handleOpenDialog, handleRevealPath, canCreateFile, canCreateFolder, canRename, canDelete, canReveal, contextMenuPath, setContextMenuPath, isMobile, getFileStatus, getFolderBadge]);

  const isSelectedImage = Boolean(selectedFile?.path && isImageFile(selectedFile.path));
  const isSelectedSvg = Boolean(selectedFile?.path && selectedFile.path.toLowerCase().endsWith('.svg'));
  const getDisplayPath = React.useCallback((path: string): string => {
    if (!path) return '';
    const normalizedFilePath = normalizePath(path);
    if (root && isPathWithinRoot(normalizedFilePath, root)) {
      const relative = normalizedFilePath.slice(root.length);
      return relative.startsWith('/') ? relative.slice(1) : relative;
    }
    return normalizedFilePath;
  }, [root]);

  const displaySelectedPath = React.useMemo(() => {
    if (!selectedFile?.path) return '';
    return getDisplayPath(selectedFile.path);
  }, [getDisplayPath, selectedFile?.path]);

  const canCopy = Boolean(selectedFile && (!isSelectedImage || isSelectedSvg) && fileContent.length > 0);
  const canCopyPath = Boolean(selectedFile && displaySelectedPath.length > 0);
  const canEdit = Boolean(selectedFile && !isSelectedImage && files.writeFile && fileContent.length <= MAX_VIEW_CHARS);

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
    const language = languageByExtension(selectedFile.path);
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
  }, [currentTheme, selectedFile?.path, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard]);

  const imageSrc = selectedFile?.path && isSelectedImage
    ? (runtime.isDesktop
      ? (isSelectedSvg
        ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
        : desktopImageSrc)
      : (isSelectedSvg
        ? `data:${getImageMimeType(selectedFile.path)};utf8,${encodeURIComponent(fileContent)}`
        : `/api/fs/raw?path=${encodeURIComponent(selectedFile.path)}`))
    : '';




  React.useEffect(() => {
    let cancelled = false;

    const resolveDesktopImage = async () => {
      if (!runtime.isDesktop || !selectedFile?.path || !isSelectedImage || isSelectedSvg) {
        setDesktopImageSrc('');
        return;
      }

      setFileError(null);

      try {
        if (files.readFileBinary) {
          const result = await files.readFileBinary(selectedFile.path);
          if (!cancelled) {
            setDesktopImageSrc(result.dataUrl);
          }
          return;
        }

        const core = await import('@tauri-apps/api/core');
        const convertFileSrc = (core as { convertFileSrc?: (path: string, protocol?: string) => string }).convertFileSrc;
        if (!convertFileSrc) {
          return;
        }

        const src = convertFileSrc(selectedFile.path, 'asset');
        if (!cancelled) {
          setDesktopImageSrc(src);
        }
      } catch (error) {
        if (!cancelled) {
          setDesktopImageSrc('');
          setFileError(error instanceof Error ? error.message : 'Failed to read file');
        }
      } finally {
        if (!cancelled) {
          setFileLoading(false);
        }
      }
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
          <div className="py-4">
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
      <div className="flex flex-col border-b border-border/40 flex-shrink-0">
        {/* Row 1: Tabs */}
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
                        <span className="min-w-0 flex-1 truncate">
                          {file.name}
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
                        title={getDisplayPath(file.path)}
                        className={cn(
                          'group inline-flex items-center gap-1 rounded-md border px-2 py-1 typography-ui-label transition-colors whitespace-nowrap',
                          isActive
                            ? 'bg-[var(--interactive-selection)] border-[var(--primary-muted)] text-[var(--interactive-selection-foreground)]'
                            : 'bg-transparent border-[var(--interactive-border)] text-[var(--surface-muted-foreground)] hover:bg-[var(--interactive-hover)] hover:text-[var(--surface-foreground)]'
                        )}
                      >
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

        {/* Row 2: Actions (right-aligned) */}
        {selectedFile && (
          <div className="flex items-center justify-end gap-1 px-3 pb-1.5">
            {canEdit && (
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
              </>
            )}

            {(canCopy || canCopyPath || isMarkdownFile(selectedFile.path)) && (canEdit || !isSelectedImage) && (
              <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
            )}

            {isMarkdownFile(selectedFile.path) && (
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
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {!selectedFile ? (
            <div className="p-3 typography-ui text-muted-foreground">Pick a file from the tree.</div>
          ) : fileLoading ? (
            <div className="p-3 flex items-center gap-2 typography-ui text-muted-foreground">
              <RiLoader4Line className="h-4 w-4 animate-spin" />
              Loading…
            </div>
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
          ) : selectedFile && isMarkdownFile(selectedFile.path) && getMdViewMode() === 'preview' ? (
            <div className="h-full overflow-auto p-3">
              {fileContent.length > 500 * 1024 && (
                <div className="mb-3 rounded-md border border-status-warning/20 bg-status-warning/10 px-3 py-2 text-sm text-status-warning">
                  ⚠️ This file is large ({Math.round(fileContent.length / 1024)}KB). Preview may be limited.
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
                <SimpleMarkdownRenderer content={fileContent} className="typography-markdown-body" />
              </ErrorBoundary>
            </div>
          ) : (
            <div
              className="relative h-full"
              ref={editorWrapperRef}
              data-keyboard-avoid="none"
              style={isMobile ? { height: 'calc(100% - var(--oc-keyboard-inset, 0px))' } : undefined}
            >
              <CodeMirrorEditor
                value={draftContent}
                onChange={setDraftContent}
                extensions={editorExtensions}
                className="h-full"
                blockWidgets={blockWidgets}
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
                enableSearch
                searchOpen={isSearchOpen}
                onSearchOpenChange={setIsSearchOpen}
                highlightLines={lineSelection
                  ? {
                    start: Math.min(lineSelection.start, lineSelection.end),
                    end: Math.max(lineSelection.start, lineSelection.end),
                  }
                  : undefined}
                lineNumbersConfig={{
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

                      // Mobile: tap-to-extend selection
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
                }}
              />
            </div>
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );

  const hasTree = Boolean(root && childrenByDir[root]);

  const treePanel = (
    <section className={cn(
      "flex min-h-0 flex-col overflow-hidden",
      isMobile ? "h-full w-full bg-background" : "h-full rounded-xl border border-border/60 bg-background/70"
    )}>
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
                      'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-foreground transition-colors',
                      isActive ? 'bg-interactive-selection/70' : 'hover:bg-interactive-hover/40'
                    )}
                  >
                    {getFileIcon(node.extension)}
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
          {canEdit && (
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

          {(canCopy || canCopyPath || isMarkdownFile(selectedFile.path)) && (canEdit || !isSelectedImage) && (
            <span aria-hidden="true" className="mx-1 h-4 w-px bg-border/60" />
          )}

          {isMarkdownFile(selectedFile.path) && (
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
        <ScrollableOverlay outerClassName="h-full min-w-0" className="h-full min-w-0">
          {fileLoading ? (
            <div className="p-4 flex items-center gap-2 typography-ui text-muted-foreground">
              <RiLoader4Line className="h-4 w-4 animate-spin" />
              Loading…
            </div>
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
          ) : isMarkdownFile(selectedFile.path) && getMdViewMode() === 'preview' ? (
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
                <SimpleMarkdownRenderer content={fileContent} className="typography-markdown-body" />
              </ErrorBoundary>
            </div>
          ) : (
            <div className="h-full">
              <CodeMirrorEditor
                value={draftContent}
                onChange={setDraftContent}
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
          )}
        </ScrollableOverlay>
      </div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background relative">
      {renderDialogs()}
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
