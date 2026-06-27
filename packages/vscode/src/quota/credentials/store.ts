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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { getQuotaCredentialsDir } from '../credentials-path';

const CREDENTIALS_FILENAME = 'credentials.json';

export type QuotaCredentialValidationStatus = 'untested' | 'valid' | 'expired' | 'invalid';

export interface QuotaCredentialRecord {
  id: string;
  providerId: string;
  label: string;
  accountHint?: string | null;
  createdAt: number;
  updatedAt: number;
  validationStatus: QuotaCredentialValidationStatus;
  lastValidatedAt?: number | null;
  expiry?: number | null;
  credential: Record<string, unknown>;
}

export type SanitizedCredentialRecord = Omit<QuotaCredentialRecord, 'credential'>;

function getCredentialsFilePath(): string {
  return path.join(getQuotaCredentialsDir(), CREDENTIALS_FILENAME);
}

function ensureCredentialsDir(): void {
  const dir = getQuotaCredentialsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Return a sanitized copy of a credential record with the `credential`
 * field removed.
 */
export function sanitize<T extends QuotaCredentialRecord | null | undefined>(record: T): SanitizedCredentialRecord | null {
  if (!record || typeof record !== 'object') return null;
  const { credential: _credential, ...rest } = record;
  void _credential;
  return rest;
}

function generateCredentialId(): string {
  const timestamp = Date.now();
  const random = crypto.randomBytes(6).toString('hex');
  return `cred_${timestamp}_${random}`;
}

/**
 * Read all credential records from disk.
 *
 * Returns an empty array when the file does not exist or is empty.
 */
export function loadCredentials(): QuotaCredentialRecord[] {
  const filePath = getCredentialsFilePath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Write all credential records to disk atomically.
 *
 * Writes to a temporary file first, then renames to the final path
 * to avoid partial writes.
 */
export function saveCredentials(records: QuotaCredentialRecord[]): void {
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
 */
export function getCredential(providerId: string, accountKey?: string): QuotaCredentialRecord | null {
  if (!providerId) return null;
  const records = loadCredentials();
  for (const record of records) {
    if (record.providerId !== providerId) continue;
    if (!accountKey) return record;
    if (record.accountHint === accountKey) return record;
  }
  return null;
}

export interface NewCredentialInput {
  providerId: string;
  label: string;
  accountHint?: string | null;
  credential: Record<string, unknown>;
  validationStatus?: QuotaCredentialValidationStatus;
  lastValidatedAt?: number | null;
  expiry?: number | null;
}

/**
 * Add a new credential record.
 *
 * Generates an ID, sets timestamps and default validation status,
 * then persists.
 */
export function addCredential(record: NewCredentialInput): QuotaCredentialRecord {
  const records = loadCredentials();
  const now = Date.now();
  const stored: QuotaCredentialRecord = {
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
 */
export function updateCredential(id: string, updates: Partial<QuotaCredentialRecord>): QuotaCredentialRecord | null {
  if (!id) return null;
  const records = loadCredentials();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) return null;
  const existing = records[index];
  const updated: QuotaCredentialRecord = {
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
 */
export function deleteCredential(id: string): boolean {
  if (!id) return false;
  const records = loadCredentials();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) return false;
  records.splice(index, 1);
  saveCredentials(records);
  return true;
}