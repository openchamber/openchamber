import { createHmac, createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as windowsAcl from '../../guardian/windows-acl.js';
import {
  MANAGED_OPENCODE_HANDOFF_V2_INITIALIZATION_EVIDENCE_FILENAME,
  MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME,
  createManagedOpenCodeHandoffV2SecretProvider,
} from './secret-provider.js';
import { fsyncDirectory } from './filesystem.js';

const roots = [];
const noFollow = fs.constants.O_NOFOLLOW ?? 0;

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-v2-secret-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
};

const createIncarnation = () => randomBytes(32).toString('base64url');
const createProvider = (root, options = {}) =>
  createManagedOpenCodeHandoffV2SecretProvider({
    rootDir: root,
    // General provider tests exercise secret lifecycle semantics, not the
    // platform ACL implementation. Windows ACL coverage is explicit below
    // and supplies its own mocked ACL seam.
    platform: 'linux',
    username: 'alice',
    aclInspector: () => ({ entries: [{ principal: 'alice', rights: ['F'] }] }),
    ...options,
  });

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    fs.rmSync(roots.pop(), { recursive: true, force: true });
  }
});

describe('managed OpenCode handoff v2 secret provider', () => {
  it('uses the Windows ACL branch without POSIX mode checks or directory fsync', async () => {
    const root = createRoot();
    const aclSpy = vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
    const fsyncSync = fs.fsyncSync.bind(fs);
    const directoryFsyncs = [];
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      const isDirectory = fs.fstatSync(descriptor).isDirectory();
      directoryFsyncs.push(isDirectory);
      if (isDirectory) {
        throw new Error('directory fsync is not available on Windows');
      }
      return fsyncSync(descriptor);
    });
    const provider = createProvider(root, { platform: 'win32' });
    const incarnation = createIncarnation();
    const key = await provider.deriveRecordMacKey({ incarnation });

    expect(key).toHaveLength(32);
    expect(aclSpy).toHaveBeenCalled();
    expect(fsyncSpy).toHaveBeenCalled();
    expect(directoryFsyncs).toEqual(expect.arrayContaining([false]));
    expect(directoryFsyncs).not.toContain(true);

    key.fill(0);
    provider.dispose();
  });

  it('does not treat missing initialized Windows state as a fresh initialization', async () => {
    const root = createRoot();
    vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
    const incarnation = createIncarnation();
    const initialized = createProvider(root, { platform: 'win32' });
    const key = await initialized.deriveRecordMacKey({ incarnation });
    key.fill(0);
    initialized.dispose();

    fs.unlinkSync(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME));
    const missing = createProvider(root, { platform: 'win32', initializationWaitAttempts: 1 });
    await expect(missing.deriveRecordMacKey({ incarnation }))
      .rejects.toThrow(/missing after initialization evidence/);
    missing.dispose();
  });

  it('does not treat corrupt initialized Windows state as absent', async () => {
    const root = createRoot();
    vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
    const initialized = createProvider(root, { platform: 'win32' });
    const key = await initialized.deriveRecordMacKey({ incarnation: createIncarnation() });
    key.fill(0);
    initialized.dispose();

    fs.writeFileSync(
      path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME),
      Buffer.alloc(31, 1),
    );
    const corrupt = createProvider(root, { platform: 'win32', initializationWaitAttempts: 1 });
    await expect(corrupt.deriveRecordMacKey({ incarnation: createIncarnation() }))
      .rejects.toThrow(/invalid length/);
    corrupt.dispose();
  });

  it('uses the Windows ACL trust boundary for existing files instead of POSIX mode bits', async () => {
    const root = createRoot();
    vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
    const incarnation = createIncarnation();
    const initialized = createProvider(root, { platform: 'win32' });
    const firstKey = await initialized.deriveRecordMacKey({ incarnation });
    firstKey.fill(0);
    initialized.dispose();

    fs.chmodSync(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME), 0o644);
    fs.chmodSync(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_INITIALIZATION_EVIDENCE_FILENAME), 0o644);
    const reopened = createProvider(root, { platform: 'win32' });
    const secondKey = await reopened.deriveRecordMacKey({ incarnation });
    expect(secondKey).toHaveLength(32);
    secondKey.fill(0);
    reopened.dispose();
  });

  it.skipIf(noFollow === 0)('retries master-secret reads without O_NOFOLLOW only after EINVAL', async () => {
    const root = createRoot();
    const incarnation = createIncarnation();
    const first = createProvider(root);
    const firstKey = await first.deriveRecordMacKey({ incarnation });
    firstKey.fill(0);
    first.dispose();

    const secretPath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
    const realOpenSync = fs.openSync.bind(fs);
    let fallbackAttempted = false;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
      if (target === secretPath && typeof flags === 'number' && (flags & noFollow) !== 0) {
        fallbackAttempted = true;
        throw Object.assign(new Error('O_NOFOLLOW is unsupported'), { code: 'EINVAL' });
      }
      return realOpenSync(target, flags, ...args);
    });
    const reopened = createProvider(root);

    try {
      const key = await reopened.deriveRecordMacKey({ incarnation });
      expect(key).toHaveLength(32);
      expect(fallbackAttempted).toBe(true);
      key.fill(0);
    } finally {
      openSpy.mockRestore();
      reopened.dispose();
    }
  });

  it('does not retry an ordinary master-secret open error', async () => {
    const root = createRoot();
    const incarnation = createIncarnation();
    const first = createProvider(root);
    const firstKey = await first.deriveRecordMacKey({ incarnation });
    firstKey.fill(0);
    first.dispose();

    const secretPath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
    const realOpenSync = fs.openSync.bind(fs);
    let secretOpenAttempts = 0;
    const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((target, flags, ...args) => {
      if (target === secretPath && typeof flags === 'number') {
        secretOpenAttempts += 1;
        throw Object.assign(new Error('master-secret open denied'), { code: 'EACCES' });
      }
      return realOpenSync(target, flags, ...args);
    });
    const reopened = createProvider(root);

    try {
      await expect(reopened.deriveRecordMacKey({ incarnation })).rejects.toMatchObject({ code: 'EACCES' });
      expect(secretOpenAttempts).toBe(1);
    } finally {
      openSpy.mockRestore();
      reopened.dispose();
    }
  });

  it('rejects an existing master-secret ACL that grants a broader principal', async () => {
    const root = createRoot();
    vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'alice' });
    const initialized = createProvider(root, { platform: 'win32' });
    const firstKey = await initialized.deriveRecordMacKey({ incarnation: createIncarnation() });
    firstKey.fill(0);
    initialized.dispose();

    const unsafe = createProvider(root, {
      platform: 'win32',
      aclInspector: () => ({
        entries: [
          { principal: 'alice', rights: ['F'] },
          { principal: 'Everyone', rights: ['F'] },
        ],
      }),
    });
    await expect(unsafe.deriveRecordMacKey({ incarnation: createIncarnation() }))
      .rejects.toThrow(/unapproved principal/);
    unsafe.dispose();
  });

  it.skipIf(process.platform === 'win32')('converges concurrent first creation on one private 32-byte secret', async () => {
    const root = createRoot();
    const incarnation = createIncarnation();
    const firstProvider = createProvider(root);
    const secondProvider = createProvider(root);

    const [firstKey, secondKey] = await Promise.all([
      firstProvider.deriveRecordMacKey({ incarnation }),
      secondProvider.deriveRecordMacKey({ incarnation }),
    ]);

    expect(firstKey.equals(secondKey)).toBe(true);
    const secretPath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(secretPath).size).toBe(32);

    firstKey.fill(0);
    secondKey.fill(0);
    firstProvider.dispose();
    secondProvider.dispose();
  });

  it.skipIf(process.platform === 'win32')('persists only the master and initialization evidence while retaining the raw master inside each provider closure', async () => {
    const root = createRoot();
    const incarnation = createIncarnation();
    const firstProvider = createProvider(root);
    const firstKey = await firstProvider.deriveRecordMacKey({ incarnation });
    firstProvider.dispose();

    const secondProvider = createProvider(root);
    const secondKey = await secondProvider.deriveRecordMacKey({ incarnation });

    expect(secondKey.equals(firstKey)).toBe(true);
    expect(fs.readdirSync(root).sort()).toEqual([
      MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME,
      MANAGED_OPENCODE_HANDOFF_V2_INITIALIZATION_EVIDENCE_FILENAME,
    ]);
    expect(fs.statSync(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_INITIALIZATION_EVIDENCE_FILENAME)).mode & 0o777).toBe(0o600);
    expect(Object.keys(secondProvider).sort()).toEqual([
      'deriveCredentialEncryptionKey',
      'deriveRecordMacKey',
      'dispose',
      'getLifecycleCredentialFingerprint',
      'issueLifecycleCredential',
    ]);
    firstKey.fill(0);
    secondKey.fill(0);
    secondProvider.dispose();
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked, nonregular, unsafe-mode, and malformed secret state without replacement', async () => {
    const cases = [
      ['symlink', (secretPath, root) => {
        const target = path.join(root, 'target');
        fs.writeFileSync(target, Buffer.alloc(32, 1), { mode: 0o600 });
        fs.symlinkSync(target, secretPath);
      }],
      ['nonregular', (secretPath) => fs.mkdirSync(secretPath, { mode: 0o700 })],
      ['unsafe mode', (secretPath) => {
        fs.writeFileSync(secretPath, Buffer.alloc(32, 1), { mode: 0o600 });
        fs.chmodSync(secretPath, 0o644);
      }],
      ['invalid length', (secretPath) => fs.writeFileSync(secretPath, Buffer.alloc(31, 1), { mode: 0o600 })],
    ];

    for (const [_label, setup] of cases) {
      const root = createRoot();
      const secretPath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
      setup(secretPath, root);
      const provider = createProvider(root);

      await expect(provider.deriveRecordMacKey({ incarnation: createIncarnation() })).rejects.toThrow();
      expect(fs.lstatSync(secretPath).isSymbolicLink() || fs.existsSync(secretPath)).toBe(true);
      provider.dispose();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a symlinked or unsafe v2 root instead of repairing it', async () => {
    const targetRoot = createRoot();
    const aliasedRoot = `${targetRoot}-alias`;
    fs.symlinkSync(targetRoot, aliasedRoot);
    roots.push(aliasedRoot);
    const symlinkedProvider = createProvider(aliasedRoot);
    await expect(symlinkedProvider.deriveRecordMacKey({ incarnation: createIncarnation() })).rejects.toThrow(/regular directory/);
    symlinkedProvider.dispose();

    const unsafeRoot = createRoot();
    fs.chmodSync(unsafeRoot, 0o755);
    const unsafeProvider = createProvider(unsafeRoot);
    await expect(unsafeProvider.deriveRecordMacKey({ incarnation: createIncarnation() })).rejects.toThrow(/unsafe permissions/);
    unsafeProvider.dispose();
  });

  it.skipIf(process.platform === 'win32')('fails closed when initialized evidence remains after a missing or corrupt master secret', async () => {
    const missingRoot = createRoot();
    const incarnation = createIncarnation();
    const initialized = createProvider(missingRoot);
    const key = await initialized.deriveRecordMacKey({ incarnation });
    key.fill(0);
    initialized.dispose();

    const missingSecretPath = path.join(missingRoot, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
    fs.unlinkSync(missingSecretPath);
    const missingProvider = createProvider(missingRoot, { initializationWaitAttempts: 1 });
    await expect(missingProvider.deriveRecordMacKey({ incarnation })).rejects.toThrow(/missing after initialization evidence/);
    expect(fs.existsSync(missingSecretPath)).toBe(false);
    missingProvider.dispose();

    const corruptRoot = createRoot();
    const corruptInitialized = createProvider(corruptRoot);
    const corruptKey = await corruptInitialized.deriveRecordMacKey({ incarnation: createIncarnation() });
    corruptKey.fill(0);
    corruptInitialized.dispose();
    const corruptSecretPath = path.join(corruptRoot, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
    fs.writeFileSync(corruptSecretPath, Buffer.alloc(31, 1), { mode: 0o600 });
    const corruptProvider = createProvider(corruptRoot, { initializationWaitAttempts: 1 });
    await expect(corruptProvider.deriveRecordMacKey({ incarnation: createIncarnation() })).rejects.toThrow(/invalid length/);
    expect(fs.statSync(corruptSecretPath).size).toBe(31);
    corruptProvider.dispose();
  });

  it.skipIf(process.platform === 'win32')('rejects an otherwise valid secret when durable initialization evidence is absent', async () => {
    const root = createRoot();
    const secretPath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
    const evidencePath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_INITIALIZATION_EVIDENCE_FILENAME);
    const expectedSecret = Buffer.alloc(32, 7);
    fs.writeFileSync(secretPath, expectedSecret, { mode: 0o600 });
    const provider = createProvider(root);

    await expect(provider.deriveRecordMacKey({ incarnation: createIncarnation() }))
      .rejects.toThrow(/initialization evidence is missing/);
    expect(fs.existsSync(evidencePath)).toBe(false);
    expect(fs.readFileSync(secretPath).equals(expectedSecret)).toBe(true);

    expectedSecret.fill(0);
    provider.dispose();
  });

  it.skipIf(process.platform === 'win32')('deterministically converges concurrent first initializers through durable evidence', async () => {
    const root = createRoot();
    const incarnation = createIncarnation();
    let releaseFirstInitializer;
    let firstPublishedEvidence;
    let secondObservedEvidence;
    const firstGate = new Promise((resolve) => { releaseFirstInitializer = resolve; });
    const evidencePublished = new Promise((resolve) => { firstPublishedEvidence = resolve; });
    const secondWaiting = new Promise((resolve) => { secondObservedEvidence = resolve; });
    const first = createProvider(root, {
      initializationHooks: {
        afterEvidencePublished: async () => {
          firstPublishedEvidence();
          await firstGate;
        },
      },
    });
    const firstKeyPromise = first.deriveRecordMacKey({ incarnation });
    await evidencePublished;

    const second = createProvider(root, {
      initializationHooks: {
        waitForSecret: async () => {
          secondObservedEvidence();
          await firstGate;
        },
      },
    });
    const secondKeyPromise = second.deriveRecordMacKey({ incarnation });
    await secondWaiting;
    releaseFirstInitializer();

    const [firstKey, secondKey] = await Promise.all([firstKeyPromise, secondKeyPromise]);
    expect(firstKey.equals(secondKey)).toBe(true);
    firstKey.fill(0);
    secondKey.fill(0);
    first.dispose();
    second.dispose();
  });

  it.skipIf(process.platform === 'win32')('treats POSIX directory fsync failure as a fatal durability failure', () => {
    const root = createRoot();
    const failure = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    vi.spyOn(fs, 'fsyncSync').mockImplementation(() => { throw failure; });
    expect(() => fsyncDirectory(root)).toThrow(/directory fsync failed/);
  });

  it.skipIf(process.platform === 'win32')('fails actual secret-provider initialization when directory fsync fails', async () => {
    const root = createRoot();
    const failure = Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
    const fsyncSync = fs.fsyncSync.bind(fs);
    vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) throw failure;
      return fsyncSync(descriptor);
    });
    const provider = createProvider(root, { initializationWaitAttempts: 1 });

    await expect(provider.deriveRecordMacKey({ incarnation: createIncarnation() }))
      .rejects.toThrow(/missing after initialization evidence/);
    provider.dispose();
  });

  it.skipIf(process.platform === 'win32')('delivers lifecycle credentials once through a callback and zeroes the delivered buffer', async () => {
    const root = createRoot();
    const provider = createProvider(root);
    const incarnation = createIncarnation();
    const material = await provider.issueLifecycleCredential({ incarnation });
    let delivered;
    let deliveredText;

    await expect(material.withCredential(async (credential) => {
      delivered = credential;
      deliveredText = credential.toString('base64url');
      expect(credential).toHaveLength(32);
      return createHmac('sha256', credential)
        .update(Buffer.from(incarnation, 'base64url'))
        .digest('base64url');
    })).resolves.toBe(material.fingerprint);

    expect(delivered.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(material)).not.toContain(deliveredText);
    await expect(material.withCredential(async () => undefined)).rejects.toThrow(/unavailable/);
    expect(material.dispose()).toBe(true);
    expect(material.dispose()).toBe(false);
    provider.dispose();
  });

  it.skipIf(process.platform === 'win32')('derives a domain-separated credential-encryption key', async () => {
    const root = createRoot();
    const provider = createProvider(root);
    const incarnation = createIncarnation();
    const recordKey = await provider.deriveRecordMacKey({ incarnation });
    const credentialKey = await provider.deriveCredentialEncryptionKey({ incarnation });

    expect(credentialKey).toHaveLength(32);
    expect(credentialKey.equals(recordKey)).toBe(false);
    recordKey.fill(0);
    credentialKey.fill(0);
    provider.dispose();
  });

  it.skipIf(process.platform === 'win32')('recovers from post-link fsync failure during evidence creation', async () => {
    const root = createRoot();
    const incarnation = createIncarnation();
    const fsyncSync = fs.fsyncSync.bind(fs);
    const mock = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
      if (fs.fstatSync(descriptor).isDirectory()) throw Object.assign(new Error('post-link fsync failed'), { code: 'EIO' });
      return fsyncSync(descriptor);
    });
    const provider = createProvider(root, {
      initializationHooks: {
        waitForSecret: async () => {
          const secretPath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
          if (!fs.existsSync(secretPath)) {
            fs.writeFileSync(secretPath, Buffer.alloc(32, 9), { mode: 0o600 });
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      },
    });

    const key = await provider.deriveRecordMacKey({ incarnation });
    expect(key).toHaveLength(32);
    key.fill(0);
    provider.dispose();
    mock.mockRestore();
  });

  it.skipIf(process.platform === 'win32')('allows re-issuing a lifecycle credential after the material is disposed', async () => {
    const root = createRoot();
    const provider = createProvider(root);
    const incarnation = createIncarnation();

    const material = await provider.issueLifecycleCredential({ incarnation });
    expect(material.fingerprint).toBeDefined();
    expect(material.dispose()).toBe(true);

    const material2 = await provider.issueLifecycleCredential({ incarnation });
    expect(material2.fingerprint).toBeDefined();
    material2.dispose();
    provider.dispose();
  });
});
