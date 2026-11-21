import { useEffect } from 'react';

import { isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import { getIdleDesktopUpdate, listenIdleDesktopUpdate } from '@/lib/idle-desktop-update';
import { useUpdateStore } from '@/stores/useUpdateStore';

export function useIdleDesktopUpdate() {
  const applyIdleUpdate = useUpdateStore((state) => state.applyIdleUpdate);

  useEffect(() => {
    if (!isElectronShell() || !isDesktopLocalOriginActive()) return undefined;
    let unlisten = () => {};
    let stopped = false;
    void (async () => {
      let sawEvent = false;
      unlisten = await listenIdleDesktopUpdate((status) => {
        sawEvent = true;
        applyIdleUpdate(status);
      });
      if (stopped) {
        unlisten();
        return;
      }
      const current = await getIdleDesktopUpdate().catch(() => null);
      if (!stopped && current && !sawEvent) applyIdleUpdate(current);
    })();
    return () => {
      stopped = true;
      unlisten();
    };
  }, [applyIdleUpdate]);
}
