import React from 'react';
import {
  RiArrowLeftLine,
  RiArrowRightSLine,
  RiCloseLine,
  RiFolder3Fill,
  RiFolderOpenFill,
  RiLoader4Line,
  RiRefreshLine,
} from '@remixicon/react';

import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { MobileSheetSearch } from '@/components/ui/MobileSheetList';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { useFileTreeUpload } from '@/components/views/files/useFileTreeUpload';
import { AUTO_RELIST_MAX_ENTRIES, useFileTreeChanges, type FileTreeChangeBatch } from '@/components/views/files/useFileTreeChanges';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { SpacePreparing } from '@/components/session/spaces/SpacePreparing';
import { useI18n } from '@/lib/i18n';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import type { FileListEntry, FileSearchResult } from '@/lib/api/types';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { normalizePath as normalizePathImpl } from '@/lib/pathNormalization';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { guestActionsWhere, type GuestActionEntry } from '@/lib/guests/actions';
import { runGuestAction } from '@/lib/guests/run-action';
import { MobileRowMenu } from './mobileSidebar/MobileRowMenu';
import { MOBILE_HEADER_BUTTON_CLASS, MOBILE_HEADER_CLASS, MOBILE_HEADER_TITLE_CLASS } from '@/components/ui/mobileHeader';

// The full desktop file editor, loaded on demand — it's a heavy chunk and only
// needed once a file is actually opened.
const LazyFilesEditor = React.lazy(() =>
  import('@/components/views/FilesView').then((module) => ({ default: module.FilesView })),
);

type MobileFilesRoute =
  | { type: 'browser'; directory: string }
  | { type: 'file'; path: string; returnDirectory: string };

const normalizePath = (value: string | null | undefined): string => normalizePathImpl(value) ?? '';

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
  /** The surface is on screen; file changes wait for it. */
  visible?: boolean;
};

export const MobileFilesSurface: React.FC<MobileFilesSurfaceProps> = ({ onClose, visible = true }) => {
  // A draft waiting for a new space lists the space, and nothing of this computer's until it runs.
  const draftSpace = useDraftSpaceTarget();
  const root = normalizePath(panelContentDirectory(draftSpace, useEffectiveDirectory()));
  if (draftSpace?.kind === 'preparing') return <SpacePreparing />;
  return <MobileFilesSurfaceForRoot key={root} root={root} onClose={onClose} visible={visible} />;
};

const MobileFilesSurfaceForRoot: React.FC<MobileFilesSurfaceProps & { root: string; visible: boolean }> = ({ root, onClose, visible }) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const showGitignored = useFilesViewShowGitignored();
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const [route, setRoute] = React.useState<MobileFilesRoute>(() => ({ type: 'browser', directory: root }));
  const [entries, setEntries] = React.useState<FileListEntry[]>([]);
  const [isLoadingDirectory, setIsLoadingDirectory] = React.useState(false);
  const [directoryError, setDirectoryError] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState('');
  const [searchResults, setSearchResults] = React.useState<FileSearchResult[]>([]);
  const [isSearching, setIsSearching] = React.useState(false);
  const directoryLoadRequestIdRef = React.useRef(0);

  const currentDirectory = route.type === 'browser' ? route.directory : route.returnDirectory;
  const currentDirectoryRef = React.useRef(currentDirectory);
  currentDirectoryRef.current = currentDirectory;

  // A background reload (a file change, not a navigation) keeps the listing
  // on screen when it fails.
  const loadDirectory = React.useCallback(async (directory: string, options?: { background?: boolean }) => {
    if (!directory) return;
    const respectGitignore = !showGitignored;
    const requestId = directoryLoadRequestIdRef.current + 1;
    directoryLoadRequestIdRef.current = requestId;
    setIsLoadingDirectory(true);
    if (!options?.background) setDirectoryError(null);
    try {
      const result = await files.listDirectory(directory, { respectGitignore });
      if (directoryLoadRequestIdRef.current !== requestId) return;
      setDirectoryError(null);
      setEntries(result.entries.slice().sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      }));
    } catch (error) {
      if (directoryLoadRequestIdRef.current !== requestId) return;
      if (options?.background) {
        console.error('Failed to reload mobile directory:', error);
        return;
      }
      setEntries([]);
      setDirectoryError(error instanceof Error ? error.message : t('mobile.files.error.listFailed'));
    } finally {
      if (directoryLoadRequestIdRef.current === requestId) {
        setIsLoadingDirectory(false);
      }
    }
  }, [files, showGitignored, t]);

  React.useEffect(() => {
    if (route.type !== 'browser') return;
    void loadDirectory(route.directory);
  }, [loadDirectory, route]);

  // The folder on screen reloads when the agent changed it, also after the
  // drawer was closed meanwhile; a file being viewed reloads its folder on return.
  const routeRef = React.useRef(route);
  routeRef.current = route;
  const entriesRef = React.useRef(entries);
  entriesRef.current = entries;
  const reloadChangedDirectory = React.useCallback(({ directories }: FileTreeChangeBatch) => {
    const current = routeRef.current;
    if (current.type !== 'browser') return;
    if (directories && !directories.some((directory) => normalizePath(directory) === normalizePath(current.directory))) return;
    if (entriesRef.current.length > AUTO_RELIST_MAX_ENTRIES) return;
    void loadDirectory(current.directory, { background: true });
  }, [loadDirectory]);
  useFileTreeChanges({ root, active: visible, whileInactive: 'hold', onChanges: reloadChangedDirectory });

  // Reload the listing only when the upload landed in the folder still on screen.
  const refreshUploadedDirectory = React.useCallback(async (directory: string) => {
    if (normalizePath(directory) !== normalizePath(currentDirectoryRef.current)) return;
    await loadDirectory(currentDirectoryRef.current);
  }, [loadDirectory]);

  const { canUpload, uploadingDirectory, pickFiles, uploadElements } = useFileTreeUpload({
    root,
    refreshDirectory: refreshUploadedDirectory,
  });
  const isUploading = uploadingDirectory !== null;
  const guestActions = useGuestActions();
  const fileActions = React.useMemo<MobileFileActions>(
    () => ({ root, entries: guestActionsWhere(guestActions, 'file') }),
    [guestActions, root],
  );

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
  // straight to the editor for any requested target, inside or outside this
  // workspace: a skill or an agent output under /tmp is a real file the user
  // asked to read, and the editor reads it through allowOutsideWorkspace. The
  // browser tree itself stays rooted at `root`.
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const pendingFileNavigation = useUIStore((state) => state.pendingFileNavigation);
  React.useEffect(() => {
    const target = normalizePath(pendingFileNavigation?.path ?? pendingFileFocusPath ?? '');
    if (!target || !root) return;
    setSelectedPath(root, target, { allowOutsideRoot: true });
    // From a file already open (the image preview's arrows), Back still leads
    // to the folder the user was browsing.
    setRoute((current) => ({ type: 'file', path: target, returnDirectory: current.type === 'file' ? current.returnDirectory : root }));
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
        <header className={cn(MOBILE_HEADER_CLASS, 'border-b border-edge text-foreground')}>
          <button
            type="button"
            className={MOBILE_HEADER_BUTTON_CLASS}
            aria-label={t('header.actions.backAria')}
            onClick={() => setRoute({ type: 'browser', directory: route.returnDirectory })}
            style={{ touchAction: 'manipulation' }}
          >
            <Icon name="arrow-left" className="size-5" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className={cn('truncate', MOBILE_HEADER_TITLE_CLASS)}>{getNameFromPath(route.path)}</h2>
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
      {uploadElements}
      {/* The tab above already names the surface, so the first row is the search
          and the folder's actions; a subfolder adds only the way back. */}
      <div className="shrink-0 px-2 pt-1">
        <MobileSheetSearch
          value={query}
          onChange={setQuery}
          placeholder={t('mobile.files.search.placeholder')}
          actions={(
            <>
              <button
                type="button"
                className={FILES_ACTION_CLASS}
                aria-label={t('mobile.files.refreshAria')}
                onClick={() => void loadDirectory(route.directory)}
              >
                <RiRefreshLine className={cn('size-4', isLoadingDirectory && 'animate-spin')} />
              </button>
              {canUpload ? (
                <button
                  type="button"
                  className={FILES_ACTION_CLASS}
                  aria-label={t('sidebarFilesTree.actions.uploadFilesTitle')}
                  onClick={() => pickFiles(route.directory)}
                  disabled={isUploading}
                >
                  <Icon name={isUploading ? 'loader-4' : 'upload-2'} className={cn('size-4', isUploading && 'animate-spin')} />
                </button>
              ) : null}
              {onClose ? (
                <button type="button" className={FILES_ACTION_CLASS} aria-label={t('mobile.surface.closeAria')} onClick={onClose}>
                  <RiCloseLine className="size-4" />
                </button>
              ) : null}
            </>
          )}
        />
        {canGoBack && parentDirectory ? (
          <button
            type="button"
            className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-start active:bg-interactive-hover focus:outline-none"
            aria-label={t('mobile.files.backToParentAria', { name: getNameFromPath(parentDirectory) })}
            onClick={() => openDirectory(parentDirectory)}
          >
            <RiArrowLeftLine className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate typography-ui-label text-muted-foreground">{directoryLabel}</span>
          </button>
        ) : null}
      </div>

      <ScrollableOverlay outerClassName="min-h-0 flex-1" className="px-2 pb-3 pt-1" useScrollShadow disableHorizontal>
        {directoryError ? (
          <MobileFilesState message={directoryError} />
        ) : query.trim() ? (
          <MobileSearchResults root={root} results={visibleSearchResults} isSearching={isSearching} actions={fileActions} onOpenFile={openFile} />
        ) : (
          <>
            {entries.length === 0 && !isLoadingDirectory ? (
              <div className="px-4 py-8 text-center typography-ui-label text-muted-foreground">{t('mobile.files.empty.directory')}</div>
            ) : null}
            {entries.map((entry) => (
              <MobileFileRow
                key={entry.path}
                name={entry.name}
                path={entry.path}
                directory={entry.isDirectory}
                meta={entry.isDirectory ? undefined : formatFileSize(entry.size)}
                actions={fileActions}
                onClick={() => entry.isDirectory ? openDirectory(entry.path) : openFile(entry.path)}
              />
            ))}
          </>
        )}
      </ScrollableOverlay>
    </div>
  );
};

const FILES_ACTION_CLASS = '-my-1 flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground touch-manipulation focus:outline-none active:bg-interactive-hover disabled:opacity-50';

/** Extensions' file actions and the root they act in; a row's long-press menu lists them after Copy path. */
type MobileFileActions = { root: string; entries: GuestActionEntry[] };

const MobileFileRow: React.FC<{
  name: string;
  path: string;
  directory: boolean;
  meta?: string;
  actions: MobileFileActions;
  onClick: () => void;
}> = ({ name, path, directory, meta, actions, onClick }) => {
  const { t } = useI18n();
  const row = (
    <button
      type="button"
      className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-start active:bg-interactive-hover focus:outline-none"
      onClick={onClick}
      style={{ touchAction: 'manipulation' }}
    >
      {directory ? (
        <RiFolder3Fill className="size-4 shrink-0 text-primary/80" />
      ) : (
        <FileTypeIcon filePath={path} className="size-4 shrink-0" />
      )}
      <span className="block min-w-0 flex-1 truncate typography-ui-label text-foreground">{name}</span>
      {meta ? <span className="min-w-0 max-w-[55%] shrink truncate typography-micro text-muted-foreground" dir="auto">{meta}</span> : null}
      {directory ? <RiArrowRightSLine className="size-4 shrink-0 text-muted-foreground" /> : null}
    </button>
  );
  // The desktop row menu's Copy path, then the extensions' file actions.
  const copyPath = () => {
    void copyTextToClipboard(path).then((result) => {
      if (result.ok) {
        toast.success(t('sidebarFilesTree.toast.pathCopied'));
        return;
      }
      toast.error(t('sidebarFilesTree.toast.copyFailed'));
    });
  };
  return (
    <MobileRowMenu
      menu={<>
        <ContextMenuItem onClick={copyPath}>
          <Icon name="link" className="me-1 size-4" />
          {t('sidebarFilesTree.menu.copyPath')}
        </ContextMenuItem>
        {actions.entries.length > 0 ? <ContextMenuSeparator /> : null}
        {actions.entries.map((entry) => (
          <ContextMenuItem
            key={`${entry.guest.id}:${entry.action.id}`}
            onClick={() => { void runGuestAction(entry, { kind: 'file', action: entry.action.id, directory: actions.root || null, path, isDirectory: directory }, t); }}
          >
            <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="me-1 size-4" />
            {entry.action.label}
          </ContextMenuItem>
        ))}
      </>}
    >
      {row}
    </MobileRowMenu>
  );
};

const MobileSearchResults: React.FC<{
  root: string;
  results: FileSearchResult[];
  isSearching: boolean;
  actions: MobileFileActions;
  onOpenFile: (path: string) => void;
}> = ({ root, results, isSearching, actions, onOpenFile }) => {
  const { t } = useI18n();
  if (isSearching) return <MobileFilesState loading message={t('common.loading')} />;
  if (results.length === 0) return <MobileFilesState message={t('mobile.files.search.empty')} />;
  return (
    <>
      {results.map((result) => (
        <MobileFileRow
          key={result.path}
          name={getNameFromPath(result.path)}
          path={result.path}
          directory={false}
          meta={getRelativePath(result.path, root)}
          actions={actions}
          onClick={() => onOpenFile(result.path)}
        />
      ))}
    </>
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
