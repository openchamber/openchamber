import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';

const clean = (value) => typeof value === 'string' && !/[\r\n]/.test(value) ? value.trim() : '';

export const normalizers = {
  'exe-dev': (value) => {
    const usageToken = clean(value?.usageToken);
    return usageToken ? { usageToken } : null;
  },
  cursor: (value) => {
    const accessToken = clean(value?.accessToken);
    const refreshToken = clean(value?.refreshToken);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
  },
  zenmux: (value) => {
    const platformApiKey = clean(value?.platformApiKey);
    return platformApiKey ? { platformApiKey } : null;
  },
  opendesign: (value) => {
    const cookieInput = clean(value?.cookie);
    const workspaceId = clean(value?.workspaceId);
    if (!cookieInput || !workspaceId) return null;
    // Accept the cookie header value as copied from the browser, or a bare
    // session token, which is stored under its Better Auth cookie name.
    const cookie = cookieInput.includes('better-auth')
      ? cookieInput
      : `better-auth.session_token=${cookieInput}`;
    return { cookie, workspaceId };
  },
};

// Own-property lookup: provider ids come from URLs, and a plain keyed read
// resolves Object.prototype members ('constructor', 'toString', '__proto__')
// as if they were registered providers.
const getNormalizer = (providerId) => (Object.hasOwn(normalizers, providerId) ? normalizers[providerId] : undefined);

export const readManagedCredential = (providerId) => {
  const normalize = getNormalizer(providerId);
  return normalize ? readQuotaCredential(providerId, normalize) : null;
};

export const writeManagedCredential = (providerId, value) => {
  const credential = getNormalizer(providerId)?.(value);
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
