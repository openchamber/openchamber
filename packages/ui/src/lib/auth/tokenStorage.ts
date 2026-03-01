import { getSafeStorage } from '@/stores/utils/safeStorage';

const TOKEN_STORAGE_PREFIX = 'openchamber:device-token:v1:';

export type DeviceTokenSet = {
  accessToken: string;
  tokenType: string;
  expiresIn?: number;
  expiresAt?: number;
  createdAt: number;
};

type PersistedTokenSet = Omit<DeviceTokenSet, 'createdAt'> & {
  createdAt?: number;
};

const getKey = (instanceId: string): string => `${TOKEN_STORAGE_PREFIX}${instanceId}`;

const isExpired = (tokenSet: DeviceTokenSet): boolean => {
  if (typeof tokenSet.expiresAt !== 'number') {
    return false;
  }
  return Date.now() >= tokenSet.expiresAt;
};

const normalizeTokenSet = (value: PersistedTokenSet | null): DeviceTokenSet | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const accessToken = typeof value.accessToken === 'string' ? value.accessToken.trim() : '';
  if (!accessToken) {
    return null;
  }
  const tokenType = typeof value.tokenType === 'string' && value.tokenType.trim().length > 0
    ? value.tokenType.trim()
    : 'bearer';
  const createdAt = typeof value.createdAt === 'number' ? value.createdAt : Date.now();
  const expiresIn = typeof value.expiresIn === 'number' && Number.isFinite(value.expiresIn) && value.expiresIn > 0
    ? value.expiresIn
    : undefined;
  const expiresAt = typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) && value.expiresAt > 0
    ? value.expiresAt
    : undefined;

  return {
    accessToken,
    tokenType,
    createdAt,
    expiresIn,
    expiresAt,
  };
};

export const getToken = (instanceId: string): DeviceTokenSet | null => {
  if (!instanceId) {
    return null;
  }
  try {
    const storage = getSafeStorage();
    const raw = storage.getItem(getKey(instanceId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PersistedTokenSet;
    const tokenSet = normalizeTokenSet(parsed);
    if (!tokenSet) {
      storage.removeItem(getKey(instanceId));
      return null;
    }
    if (isExpired(tokenSet)) {
      storage.removeItem(getKey(instanceId));
      return null;
    }
    return tokenSet;
  } catch {
    return null;
  }
};

export const setToken = (
  instanceId: string,
  tokenSet: Omit<DeviceTokenSet, 'createdAt'> & { createdAt?: number },
): void => {
  if (!instanceId || !tokenSet || typeof tokenSet !== 'object') {
    return;
  }
  const accessToken = typeof tokenSet.accessToken === 'string' ? tokenSet.accessToken.trim() : '';
  if (!accessToken) {
    return;
  }
  const createdAt = typeof tokenSet.createdAt === 'number' ? tokenSet.createdAt : Date.now();
  const expiresIn = typeof tokenSet.expiresIn === 'number' && Number.isFinite(tokenSet.expiresIn) && tokenSet.expiresIn > 0
    ? tokenSet.expiresIn
    : undefined;
  const expiresAt = typeof tokenSet.expiresAt === 'number' && Number.isFinite(tokenSet.expiresAt) && tokenSet.expiresAt > 0
    ? tokenSet.expiresAt
    : (typeof expiresIn === 'number' ? createdAt + (expiresIn * 1000) : undefined);

  const normalized: DeviceTokenSet = {
    accessToken,
    tokenType: typeof tokenSet.tokenType === 'string' && tokenSet.tokenType.trim().length > 0
      ? tokenSet.tokenType.trim()
      : 'bearer',
    createdAt,
    expiresIn,
    expiresAt,
  };

  try {
    const storage = getSafeStorage();
    storage.setItem(getKey(instanceId), JSON.stringify(normalized));
  } catch {
    return;
  }
};

export const clearToken = (instanceId: string): void => {
  if (!instanceId) {
    return;
  }
  try {
    getSafeStorage().removeItem(getKey(instanceId));
  } catch {
    return;
  }
};

export const getAccessToken = (instanceId: string): string | null => {
  const tokenSet = getToken(instanceId);
  return tokenSet?.accessToken ?? null;
};
