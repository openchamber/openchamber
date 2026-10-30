import React from 'react';
import {
  boundaryClipKeyframes,
  boundaryFadeInKeyframes,
  ROW_DISCLOSURE_EASING,
  ROW_DISCLOSURE_FADE_OUT,
  ROW_DISCLOSURE_MS,
} from '@/lib/motion/rowDisclosure';

/**
 * Opening and closing a folder in a file tree moves the rows the way the
 * sessions sidebar does: the folder's rows are revealed above a boundary moving
 * down from the folder row, or folded under it moving up, and every row below
 * slides with that boundary.
 *
 * The trees draw their rows differently (nested lists, a flat list, a virtual
 * list), so this works on the rows in the document: each row carries its path
 * in `data-tree-disclosure-path`, in tree order, and a folder's rows are the
 * rows right after it whose paths lie inside it. A folder that loads its
 * children after opening animates when they arrive.
 */

const ROW_SELECTOR = '[data-tree-disclosure-path]';
/** How long an opened folder waits for its rows, or a closed one for its rows to go, before giving up. */
const PENDING_LIMIT_MS = 1500;

const rowPath = (row: Element): string => row.getAttribute('data-tree-disclosure-path') ?? '';

const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

type FolderRows = { block: HTMLElement[]; following: HTMLElement[] };

const findFolderRows = (container: HTMLElement, path: string): FolderRows | null => {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(ROW_SELECTOR));
  const headerIndex = rows.findIndex((row) => rowPath(row) === path);
  if (headerIndex < 0) return null;
  const prefix = `${path}/`;
  let end = headerIndex + 1;
  while (end < rows.length && rowPath(rows[end]).startsWith(prefix)) end += 1;
  return { block: rows.slice(headerIndex + 1, end), following: rows.slice(end) };
};

/** Height the folder's rows take, measured to the next row when it is in the document. */
const blockHeight = ({ block, following }: FolderRows): number => {
  const top = block[0].getBoundingClientRect().top;
  const next = following[0];
  return next
    ? next.getBoundingClientRect().top - top
    : block[block.length - 1].getBoundingClientRect().bottom - top;
};

/** Whether a row whose box will span `top`..`bottom` (client px), moved by up to `reach`, is ever on screen. */
const nearViewport = (top: number, bottom: number, reach: number): boolean =>
  bottom + reach > 0 && top - reach < window.innerHeight;

const slideKeyframes = (row: HTMLElement, distance: number): Keyframe[] => {
  const base = row.style.transform;
  return [
    { transform: `${base} translateY(${distance}px)`.trim() },
    { transform: base || 'none' },
  ];
};

type Ghost = { element: HTMLElement; top: number; height: number };

/** Inert copies of the closing rows, drawn where the rows were while they fold away. */
const cloneGhosts = (container: HTMLElement, block: HTMLElement[], reach: number): Ghost[] => {
  const box = container.getBoundingClientRect();
  const ghosts: Ghost[] = [];
  for (const row of block) {
    const rect = row.getBoundingClientRect();
    if (!nearViewport(rect.top, rect.bottom, reach)) continue;
    // SAFETY: a deep clone of an HTMLElement is an HTMLElement of the same tag.
    const element = row.cloneNode(true) as HTMLElement;
    element.removeAttribute('data-tree-disclosure-path');
    element.removeAttribute('data-index');
    for (const withId of element.querySelectorAll('[id]')) withId.removeAttribute('id');
    element.removeAttribute('id');
    element.setAttribute('aria-hidden', 'true');
    element.inert = true;
    const top = rect.top - box.top - container.clientTop;
    Object.assign(element.style, {
      position: 'absolute',
      top: `${top}px`,
      left: `${rect.left - box.left - container.clientLeft}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: '0',
      transform: 'none',
      pointerEvents: 'none',
    });
    ghosts.push({ element, top, height: rect.height });
  }
  return ghosts;
};

type Pending =
  | { kind: 'open'; path: string }
  | { kind: 'close'; path: string; ghosts: Ghost[]; distance: number; blockTop: number; height: number };

type Running = { container: HTMLElement; animations: Animation[]; ghosts: HTMLElement[] };

const timing: KeyframeAnimationOptions = { duration: ROW_DISCLOSURE_MS, easing: ROW_DISCLOSURE_EASING };

const animateOpen = (container: HTMLElement, rows: FolderRows): Animation[] => {
  const distance = blockHeight(rows);
  const box = container.getBoundingClientRect();
  const from = rows.block[0].getBoundingClientRect().top - box.top;
  const to = from + distance;
  const animations: Animation[] = [];
  for (const row of rows.block) {
    const rect = row.getBoundingClientRect();
    if (!nearViewport(rect.top, rect.bottom, 0)) continue;
    const start = rect.top - box.top;
    animations.push(row.animate(boundaryClipKeyframes(start, rect.height, from, to), timing));
    animations.push(row.animate(boundaryFadeInKeyframes(start, rect.height, from, to), timing));
  }
  if (distance === 0) return animations;
  for (const row of rows.following) {
    const rect = row.getBoundingClientRect();
    if (!nearViewport(rect.top - distance, rect.bottom, 0)) continue;
    animations.push(row.animate(slideKeyframes(row, -distance), timing));
  }
  return animations;
};

const animateClose = (container: HTMLElement, rows: FolderRows, pending: Extract<Pending, { kind: 'close' }>): Animation[] => {
  const from = pending.blockTop + pending.distance;
  const to = pending.blockTop;
  const animations: Animation[] = [];
  for (const ghost of pending.ghosts) {
    container.appendChild(ghost.element);
    // Held shut after the end, so a ghost never flashes back before it goes.
    animations.push(ghost.element.animate(boundaryClipKeyframes(ghost.top, ghost.height, from, to), { ...timing, fill: 'forwards' }));
    animations.push(ghost.element.animate(ROW_DISCLOSURE_FADE_OUT, { ...timing, fill: 'forwards' }));
  }
  // Keeps the list as tall as it was, so a list scrolled to its end does not jump up.
  container.style.minHeight = `${pending.height}px`;
  if (pending.distance === 0) return animations;
  for (const row of rows.following) {
    const rect = row.getBoundingClientRect();
    if (!nearViewport(rect.top, rect.bottom + pending.distance, 0)) continue;
    animations.push(row.animate(slideKeyframes(row, pending.distance), timing));
  }
  return animations;
};

/**
 * Returns `toggle(path, expanded, commit)`: call it in place of the tree's own
 * toggle, with whether the folder is open now and the state change that opens
 * or closes it. `onSettled` runs when a motion ends or is dropped.
 */
export function useFileTreeDisclosure(
  containerRef: React.RefObject<HTMLElement | null>,
  options?: { onSettled?: () => void },
): (path: string, expanded: boolean, commit: () => void) => void {
  const pendingRef = React.useRef<Pending | null>(null);
  const pendingTimerRef = React.useRef<number | null>(null);
  const runningRef = React.useRef<Running | null>(null);
  const onSettledRef = React.useRef(options?.onSettled);
  React.useLayoutEffect(() => {
    onSettledRef.current = options?.onSettled;
  });

  const stop = React.useCallback(() => {
    const running = runningRef.current;
    runningRef.current = null;
    if (!running) return;
    for (const animation of running.animations) animation.cancel();
    for (const ghost of running.ghosts) ghost.remove();
    running.container.style.minHeight = '';
  }, []);

  const clearPending = React.useCallback(() => {
    pendingRef.current = null;
    if (pendingTimerRef.current !== null) window.clearTimeout(pendingTimerRef.current);
    pendingTimerRef.current = null;
  }, []);

  const settle = React.useCallback(() => {
    stop();
    clearPending();
    onSettledRef.current?.();
  }, [clearPending, stop]);

  // A folder that never gets its rows (an empty one, a failed load) or never
  // loses them gives up on its own, so nothing it pinned stays mounted.
  const setPending = React.useCallback((pending: Pending) => {
    clearPending();
    pendingRef.current = pending;
    pendingTimerRef.current = window.setTimeout(() => {
      pendingTimerRef.current = null;
      if (pendingRef.current === pending) settle();
    }, PENDING_LIMIT_MS);
  }, [clearPending, settle]);

  const start = React.useCallback((container: HTMLElement, animations: Animation[], ghosts: HTMLElement[]) => {
    const running: Running = { container, animations, ghosts };
    runningRef.current = running;
    void Promise.all(animations.map((animation) => animation.finished)).then(() => {
      if (runningRef.current === running) settle();
    }, () => undefined);
  }, [settle]);

  // After each commit: start the motion a toggle asked for once its rows are in
  // (or, for a close, out of) the document.
  React.useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    const container = containerRef.current;
    const rows = container ? findFolderRows(container, pending.path) : null;
    if (!container || !rows) {
      settle();
      return;
    }
    const ready = pending.kind === 'open' ? rows.block.length > 0 : rows.block.length === 0;
    if (!ready) return;
    clearPending();
    if (pending.kind === 'open') {
      start(container, animateOpen(container, rows), []);
    } else {
      start(container, animateClose(container, rows, pending), pending.ghosts.map((ghost) => ghost.element));
    }
  });

  React.useEffect(() => () => {
    stop();
    clearPending();
  }, [clearPending, stop]);

  return React.useCallback((path: string, expanded: boolean, commit: () => void) => {
    stop();
    clearPending();
    const container = containerRef.current;
    const rows = container && expanded ? findFolderRows(container, path) : null;
    if (!container || prefersReducedMotion() || (expanded && (!rows || rows.block.length === 0))) {
      // No motion: whatever the commit set up for one is released at once.
      commit();
      onSettledRef.current?.();
      return;
    }
    if (!expanded || !rows) {
      setPending({ kind: 'open', path });
      commit();
      return;
    }
    const distance = blockHeight(rows);
    setPending({
      kind: 'close',
      path,
      distance,
      ghosts: cloneGhosts(container, rows.block, distance),
      blockTop: rows.block[0].getBoundingClientRect().top - container.getBoundingClientRect().top - container.clientTop,
      height: container.offsetHeight,
    });
    commit();
  }, [clearPending, containerRef, setPending, stop]);
}
