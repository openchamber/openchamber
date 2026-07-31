import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  resolveManagedOpenCodeHandoffV2Root,
} from './filesystem.js';
import {
  isManagedOpenCodeHandoffV2Incarnation,
  MANAGED_OPENCODE_HANDOFF_V2_INCARNATION_BYTES,
  MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES,
} from './record.js';

const MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_BYTES = 32;
export const MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME = 'master-secret.bin';
export const MANAGED_OPENCODE_HANDOFF_V2_INITIALIZATION_EVIDENCE_FILENAME = 'master-secret.initialized';
const MANAGED_OPENCODE_HANDOFF_V2_RECORD_MAC_HKDF_INFO =
  'openchamber/managed-opencode-handoff/v2/record-mac';
const MANAGED_OPENCODE_HANDOFF_V2_LIFECYCLE_CREDENTIAL_HKDF_INFO =
  'openchamber/managed-opencode-handoff/v2/lifecycle-credential';
const INITIALIZATION_EVIDENCE = Buffer.from(
  'openchamber/managed-opencode-handoff/v2/master-secret-initialized/v1\n',
  'utf8',
);
const DEFAULT_INITIALIZATION_WAIT_ATTEMPTS = 50;
const DEFAULT_INITIALIZATION_RETRY_DELAY_MS = 10;

const writeAllSync = (descriptor, buffer) => {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('Managed OpenCode handoff v2 secret write did not complete');
    }
    offset += written;
  }
};

const readPrivateFile = (
  filePath,
  expectedLength,
  label,
  { platform = process.platform, username, aclInspector, reparseChecker } = {},
) => {
  let listed;
  try {
    listed = assertPrivateRegularFile(filePath, 0o600, {
      platform,
      username,
      aclInspector,
      reparseChecker,
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }

  if (listed.size !== expectedLength) {
    throw new Error(`Managed OpenCode handoff v2 ${label} has an invalid length`);
  }

  let descriptor;
  let value;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== listed.dev
      || opened.ino !== listed.ino
      || opened.size !== expectedLength
    ) {
      throw new Error(`Managed OpenCode handoff v2 ${label} changed while being read`);
    }
    if (!opened.isFile() || (platform !== 'win32' && (opened.mode & 0o777) !== 0o600)) {
      throw new Error(`Managed OpenCode handoff v2 ${label} is unsafe`);
    }
    if (platform !== 'win32' && typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
      throw new Error(`Managed OpenCode handoff v2 ${label} is not owned by this user`);
    }

    value = Buffer.alloc(expectedLength);
    let offset = 0;
    while (offset < value.length) {
      const read = fs.readSync(descriptor, value, offset, value.length - offset, null);
      if (!Number.isSafeInteger(read) || read <= 0) break;
      offset += read;
    }
    if (offset !== value.length) {
      throw new Error(`Managed OpenCode handoff v2 ${label} could not be read completely`);
    }
    return value;
  } catch (error) {
    value?.fill(0);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const readSecretFile = (secretPath, platform, options) => readPrivateFile(
  secretPath,
  MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_BYTES,
  'secret',
  { platform, ...options },
);

const readInitializationEvidence = (evidencePath, platform, options) => {
  const evidence = readPrivateFile(
    evidencePath,
    INITIALIZATION_EVIDENCE.length,
    'initialization evidence',
    { platform, ...options },
  );
  if (!evidence) return false;
  try {
    if (evidence.length !== INITIALIZATION_EVIDENCE.length || !timingSafeEqual(evidence, INITIALIZATION_EVIDENCE)) {
      throw new Error('Managed OpenCode handoff v2 initialization evidence is invalid');
    }
    return true;
  } finally {
    evidence.fill(0);
  }
};

const createTemporaryPath = (rootPath, label) => path.join(
  rootPath,
  `.${label}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`,
);

const publishFileExclusively = (rootPath, targetPath, contents, label, { platform = process.platform } = {}) => {
  let temporaryPath;
  let descriptor;

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      temporaryPath = createTemporaryPath(rootPath, label);
      try {
        descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        break;
      } catch (error) {
        if (error?.code !== 'EEXIST' || attempt === 2) throw error;
      }
    }

    if (descriptor === undefined) {
      throw new Error('Managed OpenCode handoff v2 secret temporary file could not be created');
    }
    if (platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    writeAllSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    try {
      // link(2) publishes an already-fsynced temporary inode only if the target
      // does not exist; unlike rename(2), it cannot replace another creator's key.
      fs.linkSync(temporaryPath, targetPath);
    } catch (error) {
      if (error?.code === 'EEXIST') return null;
      throw error;
    }

    fsyncDirectory(rootPath, { platform });
    fs.unlinkSync(temporaryPath);
    temporaryPath = undefined;
    fsyncDirectory(rootPath, { platform });
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (temporaryPath !== undefined) {
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
  }
};

const createSecretFileExclusively = (rootPath, secretPath, platform) => {
  let generated;
  let published = false;
  try {
    generated = randomBytes(MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_BYTES);
    if (!publishFileExclusively(rootPath, secretPath, generated, 'master-secret', { platform })) return null;
    published = true;
    return generated;
  } finally {
    if (!published) generated?.fill(0);
  }
};

const createInitializationEvidenceExclusively = (rootPath, evidencePath, platform) =>
  publishFileExclusively(
    rootPath,
    evidencePath,
    INITIALIZATION_EVIDENCE,
    'master-secret-initialized',
    { platform },
  );

const validateDerivedKey = (value) => {
  if (!Buffer.isBuffer(value) || value.length !== MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES) {
    throw new Error('Managed OpenCode handoff v2 derived key is invalid');
  }
  return value;
};

/**
 * Owns only the v2 master secret. The raw secret never leaves this closure;
 * callers can derive a record-MAC key or use a one-shot lifecycle credential.
 */
export const createManagedOpenCodeHandoffV2SecretProvider = ({
  rootDir,
  platform = process.platform,
  username,
  aclInspector,
  reparseChecker,
  initializationHooks = {},
  initializationWaitAttempts = DEFAULT_INITIALIZATION_WAIT_ATTEMPTS,
} = {}) => {
  if (
    !Number.isSafeInteger(initializationWaitAttempts)
    || initializationWaitAttempts <= 0
    || initializationWaitAttempts > 1_000
  ) {
    throw new TypeError('Managed OpenCode handoff v2 secret provider received invalid initialization retry attempts');
  }
  if (initializationHooks === null || typeof initializationHooks !== 'object') {
    throw new TypeError('Managed OpenCode handoff v2 secret provider received invalid initialization hooks');
  }

  const afterEvidencePublished = initializationHooks.afterEvidencePublished
    ?? (async () => {});
  const waitForSecret = initializationHooks.waitForSecret
    ?? (async () => new Promise((resolve) => setTimeout(resolve, DEFAULT_INITIALIZATION_RETRY_DELAY_MS)));
  if (typeof afterEvidencePublished !== 'function' || typeof waitForSecret !== 'function') {
    throw new TypeError('Managed OpenCode handoff v2 secret provider received invalid initialization hooks');
  }

  const rootPath = resolveManagedOpenCodeHandoffV2Root(rootDir);
  const secretPath = path.join(rootPath, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME);
  const evidencePath = path.join(rootPath, MANAGED_OPENCODE_HANDOFF_V2_INITIALIZATION_EVIDENCE_FILENAME);
  const issuedIncarnations = new Set();
  const activeMaterials = new Set();
  let masterSecret = null;
  let initialization = null;
  let disposed = false;

  const waitForSecretAfterEvidence = async () => {
    for (let attempt = 0; attempt < initializationWaitAttempts; attempt += 1) {
      const converged = readSecretFile(secretPath, platform, { username, aclInspector, reparseChecker });
      if (converged) return converged;
      if (attempt + 1 < initializationWaitAttempts) await waitForSecret({ attempt });
    }
    return null;
  };

  const initializeMasterSecret = async () => {
    ensurePrivateDirectory(rootPath, {
      platform,
      username,
      aclInspector,
      reparseChecker,
    });

    const fileOptions = { username, aclInspector, reparseChecker };
    const hasEvidence = readInitializationEvidence(evidencePath, platform, fileOptions);
    const existing = readSecretFile(secretPath, platform, fileOptions);
    try {
      if (existing) {
        if (!hasEvidence) {
          throw new Error('Managed OpenCode handoff v2 initialization evidence is missing for an existing secret');
        }
        return existing;
      }

      if (hasEvidence) {
        const converged = await waitForSecretAfterEvidence();
        if (!converged) {
          throw new Error('Managed OpenCode handoff v2 secret is missing after initialization evidence');
        }
        return converged;
      }

      let evidenceCreated;
      try {
        evidenceCreated = createInitializationEvidenceExclusively(rootPath, evidencePath, platform);
      } catch (error) {
        if (readInitializationEvidence(evidencePath, platform, fileOptions)) {
          const converged = await waitForSecretAfterEvidence();
          if (!converged) {
            throw new Error('Managed OpenCode handoff v2 secret is missing after initialization evidence');
          }
          return converged;
        }
        throw error;
      }

      if (!evidenceCreated) {
        if (!readInitializationEvidence(evidencePath, platform, fileOptions)) {
          throw new Error('Managed OpenCode handoff v2 initialization evidence did not converge');
        }
        const converged = await waitForSecretAfterEvidence();
        if (!converged) {
          throw new Error('Managed OpenCode handoff v2 secret is missing after initialization evidence');
        }
        return converged;
      }

      await afterEvidencePublished();
      let created;
      try {
        created = createSecretFileExclusively(rootPath, secretPath, platform);
      } catch (error) {
        const converged = readSecretFile(secretPath, platform, fileOptions);
        if (converged) return converged;
        const waited = await waitForSecretAfterEvidence();
        if (!waited) {
          throw new Error('Managed OpenCode handoff v2 secret creation did not converge');
        }
        return waited;
      }

      if (created) return created;

      const converged = await waitForSecretAfterEvidence();
      if (!converged) {
        throw new Error('Managed OpenCode handoff v2 secret creation did not converge');
      }
      return converged;
    } catch (error) {
      existing?.fill(0);
      throw error;
    }
  };

  const ensureMasterSecret = async () => {
    if (disposed) throw new Error('Managed OpenCode handoff v2 secret provider is disposed');
    if (masterSecret) return masterSecret;
    if (!initialization) {
      initialization = initializeMasterSecret()
        .then((loaded) => {
          if (disposed) {
            loaded.fill(0);
            throw new Error('Managed OpenCode handoff v2 secret provider is disposed');
          }
          masterSecret = loaded;
        })
        .finally(() => {
          initialization = null;
        });
    }
    await initialization;
    if (!masterSecret) throw new Error('Managed OpenCode handoff v2 secret is unavailable');
    return masterSecret;
  };

  const derive = async (incarnation, info) => {
    if (!isManagedOpenCodeHandoffV2Incarnation(incarnation)) {
      throw new TypeError('Invalid managed OpenCode handoff v2 incarnation');
    }
    const master = await ensureMasterSecret();
    const salt = Buffer.from(incarnation, 'base64url');
    try {
      return validateDerivedKey(Buffer.from(hkdfSync(
        'sha256',
        master,
        salt,
        Buffer.from(info, 'utf8'),
        MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES,
      )));
    } finally {
      salt.fill(0);
    }
  };

  const getLifecycleCredentialFingerprint = async ({ incarnation } = {}) => {
    if (!isManagedOpenCodeHandoffV2Incarnation(incarnation)) {
      throw new TypeError('Invalid managed OpenCode handoff v2 incarnation');
    }
    let credential;
    try {
      credential = await derive(incarnation, MANAGED_OPENCODE_HANDOFF_V2_LIFECYCLE_CREDENTIAL_HKDF_INFO);
      return createHmac('sha256', credential)
        .update(Buffer.from(incarnation, 'base64url'))
        .digest('base64url');
    } finally {
      credential?.fill(0);
    }
  };

  const issueLifecycleCredential = async ({ incarnation } = {}) => {
    if (!isManagedOpenCodeHandoffV2Incarnation(incarnation)) {
      throw new TypeError('Invalid managed OpenCode handoff v2 incarnation');
    }
    await ensureMasterSecret();
    if (issuedIncarnations.has(incarnation)) {
      throw new Error('Managed OpenCode handoff v2 lifecycle credential was already issued');
    }

    issuedIncarnations.add(incarnation);
    let fingerprint;
    try {
      fingerprint = await getLifecycleCredentialFingerprint({ incarnation });
    } catch (error) {
      issuedIncarnations.delete(incarnation);
      throw error;
    }

    let used = false;
    let materialDisposed = false;
    let delivered = null;
    const material = {};
    const revoke = () => {
      if (materialDisposed) return false;
      materialDisposed = true;
      delivered?.fill(0);
      delivered = null;
      activeMaterials.delete(material);
      issuedIncarnations.delete(incarnation);
      return true;
    };
    Object.defineProperties(material, {
      fingerprint: { enumerable: true, value: fingerprint },
      withCredential: {
        enumerable: false,
        value: async (useCredential) => {
          if (typeof useCredential !== 'function') {
            throw new TypeError('Managed OpenCode handoff v2 lifecycle credential requires a callback');
          }
          if (disposed || materialDisposed || used) {
            throw new Error('Managed OpenCode handoff v2 lifecycle credential is unavailable');
          }
          used = true;
          try {
            delivered = await derive(incarnation, MANAGED_OPENCODE_HANDOFF_V2_LIFECYCLE_CREDENTIAL_HKDF_INFO);
            if (disposed || materialDisposed) {
              throw new Error('Managed OpenCode handoff v2 lifecycle credential is unavailable');
            }
            return await useCredential(delivered);
          } finally {
            delivered?.fill(0);
            delivered = null;
          }
        },
      },
      dispose: {
        enumerable: false,
        value: revoke,
      },
    });
    activeMaterials.add(material);
    return Object.freeze(material);
  };

  return Object.freeze({
    deriveRecordMacKey: ({ incarnation } = {}) =>
      derive(incarnation, MANAGED_OPENCODE_HANDOFF_V2_RECORD_MAC_HKDF_INFO),
    getLifecycleCredentialFingerprint,
    issueLifecycleCredential,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const material of activeMaterials) material.dispose();
      issuedIncarnations.clear();
      masterSecret?.fill(0);
      masterSecret = null;
    },
  });
};
