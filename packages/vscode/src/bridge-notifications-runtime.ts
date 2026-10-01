import { showVSCodeNotification } from './notifications';
import type { BridgeResponse } from './bridge';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

/** Notification delivery bridge. Extensible: kinds route inside `notifications.ts`, not here. */
export async function handleNotificationsBridgeMessage(
  message: BridgeMessageInput,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  if (type === 'api:notifications:show') {
    const shown = await showVSCodeNotification((payload ?? {}) as Parameters<typeof showVSCodeNotification>[0]);
    return { id, type, success: true, data: { shown } };
  }

  return null;
}
