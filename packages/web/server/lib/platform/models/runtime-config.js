// Model-access runtime configuration (plan sections 11.1 and 11.2).
//
// Allowed-model whitelist: the deployment pins exactly which model IDs the
// platform will forward, via OPENCHAMBER_PLATFORM_ALLOWED_MODELS - a
// comma-separated list of `id:providerID` entries. Unset or empty means NO
// model is allowed (fail-closed): the whitelist is enforced by the model
// access module, not by UI hiding.
//
// Per-user concurrency: OPENCHAMBER_PLATFORM_MODEL_MAX_CONCURRENT_PER_USER
// bounds simultaneous model requests per user (plan section 11.2: atomic
// acquire, release on finish/timeout). Default 2.

export const ALLOWED_MODELS_ENV = 'OPENCHAMBER_PLATFORM_ALLOWED_MODELS';
export const MODEL_MAX_CONCURRENT_ENV = 'OPENCHAMBER_PLATFORM_MODEL_MAX_CONCURRENT_PER_USER';
export const DEFAULT_MODEL_MAX_CONCURRENT_PER_USER = 2;

// Parse the whitelist. Malformed entries (missing id or provider, or a
// duplicate model id) throw a locatable config error: a typo in the allowlist
// must not silently narrow or widen what users can reach.
export function resolveAllowedModels(env = process.env) {
  const raw = env[ALLOWED_MODELS_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') {
    return Object.freeze([]);
  }
  const models = [];
  const seen = new Set();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const separator = trimmed.indexOf(':');
    const id = separator > 0 ? trimmed.slice(0, separator).trim() : '';
    const provider = separator > 0 ? trimmed.slice(separator + 1).trim() : '';
    if (!id || !provider) {
      throw new Error(
        `invalid ${ALLOWED_MODELS_ENV} entry "${trimmed}" (expected "id:providerID")`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`duplicate model id "${id}" in ${ALLOWED_MODELS_ENV}`);
    }
    seen.add(id);
    models.push(Object.freeze({ id, provider }));
  }
  return Object.freeze(models);
}

export function isModelAllowed(allowedModels, modelId) {
  if (typeof modelId !== 'string' || modelId === '') return false;
  return allowedModels.some((entry) => entry.id === modelId);
}

export function resolveModelConcurrencyLimit(env = process.env) {
  const raw = env[MODEL_MAX_CONCURRENT_ENV];
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_MODEL_MAX_CONCURRENT_PER_USER;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${MODEL_MAX_CONCURRENT_ENV} must be a positive integer (got "${raw}")`);
  }
  return value;
}
