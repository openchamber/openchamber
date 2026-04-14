import {
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
  WebAuthnError,
} from '@simplewebauthn/browser';

const PASSKEY_AUTH_OPTIONS_ENDPOINT = '/auth/passkey/authenticate/options';
const PASSKEY_AUTH_VERIFY_ENDPOINT = '/auth/passkey/authenticate/verify';
const PASSKEY_REGISTER_OPTIONS_ENDPOINT = '/auth/passkey/register/options';
const PASSKEY_REGISTER_VERIFY_ENDPOINT = '/auth/passkey/register/verify';
const PASSKEY_LIST_ENDPOINT = '/api/passkeys';
const PASSKEY_STATUS_ENDPOINT = '/auth/passkey/status';
const AUTH_RESET_ENDPOINT = '/api/auth/reset';

export type PasskeyStatus = {
  enabled: boolean;
  hasPasskeys: boolean;
  passkeyCount: number;
  rpID: string | null;
};

export type StoredPasskey = {
  id: string;
  label: string;
  createdAt: number;
  lastUsedAt: number | null;
  deviceType: string;
  backedUp: boolean;
};

export const defaultPasskeyStatus: PasskeyStatus = {
  enabled: false,
  hasPasskeys: false,
  passkeyCount: 0,
  rpID: null,
};

const postJson = async (url: string, body?: unknown): Promise<Response> => fetch(url, {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
  body: body === undefined ? undefined : JSON.stringify(body),
});

export const getPasskeyErrorMessage = async (response: Response, fallback: string): Promise<string> => {
  try {
    const payload = await response.json();
    if (payload && typeof payload.error === 'string' && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // Ignore malformed error payloads and fall back to the provided message.
  }

  return fallback;
};

export const isPasskeyCeremonyAbort = (error: unknown): boolean => (
  error instanceof WebAuthnError && error.code === 'ERROR_CEREMONY_ABORTED'
);

export const cancelPasskeyCeremony = () => {
  WebAuthnAbortService.cancelCeremony();
};

export const getPasskeySupportState = () => {
  if (typeof window === 'undefined') {
    return { supported: false, reason: 'Passkeys are unavailable outside the browser.' };
  }

  if (!window.isSecureContext) {
    return { supported: false, reason: 'Passkeys require HTTPS or localhost.' };
  }

  return { supported: true, reason: '' };
};

export const registerCurrentDevicePasskey = async () => {
  const support = getPasskeySupportState();
  if (!support.supported) {
    throw new Error(support.reason);
  }

  const label = typeof navigator.userAgent === 'string' && navigator.userAgent.trim()
    ? navigator.userAgent
    : 'This device';

  const optionsResponse = await postJson(PASSKEY_REGISTER_OPTIONS_ENDPOINT, { label });
  if (!optionsResponse.ok) {
    throw new Error(await getPasskeyErrorMessage(optionsResponse, 'Could not start passkey setup.'));
  }

  const { requestId, optionsJSON } = await optionsResponse.json();
  const registrationResponse = await startRegistration({ optionsJSON });
  const verifyResponse = await postJson(PASSKEY_REGISTER_VERIFY_ENDPOINT, {
    requestId,
    response: registrationResponse,
  });

  if (!verifyResponse.ok) {
    throw new Error(await getPasskeyErrorMessage(verifyResponse, 'Could not finish passkey setup.'));
  }

  return verifyResponse.json().catch(() => null);
};

export const authenticateWithPasskey = async (trustDevice: boolean) => {
  const support = getPasskeySupportState();
  if (!support.supported) {
    throw new Error(support.reason);
  }

  const optionsResponse = await postJson(PASSKEY_AUTH_OPTIONS_ENDPOINT);
  if (!optionsResponse.ok) {
    throw new Error(await getPasskeyErrorMessage(optionsResponse, 'Passkey sign-in is not available right now.'));
  }

  const { requestId, optionsJSON } = await optionsResponse.json();
  const authResponse = await startAuthentication({ optionsJSON });
  const verifyResponse = await postJson(PASSKEY_AUTH_VERIFY_ENDPOINT, {
    requestId,
    response: authResponse,
    trustDevice,
  });

  if (!verifyResponse.ok) {
    throw new Error(await getPasskeyErrorMessage(verifyResponse, 'Passkey sign-in failed.'));
  }

  return verifyResponse.json().catch(() => null);
};

export const fetchPasskeyStatus = async (): Promise<PasskeyStatus> => {
  const response = await fetch(PASSKEY_STATUS_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return defaultPasskeyStatus;
  }

  const payload = await response.json().catch(() => null);
  return {
    enabled: payload?.enabled === true,
    hasPasskeys: payload?.hasPasskeys === true,
    passkeyCount: typeof payload?.passkeyCount === 'number' ? payload.passkeyCount : 0,
    rpID: typeof payload?.rpID === 'string' && payload.rpID ? payload.rpID : null,
  };
};

export const fetchStoredPasskeys = async (): Promise<StoredPasskey[]> => {
  const response = await fetch(PASSKEY_LIST_ENDPOINT, {
    method: 'GET',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(await getPasskeyErrorMessage(response, 'Could not load passkeys.'));
  }

  const payload = await response.json().catch(() => null);
  return Array.isArray(payload?.passkeys) ? payload.passkeys : [];
};

export const revokeStoredPasskey = async (id: string) => {
  const response = await fetch(`${PASSKEY_LIST_ENDPOINT}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(await getPasskeyErrorMessage(response, 'Could not remove passkey.'));
  }

  return response.json().catch(() => null);
};

export const resetAllAuth = async () => {
  const response = await postJson(AUTH_RESET_ENDPOINT);

  if (!response.ok) {
    throw new Error(await getPasskeyErrorMessage(response, 'Could not clear saved authentication.'));
  }

  return response.json().catch(() => null);
};
