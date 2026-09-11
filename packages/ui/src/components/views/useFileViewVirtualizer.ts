import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Virtualizer } from '@pierre/diffs';

/**
 * Owns one pierre `Virtualizer` bound to a scrolling container.
 *
 * The instance is created on first render (the constructor does no DOM work)
 * so a `<PierreFile>` mounted inside a `VirtualizerContext.Provider` already
 * picks the virtualized path on mount. pierre queues `connect()` calls made
 * before `setup()` and flushes them once the real scroller element is bound.
 *
 * The scroller passed to `setScroller` must be the actual scrolling element:
 * pierre reads `scrollTop`/`scrollHeight`/client height and applies its scroll
 * fix on that element.
 */
export function useFileViewVirtualizer() {
  const [virtualizer] = useState(() => new Virtualizer());
  const setupRef = useRef(false);

  const setScroller = useCallback(
    (node: HTMLElement | null) => {
      if (node == null) {
        // The scroller was removed (e.g. mobile tree/files toggle or exiting
        // fullscreen). pierre's setup() no-ops when a root is already bound,
        // so tear the binding down or the next mount would silently attach to
        // the stale element and the virtualized file would never update.
        virtualizer.cleanUp();
        setupRef.current = false;
        return;
      }
      if (setupRef.current) return;
      setupRef.current = true;
      virtualizer.setup(node, node.firstElementChild ?? undefined);
    },
    [virtualizer],
  );

  useLayoutEffect(
    () => () => {
      setupRef.current = false;
      virtualizer.cleanUp();
    },
    [virtualizer],
  );

  return { virtualizer, setScroller };
}

export type FileViewVirtualizer = ReturnType<typeof useFileViewVirtualizer>;
