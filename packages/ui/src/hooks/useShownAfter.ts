import * as React from 'react';

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
