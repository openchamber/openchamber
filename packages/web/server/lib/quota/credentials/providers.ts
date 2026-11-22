import { deleteQuotaCredential, readQuotaCredential, writeQuotaCredential } from './store.js';
import type { CredentialJson, CursorCredential, ExeDevCredential, ManagedCredential, ManagedCredentialProvider, ManagedCredentialStatus, OpenDesignCredential, ZenmuxCredential } from './contracts.js';

const isSecret = (value: unknown): value is string => typeof value === 'string' && !/[\r\n]/.test(value);
const clean = (value: CredentialJson | undefined) => isSecret(value) ? value.trim() : '';
const isCredentialObject = (value: CredentialJson | undefined): value is { [key: string]: CredentialJson } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const normalizers = {
  'exe-dev': (value: CredentialJson | undefined) => {
    const usageToken = clean(isCredentialObject(value) ? value.usageToken : undefined);
    return usageToken ? { usageToken } : null;
  },
  cursor: (value: CredentialJson | undefined) => {
    const accessToken = clean(isCredentialObject(value) ? value.accessToken : undefined);
    const refreshToken = clean(isCredentialObject(value) ? value.refreshToken : undefined);
    return accessToken || refreshToken ? { accessToken, refreshToken } : null;
  },
  zenmux: (value: CredentialJson | undefined) => {
    const platformApiKey = clean(isCredentialObject(value) ? value.platformApiKey : undefined);
    return platformApiKey ? { platformApiKey } : null;
  },
  opendesign: (value: CredentialJson | undefined) => {
    const cookieInput = clean(isCredentialObject(value) ? value.cookie : undefined);
    const workspaceId = clean(isCredentialObject(value) ? value.workspaceId : undefined);
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
const isNormalizerKey = (providerId: string): providerId is keyof typeof normalizers => Object.hasOwn(normalizers, providerId);
const getNormalizer = (providerId: string) => (isNormalizerKey(providerId) ? normalizers[providerId] : undefined);
export function readManagedCredential(providerId: 'cursor'): CursorCredential | null;
export function readManagedCredential(providerId: 'exe-dev'): ExeDevCredential | null;
export function readManagedCredential(providerId: 'zenmux'): ZenmuxCredential | null;
export function readManagedCredential(providerId: 'opendesign'): OpenDesignCredential | null;
export function readManagedCredential(providerId: ManagedCredentialProvider): ManagedCredential | null;

export function readManagedCredential(providerId: ManagedCredentialProvider) {
  const normalize = getNormalizer(providerId);
  return normalize ? readQuotaCredential<ManagedCredential | null>(providerId, normalize) : null;
}

export const writeManagedCredential = (providerId: ManagedCredentialProvider, value: CredentialJson | undefined) => {
  const credential = getNormalizer(providerId)?.(value);
  if (!credential) throw new Error('Invalid credential');
  writeQuotaCredential(providerId, credential);
  return getManagedCredentialStatus(providerId);
};

export const getManagedCredentialStatus = (providerId: ManagedCredentialProvider): ManagedCredentialStatus => {
  if (providerId === 'cursor') {
    const credential = readManagedCredential(providerId);
    if (!credential) return { configured: false };
    return { configured: true, hasRefreshToken: Boolean(credential.refreshToken), secretMasked: '••••••••' };
  }
  const credential = readManagedCredential(providerId);
  if (!credential) return { configured: false };
  return { configured: true, secretMasked: '••••••••' };
};

export const deleteManagedCredential = (providerId: ManagedCredentialProvider) => deleteQuotaCredential(providerId);
