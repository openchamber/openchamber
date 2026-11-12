import { useCallback, useMemo, useState, type RefObject } from 'react';

import { useDiffFind, type DiffFindLayout } from '@/components/views/diffFind/useDiffFind';
import { useDiffFindSurface } from '@/components/views/diffFind/useDiffFindSurface';
import type { DiffFindMatch } from '@/lib/diff/diffFind';
import type { WalkthroughView } from '@/lib/walkthrough/model';

import { buildFindSources, enumerateFindRuns, UNCOVERED_STOP_ID } from './walkthroughFind';

interface UseWalkthroughFindOptions {
  view: WalkthroughView | null;
  renderSideBySide: boolean;
  visible: boolean;
  rootRef: RefObject<HTMLElement | null>;
  /** Make a stop the active one and scroll to it. */
  selectStop: (stopId: string) => void;
  /** Make a stop the active one where it is. */
  markStopActive: (stopId: string) => void;
}

/**
 * Find across a walkthrough. Every run is a search source: one file's
 * consecutive hunks inside one stop. Two stops that touch one file are two runs
 * with two keys, so their partial diffs never collide. A run parses lazily, so
 * a closed bar costs nothing; the layout is part of the source set, so a toggle
 * re-runs matching.
 */
export const useWalkthroughFind = ({ view, renderSideBySide, visible, rootRef, selectStop, markStopActive }: UseWalkthroughFindOptions) => {
  const runs = useMemo(() => (view ? enumerateFindRuns(view) : []), [view]);
  const layout: DiffFindLayout = renderSideBySide ? 'side-by-side' : 'inline';
  const sources = useMemo(() => buildFindSources(runs, layout), [layout, runs]);
  const find = useDiffFind({ sources });

  const runByKey = useMemo(() => new Map(runs.map((run) => [run.key, run])), [runs]);
  // Bumped to open the uncovered tail, whose runs mount only while it is open.
  const [uncoveredOpenRequest, setUncoveredOpenRequest] = useState(0);
  // A mounted run is reached by the line scroll alone: the stop-level jump
  // would pin the stop's header to the top and hold it there, away from a
  // match deep in a long stop.
  const reveal = useCallback((match: DiffFindMatch, viewerMounted: boolean) => {
    const run = runByKey.get(match.filePath);
    if (!run) return;
    if (run.stopId === UNCOVERED_STOP_ID) {
      if (!viewerMounted) setUncoveredOpenRequest((request) => request + 1);
      return;
    }
    if (viewerMounted) markStopActive(run.stopId);
    else selectStop(run.stopId);
  }, [markStopActive, runByKey, selectStop]);

  const surface = useDiffFindSurface({ find, visible, rootRef, reveal });
  return { find, uncoveredOpenRequest, ...surface };
};
