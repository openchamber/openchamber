import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { VirtualizedFile, type File } from '@pierre/diffs';
import { holdMarkdownBlocks } from '@/components/chat/markdown/markdownWindow';

type PreviewScrollPosition = {
  top: number;
  left: number;
  line?: { number: number; offset: number };
  block?: { index: number; offset: number };
};

const markdownBlocks = (scroller: HTMLElement): HTMLCollection | null =>
  scroller.querySelector('[data-oc-streamdown]')?.children ?? null;

const topBlock = (scroller: HTMLElement, scrollerTop: number): PreviewScrollPosition['block'] => {
  const blocks = markdownBlocks(scroller);
  if (!blocks?.length) return undefined;
  let low = 0;
  let high = blocks.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle].getBoundingClientRect().bottom > scrollerTop) high = middle;
    else low = middle + 1;
  }
  return { index: low, offset: blocks[low].getBoundingClientRect().top - scrollerTop };
};

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
    // external: https://github.com/pierrecomputer/pierre onPostRender precedes height reconciliation and scroll correction; restore runs after that synchronous pass.
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

    let blockFrame: number | null = null;
    let blockSteadyFrames = 0;
    let heldBlock: Element | null = null;
    let releaseBlock: (() => void) | null = null;
    const holdBlock = (block: Element | null) => {
      if (block === heldBlock) return;
      releaseBlock?.();
      heldBlock = block;
      releaseBlock = block ? holdMarkdownBlocks(block, { block }) : null;
    };
    const stopObserving = () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (blockFrame !== null) cancelAnimationFrame(blockFrame);
      blockFrame = null;
      holdBlock(null);
    };
    const restorePosition = (inFrame = false) => {
      if (!pending) return;
      const file = getVirtualFile();
      const linePosition = target.line && file?.getLinePosition(target.line.number);
      const lineElement = target.line && getLineElement(target.line.number);
      let targetTop = target.top;
      if (target.line && linePosition) {
        targetTop = (file?.top ?? 0) + linePosition.top - target.line.offset;
      }
      if (target.line && lineElement) {
        targetTop = scroller.scrollTop + lineElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top - target.line.offset;
      }
      const blockElement = target.block ? markdownBlocks(scroller)?.[target.block.index] ?? null : null;
      holdBlock(blockElement);
      if (target.block && blockElement) {
        targetTop = scroller.scrollTop + blockElement.getBoundingClientRect().top - scroller.getBoundingClientRect().top - target.block.offset;
      }
      const moved = Math.abs(scroller.scrollTop - targetTop) >= 1;
      scroller.scrollTop = targetTop;
      scroller.scrollLeft = target.left;
      if ((!target.line || lineElement) && (!target.block || blockElement) && Math.abs(scroller.scrollTop - targetTop) < 1 && Math.abs(scroller.scrollLeft - target.left) < 1) {
        if (inFrame) blockSteadyFrames = moved ? 0 : blockSteadyFrames + 1;
        if (blockElement && blockSteadyFrames < 2) {
          blockFrame ??= requestAnimationFrame(() => {
            blockFrame = null;
            restorePosition(true);
          });
          return;
        }
        pending = false;
        stopObserving();
      }
    };
    const resizeObserver = new ResizeObserver(() => restorePosition());
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
      const scrollerTop = scroller.getBoundingClientRect().top;
      const offset = lineElement ? lineElement.getBoundingClientRect().top - scrollerTop : null;
      positions.delete(positionKey);
      positions.set(positionKey, {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        line: anchor && offset !== null && offset >= 0 && offset < scroller.clientHeight
          ? { number: anchor.lineNumber, offset }
          : undefined,
        block: file ? undefined : topBlock(scroller, scrollerTop),
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
    };
  }, [positionKey, scroller]);

  return { setScroller, restore };
}
