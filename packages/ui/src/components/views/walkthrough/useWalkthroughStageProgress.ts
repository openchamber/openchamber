import { useEffect, useRef, useState } from 'react';
import type { WalkthroughStage } from '@/lib/walkthrough/types';


const ORDER: WalkthroughStage[] = ['collecting', 'asking', 'assembling'];
const MIN_STEP_MS = 450;

const indexOfStage = (stage: WalkthroughStage | null): number => {
  if (stage === 'retrying') return ORDER.indexOf('asking');
  return stage ? ORDER.indexOf(stage) : -1;
};

const nextIndex = (current: number, target: number): number => Math.min(current + 1, target);

export interface WalkthroughStageProgress {
  completedCount: number;
  activeIndex: number | null;
  holding: boolean;
}

export const useWalkthroughStageProgress = (
  stage: WalkthroughStage | null,
  active: boolean
): WalkthroughStageProgress => {
  const [shownIndex, setShownIndex] = useState(-1);
  const shownAtRef = useRef(0);

  const target = active ? Math.max(indexOfStage(stage), 0) : (shownIndex < 0 ? -1 : ORDER.length);

  useEffect(() => {
    if (target <= shownIndex) {
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
