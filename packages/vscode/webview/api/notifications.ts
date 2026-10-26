import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';
import { sendBridgeMessage } from './bridge';

// The extension host shows notifications: Chromium never displays a
// `new Notification()` from a VS Code webview frame.
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
