import React from 'react';
import type { GitAPI } from '@/lib/api/types';
import { buildDiffTreeRows } from '../diffFileTree';
import { isFindRevealFor } from '../diffView/diffData';
import { useDiffViewFind } from '../diffView/useDiffViewFind';
import { useChangedFileStepping } from '../diffView/useChangedFileStepping';
import type { ComparisonDiffResult, DiffData, DiffScope, FileEntry } from '../diffView/types';

const NO_REFRESH_NONCE: ReadonlyMap<string, number> = new Map();
const ignore = () => {};
const notStaged = () => false;
const noScroll = () => true;

export function useReviewScopeDiffNavigation(options: {
  directory: string | undefined;
  git: GitAPI;
  visible: boolean;
  filesShown: boolean;
  isWide: boolean;
  scope: DiffScope;
  changedFiles: FileEntry[];
  currentPath: string | null;
  reveal: (path: string) => void;
  getLayoutForFile: (path: string) => 'inline' | 'side-by-side';
  diffHideWhitespace: boolean;
  lastTurnDiffData: ReadonlyMap<string, DiffData>;
  comparisonDiffData: ReadonlyMap<string, ComparisonDiffResult>;
  comparisonRangeKey: string | null;
  loadFullComparisonDiff: ((path: string) => Promise<ComparisonDiffResult>) | undefined;
  fetchComparisonDiffEntry: (path: string, fullContext?: boolean) => Promise<ComparisonDiffResult>;
}) {
  const {
    directory, git, visible: panelVisible, filesShown, isWide, scope, changedFiles, currentPath, reveal, getLayoutForFile,
    diffHideWhitespace, lastTurnDiffData, comparisonDiffData, comparisonRangeKey, loadFullComparisonDiff, fetchComparisonDiffEntry,
  } = options;
  const visible = panelVisible && filesShown;
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const getFindLayout = React.useCallback((file: FileEntry) => getLayoutForFile(file.path), [getLayoutForFile]);

  const {
    handleFullContextChange, diffFind, findReveal, registerViewerRef, handleFindWordRequest, findFocusNonce,
  } = useDiffViewFind({
    effectiveDirectory: directory,
    git,
    diffHideWhitespace,
    activeDiffScope: scope,
    workingTreeRevision: 0,
    fileDiffRefreshNonce: NO_REFRESH_NONCE,
    displayFile: null,
    setDisplayFile: ignore,
    setDisplayFileStaged: ignore,
    expandStackedFile: reveal,
    diffRootRef: rootRef,
    lastTurnDiffData,
    comparisonDiffData,
    comparisonRangeKey,
    loadFullComparisonDiff,
    fetchComparisonDiffEntry,
    changedFiles,
    getLayoutForFile: getFindLayout,
    getFileStaged: notStaged,
    scrollToFile: noScroll,
    isTreeMode: false,
    visible,
  });

  const { close: closeFind } = diffFind;
  React.useEffect(() => {
    if (!filesShown) closeFind();
  }, [closeFind, filesShown]);

  const stepFiles = React.useMemo(() => (isWide
    ? buildDiffTreeRows(changedFiles, new Set()).flatMap((row) => (row.kind === 'file' ? [row.file] : []))
    : changedFiles), [changedFiles, isWide]);
  useChangedFileStepping({
    visible,
    files: stepFiles,
    currentIndex: currentPath ? stepFiles.findIndex((file) => file.path === currentPath) : -1,
    onStep: (file) => reveal(file.path),
  });

  const findPropsFor = (path: string) => ({
    registerViewerRef,
    onFindWordRequest: handleFindWordRequest,
    onFullContextChange: handleFullContextChange,
    findReveal: findReveal && isFindRevealFor(path, findReveal.key) ? findReveal : null,
  });

  return { rootRef, diffFind, findFocusNonce, findPropsFor };
}
