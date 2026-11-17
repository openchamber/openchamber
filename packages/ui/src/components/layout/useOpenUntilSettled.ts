import React from 'react';

import { cancelWhenLayoutSettled, runWhenLayoutSettled } from '@/lib/layoutAnimation';

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

export const useOpenUntilSettled = (isOpen: boolean): boolean => {
  const settledOpen = useOpenWhenSettled(isOpen);
  return isOpen || settledOpen;
};
