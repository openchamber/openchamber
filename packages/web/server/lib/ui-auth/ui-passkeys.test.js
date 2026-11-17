import { afterAll, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createUiPasskeys } from './ui-passkeys.js';

// Registration verification runs through a stubbed WebAuthn server so the
// stored label can be checked end to end without a real authenticator.
mock.module('@simplewebauthn/server', () => ({
  generateRegistrationOptions: async () => ({ challenge: 'registration-challenge' }),
  verifyRegistrationResponse: async () => ({
    verified: true,
    registrationInfo: {
      credential: {
        id: 'credential-registered',
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        transports: [],
      },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
    },
  }),
}));

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

describe('ui-passkeys store durability', () => {
  const siblingsMatching = (storeFile, needle) => fs.readdirSync(path.dirname(storeFile))
    .filter((name) => name.includes(needle));

  it('creates a fresh store with mode 0600 and no corrupt backup', () => {
    const dir = fs.mkdtempSync(path.join(dataDir, 'fresh-'));
    const storeFile = path.join(dir, 'ui-passkeys.json');
    const controller = createController(storeFile);

    expect(controller.listPasskeys(requestFor())).toEqual([]);
    expect(fs.existsSync(storeFile)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(storeFile).mode & 0o777).toBe(0o600);
    }
    expect(siblingsMatching(storeFile, '.corrupt-')).toEqual([]);
    expect(siblingsMatching(storeFile, '.tmp-')).toEqual([]);
  });

  it('initializes an existing empty file in place so the userID stays stable', () => {
    const dir = fs.mkdtempSync(path.join(dataDir, 'empty-'));
    const storeFile = path.join(dir, 'ui-passkeys.json');
    fs.writeFileSync(storeFile, '');
    const controller = createController(storeFile);

    expect(controller.listPasskeys(requestFor())).toEqual([]);
    // The empty file holds no bytes worth preserving, so no corrupt
    // sibling appears; the fresh store is persisted in place instead,
    // and a later load reuses the persisted userID rather than
    // inventing a new one.
    const initialized = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    expect(String(initialized.userID)).toBe(initialized.userID);
    expect(initialized.userID.length).toBeGreaterThan(0);
    expect(initialized.passkeys).toEqual([]);
    expect(siblingsMatching(storeFile, '.corrupt-')).toEqual([]);
    const secondController = createController(storeFile);
    expect(secondController.listPasskeys(requestFor())).toEqual([]);
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf8')).userID).toBe(initialized.userID);
  });

  it('preserves a corrupt store before overwriting it instead of silently discarding passkeys', () => {
    const storeFile = createStoreFile([passkey(), passkey({ id: 'credential-2' })]);
    const valid = fs.readFileSync(storeFile, 'utf8');
    const torn = valid.slice(0, Math.floor(valid.length / 2));
    fs.writeFileSync(storeFile, torn);
    const controller = createController(storeFile);

    expect(controller.listPasskeys(requestFor())).toEqual([]);

    const preserved = siblingsMatching(storeFile, '.corrupt-');
    expect(preserved.length).toBe(1);
    expect(fs.readFileSync(path.join(path.dirname(storeFile), preserved[0]), 'utf8')).toBe(torn);
    // The replacement store is valid JSON with no passkeys: the original
    // bytes survive only in the preserved copy, never silently lost.
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf8')).passkeys).toEqual([]);
  });

  it('refuses to replace a corrupt store when preservation fails', () => {
    const storeFile = createStoreFile([passkey()]);
    const corrupt = '{ not json';
    fs.writeFileSync(storeFile, corrupt);
    const storeFs = {
      existsSync: (...args) => fs.existsSync(...args),
      readFileSync: (...args) => fs.readFileSync(...args),
      renameSync: (from, to) => {
        if (String(to).includes('.corrupt-')) {
          throw new Error('preserve failed');
        }
        return fs.renameSync(from, to);
      },
    };
    const controller = createUiPasskeys({
      passwordBinding: PASSWORD_BINDING,
      readSettingsFromDiskMigrated: async () => ({}),
      storeFile,
      fs: storeFs,
    });

    expect(() => controller.listPasskeys(requestFor())).toThrow('refusing to overwrite it');
    expect(fs.readFileSync(storeFile, 'utf8')).toBe(corrupt);
  });

  it('treats a non-object store as corrupt and preserves it', () => {
    const dir = fs.mkdtempSync(path.join(dataDir, 'scalar-'));
    const storeFile = path.join(dir, 'ui-passkeys.json');
    fs.writeFileSync(storeFile, '123');
    const controller = createController(storeFile);

    expect(controller.listPasskeys(requestFor())).toEqual([]);
    expect(siblingsMatching(storeFile, '.corrupt-').length).toBe(1);
  });

  it('propagates a filesystem read error without moving or replacing the active store', () => {
    // A directory in place of the store file makes readFileSync fail
    // with a non-ENOENT filesystem error (EISDIR on Linux) regardless
    // of the test process's privileges, unlike a mode-000 file under root.
    const dir = fs.mkdtempSync(path.join(dataDir, 'read-error-'));
    const storeFile = path.join(dir, 'ui-passkeys.json');
    fs.mkdirSync(storeFile);
    const controller = createController(storeFile);

    let thrown = null;
    try {
      controller.listPasskeys(requestFor());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.code).not.toBe('ENOENT');
    // The active store is untouched and nothing was preserved/created.
    expect(fs.statSync(storeFile).isDirectory()).toBe(true);
    expect(siblingsMatching(storeFile, '.corrupt-')).toEqual([]);
  });

  it('rewrites an existing store atomically with mode 0600 and no temp leftovers', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    const result = controller.renamePasskey(requestFor(), 'credential-1', 'Office laptop');

    expect(result.renamed).toBe(true);
    expect(readStoredPasskey(storeFile).customLabel).toBe('Office laptop');
    if (process.platform !== 'win32') {
      expect(fs.statSync(storeFile).mode & 0o777).toBe(0o600);
    }
    expect(siblingsMatching(storeFile, '.tmp-')).toEqual([]);
    expect(siblingsMatching(storeFile, '.corrupt-')).toEqual([]);
  });
});

describe('ui-passkeys surrogate-pair clamp (#2012)', () => {
  // 119 ASCII units, then an emoji (two code units) straddling offset 120.
  const straddlingLabel = `${'d'.repeat(119)}\u{1F600}x`;

  it('caps a renamed label at the surrogate pair boundary without a lone surrogate', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    const result = controller.renamePasskey(requestFor(), 'credential-1', straddlingLabel);

    expect(result.passkey.customLabel).toBe('d'.repeat(119));
    expect(result.passkey.customLabel.isWellFormed()).toBe(true);
    expect(Buffer.from(result.passkey.customLabel, 'utf8').toString('utf8')).toBe(result.passkey.customLabel);
    expect(readStoredPasskey(storeFile).customLabel).toBe('d'.repeat(119));
    // JSON persists a lone high surrogate as the \ud83d escape; none may survive.
    expect(fs.readFileSync(storeFile, 'utf8')).not.toContain('\\ud83d');
  });

  it('still cuts an ASCII label at exactly 120 characters', () => {
    const storeFile = createStoreFile([passkey()]);
    const controller = createController(storeFile);

    const result = controller.renamePasskey(requestFor(), 'credential-1', 'a'.repeat(130));

    expect(result.passkey.customLabel).toBe('a'.repeat(120));
    expect(result.passkey.customLabel.length).toBe(120);
  });

  it('caps a registration label at the surrogate pair boundary', async () => {
    const storeFile = createStoreFile([]);
    const controller = createController(storeFile);

    const { requestId } = await controller.beginRegistration(requestFor(), { label: straddlingLabel });
    await controller.finishRegistration({
      requestId,
      response: { id: 'credential-registered' },
    });

    const stored = readStoredPasskey(storeFile);
    expect(stored.label).toBe('d'.repeat(119));
    expect(stored.label.isWellFormed()).toBe(true);
    expect(fs.readFileSync(storeFile, 'utf8')).not.toContain('\\ud83d');
  });

  it('applies the pair-safe clamp when re-normalizing a stored label on read', () => {
    // Older/other writers could leave 121+ units with the pair straddling 120.
    const storeFile = createStoreFile([passkey({ label: `${'d'.repeat(119)}\uD83Dx` })]);
    const [listed] = createController(storeFile).listPasskeys(requestFor());

    expect(listed.label).toBe('d'.repeat(119));
    expect(listed.label.isWellFormed()).toBe(true);
  });
});
