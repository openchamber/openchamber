import { useDaytonaSandboxStore } from '@/stores/useDaytonaSandboxStore';
import { toast } from '@/components/ui';

/**
 * Handles a sandbox inactivity timeout notification from the server.
 * Call this when the backend sends an event indicating a sandbox was or will be
 * destroyed due to inactivity (10+ minutes of no activity).
 */
export function handleSandboxTimeoutNotification(sessionId: string): void {
  const { setSandboxStatus } = useDaytonaSandboxStore.getState();

  setSandboxStatus(sessionId, { status: 'timed-out' });

  toast.warning('Sandbox timed out', {
    description: `The sandbox for session ${sessionId.slice(0, 8)}... was destroyed due to inactivity.`,
  });
}

/**
 * Handles a sandbox destroyed event (explicit or implicit).
 */
export function handleSandboxDestroyedNotification(sessionId: string): void {
  const { setSandboxStatus } = useDaytonaSandboxStore.getState();

  setSandboxStatus(sessionId, { status: 'destroyed' });

  toast.info('Sandbox destroyed', {
    description: `The sandbox for session ${sessionId.slice(0, 8)}... has been shut down.`,
  });
}
