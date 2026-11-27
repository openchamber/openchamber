import React from 'react';

import type { DesktopHost } from '@/lib/desktopHosts';
import { getDesktopHostStatusSnapshot, probeDesktopHosts } from '@/lib/desktopHostStatus';
import { afterDelay } from '@/lib/timing/afterDelay';

const SSH_STATUS_POLL_MS = 1_500;
const PLAIN_HOST_RECHECK_MS = 5_000;

const repeatWhilePageVisible = (intervalMs: number, run: () => void | Promise<void>): (() => void) => {
  let stopped = false;
  let cancelNext = () => {};
  const scheduleNext = () => {
    cancelNext = afterDelay(intervalMs, async () => {
      if (document.visibilityState === 'visible') await run();
      if (!stopped) scheduleNext();
    });
  };
  scheduleNext();
  return () => {
    stopped = true;
    cancelNext();
  };
};

export function useHostSwitcherRechecks(
  plainHosts: readonly DesktopHost[] | null,
  pollSshStatuses: (() => Promise<void>) | null,
) {
  React.useEffect(() => {
    if (!pollSshStatuses) return;
    void pollSshStatuses();
    return repeatWhilePageVisible(SSH_STATUS_POLL_MS, pollSshStatuses);
  }, [pollSshStatuses]);

  React.useEffect(() => {
    if (!plainHosts || plainHosts.length === 0) return;
    return repeatWhilePageVisible(PLAIN_HOST_RECHECK_MS, () => {
      const { pendingHostIds } = getDesktopHostStatusSnapshot();
      const settled = plainHosts.filter((host) => !pendingHostIds.has(host.id));
      if (settled.length > 0) void probeDesktopHosts(settled, { background: true });
    });
  }, [plainHosts]);
}
