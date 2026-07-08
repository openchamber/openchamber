// Connection payload parsing + native QR scanning for the dedicated mobile app.
//
// The pairing link format is produced by `openchamber connect-url --qr`:
//   openchamber://connect?v=1&server=<url>&token=<token>&label=<label>
// We also accept a bare http(s) URL so a QR encoding only the server address works.
//
// QR scanning is delegated to a Capacitor barcode-scanner plugin if the native
// shell registered one (`window.Capacitor.Plugins.BarcodeScanner`). We resolve it
// at runtime instead of importing the package so the web build stays dependency-free
// and the browser-hosted mobile UI degrades to `unsupported` cleanly.

import { parseRelayOfferUrl } from '@/lib/relay/offer';

import type { MobileRelayConfig } from './mobileConnections';

export type MobileConnectionPayload = {
  url: string;
  clientToken?: string;
  label?: string;
  // Present when the payload is a relay pairing offer (openchamber://connect?v=1&mode=relay#offer=...).
  // `url` then holds the raw offer link so form fields and connect() can round-trip it.
  relay?: MobileRelayConfig;
  // One-time relay authorization grant from the offer. Never persisted.
  relayGrant?: string;
};

export type QrScanResult =
  | ({ status: 'ok' } & MobileConnectionPayload)
  | { status: 'cancelled' }
  | { status: 'unsupported' }
  | { status: 'permission-denied' }
  | { status: 'invalid' }
  | { status: 'failed' };

type ScannedBarcode = { rawValue?: string; displayValue?: string };

type ModuleInstallProgress = { state?: number };
type ListenerHandle = { remove: () => void };

type BarcodeScannerPlugin = {
  requestPermissions?: () => Promise<{ camera?: string } | undefined>;
  scan?: (options?: { formats?: string[] }) => Promise<{ barcodes?: ScannedBarcode[] } | undefined>;
  // Android-only: the Google code scanner used by scan() needs the ML Kit barcode module,
  // which Play Services must download once before the first scan. Absent on iOS.
  isGoogleBarcodeScannerModuleAvailable?: () => Promise<{ available?: boolean } | undefined>;
  installGoogleBarcodeScannerModule?: () => Promise<void>;
  addListener?: (
    event: 'googleBarcodeScannerModuleInstallProgress',
    cb: (info: ModuleInstallProgress) => void,
  ) => Promise<ListenerHandle>;
};

// Google's ModuleInstallProgress states: 4 = COMPLETED, 3 = CANCELED, 5 = FAILED.
const MODULE_STATE_COMPLETED = 4;
const MODULE_STATE_CANCELED = 3;
const MODULE_STATE_FAILED = 5;
const MODULE_INSTALL_TIMEOUT_MS = 90_000;

// Ensure the Android Google barcode module is downloaded before scanning. No-op on platforms
// where these methods don't exist (iOS) or when it's already available. Resolves once the module
// is usable; rejects if the install is canceled, fails, or times out.
const ensureScannerModule = async (plugin: BarcodeScannerPlugin): Promise<void> => {
  const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  if (
    capacitor?.getPlatform?.() !== 'android' ||
    !plugin.isGoogleBarcodeScannerModuleAvailable ||
    !plugin.installGoogleBarcodeScannerModule
  ) {
    return;
  }
  const status = await plugin.isGoogleBarcodeScannerModuleAvailable().catch(() => undefined);
  if (status?.available) return;

  await new Promise<void>((resolve, reject) => {
    let handle: ListenerHandle | undefined;
    const finish = (fn: () => void) => {
      window.clearTimeout(timer);
      handle?.remove();
      fn();
    };
    const timer = window.setTimeout(
      () => finish(() => reject(new Error('module install timed out'))),
      MODULE_INSTALL_TIMEOUT_MS,
    );
    // addListener may return a handle synchronously OR a Promise<handle> depending on the
    // Capacitor proxy — normalize with Promise.resolve so a non-thenable handle doesn't throw
    // and abort the install call below.
    Promise.resolve(
      plugin.addListener?.('googleBarcodeScannerModuleInstallProgress', (info) => {
        if (info?.state === MODULE_STATE_COMPLETED) finish(resolve);
        else if (info?.state === MODULE_STATE_CANCELED || info?.state === MODULE_STATE_FAILED) {
          finish(() => reject(new Error('module install failed')));
        }
      }),
    )
      .then((h) => {
        handle = h as ListenerHandle | undefined;
      })
      .catch(() => undefined);
    Promise.resolve(plugin.installGoogleBarcodeScannerModule?.()).catch((error) =>
      finish(() => reject(error instanceof Error ? error : new Error('module install failed'))),
    );
  });
};

const getScannerPlugin = (): BarcodeScannerPlugin | null => {
  if (typeof window === 'undefined') return null;
  const capacitor = (window as typeof window & {
    Capacitor?: { Plugins?: Record<string, unknown> };
  }).Capacitor;
  const plugin = capacitor?.Plugins?.BarcodeScanner as BarcodeScannerPlugin | undefined;
  return plugin && typeof plugin.scan === 'function' ? plugin : null;
};

export const parseConnectionPayload = (raw: string): MobileConnectionPayload | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^openchamber:\/\//i.test(trimmed)) {
    // Relay pairing offers are a strict superset format (mode=relay + fragment
    // payload); try them first. Direct pairing links (?server=...) never match
    // the relay parser, so existing payloads are untouched.
    const offer = parseRelayOfferUrl(trimmed);
    if (offer) {
      return {
        url: trimmed,
        clientToken: offer.token,
        label: offer.label,
        relay: {
          relayUrl: offer.relayUrl,
          serverId: offer.serverId,
          hostEncPubJwk: offer.hostEncPubJwk,
        },
        relayGrant: offer.grant,
      };
    }
    try {
      const parsed = new URL(trimmed);
      const server = parsed.searchParams.get('server')?.trim();
      if (!server) return null;
      const clientToken = parsed.searchParams.get('token')?.trim();
      const label = parsed.searchParams.get('label')?.trim();
      return {
        url: server,
        clientToken: clientToken || undefined,
        label: label || undefined,
      };
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
  return null;
};

// The Google code scanner can briefly still throw "module not available" in the moments right
// after its install completes. Detect that specific error so we can re-ensure + retry rather
// than surfacing a failure the user would have to manually tap through.
const isModuleUnavailableError = (error: unknown): boolean => {
  const message =
    typeof error === 'object' && error && 'message' in error
      ? String((error as { message?: unknown }).message ?? '')
      : String(error ?? '');
  return /module/i.test(message) && /not\s*available|unavailable/i.test(message);
};

export const isQrScanSupported = (): boolean => getScannerPlugin() !== null;

export const scanConnectionQr = async (): Promise<QrScanResult> => {
  const plugin = getScannerPlugin();
  if (!plugin?.scan) return { status: 'unsupported' };

  try {
    if (plugin.requestPermissions) {
      const permission = await plugin.requestPermissions();
      const camera = permission?.camera;
      if (camera && camera !== 'granted' && camera !== 'limited') {
        return { status: 'permission-denied' };
      }
    }

    // First scan on Android downloads the Google barcode module (the button stays in its
    // scanning state for the whole wait). The module can still report "not available" for a
    // moment right after install, so re-ensure + retry within this same call instead of erroring
    // out — the user shouldn't have to guess to tap again.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await ensureScannerModule(plugin);
        const result = await plugin.scan({ formats: ['QR_CODE'] });
        const barcode = result?.barcodes?.[0];
        const raw = (barcode?.rawValue ?? barcode?.displayValue ?? '').trim();
        if (!raw) return { status: 'cancelled' };

        const payload = parseConnectionPayload(raw);
        if (!payload) return { status: 'invalid' };
        return { status: 'ok', ...payload };
      } catch (error) {
        if (!isModuleUnavailableError(error) || attempt === 2) return { status: 'failed' };
        await new Promise((resolve) => window.setTimeout(resolve, 600));
      }
    }
    return { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
};
