import { SecureStorage } from '@aparajita/capacitor-secure-storage';

import { isCapacitorApp } from '@/lib/platform';

import { recordMobileConnectDebug } from './mobileConnectionDebug';

export const MOBILE_SECURE_STORAGE_PREFIX = 'openchamber.mobile.';
const MOBILE_SECURE_TIMEOUT_MS = 3000;

export const logDetail = (detail: Record<string, unknown>): string => {
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
};

export const logStorage = (step: string, detail: Record<string, unknown> = {}): void => {
  const serialized = logDetail(detail);
  console.info('[mobile-storage]', step, serialized);
  recordMobileConnectDebug(step, serialized);
};

type NativeSecureStorage = {
  internalSetItem: (options: { prefixedKey: string; data: string; sync: boolean; access: number }) => Promise<void>;
  internalGetItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ data: string | null }>;
  internalRemoveItem: (options: { prefixedKey: string; sync: boolean }) => Promise<{ success: boolean }>;
};

export const nativeSecure = SecureStorage as unknown as NativeSecureStorage;
export const KEYCHAIN_ACCESS_WHEN_UNLOCKED = 0;

const prefixedTokenKey = (key: string): string =>
  `${MOBILE_SECURE_STORAGE_PREFIX}token.${encodeURIComponent(key)}`;

export const withTimeout = async <T,>(operation: Promise<T>, fallback: T): Promise<T> => {
  let timeoutId: number | undefined;
  const timeout = new Promise<T>((resolve) => {
    timeoutId = window.setTimeout(() => resolve(fallback), MOBILE_SECURE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([operation.catch(() => fallback), timeout]);
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
};

const boundedSecure = async <T,>(label: string, run: () => Promise<T>, fallback: T): Promise<T> => {
  if (!isCapacitorApp()) return fallback;
  return withTimeout(
    run().catch((error) => {
      console.warn(`[mobile-storage] ${label} failed`, error);
      return fallback;
    }),
    fallback,
  );
};

export const readSecureToken = async (key: string): Promise<string | undefined> => {
  logStorage('secure:read-start', { key });
  const value = await boundedSecure(
    'secure:read',
    async () => (await nativeSecure.internalGetItem({ prefixedKey: prefixedTokenKey(key), sync: false })).data,
    null,
  );
  const token = typeof value === 'string' && value.trim() ? value : undefined;
  logStorage('secure:read', { key, hasToken: Boolean(token) });
  return token;
};

export const writeSecureToken = async (key: string, token: string): Promise<boolean> => {
  logStorage('secure:write-start', { key });
  const ok = await boundedSecure('secure:write', async () => {
    await nativeSecure.internalSetItem({
      prefixedKey: prefixedTokenKey(key),
      data: token,
      sync: false,
      access: KEYCHAIN_ACCESS_WHEN_UNLOCKED,
    });
    return true;
  }, false);
  logStorage('secure:write', { key, ok });
  return ok;
};

export const deleteSecureToken = async (key: string): Promise<void> => {
  await boundedSecure('secure:delete', async () => {
    await nativeSecure.internalRemoveItem({ prefixedKey: prefixedTokenKey(key), sync: false });
    return true;
  }, false);
};

export const deleteSecureHeaders = async (prefixedKey: string): Promise<void> => {
  await withTimeout(nativeSecure.internalRemoveItem({ prefixedKey, sync: false }), null);
};
