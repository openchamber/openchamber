import React from 'react';
import { toast } from '@/components/ui';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { getDisambiguatingFolders } from '@/lib/path-utils';
import { useZoneInteractive } from '@/components/layout/zoneInteractiveContext';
import { type FileStatSnapshot } from '../../fileStatChange';
import { syncVimMappings } from '@/lib/codemirror/vimModeExtension';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useFileSearchStore } from '@/stores/useFileSearchStore';
import { useDeviceInfo } from '@/lib/device';
import { type FileLineEnding } from '../../fileEditorContent';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { DiagramEditor } from '@/components/diagram';
import { EMPTY_CANVAS_READ, type FileCanvasHandle } from '@/components/views/files/fileCanvas';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { EditorView } from '@codemirror/view';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useUIStore } from '@/stores/useUIStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';
import { DirectoryRequests } from '../directoryRequests';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { getDefaultTheme } from '@/lib/theme/themes';
import { isBrowserClientRuntime, openDesktopFileInApp, openDesktopPath } from '@/lib/desktop';
import { useOpenInAppsStore } from '@/stores/useOpenInAppsStore';
import { isEditableEventTarget } from '@/hooks/keyboard-shortcut-dom';
import { useI18n } from '@/lib/i18n';
import type { FileNode, SelectedLineRange, TextViewMode, PreviewViewMode } from './fileViewTypes';
import { getParentDirectoryPath, normalizePath, toComparablePath, isPathWithinRoot, getDisplayPath } from './fileViewPaths';
import type { FilesViewOptions } from './fileViewTypes';

type RuntimeDescriptor = ReturnType<typeof useRuntimeAPIs>['runtime'];
interface FileViewRuntime extends RuntimeDescriptor {
  isDesktop: RuntimeDescriptor['isDesktop'];
}
type DiagramEditorRef = React.RefObject<React.ComponentRef<typeof DiagramEditor> | null>;

export function useFilesViewState({
  mode, visible,
}: Pick<FilesViewOptions, 'mode' | 'visible'>) {
  const { t } = useI18n();
  const guestActions = useGuestActions();
  const { files, runtime: fileRuntime, git } = useRuntimeAPIs();
  const runtime: FileViewRuntime = fileRuntime;
  const { currentTheme, availableThemes, lightThemeId, darkThemeId } = useThemeSystem();
  const { isMobile, isTablet, screenWidth } = useDeviceInfo();
  const isBrowserClient = isBrowserClientRuntime(runtime.platform);
  const alwaysShowActions = isMobile || isTablet;
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const zoneInteractive = useZoneInteractive();

  // The panel's tabs belong to the open view's folder; the files come from it too, except in a
  // draft waiting for a new space, which shows the space's (`panelContentDirectory`).
  const panelDirectory = useEffectiveDirectory() ?? '';
  const currentDirectory = panelContentDirectory(useDraftSpaceTarget(), panelDirectory) ?? '';
  const root = normalizePath(currentDirectory.trim());
  const panelRoot = normalizePath(panelDirectory.trim());
  const treeEnabled = isMobile || mode === 'full';
  const treeActive = treeEnabled && visible;
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const fileScope = JSON.stringify([runtimeKey, root]);
  const fileScopeRef = React.useRef(fileScope);
  fileScopeRef.current = fileScope;
  const treeScope = JSON.stringify([runtimeKey, root, showHidden, showGitignored]);
  const treeScopeRef = React.useRef(treeScope);
  treeScopeRef.current = treeScope;
  // editor-only hosts (desktop context panel, the mobile Files surface) bring
  // their own chrome — the open-file tabs row is redundant there.
  const showEditorTabsRow = mode !== 'editor-only';
  const suppressFileLoadingIndicator = mode === 'editor-only' && !isMobile;
  const searchFiles = useFileSearchStore((state) => state.searchFiles);
  const gitStatus = useGitStatus(treeActive ? currentDirectory : null);

  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const [showMobilePageContent, setShowMobilePageContent] = React.useState(false);
  const wrapLines = useUIStore((state) => state.fileEditorWrapLines);
  const setWrapLines = useUIStore((state) => state.setFileEditorWrapLines);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  // The canvas lives in one place at a time (docked or fullscreen), so moving
  // it carries unsaved edits over through the draft, as the source toggle does.
  // An extension editor answers asynchronously; if it cannot, the canvas stays
  // where it is rather than remounting without the user's edits.
  const changeFullscreen = React.useCallback((next: boolean) => {
    if (!canvasDirtyRef.current) {
      setIsFullscreen(next);
      return;
    }
    const pathAtToggle = selectedFilePathRef.current;
    // Bytes have no text draft to travel through, so a binary editor's
    // unsaved changes are saved before it moves.
    if (binaryCanvasRef.current) {
      void saveDraftRef.current?.().then((saved) => {
        if (saved && selectedFilePathRef.current === pathAtToggle) setIsFullscreen(next);
      });
      return;
    }
    void Promise.resolve(canvasEditorRef.current?.getContent('handoff') ?? EMPTY_CANVAS_READ).then((read) => {
      if (selectedFilePathRef.current !== pathAtToggle) return;
      if (!read.ok) {
        toast.error(read.message);
        return;
      }
      if (read.snapshot && 'content' in read.snapshot) {
        setDraftContent(read.snapshot.content);
        setCanvasDirty(false);
      }
      setIsFullscreen(next);
    });
  }, []);
  const [isSearchOpen, setIsSearchOpen] = React.useState(false);
  const toolbarDropdownOpenCountRef = React.useRef(0);

  const handleToolbarDropdownOpenChange = React.useCallback((open: boolean) => {
    toolbarDropdownOpenCountRef.current = Math.max(
      0,
      toolbarDropdownOpenCountRef.current + (open ? 1 : -1),
    );
  }, []);


  const [textViewMode, setTextViewMode] = React.useState<TextViewMode>('edit');
  const [mdViewMode, setMdViewMode] = React.useState<PreviewViewMode>('edit');
  const [jsonViewMode, setJsonViewMode] = React.useState<'tree' | 'text'>('tree');
  const [htmlViewMode, setHtmlViewMode] = React.useState<PreviewViewMode>('edit');
  const [drawioViewMode, setDrawioViewMode] = React.useState<PreviewViewMode>('preview');
  const [canvasViewMode, setCanvasViewMode] = React.useState<PreviewViewMode>('preview');
  const [svgViewMode, setSvgViewMode] = React.useState<PreviewViewMode>('preview');
  const [mermaidViewMode, setMermaidViewMode] = React.useState<PreviewViewMode>('preview');
  const [tableViewMode, setTableViewMode] = React.useState<'table' | 'text'>('table');
  // Byte size of the open file, for the artifact meta line.
  const [artifactSize, setArtifactSize] = React.useState<number | null>(null);
  const [drawioRemountNonce, setDrawioRemountNonce] = React.useState(0);
  const [canvasRemountNonce, setCanvasRemountNonce] = React.useState(0);
  const textViewModeByPathRef = React.useRef<Record<string, TextViewMode>>({});
  const mdViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const htmlViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const svgViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const mermaidViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const tableViewModeByPathRef = React.useRef<Record<string, 'table' | 'text'>>({});
  const drawioViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});
  const canvasViewModeByPathRef = React.useRef<Record<string, PreviewViewMode>>({});

  const lightTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? getDefaultTheme(false),
    [availableThemes, lightThemeId],
  );
  const darkTheme = React.useMemo(
    () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? getDefaultTheme(true),
    [availableThemes, darkThemeId],
  );

  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const openPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.openPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const expandedPathSet = React.useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const removeOpenPath = useFilesViewTabsStore((state) => state.removeOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const removeUnselectedOpenPath = useFilesViewTabsStore((state) => state.removeUnselectedOpenPath);
  const removeExpandedPathsByPrefix = useFilesViewTabsStore((state) => state.removeExpandedPathsByPrefix);
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
  const openFileFolders = React.useMemo(
    () => getDisambiguatingFolders(openPaths.map((path) => getDisplayPath(root, path))),
    [openPaths, root],
  );
  const getOpenFileFolder = (path: string) => openFileFolders.get(getDisplayPath(root, path));
  const effectiveSelectedPath = React.useMemo(() => {
    if (selectedPath) {
      const comparableSelected = toComparablePath(selectedPath);
      if (openPaths.some((path) => toComparablePath(path) === comparableSelected)) {
        return selectedPath;
      }
    }
    return openPaths[0] ?? null;
  }, [openPaths, selectedPath]);
  const selectedFile = React.useMemo(() => (effectiveSelectedPath ? toFileNode(effectiveSelectedPath) : null), [effectiveSelectedPath, toFileNode]);
  const selectedFilePath = selectedFile?.path ?? '';
  const selectedFilePathRef = React.useRef(selectedFilePath);
  selectedFilePathRef.current = selectedFilePath;

  React.useEffect(() => {
    if (!root || !selectedPath) return;
    const comparableSelected = toComparablePath(selectedPath);
    const selectedIsOpen = openPaths.some((path) => toComparablePath(path) === comparableSelected);
    if (!selectedIsOpen) {
      setSelectedPath(root, openPaths[0] ?? null);
    }
  }, [openPaths, root, selectedPath, setSelectedPath]);

  const selectedFileIsOutsideWorkspace = Boolean(root && selectedFilePath && !isPathWithinRoot(selectedFilePath, root));
  const selectedFileReadOptions = React.useMemo(
    () => ({
      allowOutsideWorkspace: selectedFileIsOutsideWorkspace,
      directory: root || undefined,
    }),
    [selectedFileIsOutsideWorkspace, root],
  );
  const resolveFileReadOptions = React.useCallback((path: string) => ({
    allowOutsideWorkspace: Boolean(root && !isPathWithinRoot(path, root)),
  }), [root]);

  // Editor tabs horizontal scroll fades
  const editorTabsScrollRef = React.useRef<HTMLDivElement>(null);
  const [editorTabsOverflow, setEditorTabsOverflow] = React.useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const updateEditorTabsOverflow = React.useCallback(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    // scrollLeft is negative in RTL; its magnitude is the distance from the start.
    const fromStart = Math.abs(el.scrollLeft);
    setEditorTabsOverflow({
      start: fromStart > 2,
      end: fromStart + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);
  const updateEditorTabsOverflowRef = React.useRef(updateEditorTabsOverflow);
  updateEditorTabsOverflowRef.current = updateEditorTabsOverflow;
  React.useEffect(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    const handler = () => updateEditorTabsOverflowRef.current();
    handler();
    el.addEventListener('scroll', handler, { passive: true });
    const ro = new ResizeObserver(handler);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', handler);
      ro.disconnect();
    };
  }, [openFiles.length]);

  const [childrenByDir, setChildrenByDir] = React.useState<Record<string, FileNode[]>>({});
  const [loadErrorsByDir, setLoadErrorsByDir] = React.useState<Record<string, string>>({});
  const loadedDirsRef = React.useRef<Set<string>>(new Set());
  const directoryRequests = React.useMemo(() => new DirectoryRequests(), []);
  React.useEffect(() => () => directoryRequests.clear(), [directoryRequests]);

  const [searchResults, setSearchResults] = React.useState<FileNode[]>([]);
  const [searching, setSearching] = React.useState(false);

  const [fileContent, setFileContent] = React.useState<string>('');
  const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS();
  const [fileLoading, setFileLoading] = React.useState(false);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const [desktopImageSrc, setDesktopImageSrc] = React.useState<string>('');

  const [loadedFilePath, setLoadedFilePath] = React.useState<string | null>(null);
  const loadedFilePathRef = React.useRef(loadedFilePath);
  loadedFilePathRef.current = loadedFilePath;
  // Set when a move or rename lands on the loaded file (`lib/filePathMoves.ts`):
  // once the tabs point at `to`, the editor adopts it with its unsaved edits
  // instead of re-reading the file.
  const pendingPathMoveRef = React.useRef<{ from: string; to: string } | null>(null);
  // Editors are keyed by the path the file was opened under, so adopting a
  // moved path does not remount them and drop their undo history or edits.
  const [documentPathAlias, setDocumentPathAlias] = React.useState<{ path: string; documentPath: string } | null>(null);
  const editorDocumentPath = documentPathAlias && documentPathAlias.path === loadedFilePath
    ? documentPathAlias.documentPath
    : loadedFilePath;
  // The path whose last read failed. Requests waiting for that file to load
  // (a line jump, a focus) end here instead of waiting forever.
  const [failedFilePath, setFailedFilePath] = React.useState<string | null>(null);
  // The path the open-file poll saw missing since its last load; only that
  // observation lets the poll reload a failed file once it is back.
  const missingSeenPathRef = React.useRef<string | null>(null);
  const filePositionKey = JSON.stringify([getRuntimeKey(), root, editorDocumentPath]);

  const [draftContent, setDraftContent] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const [loadedFileLineEnding, setLoadedFileLineEnding] = React.useState<FileLineEnding>('\n');
  const dialogInputRef = React.useRef<HTMLInputElement>(null);
  const autoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagramAutoSaveTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const diagramXmlRef = React.useRef('');
  const diagramSavedXmlRef = React.useRef('');
  const pendingDrawioPreviewFrameRef = React.useRef<number | null>(null);
  const pendingCanvasPreviewFrameRef = React.useRef<number | null>(null);
  const diagramEditorRef: DiagramEditorRef = React.useRef<React.ComponentRef<typeof DiagramEditor>>(null);
  const canvasEditorRef = React.useRef<FileCanvasHandle | null>(null);
  const [canvasDirty, setCanvasDirty] = React.useState(false);
  const canvasDirtyRef = React.useRef(false);
  canvasDirtyRef.current = canvasDirty;
  // Set during render once the selected file's editor is known: callbacks
  // declared above that point (save, autosave, fullscreen) read it here.
  const binaryCanvasRef = React.useRef(false);
  const saveDraftRef = React.useRef<(() => Promise<boolean>) | null>(null);
  const lastLoadedFileStatRef = React.useRef<FileStatSnapshot | null>(null);
  const lastLoadedFileContentRef = React.useRef('');
  const lastLoadedFileRevisionRef = React.useRef(0);
  const activeFileLoadIdRef = React.useRef(0);
  const loadingFilePathRef = React.useRef<string | null>(null);
  const [fileContentRevision, setFileContentRevision] = React.useState(0);
  const [autoSaveStatus, setAutoSaveStatus] = React.useState<'idle' | 'saved'>('idle');
  const [diagramSaved, setDiagramSaved] = React.useState(false);
  const [canvasSaved, setCanvasSaved] = React.useState(false);
  const [contentDetectedBinary, setContentDetectedBinary] = React.useState(false);
  const autoSaveEnabled = useUIStore((state) => state.autoSaveEnabled);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setAutoSaveEnabled = useUIStore((state) => state.setAutoSaveEnabled);

  const [confirmDiscardOpen, setConfirmDiscardOpen] = React.useState(false);
  const pendingSelectFileRef = React.useRef<FileNode | null>(null);
  const pendingClosePathRef = React.useRef<string | null>(null);
  const skipDirtyOnceRef = React.useRef(false);
  const copiedContentTimeoutRef = React.useRef<number | null>(null);
  const copiedPathTimeoutRef = React.useRef<number | null>(null);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);
  // The canvas has no CodeMirror wrapper; Cmd/Ctrl+S must reach it too.
  const canvasWrapperRef = React.useRef<HTMLDivElement | null>(null);
  // Last drawing change, so autosave waits until the user stops drawing. A ref:
  // strokes arrive every frame and must not re-render this view.
  const canvasLastEditAtRef = React.useRef(0);
  const [editorViewReadyNonce, setEditorViewReadyNonce] = React.useState(0);
  const pendingNavigationRafRef = React.useRef<number | null>(null);
  const pendingNavigationCycleRef = React.useRef<{ key: string; attempts: number; targetShown: boolean }>({ key: '', attempts: 0, targetShown: false });

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
  const [rightClickMenuPath, setRightClickMenuPath] = React.useState<string | null>(null);
  const [copiedContent, setCopiedContent] = React.useState(false);
  const [copiedPath, setCopiedPath] = React.useState(false);
  const [isGoToLineOpen, setIsGoToLineOpen] = React.useState(false);
  const [isSymbolsOpen, setIsSymbolsOpen] = React.useState(false);
  // In-preview find for the rendered Markdown preview (Ctrl/Cmd+F).
  const [mdPreviewFindOpen, setMdPreviewFindOpen] = React.useState(false);
  const [mdPreviewFindFocusNonce, setMdPreviewFindFocusNonce] = React.useState(0);
  // The outline of the rendered Markdown preview. Closed whenever a preview opens; never stored.
  const [mdPreviewOutlineOpen, setMdPreviewOutlineOpen] = React.useState(false);
  const mdPreviewContainerRef = React.useRef<HTMLDivElement | null>(null);
  // Give the rendered preview keyboard focus (without scrolling it) unless the
  // user is typing somewhere else, so Cmd/Ctrl+F opens the preview find bar
  // right after a Markdown file opens and after any click inside it.
  const focusMdPreviewContainer = React.useCallback((event?: React.MouseEvent<HTMLDivElement>) => {
    const container = event?.currentTarget ?? mdPreviewContainerRef.current;
    if (!container) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== container) {
      if (isEditableEventTarget(active)) return;
      if (container.contains(active)) return;
    }
    container.focus({ preventScroll: true });
  }, []);
  const mdFullscreenPreviewContainerRef = React.useRef<HTMLDivElement | null>(null);

  const canCreateFile = Boolean(files.writeFile);
  const canCreateFolder = Boolean(files.createDirectory);
  const canRename = Boolean(files.rename);
  const canDelete = Boolean(files.delete);
  const canReveal = Boolean(files.revealPath);
  const openInApps = useOpenInAppsStore((state) => state.availableApps);
  const openInCacheStale = useOpenInAppsStore((state) => state.isCacheStale);
  const initializeOpenInApps = useOpenInAppsStore((state) => state.initialize);
  const loadOpenInApps = useOpenInAppsStore((state) => state.loadInstalledApps);

  React.useEffect(() => {
    initializeOpenInApps();
  }, [initializeOpenInApps]);

  const handleRevealPath = React.useCallback((targetPath: string) => {
    if (!files.revealPath) return;
    void files.revealPath(targetPath).catch(() => {
      toast.error(t('sidebarFilesTree.toast.revealFailed'));
    });
  }, [files, t]);

  const handleOpenInApp = React.useCallback(async (app: { id: string; appName: string }) => {
    if (!selectedFile?.path) {
      return;
    }

    const openedInApp = await openDesktopFileInApp(selectedFile.path, app.id, app.appName);
    if (openedInApp) {
      return;
    }

    const openedFile = await openDesktopPath(selectedFile.path, app.appName);
    if (openedFile) {
      return;
    }

    const fileDirectory = getParentDirectoryPath(selectedFile.path) || root;
    if (fileDirectory) {
      const openedDirectory = await openDesktopPath(fileDirectory, app.appName);
      if (openedDirectory) {
        return;
      }
    }
    toast.error(t('filesView.toast.openInAppFailed', { app: app.appName }));
  }, [root, selectedFile?.path, t]);

  const handleOpenDialog = React.useCallback((type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => {
    setActiveDialog(type);
    setDialogData(data);
    setDialogInputValue(type === 'rename' ? data.name || '' : '');
    setIsDialogSubmitting(false);
  }, []);

  // Line selection state for commenting
  const [lineSelection, setLineSelection] = React.useState<SelectedLineRange | null>(null);

  // Session/config for sending comments
  const pendingFileNavigation = useUIStore((state) => state.pendingFileNavigation);
  const setPendingFileNavigation = useUIStore((state) => state.setPendingFileNavigation);
  const pendingFileFocusPath = useUIStore((state) => state.pendingFileFocusPath);
  const setPendingFileFocusPath = useUIStore((state) => state.setPendingFileFocusPath);
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const fileEditorVimMappings = useUIStore((state) => state.fileEditorVimMappings);
  // Vim mappings live in the Vim keymap, which is global; editing them in
  // Settings applies to open editors on the next key press.
  React.useEffect(() => {
    if (fileEditorKeymap === 'vim') syncVimMappings(fileEditorVimMappings);
  }, [fileEditorKeymap, fileEditorVimMappings]);
  const settingsDefaultFileViewerPreview = useConfigStore((state) => state.settingsDefaultFileViewerPreview);
  const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);

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
  return {
  t, guestActions, files, runtime, git, currentTheme, isMobile, screenWidth, isBrowserClient, alwaysShowActions,
  showHidden, showGitignored, zoneInteractive, currentDirectory, root, panelRoot, treeEnabled, treeActive,
  runtimeKey, fileScope, fileScopeRef, treeScope, treeScopeRef, showEditorTabsRow, suppressFileLoadingIndicator,
  searchFiles, gitStatus, searchQuery, setSearchQuery, debouncedSearchQuery, searchInputRef, showMobilePageContent,
  setShowMobilePageContent, wrapLines, setWrapLines, isFullscreen, changeFullscreen, isSearchOpen, setIsSearchOpen,
  handleToolbarDropdownOpenChange, textViewMode, setTextViewMode, mdViewMode, setMdViewMode, jsonViewMode,
  setJsonViewMode, htmlViewMode, setHtmlViewMode, drawioViewMode, setDrawioViewMode, canvasViewMode,
  setCanvasViewMode, svgViewMode, setSvgViewMode, mermaidViewMode, setMermaidViewMode, tableViewMode,
  setTableViewMode, artifactSize, setArtifactSize, drawioRemountNonce, setDrawioRemountNonce, canvasRemountNonce,
  setCanvasRemountNonce, textViewModeByPathRef, mdViewModeByPathRef, htmlViewModeByPathRef, svgViewModeByPathRef,
  mermaidViewModeByPathRef, tableViewModeByPathRef, drawioViewModeByPathRef, canvasViewModeByPathRef, lightTheme,
  darkTheme, openPaths, expandedPaths, expandedPathSet, removeOpenPath, removeOpenPathsByPrefix,
  removeUnselectedOpenPath, removeExpandedPathsByPrefix, setSelectedPath, toggleExpandedPath, expandPaths,
  toFileNode, openFiles, getOpenFileFolder, selectedFile, selectedFilePath, selectedFilePathRef,
  selectedFileIsOutsideWorkspace, selectedFileReadOptions, resolveFileReadOptions, editorTabsScrollRef,
  editorTabsOverflow, childrenByDir, setChildrenByDir, loadErrorsByDir, setLoadErrorsByDir, loadedDirsRef,
  directoryRequests, searchResults, setSearchResults, searching, setSearching, fileContent, setFileContent,
  isTTSPlaying, playTTS, stopTTS, fileLoading, setFileLoading, fileError, setFileError, desktopImageSrc,
  setDesktopImageSrc, loadedFilePath, setLoadedFilePath, loadedFilePathRef, pendingPathMoveRef,
  setDocumentPathAlias, editorDocumentPath, failedFilePath, setFailedFilePath, missingSeenPathRef, filePositionKey,
  draftContent, setDraftContent, isSaving, setIsSaving, loadedFileLineEnding, setLoadedFileLineEnding,
  dialogInputRef, autoSaveTimerRef, diagramAutoSaveTimerRef, diagramXmlRef, diagramSavedXmlRef,
  pendingDrawioPreviewFrameRef, pendingCanvasPreviewFrameRef, diagramEditorRef, canvasEditorRef, canvasDirty,
  setCanvasDirty, canvasDirtyRef, binaryCanvasRef, saveDraftRef, lastLoadedFileStatRef, lastLoadedFileContentRef,
  lastLoadedFileRevisionRef, activeFileLoadIdRef, loadingFilePathRef, fileContentRevision, setFileContentRevision,
  autoSaveStatus, setAutoSaveStatus, diagramSaved, setDiagramSaved, canvasSaved, setCanvasSaved,
  contentDetectedBinary, setContentDetectedBinary, autoSaveEnabled, shortcutOverrides, setAutoSaveEnabled,
  confirmDiscardOpen, setConfirmDiscardOpen, pendingSelectFileRef, pendingClosePathRef, skipDirtyOnceRef,
  copiedContentTimeoutRef, copiedPathTimeoutRef, editorViewRef, editorWrapperRef, canvasWrapperRef,
  canvasLastEditAtRef, editorViewReadyNonce, setEditorViewReadyNonce, pendingNavigationRafRef,
  pendingNavigationCycleRef, activeDialog, setActiveDialog, dialogData, dialogInputValue, setDialogInputValue,
  isDialogSubmitting, setIsDialogSubmitting, contextMenuPath, setContextMenuPath, rightClickMenuPath,
  setRightClickMenuPath, copiedContent, setCopiedContent, copiedPath, setCopiedPath, isGoToLineOpen,
  setIsGoToLineOpen, isSymbolsOpen, setIsSymbolsOpen, mdPreviewFindOpen, setMdPreviewFindOpen,
  mdPreviewFindFocusNonce, setMdPreviewFindFocusNonce, mdPreviewOutlineOpen, setMdPreviewOutlineOpen,
  mdPreviewContainerRef, focusMdPreviewContainer, mdFullscreenPreviewContainerRef, canCreateFile, canCreateFolder,
  canRename, canDelete, canReveal, openInApps, openInCacheStale, loadOpenInApps, handleRevealPath, handleOpenInApp,
  handleOpenDialog, lineSelection, setLineSelection, pendingFileNavigation, setPendingFileNavigation,
  pendingFileFocusPath, setPendingFileFocusPath, fileEditorKeymap, settingsDefaultFileViewerPreview,
  showMessageTTSButtons,
  };
}
