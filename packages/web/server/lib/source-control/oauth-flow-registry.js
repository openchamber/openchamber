import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 256;

const invalidFlow = () => {
  const error = new Error('OAuth flow is invalid');
  error.code = 'INVALID_SOURCE_CONTROL_OAUTH_FLOW';
  return error;
};

const unavailableFlow = () => {
  const error = new Error('OAuth flow is unavailable');
  error.code = 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE';
  return error;
};

const busyFlow = () => {
  const error = new Error('OAuth flow is busy');
  error.code = 'SOURCE_CONTROL_OAUTH_FLOW_BUSY';
  return error;
};

const isNonEmptyString = (value) => Object.prototype.toString.call(value) === '[object String]' && value.length > 0;

export function createOAuthFlowRegistry({
  now = Date.now,
  randomBytes = crypto.randomBytes,
  maxEntries = MAX_ENTRIES,
  maxTtlMs = MAX_TTL_MS,
  defaultTtlMs = DEFAULT_TTL_MS,
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1
    || !Number.isFinite(maxTtlMs) || maxTtlMs < 1
    || !Number.isFinite(defaultTtlMs) || defaultTtlMs < 1) throw invalidFlow();

  const entries = new Map();
  const prune = (timestamp) => {
    for (const [flowId, entry] of entries) {
      if (entry.expiresAt <= timestamp) entries.delete(flowId);
    }
  };
  const getAvailable = ({ flowId, provider, instance } = {}) => {
    const timestamp = now();
    prune(timestamp);
    const entry = entries.get(flowId);
    if (!entry || entry.provider !== provider || entry.instance !== instance) throw unavailableFlow();
    if (entry.state !== 'pending') throw busyFlow();
    return entry;
  };

  const register = ({ provider, instance, deviceCode, clientId, expiresIn }) => {
    if (![provider, instance, deviceCode, clientId].every(isNonEmptyString)) throw invalidFlow();
    const timestamp = now();
    prune(timestamp);
    if (entries.size >= maxEntries) {
      const error = new Error('OAuth flow capacity reached');
      error.code = 'SOURCE_CONTROL_OAUTH_FLOW_CAPACITY';
      throw error;
    }

    let providerTtlMs = defaultTtlMs;
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
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

  const acquire = (identity) => {
    const entry = getAvailable(identity);
    entry.state = 'acquired';
    return {
      deviceCode: entry.deviceCode,
      clientId: entry.clientId,
      expiresAt: entry.expiresAt,
    };
  };

  const release = (flowId) => {
    const entry = entries.get(flowId);
    if (!entry || entry.state !== 'acquired') return false;
    if (entry.expiresAt <= now()) {
      entries.delete(flowId);
      return false;
    }
    entry.state = 'pending';
    return true;
  };

  const consume = (flowId) => entries.delete(flowId);

  return { register, acquire, release, consume };
}
