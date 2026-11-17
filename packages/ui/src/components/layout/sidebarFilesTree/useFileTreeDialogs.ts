import React from 'react';

import { toast } from '@/components/ui';
import { moveWorkspacePath } from '@/components/views/files/moveWorkspacePath';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { getDropTargetLabel, normalizePath } from './treePaths';

export type FileTreeDialogType = 'createFile' | 'createFolder' | 'rename' | 'delete';
export type FileTreeDialogData = { path: string; name?: string; type?: 'file' | 'directory' };

export const useFileTreeDialogs = ({
  root,
  panelRoot,
  selectedPath,
  refreshDirectory,
}: {
  root: string;
  panelRoot: string;
  selectedPath: string | null;
  refreshDirectory: (dirPath: string) => Promise<void>;
}) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);

  const [activeDialog, setActiveDialog] = React.useState<FileTreeDialogType | null>(null);
  const [dialogData, setDialogData] = React.useState<FileTreeDialogData | null>(null);
  const [dialogInputValue, setDialogInputValue] = React.useState('');
  const [isDialogSubmitting, setIsDialogSubmitting] = React.useState(false);

  const handleOpenDialog = React.useCallback((type: FileTreeDialogType, data: FileTreeDialogData) => {
    setActiveDialog(type);
    setDialogData(data);
    setDialogInputValue(type === 'rename' ? data.name || '' : '');
    setIsDialogSubmitting(false);
  }, []);


  const handleDialogSubmit = React.useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogData || !activeDialog) return;

    setIsDialogSubmitting(true);
    const done = () => setIsDialogSubmitting(false);
    const closeDialog = () => setActiveDialog(null);

    if (activeDialog === 'createFile') {
      if (!dialogInputValue.trim()) {
        toast.error(t('sidebarFilesTree.toast.filenameRequired'));
        done();
        return;
      }
      if (!files.writeFile) {
        toast.error(t('sidebarFilesTree.toast.writeNotSupported'));
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

      await files.writeFile(newPath, '')
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.fileCreated'));
            await refreshDirectory(parentPath);
          }
          closeDialog();
        })
        .catch(() => toast.error(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'createFolder') {
      if (!dialogInputValue.trim()) {
        toast.error(t('sidebarFilesTree.toast.folderNameRequired'));
        done();
        return;
      }

      const parentPath = dialogData.path;
      const prefix = parentPath ? `${parentPath}/` : '';
      const newPath = normalizePath(`${prefix}${dialogInputValue.trim()}`);

      await files.createDirectory(newPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.folderCreated'));
            await refreshDirectory(parentPath);
          }
          closeDialog();
        })
        .catch(() => toast.error(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'rename') {
      if (!dialogInputValue.trim()) {
        toast.error(t('sidebarFilesTree.toast.nameRequired'));
        done();
        return;
      }
      if (!files.rename) {
        toast.error(t('sidebarFilesTree.toast.renameNotSupported'));
        done();
        return;
      }

      const oldPath = dialogData.path;
      const parentDir = oldPath.split('/').slice(0, -1).join('/');
      const prefix = parentDir ? `${parentDir}/` : '';
      const newName = dialogInputValue.trim();
      const newPath = normalizePath(`${prefix}${newName}`);

      try {
        const result = await moveWorkspacePath(files, { tabs: panelRoot, files: root }, oldPath, newPath);
        if (result === 'moved') {
          toast.success(t('sidebarFilesTree.toast.renamedSuccessfully'));
          await refreshDirectory(parentDir);
          closeDialog();
        } else if (result === 'conflict') {
          toast.error(t('sidebarFilesTree.toast.nameTaken', { name: newName, folder: getDropTargetLabel(root, parentDir) }));
        } else {
          toast.error(t('sidebarFilesTree.toast.operationFailed'));
        }
      } catch {
        toast.error(t('sidebarFilesTree.toast.operationFailed'));
      } finally {
        done();
      }
      return;
    }

    if (activeDialog === 'delete') {
      if (!files.delete) {
        toast.error(t('sidebarFilesTree.toast.deleteNotSupported'));
        done();
        return;
      }

      const deletedPath = dialogData.path;
      const parentDir = deletedPath.split('/').slice(0, -1).join('/');
      await files.delete(deletedPath)
        .then(async (result) => {
          if (result.success) {
            toast.success(t('sidebarFilesTree.toast.deletedSuccessfully'));
            await refreshDirectory(parentDir);
            if (root) {
              removeOpenPathsByPrefix(root, deletedPath);
            }
            if (selectedPath === deletedPath || (selectedPath && selectedPath.startsWith(deletedPath + '/'))) {
              setSelectedPath(root, null);
            }
          }
          closeDialog();
        })
        .catch(() => toast.error(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    done();
  }, [activeDialog, dialogData, dialogInputValue, files, panelRoot, refreshDirectory, removeOpenPathsByPrefix, root, selectedPath, setSelectedPath, t]);

  return {
    activeDialog,
    setActiveDialog,
    dialogData,
    dialogInputValue,
    setDialogInputValue,
    isDialogSubmitting,
    handleOpenDialog,
    handleDialogSubmit,
  };
};
