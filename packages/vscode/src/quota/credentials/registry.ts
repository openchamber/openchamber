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
  type QuotaCredentialRecord,
  type SanitizedCredentialRecord,
} from './store';

import { discoverLegacyCredentials, readLegacyCookieFile, type LegacyCredentialDiscovery } from './import-legacy';
import { getLegacyOpenCodePath } from '../credentials-path';
import { PROVIDER_CREDENTIAL_SCHEMAS, type ValidationResult } from './schemas';

/**
 * Valid QuotaProviderId values for credential storage.
 *
 * Mirrors the QuotaProviderId type from packages/ui/src/types/quota.ts.
 * Both server-dispatched providers and manual-auth providers are accepted
 * because any provider may have stored credentials for manual auth flows.
 */
const VALID_PROVIDER_IDS = new Set<string>([
  'openai',
  'codex',
  'cursor',
  'claude',
  'github-copilot',
  'github-copilot-addon',
  'google',
  'kimi-for-coding',
  'nano-gpt',
  'openrouter',
  'zai-coding-plan',
  'zhipuai-coding-plan',
  'minimax-coding-plan',
  'minimax-cn-coding-plan',
  'ollama-cloud',
  'wafer',
  'atlascloud',
  'byteplus',
  'longcat',
  'mistral',
  'poe',
  'qwencloud',
  'stepfun',
  'xai',
  'opencode-go',
]);

/**
 * Validate a credential against provider requirements.
 */
export function validateCredential(providerId: string, credential: Record<string, unknown> | null): ValidationResult {
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

  const schema = PROVIDER_CREDENTIAL_SCHEMAS[providerId];
  if (!schema) {
    return { valid: true };
  }

  return schema.validate(credential);
}

/**
 * List all credentials, sanitized (no `credential` field).
 */
export function listCredentials(): SanitizedCredentialRecord[] {
  return loadCredentials()
    .map((record) => sanitize(record))
    .filter((record): record is SanitizedCredentialRecord => record !== null);
}

/**
 * Get a single credential by ID, sanitized (no `credential` field).
 */
export function getCredentialById(id: string): SanitizedCredentialRecord | null {
  if (!id) return null;
  const records = loadCredentials();
  const record = records.find((r) => r.id === id);
  return record ? sanitize(record) : null;
}

export interface CreateCredentialResult {
  record: SanitizedCredentialRecord | null;
  error?: string;
  valid: boolean;
}

export interface CreateCredentialInput {
  providerId: string;
  label: string;
  accountHint?: string | null;
  credential: Record<string, unknown>;
}

/**
 * Create a new credential.
 *
 * Validates the credential, stores it, and returns the sanitized record.
 */
export function createCredential(input: CreateCredentialInput): CreateCredentialResult {
  const { providerId, label, accountHint, credential } = input;
  const validation = validateCredential(providerId, credential);
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
    credential,
  });

  return { record: sanitize(stored), valid: true };
}

export interface UpdateCredentialResult {
  record: SanitizedCredentialRecord | null;
  error?: string;
  valid: boolean;
}

export interface UpdateCredentialInput {
  label?: string;
  accountHint?: string | null;
  credential?: Record<string, unknown>;
}

/**
 * Update an existing credential by ID.
 */
export function updateCredentialById(id: string, updates: UpdateCredentialInput): UpdateCredentialResult {
  if (!id) return { record: null, error: 'ID is required', valid: false };

  const records = loadCredentials();
  const existing = records.find((r) => r.id === id);
  if (!existing) {
    return { record: null, error: 'Credential not found', valid: false };
  }

  const patch: Partial<QuotaCredentialRecord> = {};

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
    const validation = validateCredential(existing.providerId, updates.credential);
    if (!validation.valid) {
      return { record: null, error: validation.error, valid: false };
    }
    patch.credential = updates.credential;
    patch.validationStatus = 'untested';
    patch.lastValidatedAt = null;
  }

  const updated = updateCredential(id, patch);
  return { record: updated ? sanitize(updated) : null, valid: true };
}

/**
 * Delete a credential by ID.
 */
export function deleteCredentialById(id: string): boolean {
  return deleteCredential(id);
}

export interface ValidateCredentialByIdResult {
  valid: boolean;
  error?: string;
  status: string | null;
}

/**
 * Validate a stored credential by ID.
 *
 * Loads the raw record (with credential field), runs structural
 * validation, updates `validationStatus` and `lastValidatedAt`,
 * and returns the validation result. Never returns the raw secret.
 */
export function validateCredentialById(id: string): ValidateCredentialByIdResult {
  if (!id) return { valid: false, error: 'ID is required', status: null };

  const records = loadCredentials();
  const record = records.find((r) => r.id === id);
  if (!record) {
    return { valid: false, error: 'Credential not found', status: null };
  }

  const result = validateCredential(record.providerId, record.credential);

  const status = result.valid ? 'valid' : 'invalid';
  updateCredential(id, {
    validationStatus: status as QuotaCredentialRecord['validationStatus'],
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
 */
export async function discoverCredentials(providerId: string): Promise<LegacyCredentialDiscovery | null> {
  if (!providerId || !VALID_PROVIDER_IDS.has(providerId)) {
    return null;
  }

  const schema = PROVIDER_CREDENTIAL_SCHEMAS[providerId];

  if (schema && Array.isArray(schema.legacyFiles)) {
    for (const filename of schema.legacyFiles) {
      const candidatePath = getLegacyOpenCodePath(filename);
      if (!candidatePath) continue;
      const result = await readLegacyCookieFile(candidatePath);
      if (result) {
        return { ...result, providerId };
      }
    }
    return null;
  }

  return discoverLegacyCredentials(providerId);
}