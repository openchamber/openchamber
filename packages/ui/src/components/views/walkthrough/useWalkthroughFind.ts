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
  selectStop: (stopId: string) => void;
  markStopActive: (stopId: string) => void;
}

export const useWalkthroughFind = ({ view, renderSideBySide, visible, rootRef, selectStop, markStopActive }: UseWalkthroughFindOptions) => {
  const runs = useMemo(() => (view ? enumerateFindRuns(view) : []), [view]);
  const layout: DiffFindLayout = renderSideBySide ? 'side-by-side' : 'inline';
  const sources = useMemo(() => buildFindSources(runs, layout), [layout, runs]);
  const find = useDiffFind({ sources });

  const runByKey = useMemo(() => new Map(runs.map((run) => [run.key, run])), [runs]);
  const [uncoveredOpenRequest, setUncoveredOpenRequest] = useState(0);
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
