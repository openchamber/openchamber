import React from 'react';
import { cancelWhenLayoutSettled, runWhenLayoutSettled } from '@/lib/layoutAnimation';

export const useRowLimitAfterSettle = (first: number): number => {
  const [limit, setLimit] = React.useState(first);
  React.useEffect(() => {
    const showAll = () => React.startTransition(() => setLimit(Number.POSITIVE_INFINITY));
    runWhenLayoutSettled(showAll);
    return () => cancelWhenLayoutSettled(showAll);
  }, []);
  return limit;
};
