import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  loadCredentials,
  saveCredentials,
  getCredential,
  addCredential,
  updateCredential,
  deleteCredential,
  sanitize,
} from './store.js';

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cred-store-test-'));
}

describe('sanitize', () => {
  it('strips the credential field from a record', () => {
    const record = {
      id: 'cred_1',
      providerId: 'atlascloud',
      label: 'Test',
      credential: { cookie: 'secret', accountUuid: 'uuid' },
    };
    const sanitized = sanitize(record);
    expect(sanitized).not.toHaveProperty('credential');
    expect(sanitized.id).toBe('cred_1');
    expect(sanitized.providerId).toBe('atlascloud');
    expect(sanitized.label).toBe('Test');
  });

  it('does not mutate the original record', () => {
    const record = {
      id: 'cred_1',
      credential: { cookie: 'secret' },
    };
    sanitize(record);
    expect(record.credential).toEqual({ cookie: 'secret' });
  });

  it('handles null and non-object input', () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeUndefined();
    expect(sanitize('string')).toBe('string');
  });
});

describe('store CRUD', () => {
  let originalDataDir;
  let tempDir;

  beforeEach(() => {
    originalDataDir = process.env.OPENCHAMBER_DATA_DIR;
    tempDir = createTempDataDir();
    process.env.OPENCHAMBER_DATA_DIR = tempDir;
  });

  afterEach(() => {
    process.env.OPENCHAMBER_DATA_DIR = originalDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('loadCredentials returns empty array when file does not exist', () => {
    expect(loadCredentials()).toEqual([]);
  });

  it('addCredential stores and returns a record with generated ID', () => {
    const record = {
      providerId: 'atlascloud',
      label: 'My Account',
      credential: { cookie: 'secret-cookie', accountUuid: 'uuid-1' },
    };
    const stored = addCredential(record);

    expect(stored.id).toMatch(/^cred_\d+_[a-f0-9]+$/);
    expect(stored.providerId).toBe('atlascloud');
    expect(stored.label).toBe('My Account');
    expect(stored.credential).toEqual({ cookie: 'secret-cookie', accountUuid: 'uuid-1' });
    expect(stored.createdAt).toBeGreaterThan(0);
    expect(stored.updatedAt).toBe(stored.createdAt);
    expect(stored.validationStatus).toBe('untested');
  });

  it('saveCredentials and loadCredentials round-trip', () => {
    const records = [
      { id: 'cred_a', providerId: 'atlascloud', credential: { cookie: 'a' } },
      { id: 'cred_b', providerId: 'byteplus', credential: { token: 'b' } },
    ];
    saveCredentials(records);
    const loaded = loadCredentials();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('cred_a');
    expect(loaded[1].id).toBe('cred_b');
  });

  it('getCredential finds by providerId and accountHint', () => {
    addCredential({
      providerId: 'atlascloud',
      label: 'Account 1',
      accountHint: 'user1@example.com',
      credential: { cookie: 'c1', accountUuid: 'u1' },
    });
    addCredential({
      providerId: 'atlascloud',
      label: 'Account 2',
      accountHint: 'user2@example.com',
      credential: { cookie: 'c2', accountUuid: 'u2' },
    });

    const found = getCredential('atlascloud', 'user2@example.com');
    expect(found).not.toBeNull();
    expect(found.label).toBe('Account 2');

    const first = getCredential('atlascloud');
    expect(first).not.toBeNull();

    const missing = getCredential('nonexistent');
    expect(missing).toBeNull();
  });

  it('updateCredential patches an existing record', () => {
    const stored = addCredential({
      providerId: 'atlascloud',
      label: 'Old Label',
      credential: { cookie: 'old' },
    });

    const updated = updateCredential(stored.id, {
      label: 'New Label',
      validationStatus: 'valid',
    });

    expect(updated).not.toBeNull();
    expect(updated.label).toBe('New Label');
    expect(updated.validationStatus).toBe('valid');
    expect(updated.id).toBe(stored.id);
    expect(updated.createdAt).toBe(stored.createdAt);
    expect(updated.updatedAt).toBeGreaterThanOrEqual(stored.updatedAt);
  });

  it('updateCredential returns null for missing ID', () => {
    const result = updateCredential('nonexistent_id', { label: 'x' });
    expect(result).toBeNull();
  });

  it('deleteCredential removes a record', () => {
    const stored = addCredential({
      providerId: 'atlascloud',
      label: 'To Delete',
      credential: { cookie: 'del' },
    });

    expect(deleteCredential(stored.id)).toBe(true);
    expect(loadCredentials()).toHaveLength(0);
  });

  it('deleteCredential returns false for missing ID', () => {
    expect(deleteCredential('nonexistent_id')).toBe(false);
  });

  it('storage path is under OpenChamber data dir', () => {
    addCredential({
      providerId: 'atlascloud',
      label: 'Path Test',
      credential: { cookie: 'x' },
    });

    const expectedDir = path.join(tempDir, 'quota', 'credentials');
    const expectedFile = path.join(expectedDir, 'credentials.json');
    expect(fs.existsSync(expectedDir)).toBe(true);
    expect(fs.existsSync(expectedFile)).toBe(true);
  });

  it('saveCredentials creates the directory if it does not exist', () => {
    const dir = path.join(tempDir, 'quota', 'credentials');
    expect(fs.existsSync(dir)).toBe(false);
    saveCredentials([{ id: 'x', providerId: 'atlascloud' }]);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
