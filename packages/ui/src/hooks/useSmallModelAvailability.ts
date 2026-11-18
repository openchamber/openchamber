import React from 'react';
import { selectSmallModelAvailability, useSmallModelStore, type SmallModelAvailability } from '@/stores/useSmallModelStore';

export function useSmallModelAvailability(directory: string | null | undefined, active = true): SmallModelAvailability {
  const availability = useSmallModelStore(
    React.useCallback((state) => selectSmallModelAvailability(state, directory), [directory]),
  );
  const ensureFresh = useSmallModelStore((state) => state.ensureFresh);
  React.useEffect(() => {
    if (!active) return;
    void ensureFresh(directory);
  }, [active, directory, ensureFresh]);
  return availability;
}
