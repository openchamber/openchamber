import { useEffect, useMemo, useRef } from 'react';
import {
  doesReviewedFingerprintMatch,
  type ReviewedFileFingerprint,
} from '@/lib/reviewedFiles';
import {
  selectReviewedFilesForScope,
  useReviewedFilesStore,
} from '@/stores/useReviewedFilesStore';

export interface ReviewedFilesLane {
  scopeKey: string | null;
  fingerprints: ReadonlyMap<string, ReviewedFileFingerprint>;
}

export function useReviewedFilesSubscription({
  primary,
  secondary,
  ready,
  pruneMissing,
  onAutoUnreviewed,
}: {
  primary: ReviewedFilesLane;
  secondary?: ReviewedFilesLane;
  ready: boolean;
  pruneMissing: boolean;
  onAutoUnreviewed?: (paths: string[]) => void;
}) {
  const primaryStored = useReviewedFilesStore(selectReviewedFilesForScope(primary.scopeKey));
  const secondaryStored = useReviewedFilesStore(selectReviewedFilesForScope(secondary?.scopeKey ?? null));
  const onAutoUnreviewedRef = useRef(onAutoUnreviewed);
  onAutoUnreviewedRef.current = onAutoUnreviewed;
  const manualUnmarkedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!ready) return;
    const store = useReviewedFilesStore.getState();
    const invalidated: string[] = [];
    if (primary.scopeKey) {
      invalidated.push(...store.reconcileScope(primary.scopeKey, primary.fingerprints, { pruneMissing }));
    }
    if (secondary?.scopeKey) {
      invalidated.push(...store.reconcileScope(secondary.scopeKey, secondary.fingerprints, { pruneMissing }));
    }
    if (invalidated.length > 0) {
      onAutoUnreviewedRef.current?.([...new Set(invalidated)]);
    }
  }, [primary.fingerprints, primary.scopeKey, pruneMissing, ready, secondary?.fingerprints, secondary?.scopeKey]);

  const reviewedPaths = useMemo(() => {
    const next = new Set<string>();
    const allPaths = new Set<string>(primary.fingerprints.keys());
    if (secondary) {
      for (const path of secondary.fingerprints.keys()) allPaths.add(path);
    }
    for (const path of allPaths) {
      const pCurrent = primary.fingerprints.get(path);
      const sCurrent = secondary?.fingerprints.get(path);
      const pOk = !pCurrent || (
        primaryStored[path] !== undefined && doesReviewedFingerprintMatch(primaryStored[path], pCurrent)
      );
      const sOk = !sCurrent || (
        secondaryStored[path] !== undefined && doesReviewedFingerprintMatch(secondaryStored[path], sCurrent)
      );
      if ((pCurrent || sCurrent) && pOk && sOk) {
        next.add(path);
      }
    }
    return next;
  }, [primary.fingerprints, primaryStored, secondary, secondaryStored]);

  const combinedScopeKey = `${primary.scopeKey ?? ''}\0${secondary?.scopeKey ?? ''}`;
  const prevStateRef = useRef<{ scopeKey: string; reviewed: ReadonlySet<string> }>({
    scopeKey: combinedScopeKey,
    reviewed: reviewedPaths,
  });

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = { scopeKey: combinedScopeKey, reviewed: reviewedPaths };
    if (prev.scopeKey !== combinedScopeKey || !ready) {
      manualUnmarkedRef.current.clear();
      return;
    }
    const autoCleared: string[] = [];
    for (const path of prev.reviewed) {
      if (reviewedPaths.has(path)) continue;
      if (manualUnmarkedRef.current.delete(path)) continue;
      if (primary.fingerprints.has(path) || secondary?.fingerprints.has(path)) {
        autoCleared.push(path);
      }
    }
    if (autoCleared.length > 0) {
      onAutoUnreviewedRef.current?.(autoCleared);
    }
  }, [combinedScopeKey, primary.fingerprints, ready, reviewedPaths, secondary?.fingerprints]);

  const markManualUnmark = (path: string) => {
    manualUnmarkedRef.current.add(path);
  };

  return {
    reviewedPaths,
    markManualUnmark,
  };
}
