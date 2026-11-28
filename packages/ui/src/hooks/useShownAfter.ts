import * as React from 'react';

export const useShownAfter = (active: boolean, delayMs: number): boolean => {
  const [held, setHeld] = React.useState(false);
  if (!active && held) setHeld(false);

  React.useEffect(() => {
    if (!active) return;
    const handle = window.setTimeout(() => setHeld(true), delayMs);
    return () => window.clearTimeout(handle);
  }, [active, delayMs]);

  return active && held;
};
