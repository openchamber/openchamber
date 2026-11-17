import React from 'react';
import { getDisambiguatingFolders } from '@/lib/path-utils';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { type FileNode } from './fileViewTypes';
import { normalizePath, toComparablePath, isPathWithinRoot, getDisplayPath } from './fileViewPaths';
import { type useFileScope } from './useFileScope';

export function useFileTabs({ scope }: {
  scope: Pick<ReturnType<typeof useFileScope>, 'root'>;
}) {
  const { root } = scope;
  const EMPTY_PATHS: string[] = React.useMemo(() => [], []);
  const openPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.openPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const selectedPath = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.selectedPath ?? null) : null));
  const expandedPaths = useFilesViewTabsStore((state) => (root ? (state.byRoot[root]?.expandedPaths ?? EMPTY_PATHS) : EMPTY_PATHS));
  const expandedPathSet = React.useMemo(() => new Set(expandedPaths), [expandedPaths]);
  const removeOpenPath = useFilesViewTabsStore((state) => state.removeOpenPath);
  const removeOpenPathsByPrefix = useFilesViewTabsStore((state) => state.removeOpenPathsByPrefix);
  const removeUnselectedOpenPath = useFilesViewTabsStore((state) => state.removeUnselectedOpenPath);
  const removeExpandedPathsByPrefix = useFilesViewTabsStore((state) => state.removeExpandedPathsByPrefix);
  const setSelectedPath = useFilesViewTabsStore((state) => state.setSelectedPath);
  const toggleExpandedPath = useFilesViewTabsStore((state) => state.toggleExpandedPath);
  const expandPaths = useFilesViewTabsStore((state) => state.expandPaths);

  const toFileNode = React.useCallback((path: string): FileNode => {
    const normalized = normalizePath(path);
    const parts = normalized.split('/');
    const name = parts[parts.length - 1] || normalized;
    const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
    return {
      name,
      path: normalized,
      type: 'file',
      extension,
    };
  }, []);

  const openFiles = React.useMemo(() => openPaths.map(toFileNode), [openPaths, toFileNode]);
  const openFileFolders = React.useMemo(
    () => getDisambiguatingFolders(openPaths.map((path) => getDisplayPath(root, path))),
    [openPaths, root],
  );
  const getOpenFileFolder = (path: string) => openFileFolders.get(getDisplayPath(root, path));
  const effectiveSelectedPath = React.useMemo(() => {
    if (selectedPath) {
      const comparableSelected = toComparablePath(selectedPath);
      if (openPaths.some((path) => toComparablePath(path) === comparableSelected)) {
        return selectedPath;
      }
    }
    return openPaths[0] ?? null;
  }, [openPaths, selectedPath]);
  const selectedFile = React.useMemo(() => (effectiveSelectedPath ? toFileNode(effectiveSelectedPath) : null), [effectiveSelectedPath, toFileNode]);
  const selectedFilePath = selectedFile?.path ?? '';
  const selectedFilePathRef = React.useRef(selectedFilePath);
  selectedFilePathRef.current = selectedFilePath;

  React.useEffect(() => {
    if (!root || !selectedPath) return;
    const comparableSelected = toComparablePath(selectedPath);
    const selectedIsOpen = openPaths.some((path) => toComparablePath(path) === comparableSelected);
    if (!selectedIsOpen) {
      setSelectedPath(root, openPaths[0] ?? null);
    }
  }, [openPaths, root, selectedPath, setSelectedPath]);

  const selectedFileIsOutsideWorkspace = Boolean(root && selectedFilePath && !isPathWithinRoot(selectedFilePath, root));
  const selectedFileReadOptions = React.useMemo(
    () => ({
      allowOutsideWorkspace: selectedFileIsOutsideWorkspace,
      directory: root || undefined,
    }),
    [selectedFileIsOutsideWorkspace, root],
  );
  const resolveFileReadOptions = React.useCallback((path: string) => ({
    allowOutsideWorkspace: Boolean(root && !isPathWithinRoot(path, root)),
  }), [root]);
  const editorTabsScrollRef = React.useRef<HTMLDivElement>(null);
  const [editorTabsOverflow, setEditorTabsOverflow] = React.useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const updateEditorTabsOverflow = React.useCallback(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    const fromStart = Math.abs(el.scrollLeft);
    setEditorTabsOverflow({
      start: fromStart > 2,
      end: fromStart + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);
  const updateEditorTabsOverflowRef = React.useRef(updateEditorTabsOverflow);
  updateEditorTabsOverflowRef.current = updateEditorTabsOverflow;
  React.useEffect(() => {
    const el = editorTabsScrollRef.current;
    if (!el) return;
    const handler = () => updateEditorTabsOverflowRef.current();
    handler();
    el.addEventListener('scroll', handler, { passive: true });
    const ro = new ResizeObserver(handler);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', handler);
      ro.disconnect();
    };
  }, [openFiles.length]);

  return { openPaths, expandedPaths, expandedPathSet, removeOpenPath, removeOpenPathsByPrefix, removeUnselectedOpenPath, removeExpandedPathsByPrefix, setSelectedPath, toggleExpandedPath, expandPaths, toFileNode, openFiles, getOpenFileFolder, selectedFile, selectedFilePath, selectedFilePathRef, selectedFileIsOutsideWorkspace, selectedFileReadOptions, resolveFileReadOptions, editorTabsScrollRef, editorTabsOverflow };
}
