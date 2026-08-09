import os from 'os';
import path from 'path';

export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';
export const TUNNEL_PROVIDER_NGROK = 'ngrok';
export const TUNNEL_PROVIDER_TAILSCALE = 'tailscale';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_PRIVATE_NETWORK = 'private-network';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';

export const TAILSCALE_DEFAULT_HTTPS_PORT = 443;
// Tailscale Funnel supports only these frontend ports; Serve accepts the full TCP range.
export const TAILSCALE_HTTPS_PORTS = Object.freeze([443, 8443, 10000]);

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
  TUNNEL_MODE_PRIVATE_NETWORK,
  TUNNEL_MODE_MANAGED_REMOTE,
  TUNNEL_MODE_MANAGED_LOCAL,
]);

export class TunnelServiceError extends Error {
  constructor(code, message, details = null) {
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

const getPathApiForPlatform = (platform) => (platform === 'win32' ? path.win32 : path);

export function isPathWithinDirectory(candidatePath, directoryPath, platform = process.platform) {
  if (typeof candidatePath !== 'string' || typeof directoryPath !== 'string') {
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

export function resolveTunnelConfigPath(value, home = os.homedir(), platform = process.platform) {
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

export function normalizeTunnelProvider(value) {
  if (typeof value !== 'string') {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  const provider = value.trim().toLowerCase();
  if (!provider || !SUPPORTED_TUNNEL_PROVIDERS.has(provider)) {
    return TUNNEL_PROVIDER_CLOUDFLARE;
  }
  return provider;
}

export function normalizeTunnelMode(value) {
  if (typeof value !== 'string') {
    return TUNNEL_MODE_QUICK;
  }
  const mode = value.trim().toLowerCase();
  if (!mode) {
    return TUNNEL_MODE_QUICK;
  }
  if (mode === TUNNEL_MODE_QUICK) {
    return TUNNEL_MODE_QUICK;
  }
  if (mode === TUNNEL_MODE_MANAGED_REMOTE) {
    return TUNNEL_MODE_MANAGED_REMOTE;
  }
  if (mode === TUNNEL_MODE_MANAGED_LOCAL) {
    return TUNNEL_MODE_MANAGED_LOCAL;
  }
  if (mode === TUNNEL_MODE_PRIVATE_NETWORK) {
    return TUNNEL_MODE_PRIVATE_NETWORK;
  }
  return TUNNEL_MODE_QUICK;
}

function normalizeTunnelIntent(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const intent = value.trim().toLowerCase();
  if (!intent || !SUPPORTED_TUNNEL_INTENTS.has(intent)) {
    return undefined;
  }
  return intent;
}

function modeIntentFallback(mode) {
  if (mode === TUNNEL_MODE_QUICK) {
    return TUNNEL_INTENT_EPHEMERAL_PUBLIC;
  }
  if (mode === TUNNEL_MODE_PRIVATE_NETWORK) {
    return TUNNEL_INTENT_PRIVATE_NETWORK;
  }
  if (mode === TUNNEL_MODE_MANAGED_REMOTE || mode === TUNNEL_MODE_MANAGED_LOCAL) {
    return TUNNEL_INTENT_PERSISTENT_PUBLIC;
  }
  return undefined;
}

function normalizeTunnelModeForRequest(value) {
  if (typeof value === 'string') {
    const mode = value.trim().toLowerCase();
    if (mode === TUNNEL_MODE_QUICK || mode === TUNNEL_MODE_PRIVATE_NETWORK || mode === TUNNEL_MODE_MANAGED_REMOTE || mode === TUNNEL_MODE_MANAGED_LOCAL) {
      return mode;
    }
  }
  return TUNNEL_MODE_QUICK;
}

export function normalizeTailscaleHttpsPort(value) {
  if (value === undefined) {
    return TAILSCALE_DEFAULT_HTTPS_PORT;
  }
  const port = typeof value === 'number'
    ? (Number.isInteger(value) ? value : null)
    : (typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

export function normalizeOptionalPath(value) {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return resolveTunnelConfigPath(trimmed);
}

export function isSupportedTunnelMode(mode) {
  return SUPPORTED_TUNNEL_MODES.has(mode);
}

export function normalizeTunnelStartRequest(input = {}, defaults = {}) {
  const provider = normalizeTunnelProvider(input.provider ?? defaults.provider);
  const mode = normalizeTunnelModeForRequest(input.mode ?? defaults.mode ?? (provider === TUNNEL_PROVIDER_TAILSCALE ? TUNNEL_MODE_PRIVATE_NETWORK : undefined));
  const explicitIntent = normalizeTunnelIntent(input.intent ?? defaults.intent);
  const intent = explicitIntent ?? modeIntentFallback(mode);
  const configPathValue = Object.prototype.hasOwnProperty.call(input, 'configPath')
    ? input.configPath
    : defaults.configPath;
  const configPath = normalizeOptionalPath(configPathValue);

  const token = typeof (input.token ?? defaults.token) === 'string'
    ? (input.token ?? defaults.token).trim()
    : '';

  const hostname = typeof (input.hostname ?? defaults.hostname) === 'string'
    ? (input.hostname ?? defaults.hostname).trim().toLowerCase()
    : '';
  const tailscaleHttpsPort = provider === TUNNEL_PROVIDER_TAILSCALE
    ? normalizeTailscaleHttpsPort(Object.prototype.hasOwnProperty.call(input, 'tailscaleHttpsPort')
      ? input.tailscaleHttpsPort
      : defaults.tailscaleHttpsPort)
    : undefined;

  return {
    provider,
    mode,
    intent,
    configPath,
    token,
    hostname,
    tailscaleHttpsPort,
  };
}

export function validateTunnelStartRequest(request, capabilities) {
  if (!request || typeof request !== 'object') {
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

  if (request.provider === TUNNEL_PROVIDER_TAILSCALE) {
    const frontendPort = normalizeTailscaleHttpsPort(request.tailscaleHttpsPort);
    const modeName = request.mode === TUNNEL_MODE_QUICK ? 'Funnel' : 'Serve';
    if (frontendPort === null) {
      throw new TunnelServiceError(
        'validation_error',
        `Tailscale ${modeName} HTTPS frontend port must be an integer from 1 to 65535; received ${String(request.tailscaleHttpsPort)}`
      );
    }
    if (request.mode === TUNNEL_MODE_QUICK && !TAILSCALE_HTTPS_PORTS.includes(frontendPort)) {
      throw new TunnelServiceError(
        'validation_error',
        `Tailscale Funnel HTTPS frontend port must be 443, 8443, or 10000; received ${frontendPort}`
      );
    }
  }

  if (typeof request.intent === 'string' && request.intent.length > 0) {
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
