import { afterAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUiPasskeys } from './ui-passkeys.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-ui-passkeys-test-'));

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const PASSWORD_BINDING = 'ui-password-binding';

const createStoreFile = (passkeys) => {
  const storeFile = path.join(fs.mkdtempSync(path.join(dataDir, 'store-')), 'ui-passkeys.json');
  fs.writeFileSync(storeFile, JSON.stringify({
    version: 1,
    userID: 'user-id',
    passwordBinding: PASSWORD_BINDING,
    passkeys,
  }, null, 2));
  return storeFile;
};

const createController = (storeFile) => createUiPasskeys({
  passwordBinding: PASSWORD_BINDING,
  readSettingsFromDiskMigrated: async () => ({}),
  storeFile,
});

const passkey = (overrides = {}) => ({
  id: 'credential-1',
  publicKey: 'cHVibGljLWtleQ',
  counter: 0,
  transports: [],
  deviceType: 'singleDevice',
  backedUp: false,
  createdAt: 1000,
  lastUsedAt: null,
  label: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  rpID: 'example.com',
  ...overrides,
});

const requestFor = (host = 'example.com') => ({
  headers: { host },
  socket: {},
  hostname: host,
});

const readStoredPasskey = (storeFile) => {
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  return store.passkeys[0];
};

describe('ui-passkeys rename', () => {
  it('lists the auto-generated name with no custom label', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    const [listed] = controller.listPasskeys(requestFor());

    expect(listed.label).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    expect(listed.customLabel).toBe(null);
  });

  it('stores a custom name and returns it as the display label', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    const result = controller.renamePasskey(requestFor(), 'credential-1', 'Office laptop');

    expect(result.renamed).toBe(true);
    expect(result.passkey.label).toBe('Office laptop');
    expect(result.passkey.customLabel).toBe('Office laptop');
    expect(readStoredPasskey(storeFile).customLabel).toBe('Office laptop');

    // A fresh controller reads the same custom name from disk.
    const [listed] = createController(storeFile).listPasskeys(requestFor());
    expect(listed.label).toBe('Office laptop');
    expect(listed.customLabel).toBe('Office laptop');
  });

  it('clears the custom name and falls back to the auto-generated one', () => {
    const storeFile = createStoreFile([passkey({ customLabel: 'Old name' })]);
    const controller = createController(storeFile);

    const result = controller.renamePasskey(requestFor(), 'credential-1', '   ');

    expect(result.passkey.customLabel).toBe(null);
    expect(result.passkey.label).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    expect(readStoredPasskey(storeFile).customLabel).toBe(null);
  });

  it('collapses whitespace and caps the stored label at 120 characters', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    const result = controller.renamePasskey(requestFor(), 'credential-1', `  Living   room ${'x'.repeat(200)}  `);

    expect(result.passkey.customLabel.startsWith('Living room ')).toBe(true);
    expect(result.passkey.customLabel.length).toBe(120);
  });

  it('refuses a passkey that belongs to another host', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    let thrown = null;
    try {
      controller.renamePasskey(requestFor('other.example.com'), 'credential-1', 'Office laptop');
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.statusCode).toBe(404);
    expect(readStoredPasskey(storeFile).customLabel).toBeUndefined();
  });

  it('rejects an unknown passkey id', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    let thrown = null;
    try {
      controller.renamePasskey(requestFor(), 'missing-credential', 'Office laptop');
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.statusCode).toBe(404);
  });

  it('rejects a missing passkey id', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    let thrown = null;
    try {
      controller.renamePasskey(requestFor(), '   ', 'Office laptop');
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.statusCode).toBe(400);
  });

  it('rejects renames when UI password protection is off', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createUiPasskeys({
      passwordBinding: '',
      readSettingsFromDiskMigrated: async () => ({}),
      storeFile,
    });

    let thrown = null;
    try {
      controller.renamePasskey(requestFor(), 'credential-1', 'Office laptop');
    } catch (error) {
      thrown = error;
    }

    expect(thrown?.statusCode).toBe(400);
  });
});
