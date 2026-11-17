import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { buildFileTreeStatusIndex } from '../fileTreeStatus';
import { FileTreeIndentGuides } from '../FileTreeRowParts';
import { fileTreeRowPaddingLeft, type FileTreeGitStatus } from '../fileTreeRow';
import { useFileTreeDisclosure } from '../useFileTreeDisclosure';
import { Icon } from '@/components/icon/Icon';
import { normalizePath } from './fileViewPaths';
import { FileRow } from './FileRow';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileDirectory } from './useFileDirectory';
import type { useFileOpening } from './useFileOpening';

export function useFileTreeRendering({
  t, guestActions, files, isMobile, isBrowserClient, alwaysShowActions, root, treeEnabled, gitStatus, openPaths,
  expandedPathSet, toggleExpandedPath, selectedFile, childrenByDir, loadErrorsByDir, loadedDirsRef, contextMenuPath,
  setContextMenuPath, rightClickMenuPath, setRightClickMenuPath, canCreateFile, canCreateFolder, canRename,
  canDelete, canReveal, handleRevealPath, handleOpenDialog, loadDirectory, refreshDirectory, canUpload, pickFiles,
  isUploading, handleSelectFile,
}: Pick<ReturnType<typeof useFilesViewState>,
  't' | 'guestActions' | 'files' | 'isMobile' | 'isBrowserClient' | 'alwaysShowActions' | 'root' | 'treeEnabled' |
  'gitStatus' | 'openPaths' | 'expandedPathSet' | 'toggleExpandedPath' | 'selectedFile' | 'childrenByDir' |
  'loadErrorsByDir' | 'loadedDirsRef' | 'contextMenuPath' | 'setContextMenuPath' | 'rightClickMenuPath' |
  'setRightClickMenuPath' | 'canCreateFile' | 'canCreateFolder' | 'canRename' | 'canDelete' | 'canReveal' |
  'handleRevealPath' | 'handleOpenDialog'> &
Pick<ReturnType<typeof useFileDirectory>,
  'loadDirectory' | 'refreshDirectory' | 'canUpload' | 'pickFiles' | 'isUploading'> &
Pick<ReturnType<typeof useFileOpening>,
  'handleSelectFile'>) {
  const openPathSet = React.useMemo(() => new Set(openPaths), [openPaths]);
  const statusIndex = React.useMemo(() => buildFileTreeStatusIndex(treeEnabled ? gitStatus?.files ?? [] : []), [gitStatus?.files, treeEnabled]);
  const getFileStatus = React.useCallback((path: string): FileTreeGitStatus | null => {
    const relative = path.startsWith(root + '/') ? path.slice(root.length + 1) : path;
    return statusIndex.statusByPath.get(relative) ?? null;
  }, [statusIndex, root]);

  const getFolderBadge = React.useCallback((dirPath: string): { modified: number; added: number } | null => {
    if (!gitStatus?.files) return null;
    const relativeDir = dirPath.startsWith(root + '/') ? dirPath.slice(root.length + 1) : dirPath;
    return statusIndex.badgeByDir.get(relativeDir) ?? null;
  }, [gitStatus, statusIndex, root]);

  const treeListRef = React.useRef<HTMLUListElement>(null);
  const toggleWithMotion = useFileTreeDisclosure(treeListRef);
  const toggleDirectory = React.useCallback(async (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    if (!root) return;

    const expanded = useFilesViewTabsStore.getState().byRoot[root]?.expandedPaths.includes(normalized) ?? false;
    toggleWithMotion(dirPath, expanded, () => toggleExpandedPath(root, normalized));

    if (!loadedDirsRef.current.has(normalized)) {
      await loadDirectory(normalized);
    }
  }, [loadDirectory, root, toggleExpandedPath, toggleWithMotion]);

  const fileRowPermissions = React.useMemo(
    () => ({ canRename, canCreateFile, canCreateFolder, canDelete, canReveal }),
    [canRename, canCreateFile, canCreateFolder, canDelete, canReveal]
  );

  function renderTree(dirPath: string, depth: number): React.ReactNode {
    const nodes = childrenByDir[dirPath] ?? [];

    return nodes.map((node) => {
      const isDir = node.type === 'directory';
      const isExpanded = isDir && expandedPathSet.has(node.path);
      const isActive = selectedFile?.path === node.path;

      return (
        <li key={node.path}>
          <FileRow
            guestActions={guestActions}
            node={node}
            root={root}
            isExpanded={isExpanded}
            isActive={isActive}
            isMobile={isMobile}
            isBrowserClient={isBrowserClient}
            alwaysShowActions={alwaysShowActions}
            depth={depth}
            isOpen={!isDir && openPathSet.has(node.path)}
            status={!isDir ? getFileStatus(node.path) : undefined}
            badge={isDir ? getFolderBadge(node.path) : undefined}
            permissions={fileRowPermissions}
            downloadFile={files.downloadFile}
            contextMenuPath={contextMenuPath}
            setContextMenuPath={setContextMenuPath}
            rightClickMenuPath={rightClickMenuPath}
            setRightClickMenuPath={setRightClickMenuPath}
            onSelect={handleSelectFile}
            onToggle={toggleDirectory}
            onRevealPath={handleRevealPath}
            onOpenDialog={handleOpenDialog}
            canUpload={canUpload && !isUploading}
            onPickFiles={pickFiles}
          />
          {isDir && isExpanded && (
            <ul className="flex flex-col">
              {loadErrorsByDir[node.path] ? (
                // As wide as the pane and held at its start, so a tree widened by a long
                // name keeps the message and its button on screen.
                <li
                  className="sticky inset-s-0 flex w-[100cqw] items-center gap-2 py-1 pe-2 typography-meta text-muted-foreground"
                  style={{ paddingLeft: fileTreeRowPaddingLeft(depth + 1) }}
                  data-tree-disclosure-path={`${node.path}/`}
                >
                  <FileTreeIndentGuides depth={depth + 1} />
                  <span className="min-w-0 flex-1 truncate text-[var(--status-error)]" title={loadErrorsByDir[node.path]}>{loadErrorsByDir[node.path]}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="xs" className="h-6 gap-1" onClick={() => void refreshDirectory(node.path)}>
                        <Icon name="refresh" className="size-3.5" />
                        {t('filesView.tree.actions.refreshTitle')}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{t('contextTooltips.files.retryFolder')}</TooltipContent>
                  </Tooltip>
                </li>
              ) : null}
              {renderTree(node.path, depth + 1)}
            </ul>
          )}
        </li>
      );
    });
  }
  return {
  treeListRef, renderTree,
  };
}
