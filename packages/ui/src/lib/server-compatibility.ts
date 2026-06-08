import { runtimeFetch } from './runtime-fetch';

export const OPENCHAMBER_CLIENT_API_VERSION = 1;

export const REQUIRED_SERVER_CAPABILITIES = [
  'api.health.v1',
  'api.runtime-url.v1',
  'api.raw-file.v1',
  'realtime.sse.v1',
  'realtime.websocket.global-events.v1',
] as const;

export type ServerCompatibilityStatus =
  | 'compatible'
  | 'auth-required'
  | 'unreachable'
  | 'invalid-response'
  | 'server-too-old'
  | 'client-too-old'
  | 'missing-capability';

export interface ServerCompatibilityPayload {
  status?: unknown;
  openchamberVersion?: unknown;
  runtime?: unknown;
  compatibility?: {
    apiVersion?: unknown;
    minClientApiVersion?: unknown;
    capabilities?: unknown;
  } | null;
}

export interface ServerCompatibilityResult {
  status: ServerCompatibilityStatus;
  openchamberVersion: string | null;
  runtime: string | null;
  apiVersion: number | null;
  minClientApiVersion: number | null;
  missingCapabilities: string[];
  requiredCapabilities: string[];
  message: string;
}

const parsePositiveInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null;
  return value;
};

const parseString = (value: unknown): string | null => {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
};

const parseCapabilities = (value: unknown): Set<string> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0));
};

export const evaluateServerCompatibility = (
  payload: ServerCompatibilityPayload | null | undefined,
  options: {
    clientApiVersion?: number;
    requiredCapabilities?: readonly string[];
  } = {},
): ServerCompatibilityResult => {
  const clientApiVersion = options.clientApiVersion ?? OPENCHAMBER_CLIENT_API_VERSION;
  const requiredCapabilities = [...(options.requiredCapabilities ?? REQUIRED_SERVER_CAPABILITIES)];
  const compatibility = payload?.compatibility ?? null;
  const apiVersion = parsePositiveInteger(compatibility?.apiVersion);
  const minClientApiVersion = parsePositiveInteger(compatibility?.minClientApiVersion);
  const openchamberVersion = parseString(payload?.openchamberVersion);
  const runtime = parseString(payload?.runtime);

  const base = {
    openchamberVersion,
    runtime,
    apiVersion,
    minClientApiVersion,
    missingCapabilities: [] as string[],
    requiredCapabilities,
  };

  if (!payload || payload.status !== 'ok' || !compatibility || !apiVersion || !minClientApiVersion) {
    return {
      ...base,
      status: 'invalid-response',
      message: 'Server did not return OpenChamber compatibility metadata.',
    };
  }

  if (apiVersion < clientApiVersion) {
    return {
      ...base,
      status: 'server-too-old',
      message: `Server API version ${apiVersion} is older than required client API version ${clientApiVersion}.`,
    };
  }

  if (minClientApiVersion > clientApiVersion) {
    return {
      ...base,
      status: 'client-too-old',
      message: `Server requires client API version ${minClientApiVersion}, but this client supports ${clientApiVersion}.`,
    };
  }

  const capabilities = parseCapabilities(compatibility.capabilities);
  const missingCapabilities = requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missingCapabilities.length > 0) {
    return {
      ...base,
      status: 'missing-capability',
      missingCapabilities,
      message: `Server is missing required capabilities: ${missingCapabilities.join(', ')}.`,
    };
  }

  return {
    ...base,
    status: 'compatible',
    message: 'Server is compatible.',
  };
};

export const checkServerCompatibility = async (): Promise<ServerCompatibilityResult> => {
  let response: Response;
  try {
    response = await runtimeFetch('/api/version', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    return {
      status: 'unreachable',
      openchamberVersion: null,
      runtime: null,
      apiVersion: null,
      minClientApiVersion: null,
      missingCapabilities: [],
      requiredCapabilities: [...REQUIRED_SERVER_CAPABILITIES],
      message: error instanceof Error ? error.message : 'Server is unreachable.',
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: 'auth-required',
      openchamberVersion: null,
      runtime: null,
      apiVersion: null,
      minClientApiVersion: null,
      missingCapabilities: [],
      requiredCapabilities: [...REQUIRED_SERVER_CAPABILITIES],
      message: 'Server requires authentication.',
    };
  }

  const payload = await response.json().catch(() => null) as ServerCompatibilityPayload | null;
  return evaluateServerCompatibility(payload);
};
