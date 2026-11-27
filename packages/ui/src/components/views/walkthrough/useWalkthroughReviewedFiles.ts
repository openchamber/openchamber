import { useCallback, useMemo, useState } from 'react';
import { useReviewedFilesSubscription } from '@/hooks/useReviewedFiles';
import {
  buildWalkthroughFileFingerprints,
  buildWalkthroughWorkingTreeFingerprints,
  reviewedFilesScopeFromWalkthrough,
  reviewedFilesScopeKey,
  type ReviewedFileFingerprint,
} from '@/lib/reviewedFiles';
import type { Walkthrough, WalkthroughResult, WalkthroughSource } from '@/lib/walkthrough/types';
import type { WalkthroughView } from '@/lib/walkthrough/model';
import { useGitStore } from '@/stores/useGitStore';
import { useReviewedFilesStore } from '@/stores/useReviewedFilesStore';

const EMPTY_STOP_IDS: ReadonlySet<string> = new Set();
const EMPTY_FINGERPRINTS: ReadonlyMap<string, ReviewedFileFingerprint> = new Map();

export function useWalkthroughReviewedFiles({
  directory,
  source,
  result,
  view,
}: {
  directory: string;
  source: WalkthroughSource;
  result: WalkthroughResult | null;
  view: WalkthroughView | null;
}) {
  const runtimeKey = useGitStore((state) => state.runtimeKey);
  const isCombinedWorkingTree = source.kind === 'working-tree' && source.scope === 'all';
  const primaryScopeKey = useMemo(() => {
    if (!directory) return null;
    if (isCombinedWorkingTree) {
      return reviewedFilesScopeKey(runtimeKey, directory, { kind: 'working-tree', scope: 'working' });
    }
    return reviewedFilesScopeKey(runtimeKey, directory, reviewedFilesScopeFromWalkthrough(source));
  }, [directory, isCombinedWorkingTree, runtimeKey, source]);

  const secondaryScopeKey = useMemo(() => {
    if (!directory || !isCombinedWorkingTree) return null;
    return reviewedFilesScopeKey(runtimeKey, directory, { kind: 'working-tree', scope: 'staged' });
  }, [directory, isCombinedWorkingTree, runtimeKey]);

  const hunks = result?.hunks;
  const { primaryFingerprints, secondaryFingerprints, totalFileCount } = useMemo(() => {
    if (!hunks?.length) {
      return { primaryFingerprints: EMPTY_FINGERPRINTS, secondaryFingerprints: EMPTY_FINGERPRINTS, totalFileCount: 0 };
    }
    if (isCombinedWorkingTree) {
      const split = buildWalkthroughWorkingTreeFingerprints(hunks);
      const uniquePaths = new Set([...split.working.keys(), ...split.staged.keys()]);
      return {
        primaryFingerprints: split.working,
        secondaryFingerprints: split.staged,
        totalFileCount: uniquePaths.size,
      };
    }
    const map = buildWalkthroughFileFingerprints(hunks);
    return { primaryFingerprints: map, secondaryFingerprints: EMPTY_FINGERPRINTS, totalFileCount: map.size };
  }, [hunks, isCombinedWorkingTree]);

  const primaryLane = useMemo(
    () => ({ scopeKey: primaryScopeKey, fingerprints: primaryFingerprints }),
    [primaryFingerprints, primaryScopeKey],
  );
  const secondaryLane = useMemo(
    () => (secondaryScopeKey ? { scopeKey: secondaryScopeKey, fingerprints: secondaryFingerprints } : undefined),
    [secondaryFingerprints, secondaryScopeKey],
  );

  const { reviewedPaths } = useReviewedFilesSubscription({
    primary: primaryLane,
    secondary: secondaryLane,
    ready: Boolean(result?.walkthrough),
    pruneMissing: false,
  });

  const toggleFileReviewed = useCallback((path: string) => {
    const store = useReviewedFilesStore.getState();
    const currentlyReviewed = reviewedPaths.has(path);
    if (currentlyReviewed) {
      if (primaryScopeKey && primaryFingerprints.has(path)) store.unmarkReviewed(primaryScopeKey, path);
      if (secondaryScopeKey && secondaryFingerprints.has(path)) store.unmarkReviewed(secondaryScopeKey, path);
      return;
    }
    if (primaryScopeKey && primaryFingerprints.has(path)) {
      store.markReviewed(primaryScopeKey, path, primaryFingerprints.get(path)!);
    }
    if (secondaryScopeKey && secondaryFingerprints.has(path)) {
      store.markReviewed(secondaryScopeKey, path, secondaryFingerprints.get(path)!);
    }
  }, [primaryFingerprints, primaryScopeKey, reviewedPaths, secondaryFingerprints, secondaryScopeKey]);

  const walkthroughIdentity = view?.walkthrough ?? null;
  const [collapsedState, setCollapsedState] = useState<{ walkthrough: Walkthrough | null; ids: Set<string> }>(() => ({
    walkthrough: walkthroughIdentity,
    ids: new Set(),
  }));
  const collapsedStopIds = collapsedState.walkthrough === walkthroughIdentity ? collapsedState.ids : EMPTY_STOP_IDS;

  const toggleStopCollapsed = useCallback((stopId: string) => {
    setCollapsedState((previous) => {
      const base = previous.walkthrough === walkthroughIdentity ? previous.ids : EMPTY_STOP_IDS;
      const next = new Set(base);
      if (next.has(stopId)) next.delete(stopId);
      else next.add(stopId);
      return { walkthrough: walkthroughIdentity, ids: next };
    });
  }, [walkthroughIdentity]);

  const expandStop = useCallback((stopId: string) => {
    setCollapsedState((previous) => {
      const base = previous.walkthrough === walkthroughIdentity ? previous.ids : EMPTY_STOP_IDS;
      if (!base.has(stopId)) return previous;
      const next = new Set(base);
      next.delete(stopId);
      return { walkthrough: walkthroughIdentity, ids: next };
    });
  }, [walkthroughIdentity]);

  const allStopsCollapsed = Boolean(
    view && view.stops.length > 0 && view.stops.every((stopView) => collapsedStopIds.has(stopView.stop.id)),
  );

  const toggleAllStopsCollapsed = useCallback(() => {
    if (!view || view.stops.length === 0) return;
    setCollapsedState((previous) => {
      const base = previous.walkthrough === walkthroughIdentity ? previous.ids : EMPTY_STOP_IDS;
      const everyCollapsed = view.stops.every((stopView) => base.has(stopView.stop.id));
      return {
        walkthrough: walkthroughIdentity,
        ids: everyCollapsed ? new Set() : new Set(view.stops.map((stopView) => stopView.stop.id)),
      };
    });
  }, [view, walkthroughIdentity]);

  return {
    reviewedPaths,
    totalFileCount,
    toggleFileReviewed,
    collapsedStopIds,
    toggleStopCollapsed,
    expandStop,
    allStopsCollapsed,
    toggleAllStopsCollapsed,
  };
}
