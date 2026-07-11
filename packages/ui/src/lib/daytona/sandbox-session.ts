import { useEffect, useRef, useCallback } from 'react';
import { useDaytonaSandboxStore } from '@/stores/useDaytonaSandboxStore';
import {
  destroyDaytonaSandbox,
  sendActivityHeartbeat,
} from './api';

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Hook that manages the lifecycle of a Daytona sandbox for a given session.
 *
 * Sandbox creation is handled by session-actions.ts (provisionSandboxForSession)
 * which fires synchronously on session creation. This hook only manages:
 * 1. Activity heartbeat interval (every 2 minutes)
 * 2. A destroy function for the exit command
 * 3. Cleanup of the heartbeat on unmount
 */
export function useSandboxSession(sessionId: string | null | undefined) {
  const sandboxMode = useDaytonaSandboxStore((state) => state.sandboxMode);
  const setSandboxStatus = useDaytonaSandboxStore((state) => state.setSandboxStatus);
  const removeSandbox = useDaytonaSandboxStore((state) => state.removeSandbox);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Heartbeat interval
  useEffect(() => {
    if (!sandboxMode || !sessionId) return;

    heartbeatRef.current = setInterval(() => {
      const sandbox = useDaytonaSandboxStore.getState().getSandboxForSession(sessionId);
      if (sandbox && sandbox.status === 'running') {
        sendActivityHeartbeat(sessionId).catch(() => {
          // heartbeat failures are non-fatal
        });
      }
    }, HEARTBEAT_INTERVAL_MS);

    return () => {
      if (heartbeatRef.current) {
        clearInterval(heartbeatRef.current);
        heartbeatRef.current = null;
      }
    };
  }, [sandboxMode, sessionId]);

  // Destroy sandbox (used when user gives exit command)
  const destroySandbox = useCallback(async () => {
    if (!sessionId) return;
    const sandbox = useDaytonaSandboxStore.getState().getSandboxForSession(sessionId);
    if (!sandbox || sandbox.status === 'destroyed' || sandbox.status === 'stopping') return;

    setSandboxStatus(sessionId, { status: 'stopping' });

    try {
      await destroyDaytonaSandbox(sessionId);
      removeSandbox(sessionId);
    } catch (error) {
      console.error('[daytona] Failed to destroy sandbox:', error);
      setSandboxStatus(sessionId, {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [sessionId, setSandboxStatus, removeSandbox]);

  return { destroySandbox };
}
