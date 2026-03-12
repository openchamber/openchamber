import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

type NotifyResponse = { shown?: boolean };

export const createVSCodeNotificationsAPI = (): NotificationsAPI => ({
  async notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean> {
    try {
      const response = await sendBridgeMessage<NotifyResponse>('notifications:notify', { payload });
      return Boolean(response?.shown);
    } catch {
      return false;
    }
  },

  async canNotify(): Promise<boolean> {
    try {
      return await sendBridgeMessage<boolean>('notifications:can-notify');
    } catch {
      return false;
    }
  },
});
