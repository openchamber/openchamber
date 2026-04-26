import type { NotificationPayload, NotificationsAPI } from '@openchamber/ui/lib/api/types';

const SW_READY_TIMEOUT_MS = 1500;

const getNotificationRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return null;
  }

  let existing: ServiceWorkerRegistration | null = null;
  try {
    existing = (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    existing = null;
  }

  if (existing?.active) {
    return existing;
  }

  if (!existing) {
    return null;
  }

  try {
    const ready = await Promise.race<ServiceWorkerRegistration | null>([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS);
      }),
    ]);

    return ready ?? existing;
  } catch {
    return existing;
  }
};

const notifyWithServiceWorker = async (payload?: NotificationPayload): Promise<boolean> => {
  const registration = await getNotificationRegistration();
  if (!registration || typeof registration.showNotification !== 'function') {
    return false;
  }

  try {
    await registration.showNotification(payload?.title ?? 'OpenChamber', {
      body: payload?.body,
      tag: payload?.tag,
    });
    return true;
  } catch (error) {
    console.warn('Failed to send notification via service worker', error);
    return false;
  }
};

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
    // Some installed PWAs expose Notification.permission but only allow
    // notifications through an active service worker registration.
    if (await notifyWithServiceWorker(payload)) {
      return true;
    }

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
    return (await notifyWithTauri(payload)) || (await notifyWithWebAPI(payload));
  },
  canNotify: () => {
    if (typeof window !== 'undefined') {
      const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
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
};
