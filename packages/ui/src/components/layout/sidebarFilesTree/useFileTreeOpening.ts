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
  // The result last opened, so only that line is marked when one file has
  // several; selecting the file another way clears the mark.
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
    // Touch has no double-click to keep a preview, so it opens tabs outright.
    openContextFile(panelRoot, node.path, { preview: !options?.pin && !useUIStore.getState().isMobile });
  }, [addOpenPath, files, openContextFile, panelRoot, root, setSelectedPath]);

  // A find-in-files result opens its file at the matching line, as a preview
  // on a click and as a pinned tab on a double-click, like a tree row.
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
    // Search results attach to the chat only; they never move.
    setFileTreeDragSource(null);
    event.dataTransfer.setData(INTERNAL_FILE_PATH_TYPE, match.relativePath);
    event.dataTransfer.effectAllowed = 'copy';
  }, []);

  const handleMatchDragEnd = React.useCallback((event: React.DragEvent<HTMLButtonElement>, match: FileContentSearchMatch) => {
    // A micro-drag suppressed the click this gesture was meant to be (#2368).
    if (shouldTreatFileTreeDragEndAsClick(event)) {
      void handleOpenMatch(match);
    }
  }, [handleOpenMatch]);

  return { openedMatch, handleOpenFile, handleOpenMatch, handleMatchDragStart, handleMatchDragEnd };
};
