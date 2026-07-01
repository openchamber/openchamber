import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';

const showWebviewNotification = async (payload?: NotificationPayload): Promise<boolean> => {
  if (typeof Notification === 'undefined') {
    return false;
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return false;
    }
  }

  if (Notification.permission !== 'granted') {
    return false;
  }

  const title = typeof payload?.title === 'string' && payload.title.trim().length > 0
    ? payload.title.trim()
    : 'OpenChamber';
  const body = typeof payload?.body === 'string' ? payload.body : '';

  new Notification(title, { body });
  return true;
};

export const createVSCodeNotificationsAPI = (): NotificationsAPI => ({
  async notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean> {
    try {
      return await showWebviewNotification(payload);
    } catch {
      return false;
    }
  },

  async canNotify(): Promise<boolean> {
    return typeof Notification !== 'undefined' && Notification.permission !== 'denied';
  },
});
