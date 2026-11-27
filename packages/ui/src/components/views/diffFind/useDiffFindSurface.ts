import React from 'react';

import type { DiffFindWordRequest, PierreDiffViewerHandle } from '@/components/views/PierreDiffViewer';
import { isEditableEventTarget } from '@/hooks/keyboard-shortcut-dom';
import { useKeybind } from '@/hooks/useKeybind';
import type { DiffFindMatch, DiffFindSide } from '@/lib/diff/diffFind';
import { isIMECompositionEvent } from '@/lib/ime';

import { DIFF_FIND_BAR_ATTR } from './DiffFindBar';
import { isForeignEditableFocus } from './findShortcutClaim';
import type { UseDiffFindResult } from './useDiffFind';

const SCROLL_WAIT_MS = 5000;

interface ScrollJob {
  target: DiffScrollTarget;
  scope: number;
  frame: number | null;
  deadline: number;
  waitForViewer: boolean;
}

type DiffScrollTarget = {
  filePath: string;
  lineNumber: number;
  side: DiffFindSide;
};

const FIND_SURFACE_SELECTOR = '[data-find-surface]';

const isInOtherFindSurface = (target: EventTarget | null, root: HTMLElement | null): boolean => {
  if (!(target instanceof Element)) return false;
  const surface = target.closest(FIND_SURFACE_SELECTOR);
  return surface !== null && surface !== root;
};

interface UseDiffFindSurfaceOptions {
  find: UseDiffFindResult;
  visible: boolean;
  rootRef: React.RefObject<HTMLElement | null>;
  reveal: (target: { filePath: string }, viewerMounted: boolean) => void;
  revealLocation?: (target: { filePath: string }) => void;
  scopeKey?: string;
}

interface DiffFindSurface {
  registerViewer: (key: string, handle: PierreDiffViewerHandle | null) => void;
  openOnWord: (key: string, request: DiffFindWordRequest) => void;
  scrollToLocation: (target: DiffScrollTarget) => void;
  focusNonce: number;
}

export const useDiffFindSurface = ({ find, visible, rootRef, reveal, revealLocation, scopeKey = '' }: UseDiffFindSurfaceOptions): DiffFindSurface => {
  const { isOpen, matches, currentMatch, currentIndex, open, close, openWithQuery } = find;
  const viewersRef = React.useRef(new Map<string, PierreDiffViewerHandle>());
  const [focusNonce, setFocusNonce] = React.useState(0);
  const revealRef = React.useRef(reveal);
  revealRef.current = reveal;
  const revealLocationRef = React.useRef(revealLocation);
  revealLocationRef.current = revealLocation;

  const matchesByFile = React.useMemo(() => {
    const map = new Map<string, DiffFindMatch[]>();
    for (const match of matches) {
      const list = map.get(match.filePath);
      if (list) list.push(match);
      else map.set(match.filePath, [match]);
    }
    return map;
  }, [matches]);

  const stateRef = React.useRef({ isOpen, currentMatch, matchesByFile });
  stateRef.current = { isOpen, currentMatch, matchesByFile };

  const applyHighlights = React.useCallback((key: string, handle: PierreDiffViewerHandle) => {
    const state = stateRef.current;
    const current = state.currentMatch;
    if (!state.isOpen || !current || current.filePath !== key) {
      handle.setFindHighlights([], 0);
      return;
    }
    const list = state.matchesByFile.get(key) ?? [];
    handle.setFindHighlights(list, list.indexOf(current));
  }, []);

  const scrollJobRef = React.useRef<ScrollJob | null>(null);
  const shownScope = visible ? scopeKey : null;
  const lastScopeRef = React.useRef<string | null>(shownScope);
  const scopeRef = React.useRef(0);
  if (lastScopeRef.current !== shownScope) {
    lastScopeRef.current = shownScope;
    scopeRef.current += 1;
  }
  const cancelScroll = React.useCallback(() => {
    const job = scrollJobRef.current;
    if (job?.frame != null) window.cancelAnimationFrame(job.frame);
    scrollJobRef.current = null;
  }, []);
  const startScroll = React.useCallback((target: DiffScrollTarget, waitForViewer = false) => {
    const previous = scrollJobRef.current;
    if (previous?.frame != null) window.cancelAnimationFrame(previous.frame);
    const job: ScrollJob = { target, scope: scopeRef.current, frame: null, deadline: performance.now() + SCROLL_WAIT_MS, waitForViewer };
    scrollJobRef.current = job;
    const attempt = () => {
      job.frame = null;
      if (scrollJobRef.current !== job) return;
      if (job.scope !== scopeRef.current) {
        scrollJobRef.current = null;
        return;
      }
      const handle = viewersRef.current.get(target.filePath);
      if (handle?.scrollToLine({ lineNumber: target.lineNumber, side: target.side, align: 'center' })) {
        scrollJobRef.current = null;
        return;
      }
      if (waitForViewer && !handle) return;
      if (performance.now() < job.deadline) job.frame = window.requestAnimationFrame(attempt);
      else if (!waitForViewer) scrollJobRef.current = null;
    };
    job.frame = window.requestAnimationFrame(attempt);
  }, []);
  React.useEffect(() => cancelScroll, [cancelScroll]);

  const registerViewer = React.useCallback((key: string, handle: PierreDiffViewerHandle | null) => {
    if (!handle) {
      viewersRef.current.delete(key);
      return;
    }
    viewersRef.current.set(key, handle);
    if (stateRef.current.isOpen) applyHighlights(key, handle);
    const job = scrollJobRef.current;
    if (job && job.scope !== scopeRef.current) cancelScroll();
    else if (job && job.target.filePath === key) startScroll(job.target, job.waitForViewer);
  }, [applyHighlights, cancelScroll, startScroll]);

  React.useEffect(() => {
    for (const [key, handle] of viewersRef.current) applyHighlights(key, handle);
  }, [applyHighlights, currentMatch, isOpen, matchesByFile]);

  const lastJumpKeyRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!isOpen || !currentMatch) {
      lastJumpKeyRef.current = null;
      cancelScroll();
      return;
    }
    const key = `${currentIndex}:${currentMatch.filePath}:${currentMatch.side}:${currentMatch.lineNumber}:${currentMatch.spanStart}`;
    if (lastJumpKeyRef.current === key) return;
    lastJumpKeyRef.current = key;
    revealRef.current(currentMatch, viewersRef.current.has(currentMatch.filePath));
    startScroll(currentMatch);
  }, [cancelScroll, currentIndex, currentMatch, isOpen, startScroll]);

  useKeybind('find_in_file', (event) => {
    if (!visible || event.defaultPrevented) return false;
    if (isForeignEditableFocus(document.activeElement, rootRef.current)) return false;
    if (isInOtherFindSurface(event.target, rootRef.current)) return false;
    open();
    setFocusNonce((nonce) => nonce + 1);
  });

  React.useEffect(() => {
    if (!visible || !isOpen) return;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isIMECompositionEvent(event)) return;
      const { target } = event;
      if (!(target instanceof Node)) return;
      const active = document.activeElement;
      const nothingHoldsFocus = !active || active === document.body;
      if (!rootRef.current?.contains(target) && !nothingHoldsFocus) return;
      if (isInOtherFindSurface(target, rootRef.current)) return;
      const inBar = target instanceof Element && target.closest(`[${DIFF_FIND_BAR_ATTR}]`) !== null;
      if (!inBar && isEditableEventTarget(target)) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => window.removeEventListener('keydown', onKeyDownCapture, true);
  }, [close, isOpen, rootRef, visible]);

  const openOnWord = React.useCallback((key: string, request: DiffFindWordRequest) => {
    openWithQuery(request.word, { filePath: key, side: request.side, lineNumber: request.lineNumber, spanStart: request.spanStart });
    setFocusNonce((nonce) => nonce + 1);
  }, [openWithQuery]);

  const scrollToLocation = React.useCallback((target: DiffScrollTarget) => {
    const revealTarget = revealLocationRef.current;
    if (revealTarget) revealTarget(target);
    else revealRef.current(target, viewersRef.current.has(target.filePath));
    startScroll(target, true);
  }, [startScroll]);

  return { registerViewer, openOnWord, scrollToLocation, focusNonce };
};
