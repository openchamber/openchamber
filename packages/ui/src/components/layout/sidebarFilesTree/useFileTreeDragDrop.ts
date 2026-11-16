import React from 'react';

import { toast } from '@/components/ui';
import { moveWorkspacePath } from '@/components/views/files/moveWorkspacePath';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { isFileTreeDragWithinClickSlop } from '../fileTreeDragClick';
import {
  getFileTreeDragSource,
  getFileTreeMovedPath,
  getFileTreeMoveTarget,
  setFileTreeDragSource,
  type FileTreeEntry,
} from '../fileTreeMoveDrag';
import { getExternalFiles, getMoveDragSource, hasExternalFiles, isDropOfMoveSource } from './dragData';
import { getDropTargetLabel, getParentPath } from './treePaths';

export const useFileTreeDragDrop = ({
  root,
  panelRoot,
  canUpload,
  isUploading,
  uploadFiles,
  refreshDirectory,
  expandPath,
}: {
  root: string;
  panelRoot: string;
  canUpload: boolean;
  isUploading: boolean;
  uploadFiles: (directory: string, droppedFiles: File[]) => Promise<void>;
  refreshDirectory: (dirPath: string) => Promise<void>;
  expandPath: (root: string, path: string) => void;
}) => {
  const { t } = useI18n();
  const { files } = useRuntimeAPIs();
  const [dropTarget, setDropTarget] = React.useState<string | null>(null);
  // Drag-to-move: the row being dragged, the folder it would land in, and a
  // drop waiting for confirmation.
  const [moveDragPath, setMoveDragPath] = React.useState<string | null>(null);
  const [moveDropTarget, setMoveDropTarget] = React.useState<string | null>(null);
  const [pendingMove, setPendingMove] = React.useState<{ source: FileTreeEntry; targetDirectory: string } | null>(null);
  const { hasTouchOnlyPointer } = useDeviceInfo();
  // A touch tree scrolls under the finger, so moving by drag stays off there.
  const canMove = Boolean(files.rename && root) && !hasTouchOnlyPointer;

  const handleDropFiles = React.useCallback((directory: string, dataTransfer: DataTransfer) => {
    const droppedFiles = getExternalFiles(dataTransfer);
    if (droppedFiles.length === 0) return;
    setDropTarget(null);
    void uploadFiles(directory, droppedFiles);
  }, [uploadFiles]);

  const handleMoveDragChange = React.useCallback((source: FileTreeEntry | null) => {
    setFileTreeDragSource(source);
    if (!source) {
      setMoveDragPath(null);
      setMoveDropTarget(null);
      return;
    }
    // Dim the row only after the browser has taken the drag image from it.
    requestAnimationFrame(() => {
      if (getFileTreeDragSource()?.path === source.path) setMoveDragPath(source.path);
    });
  }, []);

  const moveEntry = React.useCallback(async (source: FileTreeEntry, targetDirectory: string) => {
    const toPath = getFileTreeMovedPath(source, targetDirectory);
    const result = await moveWorkspacePath(files, { tabs: panelRoot, files: root }, source.path, toPath);
    if (result === 'conflict') {
      toast.error(t('sidebarFilesTree.toast.nameTaken', {
        name: toPath.slice(toPath.lastIndexOf('/') + 1),
        folder: getDropTargetLabel(root, targetDirectory),
      }));
      return;
    }
    if (result === 'failed') {
      toast.error(t('sidebarFilesTree.toast.operationFailed'));
      return;
    }
    if (targetDirectory !== root) expandPath(root, targetDirectory);
    await Promise.all([
      refreshDirectory(getParentPath(source.path)),
      refreshDirectory(targetDirectory),
    ]).catch(() => undefined);
  }, [expandPath, files, panelRoot, refreshDirectory, root, t]);

  const handleMoveDrop = React.useCallback((source: FileTreeEntry, targetDirectory: string) => {
    if (useUIStore.getState().confirmFileTreeMove) {
      setPendingMove({ source, targetDirectory });
      return;
    }
    void moveEntry(source, targetDirectory);
  }, [moveEntry]);

  const handleConfirmMove = React.useCallback(() => {
    if (!pendingMove) return;
    setPendingMove(null);
    void moveEntry(pendingMove.source, pendingMove.targetDirectory);
  }, [moveEntry, pendingMove]);

  const getRootMoveTarget = React.useCallback((event: React.DragEvent, source: FileTreeEntry): string | null => {
    if (!canMove || isFileTreeDragWithinClickSlop(event)) return null;
    return getFileTreeMoveTarget(source, null, root);
  }, [canMove, root]);

  const handleRootDragOver = React.useCallback((event: React.DragEvent) => {
    const moveSource = getMoveDragSource(event.dataTransfer);
    if (moveSource) {
      const target = getRootMoveTarget(event, moveSource);
      setMoveDropTarget(target);
      if (!target) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      return;
    }
    if (!canUpload || isUploading || !root || !hasExternalFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDropTarget(root);
  }, [canUpload, getRootMoveTarget, isUploading, root]);

  const handleRootDragLeave = React.useCallback((event: React.DragEvent) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    if (getMoveDragSource(event.dataTransfer)) {
      setMoveDropTarget(null);
      return;
    }
    if (!hasExternalFiles(event.dataTransfer)) return;
    setDropTarget(null);
  }, []);

  const handleRootDrop = React.useCallback((event: React.DragEvent) => {
    const moveSource = getMoveDragSource(event.dataTransfer);
    if (moveSource) {
      event.preventDefault();
      setMoveDropTarget(null);
      const target = getRootMoveTarget(event, moveSource);
      if (target && isDropOfMoveSource(event.dataTransfer, root, moveSource)) handleMoveDrop(moveSource, target);
      return;
    }
    if (!canUpload || isUploading || !root || !hasExternalFiles(event.dataTransfer)) return;
    event.preventDefault();
    handleDropFiles(root, event.dataTransfer);
  }, [canUpload, getRootMoveTarget, handleDropFiles, handleMoveDrop, isUploading, root]);

  return {
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
  };
};
