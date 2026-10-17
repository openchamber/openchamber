import React from 'react';

/**
 * One-shot deadline for the reconnect "stuck" transition at
 * `status.updatedAtMs + 12_000`. Replaces the old recurring 1 Hz clock
 * that re-rendered the whole page every second during a reconnect just to
 * check whether 12 s had elapsed.
 *
 * Returns `true` once the deadline has passed. The timer:
 * - reschedules when `updatedAtMs` changes (new status update),
 * - cancels when `isReconnecting` becomes false,
 * - cleans up on unmount.
 *
 * Depends on `statusUpdatedAtMs` (the value that defines the deadline),
 * not on the whole `status` object — otherwise every recurring status poll
 * (every 2 s) would reset the timeout and defeat the purpose of one-shot.
 */
export const useReconnectStuck = (
  isReconnecting: boolean,
  statusUpdatedAtMs: number | null | undefined,
): boolean => {
  const [reconnectAppearsStuck, setReconnectAppearsStuck] = React.useState(false);

  React.useEffect(() => {
    if (!isReconnecting || statusUpdatedAtMs == null) {
      setReconnectAppearsStuck(false);
      return;
    }

    const remaining = statusUpdatedAtMs + 12_000 - Date.now();
    if (remaining <= 0) {
      // Past (or exactly at) the deadline: mark stuck on this frame.
      // Previous clock-tick version fired on the next tick after >12 s;
      // this fires at the deadline itself, which is at most ~1s earlier.
      setReconnectAppearsStuck(true);
      return;
    }

    const timer = window.setTimeout(() => setReconnectAppearsStuck(true), remaining);
    return () => {
      window.clearTimeout(timer);
    };
  }, [isReconnecting, statusUpdatedAtMs]);

  return reconnectAppearsStuck;
};
