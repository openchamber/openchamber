import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { VirtualizedFile, type File } from '@pierre/diffs';

type PreviewScrollPosition = {
  top: number;
  left: number;
  line?: { number: number; offset: number };
};

// Runtime, directory, file, preview mode and surface are supplied by FilesView.
// Retain coordinates across view unmounts, without retaining DOM or file data.
const positions = new Map<string, PreviewScrollPosition>();
const MAX_POSITIONS = 100;

export function useFilePreviewScrollPosition(positionKey: string | null) {
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const restoreRef = useRef<(() => void) | null>(null);
  const rememberRef = useRef<(() => void) | null>(null);
  const virtualFileRef = useRef<{ key: string | null; file: VirtualizedFile; node: HTMLElement } | null>(null);
  const restore = useCallback((node?: HTMLElement, instance?: File) => {
    if (node && instance instanceof VirtualizedFile) {
      virtualFileRef.current = { key: positionKey, file: instance, node };
    }
    const restorePosition = restoreRef.current;
    const rememberPosition = rememberRef.current;
    const finishRender = () => {
      if (restoreRef.current !== restorePosition) return;
      restorePosition?.();
      rememberPosition?.();
    };
    // Pierre calls onPostRender before reconciling measured heights and applying
    // its own scroll correction. Finish after that synchronous render pass,
    // before paint, rather than saving estimates or having our restore undone.
    if (instance) queueMicrotask(finishRender);
    else finishRender();
  }, [positionKey]);

  useLayoutEffect(() => {
    if (!scroller || !positionKey) return;

    const target: PreviewScrollPosition = positions.get(positionKey) ?? { top: 0, left: 0 };
    let pending = true;
    const getVirtualFile = () => virtualFileRef.current?.key === positionKey ? virtualFileRef.current.file : null;
    const getLineElement = (number: number) => virtualFileRef.current?.key === positionKey
      ? virtualFileRef.current.node.shadowRoot?.querySelector<HTMLElement>(`[data-line][data-line-index="${number - 1}"]`)
      : null;

    const stopObserving = () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
    const restorePosition = () => {
      if (!pending) return;
      const file = getVirtualFile();
      const linePosition = target.line && file?.getLinePosition(target.line.number);
      const lineElement = target.line && getLineElement(target.line.number);
      // Estimated heights locate the virtual window; the mounted row supplies
      // the final visual offset, including wrapping and Pierre's padding.
      let targetTop = target.top;
      if (target.line && linePosition) {
        targetTop = (file?.top ?? 0) + linePosition.top - target.line.offset;
      }
      if (target.line && lineElement) {
        targetTop = scroller.scrollTop + lineElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top - target.line.offset;
      }
      scroller.scrollTop = targetTop;
      scroller.scrollLeft = target.left;
      if ((!target.line || lineElement) && Math.abs(scroller.scrollTop - targetTop) < 1 && Math.abs(scroller.scrollLeft - target.left) < 1) {
        pending = false;
        stopObserving();
      }
    };
    // Markdown can mount through Suspense; code may render asynchronously in
    // Pierre's worker. Retry only on content/layout changes, until reachable.
    const resizeObserver = new ResizeObserver(restorePosition);
    const mutationObserver = new MutationObserver(() => {
      if (!pending) return;
      for (const child of scroller.children) resizeObserver.observe(child);
      restorePosition();
    });
    resizeObserver.observe(scroller);
    for (const child of scroller.children) resizeObserver.observe(child);
    mutationObserver.observe(scroller, { childList: true, subtree: true });

    const rememberPosition = () => {
      if (pending) return;
      const file = getVirtualFile();
      const anchor = file?.getNumericScrollAnchor(scroller.scrollTop - (file.top ?? 0));
      const lineElement = anchor && getLineElement(anchor.lineNumber);
      const offset = lineElement ? lineElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top : null;
      positions.delete(positionKey);
      positions.set(positionKey, {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        line: anchor && offset !== null && offset >= 0 && offset < scroller.clientHeight
          ? { number: anchor.lineNumber, offset }
          : undefined,
      });
      if (positions.size > MAX_POSITIONS) {
        const oldestKey = positions.keys().next().value;
        if (oldestKey !== undefined) positions.delete(oldestKey);
      }
    };
    const cancelRestoration = () => {
      pending = false;
      stopObserving();
    };

    restoreRef.current = restorePosition;
    rememberRef.current = rememberPosition;
    restorePosition();
    scroller.addEventListener('scroll', rememberPosition, { passive: true });
    scroller.addEventListener('wheel', cancelRestoration, { passive: true });
    scroller.addEventListener('touchstart', cancelRestoration, { passive: true });
    scroller.addEventListener('pointerdown', cancelRestoration, { passive: true });
    scroller.addEventListener('keydown', cancelRestoration);

    return () => {
      restoreRef.current = null;
      rememberRef.current = null;
      if (virtualFileRef.current?.key === positionKey) virtualFileRef.current = null;
      stopObserving();
      scroller.removeEventListener('scroll', rememberPosition);
      scroller.removeEventListener('wheel', cancelRestoration);
      scroller.removeEventListener('touchstart', cancelRestoration);
      scroller.removeEventListener('pointerdown', cancelRestoration);
      scroller.removeEventListener('keydown', cancelRestoration);
      // Keep the last scroll event, not offsets collapsed by DOM teardown.
    };
  }, [positionKey, scroller]);

  return { setScroller, restore };
}
