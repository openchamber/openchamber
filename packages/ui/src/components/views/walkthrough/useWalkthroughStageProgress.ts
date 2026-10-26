import { useEffect, useRef, useState } from 'react';
import type { WalkthroughStage } from '@/lib/walkthrough/types';

/**
 * Paces the stage display so every step is actually seen.
 *
 * Assembling the walkthrough takes milliseconds, so on the real timeline it
 * flickers past between "waiting on the model" and the finished result — the
 * user is told about a step they never observe, which is worse than not
 * naming it. Each step is therefore held for a floor before the next one is
 * revealed, including the final all-done state.
 *
 * This delays the result by well under a second at the end of a wait measured
 * in minutes, and buys a legible finish in exchange.
 */

const ORDER: WalkthroughStage[] = ['collecting', 'asking', 'assembling'];
const MIN_STEP_MS = 450;

/** `retrying` is the same wait from the user's side: still waiting on the model. */
const indexOfStage = (stage: WalkthroughStage | null): number => {
  if (stage === 'retrying') return ORDER.indexOf('asking');
  return stage ? ORDER.indexOf(stage) : -1;
};

/** One step at a time, so a fast stage is still shown rather than skipped. */
const nextIndex = (current: number, target: number): number => Math.min(current + 1, target);

export interface WalkthroughStageProgress {
  /** Steps to render as finished. */
  completedCount: number;
  /** Step to render as running, or `null` when everything is done. */
  activeIndex: number | null;
  /** True while the display still owes the user time after the work finished. */
  holding: boolean;
}

export const useWalkthroughStageProgress = (
  stage: WalkthroughStage | null,
  active: boolean
): WalkthroughStageProgress => {
  // `ORDER.length` means "all done"; -1 means nothing started.
  const [shownIndex, setShownIndex] = useState(-1);
  const shownAtRef = useRef(0);

  const target = active ? Math.max(indexOfStage(stage), 0) : (shownIndex < 0 ? -1 : ORDER.length);

  useEffect(() => {
    if (target <= shownIndex) {
      // Work restarted: fall back to the earlier step immediately rather than
      // pretending the later one is still running.
      if (target < shownIndex && active) {
        setShownIndex(target);
        shownAtRef.current = Date.now();
      }
      return;
    }

    const elapsed = Date.now() - shownAtRef.current;
    const advance = () => {
      shownAtRef.current = Date.now();
      setShownIndex((current) => nextIndex(current, target));
    };

    if (shownIndex < 0 || elapsed >= MIN_STEP_MS) {
      advance();
      return;
    }

    const timer = setTimeout(advance, MIN_STEP_MS - elapsed);
    return () => clearTimeout(timer);
  }, [active, shownIndex, target]);

  // A fresh run resets the display so the next generation starts from the top.
  useEffect(() => {
    if (active || shownIndex < ORDER.length) return;
    const timer = setTimeout(() => setShownIndex(-1), MIN_STEP_MS);
    return () => clearTimeout(timer);
  }, [active, shownIndex]);

  const done = shownIndex >= ORDER.length;

  return {
    completedCount: Math.max(0, Math.min(shownIndex, ORDER.length)),
    activeIndex: done || shownIndex < 0 ? null : shownIndex,
    holding: !active && shownIndex >= 0,
  };
};

export const WALKTHROUGH_STAGE_ORDER = ORDER;

export const __testing = { indexOfStage, nextIndex };
