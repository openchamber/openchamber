import os from 'os';
import path from 'path';

export interface TunnelStartInput {
  provider?: unknown;
  mode?: unknown;
  intent?: unknown;
  configPath?: unknown;
  token?: unknown;
  hostname?: unknown;
  httpsPort?: unknown;
}

export interface TunnelModeDescriptor {
  key: string;
  intent?: string;
  requires?: string[];
  httpsPorts?: number[];
}

export interface TunnelCapabilities {
  provider: string;
  modes: TunnelModeDescriptor[];
}

const isText = (value: unknown): value is string => typeof value === 'string';

export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';
export const TUNNEL_PROVIDER_NGROK = 'ngrok';
export const TUNNEL_PROVIDER_TAILSCALE = 'tailscale';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';
export const TUNNEL_MODE_SERVE = 'serve';
export const TUNNEL_MODE_FUNNEL = 'funnel';

export const TUNNEL_INTENT_EPHEMERAL_PUBLIC = 'ephemeral-public';
export const TUNNEL_INTENT_PERSISTENT_PUBLIC = 'persistent-public';
export const TUNNEL_INTENT_PRIVATE_NETWORK = 'private-network';

const SUPPORTED_TUNNEL_INTENTS = new Set([
  TUNNEL_INTENT_EPHEMERAL_PUBLIC,
  TUNNEL_INTENT_PERSISTENT_PUBLIC,
  TUNNEL_INTENT_PRIVATE_NETWORK,
]);

const SUPPORTED_TUNNEL_MODES = new Set([
  TUNNEL_MODE_QUICK,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_MANAGED_LOCAL,
  TUNNEL_MODE_SERVE,
  TUNNEL_MODE_FUNNEL,
]);

export class TunnelServiceError extends Error {
  code: string;
  details: { approvalUrl?: string } | null;

  constructor(code: string, message: string, details: { approvalUrl?: string } | null = null) {
    super(message);
    this.name = 'TunnelServiceError';
    this.code = code;
    this.details = details;
  }
}

const SUPPORTED_TUNNEL_PROVIDERS = new Set([
  TUNNEL_PROVIDER_CLOUDFLARE,
  TUNNEL_PROVIDER_NGROK,
  TUNNEL_PROVIDER_TAILSCALE,
]);

const getPathApiForPlatform = (platform: NodeJS.Platform) => (platform === 'win32' ? path.win32 : path);

export function isPathWithinDirectory(candidatePath: string, directoryPath: string, platform: NodeJS.Platform = process.platform) {
  if (!isText(candidatePath) || !isText(directoryPath)) {
    return false;
  }

  const pathApi = getPathApiForPlatform(platform);
  const resolvedCandidate = pathApi.resolve(candidatePath);
  const resolvedDirectory = pathApi.resolve(directoryPath);
  const comparableCandidate = platform === 'win32' ? resolvedCandidate.toLowerCase() : resolvedCandidate;
  const comparableDirectory = platform === 'win32' ? resolvedDirectory.toLowerCase() : resolvedDirectory;
  const directoryPrefix = comparableDirectory.endsWith(pathApi.sep)
    ? comparableDirectory
    : `${comparableDirectory}${pathApi.sep}`;

  return comparableCandidate === comparableDirectory || comparableCandidate.startsWith(directoryPrefix);
}

export function resolveTunnelConfigPath(value: string, home = os.homedir(), platform: NodeJS.Platform = process.platform) {
  const pathApi = getPathApiForPlatform(platform);
  let resolved;
  if (value === '~') {
    resolved = home;
  } else if (value.startsWith('~/') || value.startsWith('~\\')) {
    resolved = pathApi.join(home, value.slice(2));
  } else {
    resolved = pathApi.resolve(value);
  }

  if (!isPathWithinDirectory(resolved, home, platform)) {
    throw new TunnelServiceError(
      'validation_error',
      `Config path must be within the home directory (${home}). Got: ${resolved}`
    );
  }
  return resolved;
}

export function normalizeTunnelProvider(value: string | null | undefined) {
  if (!isText(value)) {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  const provider = value.trim().toLowerCase();
  if (!provider || !SUPPORTED_TUNNEL_PROVIDERS.has(provider)) {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  return provider;
}

export function normalizeTunnelMode(value: string | null | undefined) {
  if (!isText(value)) {
    return TUNNEL_MODE_QUICK;
  }
  const mode = value.trim().toLowerCase();
  return SUPPORTED_TUNNEL_MODES.has(mode) ? mode : TUNNEL_MODE_QUICK;
}

function normalizeTunnelIntent(value: string | null | undefined) {
  if (!isText(value)) {
    return undefined;
  }
  const intent = value.trim().toLowerCase();
  if (!intent || !SUPPORTED_TUNNEL_INTENTS.has(intent)) {
    return undefined;
  }
  return intent;
}

function modeIntentFallback(mode: string) {
  if (mode === TUNNEL_MODE_QUICK) {
    return TUNNEL_INTENT_EPHEMERAL_PUBLIC;
  }
  if (mode === TUNNEL_MODE_MANAGED_REMOTE || mode === TUNNEL_MODE_MANAGED_LOCAL || mode === TUNNEL_MODE_FUNNEL) {
    return TUNNEL_INTENT_PERSISTENT_PUBLIC;
  }
  if (mode === TUNNEL_MODE_SERVE) {
    return TUNNEL_INTENT_PRIVATE_NETWORK;
  }
  return undefined;
}

export function normalizeOptionalPath(value: string | null | undefined) {
  if (value === null) {
    return null;
  }
  if (!isText(value)) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return resolveTunnelConfigPath(trimmed);
}

export function isSupportedTunnelMode(mode: string) {
  return SUPPORTED_TUNNEL_MODES.has(mode);
}

export function normalizeTunnelStartRequest(input: TunnelStartInput = {}, defaults: TunnelStartInput = {}) {
  const providerValue = input.provider ?? defaults.provider;
  const modeValue = input.mode ?? defaults.mode;
  const intentValue = input.intent ?? defaults.intent;
  const provider = normalizeTunnelProvider(isText(providerValue) ? providerValue : undefined);
  const mode = normalizeTunnelMode(isText(modeValue) ? modeValue : undefined);
  const explicitIntent = normalizeTunnelIntent(isText(intentValue) ? intentValue : undefined);
  const intent = explicitIntent ?? modeIntentFallback(mode);
  const configPathValue = Object.prototype.hasOwnProperty.call(input, 'configPath')
    ? input.configPath
    : defaults.configPath;
  const configPath = normalizeOptionalPath(isText(configPathValue) || configPathValue === null ? configPathValue : undefined);

  const tokenValue = input.token ?? defaults.token;
  const token = isText(tokenValue)
    ? tokenValue.trim()
    : '';

  const hostnameValue = input.hostname ?? defaults.hostname;
  const hostname = isText(hostnameValue)
    ? hostnameValue.trim().toLowerCase()
    : '';

  const httpsPortValue = input.httpsPort ?? defaults.httpsPort;
  const httpsPortText = httpsPortValue === undefined || httpsPortValue === null || httpsPortValue === ''
    ? undefined
    : String(httpsPortValue).trim();
  const httpsPort = httpsPortText === undefined
    ? undefined
    : (/^\d+$/.test(httpsPortText) ? Number(httpsPortText) : Number.NaN);

  return {
    provider,
    mode,
    intent,
    configPath,
    token,
    hostname,
    httpsPort,
  };
}

export type TunnelStartRequest = ReturnType<typeof normalizeTunnelStartRequest>;

const isRequestObject = (value: unknown): value is TunnelStartInput => Boolean(value) && typeof value === 'object';

export function validateTunnelStartRequest(request: TunnelStartRequest, capabilities: TunnelCapabilities | null | undefined) {
  if (!isRequestObject(request)) {
    throw new TunnelServiceError('validation_error', 'Tunnel start request must be an object');
  }

  if (!request.provider) {
    throw new TunnelServiceError('validation_error', 'Tunnel provider is required');
  }

  if (!isSupportedTunnelMode(request.mode)) {
    throw new TunnelServiceError('mode_unsupported', `Unsupported tunnel mode: ${request.mode}`);
  }

  if (!capabilities || capabilities.provider !== request.provider) {
    throw new TunnelServiceError('provider_unsupported', `Unsupported tunnel provider: ${request.provider}`);
  }

  if (!Array.isArray(capabilities.modes)) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not declare tunnel modes`);
  }

  const modeDescriptor = capabilities.modes.find((entry) => entry?.key === request.mode);
  if (!modeDescriptor) {
    throw new TunnelServiceError('mode_unsupported', `Provider '${request.provider}' does not support mode '${request.mode}'`);
  }

  if (isText(request.intent) && request.intent.length > 0) {
    if (!SUPPORTED_TUNNEL_INTENTS.has(request.intent)) {
      throw new TunnelServiceError('validation_error', `Unsupported tunnel intent: ${request.intent}`);
    }
    if (modeDescriptor.intent !== request.intent) {
      throw new TunnelServiceError(
        'validation_error',
        `Tunnel intent '${request.intent}' does not match mode '${request.mode}' (expected '${modeDescriptor.intent}')`
      );
    }
  }

  if (request.httpsPort !== undefined) {
    const allowedPorts = modeDescriptor.httpsPorts;
    if (!Array.isArray(allowedPorts)) {
      throw new TunnelServiceError('validation_error', `Provider '${request.provider}' does not take an HTTPS port`);
    }
    if (!allowedPorts.includes(request.httpsPort)) {
      throw new TunnelServiceError('validation_error', `HTTPS port must be one of ${allowedPorts.join(', ')}`);
    }
  }

  const requiredFields = Array.isArray(modeDescriptor.requires) ? modeDescriptor.requires : [];

  if (requiredFields.includes('token')) {
    if (!request.token) {
      throw new TunnelServiceError('validation_error', 'Managed remote tunnel token is required');
    }
  }

  if (requiredFields.includes('hostname')) {
    if (!request.hostname) {
      throw new TunnelServiceError('validation_error', 'Managed remote tunnel hostname is required');
    }
  }

  if (requiredFields.includes('configPath')) {
    if (request.configPath === undefined || request.configPath === null || request.configPath === '') {
      throw new TunnelServiceError('validation_error', `Mode '${request.mode}' requires a configPath`);
    }
  }
}
