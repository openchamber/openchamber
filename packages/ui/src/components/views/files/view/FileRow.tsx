import React from 'react';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { guestActionsWhere, type GuestActionEntry } from '@/lib/guests/actions';
import { runGuestAction } from '@/lib/guests/run-action';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Button } from '@/components/ui/button';
import { cn, getRevealLabelKey } from '@/lib/utils';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { FileTreeChevron, FileTreeFileMarkers, FileTreeFolderBadge, FileTreeIndentGuides, FileTreeRowEnd } from '../FileTreeRowParts';
import { fileTreeRowMenuFillClassName, fileTreeRowPaddingLeft, fileTreeRowStateClassName, type FileTreeGitStatus } from '../fileTreeRow';
import { Icon } from '@/components/icon/Icon';
import { isDesktopLocalOriginActive, openDesktopPath } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import type { FileNode } from './fileViewTypes';
import { getDisplayPath } from './fileViewPaths';

interface FileRowProps {
  node: FileNode;
  root: string;
  isExpanded: boolean;
  isActive: boolean;
  isMobile: boolean;
  isBrowserClient: boolean;
  alwaysShowActions: boolean;
  depth: number;
  isOpen: boolean;
  status?: FileTreeGitStatus | null;
  badge?: { modified: number; added: number } | null;
  permissions: {
    canRename: boolean;
    canCreateFile: boolean;
    canCreateFolder: boolean;
    canDelete: boolean;
    canReveal: boolean;
  };
  downloadFile?: (path: string) => Promise<void>;
  contextMenuPath: string | null;
  setContextMenuPath: (path: string | null) => void;
  rightClickMenuPath: string | null;
  setRightClickMenuPath: (path: string | null) => void;
  onSelect: (node: FileNode) => void;
  onToggle: (path: string) => void;
  onRevealPath: (path: string) => void;
  onOpenDialog: (type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => void;
  canUpload: boolean;
  onPickFiles: (directory: string) => void;
  guestActions: GuestActionEntry[];
}

export const FileRow: React.FC<FileRowProps> = ({
  guestActions,
  node,
  root,
  isExpanded,
  isActive,
  isMobile,
  isBrowserClient,
  alwaysShowActions,
  depth,
  isOpen,
  status,
  badge,
  permissions,
  downloadFile,
  contextMenuPath,
  setContextMenuPath,
  rightClickMenuPath,
  setRightClickMenuPath,
  onSelect,
  onToggle,
  onRevealPath,
  onOpenDialog,
  canUpload,
  onPickFiles,
}) => {
  const { t } = useI18n();
  const isDir = node.type === 'directory';
  const { canRename, canCreateFile, canCreateFolder, canDelete, canReveal } = permissions;
  const canDownload = !isDir && Boolean(downloadFile);
  const canRevealPath = canReveal && !isBrowserClient;
  const canUploadHere = isDir && canUpload;
  const hasMenuActions = canRename || canCreateFile || canCreateFolder || canUploadHere || canDelete || canDownload || canRevealPath;

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!hasMenuActions) {
      return;
    }
    event?.preventDefault();
    setRightClickMenuPath(node.path);
  }, [hasMenuActions, node.path, setRightClickMenuPath]);

  const handleInteraction = React.useCallback(() => {
    if (isDir) {
      onToggle(node.path);
    } else {
      onSelect(node);
    }
  }, [isDir, node, onSelect, onToggle]);

  const handleMenuButtonClick = React.useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    setRightClickMenuPath(null);
    setContextMenuPath(node.path);
  }, [node.path, setContextMenuPath, setRightClickMenuPath]);

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
          <Icon name="edit" className="me-2 size-4" /> {t('sidebarFilesTree.menu.rename')}
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
        <Icon name="link" className="me-2 size-4" /> {t('sidebarFilesTree.menu.copyPath')}
      </Item>
      <Item onClick={(e: React.MouseEvent) => {
        e.stopPropagation();
        const relativePath = getDisplayPath(root, node.path) || node.path;
        void copyTextToClipboard(relativePath).then((result) => {
          if (result.ok) {
            toast.success(t('filesView.toast.relativePathCopied'));
            return;
          }
          toast.error(t('sidebarFilesTree.toast.copyFailed'));
        });
      }}>
        <Icon name="file-copy-2" className="me-2 size-4" /> {t('filesView.tree.menu.copyRelativePath')}
      </Item>
      {!isDir && downloadFile && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void downloadFile(node.path).catch((error) => {
            console.error('Download failed:', error);
            toast.error(t('sidebarFilesTree.toast.operationFailed'));
          });
        }}>
          <Icon name="download" className="me-2 size-4" /> {t(isBrowserClient ? 'sidebarFilesTree.menu.download' : 'sidebarFilesTree.menu.save')}
        </Item>
      )}
      {canRevealPath && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRevealPath(node.path); }}>
          <Icon name="folder-received" className="me-2 size-4" /> {t(getRevealLabelKey())}
        </Item>
      )}
      {!isDir && canRevealPath && isDesktopLocalOriginActive() && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void openDesktopPath(node.path).then((opened) => {
            if (!opened) toast.error(t('sidebarFilesTree.toast.operationFailed'));
          });
        }}>
          <Icon name="external-link" className="me-2 size-4" /> {t('sidebarFilesTree.menu.openInDefaultApp')}
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
          <GuestIcon icon={entry.icon} iconSrc={entry.iconSrc} className="me-2 size-4" /> {entry.action.label}
        </Item>
      ))}
      {isDir && (canCreateFile || canCreateFolder || canUploadHere) && (
        <>
          <Separator />
          {canCreateFile && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFile', node); }}>
              <Icon name="file-add" className="me-2 size-4" /> {t('sidebarFilesTree.menu.newFile')}
            </Item>
          )}
          {canCreateFolder && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFolder', node); }}>
              <Icon name="folder-add" className="me-2 size-4" /> {t('sidebarFilesTree.menu.newFolder')}
            </Item>
          )}
          {canUploadHere && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onPickFiles(node.path); }}>
              <Icon name="upload-2" className="me-2 size-4" /> {t('sidebarFilesTree.menu.uploadFiles')}
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
            <Icon name="delete-bin" className="me-2 size-4" /> {t('sidebarFilesTree.menu.delete')}
          </Item>
        </>
      )}
    </>
  );

  return (
    <ContextMenu open={rightClickMenuPath === node.path} onOpenChange={(open) => setRightClickMenuPath(open ? node.path : null)}>
      <ContextMenuTrigger render={<div className="group relative flex items-center" data-tree-disclosure-path={node.path} onContextMenu={!isMobile ? handleContextMenu : undefined} />}>
      <FileTreeIndentGuides depth={depth} />
      <button
        type="button"
        onClick={handleInteraction}
        onContextMenu={!isMobile ? handleContextMenu : undefined}
        className={cn(
          'oc-file-tree-row flex w-full items-center gap-1.5 rounded-md py-1 text-start select-none',
          fileTreeRowStateClassName(isActive)
        )}
        style={{ paddingLeft: fileTreeRowPaddingLeft(depth) }}
      >
        {isDir ? (
          <FileTreeChevron expanded={isExpanded} />
        ) : (
          <FileTypeIcon filePath={node.path} extension={node.extension} className="ms-0.5 size-3.5" />
        )}
        <span
          className="oc-file-tree-row-name typography-meta"
          title={node.path}
        >
          {node.name}
        </span>
        <FileTreeRowEnd className="pe-2">
          {!isDir && <FileTreeFileMarkers isOpen={isOpen} status={status} />}
          {isDir && badge && <FileTreeFolderBadge badge={badge} />}
        </FileTreeRowEnd>
      </button>
      {hasMenuActions && (
        <div className={cn(
          "oc-file-tree-row-end -ms-7 w-7 pe-1 transition-opacity pointer-fine:hidden",
          fileTreeRowMenuFillClassName(isActive),
          alwaysShowActions ? "opacity-100" : "opacity-0 focus-within:opacity-100 group-hover:opacity-100"
        )}>
          <DropdownMenu
            open={contextMenuPath === node.path}
            onOpenChange={(open) => setContextMenuPath(open ? node.path : null)}
          >
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                onClick={handleMenuButtonClick}
                aria-label={t('diffView.actions.moreActions')}
                data-row-tooltip={t('diffView.actions.moreActions')}
              >
                <Icon name="more-2-fill" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" onCloseAutoFocus={() => setContextMenuPath(null)}>
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
