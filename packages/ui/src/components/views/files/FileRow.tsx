import React from 'react';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { Button } from '@/components/ui/button';
import { cn, getRevealLabelKey } from '@/lib/utils';
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
import type { FileNode, FileStatus } from './helpers';
import { getDisplayPath } from './helpers';
import { FileStatusDot } from './FileStatusDot';
import { getFileIcon } from './helpers';

interface FileRowProps {
  node: FileNode;
  root: string;
  isExpanded: boolean;
  isActive: boolean;
  isMobile: boolean;
  alwaysShowActions: boolean;
  status?: FileStatus | null;
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
}

export const FileRow: React.FC<FileRowProps> = ({
  node,
  root,
  isExpanded,
  isActive,
  isMobile,
  alwaysShowActions,
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
}) => {
  const { t } = useI18n();
  const isDir = node.type === 'directory';
  const { canRename, canCreateFile, canCreateFolder, canDelete, canReveal } = permissions;

  const handleContextMenu = React.useCallback((event?: React.MouseEvent) => {
    if (!canRename && !canCreateFile && !canCreateFolder && !canDelete && !canReveal) {
      return;
    }
    event?.preventDefault();
    setRightClickMenuPath(node.path);
  }, [canRename, canCreateFile, canCreateFolder, canDelete, canReveal, node.path, setRightClickMenuPath]);

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
          <Icon name="edit" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.rename')}
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
        <Icon name="file-copy" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.copyPath')}
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
        <Icon name="file-copy-2" className="mr-2 size-4" /> {t('filesView.tree.menu.copyRelativePath')}
      </Item>
      {!isDir && downloadFile && (
        <Item onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          void downloadFile(node.path);
        }}>
          <Icon name="download" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.save')}
        </Item>
      )}
      {canReveal && (
        <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRevealPath(node.path); }}>
          <Icon name="folder-received" className="mr-2 size-4" /> {t(getRevealLabelKey())}
        </Item>
      )}
      {isDir && (canCreateFile || canCreateFolder) && (
        <>
          <Separator />
          {canCreateFile && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFile', node); }}>
              <Icon name="file-add" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.newFile')}
            </Item>
          )}
          {canCreateFolder && (
            <Item onClick={(e: React.MouseEvent) => { e.stopPropagation(); onOpenDialog('createFolder', node); }}>
              <Icon name="folder-add" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.newFolder')}
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
            <Icon name="delete-bin" className="mr-2 size-4" /> {t('sidebarFilesTree.menu.delete')}
          </Item>
        </>
      )}
    </>
  );

  return (
    <ContextMenu open={rightClickMenuPath === node.path} onOpenChange={(open) => setRightClickMenuPath(open ? node.path : null)}>
      <ContextMenuTrigger render={<div className="group relative flex items-center" onContextMenu={!isMobile ? handleContextMenu : undefined} />}>
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
            <Icon name="folder-open-fill" className="size-4 flex-shrink-0 text-primary/60" />
          ) : (
            <Icon name="folder-3-fill" className="size-4 flex-shrink-0 text-primary/60" />
          )
        ) : (
          getFileIcon(node.path, node.extension)
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
              >
                <Icon name="more-2-fill" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side={isMobile ? "bottom" : "bottom"} onCloseAutoFocus={() => setContextMenuPath(null)}>
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
