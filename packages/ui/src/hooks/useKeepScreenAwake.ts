import { registerPlugin } from '@capacitor/core';
import React from 'react';

import { canKeepScreenAwake, getClientPlatform } from '@/lib/platform';
import { useUIStore } from '@/stores/useUIStore';
import { hasActiveSubagent, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionUIStore } from '@/sync/session-ui-store';

interface KeepAwakePlugin {
  setEnabled(options: { enabled: boolean }): Promise<void>;
}

// iOS only (KeepAwake.swift): WKWebView grants navigator.wakeLock only inside a tap.
const KeepAwake = registerPlugin<KeepAwakePlugin>('KeepAwake');

const setIdleTimerDisabled = (enabled: boolean): void => {
  void KeepAwake.setEnabled({ enabled }).catch(() => undefined);
};

/**
 * Keeps the display on in the native app as the Keep screen awake setting says:
 * always, or while the open session or a subagent below it runs. On Android the
 * system drops the wake lock whenever the app leaves the screen, so it is
 * requested again each time the page becomes visible. iOS turns off its idle
 * timer through the app's own plugin.
 *
 * While disconnected the status store keeps the last busy state, so "working"
 * also needs `connected`. That covers a dead server only once `isConnected`
 * stays false: today a WS → SSE fallback sets it back to true with nothing
 * connected (sync-context `onTransportSwitch`). Android keeps the screen on for
 * one timeout after a release, so a short drop does not blank it.
 */
export const useKeepScreenAwake = (connected: boolean): void => {
  const mode = useUIStore((state) => state.mobileKeepScreenAwake);
  const sessionId = useSessionUIStore((state) => state.currentSessionId);
  const working = useGlobalSessionStatusStore((state) => (
    sessionId !== null && (state.activeSessionIds.has(sessionId) || hasActiveSubagent(sessionId, state.activeSessionIds))
  ));
  const wanted = mode === 'always' || (mode === 'working' && working && connected);

  React.useEffect(() => {
    if (!canKeepScreenAwake()) return;
    if (getClientPlatform() === 'ios') {
      // Written when unwanted too: a reloaded page must clear what the previous one set.
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
