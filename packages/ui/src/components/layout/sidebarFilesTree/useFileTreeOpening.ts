import React from 'react';

import { INTERNAL_FILE_PATH_TYPE } from '@/components/chat/composer/attachments/dataTransfer';
import { fileContentMatchKey } from '@/components/views/files/useFileContentSearch';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { FileContentSearchMatch } from '@/lib/api/types';
import { toastContextFileOpenFailure, validateContextFileOpen } from '@/lib/contextFileOpenGuard';
import { useUIStore } from '@/stores/useUIStore';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { recordFileTreeDragStart, shouldTreatFileTreeDragEndAsClick } from '../fileTreeDragClick';
import { setFileTreeDragSource } from '../fileTreeMoveDrag';
import type { FileNode } from './fileNode';

export const useFileTreeOpening = ({ root, panelRoot }: { root: string; panelRoot: string }) => {
  const { files } = useRuntimeAPIs();
  const openContextFile = useUIStore((state) => state.openContextFile);
  const openContextFileAtLine = useUIStore((state) => state.openContextFileAtLine);
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const addOpenPath = useFilesViewTabsStore((state) => state.addOpenPath);
  const [openedMatch, setOpenedMatch] = React.useState<{ path: string; key: string } | null>(null);

  const handleOpenFile = React.useCallback(async (node: FileNode, options?: { pin?: boolean }) => {
    if (!root) return;

    const openValidation = await validateContextFileOpen(files, node.path, { directory: root });
    if (!openValidation.ok) {
      toastContextFileOpenFailure(node.path, openValidation);
      return;
    }

    setSelectedPath(root, node.path);
    addOpenPath(root, node.path);
    openContextFile(panelRoot, node.path, { preview: !options?.pin && !useUIStore.getState().isMobile });
  }, [addOpenPath, files, openContextFile, panelRoot, root, setSelectedPath]);

  const handleOpenMatch = React.useCallback(async (match: FileContentSearchMatch, options?: { pin?: boolean }) => {
    if (!root) return;

    const openValidation = await validateContextFileOpen(files, match.path, { directory: root });
    if (!openValidation.ok) {
      toastContextFileOpenFailure(match.path, openValidation);
      return;
    }

    setSelectedPath(root, match.path);
    addOpenPath(root, match.path);
    setOpenedMatch({ path: match.path, key: fileContentMatchKey(match) });
    openContextFileAtLine(panelRoot, match.path, match.line, match.column, { preview: !options?.pin && !useUIStore.getState().isMobile });
  }, [addOpenPath, files, openContextFileAtLine, panelRoot, root, setSelectedPath]);

  const handleMatchDragStart = React.useCallback((event: React.DragEvent<HTMLButtonElement>, match: FileContentSearchMatch) => {
    recordFileTreeDragStart(event);
    setFileTreeDragSource(null);
    event.dataTransfer.setData(INTERNAL_FILE_PATH_TYPE, match.relativePath);
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleMatchDragEnd = React.useCallback((event: React.DragEvent<HTMLButtonElement>, match: FileContentSearchMatch) => {
    // external: #2368 Recover the click suppressed by an accidental native micro-drag.
    if (shouldTreatFileTreeDragEndAsClick(event)) {
      void handleOpenMatch(match);
    }
  }, [handleOpenMatch]);

  return { openedMatch, handleOpenFile, handleOpenMatch, handleMatchDragStart, handleMatchDragEnd };
};
