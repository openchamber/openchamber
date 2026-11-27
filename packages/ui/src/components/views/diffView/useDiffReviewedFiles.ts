import React from 'react';
import type { GitComparisonFile } from '@/hooks/useGitComparison';
import { useReviewedFilesSubscription } from '@/hooks/useReviewedFiles';
import {
  buildDiffFileFingerprint,
  reviewedFilesScopeKey,
  type ReviewedFileFingerprint,
  type ReviewedFilesScope,
} from '@/lib/reviewedFiles';
import { useReviewedFilesStore } from '@/stores/useReviewedFilesStore';
import { isStagedStatusFile, isWorkingStatusFile } from './diffData';
import type { DiffData, DiffScope, FileEntry } from './types';

const EMPTY_FINGERPRINTS: ReadonlyMap<string, ReviewedFileFingerprint> = new Map();

interface UseDiffReviewedFilesOptions {
  runtimeKey: string;
  directory: string | null | undefined;
  activeDiffScope: DiffScope;
  changedFiles: FileEntry[];
  filesReady: boolean;
  qualifiedBranchBase?: string | null;
  currentBranch?: string | null;
  selectedCommitHash?: string | null;
  selectedPr?: { number: number; sourceRepo?: { owner: string; repo: string } } | null;
  turnSessionId?: string | null;
  turnId?: string;
  comparisonFiles?: ReadonlyArray<GitComparisonFile> | null;
  lastTurnDiffData?: ReadonlyMap<string, DiffData>;
  onAutoUnreviewed?: (paths: string[]) => void;
  onReviewedChange?: (path: string, reviewed: boolean) => void;
}

export function useDiffReviewedFiles({
  runtimeKey,
  directory,
  activeDiffScope,
  changedFiles,
  filesReady,
  qualifiedBranchBase,
  currentBranch,
  selectedCommitHash,
  selectedPr,
  turnSessionId,
  turnId,
  comparisonFiles,
  lastTurnDiffData,
  onAutoUnreviewed,
  onReviewedChange,
}: UseDiffReviewedFilesOptions) {
  const isCombinedWorkingTree = activeDiffScope === 'all';
  const primaryScopeKey = React.useMemo(() => {
    if (!directory) return null;
    let scope: ReviewedFilesScope | null = null;
    if (activeDiffScope === 'all' || activeDiffScope === 'working') {
      scope = { kind: 'working-tree', scope: 'working' };
    } else if (activeDiffScope === 'staged') {
      scope = { kind: 'working-tree', scope: 'staged' };
    } else if (activeDiffScope === 'branch' && qualifiedBranchBase && currentBranch) {
      scope = { kind: 'branch', baseRef: qualifiedBranchBase, headRef: currentBranch };
    } else if (activeDiffScope === 'commit' && selectedCommitHash) {
      scope = { kind: 'commit', hash: selectedCommitHash };
    } else if (activeDiffScope === 'pr' && selectedPr) {
      scope = { kind: 'pr', number: selectedPr.number, sourceRepo: selectedPr.sourceRepo };
    } else if (activeDiffScope === 'turn' && turnSessionId) {
      scope = { kind: 'turn', sessionId: turnSessionId, turnId };
    }
    return scope ? reviewedFilesScopeKey(runtimeKey, directory, scope) : null;
  }, [
    activeDiffScope,
    currentBranch,
    directory,
    qualifiedBranchBase,
    runtimeKey,
    selectedCommitHash,
    selectedPr,
    turnId,
    turnSessionId,
  ]);

  const secondaryScopeKey = React.useMemo(() => {
    if (!directory || !isCombinedWorkingTree) return null;
    return reviewedFilesScopeKey(runtimeKey, directory, { kind: 'working-tree', scope: 'staged' });
  }, [directory, isCombinedWorkingTree, runtimeKey]);

  const comparisonByPath = React.useMemo(() => {
    if (!comparisonFiles?.length) return null;
    return new Map(comparisonFiles.map((file) => [file.path, file]));
  }, [comparisonFiles]);

  const { primaryFingerprints, secondaryFingerprints } = React.useMemo(() => {
    if (isCombinedWorkingTree) {
      const working = new Map<string, ReviewedFileFingerprint>();
      const staged = new Map<string, ReviewedFileFingerprint>();
      for (const file of changedFiles) {
        const fp = buildDiffFileFingerprint(file);
        if (isWorkingStatusFile(file)) working.set(file.path, fp);
        if (isStagedStatusFile(file)) staged.set(file.path, fp);
      }
      return { primaryFingerprints: working, secondaryFingerprints: staged };
    }

    const map = new Map<string, ReviewedFileFingerprint>();
    for (const file of changedFiles) {
      const comp = comparisonByPath?.get(file.path);
      const turnDiff = activeDiffScope === 'turn' ? lastTurnDiffData?.get(file.path) : undefined;
      map.set(
        file.path,
        buildDiffFileFingerprint(file, {
          revision: comp?.revision,
          patch: comp?.patch ?? turnDiff?.patch,
          original: turnDiff?.original,
          modified: turnDiff?.modified,
        }),
      );
    }
    return { primaryFingerprints: map, secondaryFingerprints: EMPTY_FINGERPRINTS };
  }, [activeDiffScope, changedFiles, comparisonByPath, isCombinedWorkingTree, lastTurnDiffData]);

  const primaryLane = React.useMemo(
    () => ({ scopeKey: primaryScopeKey, fingerprints: primaryFingerprints }),
    [primaryFingerprints, primaryScopeKey],
  );
  const secondaryLane = React.useMemo(
    () => (secondaryScopeKey ? { scopeKey: secondaryScopeKey, fingerprints: secondaryFingerprints } : undefined),
    [secondaryFingerprints, secondaryScopeKey],
  );

  const { reviewedPaths, markManualUnmark } = useReviewedFilesSubscription({
    primary: primaryLane,
    secondary: secondaryLane,
    ready: filesReady,
    pruneMissing: true,
    onAutoUnreviewed,
  });

  const toggleReviewed = React.useCallback((path: string, diffData: DiffData | null) => {
    const store = useReviewedFilesStore.getState();
    const currentlyReviewed = reviewedPaths.has(path);
    if (currentlyReviewed) {
      markManualUnmark(path);
      if (primaryScopeKey && primaryFingerprints.has(path)) store.unmarkReviewed(primaryScopeKey, path);
      if (secondaryScopeKey && secondaryFingerprints.has(path)) store.unmarkReviewed(secondaryScopeKey, path);
      onReviewedChange?.(path, false);
      return;
    }

    const file = changedFiles.find((entry) => entry.path === path);
    const defaultContextPatch = diffData?.contextMode !== 'full' ? diffData?.patch : undefined;
    const enrich = (fallback: ReviewedFileFingerprint) => (
      file && defaultContextPatch !== undefined
        ? buildDiffFileFingerprint(file, {
          revision: comparisonByPath?.get(path)?.revision,
          patch: defaultContextPatch ?? comparisonByPath?.get(path)?.patch,
        })
        : fallback
    );

    if (primaryScopeKey && primaryFingerprints.has(path)) {
      store.markReviewed(primaryScopeKey, path, enrich(primaryFingerprints.get(path)!));
    }
    if (secondaryScopeKey && secondaryFingerprints.has(path)) {
      store.markReviewed(secondaryScopeKey, path, enrich(secondaryFingerprints.get(path)!));
    }
    onReviewedChange?.(path, true);
  }, [
    changedFiles,
    comparisonByPath,
    markManualUnmark,
    onReviewedChange,
    primaryFingerprints,
    primaryScopeKey,
    reviewedPaths,
    secondaryFingerprints,
    secondaryScopeKey,
  ]);

  return {
    reviewedPaths,
    toggleReviewed,
  };
}
