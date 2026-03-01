import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';

const notifyWithWebAPI = async (payload?: NotificationPayload): Promise<boolean> => {
  if (typeof Notification === 'undefined') {
    console.info('Notifications not supported in this environment', payload);
    return false;
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission not granted');
      return false;
    }
  }

  if (Notification.permission !== 'granted') {
    console.warn('Notification permission not granted');
    return false;
  }

  try {
    new Notification(payload?.title ?? 'OpenChamber', {
      body: payload?.body,
      tag: payload?.tag,
    });
    return true;
  } catch (error) {
    console.warn('Failed to send notification', error);
    return false;
  }
};

const notifyWithTauri = async (payload?: NotificationPayload): Promise<boolean> => {
  if (typeof window === 'undefined') {
    return false;
  }

  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  if (!tauri?.core?.invoke) {
    return false;
  }

  try {
    if (tauri.notification?.sendNotification) {
      const isGranted = await tauri.notification.isPermissionGranted?.();
      let granted = isGranted === true;
      if (!granted) {
        const permission = await tauri.notification.requestPermission?.();
        granted = permission === 'granted';
      }
      if (!granted) {
        return false;
      }
      await tauri.notification.sendNotification({
        title: payload?.title,
        body: payload?.body,
        tag: payload?.tag,
      });
      return true;
    }

    await tauri.core.invoke('desktop_notify', {
      payload: {
        title: payload?.title,
        body: payload?.body,
        tag: payload?.tag,
      },
    });
    return true;
  } catch (error) {
    console.warn('Failed to send native notification (tauri)', error);
    return false;
  }
};

export const createWebNotificationsAPI = (): NotificationsAPI => ({
  async notifyAgentCompletion(payload?: NotificationPayload): Promise<boolean> {
    return (await notifyWithTauri(payload)) || notifyWithWebAPI(payload);
  },
  canNotify: () => {
    if (typeof window !== 'undefined') {
      const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
      if (tauri?.notification?.isPermissionGranted) {
        return true;
      }
      if (tauri?.core?.invoke) {
        return true;
      }
    }
    return typeof Notification !== 'undefined' ? Notification.permission === 'granted' : false;
  },
});
type TauriGlobal = {
  core?: {
    invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };
  notification?: {
    isPermissionGranted?: () => Promise<boolean>;
    requestPermission?: () => Promise<'granted' | 'denied' | 'default' | string>;
    sendNotification?: (payload: { title?: string; body?: string; tag?: string }) => Promise<void> | void;
  };
};
