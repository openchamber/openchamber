/// <reference lib="webworker" />

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

declare const __APP_VERSION__: string;

const PRECACHE_CACHE_NAME = `openchamber-precache-${__APP_VERSION__}`;

function manifestUrls(): string[] {
  return self.__WB_MANIFEST.map((entry) =>
    typeof entry === 'string' ? entry : entry.url,
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // Always start from a clean cache for this version so stale hashed
      // assets from previous builds do not survive when the version hasn't
      // changed.
      await caches.delete(PRECACHE_CACHE_NAME);
      const cache = await caches.open(PRECACHE_CACHE_NAME);
      await cache.addAll(manifestUrls());
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith('openchamber-precache-') && key !== PRECACHE_CACHE_NAME)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

// Cache-first for precached build assets. We intentionally do NOT write
// runtime responses back to the cache: the precache manifest already
// contains the assets needed for first paint, and the large lazy-loaded
// chunks excluded from precache (>2 MB: shikijs-langs, font effects,
// diagrams, etc.) should not bloat the SW install. They will still load
// normally when the feature that needs them is triggered.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }
  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ||
        fetch(event.request).catch((error) => {
          console.error('[SW] fetch failed', event.request.url, error);
          throw error;
        }),
    ),
  );
});

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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = (event.notification.data ?? null) as { url?: string } | null;
  const url = data?.url ?? '/';

  event.waitUntil(self.clients.openWindow(url));
});
