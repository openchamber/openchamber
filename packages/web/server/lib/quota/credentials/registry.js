/**
 * Credential registry
 *
 * Credential management with validation, storage, and legacy import
 * discovery. All list/get functions return sanitized records — the
 * raw `credential` field is never exposed.
 *
 * @module quota/credentials/registry
 */

import {
  loadCredentials,
  addCredential,
  updateCredential,
  deleteCredential,
  sanitize,
} from './store.js';

import { discoverLegacyCredentials, readLegacyCookieFile } from '../utils/import-legacy.js';
import { getLegacyOpenCodePath } from '../utils/credentials-path.js';
import { PROVIDER_CREDENTIAL_SCHEMAS } from './schemas.js';

/**
 * Provider IDs that accept manual credentials — exactly the providers with a
 * credential schema. OAuth providers (openai, anthropic, google, zai, xai,
 * minimax, etc.) authenticate via OpenCode auth.json and must be rejected here.
 */
const VALID_PROVIDER_IDS = new Set(Object.keys(PROVIDER_CREDENTIAL_SCHEMAS));

/**
 * Apply a provider schema's optional `normalize()` to clean common paste
 * artifacts (e.g. a cookie copied as `auth:"<value>"`) before validation and
 * storage. Returns the credential unchanged when no normalizer is defined.
 *
 * @param {string} providerId
 * @param {object} credential
 * @returns {object}
 */
function normalizeCredential(providerId, credential) {
  const schema = PROVIDER_CREDENTIAL_SCHEMAS[providerId];
  if (schema && typeof schema.normalize === 'function' && credential && typeof credential === 'object') {
    return schema.normalize(credential);
  }
  return credential;
}

/**
 * Validate a credential against provider requirements.
 *
 * Rules:
 * - `providerId` must be a valid QuotaProviderId
 * - `credential` must be a non-empty object
 * - Provider-specific schema validation (required fields, cookie content,
 *   multi-account shape) when a schema is defined in
 *   `PROVIDER_CREDENTIAL_SCHEMAS`. Providers without a schema pass with
 *   any non-empty object.
 *
 * @param {string} providerId
 * @param {object} credential
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateCredential(providerId, credential) {
  if (!providerId || !VALID_PROVIDER_IDS.has(providerId)) {
    return { valid: false, error: `Unsupported provider ID: ${providerId}` };
  }

  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) {
    return { valid: false, error: 'Credential must be an object' };
  }

  const keys = Object.keys(credential);
  if (keys.length === 0) {
    return { valid: false, error: 'Credential must have at least one field' };
  }

  // If no schema for this provider, basic validation passes.
  const schema = PROVIDER_CREDENTIAL_SCHEMAS[providerId];
  if (!schema) {
    return { valid: true };
  }

  // Run provider-specific validation.
  return schema.validate(credential);
}

/**
 * List all credentials, sanitized (no `credential` field).
 *
 * @returns {object[]}
 */
export function listCredentials() {
  return loadCredentials().map(sanitize);
}

/**
 * Get a single credential by ID, sanitized (no `credential` field).
 *
 * @param {string} id
 * @returns {object|null}
 */
export function getCredentialById(id) {
  if (!id) return null;
  const records = loadCredentials();
  const record = records.find((r) => r.id === id);
  return record ? sanitize(record) : null;
}

/**
 * Create a new credential.
 *
 * Validates the credential, stores it, and returns the sanitized record.
 *
 * @param {{ providerId: string, label: string, accountHint?: string, credential: object }} input
 * @returns {{ record: object, error?: string, valid: boolean }}
 */
export function createCredential({ providerId, label, accountHint, credential }) {
  const normalized = normalizeCredential(providerId, credential);
  const validation = validateCredential(providerId, normalized);
  if (!validation.valid) {
    return { record: null, error: validation.error, valid: false };
  }

  if (!label || typeof label !== 'string' || label.trim() === '') {
    return { record: null, error: 'Label is required', valid: false };
  }

  const stored = addCredential({
    providerId,
    label: label.trim(),
    accountHint: accountHint || null,
    credential: normalized,
  });

  return { record: sanitize(stored), valid: true };
}

/**
 * Update an existing credential by ID.
 *
 * Patches the record, stores it, and returns the sanitized record.
 *
 * @param {string} id
 * @param {{ label?: string, credential?: object, accountHint?: string }} updates
 * @returns {{ record: object|null, error?: string, valid: boolean }}
 */
export function updateCredentialById(id, updates) {
  if (!id) return { record: null, error: 'ID is required', valid: false };

  const records = loadCredentials();
  const existing = records.find((r) => r.id === id);
  if (!existing) {
    return { record: null, error: 'Credential not found', valid: false };
  }

  const patch = {};

  if (updates.label !== undefined) {
    if (typeof updates.label !== 'string' || updates.label.trim() === '') {
      return { record: null, error: 'Label must be a non-empty string', valid: false };
    }
    patch.label = updates.label.trim();
  }

  if (updates.accountHint !== undefined) {
    patch.accountHint = updates.accountHint || null;
  }

  if (updates.credential !== undefined) {
    const normalized = normalizeCredential(existing.providerId, updates.credential);
    const validation = validateCredential(existing.providerId, normalized);
    if (!validation.valid) {
      return { record: null, error: validation.error, valid: false };
    }
    patch.credential = normalized;
    patch.validationStatus = 'untested';
    patch.lastValidatedAt = null;
  }

  const updated = updateCredential(id, patch);
  return { record: updated ? sanitize(updated) : null, valid: true };
}

/**
 * Delete a credential by ID.
 *
 * @param {string} id
 * @returns {boolean} - true if removed, false if not found
 */
export function deleteCredentialById(id) {
  return deleteCredential(id);
}

/**
 * Validate a stored credential by ID.
 *
 * Loads the raw record (with credential field), runs structural
 * validation, updates `validationStatus` and `lastValidatedAt`,
 * and returns the validation result. Never returns the raw secret.
 *
 * @param {string} id
 * @returns {{ valid: boolean, error?: string, status: string|null }} - status is null when record not found
 */
export function validateCredentialById(id) {
  if (!id) return { valid: false, error: 'ID is required', status: null };

  const records = loadCredentials();
  const record = records.find((r) => r.id === id);
  if (!record) {
    return { valid: false, error: 'Credential not found', status: null };
  }

  const result = validateCredential(record.providerId, record.credential);

  let status = result.valid ? 'valid' : 'invalid';
  updateCredential(id, {
    validationStatus: status,
    lastValidatedAt: Date.now(),
  });

  return { valid: result.valid, error: result.error, status };
}

/**
 * Discover legacy credentials for a provider.
 *
 * When the provider's schema declares `legacyFiles`, each file is tried
 * in both `~/.config/opencode/` and `~/.local/share/opencode/`.
 * Providers whose schema declares an empty `legacyFiles` array return
 * null immediately. Providers without a schema fall back to the default
 * `<providerId>-cookies.json` discovery.
 *
 * Returns sanitized discovery metadata (file path + timestamp) only.
 * Never returns raw secrets.
 *
 * @param {string} providerId
 * @returns {Promise<object|null>}
 */
export async function discoverCredentials(providerId) {
  if (!providerId || !VALID_PROVIDER_IDS.has(providerId)) {
    return null;
  }

  const schema = PROVIDER_CREDENTIAL_SCHEMAS[providerId];

  if (schema && Array.isArray(schema.legacyFiles)) {
    for (const filename of schema.legacyFiles) {
      const candidatePath = getLegacyOpenCodePath(filename);
      const result = await readLegacyCookieFile(candidatePath);
      if (result) {
        return { ...result, providerId };
      }
    }
    return null;
  }

  return discoverLegacyCredentials(providerId);
}
