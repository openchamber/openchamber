/**
 * Credential storage
 *
 * Persistent credential storage for manual-auth quota providers.
 * Credentials are stored under the OpenChamber data dir
 * (quota/credentials/credentials.json), never in browser local storage.
 *
 * The `credential` field stores the raw secret and MUST NEVER be returned
 * from list/get endpoints. Use `sanitize()` to strip it before returning.
 *
 * @module quota/credentials/store
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { getQuotaCredentialsDir } from '../utils/credentials-path.js';

const CREDENTIALS_FILENAME = 'credentials.json';

/**
 * Resolve the full path to the credentials JSON file.
 *
 * @returns {string}
 */
function getCredentialsFilePath() {
  return path.join(getQuotaCredentialsDir(), CREDENTIALS_FILENAME);
}

/**
 * Ensure the credentials directory exists before writing.
 *
 * @returns {void}
 */
function ensureCredentialsDir() {
  const dir = getQuotaCredentialsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Return a sanitized copy of a credential record with the `credential`
 * field removed.
 *
 * @param {object} record
 * @returns {object} - copy of record without the `credential` field
 */
export function sanitize(record) {
  if (!record || typeof record !== 'object') return record;
  const { credential, ...rest } = record;
  return rest;
}

/**
 * Generate a unique credential ID.
 *
 * Format: `cred_<timestamp>_<random>`
 *
 * @returns {string}
 */
function generateCredentialId() {
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  return `cred_${timestamp}_${random}`;
}

/**
 * Read all credential records from disk.
 *
 * Returns an empty array when the file does not exist or is empty.
 *
 * @returns {object[]}
 */
export function loadCredentials() {
  const filePath = getCredentialsFilePath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn('Failed to read quota credentials file; treating as empty. Existing credentials may be unreadable.');
    return [];
  }
}

/**
 * Write all credential records to disk atomically.
 *
 * Writes to a temporary file first, then renames to the final path
 * to avoid partial writes.
 *
 * @param {object[]} records
 * @returns {void}
 */
export function saveCredentials(records) {
  ensureCredentialsDir();
  const filePath = getCredentialsFilePath();
  const tmpPath = `${filePath}.tmp`;
  const data = JSON.stringify(records, null, 2);
  fs.writeFileSync(tmpPath, data, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

/**
 * Get a single credential record by providerId and accountKey.
 *
 * Matches by `providerId` and `accountHint` (the account identifier
 * stored on the record). If `accountKey` is omitted, returns the first
 * record for the given provider.
 *
 * @param {string} providerId
 * @param {string} [accountKey]
 * @returns {object|null}
 */
export function getCredential(providerId, accountKey) {
  if (!providerId) return null;
  const records = loadCredentials();
  for (const record of records) {
    if (record.providerId !== providerId) continue;
    if (!accountKey) return record;
    if (record.accountHint === accountKey) return record;
  }
  return null;
}

/**
 * Add a new credential record.
 *
 * Generates an ID, sets timestamps and default validation status,
 * then persists.
 *
 * @param {object} record - { providerId, label, accountHint?, credential, ... }
 * @returns {object} - the stored record (with credential field)
 */
export function addCredential(record) {
  const records = loadCredentials();
  const now = Date.now();
  const stored = {
    id: generateCredentialId(),
    providerId: record.providerId,
    label: record.label || '',
    accountHint: record.accountHint || null,
    createdAt: now,
    updatedAt: now,
    validationStatus: record.validationStatus || 'untested',
    lastValidatedAt: record.lastValidatedAt || null,
    expiry: record.expiry || null,
    credential: record.credential,
  };
  records.push(stored);
  saveCredentials(records);
  return stored;
}

/**
 * Patch an existing credential record by ID.
 *
 * Merges `updates` into the existing record, refreshes `updatedAt`,
 * and persists.
 *
 * @param {string} id
 * @param {object} updates
 * @returns {object|null} - the updated record (with credential field), or null if not found
 */
export function updateCredential(id, updates) {
  if (!id) return null;
  const records = loadCredentials();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) return null;
  const existing = records[index];
  const updated = {
    ...existing,
    ...updates,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };
  records[index] = updated;
  saveCredentials(records);
  return updated;
}

/**
 * Remove a credential record by ID.
 *
 * @param {string} id
 * @returns {boolean} - true if a record was removed, false if not found
 */
export function deleteCredential(id) {
  if (!id) return false;
  const records = loadCredentials();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) return false;
  records.splice(index, 1);
  saveCredentials(records);
  return true;
}
