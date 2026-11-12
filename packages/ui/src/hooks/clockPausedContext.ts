import React from 'react';

/**
 * True inside a surface that stays mounted while the user cannot see it (a
 * closed side panel kept at opacity 0, a row hidden with `invisible`). Every
 * indicator on the shared clock (`useDurationTicker.ts`) stands still there and
 * catches up when shown again. Set it with `PauseClock`.
 */
export const ClockPausedContext = React.createContext(false);
