import type {
  Walkthrough,
  WalkthroughChapter,
  WalkthroughHunk,
  WalkthroughResult,
  WalkthroughStop,
} from './types';

/**
 * Flattens a walkthrough plus the current hunk index into the ordered stream
 * the view renders: every stop with its resolved hunks, followed by everything
 * the walkthrough did not cover.
 *
 * Resolution is pure id matching — the server owns hunk identity, so a stop
 * whose hunks are missing is not a bug to paper over, it is a stop whose code
 * has changed.
 */

export interface WalkthroughStopView {
  stop: WalkthroughStop;
  chapter: WalkthroughChapter;
  chapterIndex: number;
  /** Global 1-based position, used for the stepper and keyboard navigation. */
  position: number;
  hunks: WalkthroughHunk[];
  /** Anchors that no longer resolve: their code changed or was removed. */
  missingHunkIds: string[];
  isStale: boolean;
}

export interface WalkthroughView {
  walkthrough: Walkthrough;
  stops: WalkthroughStopView[];
  chapters: Array<{ chapter: WalkthroughChapter; stops: WalkthroughStopView[] }>;
  /** Current hunks no stop covers. Never dropped — rendered as a collapsed tail. */
  uncoveredHunks: WalkthroughHunk[];
  staleStopCount: number;
  isStale: boolean;
}

export const buildWalkthroughView = (result: WalkthroughResult | null): WalkthroughView | null => {
  if (!result?.walkthrough) return null;

  const index = new Map(result.hunks.map((hunk) => [hunk.id, hunk]));
  const covered = new Set<string>();
  const stops: WalkthroughStopView[] = [];
  const chapters: WalkthroughView['chapters'] = [];

  for (const [chapterIndex, chapter] of result.walkthrough.chapters.entries()) {
    const chapterStops: WalkthroughStopView[] = [];

    for (const stop of chapter.stops) {
      const hunks: WalkthroughHunk[] = [];
      const missingHunkIds: string[] = [];

      for (const id of stop.hunkIds) {
        const hunk = index.get(id);
        if (hunk) {
          hunks.push(hunk);
          covered.add(id);
        } else {
          missingHunkIds.push(id);
        }
      }

      const view: WalkthroughStopView = {
        stop,
        chapter,
        chapterIndex,
        position: stops.length + 1,
        hunks,
        missingHunkIds,
        isStale: missingHunkIds.length > 0,
      };
      stops.push(view);
      chapterStops.push(view);
    }

    chapters.push({ chapter, stops: chapterStops });
  }

  return {
    walkthrough: result.walkthrough,
    stops,
    chapters,
    uncoveredHunks: result.hunks.filter((hunk) => !covered.has(hunk.id)),
    staleStopCount: stops.filter((stop) => stop.isStale).length,
    isStale: stops.some((stop) => stop.isStale),
  };
};

/**
 * Files touched by a set of hunks, in first-appearance order, with their
 * per-file totals. Used for the table of contents rows.
 */
export const summarizeHunkFiles = (
  hunks: WalkthroughHunk[]
): Array<{ path: string; added: number; deleted: number }> => {
  const byPath = new Map<string, { path: string; added: number; deleted: number }>();
  for (const hunk of hunks) {
    const existing = byPath.get(hunk.path);
    if (existing) {
      existing.added += hunk.added;
      existing.deleted += hunk.deleted;
      continue;
    }
    byPath.set(hunk.path, { path: hunk.path, added: hunk.added, deleted: hunk.deleted });
  }
  return [...byPath.values()];
};

/**
 * Consecutive hunks from the same file are rendered as one diff block so the
 * reader sees continuous code instead of a stack of one-hunk cards.
 */
export const groupHunksByFile = (
  hunks: WalkthroughHunk[]
): Array<{ path: string; hunks: WalkthroughHunk[] }> => {
  const runs: Array<{ path: string; hunks: WalkthroughHunk[] }> = [];
  for (const hunk of hunks) {
    const last = runs.at(-1);
    if (last && last.path === hunk.path) {
      last.hunks.push(hunk);
      continue;
    }
    runs.push({ path: hunk.path, hunks: [hunk] });
  }
  return runs;
};

/**
 * Merge a file's hunk patches back into one patch so a run renders as a single
 * diff. All hunks in a run share a file header, so only the first one's header
 * is kept.
 */
export const mergeRunPatch = (hunks: WalkthroughHunk[]): string => {
  if (hunks.length === 0) return '';
  if (hunks.length === 1) return hunks[0].patch;

  const first = hunks[0].patch;
  const headerEnd = first.indexOf('\n@@');
  if (headerEnd === -1) return first;

  const header = first.slice(0, headerEnd);
  const bodies = hunks.map((hunk) => {
    const start = hunk.patch.indexOf('\n@@');
    return start === -1 ? '' : hunk.patch.slice(start + 1);
  });

  return `${header}\n${bodies.join('')}`;
};
