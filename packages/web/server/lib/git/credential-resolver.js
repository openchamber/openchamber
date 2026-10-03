import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const REFERENCE_PREFIX = 'ocgit:v1';
const VERSIONED_REFERENCE_PREFIX = 'ocgit:v2';
const DEFAULT_PORTS = Object.freeze({ http: 80, https: 443, ssh: 22 });
const MAX_SSH_PRIVATE_KEY_BYTES = 128 * 1024;
const SSH_PRIVATE_KEY_MARKER = /-----BEGIN (?:OPENSSH |RSA |DSA |EC |ENCRYPTED )?PRIVATE KEY-----/;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const requiredString = (value, name) => {
  if (!isString(value) || !value || value.trim() !== value || /[\0\r\n]/.test(value)) {
    throw new Error(`Invalid Git credential ${name}`);
  }
  return value;
};

const encodePart = (value) => Buffer.from(requiredString(value, 'reference value'), 'utf8').toString('base64url');
const decodePart = (value) => {
  if (!isString(value) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid Git credential reference');
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!decoded || encodePart(decoded) !== value) throw new Error('Invalid Git credential reference');
  return decoded;
};

export function createHttpsCredentialReference({
  provider,
  instance,
  credentialId,
  credentialRevision,
  providerUserId,
}) {
  if (!['github', 'gitlab'].includes(provider)) throw new Error('Invalid Git credential provider');
  if (!Number.isSafeInteger(credentialRevision) || credentialRevision < 1) throw new Error('Invalid Git credential revision');
  return `${VERSIONED_REFERENCE_PREFIX}:https:${provider}:${encodePart(instance)}:${encodePart(credentialId)}:${credentialRevision}:${encodePart(providerUserId)}`;
}

export function createSshCredentialReference(keyId) {
  return `${REFERENCE_PREFIX}:ssh:${encodePart(keyId)}`;
}

export function parseGitCredentialReference(reference) {
  const parts = requiredString(reference, 'reference').split(':');
  if (parts[0] !== 'ocgit' || !['v1', 'v2'].includes(parts[1])) throw new Error('Invalid Git credential reference');
  if (parts.length === 8 && parts[1] === 'v2' && parts[2] === 'https' && ['github', 'gitlab'].includes(parts[3])) {
    const credentialRevision = Number(parts[6]);
    if (!/^[1-9]\d*$/.test(parts[6]) || !Number.isSafeInteger(credentialRevision)) {
      throw new Error('Invalid Git credential reference');
    }
    return Object.freeze({
      version: 2,
      transport: 'https',
      provider: parts[3],
      instance: decodePart(parts[4]),
      credentialId: decodePart(parts[5]),
      credentialRevision,
      providerUserId: decodePart(parts[7]),
    });
  }
  if (parts.length === 4 && parts[1] === 'v1' && parts[2] === 'ssh') {
    return Object.freeze({ version: 1, transport: 'ssh', keyId: decodePart(parts[3]) });
  }
  throw new Error('Invalid Git credential reference');
}

const normalizePath = (value) => {
  let decoded;
  try {
    decoded = decodeURIComponent(requiredString(value, 'endpoint path').replace(/^\/+|\/+$/g, ''));
  } catch {
    throw new Error('Invalid Git credential endpoint path');
  }
  if (!decoded || decoded.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('Invalid Git credential endpoint path');
  }
  return decoded;
};

export function normalizeGitCredentialEndpoint(endpoint) {
  if (!isPlainObject(endpoint)) throw new Error('Invalid Git credential endpoint');
  const protocol = requiredString(endpoint.protocol, 'endpoint protocol').replace(/:$/, '').toLowerCase();
  if (!(protocol in DEFAULT_PORTS)) throw new Error('Invalid Git credential endpoint protocol');

  let parsed;
  try {
    parsed = new URL(`${protocol}://${requiredString(endpoint.host, 'endpoint host')}`);
  } catch {
    throw new Error('Invalid Git credential endpoint host');
  }
  if (parsed.username || parsed.password || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('Invalid Git credential endpoint host');
  }

  const suppliedPort = endpoint.port === undefined || endpoint.port === null || endpoint.port === ''
    ? (parsed.port ? Number(parsed.port) : DEFAULT_PORTS[protocol])
    : Number(endpoint.port);
  if (!Number.isInteger(suppliedPort) || suppliedPort < 1 || suppliedPort > 65_535) {
    throw new Error('Invalid Git credential endpoint port');
  }
  if (parsed.port && Number(parsed.port) !== suppliedPort) throw new Error('Conflicting Git credential endpoint port');

  return Object.freeze({ protocol, host: parsed.hostname.toLowerCase(), port: suppliedPort, path: normalizePath(endpoint.path) });
}

const GIT_LFS_ENDPOINT_SUFFIX = '/info/lfs';

/**
 * git-lfs asks the credential helper for the repository URL it derives from the LFS
 * endpoint by stripping `/info/lfs`, not for the endpoint itself. A lease for such an
 * endpoint must therefore also answer for that repository path; custom endpoints
 * without the suffix get no alias.
 */
export function gitLfsCredentialEndpointAliases(endpoint) {
  const normalized = normalizeGitCredentialEndpoint(endpoint);
  if (!normalized.path.endsWith(GIT_LFS_ENDPOINT_SUFFIX)) return Object.freeze([]);
  const repositoryPath = normalized.path.slice(0, -GIT_LFS_ENDPOINT_SUFFIX.length);
  if (!repositoryPath) return Object.freeze([]);
  return Object.freeze([Object.freeze({ ...normalized, path: repositoryPath })]);
}

export function normalizeGitRemoteEndpoint(remoteUrl) {
  const value = requiredString(remoteUrl, 'endpoint URL');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Invalid Git credential endpoint URL');
    }
    if (parsed.username && parsed.protocol !== 'ssh:') throw new Error('Git endpoint credentials are not allowed');
    if (parsed.password || parsed.search || parsed.hash) throw new Error('Git endpoint credentials are not allowed');
    return normalizeGitCredentialEndpoint({
      protocol: parsed.protocol,
      host: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
    });
  }

  const scp = value.match(/^(?:[^@/:\s]+@)?([^/:\s]+):(.+)$/);
  if (!scp) throw new Error('Invalid Git credential endpoint URL');
  return normalizeGitCredentialEndpoint({ protocol: 'ssh', host: scp[1], path: scp[2] });
}

const runFile = (file, args, { input = '', deadline = Date.now() + 30_000, controls } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  let inputError;
  child.stdin.on('error', (error) => {
    // ssh-keygen may close stdin after reading its key. Its exit code and verified output remain authoritative.
    if (error.code !== 'EPIPE') inputError = error;
  });
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  let settled = false;
  const remaining = Math.max(1, deadline - Date.now());
  const timer = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch {}
    const escalation = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1_000);
    escalation.unref?.();
  }, remaining);
  timer.unref?.();
  const settle = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    controls?.detachChild(child);
    callback();
  };
  child.on('error', (error) => settle(() => reject(error)));
  child.on('close', (code) => settle(() => {
    const result = { code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
    if (code === 0 && !inputError) resolve(result);
    else reject(Object.assign(new Error('SSH key verification failed'), result));
  }));
  controls?.attachChild(child);
  child.stdin.end(input);
});

const fileIdentity = (stats) => `${stats.dev}:${stats.ino}`;
const sourceIdentity = (stats) => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
const removeOwnedFile = async (filePath, identity, fsImpl) => {
  try {
    if (fileIdentity(await fsImpl.stat(filePath)) !== identity) return false;
    await fsImpl.rm(filePath, { force: true });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    return false;
  }
};

export const snapshotSshPrivateKey = async ({
  privateKeyPath,
  realpath = fs.realpath,
  execute = runFile,
  fsImpl = fs,
  snapshotRoot,
  operationId,
  deadline,
  controls,
  approvedRoot,
  expectedSourceIdentity,
  requirePrivateMode = false,
  rejectSymlinkPath = false,
}) => {
  const requestedPath = requiredString(privateKeyPath, 'private key path');
  let requestedStats;
  let sourcePath;
  let sourceHandle;
  let privateKey;
  try {
    if (rejectSymlinkPath) {
      requestedStats = await fsImpl.lstat(requestedPath, { bigint: true });
      if (requestedStats.isSymbolicLink()) {
        throw Object.assign(new Error('Managed SSH key symlinks are not allowed'), { code: 'SSH_KEY_CHANGED' });
      }
    }
    sourcePath = await realpath(requestedPath);
    if (approvedRoot && path.dirname(sourcePath) !== approvedRoot) {
      throw Object.assign(new Error('Managed SSH key changed'), { code: 'SSH_KEY_CHANGED' });
    }
    if (rejectSymlinkPath && sourcePath !== requestedPath) {
      throw Object.assign(new Error('Managed SSH key symlinks are not allowed'), { code: 'SSH_KEY_CHANGED' });
    }
    sourceHandle = await fsImpl.open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stats = await sourceHandle.stat({ bigint: true });
    if (!stats.isFile() || stats.size < 1n || stats.size > BigInt(MAX_SSH_PRIVATE_KEY_BYTES)) {
      throw Object.assign(new Error('Not an SSH private key'), { code: 'SSH_KEY_NOT_PRIVATE' });
    }
    if (requestedStats && (requestedStats.dev !== stats.dev || requestedStats.ino !== stats.ino)) {
      throw Object.assign(new Error('Managed SSH key changed'), { code: 'SSH_KEY_CHANGED' });
    }
    const identity = sourceIdentity(stats);
    if (expectedSourceIdentity && identity !== expectedSourceIdentity) {
      throw Object.assign(new Error('Managed SSH key changed'), { code: 'SSH_KEY_CHANGED' });
    }
    privateKey = await sourceHandle.readFile();
    if (!SSH_PRIVATE_KEY_MARKER.test(privateKey.subarray(0, 512).toString('ascii'))) {
      throw Object.assign(new Error('Not an SSH private key'), { code: 'SSH_KEY_NOT_PRIVATE' });
    }
    if (requirePrivateMode && process.platform !== 'win32' && Number(stats.mode & 0o077n) !== 0) {
      throw Object.assign(new Error('SSH private key permissions are too broad'), { code: 'SSH_KEY_INSECURE_PERMISSIONS' });
    }
    requestedStats = identity;
  } catch (error) {
    privateKey?.fill(0);
    if (['SSH_KEY_CHANGED', 'SSH_KEY_NOT_PRIVATE', 'SSH_KEY_INSECURE_PERMISSIONS'].includes(error?.code)) throw error;
    throw Object.assign(new Error('Managed SSH key is unavailable'), { code: 'SSH_KEY_UNREADABLE' });
  } finally {
    await sourceHandle?.close().catch(() => {});
  }

  const safeOperationId = requiredString(operationId, 'operation ID').replace(/[^A-Za-z0-9_-]/g, '_');
  const snapshotPath = path.join(snapshotRoot, `${safeOperationId}.key`);
  let snapshotIdentity;
  let snapshotCreated = false;
  let snapshotHandle;
  let publicKey;
  let fingerprintOutput;
  try {
    await fsImpl.mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
    const rootStats = await fsImpl.lstat(snapshotRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error('Managed SSH key snapshot directory is invalid');
    }
    if (process.platform !== 'win32') await fsImpl.chmod(snapshotRoot, 0o700);
    snapshotHandle = await fsImpl.open(snapshotPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    snapshotCreated = true;
    await snapshotHandle.writeFile(privateKey);
    snapshotIdentity = fileIdentity(await snapshotHandle.stat());
    await snapshotHandle.chmod(0o600);
  } catch (error) {
    if (snapshotCreated && !snapshotIdentity) {
      snapshotIdentity = await snapshotHandle.stat().then(fileIdentity, () => null);
    }
    await snapshotHandle?.close().catch(() => {});
    snapshotHandle = null;
    if (snapshotCreated && (!snapshotIdentity || !await removeOwnedFile(snapshotPath, snapshotIdentity, fsImpl))) {
      throw new Error('Managed SSH key cleanup failed');
    }
    throw new Error('Managed SSH key snapshot failed', { cause: error });
  } finally {
    await snapshotHandle?.close().catch(() => {});
    privateKey.fill(0);
  }
  try {
    publicKey = (await execute('ssh-keygen', ['-y', '-P', '', '-f', snapshotPath], { deadline, controls })).stdout;
    fingerprintOutput = (await execute('ssh-keygen', ['-lf', '-', '-E', 'sha256'], { input: publicKey, deadline, controls })).stdout;
  } catch (error) {
    if (!await removeOwnedFile(snapshotPath, snapshotIdentity, fsImpl)) throw new Error('Managed SSH key cleanup failed');
    if (['EACCES', 'EPERM', 'ENOENT'].includes(error?.code)) {
      throw new Error('Managed SSH key verification is unavailable', { cause: error });
    }
    throw Object.assign(new Error('Managed SSH key is encrypted or unverifiable'), { code: 'SSH_KEY_UNVERIFIABLE' });
  }
  const derived = String(fingerprintOutput).match(/\b(SHA256:[A-Za-z0-9+/]{43}=?)(?:\s|$)/)?.[1];
  if (!derived) {
    if (!await removeOwnedFile(snapshotPath, snapshotIdentity, fsImpl)) throw new Error('Managed SSH key cleanup failed');
    throw Object.assign(new Error('Managed SSH key is encrypted or unverifiable'), { code: 'SSH_KEY_UNVERIFIABLE' });
  }
  return Object.freeze({
    privateKeyPath: snapshotPath,
    snapshotIdentity,
    sourcePath,
    sourceIdentity: requestedStats,
    fingerprint: derived,
    cleanup: () => removeOwnedFile(snapshotPath, snapshotIdentity, fsImpl),
  });
};

const verifiedSshKey = async ({ record, realpath, execute, fsImpl, snapshotRoot, operationId, deadline, controls }) => {
  if (!isPlainObject(record)
    || !hasExactRecord(record, ['id', 'privateKeyPath', 'fingerprint'])
    || record.id !== operationId.keyId) throw new Error('Managed SSH key is unavailable');
  const storedFingerprint = requiredString(record.fingerprint, 'SSH fingerprint');
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(storedFingerprint)) throw new Error('Managed SSH key fingerprint is invalid');
  const key = await snapshotSshPrivateKey({
    privateKeyPath: record.privateKeyPath,
    realpath,
    execute,
    fsImpl,
    snapshotRoot,
    operationId: operationId.value,
    deadline,
    controls,
  });
  if (key.fingerprint !== storedFingerprint) {
    if (!await key.cleanup()) throw new Error('Managed SSH key cleanup failed');
    throw Object.assign(new Error('Managed SSH key fingerprint does not match'), { code: 'SSH_KEY_FINGERPRINT_MISMATCH' });
  }
  return key;
};

const hasExactRecord = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

export async function inspectManagedSshCredential(record, { snapshotRoot, fsImpl = fs, executeFile = runFile, deadline = Date.now() + 10_000 } = {}) {
  let key;
  try {
    key = await verifiedSshKey({ record, realpath: fsImpl.realpath, execute: executeFile, fsImpl,
      snapshotRoot, operationId: { value: `inventory_${randomUUID()}`, keyId: record.id }, deadline });
  } catch (error) {
    if (error?.code === 'SSH_KEY_UNREADABLE') return { status: 'unavailable', reason: 'unreadable' };
    if (error?.code === 'SSH_KEY_UNVERIFIABLE') return { status: 'unavailable', reason: 'encrypted-or-unverifiable' };
    if (error?.code === 'SSH_KEY_FINGERPRINT_MISMATCH') return { status: 'unavailable', reason: 'fingerprint-mismatch' };
    throw new Error('Managed SSH credential inspection failed');
  }
  if (!await key.cleanup()) throw new Error('Managed SSH credential inspection cleanup failed');
  return { status: 'ready' };
}

const assertHttpsEndpoint = (reference, endpoint) => {
  if (endpoint.protocol !== 'https') throw new Error('Managed HTTPS credentials require HTTPS');
  if (reference.provider === 'github' && reference.instance !== 'github.com') {
    throw new Error('Invalid managed provider instance');
  }
  let instance;
  try {
    instance = new URL(reference.provider === 'github' ? 'https://github.com' : reference.instance);
  } catch {
    throw new Error('Invalid managed provider instance');
  }
  const instancePort = instance.port ? Number(instance.port) : 443;
  if (instance.protocol !== 'https:' || instance.hostname.toLowerCase() !== endpoint.host || instancePort !== endpoint.port) {
    throw new Error('Git endpoint is outside the managed credential policy');
  }
};

export function createGitCredentialResolver({
  readGitHubAccount,
  readGitLabAccount,
  lookupManagedSshKey,
  realpath = fs.realpath,
  executeFile = runFile,
  fsImpl = fs,
  snapshotRoot = path.join(os.tmpdir(), 'openchamber-git-ssh'),
} = {}) {
  return Object.freeze({
    resolve: async (input) => {
      const { mode, credentialId, endpoint: rawEndpoint, operationId, deadline, controls } = input;
      if (mode === 'system') return Object.freeze({ mode: 'system' });
      if (mode === 'anonymous') {
        if (Object.keys(input).some((key) => !['mode', 'endpoint', 'operationId', 'deadline', 'controls'].includes(key))
          || normalizeGitCredentialEndpoint(rawEndpoint).protocol !== 'https') {
          throw new Error('Anonymous Git transport requires credential-free HTTPS');
        }
        return Object.freeze({ mode: 'anonymous' });
      }
      if (mode !== 'managed') throw new Error('Invalid Git credential mode');
      const reference = parseGitCredentialReference(credentialId);
      const endpoint = normalizeGitCredentialEndpoint(rawEndpoint);

      if (reference.transport === 'ssh') {
        if (endpoint.protocol !== 'ssh') throw new Error('Managed SSH credential requires SSH');
        if (!(lookupManagedSshKey instanceof Function)) throw new Error('Managed SSH credentials are unavailable');
        const key = await verifiedSshKey({
          record: await lookupManagedSshKey(reference.keyId),
          realpath,
          execute: executeFile,
          fsImpl,
          snapshotRoot,
          operationId: { value: operationId, keyId: reference.keyId },
          deadline,
          controls,
        });
        return Object.freeze({ mode: 'managed', transport: 'ssh', key, allowedEndpoint: endpoint });
      }

      assertHttpsEndpoint(reference, endpoint);
      const readAccount = reference.provider === 'github' ? readGitHubAccount : readGitLabAccount;
      if (!(readAccount instanceof Function)) throw new Error('Managed HTTPS credentials are unavailable');
      const resolvedCredentialId = reference.credentialId;
      const credentialRevision = reference.credentialRevision;
      const account = reference.provider === 'github'
        ? await readAccount(resolvedCredentialId, credentialRevision)
        : await readAccount(reference.instance, resolvedCredentialId, credentialRevision);
      const password = reference.provider === 'github' ? account?.accessToken : account?.token;
      const storedId = account?.credentialId;
      const storedRevision = account?.credentialRevision;
      const providerUserId = account?.providerUserId;
      if (storedId !== resolvedCredentialId
        || account?.status !== 'valid'
        || (credentialRevision !== undefined && storedRevision !== credentialRevision)
        || (reference.version === 2 && reference.providerUserId !== undefined
          && reference.providerUserId !== providerUserId)
        || !isString(providerUserId) || !providerUserId
        || !isString(password) || !password || /[\r\n\0]/.test(password)) {
        throw new Error('Managed provider account is unavailable');
      }
      const login = account?.user?.login ?? account?.user?.username;
      return Object.freeze({
        mode: 'managed',
        transport: 'https',
        username: reference.provider === 'github' ? 'x-access-token' : 'oauth2',
        password,
        actor: Object.freeze({
          provider: reference.provider,
          instance: reference.instance,
          accountId: providerUserId,
          login: isString(login) && login ? login : null,
        }),
        allowedEndpoint: endpoint,
      });
    },
  });
}
