import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isElectronShell } from '@/lib/desktop';

export const CURRENT_TELEMETRY_CONSENT_VERSION = 1;

/**
 * Consent is owned by the UI store (persisted, settings-synced); this module
 * keeps only a copy pushed through `setTelemetryConsentState`. Tracking
 * modules import this light module, never the full UI store. Until a push
 * arrives — store init rehydration or a consent setter — consent counts as
 * absent and events are dropped.
 */
let consentState = { reportUsage: false, consentVersion: 0 };

export function setTelemetryConsentState(next: { reportUsage: boolean; consentVersion: number }): void {
  consentState = { reportUsage: next.reportUsage === true, consentVersion: next.consentVersion };
}

export function isTelemetryDisabledByEnv(): boolean {
  const processEnv = globalThis.process?.env;
  if (processEnv) {
    if (
      processEnv.OPENCHAMBER_DISABLE_TELEMETRY === '1' ||
      processEnv.DO_NOT_TRACK === '1' ||
      processEnv.VITE_DISABLE_TELEMETRY === '1'
    ) {
      return true;
    }
  }
  // SAFETY: Safely accessing optional import.meta.env properties for Vite/web bundlers.
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  if (metaEnv) {
    if (
      metaEnv.VITE_DISABLE_TELEMETRY === '1' ||
      metaEnv.OPENCHAMBER_DISABLE_TELEMETRY === '1'
    ) {
      return true;
    }
  }
  return false;
}

export function getTelemetryChannel(): 'beta' | 'stable' {
  const processEnv = globalThis.process?.env;
  const channelOverride = processEnv?.VITE_OPENCHAMBER_CHANNEL || processEnv?.OPENCHAMBER_CHANNEL;
  if (channelOverride === 'beta' || channelOverride === 'stable') {
    return channelOverride;
  }
  // SAFETY: Safely accessing optional import.meta.env properties for Vite/web bundlers.
  const metaEnv = (import.meta as { env?: { DEV?: boolean } & Record<string, string | undefined> }).env;
  const metaOverride = metaEnv?.VITE_OPENCHAMBER_CHANNEL || metaEnv?.OPENCHAMBER_CHANNEL;
  if (metaOverride === 'beta' || metaOverride === 'stable') {
    return metaOverride;
  }
  // Dev builds report beta the same way the desktop shell does
  // (app.isPackaged ? 'stable' : 'beta'), so dev traffic stays separable.
  if (metaEnv?.DEV === true) {
    return 'beta';
  }
  const version = processEnv?.VITE_APP_VERSION || processEnv?.APP_VERSION || metaEnv?.VITE_APP_VERSION || '';
  if (version.includes('-beta') || version.includes('-rc') || version.includes('-alpha') || version.includes('-dev')) {
    return 'beta';
  }
  return 'stable';
}

export function getTelemetryConnection(): 'local' | 'remote' {
  const win = globalThis.window;
  if (!win) return 'local';
  try {
    // SAFETY: Electron preload / runtime optionally sets __OPENCHAMBER_API_BASE_URL__ on window.
    const rawApi = (win as { __OPENCHAMBER_API_BASE_URL__?: string }).__OPENCHAMBER_API_BASE_URL__ || '';
    if (rawApi) {
      const url = new URL(rawApi);
      const host = url.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') {
        return 'local';
      }
      return 'remote';
    }
    const host = win.location?.hostname || '';
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      return 'local';
    }
    return 'remote';
  } catch {
    return 'local';
  }
}

declare const __APP_VERSION__: string | undefined;

export function getTelemetryAppVersion(): string {
  if (typeof __APP_VERSION__ !== 'undefined' && __APP_VERSION__) {
    return __APP_VERSION__;
  }
  const processEnv = globalThis.process?.env;
  // SAFETY: Safely accessing optional import.meta.env properties for Vite/web bundlers.
  const metaEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
  return processEnv?.VITE_APP_VERSION || processEnv?.APP_VERSION || metaEnv?.VITE_APP_VERSION || 'unknown';
}

export function getTelemetrySurface(): string {
  const win = globalThis.window as {
    Capacitor?: { getPlatform?: () => string; isNativePlatform?: () => boolean };
  } | undefined;

  const capPlatform = win?.Capacitor?.getPlatform?.();
  if (win?.Capacitor?.isNativePlatform?.() && capPlatform) {
    return capPlatform; // 'ios' | 'android'
  }

  if (isElectronShell()) {
    return 'desktop';
  }

  const apis = getRegisteredRuntimeAPIs();
  return apis?.runtime?.platform || 'web';
}

export function getTelemetryOS(): string {
  const win = globalThis.window as {
    Capacitor?: { getPlatform?: () => string };
  } | undefined;

  const capPlatform = win?.Capacitor?.getPlatform?.();
  if (capPlatform === 'ios') return 'iOS';
  if (capPlatform === 'android') return 'Android';

  const processEnv = globalThis.process;
  if (processEnv?.platform) {
    if (processEnv.platform === 'darwin') return 'macOS';
    if (processEnv.platform === 'win32') return 'Windows';
    if (processEnv.platform === 'linux') return 'Linux';
  }

  if (typeof navigator !== 'undefined') {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
    if (/Android/i.test(ua)) return 'Android';
    if (/Mac/i.test(ua)) return 'macOS';
    if (/Win/i.test(ua)) return 'Windows';
    if (/Linux/i.test(ua)) return 'Linux';
  }

  return 'unknown';
}

/**
 * Telemetry runs only on explicit, current consent: the user answered the
 * consent prompt (or the equivalent Settings toggle) at the current copy
 * version and left usage reporting on. Env kill-switches win over any stored
 * choice. The desktop main process re-derives this predicate from the
 * persisted settings in `packages/electron/telemetry-consent.mjs`; keep the
 * consent semantics in sync.
 */
function isTelemetryTrackingAllowed(): boolean {
  if (isTelemetryDisabledByEnv()) return false;
  return consentState.reportUsage === true
    && consentState.consentVersion >= CURRENT_TELEMETRY_CONSENT_VERSION;
}

export function trackTelemetryEvent(name: string, props?: Record<string, string | number | boolean>): void {
  if (!isTelemetryTrackingAllowed()) return;
  const apis = getRegisteredRuntimeAPIs();
  const surface = getTelemetrySurface();
  const os = getTelemetryOS();
  const channel = getTelemetryChannel();
  const connection = getTelemetryConnection();
  const appVersion = getTelemetryAppVersion();
  apis?.telemetry?.trackEvent(name, { surface, os, channel, connection, appVersion, ...props });
}
