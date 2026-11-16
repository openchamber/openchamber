import React from 'react';

import { toast } from '@/components/ui';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useGuestActions } from '@/hooks/useGuestSurfaces';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useDraftSpaceTarget } from '@/lib/spaces/useDraftSpaceTarget';
import { panelContentDirectory } from '@/lib/spaces/space-creation-requests';
import { SpacePreparing } from '@/components/session/spaces/SpacePreparing';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';
import { useFileTreeUpload } from '@/components/views/files/useFileTreeUpload';
import { useFileContentSearch } from '@/components/views/files/useFileContentSearch';
import { useDirectoryShowHidden } from '@/lib/directoryShowHidden';
import { useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { cn } from '@/lib/utils';
import { isBrowserClientRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { type FileTreeRow } from './fileTreeRows';
import { FileTreeCrudDialog } from './sidebarFilesTree/FileTreeCrudDialog';
import { FileTreeDropIndicator } from './sidebarFilesTree/FileTreeDropIndicator';
import { FileTreeErrorRow } from './sidebarFilesTree/FileTreeErrorRow';
import { FileTreeFallbackList } from './sidebarFilesTree/FileTreeFallbackList';
import { FileTreeMoveDialog } from './sidebarFilesTree/FileTreeMoveDialog';
import { FileTreeSearchField, type FileTreeSearchMode } from './sidebarFilesTree/FileTreeSearchField';
import { FileTreeToolbar } from './sidebarFilesTree/FileTreeToolbar';
import { MemoizedFileRow } from './sidebarFilesTree/FileRow';
import type { FileNode } from './sidebarFilesTree/fileNode';
import { getDropTargetLabel, normalizePath } from './sidebarFilesTree/treePaths';
import { useFileNameSearch } from './sidebarFilesTree/useFileNameSearch';
import { useFileTreeDialogs } from './sidebarFilesTree/useFileTreeDialogs';
import { useFileTreeDragDrop } from './sidebarFilesTree/useFileTreeDragDrop';
import { useFileTreeGitMarks } from './sidebarFilesTree/useFileTreeGitMarks';
import { useFileTreeListing } from './sidebarFilesTree/useFileTreeListing';
import { useFileTreeOpening } from './sidebarFilesTree/useFileTreeOpening';
import { useFileTreeToggle } from './sidebarFilesTree/useFileTreeToggle';
import { useVirtualFileTree } from './sidebarFilesTree/useVirtualFileTree';

// --- Main component ---

export const SidebarFilesTree: React.FC<{ visible?: boolean }> = ({ visible = true }) => {
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const panelDirectory = useEffectiveDirectory() ?? '';
  // A draft waiting for a new space lists the space, and nothing of this computer's until it runs.
  const draftSpace = useDraftSpaceTarget();
  const directory = panelContentDirectory(draftSpace, panelDirectory) ?? '';
  if (draftSpace?.kind === 'preparing') return <SpacePreparing />;
  return <SidebarFilesTreeContent key={JSON.stringify([runtimeKey, directory])} visible={visible} currentDirectory={directory} panelDirectory={panelDirectory} />;
};

/**
 * `currentDirectory` is the folder listed; `panelDirectory` is the one the panel's tabs belong to,
 * the same folder except in a draft waiting for a space.
 */
const SidebarFilesTreeContent: React.FC<{ visible: boolean; currentDirectory: string; panelDirectory: string }> = ({ visible, currentDirectory, panelDirectory }) => {
  const { t } = useI18n();
  const { files, runtime } = useRuntimeAPIs();
  const guestActions = useGuestActions();
  const isBrowserClient = isBrowserClientRuntime(runtime.platform);
  const root = normalizePath(currentDirectory.trim());
  const panelRoot = normalizePath(panelDirectory.trim());
  const showHidden = useDirectoryShowHidden();
  const showGitignored = useFilesViewShowGitignored();
  const gitStatus = useGitStatus(visible ? currentDirectory : null);

  const [searchQuery, setSearchQuery] = React.useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery, 200);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  // Find in files: the menu on the search icon switches the field between
  // names and contents, and `.*` makes the contents query a regular
  // expression. Runtimes without the capability (VS Code) keep names only.
  const canSearchContents = Boolean(files.searchContents);
  const [searchMode, setSearchMode] = React.useState<FileTreeSearchMode>('names');
  const [regexSearch, setRegexSearch] = React.useState(false);
  const contentSearchActive = canSearchContents && searchMode === 'contents';
  const contentSearch = useFileContentSearch({
    searchContents: files.searchContents,
    directory: currentDirectory,
    query: debouncedSearchQuery,
    regex: regexSearch,
    includeHidden: showHidden,
    respectGitignore: !showGitignored,
    active: visible && contentSearchActive,
  });

  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const EMPTY_CONTEXT_TABS: Array<{ mode: string; targetPath: string | null }> = React.useMemo(() => [], []);
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const expandedPathSet = React.useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const expandPath = useFilesViewTabsStore((state) => state.expandPath);
  const collapseAllExpandedPaths = useFilesViewTabsStore((state) => state.collapseAllExpandedPaths);
  const contextTabs = useUIStore((state) => (panelRoot ? (state.contextPanelByDirectory[panelRoot]?.tabs ?? EMPTY_CONTEXT_TABS) : EMPTY_CONTEXT_TABS));
  const openContextFilePaths = React.useMemo(() => new Set(
    contextTabs
      .map((tab) => (tab.mode === 'file' ? tab.targetPath : null))
      .filter((targetPath): targetPath is string => typeof targetPath === 'string' && targetPath.length > 0)
      .map((targetPath) => normalizePath(targetPath))
  ), [contextTabs]);

  const { childrenByDir, loadErrorsByDir, loadedDirsRef, loadDirectory, refreshRoot, refreshDirectory } = useFileTreeListing({
    root,
    visible,
    showHidden,
    showGitignored,
    expandedPaths,
  });
  const { searchResults, searching } = useFileNameSearch({
    visible,
    currentDirectory,
    contentSearchActive,
    query: debouncedSearchQuery,
    showHidden,
    showGitignored,
  });
  const { getFileStatus, getFolderBadge } = useFileTreeGitMarks(gitStatus, root);
  const { openedMatch, handleOpenFile, handleOpenMatch, handleMatchDragStart, handleMatchDragEnd } = useFileTreeOpening({ root, panelRoot });

  const treeListRef = React.useRef<HTMLUListElement | null>(null);
  const { slidingRowPaths, toggleDirectory } = useFileTreeToggle({ root, treeListRef, loadedDirsRef, loadDirectory });

  const {
    canUpload,
    uploadingDirectory,
    uploadFiles,
    pickFiles,
    uploadElements,
  } = useFileTreeUpload({ root, refreshDirectory });
  const isUploading = uploadingDirectory !== null;
  const {
    dropTarget,
    moveDragPath,
    moveDropTarget,
    pendingMove,
    setPendingMove,
    canMove,
    setDropTarget,
    setMoveDropTarget,
    handleDropFiles,
    handleMoveDragChange,
    handleMoveDrop,
    handleConfirmMove,
    handleRootDragOver,
    handleRootDragLeave,
    handleRootDrop,
  } = useFileTreeDragDrop({ root, panelRoot, canUpload, isUploading, uploadFiles, refreshDirectory, expandPath });
  const dropIndicatorTarget = uploadingDirectory ?? dropTarget;

  const {
    activeDialog,
    setActiveDialog,
    dialogData,
    dialogInputValue,
    setDialogInputValue,
    isDialogSubmitting,
    handleOpenDialog,
    handleDialogSubmit,
  } = useFileTreeDialogs({ root, panelRoot, selectedPath, refreshDirectory });

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

  const { treeRows, treeVirtualizer, treeListOffset, setTreeScrollElement, attachTreeList, handleTreeFocus, handleTreeBlur } = useVirtualFileTree({
    root,
    childrenByDir,
    expandedPathSet,
    loadErrorsByDir,
    selectedPath,
    moveDragPath,
    slidingRowPaths,
    treeListRef,
  });

  const renderTreeRow = (row: FileTreeRow<FileNode>): React.ReactNode => {
    if (row.kind === 'error') {
      return <FileTreeErrorRow depth={row.depth} message={row.message} directory={row.directory} onRefresh={refreshDirectory} />;
    }
    const { node, depth, isExpanded } = row;
    const isDir = node.type === 'directory';
    return (
      <MemoizedFileRow
        node={node}
        root={root}
        isExpanded={isExpanded}
        isActive={selectedPath === node.path}
        isBrowserClient={isBrowserClient}
        depth={depth}
        isOpen={!isDir && openContextFilePaths.has(node.path)}
        status={!isDir ? getFileStatus(node.path) : undefined}
        badge={isDir ? getFolderBadge(node.path) : undefined}
        isDropTarget={isDir && (dropIndicatorTarget === node.path || moveDropTarget === node.path)}
        isDragSource={moveDragPath === node.path}
        canUpload={canUpload && !isUploading}
        canMove={canMove}
        permissions={fileRowPermissions}
        downloadFile={files.downloadFile}
        onSelect={handleOpenFile}
        onToggle={toggleDirectory}
        onRevealPath={handleRevealPath}
        onOpenDialog={handleOpenDialog}
        onSetDropTarget={setDropTarget}
        onDropFiles={handleDropFiles}
        onPickFiles={pickFiles}
        onMoveDragChange={handleMoveDragChange}
        onSetMoveDropTarget={setMoveDropTarget}
        onMoveDrop={handleMoveDrop}
        guestActions={guestActions}
      />
    );
  };

  const hasTree = Boolean(root && childrenByDir[root]);
  const rootLoadError = root ? loadErrorsByDir[root] : null;
  const isSearchActive = debouncedSearchQuery.trim().length > 0;
  // The same order of cases as the list below: the tree shows only when no
  // search, search result or root error takes its place.
  const showsTree = !searching && !isSearchActive && searchResults.length === 0 && !rootLoadError && hasTree && Boolean(root);
  const dropTargetLabel = dropIndicatorTarget ? getDropTargetLabel(root, dropIndicatorTarget) : '';
  const moveDropTargetLabel = moveDropTarget ? getDropTargetLabel(root, moveDropTarget) : '';

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* One band: the search field leads, the tree's actions follow it. The
          band is as tall as the file editor's docked toolbar beside it, so the
          two read as one strip across the panel. */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-t border-edge-muted px-2">
        <FileTreeSearchField
          canSearchContents={canSearchContents}
          contentSearchActive={contentSearchActive}
          searchMode={searchMode}
          onSearchModeChange={setSearchMode}
          regexSearch={regexSearch}
          onToggleRegex={() => setRegexSearch((value) => !value)}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
          inputRef={searchInputRef}
        />
        <FileTreeToolbar
          root={root}
          currentDirectory={currentDirectory}
          canCreateFile={canCreateFile}
          canCreateFolder={canCreateFolder}
          canUpload={canUpload}
          isUploading={isUploading}
          showGitignored={showGitignored}
          onOpenDialog={handleOpenDialog}
          onPickFiles={pickFiles}
          onRefresh={() => void refreshRoot()}
          onCollapseAll={() => {
            if (root) collapseAllExpandedPaths(root);
          }}
        />
      </div>

      <div className="relative flex-1 min-h-0">
        <ScrollableOverlay
          ref={setTreeScrollElement}
          outerClassName="h-full min-h-0"
          // The virtualizer keeps rows in place itself; browser scroll
          // anchoring would fight it.
          // A container, so an error row can take the pane's width in a wider tree.
          className={cn('@container px-1.5 py-1.5 [overflow-anchor:none]', (dropIndicatorTarget === root || moveDropTarget === root) && 'bg-interactive-selection/10')}
          onDragEnter={handleRootDragOver}
          onDragOver={handleRootDragOver}
          onDragLeave={handleRootDragLeave}
          onDrop={handleRootDrop}
        >
          <FileTreeFallbackList
            root={root}
            selectedPath={selectedPath}
            contentSearchActive={contentSearchActive}
            contentSearch={contentSearch}
            openedMatch={openedMatch}
            searching={searching}
            isSearchActive={isSearchActive}
            searchResults={searchResults}
            rootLoadError={rootLoadError}
            hasTree={hasTree}
            onOpenMatch={handleOpenMatch}
            onMatchDragStart={handleMatchDragStart}
            onMatchDragEnd={handleMatchDragEnd}
            onOpenFile={handleOpenFile}
            onRefreshRoot={refreshRoot}
          />
        {showsTree ? (
          <ul
            ref={attachTreeList}
            className="relative min-w-[max(100%,var(--oc-file-tree-width,0px))]"
            style={{ height: treeVirtualizer.getTotalSize() }}
            onFocus={handleTreeFocus}
            onBlur={handleTreeBlur}
          >
            {treeVirtualizer.getVirtualItems().map((item) => {
              const row = treeRows[item.index];
              if (!row) return null;
              const path = row.kind === 'node' ? row.node.path : undefined;
              return (
                <li
                  key={item.key}
                  ref={treeVirtualizer.measureElement}
                  data-index={item.index}
                  data-tree-row-path={path}
                  data-tree-disclosure-path={row.kind === 'node' ? path : `${row.directory}/`}
                  data-file-tree-path={row.kind === 'node' && row.node.type === 'file' ? path : undefined}
                  // A node row grows past the list to its whole name; an error row truncates.
                  className={cn('absolute inset-x-0 top-0', row.kind === 'node' && 'min-w-max')}
                  style={{ transform: `translateY(${item.start - treeListOffset}px)` }}
                >
                  {renderTreeRow(row)}
                </li>
              );
            })}
          </ul>
        ) : null}
        </ScrollableOverlay>
        <FileTreeDropIndicator
          uploadTarget={dropIndicatorTarget}
          isUploading={isUploading}
          uploadTargetLabel={dropTargetLabel}
          moveTarget={moveDropTarget}
          moveTargetLabel={moveDropTargetLabel}
        />
      </div>

      {uploadElements}

      <FileTreeCrudDialog
        activeDialog={activeDialog}
        dialogData={dialogData}
        inputValue={dialogInputValue}
        isSubmitting={isDialogSubmitting}
        onInputChange={setDialogInputValue}
        onSubmit={() => void handleDialogSubmit()}
        onClose={() => setActiveDialog(null)}
      />

      <FileTreeMoveDialog
        root={root}
        pendingMove={pendingMove}
        onCancel={() => setPendingMove(null)}
        onConfirm={handleConfirmMove}
      />
    </section>
  );
};
