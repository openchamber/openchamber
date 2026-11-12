import React from 'react';

import { ClockPausedContext } from '@/hooks/clockPausedContext';

/** Stops the shared clock's spinners, blinks and counters below it while `paused`. */
export const PauseClock: React.FC<{ paused: boolean; children: React.ReactNode }> = ({ paused, children }) => {
  const parentPaused = React.useContext(ClockPausedContext);
  return <ClockPausedContext.Provider value={parentPaused || paused}>{children}</ClockPausedContext.Provider>;
};
