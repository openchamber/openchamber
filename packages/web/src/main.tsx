import { createConfiguredWebAPIs, getDesktopRelayRestoreReady } from './runtimeConfig';
import { registerSW } from 'virtual:pwa-register';

import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import { resolveHostedSurface, watchHostedSurfaceViewport, type HostedSurface } from '@openchamber/ui/lib/runtimeSurface';
import { importWithChunkRecovery } from '@openchamber/ui/lib/chunkLoadRecovery';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';
import '@openchamber/ui/styles/katex-css';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
    __OPENCHAMBER_SURFACE__?: HostedSurface;
  }
}

const hostedSurface: HostedSurface = resolveHostedSurface();

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
  });
};

const unregisterDevelopmentServiceWorkers = (): void => {
  runWhenDocumentCanRegisterServiceWorker(() => {
    void navigator.serviceWorker.getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .catch(() => {});
  });
};

const start = async (): Promise<void> => {
  window.__OPENCHAMBER_RUNTIME_APIS__ = createConfiguredWebAPIs();

  // Reload into the other app shell when the viewport crosses the phone
  // threshold after boot (no-op in fixed shells and with ?surface= overrides).
  watchHostedSurfaceViewport();

  if (hostedSurface === 'mobile') {
    const { renderMobileApp } = await importWithChunkRecovery(() => import('@openchamber/ui/apps/renderMobileApp'));
    renderMobileApp(window.__OPENCHAMBER_RUNTIME_APIS__);
    return;
  }

  // Hold the render until a desktop relay-host restore has picked its transport.
  await getDesktopRelayRestoreReady();
  // A module of the app that failed to load (a dropped connection while the
  // dev server compiles, a chunk replaced by an update) left an empty page
  // for good; it is tried again, then the page reloads once.
  await importWithChunkRecovery(() => import('@openchamber/ui/main'));
};

void start();

if (import.meta.hot) {
  import.meta.hot.on('openchamber:theme-updated', (theme: unknown) => {
    window.dispatchEvent(new CustomEvent('openchamber:theme-hmr', { detail: theme }));
  });
}

if (import.meta.env.PROD) {
  registerPwaServiceWorker();
} else {
  unregisterDevelopmentServiceWorkers();
}
