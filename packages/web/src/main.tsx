import { createWebAPIs } from './api';
import { registerSW } from 'virtual:pwa-register';

import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

window.__OPENCHAMBER_RUNTIME_APIS__ = createWebAPIs();

if (import.meta.env.PROD) {
 registerSW({
 onRegisterError(error: unknown) {
   console.warn('[PWA] service worker registration failed:', error);
 },
 });

 // Notify the service worker about TWA context so it can activate
 // Workbox caching routes only when running inside an Android TWA.
 if (typeof window.AndroidNotificationBridge?.getServerUrl === 'function') {
  const notifySw = () => {
   const controller = navigator.serviceWorker.controller;
   if (controller) {
    controller.postMessage({ type: 'TWA_CONTEXT' });
   }
  };
  if (navigator.serviceWorker.controller) {
   notifySw();
  } else {
   navigator.serviceWorker.addEventListener('controllerchange', notifySw, { once: true });
  }
 }
} else if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.getRegistrations()
    .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
    .catch(() => {});
}

import('@openchamber/ui/main');
