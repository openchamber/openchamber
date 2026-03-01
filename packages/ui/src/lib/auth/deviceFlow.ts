export type DeviceStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

export type DeviceTokenResponse = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
};

export type DevicePollingState =
  | 'authorization_pending'
  | 'slow_down'
  | 'expired_token'
  | 'access_denied'
  | 'network_error';

export type DevicePlatformMetadata = {
  os?: string;
  model?: string;
  version?: string;
  arch?: string;
  type?: string;
  runtime?: string;
};

export class DeviceFlowRequestError extends Error {
  readonly endpoint: 'start' | 'token';
  readonly status: number | null;
  readonly code: string;
  readonly details?: string;

  constructor(params: {
    endpoint: 'start' | 'token';
    message: string;
    code: string;
    status?: number | null;
    details?: string;
  }) {
    super(params.message);
    this.name = 'DeviceFlowRequestError';
    this.endpoint = params.endpoint;
    this.status = params.status ?? null;
    this.code = params.code;
    this.details = params.details;
  }
}

type PollingUpdate = {
  state: DevicePollingState;
  intervalMs: number;
  retryInMs: number;
};

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

const sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
};

const normalizeApiBaseUrl = (value: string): string => value.replace(/\/+$/, '');

export const startDeviceFlow = async (
  apiBaseUrl: string,
  options?: {
    name?: string;
    platform?: DevicePlatformMetadata;
    verificationOrigin?: string;
    verificationApiBaseUrl?: string;
  },
): Promise<DeviceStartResponse> => {
  const platform = options?.platform ?? undefined;
  const hasPlatform = Boolean(
    platform
    && (
      (typeof platform.os === 'string' && platform.os.trim().length > 0)
      || (typeof platform.model === 'string' && platform.model.trim().length > 0)
      || (typeof platform.version === 'string' && platform.version.trim().length > 0)
      || (typeof platform.arch === 'string' && platform.arch.trim().length > 0)
      || (typeof platform.type === 'string' && platform.type.trim().length > 0)
      || (typeof platform.runtime === 'string' && platform.runtime.trim().length > 0)
    ),
  );

  let response: Response;
  try {
    response = await fetch(`${normalizeApiBaseUrl(apiBaseUrl)}/auth/device/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        name: options?.name || undefined,
        platform: hasPlatform ? platform : undefined,
        verification_origin: options?.verificationOrigin || undefined,
        verification_api_base_url: options?.verificationApiBaseUrl || undefined,
      }),
    });
  } catch (error) {
    throw new DeviceFlowRequestError({
      endpoint: 'start',
      code: 'network_error',
      message: 'Unable to reach instance',
      details: error instanceof Error ? error.message : String(error ?? ''),
    });
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = typeof payload?.error === 'string'
      ? payload.error
      : response.status === 401 || response.status === 403
        ? 'auth_required'
        : 'request_failed';
    const details = typeof payload?.error_description === 'string'
      ? payload.error_description
      : typeof payload?.message === 'string'
        ? payload.message
        : undefined;
    throw new DeviceFlowRequestError({
      endpoint: 'start',
      status: response.status,
      code,
      message: details || code,
      details,
    });
  }

  if (!payload) {
    throw new DeviceFlowRequestError({
      endpoint: 'start',
      status: response.status,
      code: 'invalid_response',
      message: 'Invalid response from instance',
    });
  }

  const deviceCode = typeof payload.device_code === 'string' ? payload.device_code : '';
  const userCode = typeof payload.user_code === 'string' ? payload.user_code : '';
  const verificationUri = typeof payload.verification_uri === 'string' ? payload.verification_uri : '';
  const verificationUriComplete = typeof payload.verification_uri_complete === 'string' ? payload.verification_uri_complete : undefined;
  const expiresIn = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 0;
  const interval = Number.isFinite(payload.interval) ? Number(payload.interval) : 5;

  if (!deviceCode || !userCode || !verificationUri || expiresIn <= 0) {
    throw new DeviceFlowRequestError({
      endpoint: 'start',
      status: response.status,
      code: 'invalid_response',
      message: 'Invalid device flow response',
    });
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresIn,
    interval: Math.max(1, interval),
  };
};

export const buildDevicePairingPayload = (apiBaseUrl: string): string => {
  const normalized = normalizeApiBaseUrl(apiBaseUrl.trim());
  return `openchamber://device?instance=${encodeURIComponent(normalized)}`;
};

export const parseDevicePairingPayload = (payload: string): { apiBaseUrl: string } | null => {
  const value = payload.trim();
  if (!value) {
    return null;
  }

  if (value.startsWith('openchamber://')) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'openchamber:' || parsed.hostname !== 'device') {
      return null;
    }
    const rawInstance = parsed.searchParams.get('instance') || '';
    if (!rawInstance) {
      return null;
    }
    try {
      const target = new URL(rawInstance);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return null;
      }
      return {
        apiBaseUrl: normalizeApiBaseUrl(target.toString()),
      };
    } catch {
      return null;
    }
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    const pathname = parsed.pathname.replace(/\/+$/, '');
    const apiBaseUrl = pathname.endsWith('/api')
      ? `${parsed.origin}${pathname}`
      : `${parsed.origin}/api`;
    return {
      apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl),
    };
  } catch {
    return null;
  }
};

export const pollDeviceToken = async (
  apiBaseUrl: string,
  params: {
    deviceCode: string;
    intervalSeconds?: number;
    signal?: AbortSignal;
    onUpdate?: (update: PollingUpdate) => void;
  },
): Promise<DeviceTokenResponse> => {
  const endpoint = `${normalizeApiBaseUrl(apiBaseUrl)}/auth/device/token`;
  let intervalMs = Math.max(1000, (params.intervalSeconds || 5) * 1000);
  let networkBackoffMs = 0;

  while (true) {
    params.signal?.throwIfAborted();

    if (networkBackoffMs > 0) {
      params.onUpdate?.({
        state: 'network_error',
        intervalMs,
        retryInMs: networkBackoffMs,
      });
      await sleep(networkBackoffMs, params.signal);
    } else {
      await sleep(intervalMs, params.signal);
    }

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: params.deviceCode,
        }),
        signal: params.signal,
      });

      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok && payload) {
        const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
        const tokenType = typeof payload.token_type === 'string' ? payload.token_type : 'bearer';
        const expiresIn = Number.isFinite(payload.expires_in) ? Number(payload.expires_in) : 0;
        if (!accessToken || expiresIn <= 0) {
          throw new Error('Invalid token response');
        }
        return {
          accessToken,
          tokenType,
          expiresIn,
        };
      }

      const errorCode = typeof payload?.error === 'string' ? payload.error : 'authorization_pending';
      if (errorCode === 'authorization_pending') {
        networkBackoffMs = 0;
        params.onUpdate?.({
          state: 'authorization_pending',
          intervalMs,
          retryInMs: intervalMs,
        });
        continue;
      }

      if (errorCode === 'slow_down') {
        intervalMs += 5000;
        networkBackoffMs = 0;
        params.onUpdate?.({
          state: 'slow_down',
          intervalMs,
          retryInMs: intervalMs,
        });
        continue;
      }

      if (errorCode === 'expired_token' || errorCode === 'access_denied') {
        params.onUpdate?.({
          state: errorCode,
          intervalMs,
          retryInMs: 0,
        });
        throw new Error(errorCode);
      }

      networkBackoffMs = Math.max(1000, Math.min(networkBackoffMs > 0 ? Math.round(networkBackoffMs * 1.8) : 1000, 30000));
      params.onUpdate?.({
        state: 'network_error',
        intervalMs,
        retryInMs: networkBackoffMs,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error;
      }
      if (error instanceof Error && (error.message === 'expired_token' || error.message === 'access_denied')) {
        throw error;
      }
      networkBackoffMs = Math.max(1000, Math.min(networkBackoffMs > 0 ? Math.round(networkBackoffMs * 1.8) : 1000, 30000));
      params.onUpdate?.({
        state: 'network_error',
        intervalMs,
        retryInMs: networkBackoffMs,
      });
    }
  }
};
