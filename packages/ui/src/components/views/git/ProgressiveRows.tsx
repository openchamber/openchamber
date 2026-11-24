import React from 'react';
import { useRowLimitAfterSettle } from '@/hooks/useRowLimitAfterSettle';

const FIRST_ROWS = 24;

export const ProgressiveRows: React.FC<{ minimum: number; children: (limit: number) => React.ReactNode }> = ({ minimum, children }) => {
  const limit = useRowLimitAfterSettle(FIRST_ROWS);
  return <>{children(Math.max(limit, minimum))}</>;
};
