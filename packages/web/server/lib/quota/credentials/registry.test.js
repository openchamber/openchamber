import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  listCredentials,
  getCredentialById,
  createCredential,
  updateCredentialById,
  deleteCredentialById,
  validateCredential,
  validateCredentialById,
  discoverCredentials,
} from './registry.js';

function createTempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cred-registry-test-'));
}

describe('validateCredential', () => {
  it('rejects invalid providerId', () => {
    const result = validateCredential('invalid-provider', { cookie: 'x' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported provider ID');
  });

  it('rejects empty providerId', () => {
    const result = validateCredential('', { cookie: 'x' });
    expect(result.valid).toBe(false);
  });

  it('rejects non-object credential', () => {
    const result = validateCredential('atlascloud', 'not-an-object');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('must be an object');
  });

  it('rejects array credential', () => {
    const result = validateCredential('atlascloud', ['array']);
    expect(result.valid).toBe(false);
  });

  it('rejects empty credential object', () => {
    const result = validateCredential('atlascloud', {});
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least one field');
  });

  it('accepts valid atlascloud credential with cookie containing access-token=', () => {
    const result = validateCredential('atlascloud', {
      cookie: 'access-token=eyJtest',
      accountUuid: 'uuid-123',
    });
    expect(result.valid).toBe(true);
  });

  it('accepts atlascloud credential without optional accountUuid', () => {
    const result = validateCredential('atlascloud', {
      cookie: 'access-token=eyJtest',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects atlascloud credential missing cookie', () => {
    const result = validateCredential('atlascloud', { accountUuid: 'uuid' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cookie');
  });

  it('rejects atlascloud cookie without access-token=', () => {
    const result = validateCredential('atlascloud', { cookie: 'my-cookie' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('access-token=');
  });

  it('rejects OAuth providers that have no manual credential schema', () => {
    for (const id of ['openai', 'xai', 'anthropic', 'google', 'zai-coding-plan', 'minimax-coding-plan']) {
      const result = validateCredential(id, { cookie: 'x', apiKey: 'y' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Unsupported provider');
    }
  });

  it('rejects xai explicitly (OAuth-only, no manual credential schema)', () => {
    const result = validateCredential('xai', { cookie: 'xai_session=abc' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Unsupported provider ID: xai');
  });

  it('enforces required fields for each of the 9 manual-credential providers', () => {
    expect(
      validateCredential('atlascloud', { cookie: 'access-token=x' }).valid
    ).toBe(true);
    expect(validateCredential('atlascloud', { accountUuid: 'u' }).valid).toBe(false);

    expect(
      validateCredential('byteplus', { cookie: 'csrfToken=x' }).valid
    ).toBe(true);
    expect(validateCredential('byteplus', { cookie: 'wrong=abc' }).valid).toBe(false);

    expect(
      validateCredential('longcat', { passportToken: 'tok' }).valid
    ).toBe(true);
    expect(
      validateCredential('longcat', { cookie: 'passport_token_key=tok' }).valid
    ).toBe(true);
    expect(validateCredential('longcat', { cookie: 'wrong=abc' }).valid).toBe(false);

    expect(
      validateCredential('qwencloud', { ticket: 't', isg: 'i' }).valid
    ).toBe(true);
    expect(
      validateCredential('qwencloud', { ticket: 't' }).valid
    ).toBe(false);

    expect(
      validateCredential('stepfun', { oasisToken: 't', oasisWebid: 'w' }).valid
    ).toBe(true);
    expect(validateCredential('stepfun', { oasisToken: 't' }).valid).toBe(false);

    expect(
      validateCredential('mistral', { cookie: 'csrftoken=abc' }).valid
    ).toBe(true);
    expect(validateCredential('mistral', { cookie: 'wrong=abc' }).valid).toBe(false);

    expect(
      validateCredential('ollama-cloud', { cookie: '__Secure-session=abc' }).valid
    ).toBe(true);
    expect(validateCredential('ollama-cloud', { cookie: 'wrong=abc' }).valid).toBe(false);

    expect(
      validateCredential('opencode-go', { workspaceId: 'ws', authCookie: 'c' }).valid
    ).toBe(true);
    expect(validateCredential('opencode-go', { workspaceId: 'ws' }).valid).toBe(false);
  });

  it('uses schema validation for byteplus cookie content', () => {
    expect(
      validateCredential('byteplus', { cookie: 'csrfToken=abc; session=xyz' }).valid
    ).toBe(true);
    expect(
      validateCredential('byteplus', { cookie: 'session=xyz' }).valid
    ).toBe(false);
  });

  it('uses schema validation for longcat OR-logic fields', () => {
    expect(
      validateCredential('longcat', { passportToken: 'tok' }).valid
    ).toBe(true);
    expect(
      validateCredential('longcat', { cookie: 'passport_token_key=tok' }).valid
    ).toBe(true);
    expect(validateCredential('longcat', { region: '2' }).valid).toBe(false);
  });

  it('uses schema validation for opencode-go (workspaceId + authCookie both required)', () => {
    expect(
      validateCredential('opencode-go', { workspaceId: 'ws-1', authCookie: 'c' }).valid
    ).toBe(true);
    expect(
      validateCredential('opencode-go', {
        accounts: [{ id: 'a', workspaceId: 'ws-1', authCookie: 'c' }],
      }).valid
    ).toBe(true);
    expect(validateCredential('opencode-go', { workspaceId: 'ws-1' }).valid).toBe(false);
    expect(validateCredential('opencode-go', { authCookie: 'c' }).valid).toBe(false);
  });
});

describe('registry CRUD', () => {
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

  it('listCredentials returns sanitized records (no credential field)', () => {
    createCredential({
      providerId: 'atlascloud',
      label: 'Test Account',
      credential: { cookie: 'access-token=secret', accountUuid: 'uuid' },
    });

    const list = listCredentials();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('credential');
    expect(list[0].label).toBe('Test Account');
    expect(list[0].providerId).toBe('atlascloud');
  });

  it('listCredentials returns empty array when no records exist', () => {
    expect(listCredentials()).toEqual([]);
  });

  it('createCredential validates and stores', () => {
    const result = createCredential({
      providerId: 'atlascloud',
      label: 'New Account',
      accountHint: 'user@example.com',
      credential: { cookie: 'access-token=cookie-val', accountUuid: 'uuid-val' },
    });

    expect(result.valid).toBe(true);
    expect(result.record).not.toBeNull();
    expect(result.record.id).toMatch(/^cred_/);
    expect(result.record.label).toBe('New Account');
    expect(result.record.accountHint).toBe('user@example.com');
    expect(result.record).not.toHaveProperty('credential');
  });

  it('createCredential rejects invalid providerId', () => {
    const result = createCredential({
      providerId: 'invalid',
      label: 'Bad',
      credential: { cookie: 'x' },
    });

    expect(result.valid).toBe(false);
    expect(result.record).toBeNull();
    expect(result.error).toContain('Unsupported provider ID');
  });

  it('createCredential rejects missing label', () => {
    const result = createCredential({
      providerId: 'atlascloud',
      label: '',
      credential: { cookie: 'access-token=x', accountUuid: 'u' },
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Label');
  });

  it('createCredential rejects invalid credential shape', () => {
    const result = createCredential({
      providerId: 'atlascloud',
      label: 'Test',
      credential: {},
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least one field');
  });

  it('getCredentialById returns sanitized record', () => {
    const created = createCredential({
      providerId: 'atlascloud',
      label: 'Find Me',
      credential: { cookie: 'access-token=c', accountUuid: 'u' },
    });

    const found = getCredentialById(created.record.id);
    expect(found).not.toBeNull();
    expect(found.label).toBe('Find Me');
    expect(found).not.toHaveProperty('credential');
  });

  it('getCredentialById returns null for missing ID', () => {
    expect(getCredentialById('nonexistent')).toBeNull();
  });

  it('updateCredentialById patches label', () => {
    const created = createCredential({
      providerId: 'atlascloud',
      label: 'Old',
      credential: { cookie: 'access-token=c', accountUuid: 'u' },
    });

    const result = updateCredentialById(created.record.id, { label: 'New' });
    expect(result.valid).toBe(true);
    expect(result.record.label).toBe('New');
    expect(result.record).not.toHaveProperty('credential');
  });

  it('updateCredentialById patches credential and resets validation', () => {
    const created = createCredential({
      providerId: 'atlascloud',
      label: 'Test',
      credential: { cookie: 'access-token=old', accountUuid: 'u' },
    });

    const result = updateCredentialById(created.record.id, {
      credential: { cookie: 'access-token=new', accountUuid: 'u' },
    });

    expect(result.valid).toBe(true);
    expect(result.record.validationStatus).toBe('untested');
    expect(result.record.lastValidatedAt).toBeNull();
    expect(result.record).not.toHaveProperty('credential');
  });

  it('updateCredentialById rejects invalid credential update', () => {
    const created = createCredential({
      providerId: 'atlascloud',
      label: 'Test',
      credential: { cookie: 'access-token=c', accountUuid: 'u' },
    });

    const result = updateCredentialById(created.record.id, { credential: {} });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least one field');
  });

  it('updateCredentialById returns error for missing ID', () => {
    const result = updateCredentialById('nonexistent', { label: 'x' });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('deleteCredentialById removes record', () => {
    const created = createCredential({
      providerId: 'atlascloud',
      label: 'Delete Me',
      credential: { cookie: 'access-token=c', accountUuid: 'u' },
    });

    expect(deleteCredentialById(created.record.id)).toBe(true);
    expect(getCredentialById(created.record.id)).toBeNull();
    expect(listCredentials()).toHaveLength(0);
  });

  it('deleteCredentialById returns false for missing ID', () => {
    expect(deleteCredentialById('nonexistent')).toBe(false);
  });
});

describe('validateCredentialById', () => {
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

  it('validates a stored credential and updates status', () => {
    const created = createCredential({
      providerId: 'atlascloud',
      label: 'Validate Me',
      credential: { cookie: 'access-token=c', accountUuid: 'u' },
    });

    const result = validateCredentialById(created.record.id);
    expect(result.valid).toBe(true);
    expect(result.status).toBe('valid');

    const updated = getCredentialById(created.record.id);
    expect(updated.validationStatus).toBe('valid');
    expect(updated.lastValidatedAt).toBeGreaterThan(0);
  });

  it('returns error for missing ID', () => {
    const result = validateCredentialById('nonexistent');
    expect(result.valid).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain('not found');
  });
});

describe('discoverCredentials', () => {
  it('returns null for invalid providerId', async () => {
    const result = await discoverCredentials('invalid-provider');
    expect(result).toBeNull();
  });

  it('returns null when no legacy file exists', async () => {
    const result = await discoverCredentials('atlascloud');
    expect(result).toBeNull();
  });

  it('returns null for poe (auth.json provider, not a manual credential)', async () => {
    const result = await discoverCredentials('poe');
    expect(result).toBeNull();
  });

  it('returns null for xai (OAuth provider, not a manual credential)', async () => {
    const result = await discoverCredentials('xai');
    expect(result).toBeNull();
  });

  it('returns null for OAuth providers with no credential schema', async () => {
    const result = await discoverCredentials('openai');
    expect(result).toBeNull();
  });
});
