import React from 'react';
import { toast } from '@/components/ui';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { normalizePath, getDisplayPath } from './fileViewPaths';
import { moveWorkspacePath } from '../moveWorkspacePath';
import { type useFileDirectory } from './useFileDirectory';
import { type useFileDocument } from './useFileDocument';
import { type useFileLayout } from './useFileLayout';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';

export function useFileOperations({ fileDirectory, fileDocument, layout, scope, tabs, files, isMobile, t }: {
  fileDirectory: Pick<ReturnType<typeof useFileDirectory>, 'refreshDirectory'>;
  fileDocument: Pick<ReturnType<typeof useFileDocument>, 'setDesktopImageSrc' | 'setFileContent' | 'setFileError' | 'setLoadedFilePath'>;
  layout: Pick<ReturnType<typeof useFileLayout>, 'setShowMobilePageContent'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'panelRoot' | 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'removeOpenPathsByPrefix' | 'selectedFile' | 'setSelectedPath'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  isMobile: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { refreshDirectory } = fileDirectory;
  const { setDesktopImageSrc, setFileContent, setFileError, setLoadedFilePath } = fileDocument;
  const { setShowMobilePageContent } = layout;
  const { panelRoot, root } = scope;
  const { removeOpenPathsByPrefix, selectedFile, setSelectedPath } = tabs;
  const dialogInputRef = React.useRef<HTMLInputElement>(null);
  const [activeDialog, setActiveDialog] = React.useState<'createFile' | 'createFolder' | 'rename' | 'delete' | null>(null);
  const [dialogData, setDialogData] = React.useState<{ path: string; name?: string; type?: 'file' | 'directory' } | null>(null);
  const [dialogInputValue, setDialogInputValue] = React.useState('');
  const [isDialogSubmitting, setIsDialogSubmitting] = React.useState(false);
  const canCreateFile = Boolean(files.writeFile);
  const canCreateFolder = Boolean(files.createDirectory);
  const canRename = Boolean(files.rename);
  const canDelete = Boolean(files.delete);
  const handleOpenDialog = React.useCallback((type: 'createFile' | 'createFolder' | 'rename' | 'delete', data: { path: string; name?: string; type?: 'file' | 'directory' }) => {
    setActiveDialog(type);
    setDialogData(data);
    setDialogInputValue(type === 'rename' ? data.name || '' : '');
    setIsDialogSubmitting(false);
  }, []);
  const handleCloseDialog = React.useCallback(() => setActiveDialog(null), []);
  const handleDialogSubmit = React.useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!dialogData || !activeDialog) return;

    setIsDialogSubmitting(true);
    const finishDialogOperation = () => {
      setActiveDialog(null);
    };

    const failDialogOperation = (message: string) => {
      toast.error(message);
    };

    const done = () => {
      setIsDialogSubmitting(false);
    };

    if (activeDialog === 'createFile') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.filenameRequired'));
        done();
        return;
      }
      if (!files.writeFile) {
        failDialogOperation(t('sidebarFilesTree.toast.writeNotSupported'));
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
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'createFolder') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.folderNameRequired'));
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
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    if (activeDialog === 'rename') {
      if (!dialogInputValue.trim()) {
        failDialogOperation(t('sidebarFilesTree.toast.nameRequired'));
        done();
        return;
      }

      if (!files.rename) {
        failDialogOperation(t('sidebarFilesTree.toast.renameNotSupported'));
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
          finishDialogOperation();
        } else if (result === 'conflict') {
          failDialogOperation(t('sidebarFilesTree.toast.nameTaken', {
            name: newName,
            folder: getDisplayPath(root, parentDir) || t('sidebarFilesTree.dialog.rootFallback'),
          }));
        } else {
          failDialogOperation(t('sidebarFilesTree.toast.operationFailed'));
        }
      } catch {
        failDialogOperation(t('sidebarFilesTree.toast.operationFailed'));
      } finally {
        done();
      }
      return;
    }

    if (activeDialog === 'delete') {
      if (!files.delete) {
        failDialogOperation(t('sidebarFilesTree.toast.deleteNotSupported'));
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
            if (selectedFile?.path === deletedPath || selectedFile?.path.startsWith(`${deletedPath}/`)) {
              if (root) {
                setSelectedPath(root, null);
              }
              setFileContent('');
              setFileError(null);
              setDesktopImageSrc('');
              setLoadedFilePath(null);
              if (isMobile) {
                setShowMobilePageContent(false);
              }
            }
          }
          finishDialogOperation();
        })
        .catch(() => failDialogOperation(t('sidebarFilesTree.toast.operationFailed')))
        .finally(done);
      return;
    }

    done();
  }, [activeDialog, dialogData, dialogInputValue, files, panelRoot, refreshDirectory, isMobile, removeOpenPathsByPrefix, root, selectedFile?.path, setSelectedPath, t]);

  return { dialogInputRef, activeDialog, dialogData, dialogInputValue, setDialogInputValue, isDialogSubmitting, canCreateFile, canCreateFolder, canRename, canDelete, handleOpenDialog, handleCloseDialog, handleDialogSubmit };
}
