import React from 'react';
import { cancelWhenLayoutSettled, isLayoutAnimating, runWhenLayoutSettled } from '@/lib/layoutAnimation';

export const useSettledFlag = (value: boolean): boolean => {
  const valueRef = React.useRef(value);
  valueRef.current = value;
  const [settled, setSettled] = React.useState(() => value && !isLayoutAnimating());
  const settle = React.useCallback(() => setSettled(valueRef.current), []);
  React.useLayoutEffect(() => {
    runWhenLayoutSettled(settle);
  }, [value, settle]);
  React.useEffect(() => () => cancelWhenLayoutSettled(settle), [settle]);
  return settled;
};
