import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { DiffFindSide } from '@/lib/diff/diffFind';
import { applyFindHighlightsToContainer } from './findHighlights';

type FindMatchSpans = ReadonlyArray<{ lineNumber: number; side: DiffFindSide; spanStart: number; spanLength: number }>;

export const useFindHighlights = (diffContainerRef: RefObject<HTMLDivElement | null>) => {
  const findMatchesRef = useRef<ReadonlyArray<{ lineNumber: number; side: DiffFindSide; spanStart: number; spanLength: number }>>([]);
  const findCurrentIndexRef = useRef(-1);

  const shadowObserverRef = useRef<MutationObserver | null>(null);
  const scheduleShadowPassRef = useRef<(() => void) | null>(null);
  const applyFindHighlights = useCallback(() => {
    const observer = shadowObserverRef.current;
    const pending = observer?.takeRecords() ?? [];
    applyFindHighlightsToContainer(diffContainerRef.current, findMatchesRef.current, findCurrentIndexRef.current);
    observer?.takeRecords();
    if (pending.length > 0) scheduleShadowPassRef.current?.();
  }, [diffContainerRef]);

  const setFindHighlights = useCallback((
    matches: ReadonlyArray<{ lineNumber: number; side: DiffFindSide; spanStart: number; spanLength: number }>,
    currentIndex: number,
  ) => {
    findMatchesRef.current = matches;
    findCurrentIndexRef.current = currentIndex;
    applyFindHighlights();
  }, [applyFindHighlights]);

  return { findMatchesRef, shadowObserverRef, scheduleShadowPassRef, applyFindHighlights, setFindHighlights };
};

interface ShadowRootPassInput {
  diffContainerRef: RefObject<HTMLDivElement | null>;
  forceUpdate: () => void;
  applyFindHighlights: () => void;
  findMatchesRef: RefObject<FindMatchSpans>;
  shadowObserverRef: RefObject<MutationObserver | null>;
  scheduleShadowPassRef: RefObject<(() => void) | null>;
  diffThemeKey: string;
  fileName: string | undefined;
}

export const useShadowRootPass = ({
  diffContainerRef,
  forceUpdate,
  applyFindHighlights,
  findMatchesRef,
  shadowObserverRef,
  scheduleShadowPassRef,
  diffThemeKey,
  fileName,
}: ShadowRootPassInput): void => {
  useEffect(() => {
    const container = diffContainerRef.current;
    if (!container) return;

    let observer: MutationObserver | null = null;
    let rafId: number | null = null;

    const setupObserver = () => {
      const diffsContainer = container.querySelector('diffs-container');
      if (!(diffsContainer instanceof HTMLElement)) return;

      const shadowRoot = diffsContainer.shadowRoot;

      const schedulePass = () => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(() => {
          rafId = null;
          forceUpdate();
          if (findMatchesRef.current.length > 0) applyFindHighlights();
        });
      };
      observer = new MutationObserver(schedulePass);
      shadowObserverRef.current = observer;
      scheduleShadowPassRef.current = schedulePass;

      observer.observe(diffsContainer, { childList: true, subtree: true });
      if (shadowRoot) {
        observer.observe(shadowRoot, { childList: true, subtree: true });
      }
    };

    const timeoutId = setTimeout(setupObserver, 100);

    return () => {
      clearTimeout(timeoutId);
      if (rafId) cancelAnimationFrame(rafId);
      observer?.disconnect();
      if (shadowObserverRef.current === observer) {
        shadowObserverRef.current = null;
        scheduleShadowPassRef.current = null;
      }
    };
  }, [applyFindHighlights, diffContainerRef, diffThemeKey, fileName, findMatchesRef, forceUpdate, scheduleShadowPassRef, shadowObserverRef]);
};
