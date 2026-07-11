import { lazy } from 'react';

declare const __APP_VERSION__: string | undefined;

const RELOAD_STORAGE_KEY = 'openchamber:chunk-import-reload';
const RETRY_DELAY_MS = 250;
const RELOAD_GUARD_MS = 30_000;

const DYNAMIC_IMPORT_ERROR_PATTERNS = [
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /Loading chunk \S+ failed/i,
  /ChunkLoadError/i,
];

function readErrorText(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}\n${error.message}\n${error.stack ?? ''}`;
  }

  if (typeof error === 'string') {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isDynamicImportError(error: unknown): boolean {
  const text = readErrorText(error);
  return DYNAMIC_IMPORT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

function reloadMarkerSignature(error: unknown): string {
  const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
  return `${appVersion || 'unknown'}:${readErrorText(error).slice(0, 500)}`;
}

function scheduleReloadOnce(error: unknown): void {
  if (typeof window === 'undefined') return;

  const now = Date.now();
  const signature = reloadMarkerSignature(error);

  let marker: { signature?: unknown; timestamp?: unknown } | null = null;
  try {
    const rawMarker = window.sessionStorage.getItem(RELOAD_STORAGE_KEY);
    if (rawMarker) {
      try {
        marker = JSON.parse(rawMarker) as { signature?: unknown; timestamp?: unknown };
      } catch {
        marker = null;
      }
    }
  } catch {
    return;
  }

  const markerTimestamp = typeof marker?.timestamp === 'number' ? marker.timestamp : 0;
  if (marker?.signature === signature && now - markerTimestamp < RELOAD_GUARD_MS) {
    return;
  }

  try {
    window.sessionStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify({ signature, timestamp: now }));
  } catch {
    return;
  }

  window.setTimeout(() => {
    window.location.reload();
  }, 0);
}

export async function importWithChunkRecovery<T>(
  load: () => Promise<T>,
  options: { retries?: number } = {},
): Promise<T> {
  const retries = options.retries ?? 1;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (!isDynamicImportError(error) || attempt >= retries) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }

  if (isDynamicImportError(lastError)) {
    scheduleReloadOnce(lastError);
  }

  throw lastError;
}

export const lazyWithChunkRecovery: typeof lazy = (load) => lazy(() => importWithChunkRecovery(load));
