import React, { useEffect, useRef } from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import type { WorkerPoolManager } from '@pierre/diffs/worker';
import { makeContentCacheKey } from './contentCacheKey';

const FULL_DIFF_SWAP_TIMEOUT_MS = 2000;

/**
 * A partial diff replaced by the full diff of the same file (context loaded
 * on demand) would paint unhighlighted and light up when the worker answers,
 * so the file visibly flashes to plain text. Keep the old diff on screen while
 * the worker primes the new one, then swap; fall back to a plain swap when
 * no worker pool is available or priming takes too long.
 */
export const useDiffSwapAfterHighlight = (
  incoming: FileDiffMetadata | undefined,
  workerPool: WorkerPoolManager | undefined,
): FileDiffMetadata | undefined => {
  const [displayed, setDisplayed] = React.useState(incoming);
  const displayedRef = useRef(incoming);

  useEffect(() => {
    if (incoming === displayedRef.current) return;
    const previous = displayedRef.current;
    const show = () => {
      displayedRef.current = incoming;
      setDisplayed(incoming);
    };

    const isContextReload = previous !== undefined && incoming !== undefined
      && previous.isPartial && !incoming.isPartial && previous.name === incoming.name
      && workerPool?.isWorkingPool() === true;
    if (!isContextReload) {
      show();
      return;
    }

    incoming.cacheKey ??= [
      'diff', incoming.name,
      incoming.prevObjectId ?? makeContentCacheKey(incoming.deletionLines.join('\n')),
      incoming.newObjectId ?? makeContentCacheKey(incoming.additionLines.join('\n')),
    ].join(':');

    // subscribeToStatChanges invokes the listener synchronously, so swap can
    // run before the subscription and timer handles exist. The initializers
    // keep prefer-const from demanding const: settle reads both handles while
    // subscribeToStatChanges is still running, and const would throw there.
    let settled = false;
    let unsubscribe: (() => void) | undefined = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      clearTimeout(timer);
    };
    const swap = () => {
      if (settled) return;
      settle();
      show();
    };
    const swapWhenHighlighted = () => {
      if (workerPool.getDiffResultCache(incoming)) swap();
    };
    unsubscribe = workerPool.subscribeToStatChanges(swapWhenHighlighted);
    if (settled) {
      unsubscribe();
      return;
    }
    timer = setTimeout(swap, FULL_DIFF_SWAP_TIMEOUT_MS);
    workerPool.primeDiffHighlightCache(incoming);
    swapWhenHighlighted();
    return settle;
  }, [incoming, workerPool]);

  return displayed;
};
