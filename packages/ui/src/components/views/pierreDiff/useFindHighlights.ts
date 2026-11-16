import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { DiffFindSide } from '@/lib/diff/diffFind';
import { applyFindHighlightsToContainer } from './findHighlights';

type FindMatchSpans = ReadonlyArray<{ lineNumber: number; side: DiffFindSide; spanStart: number; spanLength: number }>;

export const useFindHighlights = (diffContainerRef: RefObject<HTMLDivElement | null>) => {
  const findMatchesRef = useRef<ReadonlyArray<{ lineNumber: number; side: DiffFindSide; spanStart: number; spanLength: number }>>([]);
  const findCurrentIndexRef = useRef(-1);

  // The shadow-root observer below, and its pass, shared so highlight surgery
  // can keep its own mutations out of the observer.
  const shadowObserverRef = useRef<MutationObserver | null>(null);
  const scheduleShadowPassRef = useRef<(() => void) | null>(null);
  const applyFindHighlights = useCallback(() => {
    const observer = shadowObserverRef.current;
    // Records queued before the surgery are the library's and keep their pass.
    const pending = observer?.takeRecords() ?? [];
    applyFindHighlightsToContainer(diffContainerRef.current, findMatchesRef.current, findCurrentIndexRef.current);
    // The surgery's own records are dropped: its text splits and merges look
    // like the library's, and a pass for them would re-apply the highlights
    // and re-render the viewer for nothing.
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
  // MutationObserver to trigger re-renders when annotation DOM nodes are added/removed
  useEffect(() => {
    const container = diffContainerRef.current;
    if (!container) return;

    let observer: MutationObserver | null = null;
    let rafId: number | null = null;

    const setupObserver = () => {
      const diffsContainer = container.querySelector('diffs-container');
      if (!(diffsContainer instanceof HTMLElement)) return;

      const shadowRoot = diffsContainer.shadowRoot;

      // A rebuild of the rows drops their find marks, so the pass paints them
      // again. The surgery takes its own records (applyFindHighlights), so this
      // never fires for it.
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
