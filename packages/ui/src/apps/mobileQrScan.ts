// Connection payload parsing + native QR scanning for the dedicated mobile app.
//
// Android uses the plugin's CameraX-backed startScan() flow. Unlike its ready-made
// scan() activity, this path bundles the barcode model in the app and does not need
// Google Play Services. iOS keeps the native ready-made scanner.

import { parsePairingConnectionPayload, parsePairingConnectionPayloadString, type PairingConnectionPayload } from '@/lib/connectionPayload';

export type MobileConnectionPayload = {
  url: string;
  clientToken?: string;
  label?: string;
};

export type MobilePairingPayload = {
  pairing: PairingConnectionPayload;
};

export type QrScanResult =
  | ({ status: 'ok' } & MobileConnectionPayload)
  | ({ status: 'pairing' } & MobilePairingPayload)
  | { status: 'cancelled' }
  | { status: 'unsupported' }
  | { status: 'permission-denied' }
  | { status: 'invalid' }
  | { status: 'failed' };

type ScannedBarcode = { rawValue?: string; displayValue?: string };
type ListenerHandle = { remove: () => void | Promise<void> };
type BarcodeScannerPlugin = {
  requestPermissions?: () => Promise<{ camera?: string } | undefined>;
  scan?: (options?: { formats?: string[] }) => Promise<{ barcodes?: ScannedBarcode[] } | undefined>;
  startScan?: (options?: { formats?: string[] }) => Promise<void>;
  stopScan?: () => Promise<void>;
  addListener?: (
    event: 'barcodesScanned' | 'scanError',
    cb: (info: { barcodes?: ScannedBarcode[]; message?: string }) => void,
  ) => Promise<ListenerHandle> | ListenerHandle;
};

const getScannerPlugin = (): BarcodeScannerPlugin | null => {
  if (typeof window === 'undefined') return null;
  const capacitor = (window as typeof window & {
    Capacitor?: { Plugins?: Record<string, unknown> };
  }).Capacitor;
  const plugin = capacitor?.Plugins?.BarcodeScanner as BarcodeScannerPlugin | undefined;
  return plugin && (typeof plugin.scan === 'function' || typeof plugin.startScan === 'function') ? plugin : null;
};

const isAndroid = (): boolean => {
  const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  return capacitor?.getPlatform?.() === 'android';
};

export const parseConnectionPayload = (raw: string): MobileConnectionPayload | MobilePairingPayload | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^openchamber:\/\//i.test(trimmed)) {
    const pairing = parsePairingConnectionPayload(trimmed);
    return pairing ? { pairing } : null;
  }

  if (/^https?:\/\//i.test(trimmed)) return { url: trimmed };
  return null;
};

const resultFromRawValue = (raw: string, options?: { pairingStringFallback?: boolean }): QrScanResult => {
  const payload = parseConnectionPayload(raw);
  if (!payload && options?.pairingStringFallback) {
    // Old Android WebViews resolve openchamber://… with hostname "" / pathname "//connect",
    // so the URL-based parse above fails even though the scanned string is intact. Retry
    // with the URL-API-free string parser before declaring the scan invalid.
    const pairing = parsePairingConnectionPayloadString(raw);
    if (pairing) return { status: 'pairing', pairing };
  }
  if (!payload) return { status: 'invalid' };
  if ('pairing' in payload) return { status: 'pairing', ...payload };
  return { status: 'ok', ...payload };
};

const scanWithBundledAndroidScanner = async (
  plugin: BarcodeScannerPlugin,
  signal?: AbortSignal,
): Promise<QrScanResult> => {
  if (!plugin.startScan || !plugin.stopScan || !plugin.addListener) return { status: 'unsupported' };
  if (signal?.aborted) return { status: 'cancelled' };

  let barcodeListener: ListenerHandle | undefined;
  let errorListener: ListenerHandle | undefined;
  let settled = false;
  let resolveResult: (result: QrScanResult) => void = () => undefined;

  const result = new Promise<QrScanResult>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (scanResult: QrScanResult) => {
    if (settled) return;
    settled = true;
    resolveResult(scanResult);
  };
  const abort = () => finish({ status: 'cancelled' });
  signal?.addEventListener('abort', abort, { once: true });

  try {
    const listenerResults = await Promise.allSettled([
      Promise.resolve(plugin.addListener('barcodesScanned', ({ barcodes }) => {
        const barcode = barcodes?.[0];
        const raw = (barcode?.rawValue ?? barcode?.displayValue ?? '').trim();
        if (raw) finish(resultFromRawValue(raw, { pairingStringFallback: true }));
      })).then((handle) => { barcodeListener = handle; }),
      Promise.resolve(plugin.addListener('scanError', () => finish({ status: 'failed' })))
        .then((handle) => { errorListener = handle; }),
    ]);

    if (listenerResults.some(({ status }) => status === 'rejected')) {
      finish({ status: 'failed' });
    } else if (!settled) {
      void plugin.startScan({ formats: ['QR_CODE'] }).catch(() => finish({ status: 'failed' }));
    }

    return await result;
  } finally {
    signal?.removeEventListener('abort', abort);
    await Promise.allSettled([
      Promise.resolve(barcodeListener?.remove()),
      Promise.resolve(errorListener?.remove()),
      plugin.stopScan(),
    ]);
  }
};

export const isQrScanSupported = (): boolean => getScannerPlugin() !== null;

export const scanConnectionQr = async (options?: { signal?: AbortSignal }): Promise<QrScanResult> => {
  const plugin = getScannerPlugin();
  if (!plugin) return { status: 'unsupported' };

  try {
    if (plugin.requestPermissions) {
      const permission = await plugin.requestPermissions();
      const camera = permission?.camera;
      if (camera && camera !== 'granted' && camera !== 'limited') return { status: 'permission-denied' };
    }

    if (options?.signal?.aborted) return { status: 'cancelled' };
    if (isAndroid()) return scanWithBundledAndroidScanner(plugin, options?.signal);
    if (!plugin.scan) return { status: 'unsupported' };

    const result = await plugin.scan({ formats: ['QR_CODE'] });
    const barcode = result?.barcodes?.[0];
    const raw = (barcode?.rawValue ?? barcode?.displayValue ?? '').trim();
    return raw ? resultFromRawValue(raw) : { status: 'cancelled' };
  } catch {
    return { status: 'failed' };
  }
};
