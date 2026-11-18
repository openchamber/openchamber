import React from 'react';

import { toast } from '@/components/ui';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { guestActionsWhere, type GuestActionEntry } from '@/lib/guests/actions';
import { runGuestAction } from '@/lib/guests/run-action';
import { INTERNAL_FILE_PATH_TYPE } from '@/components/chat/composer/attachments/dataTransfer';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import {
  FileTreeChevron,
  FileTreeFileMarkers,
  FileTreeFolderBadge,
  FileTreeIndentGuides,
  FileTreeRowEnd,
} from '@/components/views/files/FileTreeRowParts';
import {
  fileTreeRowMenuFillClassName,
  fileTreeRowPaddingLeft,
  fileTreeRowStateClassName,
  type FileTreeGitStatus,
} from '@/components/views/files/fileTreeRow';
import { Icon } from "@/components/icon/Icon";
import { isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { isFileTreeDragWithinClickSlop, recordFileTreeDragStart, shouldTreatFileTreeDragEndAsClick } from '../fileTreeDragClick';
import { getFileTreeMoveTarget, type FileTreeEntry } from '../fileTreeMoveDrag';
import type { FileNode } from './fileNode';
import { getParentPath, getRelativePath } from './treePaths';
import { getMoveDragSource, hasExternalFiles, isDropOfMoveSource } from './dragData';


interface FileRowProps {
  node: FileNode;
  root: string;
  isExpanded: boolean;
  isActive: boolean;
  isBrowserClient: boolean;
  depth: number;
  isOpen: boolean;
  status?: FileTreeGitStatus | null;
  badge?: { modified: number; added: number } | null;
  isDropTarget: boolean;
  isDragSource: boolean;
  canUpload: boolean;
  canMove: boolean;
  permissions: {
    canRename: boolean;
    canCreateFile: boolean;
    canCreateFolder: boolean;
    canDelete: boolean;
    canReveal: boolean;
  };
  downloadFile?: (path: string) => Promise<void>;
  onSelect: (node: FileNode, options?: { pin?: boolean }) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onOpenDialog: (type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => void;
  onSetDropTarget: (path: string | null) => void;
  onDropFiles: (directory: string, dataTransfer: DataTransfer) => void;
  onPickFiles: (directory: string) => void;
  onMoveDragChange: (source: FileTreeEntry | null) => void;
  onSetMoveDropTarget: (path: string | null) => void;
  onMoveDrop: (source: FileTreeEntry, targetDirectory: string) => void;
  guestActions: GuestActionEntry[];
}

const FileRow: React.FC<FileRowProps> = ({
  guestActions,
  node,
  root,
  isExpanded,
  isActive,
  isBrowserClient,
  depth,
  isOpen,
  status,
  badge,
  isDropTarget,
  isDragSource,
  canUpload,
  canMove,
  permissions,
  downloadFile,
  onSelect,
  onToggle,
  onRevealPath,
  onOpenDialog,
  onSetDropTarget,
  onDropFiles,
  onPickFiles,
  onMoveDragChange,
  onSetMoveDropTarget,
  onMoveDrop,
}) => {
  const { t } = useI18n();
  const isDir = node.type === 'directory';
  const uploadDirectory = isDir ? node.path : getParentPath(node.path);
  const { canRename, canCreateFile, canCreateFolder, canDelete, canReveal } = permissions;
  const canDownload = !isDir && Boolean(downloadFile);
  const canRevealPath = canReveal && !isBrowserClient;
  const canUploadHere = isDir && canUpload;
  const hasMenuActions = canRename || canCreateFile || canCreateFolder || canUploadHere || canDelete || canDownload || canRevealPath;

  const [contextMenuOpen, setContextMenuOpen] = React.useState(false);
  const [rightClickOpen, setRightClickOpen] = React.useState(false);

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!hasMenuActions) return;
    event?.preventDefault();
    setRightClickOpen(true);
  }, [hasMenuActions]);

  const handleInteraction = React.useCallback(() => {
    if (isDir) {
      onToggle(node.path);
    } else {
      onSelect(node);
    }
  }, [isDir, node, onSelect, onToggle]);

  const handleDoubleClick = React.useCallback(() => {
    if (!isDir) onSelect(node, { pin: true });
  }, [isDir, node, onSelect]);

  const handleMenuButtonClick = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRightClickOpen(false);
    setContextMenuOpen(true);
  }, []);

  const fileActions = guestActionsWhere(guestActions, 'file');

  const renderMenuItems = ({
    Item,
    Separator,
  }: {
    Item: React.ElementType;
    Separator: React.ElementType;
  }) => (
    <>
      {canRename && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('rename', node); }}>
          <Icon name="edit" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.rename')}
        </Item>
      )}
      <Item onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        void copyTextToClipboard(node.path).then((result) => {
          if (result.ok) {
            toast.success(t('sidebarFilesTree.toast.pathCopied'));
            return;
          }
          toast.error(t('sidebarFilesTree.toast.copyFailed'));
        });
      }}>
        <Icon name="link" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.copyPath')}
      </Item>
      {!isDir && downloadFile && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void downloadFile(node.path).catch((error) => {
            console.error('Download failed:', error);
            toast.error(t('sidebarFilesTree.toast.operationFailed'));
          });
        }}>
          <Icon name="download" className="me-2 h-4 w-4" /> {t(isBrowserClient ? 'sidebarFilesTree.menu.download' : 'sidebarFilesTree.menu.save')}
        </Item>
      )}
      {canRevealPath && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRevealPath(node.path); }}>
          <Icon name="folder-received" className="me-2 h-4 w-4" /> {t(getRevealLabelKey())}
        </Item>
      )}
      {!isDir && canRevealPath && isDesktopLocalOriginActive() && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void openDesktopPath(node.path).then((opened) => {
            if (!opened) toast.error(t('sidebarFilesTree.toast.operationFailed'));
          });
        }}>
          <Icon name="external-link" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.openInDefaultApp')}
        </Item>
      )}
      {fileActions.length > 0 && <Separator />}
      {fileActions.map((entry) => (
        <Item
          key={`${entry.guest.id}:${entry.action.id}`}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            void runGuestAction(entry, { kind: 'file', action: entry.action.id, directory: root || null, path: node.path, isDirectory: isDir }, t);
          }}
        >
          <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="me-2 h-4 w-4" /> {entry.action.label}
        </Item>
      ))}
      {isDir && (canCreateFile || canCreateFolder || canUploadHere) && (
        <>
          <Separator />
          {canCreateFile && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFile', node); }}>
              <Icon name="file-add" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.newFile')}
            </Item>
          )}
          {canCreateFolder && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFolder', node); }}>
              <Icon name="folder-add" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.newFolder')}
            </Item>
          )}
          {canUploadHere && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onPickFiles(node.path); }}>
              <Icon name="upload-2" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.uploadFiles')}
            </Item>
          )}
        </>
      )}
      {canDelete && (
        <>
          <Separator />
          <Item
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('delete', node); }}
            className="text-destructive focus:text-destructive"
          >
            <Icon name="delete-bin" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.delete')}
          </Item>
        </>
      )}
    </>
  );

  const handleDragStart = React.useCallback((e: React.DragEvent) => {
    recordFileTreeDragStart(e);
    const path = getRelativePath(root, node.path);
    if (!path || path === '.') return;
    e.dataTransfer.setData(INTERNAL_FILE_PATH_TYPE, path);
    e.dataTransfer.effectAllowed = canMove ? 'copyMove' : 'copy';
    if (canMove) onMoveDragChange({ path: node.path, type: node.type });
  }, [canMove, node.path, node.type, onMoveDragChange, root]);

  const handleDragEnd = React.useCallback((e: React.DragEvent) => {
    if (canMove) onMoveDragChange(null);
    // external: #2368 Recover the click suppressed by an accidental native micro-drag.
    if (shouldTreatFileTreeDragEndAsClick(e)) {
      handleInteraction();
    }
  }, [canMove, handleInteraction, onMoveDragChange]);

  const handleExternalDragOver = React.useCallback((event: React.DragEvent) => {
    if (!canUpload || !uploadDirectory || !hasExternalFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    onSetDropTarget(uploadDirectory);
  }, [canUpload, onSetDropTarget, uploadDirectory]);

  const handleExternalDragLeave = React.useCallback((event: React.DragEvent) => {
    if (!canUpload || !uploadDirectory || !hasExternalFiles(event.dataTransfer)) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    event.stopPropagation();
    onSetDropTarget(null);
  }, [canUpload, onSetDropTarget, uploadDirectory]);

  const handleExternalDrop = React.useCallback((event: React.DragEvent) => {
    if (!canUpload || !uploadDirectory || !hasExternalFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    onDropFiles(uploadDirectory, event.dataTransfer);
  }, [canUpload, onDropFiles, uploadDirectory]);

  const getMoveTarget = React.useCallback((event: React.DragEvent, source: FileTreeEntry): string | null => {
    if (isFileTreeDragWithinClickSlop(event)) return null;
    return getFileTreeMoveTarget(source, { path: node.path, type: node.type }, root);
  }, [node.path, node.type, root]);

  const handleRowDragOver = React.useCallback((event: React.DragEvent) => {
    const source = canMove ? getMoveDragSource(event.dataTransfer) : null;
    if (!source) {
      handleExternalDragOver(event);
      return;
    }
    event.stopPropagation();
    const target = getMoveTarget(event, source);
    onSetMoveDropTarget(target);
    if (!target) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, [canMove, getMoveTarget, handleExternalDragOver, onSetMoveDropTarget]);

  const handleRowDrop = React.useCallback((event: React.DragEvent) => {
    const source = canMove ? getMoveDragSource(event.dataTransfer) : null;
    if (!source) {
      handleExternalDrop(event);
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    onSetMoveDropTarget(null);
    const target = getMoveTarget(event, source);
    if (target && isDropOfMoveSource(event.dataTransfer, root, source)) onMoveDrop(source, target);
  }, [canMove, getMoveTarget, handleExternalDrop, onMoveDrop, onSetMoveDropTarget, root]);

  return (
    <ContextMenu open={rightClickOpen} onOpenChange={setRightClickOpen}>
      <ContextMenuTrigger render={(
        <div
          className="group relative flex items-center typography-meta"
          style={{ blockSize: 'calc(max(1lh, 1rem) + 0.5rem)' }}
          onContextMenu={handleContextMenu}
          onDragEnter={handleRowDragOver}
          onDragOver={handleRowDragOver}
          onDragLeave={handleExternalDragLeave}
          onDrop={handleRowDrop}
        />
      )}>
      <FileTreeIndentGuides depth={depth} />
      <button
        type="button"
        onClick={handleInteraction}
        onDoubleClick={handleDoubleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        className={cn(
          'oc-file-tree-row flex w-full items-center gap-1.5 rounded-md py-1 text-start select-none',
          isDropTarget
            ? 'bg-interactive-selection text-interactive-selection-foreground ring-2 ring-inset ring-primary [--oc-file-tree-row-fill:var(--interactive-selection)] [--oc-file-tree-row-ring:var(--primary)]'
            : fileTreeRowStateClassName(isActive),
          isDragSource && 'opacity-50'
        )}
        style={{ paddingInlineStart: fileTreeRowPaddingLeft(depth) }}
      >
        {isDir ? (
          <FileTreeChevron expanded={isExpanded} />
        ) : (
          <FileTypeIcon filePath={node.path} extension={node.extension} className="ms-0.5 size-3.5" />
        )}
        <span className="oc-file-tree-row-name typography-meta" title={node.path}>
          {node.name}
        </span>
        <FileTreeRowEnd className="pe-2">
          {!isDir && <FileTreeFileMarkers isOpen={isOpen} status={status} />}
          {isDir && badge && <FileTreeFolderBadge badge={badge} />}
        </FileTreeRowEnd>
      </button>
      {hasMenuActions && (
        <div className={cn('oc-file-tree-row-end -ms-7 w-7 pe-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 pointer-fine:hidden', fileTreeRowMenuFillClassName(isActive || isDropTarget))}>
          <DropdownMenu
            open={contextMenuOpen}
            onOpenChange={setContextMenuOpen}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={handleMenuButtonClick}
                      aria-label={t('diffView.actions.moreActions')}
                    >
                      <Icon name="more-2-fill" className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>{t('diffView.actions.moreActions')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" side="bottom" onCloseAutoFocus={() => setContextMenuOpen(false)}>
              {renderMenuItems({ Item: DropdownMenuItem, Separator: DropdownMenuSeparator })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        {renderMenuItems({ Item: ContextMenuItem, Separator: ContextMenuSeparator })}
      </ContextMenuContent>
    </ContextMenu>
  );
};

const areFileRowPropsEqual = (prev: FileRowProps, next: FileRowProps): boolean => (
  prev.node === next.node
  && prev.root === next.root
  && prev.isExpanded === next.isExpanded
  && prev.isActive === next.isActive
  && prev.isBrowserClient === next.isBrowserClient
  && prev.depth === next.depth
  && prev.isOpen === next.isOpen
  && prev.status === next.status
  && prev.badge === next.badge
  && prev.isDropTarget === next.isDropTarget
  && prev.isDragSource === next.isDragSource
  && prev.canUpload === next.canUpload
  && prev.canMove === next.canMove
  && prev.permissions === next.permissions
  && prev.downloadFile === next.downloadFile
  && prev.onSelect === next.onSelect
  && prev.onToggle === next.onToggle
  && prev.onRevealPath === next.onRevealPath
  && prev.onOpenDialog === next.onOpenDialog
  && prev.onSetDropTarget === next.onSetDropTarget
  && prev.onDropFiles === next.onDropFiles
  && prev.onPickFiles === next.onPickFiles
  && prev.onMoveDragChange === next.onMoveDragChange
  && prev.onSetMoveDropTarget === next.onSetMoveDropTarget
  && prev.onMoveDrop === next.onMoveDrop
  && prev.guestActions === next.guestActions
);

export const MemoizedFileRow = React.memo(FileRow, areFileRowPropsEqual);
