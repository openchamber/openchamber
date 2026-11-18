import crypto from 'node:crypto';
import { isSourceControlFiniteNumber } from './input-guards.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 256;

export interface OAuthFlowIdentity {
  flowId?: string;
  provider?: string;
  instance?: string;
}

export interface OAuthFlowRegistration {
  provider: string;
  instance: string;
  deviceCode: string;
  clientId: string;
  expiresIn?: number;
}

interface OAuthFlowEntry extends Omit<OAuthFlowRegistration, 'expiresIn'> {
  expiresAt: number;
  state: 'pending' | 'acquired';
}

interface OAuthFlowRegistryOptions {
  now?: () => number;
  randomBytes?: (size: number) => Buffer;
  maxEntries?: number;
  maxTtlMs?: number;
  defaultTtlMs?: number;
}

const invalidFlow = () => {
  return Object.assign(new Error('OAuth flow is invalid'), { code: 'INVALID_SOURCE_CONTROL_OAUTH_FLOW' });
};

const unavailableFlow = () => {
  return Object.assign(new Error('OAuth flow is unavailable'), { code: 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE' });
};

const busyFlow = () => {
  return Object.assign(new Error('OAuth flow is busy'), { code: 'SOURCE_CONTROL_OAUTH_FLOW_BUSY' });
};

const isNonEmptyString = (value: string) => Object.prototype.toString.call(value) === '[object String]' && value.length > 0;

export function createOAuthFlowRegistry({
  now = Date.now,
  randomBytes = crypto.randomBytes,
  maxEntries = MAX_ENTRIES,
  maxTtlMs = MAX_TTL_MS,
  defaultTtlMs = DEFAULT_TTL_MS,
}: OAuthFlowRegistryOptions = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1
    || !Number.isFinite(maxTtlMs) || maxTtlMs < 1
    || !Number.isFinite(defaultTtlMs) || defaultTtlMs < 1) throw invalidFlow();

  const entries = new Map<string, OAuthFlowEntry>();
  const prune = (timestamp: number) => {
    for (const [flowId, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(flowId);
    }
  };
  const getAvailable = ({ flowId, provider, instance }: OAuthFlowIdentity = {}) => {
    const timestamp = now();
    prune(timestamp);
    const entry = flowId === undefined ? undefined : entries.get(flowId);
    if (!entry || entry.provider !== provider || entry.instance !== instance) throw unavailableFlow();
    if (entry.state !== 'pending') throw busyFlow();
    return entry;
  };

  const register = ({ provider, instance, deviceCode, clientId, expiresIn }: OAuthFlowRegistration) => {
    if (![provider, instance, deviceCode, clientId].every(isNonEmptyString)) throw invalidFlow();
    const timestamp = now();
    prune(timestamp);
    if (entries.size >= maxEntries) {
      throw Object.assign(new Error('OAuth flow capacity reached'), { code: 'SOURCE_CONTROL_OAUTH_FLOW_CAPACITY' });
    }

    let providerTtlMs = defaultTtlMs;
    if (isSourceControlFiniteNumber(expiresIn) && expiresIn > 0) {
      providerTtlMs = expiresIn * 1000;
    }
    const expiresAt = timestamp + Math.max(1, Math.min(providerTtlMs, maxTtlMs));
    let flowId;
    do {
      flowId = `oauth_${randomBytes(32).toString('base64url')}`;
    } while (entries.has(flowId));
    entries.set(flowId, {
      provider,
      instance,
      deviceCode,
      clientId,
      expiresAt,
      state: 'pending',
    });
    return { flowId, expiresAt };
  };

  const acquire = (identity?: OAuthFlowIdentity) => {
    const entry = getAvailable(identity);
    entry.state = 'acquired';
    return {
      deviceCode: entry.deviceCode,
      clientId: entry.clientId,
      expiresAt: entry.expiresAt,
    };
  };

  const release = (flowId: string) => {
    const entry = entries.get(flowId);
    if (!entry || entry.state !== 'acquired') return false;
    if (entry.expiresAt <= now()) {
      entries.delete(flowId);
      return false;
    }
    entry.state = 'pending';
    return true;
  };

  const consume = (flowId: string) => entries.delete(flowId);

  return { register, acquire, release, consume };
}
