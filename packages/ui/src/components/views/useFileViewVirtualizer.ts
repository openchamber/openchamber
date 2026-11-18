import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Virtualizer } from '@pierre/diffs';

// external: https://github.com/pierrecomputer/pierre Creating the virtualizer before child mount selects virtualization; connect queues until setup binds the actual scroller.
export function useFileViewVirtualizer() {
  const [virtualizer] = useState(() => new Virtualizer());
  const setupRef = useRef(false);

  const setScroller = useCallback(
    (node: HTMLElement | null) => {
      if (node == null) {
        // external: https://github.com/pierrecomputer/pierre setup ignores an already bound root, so teardown must precede binding a replacement scroller.
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
