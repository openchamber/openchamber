import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';

const clean = (value) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

export const normalizers = {
  'opencode-go': (value) => {
    const workspaceId = clean(value?.workspaceId);
    let authCookie = clean(value?.authCookie);
    if (authCookie.startsWith('auth=')) authCookie = authCookie.slice(5).trim();
    return workspaceId && authCookie ? { workspaceId, authCookie } : null;
  },
  'ollama-cloud': (value) => {
    const cookie = clean(value?.cookie);
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
  if (providerId === 'opencode-go') return { configured: true, workspaceId: credential.workspaceId, secretMasked: '••••••••' };
  if (providerId === 'cursor') return { configured: true, hasRefreshToken: Boolean(credential.refreshToken), secretMasked: '••••••••' };
  return { configured: true, secretMasked: '••••••••' };
};

export const deleteManagedCredential = (providerId) => deleteQuotaCredential(providerId);
