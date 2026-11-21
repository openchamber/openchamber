import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deleteManagedCredential, getManagedCredentialStatus, normalizers, readManagedCredential, writeManagedCredential } from './providers.js';

const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-quota-providers-'));
process.env.OPENCHAMBER_DATA_DIR = temporaryDirectory;

describe('managed quota credentials', () => {
  it('rejects missing and malformed JSON credentials', () => {
    for (const normalize of Object.values(normalizers)) {
      for (const value of [undefined, null, false, 0, 'token', [], {}, {
        usageToken: 42,
        accessToken: false,
        refreshToken: [],
        platformApiKey: {},
      }, {
        usageToken: 'token\n',
        accessToken: '\rtoken',
        refreshToken: 'token\nnext',
        platformApiKey: '\ntoken',
      }]) {
        expect(normalize(value)).toBeNull();
      }
    }
  });

  it('trims secrets and keeps the provider-specific fields', () => {
    expect(normalizers['exe-dev']({ usageToken: ' token ', ignored: true })).toEqual({ usageToken: 'token' });
    expect(normalizers.zenmux({ platformApiKey: ' key ' })).toEqual({ platformApiKey: 'key' });
    expect(normalizers.cursor({ accessToken: ' access ' })).toEqual({ accessToken: 'access', refreshToken: '' });
    expect(normalizers.cursor({ refreshToken: ' refresh ' })).toEqual({ accessToken: '', refreshToken: 'refresh' });
    expect(normalizers.cursor({ accessToken: 'bad\n', refreshToken: ' refresh ' })).toEqual({ accessToken: '', refreshToken: 'refresh' });
  });

  it('round-trips credentials while returning only masked status', () => {
    for (const [providerId, credential] of [
      ['exe-dev', { usageToken: 'token' }],
      ['zenmux', { platformApiKey: 'key' }],
      ['cursor', { accessToken: 'access', refreshToken: '' }],
    ]) {
      expect(getManagedCredentialStatus(providerId)).toEqual({ configured: false });
      const status = { configured: true, secretMasked: '••••••••' };
      if (providerId === 'cursor') status.hasRefreshToken = false;
      expect(writeManagedCredential(providerId, credential)).toEqual(status);
      expect(readManagedCredential(providerId)).toEqual(credential);
      expect(getManagedCredentialStatus(providerId)).toEqual(status);
      deleteManagedCredential(providerId);
      expect(readManagedCredential(providerId)).toBeNull();
      deleteManagedCredential(providerId);
    }
    expect(writeManagedCredential('cursor', { refreshToken: 'refresh' })).toEqual({
      configured: true, hasRefreshToken: true, secretMasked: '••••••••',
    });
    expect(() => writeManagedCredential('exe-dev', {})).toThrow('Invalid credential');
  });
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
  else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
