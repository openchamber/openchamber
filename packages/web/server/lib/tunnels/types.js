import os from 'os';
import path from 'path';

export const TUNNEL_PROVIDER_CLOUDFLARE = 'cloudflare';

export const TUNNEL_MODE_QUICK = 'quick';
export const TUNNEL_MODE_MANAGED_REMOTE = 'managed-remote';
export const TUNNEL_MODE_MANAGED_LOCAL = 'managed-local';

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
]);

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
  return TUNNEL_MODE_QUICK;
}

export function normalizeTunnelIntent(value) {
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
  if (mode === TUNNEL_MODE_MANAGED_REMOTE || mode === TUNNEL_MODE_MANAGED_LOCAL) {
    return TUNNEL_INTENT_PERSISTENT_PUBLIC;
  }
  return undefined;
}

function normalizeTunnelModeForRequest(value) {
  if (typeof value === 'string') {
    const mode = value.trim().toLowerCase();
    if (mode === TUNNEL_MODE_QUICK || mode === TUNNEL_MODE_MANAGED_REMOTE || mode === TUNNEL_MODE_MANAGED_LOCAL) {
      return mode;
    }
  }
  return TUNNEL_MODE_QUICK;
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
  let resolved;
  if (trimmed === '~') {
    resolved = os.homedir();
  } else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    resolved = path.join(os.homedir(), trimmed.slice(2));
  } else {
    resolved = path.resolve(trimmed);
  }
  const home = os.homedir();
  if (resolved !== home && !resolved.startsWith(home + path.sep)) {
    throw new TunnelServiceError(
      'validation_error',
      `Config path must be within the home directory (${home}). Got: ${resolved}`
    );
  }
  return resolved;
}

export function isSupportedTunnelMode(mode) {
  return SUPPORTED_TUNNEL_MODES.has(mode);
}

export function normalizeTunnelStartRequest(input = {}, defaults = {}) {
  const provider = normalizeTunnelProvider(input.provider ?? defaults.provider);
  const mode = normalizeTunnelModeForRequest(input.mode ?? defaults.mode);
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

  return {
    provider,
    mode,
    intent,
    configPath,
    token,
    hostname,
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
