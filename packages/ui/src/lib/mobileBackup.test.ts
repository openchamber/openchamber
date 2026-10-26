import { describe, expect, test } from 'bun:test';

import {
  MOBILE_BACKUP_FORMAT,
  MOBILE_BACKUP_ITERATIONS,
  MOBILE_BACKUP_VERSION,
  MobileBackupError,
  decryptMobileBackup,
  encryptMobileBackup,
  parseMobileBackupFile,
  serializeMobileBackup,
} from './mobileBackup';

// Real KDF work is the point of one test; the rest use the smallest allowed
// count so the suite stays quick.
const FAST_ITERATIONS = 10_000;

const payload = {
  connections: [
    {
      label: 'Home server',
      candidates: [{ kind: 'direct', url: 'http://192.168.1.10:2606' }],
      lastUsedAt: 1_700_000_000_000,
      clientToken: 'oc_client_secret',
    },
    {
      label: 'Ünïcode – schöne Grüße',
      candidates: [{ kind: 'relay', relay: { relayUrl: 'wss://relay.example', serverId: 'srv_1', hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } } }],
      lastUsedAt: 0,
    },
  ],
};

const expectCode = async (operation: Promise<unknown>, code: MobileBackupError['code']) => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(MobileBackupError);
    expect((error as MobileBackupError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
};

describe('mobile backup envelope', () => {
  test('round-trips a payload with the real KDF settings', async () => {
    const file = await encryptMobileBackup(payload, 'correct horse battery');
    expect(file.format).toBe(MOBILE_BACKUP_FORMAT);
    expect(file.version).toBe(MOBILE_BACKUP_VERSION);
    expect(file.kdf.iterations).toBe(MOBILE_BACKUP_ITERATIONS);

    // The file is JSON text, and no plaintext leaks into it.
    const serialized = serializeMobileBackup(file);
    expect(serialized).not.toContain('oc_client_secret');
    expect(serialized).not.toContain('Home server');

    const restored = await decryptMobileBackup(serialized, 'correct horse battery');
    expect(restored).toEqual(payload);
  });

  test('rejects a wrong password', async () => {
    const file = await encryptMobileBackup(payload, 'right password', { iterations: FAST_ITERATIONS });
    await expectCode(decryptMobileBackup(serializeMobileBackup(file), 'wrong password'), 'wrong-password');
  });

  test('rejects a payload that was edited after encryption', async () => {
    const file = await encryptMobileBackup(payload, 'password', { iterations: FAST_ITERATIONS });
    const bytes = atob(file.data).split('');
    bytes[0] = String.fromCharCode(bytes[0].charCodeAt(0) ^ 0xff);
    const tampered = { ...file, data: btoa(bytes.join('')) };
    await expectCode(decryptMobileBackup(tampered, 'password'), 'wrong-password');
  });

  test('rejects text that is not a backup file', async () => {
    await expectCode(decryptMobileBackup('not json', 'password'), 'invalid-file');
    await expectCode(decryptMobileBackup({ hello: 'world' }, 'password'), 'invalid-file');
    await expectCode(decryptMobileBackup('{"format":"something.else"}', 'password'), 'invalid-file');
  });

  test('reports a file from a newer version separately', async () => {
    const file = await encryptMobileBackup(payload, 'password', { iterations: FAST_ITERATIONS });
    await expectCode(decryptMobileBackup({ ...file, version: MOBILE_BACKUP_VERSION + 1 }, 'password'), 'unsupported-version');
  });

  test('bounds the KDF work an imported file can ask for', () => {
    const base = {
      format: MOBILE_BACKUP_FORMAT,
      version: MOBILE_BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 1_000_000_000, salt: btoa('x'.repeat(16)) },
      cipher: { name: 'AES-GCM', iv: btoa('i'.repeat(12)) },
      data: btoa('ciphertext'),
    };
    expect(() => parseMobileBackupFile(base)).toThrow(MobileBackupError);
    expect(() => parseMobileBackupFile({ ...base, kdf: { ...base.kdf, iterations: 1 } })).toThrow(MobileBackupError);
  });

  test('requires the salt and IV lengths the ciphers expect', async () => {
    const file = await encryptMobileBackup(payload, 'password', { iterations: FAST_ITERATIONS });
    expect(() => parseMobileBackupFile({ ...file, kdf: { ...file.kdf, salt: btoa('short') } })).toThrow(MobileBackupError);
    expect(() => parseMobileBackupFile({ ...file, cipher: { name: 'AES-GCM', iv: btoa('short') } })).toThrow(MobileBackupError);
  });

  test('refuses an empty password rather than producing an open file', async () => {
    await expectCode(encryptMobileBackup(payload, ''), 'invalid-password');
    const file = await encryptMobileBackup(payload, 'password', { iterations: FAST_ITERATIONS });
    await expectCode(decryptMobileBackup(file, ''), 'invalid-password');
  });
});
