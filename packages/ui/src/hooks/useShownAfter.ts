import * as React from 'react';

/**
 * `active` once it has held for `delayMs`, and false the moment it drops: a
 * status for a wait that usually ends within the delay never flashes. The
 * delay is display only; what the status describes follows its own state.
 */
export const useShownAfter = (active: boolean, delayMs: number): boolean => {
  const [held, setHeld] = React.useState(false);

  React.useEffect(() => {
    if (!active) {
      setHeld(false);
      return;
    }
    const handle = window.setTimeout(() => setHeld(true), delayMs);
    return () => window.clearTimeout(handle);
  }, [active, delayMs]);

  return active && held;
};
