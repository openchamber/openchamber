/// <reference lib="webworker" />

import { z } from 'zod';






declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

const __precacheManifest = self.__WB_MANIFEST;

type PushPayload = {
  title?: string;
  body?: string;
  tag?: string;



  clear?: string[];
  data?: {
    url?: string;
    sessionId?: string;
    type?: string;

    nid?: string;
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

    await closeHandledNotifications(payload.clear);

    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const hasVisibleClient = clients.some((client) => client.visibilityState === 'visible' || client.focused);
    if (hasVisibleClient) {
      return;
    }

    const title = payload.title || 'OpenChamber';
    const body = payload.body ?? '';
    const icon = payload.icon ?? '/apple-touch-icon-180x180.png';
    const badge = payload.badge ?? '/favicon-32.png';

    const options: NotificationOptions & { renotify?: boolean } = {
      body,
      icon,
      badge,
      tag: payload.tag,
      data: payload.data,
    };
    if (payload.tag) {
      options.renotify = true;
    }
    await self.registration.showNotification(title, options);
  })());
});



async function closeHandledNotifications(entries: string[] | undefined): Promise<void> {
  if (!entries?.length) return;
  const covered = new Map<string, number | null>();
  for (const entry of entries) {
    const [tag, id] = entry.split('@');
    if (tag) covered.set(tag, id ? Number(id) : null);
  }
  const shown = await self.registration.getNotifications();
  for (const notification of shown) {
    if (!notification.tag || !covered.has(notification.tag)) continue;
    const upTo = covered.get(notification.tag) ?? null;

    const shownId = Number(notification.data?.nid);
    if (upTo === null || Number.isNaN(upTo) || Number.isNaN(shownId) || shownId <= upTo) notification.close();
  }
}



type NavigationReply = boolean | { openWindow: string };

const openWindowReplySchema = z.object({ type: z.literal('open-window'), url: z.url({ protocol: /^https?$/ }) });

const navigationWaitMs = (url: string): number => (new URL(url).searchParams.has('item') ? 3000 : 1500);

function requestAppNavigation(client: WindowClient, url: string): Promise<NavigationReply> {
  const waitMs = navigationWaitMs(url);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (reply: NavigationReply) => {
      clearTimeout(timeout);
      channel.port1.close();
      channel.port2.close();
      resolve(reply);
    };
    const timeout = setTimeout(() => finish(false), waitMs);
    channel.port1.onmessage = (event: MessageEvent<unknown>) => {
      const openWindow = openWindowReplySchema.safeParse(event.data);
      finish(openWindow.success ? { openWindow: new URL(openWindow.data.url).href } : event.data === true);
    };
    channel.port1.onmessageerror = () => finish(false);
    try {
      client.postMessage({
        type: 'openchamber:notification-navigation',
        url,
        expiresAt: Date.now() + waitMs,
        canOpenWindow: true,
      }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

const focusHandled = (client: WindowClient): Promise<void> => client.focus().then(() => undefined, () => undefined);

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

    const asksFirst = new URL(target).searchParams.has('item');
    for (const client of windowClients) {
      try {
        if (!asksFirst) await client.focus();
        const reply = await requestAppNavigation(client, target);
        if (typeof reply === 'object') {
          await self.clients.openWindow(reply.openWindow).catch(() => null);
          return;
        }
        if (reply) {
          if (asksFirst) await focusHandled(client);
          return;
        }
        const navigated = await client.navigate(target);
        if (navigated) {
          if (asksFirst) await focusHandled(navigated);
          return;
        }
      } catch {
        // A window can close between enumeration and focus/navigation.
      }
    }

    if (self.clients.openWindow) {
      const opened = new URL(target);
      if (opened.searchParams.has('item')) opened.searchParams.set('itemTab', '1');
      return self.clients.openWindow(opened.href);
    }
  })());
});
