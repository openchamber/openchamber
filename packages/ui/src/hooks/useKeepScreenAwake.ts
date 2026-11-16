import { registerPlugin } from '@capacitor/core';
import React from 'react';

import { canKeepScreenAwake, getClientPlatform } from '@/lib/platform';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useSpaceDirectoryStopped, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { hasActiveSubagent, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionUIStore } from '@/sync/session-ui-store';

interface KeepAwakePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

const KeepAwake = registerPlugin<KeepAwakePlugin>('KeepAwake');

const setIdleTimerDisabled = (enabled: boolean): void => {
  void KeepAwake.setEnabled({ enabled }).catch(() => undefined);
};

export const useKeepScreenAwake = (connected: boolean): void => {
  const mode = useUIStore((state) => state.mobileKeepScreenAwake);
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const working = useGlobalSessionStatusStore((state) => (
    sessionId !== null && (state.activeSessionIds.has(sessionId) || hasActiveSubagent(sessionId, state.activeSessionIds))
  ));
  const directory = useSessionUIStore((state) => state.currentSessionDirectory);
  const spaceId = spaceIdOfDirectory(directory);
  const spaceDown = useSpacesStore((state) => spaceId !== null && state.spaces.get(spaceId)?.state === 'stale');
  const spaceStopped = useSpaceDirectoryStopped(directory);
  const wanted = mode === 'always' || (mode === 'working' && working && connected && !spaceDown && !spaceStopped);

  React.useEffect(() => {
    if (!canKeepScreenAwake()) return;
    if (getClientPlatform() === 'ios') {
      setIdleTimerDisabled(wanted);
      return wanted ? () => setIdleTimerDisabled(false) : undefined;
    }
    if (!wanted) return;
    let disposed = false;
    let requesting = false;
    let sentinel: WakeLockSentinel | null = null;
    const acquire = async () => {
      if (requesting || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      requesting = true;
      try {
        const next = await navigator.wakeLock.request('screen');
        if (disposed) void next.release();
        else sentinel = next;
      } catch {
        // Refused, for one by battery saver: the next return to the screen asks again.
      } finally {
        requesting = false;
      }
    };
    const handleVisibilityChange = () => { void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      void sentinel?.release();
    };
  }, [wanted]);
};
