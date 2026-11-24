import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitStatus } from '@/lib/api/types';
import type { DiffFindWordRequest, PierreDiffViewerHandle } from '../PierreDiffViewer';
import { isNewStatusFile, isFindRevealFor } from '../diffView/diffData';
import { useDiffViewFind } from '../diffView/useDiffViewFind';
import { useChangedFileStepping } from '../diffView/useChangedFileStepping';
import type { ComparisonDiffResult, DiffData, DiffFindReveal, FileEntry } from '../diffView/types';
import type { ChangesGroupConfig } from './ChangesPanel';
import type { WorkingEntrySelection } from './UnifiedWorkingChangesBody';

type WorkingGroupId = WorkingEntrySelection['groupId'];

const NO_TURN_DIFFS: ReadonlyMap<string, DiffData> = new Map();
const NO_COMPARISON_DIFFS: ReadonlyMap<string, ComparisonDiffResult> = new Map();
const noComparisonDiff = (): Promise<ComparisonDiffResult> => Promise.resolve({ status: 'error', message: 'No comparison in working changes' });
const ignore = () => {};

export function toFileEntry(
  file: GitStatus['files'][number],
  statsScope: 'staged' | 'working',
  diffStats: GitStatus['diffStats'],
): FileEntry {
  const stats = statsScope === 'staged'
    ? diffStats?.staged?.[file.path]
    : diffStats?.working?.[file.path];
  return {
    path: file.path,
    previousPath: file.previousPath,
    index: file.index,
    working_dir: file.working_dir,
    insertions: stats?.insertions ?? 0,
    deletions: stats?.deletions ?? 0,
    isNew: isNewStatusFile(file),
  };
}

export type WorkingEntryFindProps = {
  registerViewerRef: (path: string, handle: PierreDiffViewerHandle | null) => void;
  onFindWordRequest: (path: string, request: DiffFindWordRequest) => void;
  onFullContextChange: (path: string, full: boolean) => void;
  findReveal: DiffFindReveal | null;
};

const GROUP_IDS: readonly WorkingGroupId[] = ['staged', 'unstaged'];
const findKeyPrefix = (groupId: WorkingGroupId) => `${groupId}:`;

const selectionOfFindKey = (key: string): WorkingEntrySelection | null => {
  for (const groupId of GROUP_IDS) {
    const prefix = findKeyPrefix(groupId);
    if (key.startsWith(prefix)) return { groupId, path: key.slice(prefix.length) };
  }
  return null;
};

export function useWorkingDiffNavigation(options: {
  directory: string;
  visible: boolean;
  groups: readonly ChangesGroupConfig[];
  diffStats: GitStatus['diffStats'];
  getLayoutForFile: (path: string) => 'inline' | 'side-by-side';
  diffHideWhitespace: boolean;
  workingTreeRevision: number;
  fileRefreshNonce: ReadonlyMap<string, number>;
  currentEntry: WorkingEntrySelection | null;
  focus: (selection: WorkingEntrySelection) => void;
  expandEntry: (selection: WorkingEntrySelection) => void;
  cancelScrollHold: () => void;
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  const {
    directory, visible, groups, diffStats, getLayoutForFile, diffHideWhitespace,
    workingTreeRevision, fileRefreshNonce, currentEntry, focus, expandEntry, cancelScrollHold, rootRef,
  } = options;
  const { git } = useRuntimeAPIs();

  const [shown, setShown] = React.useState({ visible, count: 0 });
  if (shown.visible !== visible) setShown({ visible, count: shown.count + (visible ? 1 : 0) });

  const { findFiles, findKeys } = React.useMemo(() => {
    const keys = new Map<FileEntry, string>();
    const files = groups.flatMap((group) => group.entries.map((file) => {
      const entry = toFileEntry(file, group.statsScope, diffStats);
      keys.set(entry, `${group.id}:${file.path}`);
      return entry;
    }));
    return { findFiles: files, findKeys: keys };
  }, [diffStats, groups]);
  const findKeyOf = React.useCallback((file: FileEntry) => findKeys.get(file) ?? file.path, [findKeys]);

  const getFileStaged = React.useCallback((key: string) => key.startsWith(findKeyPrefix('staged')), []);
  const getFindLayout = React.useCallback((file: FileEntry) => getLayoutForFile(file.path), [getLayoutForFile]);
  const revealFile = React.useCallback((key: string) => {
    const selection = selectionOfFindKey(key);
    if (selection) expandEntry(selection);
  }, [expandEntry]);
  const scrollToFile = React.useCallback(() => true, []);

  const {
    handleFullContextChange, diffFind, findReveal, registerViewerRef, handleFindWordRequest, findFocusNonce,
  } = useDiffViewFind({
    effectiveDirectory: directory,
    git,
    diffHideWhitespace,
    activeDiffScope: 'working',
    workingTreeRevision: workingTreeRevision + shown.count,
    fileDiffRefreshNonce: fileRefreshNonce,
    displayFile: null,
    setDisplayFile: ignore,
    setDisplayFileStaged: ignore,
    expandStackedFile: revealFile,
    diffRootRef: rootRef,
    lastTurnDiffData: NO_TURN_DIFFS,
    comparisonDiffData: NO_COMPARISON_DIFFS,
    comparisonRangeKey: null,
    loadFullComparisonDiff: undefined,
    fetchComparisonDiffEntry: noComparisonDiff,
    changedFiles: findFiles,
    getLayoutForFile: getFindLayout,
    getFileStaged,
    scrollToFile,
    cancelScrollHold,
    isTreeMode: false,
    visible,
    findKeyOf,
  });

  const groupHandlers = React.useMemo(() => {
    const forGroup = (groupId: WorkingGroupId) => {
      const prefix = findKeyPrefix(groupId);
      const reveal = findReveal && findReveal.key.startsWith(prefix)
        ? { key: findReveal.key.slice(prefix.length), nonce: findReveal.nonce }
        : null;
      return {
        registerViewerRef: (path: string, handle: PierreDiffViewerHandle | null) => registerViewerRef(prefix + path, handle),
        onFindWordRequest: (path: string, request: DiffFindWordRequest) => handleFindWordRequest(prefix + path, request),
        onFullContextChange: (path: string, full: boolean) => handleFullContextChange(prefix + path, full),
        reveal,
      };
    };
    return { staged: forGroup('staged'), unstaged: forGroup('unstaged') };
  }, [findReveal, handleFindWordRequest, handleFullContextChange, registerViewerRef]);

  const findPropsFor = (groupId: WorkingGroupId, path: string): WorkingEntryFindProps => {
    const { reveal, ...handlers } = groupHandlers[groupId];
    return { ...handlers, findReveal: reveal && isFindRevealFor(path, reveal.key) ? reveal : null };
  };

  const stepOrder = React.useMemo(() => groups.flatMap((group) => group.entries.map((file) => ({
    groupId: group.id as WorkingGroupId,
    path: file.path,
  }))), [groups]);
  useChangedFileStepping({
    visible,
    files: stepOrder,
    currentIndex: currentEntry
      ? stepOrder.findIndex((entry) => entry.groupId === currentEntry.groupId && entry.path === currentEntry.path)
      : -1,
    onStep: focus,
  });

  return { diffFind, findFocusNonce, findPropsFor };
}
