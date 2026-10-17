import React from 'react';

import { useDurationTickerNow } from '@/hooks/useDurationTicker';

/**
 * Gate the shared 1 Hz clock on time-dependent tunnel values. The clock
 * runs only while there is something that actually changes once a second:
 * - a live bootstrap expiry (`bootstrapExpiresAt > now`), or
 * - an active session with a future `expiresAt`.
 *
 * Inactive/revoked/expired historical rows render static labels and never
 * change, so they must not keep the clock alive. After the last expiry
 * passes, the clock stops and the component re-renders no more than once.
 *
 * Returns `[nowTs, clockActive]` where `nowTs` is the wall-clock time used
 * by countdown/expired/inactive derived values.
 */
export const useTunnelClock = (
  tunnelInfo: { bootstrapExpiresAt: number | null } | null,
  sessionRecords: { status: 'active' | 'inactive'; expiresAt: number }[],
): [number, boolean] => {
  const clockShouldRunOptimistic =
    Boolean(tunnelInfo?.bootstrapExpiresAt) ||
    sessionRecords.some((r) => r.status === 'active');

  const [clockActive, setClockActive] = React.useState(clockShouldRunOptimistic);

  const nowTs = useDurationTickerNow(clockActive);

  const clockShouldRunActual =
    (tunnelInfo?.bootstrapExpiresAt != null && tunnelInfo.bootstrapExpiresAt > nowTs) ||
    sessionRecords.some((r) => r.status === 'active' && r.expiresAt > nowTs);

  React.useEffect(() => {
    if (clockShouldRunActual !== clockActive) {
      setClockActive(clockShouldRunActual);
    }
  }, [clockShouldRunActual, clockActive]);

  return [nowTs, clockActive];
};
