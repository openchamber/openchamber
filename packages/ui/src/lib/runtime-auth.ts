export type RuntimeAuthCredential =
  | { type: 'bearer'; token: string }
  | null;

export type RuntimeAuthCredentialProvider = () => RuntimeAuthCredential | Promise<RuntimeAuthCredential>;

let credentialProvider: RuntimeAuthCredentialProvider = () => null;
let runtimeBearerToken = '';

const normalizeBearerToken = (token: string | null | undefined): string => {
  if (typeof token !== 'string') return '';
  return token.trim();
};

const readInjectedBearerToken = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = (window as typeof window & { __OPENCHAMBER_CLIENT_TOKEN__?: string }).__OPENCHAMBER_CLIENT_TOKEN__;
  return normalizeBearerToken(injected);
};

export const setRuntimeAuthCredentialProvider = (provider: RuntimeAuthCredentialProvider): void => {
  runtimeBearerToken = '';
  credentialProvider = provider;
};

export const clearRuntimeAuthCredentialProvider = (): void => {
  runtimeBearerToken = '';
  credentialProvider = () => null;
};

export const setRuntimeBearerToken = (token: string | null | undefined): void => {
  const normalized = normalizeBearerToken(token);
  runtimeBearerToken = normalized;
  credentialProvider = () => normalized ? { type: 'bearer', token: normalized } : null;
};

export const getRuntimeBearerTokenSync = (): string => runtimeBearerToken || readInjectedBearerToken();

export const getRuntimeAuthCredential = async (): Promise<RuntimeAuthCredential> => {
  const credential = await credentialProvider();
  const token = credential?.type === 'bearer'
    ? normalizeBearerToken(credential.token)
    : getRuntimeBearerTokenSync();
  return token ? { type: 'bearer', token } : null;
};

export const buildRuntimeAuthHeaders = async (headers?: HeadersInit): Promise<Headers> => {
  const next = new Headers(headers);
  if (next.has('Authorization')) {
    return next;
  }

  const credential = await getRuntimeAuthCredential();
  if (credential?.type === 'bearer') {
    next.set('Authorization', `Bearer ${credential.token}`);
  }
  return next;
};
