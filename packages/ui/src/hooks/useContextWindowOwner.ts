import React from 'react';
import { startContextWindowOwner } from '@/lib/contextWindow/owner';

export const useContextWindowOwner = (): void => {
  React.useEffect(() => startContextWindowOwner(), []);
};
