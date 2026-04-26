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

type PrerenderingDocument = Document & {
  prerendering?: boolean;
};

const canUseServiceWorker = (): boolean => {
  if (!('serviceWorker' in navigator)) return false;
  if (!window.isSecureContext) return false;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return false;

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    return false;
  }

  return true;
};

const runWhenDocumentCanRegisterServiceWorker = (task: () => void): void => {
  let completed = false;
  const run = () => {
    if (completed) return;
    if (canUseServiceWorker()) {
      completed = true;
      task();
    }
  };

  const afterLoad = () => {
    setTimeout(run, 0);
  };

  if (document.readyState === 'complete') {
    afterLoad();
  } else {
    window.addEventListener('load', afterLoad, { once: true });
  }

  const documentState = document as PrerenderingDocument;
  if (documentState.prerendering || String(document.visibilityState) === 'prerender') {
    document.addEventListener('visibilitychange', run, { once: true });
  }
};

const registerPwaServiceWorker = (): void => {
 runWhenDocumentCanRegisterServiceWorker(() => {
 try {
 registerSW({
 onRegisterError(error: unknown) {
 console.warn('[PWA] service worker registration skipped:', error);
 },
 });
 } catch (error) {
 console.warn('[PWA] service worker registration skipped:', error);
 }

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
 });
};

const unregisterDevelopmentServiceWorkers = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  });
};

void import('@openchamber/ui/main');

if (import.meta.env.PROD) {
  registerPwaServiceWorker();
} else {
  unregisterDevelopmentServiceWorkers();
}
