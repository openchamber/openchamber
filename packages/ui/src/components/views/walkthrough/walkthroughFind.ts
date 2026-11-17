import type { FileDiffMetadata } from '@pierre/diffs';

import type { DiffFindLayout, DiffFindSource } from '@/components/views/diffFind/useDiffFind';
import { fileDiffFromPatch } from '@/lib/diff/patchFileDiff';
import { groupHunksByFile, mergeRunPatch, type WalkthroughView } from '@/lib/walkthrough/model';
import type { WalkthroughHunk } from '@/lib/walkthrough/types';

interface WalkthroughFindRun {
  key: string;
  stopId: string;
  path: string;
  hunks: WalkthroughHunk[];
}

export const findRunKey = (stopId: string, runIndex: number, hunks: readonly WalkthroughHunk[]): string =>
  `${stopId}::${runIndex}::${hunks.map((hunk) => hunk.id).join(',')}`;

export const UNCOVERED_STOP_ID = '__uncovered__';

const runsForStop = (stopId: string, hunks: WalkthroughHunk[]): WalkthroughFindRun[] =>
  groupHunksByFile(hunks).map((run, index) => ({
    key: findRunKey(stopId, index, run.hunks),
    stopId,
    path: run.path,
    hunks: run.hunks,
  }));

export const enumerateFindRuns = (view: WalkthroughView): WalkthroughFindRun[] => [
  ...view.stops.flatMap((stopView) => runsForStop(stopView.stop.id, stopView.hunks)),
  ...runsForStop(UNCOVERED_STOP_ID, view.uncoveredHunks),
];

const loadRunDiff = (run: WalkthroughFindRun): FileDiffMetadata | null => {
  const patch = mergeRunPatch(run.hunks);
  return patch ? fileDiffFromPatch(run.path, patch) : null;
};

export const buildFindSources = (
  runs: readonly WalkthroughFindRun[],
  layout: DiffFindLayout,
): Array<Omit<DiffFindSource, 'load'> & { load: () => Promise<FileDiffMetadata | null> }> =>
  runs.map((run) => ({
    filePath: run.key,
    layout,
    load: async () => loadRunDiff(run),
  }));
