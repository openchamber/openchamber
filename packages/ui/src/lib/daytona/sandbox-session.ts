import { useEffect, useRef, useCallback } from 'react';
import { useDaytonaSandboxStore } from '@/stores/useDaytonaSandboxStore';
import {
  createDaytonaSandbox,
  destroyDaytonaSandbox,
  sendActivityHeartbeat,
} from './api';

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Hook that manages the lifecycle of a Daytona sandbox for a given session.
 *
 * When sandbox mode is enabled and a sessionId is provided:
 * 1. Creates a sandbox when the session is first mounted
 * 2. Sets up an activity heartbeat interval (every 2 minutes)
 * 3. Provides a destroy function for the exit command
 * 4. Cleans up the heartbeat on unmount (does not auto-destroy - see destroySandbox)
 */
export function useSandboxSession(sessionId: string | null | undefined) {
  const sandboxMode = useDaytonaSandboxStore((state) => state.sandboxMode);
  const setSandboxStatus = useDaytonaSandboxStore((state) => state.setSandboxStatus);
  const removeSandbox = useDaytonaSandboxStore((state) => state.removeSandbox);
  const getSandboxForSession = useDaytonaSandboxStore((state) => state.getSandboxForSession);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const creatingRef = useRef<string | null>(null);

  // Create sandbox when the session starts (if sandbox mode is on)
  useEffect(() => {
    if (!sandboxMode || !sessionId) return;

    const existing = getSandboxForSession(sessionId);
    if (existing) return;
    if (creatingRef.current === sessionId) return;

    creatingRef.current = sessionId;
    setSandboxStatus(sessionId, { status: 'creating' });

    createDaytonaSandbox(sessionId)
      .then((info) => {
        setSandboxStatus(sessionId, info);
      })
      .catch((error) => {
        console.error('[daytona] Failed to create sandbox:', error);
        setSandboxStatus(sessionId, {
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (creatingRef.current === sessionId) {
          creatingRef.current = null;
        }
      });
  }, [sandboxMode, sessionId, getSandboxForSession, setSandboxStatus]);

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
