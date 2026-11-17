import React from 'react';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { ActionToolbar } from '@/components/ui/action-toolbar';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { setFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import type { FileTreeDialogData, FileTreeDialogType } from './useFileTreeDialogs';

export const FileTreeToolbar: React.FC<{
  root: string;
  currentDirectory: string;
  canCreateFile: boolean;
  canCreateFolder: boolean;
  canUpload: boolean;
  isUploading: boolean;
  showGitignored: boolean;
  onOpenDialog: (type: FileTreeDialogType, data: FileTreeDialogData) => void;
  onPickFiles: (directory: string) => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
}> = ({
  root,
  currentDirectory,
  canCreateFile,
  canCreateFolder,
  canUpload,
  isUploading,
  showGitignored,
  onOpenDialog: handleOpenDialog,
  onPickFiles: pickFiles,
  onRefresh,
  onCollapseAll,
}) => {
  const { t } = useI18n();
  return (
    <ActionToolbar
      className="shrink-0 gap-0.5"
      groups={[[
        (canCreateFile || canCreateFolder || canUpload) && {
          id: 'add',
          label: t('sidebarFilesTree.actions.addMenuTitle'),
          icon: isUploading ? 'loader-4' : 'add',
          iconClassName: isUploading ? 'animate-spin' : undefined,
          menu: (
            <>
              {canCreateFile ? (
                <DropdownMenuItem onClick={() => handleOpenDialog('createFile', { path: currentDirectory, type: 'directory' })}>
                  <Icon name="file-add" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.newFile')}
                </DropdownMenuItem>
              ) : null}
              {canCreateFolder ? (
                <DropdownMenuItem onClick={() => handleOpenDialog('createFolder', { path: currentDirectory, type: 'directory' })}>
                  <Icon name="folder-add" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.newFolder')}
                </DropdownMenuItem>
              ) : null}
              {canUpload ? (
                <DropdownMenuItem disabled={!root || isUploading} onClick={() => pickFiles(root)}>
                  <Icon name="upload-2" className="me-2 h-4 w-4" /> {t('sidebarFilesTree.menu.uploadFiles')}
                </DropdownMenuItem>
              ) : null}
            </>
          ),
        },
      ]]}
      menuOnly={[
        {
          id: 'gitignored',
          label: t('filesView.tree.actions.showGitignored'),
          icon: 'file-forbid',
          pressed: showGitignored,
          onSelect: () => setFilesViewShowGitignored(!showGitignored),
        },
        {
          id: 'refresh',
          label: t('sidebarFilesTree.actions.refreshTitle'),
          icon: 'refresh',
          onSelect: onRefresh,
        },
        {
          id: 'collapse-all',
          label: t('sidebarFilesTree.actions.collapseAllTitle'),
          icon: 'collapse-vertical',
          onSelect: onCollapseAll,
        },
      ]}
    />
  );
};
