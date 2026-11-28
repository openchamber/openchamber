import React from 'react';
import type { GitStatus } from '@/lib/api/types';
import type { GitComparisonFile } from '@/hooks/useGitComparison';
import { LIST_ROUTE, type ChangesMode, type ChangesRoute } from '@/hooks/useMobileChangesNavigation';
import { useUIStore } from '@/stores/useUIStore';
import { fileDiffFromPatch, isBinaryPatch } from '@/lib/diff/patchFileDiff';
import { statusToGitCode, type TurnSnapshotDiff } from '@/components/views/turnSnapshotDiff';
import { toWorkingFileEntry } from '@/components/views/diffView/diffData';
import type { DiffData } from '@/components/views/diffView/types';
import { useDiffReviewedFiles } from '@/components/views/diffView/useDiffReviewedFiles';
import type { ChangesGroupConfig } from '@/components/views/git/ChangesPanel';
import { changesTreeFileOrder } from '@/components/views/git/changesTree';

export function useMobileTurnFiles(diffs: TurnSnapshotDiff[]) {
  return React.useMemo(() => {
    const files: GitComparisonFile[] = [];
    const data = new Map<string, DiffData>();
    for (const diff of diffs) {
      if (!diff.file) continue;
      files.push({
        path: diff.file,
        status: statusToGitCode(diff.status),
        insertions: diff.additions ?? 0,
        deletions: diff.deletions ?? 0,
      });
      if (typeof diff.patch === 'string') {
        const isBinary = isBinaryPatch(diff.patch);
        data.set(diff.file, {
          original: '',
          modified: '',
          patch: diff.patch,
          isBinary,
          fileDiff: isBinary ? undefined : fileDiffFromPatch(diff.file, diff.patch, { complete: true }),
        });
      } else {
        data.set(diff.file, { original: diff.before ?? '', modified: diff.after ?? '' });
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, data };
  }, [diffs]);
}

type ComparisonReviewInput = Omit<Parameters<typeof useDiffReviewedFiles>[0], 'runtimeKey' | 'changedFiles'>;

export function useMobileChangesReview({
  runtimeKey, directory, mode, status, stagedFiles, workingFiles, groups, selectedDiff,
  comparison, setRoute, clearCommentTargets,
}: {
  runtimeKey: string;
  directory: string;
  mode: ChangesMode;
  status: GitStatus | null;
  stagedFiles: GitStatus['files'];
  workingFiles: GitStatus['files'];
  groups: ChangesGroupConfig[];
  selectedDiff: DiffData | null;
  comparison: ComparisonReviewInput & { files: GitComparisonFile[] | null; key: string | null };
  setRoute: (route: ChangesRoute) => void;
  clearCommentTargets: () => void;
}) {
  const [unreviewedOnly, setUnreviewedOnly] = React.useState(false);
  const changesInTreeOrder = useUIStore((state) => state.gitChangesViewMode === 'tree');
  const diffStats = status?.diffStats;
  const stagedReviewFiles = React.useMemo(() => stagedFiles.map((file) => toWorkingFileEntry(file, 'staged', diffStats)), [stagedFiles, diffStats]);
  const workingReviewFiles = React.useMemo(() => workingFiles.map((file) => toWorkingFileEntry(file, 'working', diffStats)), [workingFiles, diffStats]);
  const staged = useDiffReviewedFiles({
    runtimeKey, directory, activeDiffScope: 'staged', changedFiles: stagedReviewFiles, filesReady: status !== null,
  });
  const working = useDiffReviewedFiles({
    runtimeKey, directory, activeDiffScope: 'working', changedFiles: workingReviewFiles, filesReady: status !== null,
  });
  const comparisonReviewFiles = React.useMemo(
    () => (comparison.files ?? []).map((file) => ({ ...file, index: '', working_dir: file.status, isNew: file.status === 'A' })),
    [comparison.files],
  );
  const compared = useDiffReviewedFiles({ ...comparison, runtimeKey, changedFiles: comparisonReviewFiles });
  const shownChangeGroups = React.useMemo(
    () => unreviewedOnly ? groups.map((group) => {
      const paths = group.id === 'staged' ? staged.reviewedPaths : working.reviewedPaths;
      return { ...group, entries: group.entries.filter((file) => !paths.has(file.path)) };
    }).filter((group) => group.entries.length > 0) : groups,
    [groups, staged.reviewedPaths, unreviewedOnly, working.reviewedPaths],
  );
  const finishReviewStep = () => {
    if (unreviewedOnly) setRoute(LIST_ROUTE);
  };
  const toggleWorkingReview = (path: string, isStaged: boolean) => {
    const review = isStaged ? staged : working;
    review.toggleReviewed(path, selectedDiff);
    if (review.reviewedPaths.has(path)) return;
    const order = groups.flatMap((group) => {
      const entries = changesInTreeOrder ? changesTreeFileOrder(group.entries) : group.entries;
      return entries.map((entry) => ({ path: entry.path, staged: group.id === 'staged' }));
    });
    const index = order.findIndex((entry) => entry.path === path && entry.staged === isStaged);
    const next = order.find((entry, position) => position > index
      && !(entry.staged ? staged : working).reviewedPaths.has(entry.path));
    if (next) setRoute({ type: 'diff', ...next });
    else finishReviewStep();
  };
  const toggleComparisonReview = (path: string) => {
    compared.toggleReviewed(path, null);
    if (compared.reviewedPaths.has(path)) return;
    const index = comparison.files?.findIndex((entry) => entry.path === path) ?? -1;
    const next = comparison.files?.find((entry, position) => position > index && !compared.reviewedPaths.has(entry.path));
    clearCommentTargets();
    if (next && mode === 'turn') setRoute({ type: 'turn', path: next.path });
    else if (next && comparison.key) setRoute({ type: 'comparison', path: next.path, sourceKey: comparison.key });
    else finishReviewStep();
  };
  return {
    unreviewedOnly, setUnreviewedOnly, shownChangeGroups, toggleWorkingReview, toggleComparisonReview,
    isWorkingReviewed: (path: string, isStaged: boolean) => (isStaged ? staged : working).reviewedPaths.has(path),
    comparisonReviewedPaths: compared.reviewedPaths,
  };
}
