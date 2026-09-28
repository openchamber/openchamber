import React from 'react';
import { selectSmallModelAvailability, useSmallModelStore, type SmallModelAvailability } from '@/stores/useSmallModelStore';

/**
 * Whether the background model can run for `directory`. Fetches on mount and
 * whenever `active` flips to true (a menu opening, a dialog showing), so a
 * closed menu never polls.
 */
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
