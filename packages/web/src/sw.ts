/// <reference lib="webworker" />

// NOTE: keep the Workbox injection point so vite-plugin-pwa can build.
// We intentionally do not use Workbox runtime helpers here: iOS Safari can be
// fragile with more complex SW bundles. For push notifications we only need a
// minimal SW.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

const __precacheManifest = self.__WB_MANIFEST;

type PushPayload = {
  title?: string;
  body?: string;
  tag?: string;
  data?: {
    url?: string;
    sessionId?: string;
    type?: string;
  };
  icon?: string;
  badge?: string;
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    const payload = (event.data?.json() ?? null) as PushPayload | null;
    if (!payload) {
      return;
    }

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisibleClient = clients.some((client) => client.visibilityState === 'visible' || client.focused);
    if (hasVisibleClient) {
      return;
    }

    const title = payload.title || 'OpenChamber';
    const body = payload.body ?? '';
    const icon = payload.icon ?? '/apple-touch-icon-180x180.png';
    const badge = payload.badge ?? '/favicon-32.png';

    await self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag: payload.tag,
      data: payload.data,
    });
  })());
});

// An older page may not understand the message, so only skip navigation after
// the mounted app explicitly accepts it. Focus first to wake suspended pages.
function requestAppNavigation(client: WindowClient, url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (accepted: boolean) => {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      resolve(accepted);
    };
    const timeout = setTimeout(() => finish(false), 1500);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => finish(event.data === true);
    channel.port1.onmessageerror = () => finish(false);
    try {
      client.postMessage({
        type: 'openchamber:notification-navigation',
        url,
        expiresAt: Date.now() + 1500,
      }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  // SAFETY: notification data is only ever written by our own showNotification
  // and push payloads as { url, sessionId }; both fields are re-validated as
  // trimmed strings below before use.
  const data = (event.notification.data ?? null) as { url?: string; sessionId?: string } | null;
  const rawUrl = typeof data?.url === 'string' ? data.url.trim() : '';
  const rawSessionId = typeof data?.sessionId === 'string' ? data.sessionId.trim() : '';
  const url = rawUrl || (rawSessionId ? `/?session=${encodeURIComponent(rawSessionId)}` : '/');

  event.waitUntil((async () => {
    const target = new URL(url, self.location.origin).href;
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of windowClients) {
      try {
        await client.focus();
        if (await requestAppNavigation(client, target)) {
          return;
        }
        const navigated = await client.navigate(target);
        if (navigated) return;
      } catch {
        // A window can close between enumeration and focus/navigation.
      }
    }

    if (self.clients.openWindow) {
      return self.clients.openWindow(target);
    }
  })());
});
