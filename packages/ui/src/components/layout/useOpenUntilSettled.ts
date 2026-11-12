import React from 'react';

import { cancelWhenLayoutSettled, runWhenLayoutSettled } from '@/lib/layoutAnimation';

/**
 * A side column's open state as of the end of its animation
 * (`lib/layoutAnimation.ts`): it follows a toggle in either direction only
 * once that animation ended. Call it after the layout effect that begins the
 * animation, so a toggle's animation is already running when this hook
 * queues behind it.
 */
export const useOpenWhenSettled = (isOpen: boolean): boolean => {
  const isOpenRef = React.useRef(isOpen);
  isOpenRef.current = isOpen;
  const [settledOpen, setSettledOpen] = React.useState(isOpen);
  const settle = React.useCallback(() => setSettledOpen(isOpenRef.current), []);
  React.useLayoutEffect(() => {
    runWhenLayoutSettled(settle);
  }, [isOpen, settle]);
  React.useEffect(() => () => cancelWhenLayoutSettled(settle), [settle]);
  return settledOpen;
};

/**
 * Whether a side column's content still counts as shown: true at once when it
 * opens, and through its closing animation until that ends. Same call order
 * as `useOpenWhenSettled`.
 */
export const useOpenUntilSettled = (isOpen: boolean): boolean => {
  const settledOpen = useOpenWhenSettled(isOpen);
  return isOpen || settledOpen;
};
