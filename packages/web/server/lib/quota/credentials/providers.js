import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';

const clean = (value) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

const pickOllamaSessionCookie = (header) => {
  const parts = header.split(';').map((part) => part.trim()).filter(Boolean);
  const pick = (name) => {
    for (const part of parts) {
      const index = part.indexOf('=');
      if (index <= 0) continue;
      if (part.slice(0, index).trim() !== name) continue;
      const cookieValue = part.slice(index + 1).trim();
      if (!cookieValue) continue;
      return `${name}=${cookieValue}`;
    }
    return null;
  };
  return pick('wos-session') ?? pick('__Secure-session') ?? header.trim();
};

export const normalizers = {
  'exe-dev': (value) => {
    const usageToken = clean(value?.usageToken);
    return usageToken ? { usageToken } : null;
  },
  'ollama-cloud': (value) => {
    const raw = clean(value?.cookie);
    if (!raw) return null;
    const cookie = pickOllamaSessionCookie(raw);
    return cookie ? { cookie } : null;
  },
  cursor: (value) => {
    const accessToken = clean(value?.accessToken);
    const refreshToken = clean(value?.refreshToken);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
  },
};

export const readManagedCredential = (providerId) => {
  const normalize = normalizers[providerId];
  return normalize ? readQuotaCredential(providerId, normalize) : null;
};

export const writeManagedCredential = (providerId, value) => {
  const credential = normalizers[providerId]?.(value);
  if (!credential) throw new Error('Invalid credential');
  writeQuotaCredential(providerId, credential);
  return getManagedCredentialStatus(providerId);
};

export const getManagedCredentialStatus = (providerId) => {
  const credential = readManagedCredential(providerId);
  if (!credential) return { configured: false };
  if (providerId === 'cursor') return { configured: true, hasRefreshToken: Boolean(credential.refreshToken), secretMasked: '••••••••' };
  return { configured: true, secretMasked: '••••••••' };
};

export const deleteManagedCredential = (providerId) => deleteQuotaCredential(providerId);
