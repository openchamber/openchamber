import React from 'react';
import {
  RiCloseLine,
  RiCodeLine,
  RiDeleteBinLine,
  RiEditLine,
  RiFileAddLine,
  RiFileCopyLine,
  RiFileImageLine,
  RiFileTextLine,
  RiFolder3Fill,
  RiFolderAddLine,
  RiFolderOpenFill,
  RiFolderReceivedLine,
  RiLoader4Line,
  RiMore2Fill,
  RiRefreshLine,
  RiSearchLine,
} from '@remixicon/react';

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
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
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
import { cn } from '@/lib/utils';
import { opencodeClient } from '@/lib/opencode/client';

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

const isAbsolutePath = (value: string): boolean => {
  return value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value);
};

const DEFAULT_IGNORED_DIR_NAMES = new Set(['node_modules']);

const shouldIgnoreEntryName = (name: string): boolean => DEFAULT_IGNORED_DIR_NAMES.has(name);

const shouldIgnorePath = (path: string): boolean => {
  const normalized = normalizePath(path);
  return normalized === 'node_modules' || normalized.endsWith('/node_modules') || normalized.includes('/node_modules/');
};

// --- File icons (matching FilesView) ---

const CODE_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'styl', 'stylus',
  'vue', 'svelte', 'astro',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
  'py', 'pyw', 'pyx', 'pxd', 'pxi',
  'rb', 'erb', 'rake', 'gemspec',
  'php', 'phtml', 'php3', 'php4', 'php5', 'phps',
  'java', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gradle',
  'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hxx', 'hh', 'm', 'mm',
  'cs', 'fs', 'fsx', 'fsi',
  'go', 'rs', 'swift', 'dart', 'lua',
  'pl', 'pm', 'pod', 'r', 'R', 'rmd', 'jl',
  'hs', 'lhs', 'ex', 'exs', 'erl', 'hrl',
  'clj', 'cljs', 'cljc', 'edn',
  'lisp', 'cl', 'el', 'scm', 'ss', 'rkt',
  'ml', 'mli', 're', 'rei', 'nim', 'zig', 'v', 'cr',
  'sql', 'psql', 'plsql', 'graphql', 'gql', 'sol',
  'asm', 's', 'S', 'mk', 'nix', 'tf', 'tfvars', 'pp', 'ansible',
]);

const DATA_EXTENSIONS = new Set([
  'json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'geojson',
  'yaml', 'yml', 'toml',
  'xml', 'xsl', 'xslt', 'xsd', 'dtd', 'plist',
  'ini', 'cfg', 'conf', 'config', 'env', 'properties',
  'csv', 'tsv', 'lock',
]);

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'icns',
  'bmp', 'tiff', 'tif', 'psd', 'ai', 'eps', 'raw', 'cr2', 'nef',
  'heic', 'heif', 'avif', 'jxl',
]);

const DOCUMENT_EXTENSIONS = new Set([
  'md', 'mdx', 'markdown', 'mdown', 'mkd',
  'txt', 'text', 'rtf', 'doc', 'docx', 'odt', 'pdf',
  'rst', 'adoc', 'asciidoc', 'org', 'tex', 'latex', 'bib',
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
    if (!canRename && !canCreateFile && !canCreateFolder && !canDelete && !canReveal) return;
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
      onContextMenu={handleContextMenu}
    >
      <button
        type="button"
        onClick={handleInteraction}
        onContextMenu={handleContextMenu}
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

// --- Main component ---

export const SidebarFilesTree: React.FC = () => {
  const { files, runtime } = useRuntimeAPIs();
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
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const inFlightDirsRef = React.useRef<Set<string>>(new Set());

  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const openPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.openPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const addOpenPath = useFilesViewTabsStore((state) => state.addOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);

  // Context menu state
  const [contextMenuPath, setContextMenuPath] = React.useState<string | null>(null);

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

  // --- Fuzzy search scoring (matching FilesView) ---

  const fuzzyScore = React.useCallback((query: string, candidate: string): number | null => {
    const q = query.trim().toLowerCase();
    if (!q) return 0;

    const c = candidate.toLowerCase();
    let score = 0;
    let lastIndex = -1;
    let consecutive = 0;

    for (let i = 0; i < q.length; i += 1) {
      const ch = q[i];
      if (!ch || ch === ' ') continue;

      const idx = c.indexOf(ch, lastIndex + 1);
      if (idx === -1) return null;

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
        if (cancelled) return;

        const filtered = hits.filter((hit) => showGitignored || !shouldIgnorePath(hit.path));

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

  // --- Git status helpers (matching FilesView) ---

  const getFileStatus = React.useCallback((path: string): FileStatus | null => {
    if (openPaths.includes(path)) return 'open';

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

  // --- File operations ---

  const handleOpenFile = React.useCallback((node: FileNode) => {
    if (!root) return;

    setSelectedPath(root, node.path);
    addOpenPath(root, node.path);
    openContextFile(root, node.path);
  }, [addOpenPath, openContextFile, root, setSelectedPath]);

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
    try {
      if (activeDialog === 'createFile') {
        if (!dialogInputValue.trim()) throw new Error('Filename is required');
        const parentPath = dialogData.path;
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
            if (selectedPath === oldPath || (selectedPath && selectedPath.startsWith(`${oldPath}/`))) {
              setSelectedPath(root, null);
            }
          }
        } else {
          toast.error('Rename not supported');
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
            if (selectedPath === dialogData.path || (selectedPath && selectedPath.startsWith(dialogData.path + '/'))) {
              setSelectedPath(root, null);
            }
          }
        } else {
          toast.error('Delete not supported');
        }
      }
      setActiveDialog(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Operation failed');
    } finally {
      setIsDialogSubmitting(false);
    }
  }, [activeDialog, dialogData, dialogInputValue, files, refreshRoot, removeOpenPathsByPrefix, root, selectedPath, setSelectedPath]);

  // --- Tree rendering (matching FilesView with indent guides) ---

  const renderTree = React.useCallback((dirPath: string, depth: number): React.ReactNode => {
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
                <span className="absolute top-3.5 bottom-0 left-[-13px] w-[2px] bg-background" />
              )}
            </>
          )}
          <FileRow
            node={node}
            isExpanded={isExpanded}
            isActive={isActive}
            status={!isDir ? getFileStatus(node.path) : undefined}
            badge={isDir ? getFolderBadge(node.path) : undefined}
            permissions={{ canRename, canCreateFile, canCreateFolder, canDelete, canReveal }}
            contextMenuPath={contextMenuPath}
            setContextMenuPath={setContextMenuPath}
            onSelect={handleOpenFile}
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
  }, [childrenByDir, expandedPaths, handleOpenFile, selectedPath, toggleDirectory, handleOpenDialog, canCreateFile, canCreateFolder, canRename, canDelete, contextMenuPath, getFileStatus, getFolderBadge]);

  const hasTree = Boolean(root && childrenByDir[root]);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
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
        <ul className="flex flex-col">
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
                    {getFileIcon(node.extension)}
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
      </ScrollableOverlay>

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
    </section>
  );
};
