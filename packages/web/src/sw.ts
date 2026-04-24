/// <reference lib="webworker" />

/**
 * Architectural decision: Workbox service worker for TWA (Android)
 *
 * This service worker uses Workbox caching strategies (precacheAndRoute, NetworkFirst,
 * CacheFirst, ExpirationPlugin) to provide offline support and performance optimization
 * for the Android TWA (Trusted Web Activity) build of OpenChamber.
 *
 * TWA is an Android-only distribution — it runs inside Chrome Custom Tabs, not in iOS Safari.
 * The upstream codebase previously set `injectionPoint: undefined` and omitted workbox
 * dependencies to avoid iOS Safari service-worker stability issues. That concern does not
 * apply here: TWA targets Chrome on Android, where workbox is well-supported.
 *
 * When the app is NOT built for TWA (default web/PWA), VitePWA's `injectionPoint` is
 * `undefined` and `self.__WB_MANIFEST` resolves to an empty array, so this file degrades
 * gracefully — precacheAndRoute([]) is a no-op and the caching routes simply don't fire.
 */

import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { NetworkFirst, CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import type { RouteHandler } from 'workbox-core';

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

precacheAndRoute(self.__WB_MANIFEST);

const OFFLINE_BODY = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenChamber – Offline</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#100f0f;color:#fffcf0}
  .card{text-align:center;max-width:360px;padding:2rem}
  h1{font-size:1.5rem;margin:0 0 .5rem}
  p{color:#9e9b93;margin:0 0 1.5rem;line-height:1.5}
  button{background:#66800b;color:#fffcf0;border:none;border-radius:.5rem;padding:.6rem 1.4rem;font-size:1rem;cursor:pointer}
  button:hover{background:#4d6008}
</style>
</head>
<body><div class="card">
<h1>You're offline</h1>
<p>OpenChamber can't reach the server right now. Check your connection and try again.</p>
<button onclick="location.reload()">Retry</button>
</div></body>
</html>`;

const offlineFallbackResponse = () => new Response(OFFLINE_BODY, {
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
});

const navHandler = new NetworkFirst({
  networkTimeoutSeconds: 3,
  cacheName: 'nav-cache',
  plugins: [
    new ExpirationPlugin({ maxEntries: 50, maxAgeSeconds: 7 * 24 * 60 * 60 }),
    {
      handlerDidError: async () => offlineFallbackResponse(),
    },
  ],
}) as unknown as RouteHandler;

registerRoute(new NavigationRoute(navHandler));

registerRoute(
  ({ url }: { url: URL }) => url.pathname.startsWith('/api/'),
  new NetworkFirst({
    networkTimeoutSeconds: 30,
    cacheName: 'api-cache',
    plugins: [
      new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 5 * 60 }),
    ],
  }) as unknown as RouteHandler,
);

registerRoute(
  ({ request }: { request: Request }) =>
    request.destination === 'image' || request.destination === 'font',
  new CacheFirst({
    cacheName: 'static-assets',
    plugins: [
      new ExpirationPlugin({
        maxEntries: 200,
        maxAgeSeconds: 30 * 24 * 60 * 60,
      }),
    ],
  }) as unknown as RouteHandler,
);

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
    let payload: PushPayload | null;
    try {
      payload = (event.data?.json() ?? null) as PushPayload | null;
    } catch {
      // Push payload was not valid JSON — ignore silently
      return;
    }
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
