import React from 'react';
import {
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiFolder3Fill,
  RiFolderOpenFill,
  RiLoader4Line,
  RiRefreshLine,
  RiSearchLine,
} from '@remixicon/react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { Input } from '@/components/ui/input';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useI18n } from '@/lib/i18n';
import type { FileListEntry, FileSearchResult } from '@/lib/api/types';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

// The full desktop file editor, loaded on demand — it's a heavy chunk and only
// needed once a file is actually opened.
const LazyFilesEditor = React.lazy(() =>
  import('@/components/views/FilesView').then((module) => ({ default: module.FilesView })),
);

type MobileFilesRoute =
  | { type: 'browser'; directory: string }
  | { type: 'file'; path: string; returnDirectory: string };

const normalizePath = (value?: string | null): string => (value || '').replace(/\\/g, '/').replace(/\/+$/g, '');

const getNameFromPath = (path: string): string => {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') return normalized || '/';
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
};

const getParentDirectory = (path: string): string | null => {
  const normalized = normalizePath(path);
  if (!normalized || normalized === '/') return null;
  const index = normalized.lastIndexOf('/');
  if (index <= 0) return normalized.startsWith('/') ? '/' : null;
  return normalized.slice(0, index);
};

const getRelativePath = (path: string, root: string): string => {
  const normalizedPath = normalizePath(path);
  const normalizedRoot = normalizePath(root);
  if (!normalizedRoot || normalizedPath === normalizedRoot) return getNameFromPath(normalizedPath);
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) return normalizedPath.slice(normalizedRoot.length + 1);
  return normalizedPath;
};

const formatFileSize = (size?: number): string => {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024 || unit === units[units.length - 1]) return `${value.toFixed(value >= 10 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return '';
};

type MobileFilesSurfaceProps = {
  /** When provided, the header gets a close X that calls this. */
  onClose?: () => void;
};

export const MobileFilesSurface: React.FC<MobileFilesSurfaceProps> = ({ onClose }) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const root = normalizePath(useEffectiveDirectory() ?? null);
  const [route, setRoute] = React.useState<MobileFilesRoute>(() => ({ type: 'browser', directory: root }));
  const [entries, setEntries] = React.useState<FileListEntry[]>([]);
  const [isLoadingDirectory, setIsLoadingDirectory] = React.useState(false);
  const [directoryError, setDirectoryError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<FileSearchResult[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const directoryLoadRequestIdRef = React.useRef(0);

  React.useEffect(() => {
    if (!root) return;
    setRoute((current) => {
      if (current.type === 'browser' && current.directory) return current;
      return { type: 'browser', directory: root };
    });
  }, [root]);

  const currentDirectory = route.type === 'browser' ? route.directory : route.returnDirectory;

  const loadDirectory = React.useCallback(async (directory: string) => {
    if (!directory) return;
    const requestId = directoryLoadRequestIdRef.current + 1;
    directoryLoadRequestIdRef.current = requestId;
    setIsLoadingDirectory(true);
    setDirectoryError(null);
    try {
      const result = await files.listDirectory(directory);
      if (directoryLoadRequestIdRef.current !== requestId) return;
      setEntries(result.entries.slice().sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
    } catch (error) {
      if (directoryLoadRequestIdRef.current !== requestId) return;
      setEntries([]);
      setDirectoryError(error instanceof Error ? error.message : t('mobile.files.error.listFailed'));
    } finally {
      if (directoryLoadRequestIdRef.current === requestId) {
        setIsLoadingDirectory(false);
      }
    }
  }, [files, t]);

  React.useEffect(() => {
    if (route.type !== 'browser') return;
    void loadDirectory(route.directory);
  }, [loadDirectory, route]);

  React.useEffect(() => {
    if (route.type !== 'browser') return;
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      setSearchResults([]);
      setIsSearching(false);
      return;
    }

    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      setIsSearching(true);
      void files.search({ directory: route.directory, query: normalizedQuery, maxResults: 40 })
        .then((results) => {
          if (!cancelled) setSearchResults(results);
        })
        .catch(() => {
          if (!cancelled) setSearchResults([]);
        })
        .finally(() => {
          if (!cancelled) setIsSearching(false);
        });
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [files, query, route]);

  const openDirectory = (directory: string) => {
    setQuery('');
    setRoute({ type: 'browser', directory });
  };

  const openFile = (path: string) => {
    // FilesView (editor-only) reads its target from the files-view tabs store.
    setSelectedPath(root, path);
    setRoute({ type: 'file', path, returnDirectory: currentDirectory || root });
  };

  // Chat tool rows (read/skill/edit) stage a pending file focus/navigation in
  // the UI store — the same channel desktop's context panel consumes. Route
  // straight to the editor for targets inside this workspace; the editor
  // itself consumes pendingFileNavigation to jump to the requested line.
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const pendingFileNavigation = useUIStore((state) => state.pendingFileNavigation);
  React.useEffect(() => {
    const target = normalizePath(pendingFileNavigation?.path ?? pendingFileFocusPath ?? '');
    if (!target || !root) return;
    if (target !== root && !target.startsWith(`${root}/`)) return;
    setSelectedPath(root, target);
    setRoute({ type: 'file', path: target, returnDirectory: root });
    if (pendingFileFocusPath) useUIStore.getState().setPendingFileFocusPath(null);
  }, [pendingFileFocusPath, pendingFileNavigation, root, setSelectedPath]);

  if (!root) {
    return <MobileFilesState message={t('mobile.files.empty.noDirectory')} />;
  }

  if (route.type === 'file') {
    // Full desktop file editor (toolbar, dirty/save, wrap, search, md/html
    // preview, open-file tabs) — FilesView is already mobile-aware (keyboard
    // nudge, touch menus); this host only adds the back row.
    return (
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
        <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border/70 px-3 text-foreground">
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('header.actions.backAria')}
            onClick={() => setRoute({ type: 'browser', directory: route.returnDirectory })}
            style={{ touchAction: 'manipulation' }}
          >
            <RiArrowLeftLine className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate typography-ui-header text-foreground">{getNameFromPath(route.path)}</h2>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          <ErrorBoundary>
            <React.Suspense fallback={<MobileFilesState loading message={t('filesView.state.loading')} />}>
              <LazyFilesEditor mode="editor-only" />
            </React.Suspense>
          </ErrorBoundary>
        </div>
      </div>
    );
  }

  const directoryLabel = route.directory === root ? t('mobile.files.rootDirectory') : getNameFromPath(route.directory);
  const visibleSearchResults = query.trim() ? searchResults : [];

  // Cap parent navigation at the project root: only allow stepping up while
  // the parent stays inside (or equal to) the root.
  const rawParent = getParentDirectory(route.directory);
  const parentWithinRoot =
    route.directory !== root && rawParent !== null && (rawParent === root || rawParent.startsWith(`${root}/`));
  const canGoBack = parentWithinRoot && !query.trim();
  const parentDirectory = parentWithinRoot ? rawParent : null;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3 text-foreground">
        {onClose ? (
          <button
            type="button"
            className="-ml-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.surface.closeAria')}
            onClick={onClose}
            style={{ touchAction: 'manipulation' }}
          >
            <RiCloseLine className="size-5" />
          </button>
        ) : null}
        {canGoBack && parentDirectory ? (
          <button
            type="button"
            className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            aria-label={t('mobile.files.backToParentAria', { name: getNameFromPath(parentDirectory) })}
            onClick={() => openDirectory(parentDirectory)}
            style={{ touchAction: 'manipulation' }}
          >
            <RiArrowLeftLine className="size-5" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1 px-1">
          <h2 className="truncate typography-ui-label text-foreground">{directoryLabel}</h2>
        </div>
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t('mobile.files.refreshAria')}
          onClick={() => void loadDirectory(route.directory)}
          style={{ touchAction: 'manipulation' }}
        >
          <RiRefreshLine className={cn('size-5', isLoadingDirectory && 'animate-spin')} />
        </button>
      </header>
      <div className="shrink-0 px-4 pb-2 pt-1">
        <div className="relative">
          <RiSearchLine className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('mobile.files.search.placeholder')}
            className="h-11 pl-9"
          />
        </div>
      </div>

      <ScrollShadow className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
        {directoryError ? (
          <MobileFilesState message={directoryError} />
        ) : query.trim() ? (
          <MobileSearchResults results={visibleSearchResults} isSearching={isSearching} onOpenFile={openFile} />
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border/70 bg-[var(--surface-elevated)]">
            {entries.length === 0 && !isLoadingDirectory ? (
              <div className="px-4 py-8 text-center typography-body text-muted-foreground">{t('mobile.files.empty.directory')}</div>
            ) : null}
            {entries.map((entry) => (
              <MobileFileRow
                key={entry.path}
                name={entry.name}
                path={entry.path}
                directory={entry.isDirectory}
                meta={entry.isDirectory ? undefined : formatFileSize(entry.size)}
                onClick={() => entry.isDirectory ? openDirectory(entry.path) : openFile(entry.path)}
              />
            ))}
          </div>
        )}
      </ScrollShadow>
    </div>
  );
};

const MobileFileRow: React.FC<{
  name: string;
  path: string;
  directory: boolean;
  meta?: string;
  onClick: () => void;
}> = ({ name, path, directory, meta, onClick }) => (
  <button
    type="button"
    className="flex min-h-14 w-full items-center gap-3 border-b border-border/70 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
    onClick={onClick}
    style={{ touchAction: 'manipulation' }}
  >
    {directory ? (
      <RiFolder3Fill className="size-5 shrink-0 text-primary/80" />
    ) : (
      <FileTypeIcon filePath={path} className="size-5 shrink-0" />
    )}
    <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{name}</span>
    {meta ? <span className="shrink-0 typography-micro text-muted-foreground">{meta}</span> : null}
    {directory ? <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground/60" /> : null}
  </button>
);

const MobileSearchResults: React.FC<{
  results: FileSearchResult[];
  isSearching: boolean;
  onOpenFile: (path: string) => void;
}> = ({ results, isSearching, onOpenFile }) => {
  const { t } = useI18n();
  const root = normalizePath(useEffectiveDirectory() ?? null);
  if (isSearching) return <MobileFilesState loading message={t('common.loading')} />;
  if (results.length === 0) return <MobileFilesState message={t('mobile.files.search.empty')} />;
  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-[var(--surface-elevated)]">
      {results.map((result) => (
        <MobileFileRow
          key={result.path}
          name={getNameFromPath(result.path)}
          path={result.path}
          directory={false}
          meta={getRelativePath(result.path, root)}
          onClick={() => onOpenFile(result.path)}
        />
      ))}
    </div>
  );
};


const MobileFilesState: React.FC<{ message: string; loading?: boolean }> = ({ message, loading = false }) => (
  <div className="flex h-full items-center justify-center px-6 text-center">
    <div className="flex max-w-sm flex-col items-center gap-2">
      {loading ? <RiLoader4Line className="size-5 animate-spin text-muted-foreground" /> : <RiFolderOpenFill className="size-6 text-muted-foreground" />}
      <p className="typography-ui-label font-semibold text-foreground">{message}</p>
    </div>
  </div>
);
