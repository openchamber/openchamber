import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

export const createVSCodeNotificationsAPI = (): NotificationsAPI => ({
  async notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean> {
    try {
      const result = await sendBridgeMessage<{ shown?: boolean }>('api:notifications:show', {
        title: payload?.title,
        body: payload?.body,
      });
      return result?.shown === true;
    } catch {
      return false;
    }
  },
});
