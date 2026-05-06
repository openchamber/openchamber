import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useFileSystemAccess } from '@/hooks/useFileSystemAccess';
import type { DesktopSettings } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import {
  RiArrowDownSLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiArrowUpSLine,
  RiCheckboxBlankLine,
  RiCheckboxLine,
  RiCornerDownLeftLine,
  RiFolder6Line,
  RiFolderAddLine,
  RiPushpin2Line,
  RiPushpinLine,
} from '@remixicon/react';
import { useDeviceInfo } from '@/lib/device';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { opencodeClient } from '@/lib/opencode/client';
import {
  setDirectoryShowHidden,
  useDirectoryShowHidden,
} from '@/lib/directoryShowHidden';
import { useI18n } from '@/lib/i18n';

interface DirectoryExplorerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type BrowseEntry = {
  name: string;
  path: string;
};

type BrowseRow =
  | { type: 'up'; value: 'browse:up'; name: string; path: string | null; disabled?: false }
  | { type: 'directory'; value: string; name: string; path: string; disabled: boolean };

type PinnedRow = { type: 'pinned'; value: string; name: string; path: string; alreadyAdded: boolean };

type NavigableRow = BrowseRow | PinnedRow;

const isRootPath = (value: string): boolean => value === '/';

const normalizeSeparators = (value: string): string => value.replace(/\\/g, '/');

const trimTrailingSeparators = (value: string): string => {
  if (!value || isRootPath(value)) return value;
  let result = value;
  while (result.length > 1 && result.endsWith('/')) {
    result = result.slice(0, -1);
  }
  return result;
};

const hasTrailingPathSeparator = (value: string): boolean => value.endsWith('/');

const ensureBrowseDirectoryPath = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || hasTrailingPathSeparator(trimmed)) return trimmed;
  return `${trimmed}/`;
};

const getLastPathSeparatorIndex = (value: string): number => value.lastIndexOf('/');

const getBrowseDirectoryPath = (value: string): string => {
  if (hasTrailingPathSeparator(value)) return value;
  const lastSeparator = getLastPathSeparatorIndex(value);
  if (lastSeparator < 0) return value;
  return value.slice(0, lastSeparator + 1);
};

const getBrowseLeafPathSegment = (value: string): string => {
  const lastSeparator = getLastPathSeparatorIndex(value);
  return value.slice(lastSeparator + 1);
};

const getBrowseParentPath = (value: string): string | null => {
  const trimmed = trimTrailingSeparators(value.trim());
  if (!trimmed || trimmed === '~' || trimmed === '~/' || trimmed === '/') return null;
  const lastSeparator = getLastPathSeparatorIndex(trimmed);
  if (lastSeparator < 0) return null;
  if (trimmed.startsWith('~/') && lastSeparator <= 1) return '~/';
  if (lastSeparator === 0) return '/';
  return `${trimmed.slice(0, lastSeparator)}/`;
};

const canNavigateUp = (value: string): boolean => hasTrailingPathSeparator(value) && getBrowseParentPath(value) !== null;

const appendBrowsePathSegment = (currentPath: string, segment: string): string => (
  `${getBrowseDirectoryPath(currentPath)}${segment}/`
);

const normalizeDirectoryPath = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const normalized = trimTrailingSeparators(normalizeSeparators(path.trim()));
  if (!normalized) return null;
  return normalized.toLowerCase();
};

const normalizeStoredDirectoryPath = (path: string | null | undefined): string | null => {
  if (!path) return null;
  const normalized = trimTrailingSeparators(normalizeSeparators(path.trim()));
  return normalized || null;
};

const getDirectoryName = (path: string): string => {
  const normalized = normalizeStoredDirectoryPath(path) ?? path;
  if (normalized === '/') return '/';
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
};

const arePathSetsEqual = (left: Set<string>, right: Set<string>): boolean => {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
};

const displayPathToAbsolutePath = (value: string, homeDirectory: string): string => {
  const trimmed = value.trim();
  if (trimmed === '~') return homeDirectory;
  if (trimmed.startsWith('~/')) return `${homeDirectory}${trimmed.slice(1)}`;
  return trimmed;
};

const isPrimaryModifierPressed = (event: React.KeyboardEvent<HTMLInputElement>): boolean => {
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
};

const focusPathInput = (input: HTMLInputElement | null): void => {
  if (!input) return;
  input.focus({ preventScroll: true });
  const valueLength = input.value.length;
  input.setSelectionRange(valueLength, valueLength);
  input.scrollLeft = input.scrollWidth;
};

const resolveFreshFilesystemHome = async (): Promise<string | null> => {
  try {
    const response = await fetch('/api/fs/home', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (response.ok) {
      const data = await response.json() as { home?: unknown };
      if (typeof data.home === 'string' && data.home.trim().length > 0) {
        return normalizeSeparators(data.home.trim());
      }
    }
  } catch {
    // Fall back to the client helper below.
  }

  return opencodeClient.getFilesystemHome().catch(() => null);
};

export const DirectoryExplorerDialog: React.FC<DirectoryExplorerDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const homeDirectory = useDirectoryStore((s) => s.homeDirectory);
  const projects = useProjectsStore((s) => s.projects);
  const addProject = useProjectsStore((s) => s.addProject);
  const showHidden = useDirectoryShowHidden();
  const { isDesktop, requestAccess, startAccessing } = useFileSystemAccess();
  const { isMobile } = useDeviceInfo();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const addButtonRef = React.useRef<HTMLButtonElement>(null);
  const rowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const [dialogHomeDirectory, setDialogHomeDirectory] = React.useState('');
  const [query, setQuery] = React.useState('~/');
  const [entries, setEntries] = React.useState<BrowseEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isBrowseDirectoryMissing, setIsBrowseDirectoryMissing] = React.useState(false);
  const [highlightedIndex, setHighlightedIndex] = React.useState(0);
  const [isConfirming, setIsConfirming] = React.useState(false);
  const [isOpeningFinder, setIsOpeningFinder] = React.useState(false);
  const [addButtonWidth, setAddButtonWidth] = React.useState(0);
  const [pinnedPaths, setPinnedPaths] = React.useState<Set<string>>(new Set());
  const [isPinnedSectionExpanded, setIsPinnedSectionExpanded] = React.useState(true);
  const hasMountedPinnedPersistence = React.useRef(false);
  const suppressNextPinnedPersistence = React.useRef(false);

  const explorerRootDirectory = dialogHomeDirectory || homeDirectory;

  const addedProjectPaths = React.useMemo(() => new Set(
    projects
      .map((project) => normalizeDirectoryPath(project.path))
      .filter((path): path is string => Boolean(path))
  ), [projects]);

  const absolutePathToDisplayPath = React.useCallback((path: string): string => {
    const normalizedPath = normalizeStoredDirectoryPath(path) ?? path;
    const normalizedRoot = normalizeStoredDirectoryPath(explorerRootDirectory);
    if (!normalizedRoot) return normalizedPath;

    const normalizedPathKey = normalizeDirectoryPath(normalizedPath);
    const normalizedRootKey = normalizeDirectoryPath(normalizedRoot);
    if (!normalizedPathKey || !normalizedRootKey) return normalizedPath;
    if (normalizedPathKey === normalizedRootKey) return '~';
    if (normalizedPathKey.startsWith(`${normalizedRootKey}/`)) {
      return `~/${normalizedPath.slice(normalizedRoot.length + 1)}`;
    }
    return normalizedPath;
  }, [explorerRootDirectory]);

  const pinnedDirectories = React.useMemo(() => (
    Array.from(pinnedPaths)
      .map((path) => normalizeStoredDirectoryPath(path))
      .filter((path): path is string => Boolean(path))
      .map((path) => ({ name: getDirectoryName(path), path }))
      .sort((left, right) => left.name.localeCompare(right.name))
  ), [pinnedPaths]);

  const isPathPinned = React.useCallback((path: string): boolean => {
    const normalized = normalizeStoredDirectoryPath(path);
    return Boolean(normalized && pinnedPaths.has(normalized));
  }, [pinnedPaths]);

  const applyPinnedDirectories = React.useCallback((paths: unknown) => {
    if (!Array.isArray(paths)) return;
    const normalized = paths
      .map((path) => (typeof path === 'string' ? normalizeStoredDirectoryPath(path) : null))
      .filter((path): path is string => Boolean(path));
    const nextPaths = new Set(normalized);
    setPinnedPaths((previous) => {
      if (arePathSetsEqual(previous, nextPaths)) return previous;
      suppressNextPinnedPersistence.current = true;
      return nextPaths;
    });
  }, []);

  React.useEffect(() => {
    let cancelled = false;

    try {
      const raw = localStorage.getItem('pinnedDirectories');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (!cancelled) applyPinnedDirectories(parsed);
      }
    } catch (error) {
      console.warn('Failed to load pinned directories from local storage:', error);
    }

    const loadPinnedDirectories = async () => {
      try {
        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) applyPinnedDirectories(data?.pinnedDirectories);
      } catch (error) {
        console.warn('Failed to load pinned directories:', error);
      }
    };

    const handleSettingsSynced = (event: Event) => {
      const detail = (event as CustomEvent<DesktopSettings>).detail;
      applyPinnedDirectories(detail?.pinnedDirectories);
    };

    window.addEventListener('openchamber:settings-synced', handleSettingsSynced);
    void loadPinnedDirectories();

    return () => {
      cancelled = true;
      window.removeEventListener('openchamber:settings-synced', handleSettingsSynced);
    };
  }, [applyPinnedDirectories]);

  React.useEffect(() => {
    if (!hasMountedPinnedPersistence.current) {
      hasMountedPinnedPersistence.current = true;
      return;
    }
    if (suppressNextPinnedPersistence.current) {
      suppressNextPinnedPersistence.current = false;
      return;
    }
    void updateDesktopSettings({ pinnedDirectories: Array.from(pinnedPaths) });
  }, [pinnedPaths]);

  React.useEffect(() => {
    if (!open) return;
    setQuery('~/');
    setEntries([]);
    setHighlightedIndex(0);
    setIsConfirming(false);
    setIsOpeningFinder(false);
    requestAnimationFrame(() => focusPathInput(inputRef.current));

    let cancelled = false;
    const resolveHome = async () => {
      const resolved = await resolveFreshFilesystemHome();
      if (cancelled) return;
      setDialogHomeDirectory(resolved || homeDirectory || '');
      requestAnimationFrame(() => focusPathInput(inputRef.current));
    };
    void resolveHome();
    return () => {
      cancelled = true;
    };
  }, [homeDirectory, open]);

  const browseDirectoryDisplayPath = React.useMemo(() => getBrowseDirectoryPath(query), [query]);
  const browseFilterQuery = React.useMemo(
    () => (hasTrailingPathSeparator(query) ? '' : getBrowseLeafPathSegment(query)),
    [query]
  );
  const browseDirectoryAbsolutePath = React.useMemo(
    () => explorerRootDirectory ? displayPathToAbsolutePath(browseDirectoryDisplayPath, explorerRootDirectory) : '',
    [browseDirectoryDisplayPath, explorerRootDirectory]
  );

  React.useEffect(() => {
    if (!open || !browseDirectoryAbsolutePath) {
      setEntries([]);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setIsBrowseDirectoryMissing(false);
    opencodeClient.listLocalDirectory(browseDirectoryAbsolutePath)
      .then((result) => {
        if (cancelled) return;
        setIsBrowseDirectoryMissing(false);
        const nextEntries = result
          .filter((entry) => entry.isDirectory)
          .map((entry) => ({
            name: entry.name,
            path: normalizeSeparators(entry.path),
          }))
          .sort((left, right) => left.name.localeCompare(right.name));
        setEntries(nextEntries);
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setIsBrowseDirectoryMissing(true);
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [browseDirectoryAbsolutePath, open]);

  const togglePin = React.useCallback((path: string) => {
    const normalizedPath = normalizeStoredDirectoryPath(path);
    if (!normalizedPath) return;
    setPinnedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(normalizedPath)) {
        next.delete(normalizedPath);
      } else {
        next.add(normalizedPath);
      }
      return next;
    });
  }, []);

  const filteredEntries = React.useMemo(() => {
    const lowerFilter = browseFilterQuery.toLowerCase();
    const includeHidden = showHidden || browseFilterQuery.startsWith('.');
    return entries.filter((entry) => (
      entry.name.toLowerCase().startsWith(lowerFilter) && (includeHidden || !entry.name.startsWith('.'))
    ));
  }, [browseFilterQuery, entries, showHidden]);

  const rows = React.useMemo<BrowseRow[]>(() => {
    const nextRows: BrowseRow[] = [];
    if (canNavigateUp(query)) {
      nextRows.push({ type: 'up', value: 'browse:up', name: '..', path: getBrowseParentPath(query) });
    }
    for (const entry of filteredEntries) {
      const normalized = normalizeDirectoryPath(entry.path);
      nextRows.push({
        type: 'directory',
        value: `browse:${entry.path}`,
        name: entry.name,
        path: entry.path,
        disabled: Boolean(normalized && addedProjectPaths.has(normalized)),
      });
    }
    return nextRows;
  }, [addedProjectPaths, filteredEntries, query]);

  const navigableRows = React.useMemo<NavigableRow[]>(() => {
    const pinnedRows = isPinnedSectionExpanded
      ? pinnedDirectories.map((entry) => {
        const normalized = normalizeDirectoryPath(entry.path);
        return {
          type: 'pinned' as const,
          value: `pinned:${entry.path}`,
          name: entry.name,
          path: entry.path,
          alreadyAdded: Boolean(normalized && addedProjectPaths.has(normalized)),
        };
      })
      : [];
    return [...pinnedRows, ...rows];
  }, [addedProjectPaths, isPinnedSectionExpanded, pinnedDirectories, rows]);

  const rowIndexByValue = React.useMemo(() => {
    const indexes = new Map<string, number>();
    navigableRows.forEach((row, index) => indexes.set(row.value, index));
    return indexes;
  }, [navigableRows]);

  React.useEffect(() => {
    setHighlightedIndex(0);
  }, [query, navigableRows.length]);

  const targetPath = React.useMemo(() => {
    if (!explorerRootDirectory) return '';
    return trimTrailingSeparators(displayPathToAbsolutePath(query, explorerRootDirectory));
  }, [explorerRootDirectory, query]);
  const normalizedTargetPath = normalizeDirectoryPath(targetPath);
  const isAlreadyAdded = Boolean(normalizedTargetPath && addedProjectPaths.has(normalizedTargetPath));
  const exactEntry = React.useMemo(() => {
    if (!browseFilterQuery) return null;
    return filteredEntries.find((entry) => entry.name === browseFilterQuery) ?? null;
  }, [browseFilterQuery, filteredEntries]);
  const shouldCreateTarget = Boolean(
    targetPath
    && !isAlreadyAdded
    && (
      (hasTrailingPathSeparator(query) && isBrowseDirectoryMissing)
      || (!hasTrailingPathSeparator(query) && browseFilterQuery.trim().length > 0 && exactEntry === null)
    )
  );
  const canAddProject = !isConfirming && !isOpeningFinder && !isAlreadyAdded && Boolean(targetPath);
  const highlightedRow = navigableRows[highlightedIndex] ?? null;
  const hasHighlightedBrowseItem = Boolean(
    highlightedRow && (
      highlightedRow.type === 'up'
      || highlightedRow.type === 'pinned'
      || (highlightedRow.type === 'directory' && !highlightedRow.disabled)
    )
  );
  const submitModifierLabel = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
    ? '⌘'
    : 'Ctrl';
  const submitActionLabel = isAlreadyAdded
    ? t('directoryExplorerDialog.actions.alreadyAdded')
    : shouldCreateTarget
      ? t('directoryExplorerDialog.actions.createAndAdd')
      : t('directoryExplorerDialog.actions.addProject');

  React.useLayoutEffect(() => {
    const button = addButtonRef.current;
    if (!button) return;

    const updateWidth = () => setAddButtonWidth(Math.ceil(button.getBoundingClientRect().width));
    updateWidth();

    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(button);
    return () => observer.disconnect();
  }, [submitActionLabel]);

  React.useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.scrollLeft = input.scrollWidth;
  }, [addButtonWidth, query]);

  React.useLayoutEffect(() => {
    if (!open) return;
    focusPathInput(inputRef.current);
  }, [open]);

  React.useLayoutEffect(() => {
    const row = navigableRows[highlightedIndex];
    if (!row) return;
    rowRefs.current.get(row.value)?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, navigableRows]);

  const handleClose = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const finalizeSelection = React.useCallback(async (target: string) => {
    if (!target || isConfirming) return;
    const normalized = normalizeDirectoryPath(target);
    if (normalized && addedProjectPaths.has(normalized)) return;

    setIsConfirming(true);
    try {
      const shouldCreateSelection = shouldCreateTarget && normalizeDirectoryPath(target) === normalizeDirectoryPath(targetPath);
      if (shouldCreateSelection) {
        await opencodeClient.createDirectory(target, { allowOutsideWorkspace: true });
      }
      const added = addProject(target);
      if (!added) {
        toast.error(t('directoryExplorerDialog.toast.failedToAddProject'), {
          description: t('directoryExplorerDialog.toast.selectValidDirectoryPath'),
        });
        return;
      }
      handleClose();
    } catch (error) {
      toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
        description: error instanceof Error ? error.message : t('directoryExplorerDialog.toast.unknownError'),
      });
    } finally {
      setIsConfirming(false);
    }
  }, [addProject, addedProjectPaths, handleClose, isConfirming, shouldCreateTarget, targetPath, t]);

  const browseToDisplayPath = React.useCallback((displayPath: string) => {
    setQuery(ensureBrowseDirectoryPath(displayPath));
  }, []);

  const browseToAbsolutePath = React.useCallback((path: string) => {
    browseToDisplayPath(absolutePathToDisplayPath(path));
  }, [absolutePathToDisplayPath, browseToDisplayPath]);

  const browseToEntry = React.useCallback((entry: BrowseEntry) => {
    setQuery(appendBrowsePathSegment(query, entry.name));
  }, [query]);

  const executeRow = React.useCallback((row: NavigableRow | null) => {
    if (!row) return;
    if (row.type === 'pinned') {
      browseToAbsolutePath(row.path);
      return;
    }
    if (row.type === 'up') {
      if (row.path) browseToDisplayPath(row.path);
      return;
    }
    if (row.disabled) return;
    browseToEntry(row);
  }, [browseToAbsolutePath, browseToDisplayPath, browseToEntry]);

  const handleOpenInFinder = React.useCallback(async () => {
    if (!isDesktop || isOpeningFinder) return;
    setIsOpeningFinder(true);
    try {
      const result = await requestAccess(targetPath);
      if (!result.success || !result.path) {
        if (result.error && result.error !== 'Directory selection cancelled') {
          toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
            description: result.error,
          });
        }
        return;
      }

      const accessResult = await startAccessing(result.path);
      if (!accessResult.success) {
        toast.error(t('directoryExplorerDialog.toast.failedToOpenDirectory'), {
          description: accessResult.error || t('directoryExplorerDialog.toast.desktopCouldNotGrantAccess'),
        });
        return;
      }

      await finalizeSelection(result.path);
    } catch (error) {
      toast.error(t('directoryExplorerDialog.toast.failedToSelectDirectory'), {
        description: error instanceof Error ? error.message : t('directoryExplorerDialog.toast.unknownError'),
      });
    } finally {
      setIsOpeningFinder(false);
    }
  }, [finalizeSelection, isDesktop, isOpeningFinder, requestAccess, startAccessing, t, targetPath]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(Math.max(0, navigableRows.length - 1), index + 1));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (isPrimaryModifierPressed(event)) {
        void finalizeSelection(targetPath);
        return;
      }
      if (hasHighlightedBrowseItem) {
        executeRow(highlightedRow);
      }
      return;
    }
    if (event.key === 'Backspace' && query === '') {
      event.preventDefault();
      handleClose();
    }
  }, [executeRow, finalizeSelection, handleClose, hasHighlightedBrowseItem, highlightedRow, navigableRows.length, query, targetPath]);

  const showHiddenToggle = (
    <button
      type="button"
      onClick={() => setDirectoryShowHidden(!showHidden)}
      className="flex flex-shrink-0 items-center gap-2 rounded-lg px-2 py-1 typography-meta text-muted-foreground transition-colors hover:bg-interactive-hover/40"
    >
      {showHidden ? <RiCheckboxLine className="h-4 w-4 text-primary" /> : <RiCheckboxBlankLine className="h-4 w-4" />}
      {t('directoryExplorerDialog.toggle.showHidden')}
    </button>
  );

  const inputSection = (
    <div className="relative px-2.5 py-1.5">
      <RiFolderAddLine className="pointer-events-none absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/80" />
      <Input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(normalizeSeparators(event.target.value))}
        onKeyDown={handleKeyDown}
        placeholder={t('directoryExplorerDialog.pathInput.placeholder')}
        className="border-transparent bg-transparent pl-9 font-mono typography-ui-label shadow-none focus-visible:ring-0"
        style={!isMobile && addButtonWidth > 0 ? { paddingRight: `${addButtonWidth + 24}px` } : undefined}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
      {!isMobile ? (
        <Button
          ref={addButtonRef}
          variant="outline"
          size="xs"
          tabIndex={-1}
          className="absolute right-4 top-1/2 h-7 -translate-y-1/2 gap-1 px-2 typography-meta"
          disabled={!canAddProject}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void finalizeSelection(targetPath)}
          title={submitActionLabel}
        >
          {submitActionLabel}
        </Button>
      ) : null}
    </div>
  );

  const renderPinButton = (path: string) => {
    const isPinned = isPathPinned(path);
    return (
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          togglePin(path);
        }}
        className={cn(
          'rounded-lg p-1 text-muted-foreground transition-opacity hover:bg-interactive-hover/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          isMobile || isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
        title={isPinned ? t('directoryTree.actions.unpinDirectory') : t('directoryTree.actions.pinDirectory')}
        aria-label={isPinned ? t('directoryTree.actions.unpinDirectory') : t('directoryTree.actions.pinDirectory')}
      >
        {isPinned ? <RiPushpin2Line className="h-4 w-4 text-primary" /> : <RiPushpinLine className="h-4 w-4" />}
      </button>
    );
  };

  const renderPinnedDirectory = (entry: BrowseEntry): React.ReactNode => {
    const normalizedPath = normalizeStoredDirectoryPath(entry.path);
    if (!normalizedPath) return null;

    const value = `pinned:${normalizedPath}`;
    const normalized = normalizeDirectoryPath(normalizedPath);
    const rowIndex = rowIndexByValue.get(value);
    const isActive = rowIndex === highlightedIndex;
    const isSelected = Boolean(normalizedTargetPath && normalized === normalizedTargetPath);
    const isAlreadyProject = Boolean(normalized && addedProjectPaths.has(normalized));
    const displayPath = absolutePathToDisplayPath(normalizedPath);

    return (
      <div
        key={normalizedPath}
        ref={(node) => {
          if (node) {
            rowRefs.current.set(value, node);
          } else {
            rowRefs.current.delete(value);
          }
        }}
        onMouseEnter={() => {
          if (typeof rowIndex === 'number') setHighlightedIndex(rowIndex);
        }}
        className={cn(
          'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
          (isActive || isSelected) ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover/50'
        )}
      >
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => browseToAbsolutePath(normalizedPath)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <RiFolder6Line className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
          <span className="min-w-0 flex-1">
            <span className="block truncate typography-ui-label text-foreground">{entry.name}</span>
            <span className="block truncate typography-micro text-muted-foreground">{displayPath}</span>
          </span>
        </button>
        {isAlreadyProject ? (
          <span className="rounded-full border border-border/60 px-2 py-0.5 typography-meta text-muted-foreground">
            {t('directoryExplorerDialog.browse.addedBadge')}
          </span>
        ) : null}
        {renderPinButton(normalizedPath)}
      </div>
    );
  };

  const resultsSection = (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border/60 bg-[var(--surface-elevated)] shadow-sm">
      <div className="max-h-[min(28rem,58vh)] overflow-y-auto p-2">
        {pinnedDirectories.length > 0 ? (
          <div className="mb-2">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setIsPinnedSectionExpanded((previous) => !previous)}
              className="mb-1 flex w-full items-center gap-1.5 rounded-lg px-2 pb-1 pt-0.5 text-left typography-meta font-medium uppercase tracking-wide text-muted-foreground/80 transition-colors hover:bg-interactive-hover/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {isPinnedSectionExpanded ? <RiArrowDownSLine className="h-3.5 w-3.5" /> : <RiArrowRightSLine className="h-3.5 w-3.5" />}
              <span>{t('directoryTree.section.pinned')}</span>
              <span className="ml-auto typography-micro normal-case tracking-normal text-muted-foreground/60">
                {pinnedDirectories.length}
              </span>
            </button>
            {isPinnedSectionExpanded ? (
              <div className="space-y-0.5">
                {pinnedDirectories.map((entry) => renderPinnedDirectory(entry))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="px-2 pb-1 pt-0.5 typography-meta font-medium uppercase tracking-wide text-muted-foreground/80">
          {t('directoryExplorerDialog.browse.directories')}
        </div>
        {isLoading ? (
          <div className="py-10 text-center typography-ui-label text-muted-foreground">
            {t('directoryExplorerDialog.browse.loading')}
          </div>
        ) : rows.length === 0 ? (
          <div className="py-10 text-center typography-ui-label text-muted-foreground">
            {t('directoryExplorerDialog.browse.empty')}
          </div>
        ) : (
          <div className="space-y-0.5">
            {rows.map((row) => {
              const rowIndex = rowIndexByValue.get(row.value);
              const isActive = rowIndex === highlightedIndex;
              return (
                <div
                  key={row.value}
                  ref={(node) => {
                    if (node) {
                      rowRefs.current.set(row.value, node);
                    } else {
                      rowRefs.current.delete(row.value);
                    }
                  }}
                  onMouseEnter={() => {
                    if (typeof rowIndex === 'number') setHighlightedIndex(rowIndex);
                  }}
                  className={cn(
                    'group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors',
                    isActive && 'bg-interactive-selection text-interactive-selection-foreground',
                    !isActive && 'hover:bg-interactive-hover/50',
                    row.type === 'directory' && row.disabled && 'opacity-70 hover:bg-transparent'
                  )}
                >
                  <button
                    type="button"
                    disabled={row.type === 'directory' && row.disabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => executeRow(row)}
                    className={cn(
                      'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                      row.type === 'directory' && row.disabled && 'cursor-not-allowed opacity-60'
                    )}
                  >
                    {row.type === 'up' ? (
                      <RiArrowLeftSLine className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                    ) : (
                      <RiFolder6Line className="h-4 w-4 flex-shrink-0 text-muted-foreground/80" />
                    )}
                    <span className="flex min-w-0 flex-1 items-center gap-1.5">
                      <span className="truncate typography-ui-label text-foreground">{row.name}</span>
                    </span>
                  </button>
                  {row.type === 'directory' && row.disabled ? (
                    <span className="rounded-full border border-border/60 px-2 py-0.5 typography-meta text-muted-foreground">
                      {t('directoryExplorerDialog.browse.addedBadge')}
                    </span>
                  ) : null}
                  {row.type === 'directory' ? renderPinButton(row.path) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  const content = (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {inputSection}
      {resultsSection}
    </div>
  );

  const footerHints = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 typography-micro text-muted-foreground">
      <span className="inline-flex items-center gap-1">
        <RiArrowUpSLine className="h-3.5 w-3.5" />
        <RiArrowDownSLine className="-ml-1 h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.navigate')}
      </span>
      <span className="inline-flex items-center gap-1">
        <RiCornerDownLeftLine className="h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.select')}
      </span>
      <span className="inline-flex items-center gap-1">
        <span>{submitModifierLabel}</span>
        <RiCornerDownLeftLine className="h-3.5 w-3.5" />
        {t('directoryExplorerDialog.footer.add')}
      </span>
      <span className="inline-flex items-center gap-1">
        <span>Esc</span>
        {t('directoryExplorerDialog.footer.close')}
      </span>
    </div>
  );

  const renderFooter = () => (
    <>
      {!isMobile ? footerHints : null}
      <div className={cn('flex w-full flex-row justify-end gap-2 sm:w-auto', isMobile && 'justify-stretch')}>
        {isDesktop ? (
          <Button variant="ghost" size="xs" onClick={handleOpenInFinder} disabled={isConfirming || isOpeningFinder}>
            {isOpeningFinder ? t('directoryExplorerDialog.actions.openingFinder') : t('directoryExplorerDialog.actions.openInFinder')}
          </Button>
        ) : null}
        <Button variant="ghost" size="xs" onClick={handleClose} disabled={isConfirming || isOpeningFinder} className={cn(isMobile && 'flex-1')}>
          {t('directoryExplorerDialog.actions.cancel')}
        </Button>
        {isMobile ? (
          <Button size="xs" onClick={() => void finalizeSelection(targetPath)} disabled={!canAddProject} className="flex-1">
            {submitActionLabel}
          </Button>
        ) : null}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        onClose={handleClose}
        title={t('directoryExplorerDialog.title')}
        className="h-[88dvh] max-h-[720px] max-w-full"
        contentMaxHeightClassName="flex-1"
        footer={<div className="flex flex-col gap-2">{renderFooter()}</div>}
      >
        <div className="flex h-full min-h-0 flex-col gap-3">
          <div className="flex justify-end">{showHiddenToggle}</div>
          {content}
        </div>
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex w-full max-w-xl flex-col gap-0 overflow-hidden p-0 sm:max-h-[80vh]"
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogHeader className="px-5 pb-2 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <DialogTitle>{t('directoryExplorerDialog.title')}</DialogTitle>
              <DialogDescription className="mt-2">{t('directoryExplorerDialog.description')}</DialogDescription>
            </div>
            {showHiddenToggle}
          </div>
        </DialogHeader>
        <div className="min-h-0 flex-1 px-2 pb-0">{content}</div>
        <DialogFooter className="flex w-full flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
          {renderFooter()}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
