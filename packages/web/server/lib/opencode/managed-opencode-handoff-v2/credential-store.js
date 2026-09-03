import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { applyPrivateFileAcl } from '../../guardian/windows-acl.js';
import {
  removeFileByIdentity,
} from '../../guardian/discovery-file.js';
import { sameFileIdentity, snapshotFileIdentity } from '../../guardian/file-identity.js';
import {
  compareProcessIdentity,
  normalizeProcessIdentity,
  probeProcessLiveness,
  readProcessIdentity,
} from '../../guardian/process-identity.js';
import {
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  resolveManagedOpenCodeHandoffV2Root,
} from './filesystem.js';
import { isManagedOpenCodeHandoffV2Incarnation } from './record.js';

export const MANAGED_OPENCODE_CREDENTIAL_DIRECTORY = 'credentials';
export const MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX = '.credential.bin';
const MANAGED_OPENCODE_CREDENTIAL_LOCK_SUFFIX = '.lock';
const MANAGED_OPENCODE_CREDENTIAL_LOCK_VERSION = 1;
const MANAGED_OPENCODE_CREDENTIAL_LOCK_MAX_BYTES = 16 * 1024;
const MANAGED_OPENCODE_CREDENTIAL_LOCK_QUARANTINE_SUFFIX = '.remove';
const MANAGED_OPENCODE_CREDENTIAL_STORE_VERSION = 1;
export const MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE = 'MANAGED_OPENCODE_CREDENTIAL_MISSING';
export const MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE = 'MANAGED_OPENCODE_CREDENTIAL_INVALID';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAGIC = Buffer.from('OCHV2CRD', 'ascii');
const HEADER_BYTES = MAGIC.length + 1 + NONCE_BYTES + AUTH_TAG_BYTES;
const MAX_USERNAME_BYTES = 256;
const MAX_PASSWORD_BYTES = 64 * 1024;
const MAX_PLAINTEXT_BYTES = MAX_USERNAME_BYTES + MAX_PASSWORD_BYTES + 128;
const MAX_RECORD_BYTES = HEADER_BYTES + MAX_PLAINTEXT_BYTES;
const LOCK_TOKEN_BYTES = 32;

// A failed release can restore the original lock while retaining a quarantine
// entry, or can leave the restored lock in place after a transient unlink
// failure. Keep the exact owner in memory so another store in this process can
// retry only that owner's cleanup; a live foreign owner never gets this
// authorization. A later process may still recover an owner proven stale from
// the persisted lock identity.
const recoverableCredentialLockOwners = new Map();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isSafeIdentityPart = (value) => typeof value === 'string'
  && value.length > 0
  && value.length <= 256
  && !/[\x00-\x1F\x7F]/.test(value);

const isCanonicalBase64Url = (value, bytes) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === bytes && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
};

const credentialError = (code, message) => Object.assign(new Error(message), { code });

const isPositivePid = (value) => Number.isSafeInteger(value) && value > 0;

const isCanonicalLockToken = (value) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === LOCK_TOKEN_BYTES && decoded.toString('base64url') === value;
  } catch {
    return false;
  }
};

const lockQuarantinePathFor = (lockPath) => (
  `${lockPath}${MANAGED_OPENCODE_CREDENTIAL_LOCK_QUARANTINE_SUFFIX}`
);

const normalizeCredentialLockOwner = (value) => {
  if (!isObject(value) || value.version !== MANAGED_OPENCODE_CREDENTIAL_LOCK_VERSION) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'identity,pid,processStartTicks,token,version') return null;
  if (!isPositivePid(value.pid) || !isCanonicalLockToken(value.token)) return null;

  const identity = normalizeProcessIdentity(value.identity);
  if (!identity?.processStartTicks || identity.processStartTicks !== value.processStartTicks) return null;
  return {
    version: MANAGED_OPENCODE_CREDENTIAL_LOCK_VERSION,
    pid: value.pid,
    processStartTicks: identity.processStartTicks,
    identity,
    token: value.token,
  };
};

const createCredentialLockOwner = ({ processIdentity, platform }) => {
  let observed;
  try {
    observed = processIdentity(process.pid, { platform });
  } catch {
    observed = null;
  }
  const identity = normalizeProcessIdentity(observed);
  if (!identity?.processStartTicks) {
    throw credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      'Managed OpenCode credential operation owner identity is unavailable',
    );
  }
  return {
    version: MANAGED_OPENCODE_CREDENTIAL_LOCK_VERSION,
    pid: process.pid,
    processStartTicks: identity.processStartTicks,
    identity,
    token: randomBytes(LOCK_TOKEN_BYTES).toString('base64url'),
  };
};

const readBoundedLockBody = (descriptor, size, filePath) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > MANAGED_OPENCODE_CREDENTIAL_LOCK_MAX_BYTES) {
    throw credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      `Managed OpenCode credential operation lock is oversized or malformed: ${filePath}`,
    );
  }
  const value = Buffer.alloc(MANAGED_OPENCODE_CREDENTIAL_LOCK_MAX_BYTES + 1);
  let offset = 0;
  while (offset < value.length) {
    const read = fs.readSync(descriptor, value, offset, value.length - offset, null);
    if (!Number.isSafeInteger(read) || read <= 0) break;
    offset += read;
  }
  if (offset > MANAGED_OPENCODE_CREDENTIAL_LOCK_MAX_BYTES || offset !== size) {
    throw credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      `Managed OpenCode credential operation lock changed while being read: ${filePath}`,
    );
  }
  return value.subarray(0, offset).toString('utf8');
};

const normalizeDescriptor = ({
  incarnation,
  ownerInstanceId,
  runtimeIdentity,
  launchFingerprint,
  credentialFingerprint,
} = {}) => {
  if (!isManagedOpenCodeHandoffV2Incarnation(incarnation)) {
    throw new TypeError('Managed OpenCode credential received an invalid incarnation');
  }
  if (!isSafeIdentityPart(ownerInstanceId)
    || !isSafeIdentityPart(runtimeIdentity)
    || !isSafeIdentityPart(launchFingerprint)) {
    throw new TypeError('Managed OpenCode credential received an invalid owner identity');
  }
  if (!isCanonicalBase64Url(credentialFingerprint, KEY_BYTES)) {
    throw new TypeError('Managed OpenCode credential received an invalid credential fingerprint');
  }
  return {
    incarnation,
    ownerInstanceId,
    runtimeIdentity,
    launchFingerprint,
    credentialFingerprint,
  };
};

const normalizeCredential = ({ username = 'opencode', password } = {}) => {
  if (!isSafeIdentityPart(username) || Buffer.byteLength(username, 'utf8') > MAX_USERNAME_BYTES) {
    throw new TypeError('Managed OpenCode credential received an invalid username');
  }
  if (typeof password !== 'string'
    || password.length === 0
    || Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES
    || /[\x00-\x1F\x7F]/.test(password)) {
    throw new TypeError('Managed OpenCode credential received an invalid password');
  }
  return { username, password };
};

const canonicalizeAssociatedData = (descriptor) => Buffer.from(JSON.stringify([
  MANAGED_OPENCODE_CREDENTIAL_STORE_VERSION,
  descriptor.incarnation,
  descriptor.ownerInstanceId,
  descriptor.runtimeIdentity,
  descriptor.launchFingerprint,
  descriptor.credentialFingerprint,
]), 'utf8');

const writeAllSync = (descriptor, value) => {
  let offset = 0;
  while (offset < value.length) {
    const written = fs.writeSync(descriptor, value, offset, value.length - offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new Error('Managed OpenCode credential record write did not complete');
    }
    offset += written;
  }
};

const openPrivateFileReadOnly = (filePath) => {
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  try {
    return fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    // Some Windows Node/libuv builds expose O_NOFOLLOW but reject it at
    // runtime. The lstat/fstat identity fence below remains mandatory when
    // retrying without the flag, so the fallback never turns a replacement or
    // symlink into trusted credential state.
    if (error?.code !== 'EINVAL' || noFollow === 0) throw error;
    return fs.openSync(filePath, fs.constants.O_RDONLY);
  }
};

const isPrivateRegularFileStat = (stat, platform) => Boolean(
  stat?.isFile?.()
  && (platform === 'win32' || (stat.mode & 0o777) === 0o600)
  && (platform === 'win32'
    || typeof process.getuid !== 'function'
    || stat.uid === process.getuid())
);

const temporaryPathFor = (directoryPath, incarnation) => path.join(
  directoryPath,
  `.${incarnation}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`,
);

const markPublishedCredentialFailure = (error, publication) => {
  if (error && typeof error === 'object') {
    Object.defineProperty(error, 'credentialPublished', {
      configurable: true,
      enumerable: false,
      value: true,
    });
    if (publication) {
      Object.defineProperty(error, 'credentialPublication', {
        configurable: true,
        enumerable: false,
        value: publication,
      });
    }
  }
  return error;
};

const assertPublishedCredentialTarget = (publication) => {
  let current;
  try {
    current = fs.lstatSync(publication.targetPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record disappeared during publication durability fencing',
      );
    }
    throw error;
  }
  const currentIdentity = snapshotFileIdentity(current);
  if (
    !currentIdentity
    || currentIdentity.type !== 'file'
    || !sameFileIdentity(publication.targetIdentity, currentIdentity)
    || current.size !== publication.size
  ) {
    throw credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      'Managed OpenCode credential record was replaced during publication durability fencing',
    );
  }
  return current;
};

const readCredentialLock = (filePath, fileOptions, expectedIdentity) => {
  const listed = assertPrivateRegularFile(filePath, 0o600, fileOptions);
  const listedIdentity = snapshotFileIdentity(listed);
  if (!listedIdentity || (expectedIdentity && !sameFileIdentity(expectedIdentity, listedIdentity))) {
    throw credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      `Managed OpenCode credential operation lock identity is unavailable or changed: ${filePath}`,
    );
  }

  let descriptor;
  try {
    descriptor = openPrivateFileReadOnly(filePath);
    const opened = fs.fstatSync(descriptor);
    const openedIdentity = snapshotFileIdentity(opened);
    if (
      !openedIdentity
      || openedIdentity.type !== 'file'
      || !sameFileIdentity(listedIdentity, openedIdentity)
      || !isPrivateRegularFileStat(opened, fileOptions.platform)
      || opened.size !== listed.size
    ) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        `Managed OpenCode credential operation lock changed while being opened: ${filePath}`,
      );
    }
    const body = readBoundedLockBody(descriptor, opened.size, filePath);
    const afterRead = fs.fstatSync(descriptor);
    const current = fs.lstatSync(filePath);
    if (
      afterRead.size !== opened.size
      || !sameFileIdentity(openedIdentity, afterRead)
      || !sameFileIdentity(openedIdentity, current)
      || !isPrivateRegularFileStat(afterRead, fileOptions.platform)
      || !isPrivateRegularFileStat(current, fileOptions.platform)
    ) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        `Managed OpenCode credential operation lock changed while being read: ${filePath}`,
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        `Managed OpenCode credential operation lock is malformed: ${filePath}`,
      );
    }
    const owner = normalizeCredentialLockOwner(parsed);
    if (!owner) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        `Managed OpenCode credential operation lock is malformed: ${filePath}`,
      );
    }
    return { owner, identity: openedIdentity };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const compareCredentialLockOwnerIdentity = (owner, actual, platform) => {
  const expectedIdentity = normalizeProcessIdentity(owner?.identity);
  const actualIdentity = normalizeProcessIdentity(actual);
  if (!expectedIdentity?.processStartTicks || !actualIdentity?.processStartTicks) return null;
  if (expectedIdentity.processStartTicks !== actualIdentity.processStartTicks) return 'mismatch';

  if (expectedIdentity.launch?.commandLine) {
    const mismatch = compareProcessIdentity(expectedIdentity, actualIdentity, { platform });
    if (mismatch === null) return 'match';
    if (
      mismatch === 'process launch identity is unavailable'
      || mismatch === 'process command line identity changed'
      || mismatch === 'process working directory identity changed'
      || mismatch === 'process owner identity changed'
    ) return mismatch.endsWith('changed') ? 'mismatch' : null;
    return null;
  }
  if (expectedIdentity.owner !== null) {
    if (actualIdentity.owner === null) return null;
    return expectedIdentity.owner === actualIdentity.owner ? 'match' : 'mismatch';
  }
  return 'match';
};

const sameCredentialLockOwner = (expected, actual, platform) => Boolean(
  expected
  && actual
  && expected.pid === actual.pid
  && expected.processStartTicks === actual.processStartTicks
  && expected.token === actual.token
  && compareCredentialLockOwnerIdentity(expected, actual.identity, platform) === 'match'
);

const publishAtomically = (
  targetPath,
  value,
  {
    platform,
    username,
    aclInspector,
    reparseChecker,
    log,
  },
) => {
  const directoryPath = path.dirname(targetPath);
  let temporaryPath;
  let descriptor;
  let temporaryIdentity;
  let temporaryQuarantinePath;
  let publication;
  let operationError = null;

  const rememberTemporaryCleanup = (error) => {
    const cleanupError = error instanceof Error
      ? error
      : new Error(String(error));
    Object.defineProperty(cleanupError, 'credentialCleanup', {
      configurable: true,
      enumerable: false,
      value: {
        path: temporaryPath,
        identity: temporaryIdentity,
        quarantinePath: temporaryQuarantinePath,
      },
    });
    if (publication) markPublishedCredentialFailure(cleanupError, publication);
    return cleanupError;
  };

  const removeTemporary = () => {
    if (temporaryPath === undefined) return;
    if (!temporaryIdentity) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential temporary record identity is unavailable; cleanup is uncertain',
      );
    }
    let result;
    try {
      result = removeFileByIdentity(temporaryPath, temporaryIdentity, {
        label: 'temporary managed OpenCode credential record',
        returnResult: true,
        quarantinePath: temporaryQuarantinePath || `${temporaryPath}.remove`,
        onQuarantinePath: (value) => { temporaryQuarantinePath = value; },
        validate: () => assertPrivateRegularFile(temporaryPath, 0o600, {
          platform,
          username,
          aclInspector,
          reparseChecker,
        }),
      });
    } catch (error) {
      throw rememberTemporaryCleanup(error);
    }
    if (result.status === 'removed' || result.status === 'absent') {
      temporaryPath = undefined;
      temporaryIdentity = undefined;
      temporaryQuarantinePath = undefined;
      return;
    }
    throw rememberTemporaryCleanup(
      result.error || new Error('Managed OpenCode credential temporary cleanup is uncertain'),
    );
  };

  try {
    temporaryPath = temporaryPathFor(directoryPath, path.basename(targetPath));
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    if (platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    temporaryIdentity = snapshotFileIdentity(fs.fstatSync(descriptor));
    if (!temporaryIdentity) {
      throw new Error('Managed OpenCode credential record has no usable file identity');
    }
    writeAllSync(descriptor, value);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    if (platform === 'win32') {
      applyPrivateFileAcl({
        filePath: temporaryPath,
        username,
        log,
        ...(aclInspector ? { inspectAcl: aclInspector } : {}),
      });
    }

    const currentTemporary = fs.lstatSync(temporaryPath);
    const currentTemporaryIdentity = snapshotFileIdentity(currentTemporary);
    if (
      !currentTemporaryIdentity
      || currentTemporaryIdentity.type !== 'file'
      || !sameFileIdentity(temporaryIdentity, currentTemporaryIdentity)
    ) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential temporary record was replaced before publication',
      );
    }

    // A hard-link publish is atomic and cannot replace an existing record.
    // This keeps a valid credential safe if a duplicate creator races us.
    fs.linkSync(temporaryPath, targetPath);
    const target = fs.lstatSync(targetPath);
    publication = {
      targetPath,
      targetIdentity: snapshotFileIdentity(target),
      size: value.length,
    };
    if (!publication.targetIdentity || !sameFileIdentity(temporaryIdentity, target)) {
      throw markPublishedCredentialFailure(
        credentialError(
          MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
          'Managed OpenCode credential record target identity was not preserved during publication',
        ),
        publication,
      );
    }
    try {
      fsyncDirectory(directoryPath, { platform });
      assertPublishedCredentialTarget(publication);
    } catch (error) {
      // The target is visible even when the first directory fsync fails. Keep
      // that fact on the error so the caller can retry durability or perform
      // authenticated cleanup rather than losing track of the encrypted file.
      throw markPublishedCredentialFailure(error, publication);
    }
    removeTemporary();
    try {
      fsyncDirectory(directoryPath, { platform });
      assertPublishedCredentialTarget(publication);
    } catch (error) {
      throw markPublishedCredentialFailure(error, publication);
    }
  } catch (error) {
    operationError = error;
    if (error?.code === 'EEXIST') {
      operationError = credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record already exists',
      );
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch (error) {
        operationError ||= error;
      }
      descriptor = undefined;
    }
  }

  if (temporaryPath !== undefined) {
    try {
      removeTemporary();
    } catch (error) {
      operationError = rememberTemporaryCleanup(error);
    }
  }
  if (operationError) throw operationError;
};

const readOpaqueRecord = (
  filePath,
  {
    platform,
    username,
    aclInspector,
    reparseChecker,
  },
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

  if (listed.size < HEADER_BYTES || listed.size > MAX_RECORD_BYTES) {
    throw credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      'Managed OpenCode credential record has an invalid size',
    );
  }

  let descriptor;
  const value = Buffer.alloc(listed.size);
  const listedIdentity = snapshotFileIdentity(listed);
  try {
    descriptor = openPrivateFileReadOnly(filePath);
    const opened = fs.fstatSync(descriptor);
    const openedIdentity = snapshotFileIdentity(opened);
    if (
      !listedIdentity
      || !openedIdentity
      || !sameFileIdentity(listedIdentity, openedIdentity)
      || !isPrivateRegularFileStat(opened, platform)
      || opened.size !== listed.size
    ) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record changed while being read',
      );
    }
    let offset = 0;
    while (offset < value.length) {
      const read = fs.readSync(descriptor, value, offset, value.length - offset, null);
      if (!Number.isSafeInteger(read) || read <= 0) break;
      offset += read;
    }
    if (offset !== value.length) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record could not be read completely',
      );
    }
    const afterRead = fs.fstatSync(descriptor);
    const currentPathStat = fs.lstatSync(filePath);
    const currentPathIdentity = snapshotFileIdentity(currentPathStat);
    const afterReadIdentity = snapshotFileIdentity(afterRead);
    if (
      !afterReadIdentity
      || !currentPathIdentity
      || !sameFileIdentity(openedIdentity, afterReadIdentity)
      || !sameFileIdentity(openedIdentity, currentPathIdentity)
      || !isPrivateRegularFileStat(afterRead, platform)
      || !isPrivateRegularFileStat(currentPathStat, platform)
      || afterRead.size !== listed.size
      || currentPathStat.size !== listed.size
    ) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record changed while being read',
      );
    }
    return {
      value,
      identity: afterReadIdentity,
    };
  } catch (error) {
    value.fill(0);
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};

const encryptRecord = (descriptor, credential, key) => {
  let plaintext;
  let associatedData;
  let nonce;
  let ciphertext;
  let authTag;
  let record;
  try {
    plaintext = Buffer.from(JSON.stringify(credential), 'utf8');
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw new TypeError('Managed OpenCode credential is too large');
    }
    associatedData = canonicalizeAssociatedData(descriptor);
    nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(associatedData, { plaintextLength: plaintext.length });
    ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    authTag = cipher.getAuthTag();

    record = Buffer.alloc(HEADER_BYTES + ciphertext.length);
    MAGIC.copy(record, 0);
    record.writeUInt8(MANAGED_OPENCODE_CREDENTIAL_STORE_VERSION, MAGIC.length);
    nonce.copy(record, MAGIC.length + 1);
    authTag.copy(record, MAGIC.length + 1 + NONCE_BYTES);
    ciphertext.copy(record, HEADER_BYTES);
    publishAtomically(descriptor.filePath, record, descriptor);
  } finally {
    plaintext?.fill(0);
    associatedData?.fill(0);
    nonce?.fill(0);
    ciphertext?.fill(0);
    authTag?.fill(0);
    record?.fill(0);
  }
};

const decryptRecord = (descriptor, value, key) => {
  let associatedData;
  let plaintext;
  try {
    if (!value.subarray(0, MAGIC.length).equals(MAGIC)
      || value.readUInt8(MAGIC.length) !== MANAGED_OPENCODE_CREDENTIAL_STORE_VERSION) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record has an invalid header',
      );
    }
    const nonce = value.subarray(MAGIC.length + 1, MAGIC.length + 1 + NONCE_BYTES);
    const authTag = value.subarray(MAGIC.length + 1 + NONCE_BYTES, HEADER_BYTES);
    const ciphertext = value.subarray(HEADER_BYTES);
    associatedData = canonicalizeAssociatedData(descriptor);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(associatedData, { plaintextLength: ciphertext.length });
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (plaintext.length > MAX_PLAINTEXT_BYTES) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record is too large',
      );
    }

    let parsed;
    try {
      parsed = JSON.parse(plaintext.toString('utf8'));
    } catch {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record is malformed',
      );
    }
    if (!isObject(parsed) || Object.keys(parsed).length !== 2
      || !Object.hasOwn(parsed, 'username') || !Object.hasOwn(parsed, 'password')) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record is malformed',
      );
    }
    return normalizeCredential(parsed);
  } catch (error) {
    if (error?.code === MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE) throw error;
    throw credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      'Managed OpenCode credential record authentication failed',
    );
  } finally {
    associatedData?.fill(0);
    plaintext?.fill(0);
    value.fill(0);
  }
};

/**
 * Stores only encrypted managed OpenCode Basic Auth credentials. The record
 * key is derived by the injected v2 secret provider; this module never writes
 * a plaintext credential or an environment object to disk.
 */
export const createManagedOpenCodeCredentialStore = ({
  rootDir,
  secretProvider,
  platform = process.platform,
  username,
  aclInspector,
  reparseChecker,
  log = () => {},
  processIdentity: processIdentityOption = readProcessIdentity,
  processLiveness: processLivenessOption = probeProcessLiveness,
} = {}) => {
  if (!secretProvider || typeof secretProvider.deriveCredentialEncryptionKey !== 'function') {
    throw new TypeError('Managed OpenCode credential store requires a v2 encryption key provider');
  }
  if (typeof log !== 'function') throw new TypeError('Managed OpenCode credential store requires a log function');
  if (typeof processIdentityOption !== 'function') {
    throw new TypeError('Managed OpenCode credential store requires a process identity helper');
  }
  if (typeof processLivenessOption !== 'function') {
    throw new TypeError('Managed OpenCode credential store requires a process liveness helper');
  }

  const rootPath = ensurePrivateDirectory(resolveManagedOpenCodeHandoffV2Root(rootDir), {
    platform,
    username,
    aclInspector,
    reparseChecker,
    log,
  });
  const directoryPath = ensurePrivateDirectory(path.join(rootPath, MANAGED_OPENCODE_CREDENTIAL_DIRECTORY), {
    platform,
    username,
    aclInspector,
    reparseChecker,
    log,
  });

  const filePathFor = (incarnation) => path.join(
    directoryPath,
    `${incarnation}${MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX}`,
  );
  const fileOptions = { platform, username, aclInspector, reparseChecker, log };

  const operationQueues = new Map();
  const runSerialized = (incarnation, operation) => {
    const previous = operationQueues.get(incarnation) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    operationQueues.set(incarnation, current);
    return current.finally(() => {
      if (operationQueues.get(incarnation) === current) operationQueues.delete(incarnation);
    });
  };

  const assertCredentialAbsent = (filePath) => {
    try {
      fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    throw credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      'Managed OpenCode credential record remained present after removal',
    );
  };

  const makeCredentialAbsenceDurable = (filePath) => {
    assertCredentialAbsent(filePath);
    fsyncDirectory(directoryPath, { platform });
    assertCredentialAbsent(filePath);
  };

  const inspectCredentialLock = (lockPath, expectedIdentity) => {
    const observed = readCredentialLock(lockPath, fileOptions, expectedIdentity);
    let liveness;
    try {
      liveness = processLivenessOption(observed.owner.pid);
    } catch {
      liveness = 'unknown';
    }
    if (liveness === 'dead') return { ...observed, state: 'stale', reason: 'owner is dead' };
    if (liveness !== 'alive') return { ...observed, state: 'unknown', reason: 'owner liveness is ambiguous' };

    let actual;
    try {
      actual = processIdentityOption(observed.owner.pid, { platform });
    } catch {
      actual = null;
    }
    const identityState = compareCredentialLockOwnerIdentity(observed.owner, actual, platform);
    if (identityState === 'mismatch') {
      return { ...observed, state: 'stale', reason: 'owner identity changed' };
    }
    if (identityState === 'match') return { ...observed, state: 'live', reason: 'owner is live' };
    return { ...observed, state: 'unknown', reason: 'owner identity is ambiguous' };
  };

  const rememberCredentialLockOwner = ({ lockPath, quarantinePath, owner, identity }) => {
    if (!lockPath || !quarantinePath || !owner || !identity) return;
    const existing = recoverableCredentialLockOwners.get(quarantinePath);
    if (existing && !sameCredentialLockOwner(existing.owner, owner, platform)) return;
    recoverableCredentialLockOwners.set(quarantinePath, {
      lockPath,
      owner,
      identity,
    });
  };

  const forgetCredentialLockOwner = (quarantinePath) => {
    if (quarantinePath) recoverableCredentialLockOwners.delete(quarantinePath);
  };

  const isCurrentProcessOwner = (owner) => {
    if (!owner || owner.pid !== process.pid) return false;
    let actual;
    try {
      actual = processIdentityOption(process.pid, { platform });
    } catch {
      actual = null;
    }
    return compareCredentialLockOwnerIdentity(owner, actual, platform) === 'match';
  };

  const removeCredentialLock = (lockPath, expectedIdentity, quarantinePath, expectedOwner) => {
    const rememberFailure = (error, fallbackPath) => {
      if (!expectedOwner) return;
      rememberCredentialLockOwner({
        lockPath,
        quarantinePath: error?.quarantinePath || fallbackPath,
        owner: expectedOwner,
        identity: expectedIdentity,
      });
    };

    let result;
    try {
      result = removeFileByIdentity(lockPath, expectedIdentity, {
        label: 'managed OpenCode credential operation lock',
        returnResult: true,
        quarantinePath,
        validate: () => {
          const stat = assertPrivateRegularFile(lockPath, 0o600, fileOptions);
          if (expectedOwner) {
            const current = readCredentialLock(lockPath, fileOptions, expectedIdentity);
            if (!sameCredentialLockOwner(expectedOwner, current.owner, platform)) {
              throw credentialError(
                MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
                'Managed OpenCode credential operation lock owner changed during cleanup',
              );
            }
          }
          return stat;
        },
      });
    } catch (error) {
      rememberFailure(error, quarantinePath);
      const wrapped = credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential operation lock cleanup is uncertain',
      );
      wrapped.cause = error;
      wrapped.quarantinePath = error?.quarantinePath || quarantinePath;
      throw wrapped;
    }
    if (result.status === 'removed' || result.status === 'absent') {
      forgetCredentialLockOwner(quarantinePath);
      return result;
    }
    rememberFailure(result.error, quarantinePath);
    const wrapped = credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      result.status === 'replaced'
        ? 'Managed OpenCode credential operation lock was replaced'
        : 'Managed OpenCode credential operation lock cleanup is uncertain',
    );
    wrapped.cause = result.error;
    wrapped.quarantinePath = result.error?.quarantinePath || quarantinePath;
    throw wrapped;
  };

  const removeCredentialLockQuarantine = (quarantinePath, expectedIdentity, expectedOwner) => {
    let result;
    try {
      result = removeFileByIdentity(quarantinePath, expectedIdentity, {
        label: 'managed OpenCode credential operation lock quarantine',
        returnResult: true,
        validate: () => {
          const stat = assertPrivateRegularFile(quarantinePath, 0o600, fileOptions);
          const current = readCredentialLock(quarantinePath, fileOptions, expectedIdentity);
          if (!sameCredentialLockOwner(expectedOwner, current.owner, platform)) {
            throw credentialError(
              MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
              'Managed OpenCode credential operation lock quarantine owner changed',
            );
          }
          return stat;
        },
      });
    } catch (error) {
      const wrapped = credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential operation lock quarantine cleanup is uncertain',
      );
      wrapped.cause = error;
      wrapped.quarantinePath = error?.quarantinePath || quarantinePath;
      throw wrapped;
    }
    if (result.status === 'removed' || result.status === 'absent') return result;
    const wrapped = credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      result.status === 'replaced'
        ? 'Managed OpenCode credential operation lock quarantine was replaced'
        : 'Managed OpenCode credential operation lock quarantine cleanup is uncertain',
    );
    wrapped.cause = result.error;
    wrapped.quarantinePath = result.error?.quarantinePath || quarantinePath;
    throw wrapped;
  };

  const withCredentialOperationLock = async (filePath, operation) => {
    const lockPath = `${filePath}${MANAGED_OPENCODE_CREDENTIAL_LOCK_SUFFIX}`;
    const quarantinePath = lockQuarantinePathFor(lockPath);
    let lockIdentity;
    let lockOwner;
    let descriptor;
    let lockHeld = false;
    let operationError = null;
    let releaseError = null;
    let returnValue;

    const recoverQuarantinedLock = () => {
      const remembered = recoverableCredentialLockOwners.get(quarantinePath);
      let present;
      try {
        present = fs.lstatSync(quarantinePath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          if (!remembered) return false;

          let current;
          try {
            current = readCredentialLock(lockPath, fileOptions, remembered.identity);
          } catch (currentError) {
            if (currentError?.code === 'ENOENT') {
              forgetCredentialLockOwner(quarantinePath);
              return false;
            }
            // The original lock identity is no longer at the live path. Let
            // normal acquisition inspect the replacement and fail closed if
            // it is live or ambiguous.
            forgetCredentialLockOwner(quarantinePath);
            return false;
          }

          const inspected = inspectCredentialLock(lockPath, remembered.identity);
          const exactCurrentOwner = sameCredentialLockOwner(
            remembered.owner,
            current.owner,
            platform,
          ) && isCurrentProcessOwner(current.owner);
          if (inspected.state !== 'stale' && !exactCurrentOwner) {
            throw credentialError(
              MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
              inspected.state === 'live'
                ? 'Managed OpenCode credential operation is already fenced by a live owner'
                : 'Managed OpenCode credential operation lock is malformed or ambiguous',
            );
          }
          removeCredentialLock(
            lockPath,
            remembered.identity,
            quarantinePath,
            remembered.owner,
          );
          return true;
        }
        throw error;
      }
      const quarantinedIdentity = snapshotFileIdentity(present);
      if (!quarantinedIdentity) {
        throw credentialError(
          MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
          'Managed OpenCode credential operation lock quarantine identity is unavailable',
        );
      }
      const inspected = inspectCredentialLock(quarantinePath, quarantinedIdentity);
      const rememberedOwner = remembered
        && sameFileIdentity(remembered.identity, quarantinedIdentity)
        && sameCredentialLockOwner(remembered.owner, inspected.owner, platform)
        && isCurrentProcessOwner(inspected.owner)
        ? remembered.owner
        : null;
      if (inspected.state !== 'stale' && !rememberedOwner) {
        throw credentialError(
          MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
          `Managed OpenCode credential operation lock quarantine is ${inspected.state}`,
        );
      }

      let current = null;
      try {
        current = readCredentialLock(lockPath, fileOptions);
      } catch (error) {
        if (error?.code !== 'ENOENT') current = null;
      }
      const currentIsQuarantinedOwner = current
        && sameFileIdentity(current.identity, quarantinedIdentity)
        && sameCredentialLockOwner(inspected.owner, current.owner, platform);

      // Remove only the authenticated quarantine artifact first. If a
      // replacement lock is live, this never touches it; the acquisition
      // attempt below will report that live fence explicitly.
      removeCredentialLockQuarantine(
        quarantinePath,
        quarantinedIdentity,
        inspected.owner,
      );
      forgetCredentialLockOwner(quarantinePath);

      if (currentIsQuarantinedOwner) {
        removeCredentialLock(
          lockPath,
          current.identity,
          quarantinePath,
          current.owner,
        );
      }
      return true;
    };

    const acquire = () => {
      // Resolve and authenticate the current process owner before publishing
      // the O_EXCL lock. A failed identity probe must not leave an empty lock
      // that no later operation can safely reclaim.
      lockOwner = createCredentialLockOwner({
        processIdentity: processIdentityOption,
        platform,
      });
      recoverQuarantinedLock();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          descriptor = fs.openSync(lockPath, 'wx', 0o600);
          lockHeld = true;
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          let inspected;
          try {
            inspected = inspectCredentialLock(lockPath);
          } catch (inspectError) {
            if (inspectError?.code === 'ENOENT' && attempt === 0) continue;
            throw inspectError;
          }
          if (inspected.state !== 'stale') {
            throw credentialError(
              MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
              inspected.state === 'live'
                ? 'Managed OpenCode credential operation is already fenced by a live owner'
                : 'Managed OpenCode credential operation lock is malformed or ambiguous',
            );
          }
          removeCredentialLock(lockPath, inspected.identity, quarantinePath, inspected.owner);
          continue;
        }

        if (platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
        lockIdentity = snapshotFileIdentity(fs.fstatSync(descriptor));
        if (!lockIdentity) {
          throw credentialError(
            MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
            'Managed OpenCode credential operation lock has no usable identity; cleanup is uncertain',
          );
        }
        const body = Buffer.from(JSON.stringify(lockOwner), 'utf8');
        try {
          writeAllSync(descriptor, body);
          fs.fsyncSync(descriptor);
        } finally {
          body.fill(0);
        }
        fs.closeSync(descriptor);
        descriptor = undefined;
        if (platform === 'win32') {
          applyPrivateFileAcl({
            filePath: lockPath,
            username,
            log,
            ...(aclInspector ? { inspectAcl: aclInspector } : {}),
          });
        }
        const current = readCredentialLock(lockPath, fileOptions, lockIdentity);
        if (current.owner.token !== lockOwner.token) {
          throw credentialError(
            MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
            'Managed OpenCode credential operation lock owner changed during acquisition',
          );
        }
        return;
      }
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential operation lock could not be acquired',
      );
    };

    const release = () => {
      if (!lockHeld) return;
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* best effort */ }
        descriptor = undefined;
      }
      if (!lockIdentity) {
        throw credentialError(
          MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
          'Managed OpenCode credential operation lock cleanup is uncertain because its identity is unavailable',
        );
      }
      try {
        const current = inspectCredentialLock(lockPath, lockIdentity);
        if (current.owner.token !== lockOwner?.token || current.state !== 'live') {
          throw credentialError(
            MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
            'Managed OpenCode credential operation lock owner changed during release',
          );
        }
        removeCredentialLock(lockPath, lockIdentity, quarantinePath, lockOwner);
        lockHeld = false;
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw credentialError(
            MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
            'Managed OpenCode credential operation lock disappeared',
          );
        }
        throw error;
      }
    };

    try {
      acquire();
      returnValue = await operation();
    } catch (error) {
      operationError = error;
    } finally {
      try {
        release();
      } catch (error) {
        releaseError = error;
      }
    }

    if (releaseError) {
      if (operationError) releaseError.cause = operationError;
      throw releaseError;
    }
    if (operationError) throw operationError;
    return returnValue;
  };

  const readDescriptorAtPath = async (descriptor, filePath) => {
    const opaqueRecord = readOpaqueRecord(filePath, fileOptions);
    if (!opaqueRecord) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE,
        'Managed OpenCode credential record is missing',
      );
    }

    let key;
    try {
      key = await secretProvider.deriveCredentialEncryptionKey({ incarnation: descriptor.incarnation });
      if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
        throw new Error('invalid key');
      }
      return {
        credential: decryptRecord({ ...descriptor, filePath, platform, username, aclInspector, reparseChecker, log }, opaqueRecord.value, key),
        identity: opaqueRecord.identity,
      };
    } catch (error) {
      if (error?.code === MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE) throw error;
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record could not be opened',
      );
    } finally {
      key?.fill(0);
      if (Buffer.isBuffer(opaqueRecord.value)) opaqueRecord.value.fill(0);
    }
  };

  const readDescriptor = async (descriptor) => readDescriptorAtPath(
    descriptor,
    filePathFor(descriptor.incarnation),
  );

  const removeCredentialRecoveryArtifacts = async (descriptor, filePath) => {
    const basename = path.basename(filePath);
    const prefix = `.${basename}.`;
    let names;
    try {
      names = fs.readdirSync(directoryPath);
    } catch (error) {
      throw credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        `Managed OpenCode credential recovery state could not be inspected: ${error.message}`,
      );
    }

    for (const name of names) {
      if (!name.startsWith(prefix) || (!name.endsWith('.tmp') && !name.endsWith('.remove'))) continue;
      const candidatePath = path.join(directoryPath, name);
      let candidate;
      try {
        candidate = await readDescriptorAtPath(descriptor, candidatePath);
      } catch (error) {
        if (error?.code === MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE) continue;
        throw error;
      }
      if (!candidate) continue;

      let result;
      try {
        result = removeFileByIdentity(candidatePath, candidate.identity, {
          label: 'managed OpenCode credential recovery artifact',
          returnResult: true,
          quarantinePath: `${candidatePath}.remove`,
          validate: () => assertPrivateRegularFile(candidatePath, 0o600, fileOptions),
        });
      } catch (error) {
        const wrapped = credentialError(
          MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
          'Managed OpenCode credential recovery cleanup is uncertain',
        );
        wrapped.cause = error;
        wrapped.recoveryPath = error?.quarantinePath || `${candidatePath}.remove`;
        throw wrapped;
      }
      if (result.status !== 'removed' && result.status !== 'absent') {
        const wrapped = credentialError(
          MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
          result.status === 'replaced'
            ? 'Managed OpenCode credential recovery artifact was replaced'
            : 'Managed OpenCode credential recovery cleanup is uncertain',
        );
        wrapped.cause = result.error;
        wrapped.recoveryPath = result.error?.quarantinePath || `${candidatePath}.remove`;
        throw wrapped;
      }
    }
  };

  const read = async (input = {}) => {
    const descriptor = normalizeDescriptor(input);
    const filePath = filePathFor(descriptor.incarnation);
    return runSerialized(
      descriptor.incarnation,
      () => withCredentialOperationLock(filePath, async () => {
        const result = await readDescriptor(descriptor);
        return result.credential;
      }),
    );
  };

  const create = async (input = {}) => {
    const descriptor = normalizeDescriptor(input);
    const credential = normalizeCredential(input);
    return runSerialized(descriptor.incarnation, () => withCredentialOperationLock(
      filePathFor(descriptor.incarnation),
      async () => {
      let key;
      try {
        key = await secretProvider.deriveCredentialEncryptionKey({ incarnation: descriptor.incarnation });
        if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
          throw new Error('invalid key');
        }
        encryptRecord({
          ...descriptor,
          filePath: filePathFor(descriptor.incarnation),
          ...fileOptions,
        }, credential, key);
        return { created: true };
      } catch (error) {
        if (
          error?.credentialPublished === true
          && error?.credentialPublication
          && !error?.credentialCleanup
        ) {
          try {
            // A post-link directory fsync can fail transiently. The target is
            // already authenticated and immutable, so a successful retry makes
            // the same create operation durable without publishing a second
            // file or treating it as a duplicate. Re-check the exact target
            // identity after the retry: a concurrent remove/replacement must
            // never be reported as a successful publication.
            fsyncDirectory(directoryPath, { platform });
            assertPublishedCredentialTarget(error.credentialPublication);
            return { created: true };
          } catch {
            const wrapped = credentialError(
              MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
              'Managed OpenCode credential record publication is not durable',
            );
            Object.defineProperty(wrapped, 'credentialPublished', {
              configurable: true,
              enumerable: false,
              value: true,
            });
            Object.defineProperty(wrapped, 'credentialPublication', {
              configurable: true,
              enumerable: false,
              value: error.credentialPublication,
            });
            throw wrapped;
          }
        }
        if (error?.code === MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE) throw error;
        throw credentialError(
          MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
          'Managed OpenCode credential record could not be created',
        );
      } finally {
        key?.fill(0);
      }
      },
    ));
  };

  const removeCredentialRecordByIdentity = (filePath, identity) => {
    const recoveryPath = `${filePath}.remove`;
    let result;
    try {
      result = removeFileByIdentity(filePath, identity, {
        label: 'managed OpenCode credential record',
        returnResult: true,
        quarantinePath: recoveryPath,
        validate: () => assertPrivateRegularFile(filePath, 0o600, fileOptions),
      });
    } catch (error) {
      const wrapped = credentialError(
        MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
        'Managed OpenCode credential record cleanup is uncertain',
      );
      wrapped.cause = error;
      wrapped.recoveryPath = error?.quarantinePath || recoveryPath;
      throw wrapped;
    }

    if (result.status === 'removed' || result.status === 'absent') return result;
    const wrapped = credentialError(
      MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
      result.status === 'replaced'
        ? 'Managed OpenCode credential record changed while being removed'
        : 'Managed OpenCode credential record cleanup is uncertain',
    );
    wrapped.cause = result.error;
    wrapped.recoveryPath = result.error?.quarantinePath || recoveryPath;
    throw wrapped;
  };

  const remove = async (input = {}) => {
    const descriptor = normalizeDescriptor(input);
    const filePath = filePathFor(descriptor.incarnation);
    return runSerialized(descriptor.incarnation, () => withCredentialOperationLock(filePath, async () => {
      // Authenticate the tuple before unlinking. A wrong owner/fingerprint can
      // never delete another incarnation's durable record. The read also
      // captures the inode identity used to fence a path replacement.
      let observed;
      try {
        observed = await readDescriptor(descriptor);
      } catch (error) {
        if (error?.code !== MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE) throw error;
        const recoveryPath = `${filePath}.remove`;
        try {
          fs.lstatSync(recoveryPath);
          observed = await readDescriptorAtPath(descriptor, recoveryPath);
          if (!observed) {
            throw credentialError(
              MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
              'Managed OpenCode credential recovery state is malformed',
            );
          }
        } catch (recoveryError) {
          if (recoveryError?.code === 'ENOENT') observed = null;
          else if (recoveryError?.code === MANAGED_OPENCODE_CREDENTIAL_MISSING_CODE) {
            throw credentialError(
              MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
              'Managed OpenCode credential recovery state is malformed',
            );
          } else throw recoveryError;
        }
        if (observed) {
          const result = removeCredentialRecordByIdentity(filePath, observed.identity);
          await removeCredentialRecoveryArtifacts(descriptor, filePath);
          try {
            makeCredentialAbsenceDurable(filePath);
          } catch {
            throw credentialError(
              MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
              'Managed OpenCode credential absence could not be made durable',
            );
          }
          return { removed: result.status === 'removed' };
        }
        await removeCredentialRecoveryArtifacts(descriptor, filePath);
        try {
          makeCredentialAbsenceDurable(filePath);
        } catch {
          throw credentialError(
            MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
            'Managed OpenCode credential absence could not be made durable',
          );
        }
        return { removed: false };
      }

      const result = removeCredentialRecordByIdentity(filePath, observed.identity);
      await removeCredentialRecoveryArtifacts(descriptor, filePath);
      try {
        makeCredentialAbsenceDurable(filePath);
      } catch {
        throw credentialError(
          MANAGED_OPENCODE_CREDENTIAL_INVALID_CODE,
          'Managed OpenCode credential absence could not be made durable',
        );
      }
      return { removed: result.status === 'removed' };
    }));
  };

  return Object.freeze({
    create,
    read,
    remove,
  });
};
