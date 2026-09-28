import type { TelemetryAPI } from '@openchamber/ui/lib/api/types';

interface DesktopBridgeGlobal {
  __OPENCHAMBER_DESKTOP__?: {
    trackTelemetryEvent?: (name: string, props?: Record<string, string | number | boolean>) => void;
  };
}

interface PostHogTelemetryClient {
  init(appKey: string, options: Record<string, unknown>): void;
  capture(name: string, properties?: Record<string, unknown>): void;
}

function getPostHogConfig() {
  // SAFETY: Safely accessing optional import.meta.env properties for Vite/web bundlers.
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  const processEnv = globalThis.process?.env;

  const appKey =
    metaEnv?.VITE_POSTHOG_APP_KEY ||
    metaEnv?.POSTHOG_APP_KEY ||
    processEnv?.VITE_POSTHOG_APP_KEY ||
    processEnv?.POSTHOG_APP_KEY ||
    '';
  const hostUrl =
    metaEnv?.VITE_POSTHOG_HOST_URL ||
    metaEnv?.POSTHOG_HOST_URL ||
    processEnv?.VITE_POSTHOG_HOST_URL ||
    processEnv?.POSTHOG_HOST_URL ||
    'https://eu.i.posthog.com';

  return { appKey, hostUrl };
}

// posthog-js evaluates browser globals at import time (it reads `location`),
// so a top-level import crashes any non-browser environment that merely
// reaches this module — tests that build the web RuntimeAPIs, for one. The
// module loads lazily on the first event, which also keeps the guarantee
// that nothing loads, sends, or persists before a consented event exists.
let posthogClientPromise: Promise<PostHogTelemetryClient | null> | null = null;

const loadPostHogClient = (): Promise<PostHogTelemetryClient | null> => {
  if (!posthogClientPromise) {
    posthogClientPromise = import('posthog-js')
      .then((mod) => mod.default)
      .catch((err) => {
        console.warn('[PostHog] Failed to load:', err);
        return null;
      });
  }
  return posthogClientPromise;
};

export function createWebTelemetryAPI(
  posthogClient?: PostHogTelemetryClient,
  config?: { appKey: string; hostUrl: string },
): TelemetryAPI {
  // Per-API-instance state: the API is created once per app, and keeping the
  // flags here (not module-level) lets tests build isolated instances.
  let isInitialized = false;
  let hasLoggedMissingKey = false;

  const initIfNeeded = async (): Promise<PostHogTelemetryClient | null> => {
    if (isInitialized) return posthogClient ?? (await loadPostHogClient());
    const { appKey, hostUrl } = config ?? getPostHogConfig();

    if (appKey && globalThis.window !== undefined) {
      const client = posthogClient ?? (await loadPostHogClient());
      if (!client) return null;
      try {
        client.init(appKey, {
          api_host: hostUrl,
          ip: false, // ZERO-PII: IP tracking disabled
          persistence: 'localStorage',
          autocapture: false,
          capture_pageview: false,
          capture_pageleave: false,
          disable_session_recording: true,
          advanced_disable_decide: true,
        });
        isInitialized = true;
        console.info('[PostHog] Initialized successfully with host:', hostUrl);
        return client;
      } catch (err) {
        console.warn('[PostHog] Failed to initialize:', err);
      }
    } else if (!appKey && !hasLoggedMissingKey && globalThis.window !== undefined) {
      hasLoggedMissingKey = true;
      console.warn('[PostHog] VITE_POSTHOG_APP_KEY is missing from environment.');
    }
    return null;
  };

  // PostHog deliberately initializes lazily inside trackEvent, never at API
  // creation, so nothing is sent or persisted before a consented event arrives.

  return {
    trackEvent(name: string, properties?: Record<string, string | number | boolean>) {
      // SAFETY: Accessing optional desktop bridge attached to globalThis by Electron preload script.
      const desktopWin = globalThis.window as (Window & DesktopBridgeGlobal) | undefined;
      const desktopBridge = desktopWin?.__OPENCHAMBER_DESKTOP__;

      if (desktopBridge?.trackTelemetryEvent) {
        desktopBridge.trackTelemetryEvent(name, properties);
        return;
      }

      void initIfNeeded().then((client) => {
        client?.capture(name, properties);
      });
    },
  };
}