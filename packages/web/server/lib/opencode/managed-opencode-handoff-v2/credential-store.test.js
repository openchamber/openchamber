import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from '../../guardian/windows-acl.js';
import { snapshotFileIdentity, sameFileIdentity } from '../../guardian/file-identity.js';
import {
  createManagedOpenCodeCredentialStore,
  MANAGED_OPENCODE_CREDENTIAL_DIRECTORY,
  MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX,
  MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
  MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE,
} from './credential-store.js';
import { createManagedOpenCodeHandoffV2SecretProvider } from './secret-provider.js';

const roots = [];
const noFollow = fs.constants.O_NOFOLLOW ?? 0;

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-managed-credential-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
};

const createIncarnation = () => randomBytes(32).toString('base64url');

const createDescriptor = (incarnation = createIncarnation()) => ({
  incarnation,
  ownerInstanceId: 'owner-instance',
  runtimeIdentity: 'runtime-identity',
  launchFingerprint: 'launch-fingerprint',
  credentialFingerprint: randomBytes(32).toString('base64url'),
});

const fixtureProcessIdentity = {
  processStartTicks: '123456789',
  launch: { commandLine: 'node credential-store.test.js', cwd: '/tmp/credential-store-test' },
  owner: 'credential-store-test',
};

const createStore = (options = {}) => createManagedOpenCodeCredentialStore({
  username: 'alice',
  aclInspector: () => ({ entries: [{ principal: 'alice', rights: ['F'] }] }),
  processIdentity: () => fixtureProcessIdentity,
  ...options,
});

const createFixture = () => {
  const root = createRoot();
  const secretProvider = createManagedOpenCodeHandoffV2SecretProvider({
    rootDir: root,
    username: 'alice',
    aclInspector: () => ({ entries: [{ principal: 'alice', rights: ['F'] }] }),
  });
  const store = createStore({
    rootDir: root,
    secretProvider,
  });
  return { root, secretProvider, store };
};

const filePathFor = (root, incarnation) => path.join(
  root,
  MANAGED_OPENCODE_CREDENTIAL_DIRECTORY,
  `${incarnation}${MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX}`,
);

const lockPathFor = (root, incarnation) => `${filePathFor(root, incarnation)}.lock`;

const createLockOwner = ({ pid, identity, token = randomBytes(32).toString('base64url') }) => ({
  version: 1,
  pid,
  processStartTicks: identity.processStartTicks,
  identity,
  token,
});

beforeEach(() => {
  if (process.platform === 'win32') {
    vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
    vi.spyOn(windowsAcl, 'applyPrivateFileAcl').mockReturnValue({ ok: true, username: 'alice' });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe('managed OpenCode credential store', () => {
  it('round-trips credentials without writing plaintext at rest', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    const credential = { username: 'opencode-user', password: 'managed-password-123' };

    await expect(store.create({ ...descriptor, ...credential })).resolves.toEqual({ created: true });
    const file = filePathFor(root, descriptor.incarnation);
    const bytes = fs.readFileSync(file);
    expect(bytes.includes(Buffer.from(credential.username))).toBe(false);
    expect(bytes.includes(Buffer.from(credential.password))).toBe(false);
    expect(bytes.includes(Buffer.from(JSON.stringify(credential)))).toBe(false);
    await expect(store.read(descriptor)).resolves.toEqual(credential);
    secretProvider.dispose();
  });

  it.skipIf(noFollow === 0)('retries credential reads without O_NOFOLLOW only after EINVAL', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    await store.create({ ...descriptor, password: 'fallback-credential-password' });
    const file = filePathFor(root, descriptor.incarnation);
    const realOpenSync = fs.openSync.bind(fs);
    let fallbackAttempted = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
      if (target === file && typeof flags === 'number' && (flags & noFollow) !== 0) {
        fallbackAttempted = true;
        throw Object.assign(new Error('O_NOFOLLOW is unsupported'), { code: 'EINVAL' });
      }
      return realOpenSync(target, flags, ...args);
    });

    try {
      await expect(store.read(descriptor)).resolves.toEqual({
        username: 'opencode',
        password: 'fallback-credential-password',
      });
      expect(fallbackAttempted).toBe(true);
    } finally {
      openSpy.mockRestore();
      secretProvider.dispose();
    }
  });

  it('does not retry an ordinary credential read open error', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    await store.create({ ...descriptor, password: 'ordinary-open-error-password' });
    const file = filePathFor(root, descriptor.incarnation);
    const realOpenSync = fs.openSync.bind(fs);
    let credentialOpenAttempts = 0;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
      if (target === file && typeof flags === 'number') {
        credentialOpenAttempts += 1;
        throw Object.assign(new Error('credential open denied'), { code: 'EACCES' });
      }
      return realOpenSync(target, flags, ...args);
    });

    try {
      await expect(store.read(descriptor)).rejects.toMatchObject({ code: 'EACCES' });
      expect(credentialOpenAttempts).toBe(1);
    } finally {
      openSpy.mockRestore();
      secretProvider.dispose();
    }
  });

  it('publishes an authenticated process-owner lock before credential work begins', async () => {
    const root = createRoot();
    let releaseKey;
    let resolveKeyStarted;
    const keyStarted = new Promise((resolve) => { resolveKeyStarted = resolve; });
    const secretProvider = {
      deriveCredentialEncryptionKey: vi.fn(async () => {
        resolveKeyStarted();
        await new Promise((resolve) => { releaseKey = resolve; });
        return Buffer.alloc(32, 4);
      }),
    };
    const store = createStore({ rootDir: root, secretProvider });
    const descriptor = createDescriptor();
    const password = 'lock-owner-test-password';
    const creation = store.create({ ...descriptor, password });

    await keyStarted;
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    expect(lock).toMatchObject({
      version: 1,
      pid: process.pid,
      processStartTicks: expect.any(String),
      identity: expect.objectContaining({ processStartTicks: expect.any(String) }),
      token: expect.any(String),
    });
    expect(fs.readFileSync(lockPath, 'utf8')).not.toContain(password);

    releaseKey();
    await expect(creation).resolves.toEqual({ created: true });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('does not publish an empty lock when process identity acquisition fails', async () => {
    const root = createRoot();
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const store = createStore({
      rootDir: root,
      secretProvider: { deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 12) },
      processIdentity: () => {
        throw new Error('process identity probe failed');
      },
    });

    await expect(store.create({ ...descriptor, password: 'identity-failure-password' }))
      .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readdirSync(path.dirname(lockPath))).not.toContain(path.basename(lockPath));
  });

  it('converges on retry after process identity acquisition becomes available', async () => {
    const root = createRoot();
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const identity = fixtureProcessIdentity;
    let available = false;
    const store = createStore({
      rootDir: root,
      secretProvider: { deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 13) },
      processIdentity: () => (available ? identity : null),
    });

    await expect(store.create({ ...descriptor, password: 'identity-retry-password' }))
      .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    expect(fs.existsSync(lockPath)).toBe(false);

    available = true;
    await expect(store.create({ ...descriptor, password: 'identity-retry-password' }))
      .resolves.toEqual({ created: true });
    expect(fs.existsSync(lockPath)).toBe(false);
    await expect(store.read(descriptor)).resolves.toEqual({
      username: 'opencode',
      password: 'identity-retry-password',
    });
  });

  it('reclaims a valid lock after its recorded owner has crashed', async () => {
    const root = createRoot();
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const secretProvider = { deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 5) };
    const store = createStore({
      rootDir: root,
      secretProvider,
      processLiveness: (pid) => pid === 987654 ? 'dead' : 'alive',
      processIdentity: () => ({ processStartTicks: '987657' }),
    });
    const staleIdentity = {
      processStartTicks: '987654',
      launch: { commandLine: 'node crashed-operation.js', cwd: root },
      owner: '1000',
    };
    fs.writeFileSync(lockPath, JSON.stringify(createLockOwner({ pid: 987654, identity: staleIdentity })), {
      mode: 0o600,
    });

    await expect(store.create({ ...descriptor, password: 'after-crash-password' }))
      .resolves.toEqual({ created: true });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('reclaims a PID-reused lock only after an authoritative identity mismatch', async () => {
    const root = createRoot();
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const store = createStore({
      rootDir: root,
      secretProvider: { deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 6) },
      processLiveness: () => 'alive',
      processIdentity: () => ({ processStartTicks: '987656' }),
    });
    const oldIdentity = { processStartTicks: '987655' };
    fs.writeFileSync(lockPath, JSON.stringify(createLockOwner({ pid: 4321, identity: oldIdentity })), {
      mode: 0o600,
    });
    await expect(store.create({ ...descriptor, password: 'after-pid-reuse-password' }))
      .resolves.toEqual({ created: true });
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('converges after a transient lock cleanup failure on the next authenticated operation', async () => {
    const { root, store } = createFixture();
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const lockQuarantinePath = `${lockPath}.remove`;
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    let injected = false;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (target === lockQuarantinePath && !injected) {
        injected = true;
        throw Object.assign(new Error('transient lock cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      await expect(store.create({ ...descriptor, password: 'transient-lock-password' }))
        .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    } finally {
      unlinkSpy.mockRestore();
    }

    // The identity/token retained by the failed release authorizes the next
    // operation to remove only the restored original lock.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(fs.existsSync(lockQuarantinePath)).toBe(false);
    await expect(store.remove(descriptor)).resolves.toEqual({ removed: true });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(lockQuarantinePath)).toBe(false);
  });

  it('removes only its own quarantine when a cross-store replacement lock wins the gap', async () => {
    const root = createRoot();
    const secretProvider = {
      deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 10),
    };
    const first = createStore({ rootDir: root, secretProvider });
    const currentIdentity = fixtureProcessIdentity;
    const replacementPid = 987654;
    const replacementIdentity = {
      processStartTicks: '987654',
      launch: { commandLine: 'node replacement-operation.js', cwd: root },
    };
    const replacementOwner = createLockOwner({
      pid: replacementPid,
      identity: replacementIdentity,
      token: randomBytes(32).toString('base64url'),
    });
    let replacementAlive = true;
    const second = createStore({
      rootDir: root,
      secretProvider,
      processLiveness: (pid) => pid === replacementPid
        ? (replacementAlive ? 'alive' : 'dead')
        : 'alive',
      processIdentity: (pid) => pid === replacementPid ? replacementIdentity : currentIdentity,
    });
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const lockQuarantinePath = `${lockPath}.remove`;
    const realRenameSync = fs.renameSync.bind(fs);
    let raced = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      const result = realRenameSync(source, destination);
      if (source === lockPath && destination === lockQuarantinePath && !raced) {
        raced = true;
        fs.writeFileSync(lockPath, JSON.stringify(replacementOwner), { mode: 0o600 });
      }
      return result;
    });

    try {
      await expect(first.create({ ...descriptor, password: 'replacement-race-password' }))
        .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    } finally {
      renameSpy.mockRestore();
    }

    expect(fs.readFileSync(lockPath, 'utf8')).toBe(JSON.stringify(replacementOwner));
    expect(fs.existsSync(lockQuarantinePath)).toBe(true);

    // The original current process may reclaim its own hidden artifact, but
    // it must not remove the replacement live fence.
    await expect(second.remove(descriptor)).rejects.toMatchObject({
      code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
    });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(JSON.stringify(replacementOwner));
    expect(fs.existsSync(lockQuarantinePath)).toBe(false);

    // Once the replacement owner is authoritatively stale, the same
    // authenticated operation can recover it and finish cleanup.
    replacementAlive = false;
    await expect(second.remove(descriptor)).resolves.toEqual({ removed: true });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(lockQuarantinePath)).toBe(false);
  });

  it('does not reclaim a live foreign lock quarantine', async () => {
    const root = createRoot();
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const lockQuarantinePath = `${lockPath}.remove`;
    const foreignPid = 987653;
    const foreignIdentity = {
      processStartTicks: '987653',
      launch: { commandLine: 'node foreign-operation.js', cwd: root },
    };
    const store = createStore({
      rootDir: root,
      secretProvider: { deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 11) },
      processLiveness: (pid) => pid === foreignPid ? 'alive' : 'dead',
      processIdentity: (pid) => pid === foreignPid ? foreignIdentity : null,
    });
    fs.writeFileSync(lockQuarantinePath, JSON.stringify(createLockOwner({
      pid: foreignPid,
      identity: foreignIdentity,
    })), { mode: 0o600 });

    await expect(store.create({ ...descriptor, password: 'foreign-quarantine-password' }))
      .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(lockQuarantinePath)).toBe(true);
  });

  it.each([
    ['malformed', 'not-json'],
    ['ambiguous', JSON.stringify({ version: 1, pid: 4322, token: 'ambiguous' })],
  ])('fails closed for a %s existing operation lock', async (_label, body) => {
    const root = createRoot();
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const store = createStore({
      rootDir: root,
      secretProvider: { deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 7) },
      processLiveness: () => 'unknown',
      processIdentity: () => null,
    });
    fs.writeFileSync(lockPath, body, { mode: 0o600 });

    await expect(store.create({ ...descriptor, password: 'must-not-run' }))
      .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(body);
  });

  it('fails closed for a live matching lock instead of reclaiming another operation', async () => {
    const root = createRoot();
    const descriptor = createDescriptor();
    const lockPath = lockPathFor(root, descriptor.incarnation);
    const identity = fixtureProcessIdentity;
    const body = JSON.stringify(createLockOwner({ pid: process.pid, identity }));
    const store = createStore({
      rootDir: root,
      secretProvider: { deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 8) },
      processLiveness: () => 'alive',
      processIdentity: () => identity,
    });
    fs.writeFileSync(lockPath, body, { mode: 0o600 });

    await expect(store.create({ ...descriptor, password: 'must-not-run' }))
      .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(body);
  });

  it('defaults the username only when the caller omits it', async () => {
    const { secretProvider, store } = createFixture();
    const descriptor = createDescriptor();

    await store.create({ ...descriptor, password: 'managed-password' });
    await expect(store.read(descriptor)).resolves.toEqual({
      username: 'opencode',
      password: 'managed-password',
    });
    secretProvider.dispose();
  });

  it.each([
    ['wrong incarnation', (descriptor) => ({ ...descriptor, incarnation: createIncarnation() })],
    ['wrong owner', (descriptor) => ({ ...descriptor, ownerInstanceId: 'other-owner' })],
    ['wrong runtime', (descriptor) => ({ ...descriptor, runtimeIdentity: 'other-runtime' })],
    ['wrong launch fingerprint', (descriptor) => ({ ...descriptor, launchFingerprint: 'other-launch' })],
    ['wrong credential fingerprint', (descriptor) => ({
      ...descriptor,
      credentialFingerprint: randomBytes(32).toString('base64url'),
    })],
  ])('rejects %s without returning the credential', async (_label, alter) => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    await store.create({ ...descriptor, password: 'managed-password' });

    const altered = alter(descriptor);
    if (altered.incarnation !== descriptor.incarnation) {
      fs.copyFileSync(
        filePathFor(root, descriptor.incarnation),
        filePathFor(root, altered.incarnation),
      );
    }
    await expect(store.read(altered)).rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    secretProvider.dispose();
  });

  it('rejects tampering, missing state, and malformed state fail closed', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    await store.create({ ...descriptor, password: 'managed-password' });
    const file = filePathFor(root, descriptor.incarnation);

    const tampered = fs.readFileSync(file);
    tampered[tampered.length - 1] ^= 0xff;
    fs.writeFileSync(file, tampered, { mode: 0o600 });
    await expect(store.read(descriptor)).rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });

    fs.unlinkSync(file);
    await expect(store.read(descriptor)).rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE });

    fs.writeFileSync(file, Buffer.from('not-a-credential-record'), { mode: 0o600 });
    await expect(store.read(descriptor)).rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    secretProvider.dispose();
  });

  it.skipIf(process.platform === 'win32')('publishes one private opaque file atomically', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    const linkSpy = vi.spyOn(fs, 'linkSync');

    await store.create({ ...descriptor, password: 'managed-password' });
    const directory = path.join(root, MANAGED_OPENCODE_CREDENTIAL_DIRECTORY);
    const file = filePathFor(root, descriptor.incarnation);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(linkSpy).toHaveBeenCalled();
    expect(fs.readdirSync(directory)).toEqual([
      `${descriptor.incarnation}${MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX}`,
    ]);
    secretProvider.dispose();
  });

  it('removes only an authenticated record and confirms durable absence', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    await store.create({ ...descriptor, password: 'managed-password' });
    const file = filePathFor(root, descriptor.incarnation);

    await expect(store.remove({ ...descriptor, ownerInstanceId: 'wrong-owner' }))
      .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    expect(fs.existsSync(file)).toBe(true);

    await expect(store.remove(descriptor)).resolves.toEqual({ removed: true });
    expect(fs.existsSync(file)).toBe(false);
    await expect(store.remove(descriptor)).resolves.toEqual({ removed: false });
    secretProvider.dispose();
  });

  it('does not leave temporary files when a duplicate create loses the publish race', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    const credential = { username: 'opencode-user', password: 'managed-password' };

    await store.create({ ...descriptor, ...credential });
    await expect(store.create({ ...descriptor, ...credential }))
      .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
    expect(fs.readdirSync(path.join(root, MANAGED_OPENCODE_CREDENTIAL_DIRECTORY)))
      .toEqual([`${descriptor.incarnation}${MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX}`]);
    secretProvider.dispose();
  });

  it('serializes publication before removal for one incarnation', async () => {
    const root = createRoot();
    let resolveKey;
    const keyStarted = new Promise((resolve) => {
      resolveKey = resolve;
    });
    let deriveCalls = 0;
    const secretProvider = {
      deriveCredentialEncryptionKey: vi.fn(async () => {
        deriveCalls += 1;
        if (deriveCalls === 1) {
          resolveKey();
          await new Promise((resolve) => { setTimeout(resolve, 0); });
        }
        return Buffer.alloc(32, 9);
      }),
    };
    const store = createStore({ rootDir: root, secretProvider });
    const descriptor = createDescriptor();
    const file = filePathFor(root, descriptor.incarnation);

    const publication = store.create({ ...descriptor, password: 'publication-password' });
    await keyStarted;
    const removal = store.remove(descriptor);
    await new Promise((resolve) => setImmediate(resolve));
    expect(fs.existsSync(file)).toBe(false);

    await expect(publication).resolves.toEqual({ created: true });
    await expect(removal).resolves.toEqual({ removed: true });
    expect(fs.existsSync(file)).toBe(false);
    await expect(store.remove(descriptor)).resolves.toEqual({ removed: false });
  });

  it('fences removal when the credential path is replaced after its authenticated read', async () => {
    const root = createRoot();
    const secretProvider = {
      deriveCredentialEncryptionKey: async () => Buffer.alloc(32, 7),
    };
    const store = createStore({ rootDir: root, secretProvider });
    const descriptor = createDescriptor();
    await store.create({ ...descriptor, password: 'original-password' });
    const file = filePathFor(root, descriptor.incarnation);
    const original = fs.readFileSync(file);
    const originalStat = fs.lstatSync(file);
    const originalIdentity = snapshotFileIdentity(originalStat);
    expect(originalIdentity).not.toBeNull();
    let replacementStat;
    let replaced = false;
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      target === file && replaced ? replacementStat : realLstatSync(target, ...args)
    ));
    const deriveCredentialEncryptionKey = secretProvider.deriveCredentialEncryptionKey;
    let deriveCalls = 0;
    secretProvider.deriveCredentialEncryptionKey = async (input) => {
      deriveCalls += 1;
      if (deriveCalls === 1) {
        fs.unlinkSync(file);
        fs.writeFileSync(file, original, { mode: 0o600 });
        replacementStat = realLstatSync(file);
        Object.assign(replacementStat, {
          dev: originalStat.dev,
          ino: originalStat.ino,
          birthtimeMs: (originalStat.birthtimeMs ?? 0) + 1,
          ctimeMs: (originalStat.ctimeMs ?? 0) + 1,
        });
        replaced = true;
        expect(sameFileIdentity(originalIdentity, replacementStat)).toBe(false);
      }
      return deriveCredentialEncryptionKey(input);
    };

    try {
      await expect(store.remove(descriptor)).rejects.toMatchObject({
        code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      });
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
    await expect(store.read(descriptor)).resolves.toEqual({
      username: 'opencode',
      password: 'original-password',
    });
  });

  it('retains credential recovery state when quarantine cleanup fails, then retries safely', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    await store.create({ ...descriptor, password: 'cleanup-failure-password' });
    const file = filePathFor(root, descriptor.incarnation);
    const recoveryPath = `${file}.remove`;
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (target === recoveryPath) {
        throw Object.assign(new Error('credential quarantine cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      await expect(store.remove(descriptor)).rejects.toMatchObject({
        code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      });
      expect(fs.existsSync(file)).toBe(true);
      expect(fs.existsSync(recoveryPath)).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
    }

    await expect(store.remove(descriptor)).resolves.toEqual({ removed: true });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(recoveryPath)).toBe(false);
    secretProvider.dispose();
  });

  it('retains and later removes a temporary publication recovery artifact', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    const file = filePathFor(root, descriptor.incarnation);
    const prefix = `.${path.basename(file)}.`;
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (
        typeof target === 'string'
        && path.basename(target).startsWith(prefix)
        && target.endsWith('.remove')
      ) {
        throw Object.assign(new Error('temporary quarantine cleanup denied'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });

    try {
      await expect(store.create({ ...descriptor, password: 'temporary-cleanup-password' }))
        .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
      const recoveryNames = fs.readdirSync(path.join(root, MANAGED_OPENCODE_CREDENTIAL_DIRECTORY))
        .filter((name) => name.startsWith(prefix));
      expect(recoveryNames.some((name) => name.endsWith('.remove'))).toBe(true);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
    }

    await expect(store.remove(descriptor)).resolves.toEqual({ removed: true });
    expect(fs.readdirSync(path.join(root, MANAGED_OPENCODE_CREDENTIAL_DIRECTORY))).toEqual([]);
    secretProvider.dispose();
  });

  it.skipIf(process.platform === 'win32')('verifies absence again after removal directory fsync', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    await store.create({ ...descriptor, password: 'durable-removal-password' });
    const file = filePathFor(root, descriptor.incarnation);
    const fsyncSync = fs.fsyncSync.bind(fs);
    let replacementPublished = false;
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
      const stat = fs.fstatSync(fileDescriptor);
      if (stat.isDirectory() && !replacementPublished) {
        replacementPublished = true;
        fs.writeFileSync(file, 'replacement-after-fsync', { mode: 0o600 });
      }
      return fsyncSync(fileDescriptor);
    });

    try {
      await expect(store.remove(descriptor)).rejects.toMatchObject({
        code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      });
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      fsyncSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('recovers a transient post-link directory fsync failure idempotently', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    const warmupKey = await secretProvider.deriveCredentialEncryptionKey({ incarnation: descriptor.incarnation });
    warmupKey.fill(0);
    const failure = Object.assign(new Error('post-link fsync failed'), { code: 'EIO' });
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directoryFailures = 1;
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
      if (fs.fstatSync(fileDescriptor).isDirectory() && directoryFailures > 0) {
        directoryFailures -= 1;
        throw failure;
      }
      return fsyncSync(fileDescriptor);
    });

    try {
      await expect(store.create({ ...descriptor, password: 'managed-password' }))
        .resolves.toEqual({ created: true });
      expect(fs.readdirSync(path.join(root, MANAGED_OPENCODE_CREDENTIAL_DIRECTORY)))
        .toEqual([`${descriptor.incarnation}${MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX}`]);
      await expect(store.read(descriptor)).resolves.toEqual({
        username: 'opencode',
        password: 'managed-password',
      });
    } finally {
      fsyncSpy.mockRestore();
      secretProvider.dispose();
    }
  });

  it.skipIf(process.platform === 'win32')('does not report created when the target is replaced after the durability retry fence', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    const file = filePathFor(root, descriptor.incarnation);
    const warmupKey = await secretProvider.deriveCredentialEncryptionKey({ incarnation: descriptor.incarnation });
    warmupKey.fill(0);
    const failure = Object.assign(new Error('post-link fsync failed'), { code: 'EIO' });
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directoryFailures = 1;
    let replaced = false;
    let replacementStat;
    const realLstatSync = fs.lstatSync.bind(fs);
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => (
      target === file && replacementStat ? replacementStat : realLstatSync(target, ...args)
    ));
    const replacement = Buffer.from('replacement-after-publication-fence');
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
      const stat = fs.fstatSync(fileDescriptor);
      if (stat.isDirectory() && directoryFailures > 0) {
        directoryFailures -= 1;
        throw failure;
      }
      const result = fsyncSync(fileDescriptor);
      if (stat.isDirectory() && !replaced) {
        const originalStat = realLstatSync(file);
        replaced = true;
        fs.unlinkSync(file);
        fs.writeFileSync(file, replacement, { mode: 0o600 });
        replacementStat = realLstatSync(file);
        Object.assign(replacementStat, {
          dev: originalStat.dev,
          ino: originalStat.ino,
          birthtimeMs: (originalStat.birthtimeMs ?? 0) + 1,
          ctimeMs: (originalStat.ctimeMs ?? 0) + 1,
        });
        expect(sameFileIdentity(originalStat, replacementStat)).toBe(false);
      }
      return result;
    });

    try {
      await expect(store.create({ ...descriptor, password: 'managed-password' }))
        .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
      expect(fs.readFileSync(file)).toEqual(replacement);
    } finally {
      fsyncSpy.mockRestore();
      lstatSpy.mockRestore();
      secretProvider.dispose();
    }
  });

  it.skipIf(process.platform === 'win32')('allows authenticated cleanup after a persistent post-link fsync failure', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    const warmupKey = await secretProvider.deriveCredentialEncryptionKey({ incarnation: descriptor.incarnation });
    warmupKey.fill(0);
    const failure = Object.assign(new Error('post-link fsync failed'), { code: 'EIO' });
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directoryFailures = 2;
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
      if (fs.fstatSync(fileDescriptor).isDirectory() && directoryFailures > 0) {
        directoryFailures -= 1;
        throw failure;
      }
      return fsyncSync(fileDescriptor);
    });

    try {
      await expect(store.create({ ...descriptor, password: 'managed-password' }))
        .rejects.toMatchObject({ code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE });
      expect(fs.existsSync(filePathFor(root, descriptor.incarnation))).toBe(true);
    } finally {
      fsyncSpy.mockRestore();
    }

    await expect(store.remove(descriptor)).resolves.toEqual({ removed: true });
    expect(fs.existsSync(filePathFor(root, descriptor.incarnation))).toBe(false);
    secretProvider.dispose();
  });

  it('fences a cross-store removal while credential publication is in progress', async () => {
    const root = createRoot();
    let releaseKey;
    let resolveKeyStarted;
    let derivationCount = 0;
    const keyStarted = new Promise((resolve) => { resolveKeyStarted = resolve; });
    const secretProvider = {
      deriveCredentialEncryptionKey: vi.fn(async () => {
        if (derivationCount++ === 0) {
          resolveKeyStarted();
          await new Promise((resolve) => { releaseKey = resolve; });
        }
        return Buffer.alloc(32, 8);
      }),
    };
    const first = createStore({ rootDir: root, secretProvider });
    const second = createStore({ rootDir: root, secretProvider });
    const descriptor = createDescriptor();

    const publication = first.create({ ...descriptor, password: 'fenced-publication-password' });
    await keyStarted;
    const competingRemoval = second.remove(descriptor);
    await expect(competingRemoval).rejects.toMatchObject({
      code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
    });

    releaseKey();
    await expect(publication).resolves.toEqual({ created: true });
    await expect(first.read(descriptor)).resolves.toEqual({
      username: 'opencode',
      password: 'fenced-publication-password',
    });
  });

  it.skipIf(process.platform === 'win32')('serializes removal behind a post-link publication fsync failure', async () => {
    const { root, secretProvider, store } = createFixture();
    const descriptor = createDescriptor();
    const warmupKey = await secretProvider.deriveCredentialEncryptionKey({ incarnation: descriptor.incarnation });
    warmupKey.fill(0);
    const failure = Object.assign(new Error('post-link fsync failed'), { code: 'EIO' });
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directoryFailures = 2;
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
      if (fs.fstatSync(fileDescriptor).isDirectory() && directoryFailures > 0) {
        directoryFailures -= 1;
        throw failure;
      }
      return fsyncSync(fileDescriptor);
    });

    try {
      const publication = store.create({ ...descriptor, password: 'publication-before-remove' });
      const removal = store.remove(descriptor);
      await expect(publication).rejects.toMatchObject({
        code: MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      });
      await expect(removal).resolves.toEqual({ removed: true });
      expect(fs.existsSync(filePathFor(root, descriptor.incarnation))).toBe(false);
    } finally {
      fsyncSpy.mockRestore();
      secretProvider.dispose();
    }
  });

  it('zeroes every derived encryption key buffer after use', async () => {
    const root = createRoot();
    const issuedKeys = [];
    const store = createStore({
      rootDir: root,
      secretProvider: {
        deriveCredentialEncryptionKey: async () => {
          const key = Buffer.alloc(32, 7);
          issuedKeys.push(key);
          return key;
        },
      },
    });
    const descriptor = createDescriptor();

    await store.create({ ...descriptor, password: 'managed-password' });
    await store.read(descriptor);
    expect(issuedKeys).not.toHaveLength(0);
    expect(issuedKeys.every((key) => key.every((byte) => byte === 0))).toBe(true);
  });
});
