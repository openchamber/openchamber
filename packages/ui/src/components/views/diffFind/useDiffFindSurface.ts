import React from 'react';

import type { DiffFindWordRequest, PierreDiffViewerHandle } from '@/components/views/PierreDiffViewer';
import { isEditableEventTarget } from '@/hooks/keyboard-shortcut-dom';
import { useKeybind } from '@/hooks/useKeybind';
import type { DiffFindMatch } from '@/lib/diff/diffFind';
import { isIMECompositionEvent } from '@/lib/ime';

import { DIFF_FIND_BAR_ATTR } from './DiffFindBar';
import { isForeignEditableFocus } from './findShortcutClaim';
import type { UseDiffFindResult } from './useDiffFind';

// How long a jump keeps trying, once a frame, to reach its line: the file may
// still be read, then rendered and highlighted (a large diff takes seconds). A
// viewer that mounts later for the same match starts the wait over.
const SCROLL_WAIT_MS = 5000;

interface ScrollJob {
  match: DiffFindMatch;
  frame: number | null;
  deadline: number;
}

/**
 * Marks the root of a surface with its own Cmd/Ctrl+F (Changes, the
 * walkthrough, Files). A surface leaves the key to another one that holds the
 * event.
 */
const FIND_SURFACE_SELECTOR = '[data-find-surface]';

/** Whether the event happened inside a find surface other than `root`. */
const isInOtherFindSurface = (target: EventTarget | null, root: HTMLElement | null): boolean => {
  if (!(target instanceof Element)) return false;
  const surface = target.closest(FIND_SURFACE_SELECTOR);
  return surface !== null && surface !== root;
};

interface UseDiffFindSurfaceOptions {
  find: UseDiffFindResult;
  /** The surface is the one on screen; a hidden surface leaves Cmd/Ctrl+F alone. */
  visible: boolean;
  /** The surface's root, carrying `data-find-surface`: focus inside it belongs to it. */
  rootRef: React.RefObject<HTMLElement | null>;
  /**
   * Make the match's viewer exist and bring its section into view.
   * `viewerMounted` says the viewer is already there, so the line scroll
   * alone reaches the match.
   */
  reveal: (match: DiffFindMatch, viewerMounted: boolean) => void;
}

interface DiffFindSurface {
  /** Pass to each viewer under its source key (the match's `filePath`). */
  registerViewer: (key: string, handle: PierreDiffViewerHandle | null) => void;
  /** A Cmd/Ctrl-click on a word in the viewer registered under `key`. */
  openOnWord: (key: string, request: DiffFindWordRequest) => void;
  /** Bumped on every find shortcut or word click; the bar re-selects its query. */
  focusNonce: number;
}

/**
 * Connects one find state to the diff viewers of a surface (Changes, the
 * walkthrough): it paints the active file's matches and clears every other
 * viewer, brings the active match into view, opens the bar on Cmd/Ctrl+F
 * through the shortcut registry, and closes it on Escape.
 */
export const useDiffFindSurface = ({ find, visible, rootRef, reveal }: UseDiffFindSurfaceOptions): DiffFindSurface => {
  const { isOpen, matches, currentMatch, currentIndex, open, close, openWithQuery } = find;
  const viewersRef = React.useRef(new Map<string, PierreDiffViewerHandle>());
  const [focusNonce, setFocusNonce] = React.useState(0);
  const revealRef = React.useRef(reveal);
  revealRef.current = reveal;

  const matchesByFile = React.useMemo(() => {
    const map = new Map<string, DiffFindMatch[]>();
    for (const match of matches) {
      const list = map.get(match.filePath);
      if (list) list.push(match);
      else map.set(match.filePath, [match]);
    }
    return map;
  }, [matches]);

  // Latest find state for the viewer ref callbacks, which fire outside render.
  const stateRef = React.useRef({ isOpen, currentMatch, matchesByFile });
  stateRef.current = { isOpen, currentMatch, matchesByFile };

  // Only the viewer holding the active match is highlighted.
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
  const cancelScroll = React.useCallback(() => {
    const job = scrollJobRef.current;
    if (job?.frame != null) window.cancelAnimationFrame(job.frame);
    scrollJobRef.current = null;
  }, []);
  // The job outlives its wait, so a viewer that mounts for the match
  // afterwards (an entry that was still loading) finishes the jump.
  const startScroll = React.useCallback((match: DiffFindMatch) => {
    const previous = scrollJobRef.current;
    if (previous?.frame != null) window.cancelAnimationFrame(previous.frame);
    const job: ScrollJob = { match, frame: null, deadline: performance.now() + SCROLL_WAIT_MS };
    scrollJobRef.current = job;
    const attempt = () => {
      job.frame = null;
      if (scrollJobRef.current !== job) return;
      const handle = viewersRef.current.get(match.filePath);
      if (handle?.scrollToLine({ lineNumber: match.lineNumber, side: match.side, align: 'center' })) {
        scrollJobRef.current = null;
        return;
      }
      if (performance.now() < job.deadline) job.frame = window.requestAnimationFrame(attempt);
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
    // A viewer that mounts while the bar is closed has nothing to clear.
    if (stateRef.current.isOpen) applyHighlights(key, handle);
    const job = scrollJobRef.current;
    if (job && job.match.filePath === key) startScroll(job.match);
  }, [applyHighlights, startScroll]);

  React.useEffect(() => {
    for (const [key, handle] of viewersRef.current) applyHighlights(key, handle);
  }, [applyHighlights, currentMatch, isOpen, matchesByFile]);

  // A landing file rebuilds every match object, so the jump is keyed by what
  // the match points at: only a move to another match starts a new jump.
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

  // Cmd/Ctrl+F belongs to this surface while it is on screen, unless another
  // surface's editable control holds focus (a file editor, the chat composer).
  useKeybind('find_in_file', (event) => {
    if (!visible || event.defaultPrevented) return false;
    if (isForeignEditableFocus(document.activeElement, rootRef.current)) return false;
    if (isInOtherFindSurface(event.target, rootRef.current)) return false;
    open();
    setFocusNonce((nonce) => nonce + 1);
  });

  // Escape while the bar is open closes it from anywhere in the surface, not
  // only from its input. It is claimed in the capture phase: the zone frame
  // closes the panel on Escape from a React capture handler on the root
  // container (zoneEscape.ts), which stops native propagation, so a bubble
  // listener here would never see the key.
  React.useEffect(() => {
    if (!visible || !isOpen) return;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isIMECompositionEvent(event)) return;
      const { target } = event;
      if (!(target instanceof Node)) return;
      // A focused element outside the surface (a popover, menu or dialog
      // input) keeps its own Escape, and so does a field inside it other than
      // the bar's own (a comment being written on a diff line).
      const active = document.activeElement;
      const nothingHoldsFocus = !active || active === document.body;
      if (!rootRef.current?.contains(target) && !nothingHoldsFocus) return;
      if (isInOtherFindSurface(target, rootRef.current)) return;
      const inBar = target instanceof Element && target.closest(`[${DIFF_FIND_BAR_ATTR}]`) !== null;
      if (!inBar && isEditableEventTarget(target)) return;
      // A second surface's listener on `window` still runs, and bails on
      // `defaultPrevented`, so one Escape closes one bar.
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

  return { registerViewer, openOnWord, focusNonce };
};
