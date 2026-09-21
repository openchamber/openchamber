import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import { createGitCredentialBroker } from './credential-broker.js';
import { gitLfsCredentialEndpointAliases, normalizeGitRemoteEndpoint, parseGitCredentialReference } from './credential-resolver.js';
import { createNetworkOperationPlanner } from './network-operation-plan.js';
import { createNetworkOperationRegistry } from './network-operation-registry.js';
import { createGitRedactor, redactGitText } from './redaction.js';
import { parseSubmoduleManifest, SUBMODULE_DISCOVERY_LIMITS } from './submodule-discovery.js';
import { discoverLfs, scanLfsFiles, scanLfsPushObjects, resolveLfsPushConfig, LFS_DISCOVERY_LIMITS } from './lfs-discovery.js';
import { resolveGitRelativeEndpoint } from './discovery-endpoint.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from '../source-control/url-redaction.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const SSH_WRAPPER_PATH = fileURLToPath(new URL('./ssh-wrapper.js', import.meta.url));
const MANAGED_ENV_NAMES = new Set([
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GIT_PROXY_COMMAND', 'SSH_AUTH_SOCK', 'OPENCHAMBER_GIT_SSH_KEY',
  'GIT_SSL_CERT', 'GIT_SSL_KEY', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
  'GIT_SSL_CIPHER_LIST', 'GIT_SSL_VERSION', 'GIT_SSL_NO_VERIFY',
  'GIT_SSL_CERT_PASSWORD_PROTECTED', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'SSLKEYLOGFILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NETRC',
]);
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';

const operationError = (code, message, status = 500, details = {}) => Object.assign(new Error(message), { code, status, ...details });
const publicError = (code, message) => ({ code, message });
const terminal = (state, code, message) => ({ state, error: publicError(code, message) });
const fileIdentity = (stats) => `${stats.dev}:${stats.ino}`;
// Linux reuses an inode number when a directory is removed and recreated in the
// same parent, so device and inode alone cannot tell a replaced directory from
// the one we made. Creation time can, but only where the filesystem keeps one:
// without it Node fills the field from the change time, which moves whenever
// entries are written into the directory, and every clone would then look
// replaced the moment it filled its own checkout. So change the directory once
// on purpose and see whether the reported creation time sits still. A
// filesystem that fails this, or answers too coarsely to tell, falls back to
// device and inode rather than to a false conflict.
const birthtimeHoldsStill = async (fsImpl, pathImpl, directory) => {
  const probe = pathImpl.join(directory, '.openchamber-clone-probe');
  try {
    const before = await fsImpl.stat(directory);
    await fsImpl.mkdir(probe);
    await fsImpl.rm(probe, { recursive: true });
    const after = await fsImpl.stat(directory);
    return after.ctimeMs !== before.ctimeMs && after.birthtimeMs === before.birthtimeMs;
  } catch {
    await fsImpl.rm(probe, { recursive: true, force: true }).catch(() => {});
    return false;
  }
};
const directoryIdentity = (stats, birthtimeHolds) => (birthtimeHolds
  ? `${fileIdentity(stats)}:${stats.birthtimeMs}` : fileIdentity(stats));
const lstatSnapshot = (stats) => ({
  identity: fileIdentity(stats),
  mode: stats.mode,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
});
const sameLstat = (stats, snapshot) => stats
  && fileIdentity(stats) === snapshot.identity
  && stats.mode === snapshot.mode
  && stats.size === snapshot.size
  && stats.mtimeMs === snapshot.mtimeMs
  && stats.ctimeMs === snapshot.ctimeMs;
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const contentDigest = (value) => crypto.createHash('sha256').update(value).digest('base64url');
const publicTransportForContributor = () => ({
  mode: 'managed', verification: { status: 'verified', method: 'credential' },
});

const managedEnvironment = (source, platform) => {
  const result = { ...source };
  for (const name of Object.keys(result)) {
    const normalized = platform === 'win32' ? name.toUpperCase() : name;
    if (MANAGED_ENV_NAMES.has(normalized)
      || /^GIT_CONFIG_(?:KEY|VALUE)_/.test(normalized)
      || /^GIT_TRACE(?:2)?(?:_|$)/.test(normalized)
      || normalized === 'GIT_CURL_VERBOSE'
      || normalized === 'GIT_REDIRECT_STDERR'
      || /^CURL_/.test(normalized)) delete result[name];
  }
  result.GIT_TERMINAL_PROMPT = '0';
  result.GIT_CONFIG_NOSYSTEM = '1';
  result.GIT_CONFIG_GLOBAL = platform === 'win32' ? 'NUL' : '/dev/null';
  return result;
};

const HTTP_CONFIG_RESETS = new Map([
  ['proxy', ''],
  ['sslverify', 'true'],
  ['sslcainfo', ''],
  ['sslcapath', ''],
  ['sslcert', ''],
  ['sslcerttype', ''],
  ['sslcertpasswordprotected', 'false'],
  ['sslkey', ''],
  ['sslkeytype', ''],
  ['extraheader', ''],
  ['cookiefile', ''],
  ['savecookies', 'false'],
  ['followredirects', 'false'],
  ['emptyauth', 'false'],
  ['delegation', 'none'],
  ['sslautoclientcert', 'false'],
]);
const CREDENTIAL_CONFIG_RESETS = new Map([
  ['helper', ''],
  ['askpass', ''],
  ['username', ''],
  ['interactive', 'false'],
  ['usehttppath', 'false'],
]);
const configResetValue = (key) => {
  const normalized = key.toLowerCase();
  const suffix = normalized.slice(normalized.lastIndexOf('.') + 1);
  if (normalized.startsWith('http.')) return HTTP_CONFIG_RESETS.get(suffix);
  if (normalized.startsWith('credential.')) return CREDENTIAL_CONFIG_RESETS.get(suffix);
  return undefined;
};

const terminateProcessTree = (child, { platform, spawnImpl, escalationMs }) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (platform === 'win32' && Number.isInteger(child.pid)) {
      const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/t'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      killer.unref?.();
    } else if (Number.isInteger(child.pid)) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    } else {
      try { child.kill('SIGTERM'); } catch {}
    }
  } catch {}
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode) return;
    try {
      if (platform === 'win32' && Number.isInteger(child.pid)) {
        const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        });
        killer.unref?.();
      } else if (Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
      } else {
        try { child.kill('SIGKILL'); } catch {}
      }
    } catch {}
  }, escalationMs);
  timer.unref?.();
  child.once?.('close', () => clearTimeout(timer));
};

const appendBounded = (chunks, chunk, state, limit) => {
  if (state.bytes >= limit) return;
  const value = Buffer.from(chunk);
  const remaining = limit - state.bytes;
  chunks.push(value.subarray(0, remaining));
  state.bytes += Math.min(value.length, remaining);
};

const authorityCode = (error) => {
  if (error?.code === 'SOURCE_CONTROL_BINDING_STALE') return 'STALE_BINDING';
  if (error?.code === 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY') return 'STALE_REPOSITORY';
  if (error?.code === 'INVALID_GIT_TRANSPORT_CONTEXT') return 'INVALID_REQUEST';
  return 'REMOTE_CHANGED';
};
const transportFailureCode = (text) => /authentication failed|permission denied|could not read username/i.test(text)
  ? 'AUTHENTICATION_FAILED' : 'TRANSPORT_FAILED';
const isLeaseConflict = (text) => /stale info|force-with-lease|rejected.*stale/i.test(text);

const phaseError = (controls, deadline) => {
  if (controls?.isCancellationRequested()) {
    return operationError('CANCELLED', 'Git network operation was cancelled', 499, { cancelled: true });
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return operationError('TIMEOUT', 'Git network operation timed out', 408, { timedOut: true });
  }
  return null;
};

const awaitPhase = (work, controls, deadline) => {
  const blocked = phaseError(controls, deadline);
  if (blocked) return Promise.reject(blocked);
  const remaining = deadline - Date.now();
  const pending = Promise.resolve().then(work);
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      callback(value);
    };
    const timer = setTimeout(() => finish(reject,
      operationError('TIMEOUT', 'Git network operation timed out', 408, { timedOut: true })), remaining);
    timer.unref?.();
    unsubscribe = controls?.onCancellationRequested?.(() => finish(reject,
      operationError('CANCELLED', 'Git network operation was cancelled', 499, { cancelled: true }))) ?? unsubscribe;
    pending.then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
};

const awaitMutation = async (work, controls, deadline, record = async () => {}) => {
  const blocked = phaseError(controls, deadline);
  if (blocked) throw blocked;
  const value = await work();
  await record(value);
  const interrupted = phaseError(controls, deadline);
  if (interrupted) throw interrupted;
  return value;
};

export function createNetworkOperations({
  validateGitTransportContext,
  validateManagedSshCredential,
  resolveSourceControlAccount,
  systemPushAcknowledgements,
  contributorProvenance,
  resolveRef,
  resolveSymbolicRef,
  resolveRemoteFetchMapping,
  credentialResolver,
  runtimeIdentity,
  credentialBroker,
  registry,
  spawnImpl = spawn,
  fsImpl = fs,
  pathImpl = path,
  gitBinary = 'git',
  inheritedEnv = process.env,
  platform = process.platform,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputLimitBytes = DEFAULT_OUTPUT_BYTES,
  escalationMs = 1_000,
  validateGitIdentity,
  resolveGitIdentity,
  applyGitIdentity,
  bindClonedRepository,
  inspectMergeState,
  enumerateManagedConfigKeys,
  resolveChangeRequestSource,
  validateGitAuxiliaryContext,
  idFactory,
  auditStore,
  operationStore,
  onCheckoutHydrated,
} = {}) {
  if (!(validateGitTransportContext instanceof Function) || !(credentialResolver?.resolve instanceof Function)) {
    throw new TypeError('Git network operation dependencies are invalid');
  }

  const cancelChild = (child) => terminateProcessTree(child, { platform, spawnImpl, escalationMs });
  const operationRegistry = registry ?? createNetworkOperationRegistry({ cancelChild, store: operationStore });
  if (auditStore && (!(auditStore.plan instanceof Function)
    || !(auditStore.start instanceof Function) || !(auditStore.finish instanceof Function))) {
    throw new TypeError('Git network operation audit store is invalid');
  }
  let brokerStart = null;
  const startBroker = () => {
    credentialBroker ??= createGitCredentialBroker();
    brokerStart ??= credentialBroker.start().catch((error) => {
      brokerStart = null;
      throw error;
    });
    return brokerStart;
  };

  const run = async ({
    binary = gitBinary,
    cwd,
    args,
    env,
    controls,
    deadline,
    input,
    allowAfterCancellation = false,
    transfer = false,
    transferRole,
    maxOutputBytes = outputLimitBytes,
    rawOutput = false,
    requireCompleteOutput = false,
  }) => {
    if (transfer) await controls?.markTransferStarted(transferRole);
    return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      reject(operationError('TIMEOUT', 'Git network operation timed out', 408, { timedOut: true }));
      return;
    }
    let child;
    try {
      child = spawnImpl(binary, args, {
        cwd, env, shell: false, windowsHide: true, detached: platform !== 'win32',
        stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout = [];
    const stderr = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let timedOut = false;
    let settled = false;
    let outputExceeded = false;
    let inputError;
    child.stdout?.on('data', (chunk) => {
      if (requireCompleteOutput && !outputExceeded && stdoutState.bytes + chunk.length > maxOutputBytes) {
        outputExceeded = true;
        cancelChild(child);
      }
      appendBounded(stdout, chunk, stdoutState, maxOutputBytes);
    });
    child.stderr?.on('data', (chunk) => appendBounded(stderr, chunk, stderrState, outputLimitBytes));
    const timer = setTimeout(() => {
      timedOut = true;
      cancelChild(child);
    }, remaining);
    timer.unref?.();
    const settle = (error, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      controls?.detachChild(child);
      const result = {
        code,
        signal,
        timedOut,
        cancelled: controls?.isCancellationRequested() ?? false,
        stdout: rawOutput ? Buffer.concat(stdout) : Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (outputExceeded) reject(operationError('LFS_DISCOVERY_LIMIT_EXCEEDED', 'Checkout discovery output exceeds its byte limit', 409,
        { cancelled: result.cancelled, timedOut: result.timedOut }));
      else if (error || inputError) reject(Object.assign(error || inputError, result));
      else resolve(result);
    };
    child.once('error', (error) => settle(error, null, null));
    child.once('close', (code, signal) => settle(null, code, signal));
    try {
      controls?.attachChild(child, { allowAfterCancellation });
    } catch (error) {
      cancelChild(child);
      settle(error, null, null);
      return;
    }
    if (input !== undefined) {
      child.stdin?.on('error', (error) => {
        inputError = error;
        cancelChild(child);
      });
      child.stdin?.end(input);
    }
    });
  };

  const queryGit = async (directory, args, { controls, deadline = Date.now() + timeoutMs } = {}) => {
    const result = await run({
      cwd: directory,
      args,
      env: { ...inheritedEnv, GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
      controls,
      deadline,
    });
    if (result.code !== 0 || result.timedOut || result.cancelled) {
      throw operationError(result.timedOut ? 'TIMEOUT' : 'STALE_CONFIG',
        redactGitText(result.stderr) || 'Git repository state is unavailable', 409, result);
    }
    return result.stdout.trim();
  };
  const resolveRefImpl = resolveRef ?? ((directory, ref, options) => queryGit(
    directory,
    ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
    options,
  ));
  const resolveSymbolicRefImpl = resolveSymbolicRef ?? ((directory, options) => queryGit(
    directory,
    ['symbolic-ref', '-q', 'HEAD'],
    options,
  ));
  const enumerateManagedConfigKeysImpl = enumerateManagedConfigKeys ?? (async (plan, controls, deadline, env) => {
    const result = await run({
      cwd: plan.directory ?? pathImpl.dirname(plan.destination),
      args: ['config', '--includes', '--name-only', '--get-regexp', plan.transportMode === 'anonymous' ? '^(http|credential|url)\\.' : '^(http|credential)\\.'],
      requireCompleteOutput: true,
      env,
      controls,
      deadline,
    });
    if (result.code !== 0 && result.code !== 1) {
      throw operationError('STALE_CONFIG', 'Managed Git transport configuration is unavailable', 409);
    }
    return result.stdout.split(/\r?\n/).filter(Boolean);
  });
  const resolveRemoteFetchMappingImpl = resolveRemoteFetchMapping ?? (async (directory, remoteName, { controls, deadline = Date.now() + timeoutMs } = {}) => {
    let result;
    try {
      result = await run({
        cwd: directory, args: ['config', '--includes', '--null', '--get-all', `remote.${remoteName}.fetch`],
        env: { ...inheritedEnv, GIT_CONFIG: undefined }, controls, deadline,
        maxOutputBytes: 8192, requireCompleteOutput: true,
      });
    } catch (error) {
      if (error.cancelled || error.timedOut) throw error;
      throw operationError('STALE_CONFIG', 'Remote Fetch configuration is unavailable', 409);
    }
    if (result.cancelled || result.timedOut || (result.code !== 0 && result.code !== 1)) {
      throw operationError('STALE_CONFIG', 'Remote Fetch configuration is unavailable', 409, result);
    }
    return result.stdout;
  });
  const planner = createNetworkOperationPlanner({
    validateGitTransportContext,
    validateManagedSshCredential,
    resolveSourceControlAccount,
    systemPushAcknowledgements,
    contributorProvenance,
    resolveRef: resolveRefImpl,
    resolveSymbolicRef: resolveSymbolicRefImpl,
    resolveRemoteFetchMapping: resolveRemoteFetchMappingImpl,
    inspectCheckoutHydration: (input) => inspectCheckoutHydration(input),
    runtimeIdentity,
    idFactory,
    fsImpl,
    pathImpl,
  });

  const revalidate = async (plan, controls, deadline) => {
    if (plan.contributorAuthority) {
      const record = await awaitPhase(() => contributorProvenance.read(plan.directory), controls, deadline);
      if (record.worktreeId !== plan.contributorAuthority.worktreeId
        || record.revision !== plan.contributorAuthority.revision
        || record.provenance?.kind !== 'contributor-fork') {
        throw operationError('STALE_CONFIG', 'Contributor worktree provenance changed', 409);
      }
    }
    let authority;
    try {
      authority = await awaitPhase(() => validateGitTransportContext({
        directory: plan.directory,
        repositoryId: plan.target.repositoryId,
        bindingRevision: plan.target.bindingRevision,
        configRevision: plan.target.configRevision,
        remote: plan.target.remote.name,
        endpointKind: plan.endpointKind,
      }), controls, deadline);
    } catch (error) {
      if (error?.cancelled || error?.timedOut) throw error;
      throw operationError(authorityCode(error), 'Git network operation authority changed', error?.status ?? 409);
    }
    if (authority.endpoint !== plan.rawEndpoint
      || authority.endpointFingerprint !== plan.target.remote.endpoint.fingerprint
      || authority.transportMode !== plan.transportMode
      || authority.transportRevision !== plan.transportRevision
      || (authority.credentialId ?? null) !== (plan.credentialId ?? null)) {
      throw operationError('REMOTE_CHANGED', 'Git remote or transport binding changed', 409);
    }
    if (plan.sourceSha) {
      const sourceSha = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, plan.target.sourceRef, { controls, deadline }), controls, deadline,
      )).toLowerCase();
      if (!SHA_PATTERN.test(sourceSha) || sourceSha !== plan.sourceSha) {
        throw operationError('STALE_CONFIG', 'Git source ref changed after planning', 409);
      }
    }
    if (plan.target.operation === 'fetch' && plan.target.fetchScope === 'remote') {
      const output = await awaitPhase(
        () => resolveRemoteFetchMappingImpl(plan.directory, plan.target.remote.name, { controls, deadline }), controls, deadline,
      );
      if (output !== `${plan.fetchRefspec}\0`) {
        throw operationError('STALE_CONFIG', 'Remote Fetch mapping changed after planning', 409);
      }
    }
  };
  const revalidateContributorSource = async (plan, controls, deadline) => {
    if (!(resolveChangeRequestSource instanceof Function)) {
      throw operationError('RUNTIME_UNSUPPORTED', 'Contributor source resolution is unavailable', 501);
    }
    let current;
    try {
      current = await awaitPhase(() => resolveChangeRequestSource(plan.sourceRequest), controls, deadline);
    } catch (error) {
      if (error?.status === 409 || String(error?.code || '').includes('STALE')
        || String(error?.code || '').includes('BINDING')) {
        throw operationError('STALE_CONFIG', 'Change request source authority changed', 409);
      }
      if (error?.code === 'MALFORMED_PROVIDER_RESPONSE') {
        throw operationError('UNKNOWN', 'Change request source response was invalid', 502);
      }
      throw error;
    }
    if (current.context.repositoryId !== plan.sourceAuthority.repositoryId
      || current.context.bindingRevision !== plan.sourceAuthority.bindingRevision
      || current.context.accountId !== plan.sourceAuthority.accountId
      || current.context.instance !== plan.sourceAuthority.instance
      || current.context.primaryRemote !== plan.sourceAuthority.primaryRemote
      || current.sourceProject.id !== plan.sourceAuthority.sourceProjectId
      || current.headSha !== plan.expectedSha || current.headRef !== plan.target.sourceRef
      || current.endpoint !== plan.rawEndpoint) {
      throw operationError('STALE_CONFIG', 'Change request source changed', 409);
    }
  };

  const revalidatePullHead = async (plan, controls, deadline) => {
    const headRef = await awaitPhase(() => resolveSymbolicRefImpl(plan.directory, { controls, deadline }), controls, deadline);
    const headSha = await awaitPhase(() => resolveRefImpl(plan.directory, plan.target.destinationRef, { controls, deadline }), controls, deadline);
    if (headRef !== plan.target.destinationRef || String(headSha).toLowerCase() !== plan.destinationSha) {
      throw operationError('STALE_CONFIG', 'Checked out branch changed after pull planning', 409);
    }
  };
  const hasMergeState = inspectMergeState ?? (async (directory) => {
    const dotGit = pathImpl.join(directory, '.git');
    let gitDirectory = dotGit;
    const stats = await fsImpl.stat(dotGit);
    if (!stats.isDirectory()) {
      const contents = await fsImpl.readFile(dotGit, 'utf8');
      const match = contents.match(/^gitdir: (.+)\s*$/);
      if (!match) return false;
      gitDirectory = pathImpl.resolve(directory, match[1]);
    }
    try {
      await fsImpl.stat(pathImpl.join(gitDirectory, 'MERGE_HEAD'));
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  });

  const transport = async (plan, controls, deadline) => {
    const anonymous = plan.transportMode === 'anonymous';
    if (anonymous && (plan.credentialId !== undefined || !['fetch', 'pull', 'clone'].includes(plan.target.operation))) {
      throw operationError('INVALID_REQUEST', 'Anonymous Git transport is read-only and credential-free', 400);
    }
    if (anonymous && normalizeGitRemoteEndpoint(plan.rawEndpoint).protocol !== 'https') {
      throw operationError('RUNTIME_UNSUPPORTED', 'Anonymous Git transport requires HTTPS', 501);
    }
    if (plan.transportMode === 'system') return {
      env: { ...inheritedEnv }, configArgs: [], revoke: async () => {}, secrets: [],
    };
    let credential;
    try {
      if (!anonymous) credential = await awaitPhase(() => credentialResolver.resolve({
        mode: 'managed',
        credentialId: plan.credentialId,
        endpoint: normalizeGitRemoteEndpoint(plan.rawEndpoint),
        operationId: plan.operationId,
        deadline,
        controls,
      }), controls, deadline);
    } catch (error) {
      if (error?.cancelled || error?.timedOut || error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') throw error;
      throw operationError('AUTHENTICATION_REQUIRED', 'Managed Git credential is unavailable', 409);
    }
    const env = managedEnvironment(inheritedEnv, platform);
    if (anonymous) {
      // Git's Curl transport also consults netrc outside Git configuration.
      for (const name of Object.keys(env)) {
        if (['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'HOMEDRIVE', 'HOMEPATH'].includes(name.toUpperCase())) delete env[name];
      }
      env.HOME = env.USERPROFILE = env.XDG_CONFIG_HOME = platform === 'win32' ? 'NUL' : '/dev/null';
      env.GIT_ALLOW_PROTOCOL = 'https';
      env.GIT_NO_LAZY_FETCH = '1';
      env.GIT_LFS_SKIP_SMUDGE = '1';
    }
    const configArgs = [
      '-c', 'core.askPass=',
      '-c', 'credential.helper=',
      '-c', 'http.followRedirects=false',
      '-c', `core.hooksPath=${platform === 'win32' ? 'NUL' : '/dev/null'}`,
    ];
    if (anonymous || credential.transport === 'https') {
      const configuredKeys = await awaitPhase(
        () => enumerateManagedConfigKeysImpl(plan, controls, deadline, env), controls, deadline,
      );
      if (anonymous && configuredKeys.some((key) => /^url\./i.test(key))) {
        throw operationError('RUNTIME_UNSUPPORTED', 'Anonymous transport does not support repository URL rewrites', 501);
      }
      if (plan.target.operation === 'contributor-fetch') await revalidateContributorSource(plan, controls, deadline);
      else if (plan.target.operation !== 'clone') await revalidate(plan, controls, deadline);
      const endpointHttpConfig = `http.${plan.rawEndpoint}`;
      configArgs.push(
        '-c', 'http.proxy=',
        '-c', 'http.sslVerify=true',
        '-c', 'http.extraHeader=',
        '-c', 'http.cookieFile=',
        '-c', 'http.saveCookies=false',
        '-c', 'http.emptyAuth=false',
        '-c', 'http.delegation=none',
        '-c', 'http.sslAutoClientCert=false',
        '-c', 'credential.username=',
        '-c', 'credential.interactive=false',
        '-c', 'submodule.recurse=false',
        '-c', 'fetch.recurseSubmodules=false',
        '-c', `${endpointHttpConfig}.proxy=`,
        '-c', `${endpointHttpConfig}.sslVerify=true`,
        '-c', `${endpointHttpConfig}.followRedirects=false`,
        '-c', `${endpointHttpConfig}.extraHeader=`,
        '-c', `${endpointHttpConfig}.cookieFile=`,
        '-c', `${endpointHttpConfig}.saveCookies=false`,
        '-c', `${endpointHttpConfig}.emptyAuth=false`,
        '-c', `${endpointHttpConfig}.delegation=none`,
        '-c', `${endpointHttpConfig}.sslAutoClientCert=false`,
      );
      for (const key of configuredKeys) {
        const reset = configResetValue(key);
        if (reset !== undefined) configArgs.push('-c', `${key}=${reset}`);
      }
      if (anonymous) return { env, configArgs, revoke: async () => true, secrets: [] };
      await awaitPhase(startBroker, controls, deadline);
      const lease = credentialBroker.issue({
        operationId: plan.operationId,
        credential,
        endpointAliases: plan.auxiliaryKind === 'lfs' ? gitLfsCredentialEndpointAliases(credential.allowedEndpoint) : [],
      });
      if (credential.actor) controls.updateTransportMetadata(credential.actor, plan.transportRole);
      configArgs.push(...lease.gitConfigArgs);
      return {
        env,
        configArgs,
        revoke: async () => { try { lease.revoke(); return true; } catch { return false; } },
        secrets: [credential.password, ...(lease.redactionSecrets ?? [])],
      };
    }
    if (credential.transport !== 'ssh') {
      throw operationError('AUTHENTICATION_REQUIRED', 'Managed Git credential is unavailable', 409);
    }
    env.OPENCHAMBER_GIT_SSH_KEY = credential.key.privateKeyPath;
    env.GIT_SSH_COMMAND = `${shellQuote(process.execPath)} ${shellQuote(SSH_WRAPPER_PATH)}`;
    env.GIT_SSH_VARIANT = 'ssh';
    controls.updateTransportMetadata({ fingerprint: credential.key.fingerprint }, plan.transportRole);
    return {
      env,
      configArgs,
      revoke: async () => {
        try { return credential.key.cleanup ? await credential.key.cleanup() : true; } catch { return false; }
      },
      secrets: [credential.key.sourcePath, credential.key.privateKeyPath],
    };
  };

  const commandResult = async (plan, controls, args, context, deadline, options = {}) => {
    const localRefCleanup = options.localRefCleanup === true
      && args.length === 3
      && args[0] === 'update-ref'
      && args[1] === '-d'
      && args[2] === `refs/openchamber/network/${plan.operationId}`;
    const result = await run({
      cwd: options.cwd ?? plan.directory,
      args: [...context.configArgs, ...args],
      env: context.env,
      controls,
      deadline,
      transfer: options.transfer === true,
      transferRole: options.transferRole,
      allowAfterCancellation: localRefCleanup,
    });
    if (result.code === 0 && !result.timedOut && (!result.cancelled || localRefCleanup)) return result;
    const redactor = createGitRedactor({
      secrets: [context.secrets, plan.directory, plan.destination, plan.temporaryDirectory].flat().filter(Boolean),
    });
    const detail = redactor.error(`${result.stderr}\n${result.stdout}`, 'Git transport failed');
    throw operationError(transportFailureCode(detail), detail, 500, result);
  };

  const localIntegrationContext = async (directory, controls, deadline) => {
    const env = {
      ...managedEnvironment(inheritedEnv, platform),
      GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_LFS_SKIP_SMUDGE: '1',
    };
    const configArgs = [
      '-c', `core.hooksPath=${platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'merge.autoStash=false',
      '-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.clean=', '-c', 'filter.lfs.required=false',
    ];
    const blocked = phaseError(controls, deadline);
    if (blocked) throw blocked;
    const filters = await run({
      cwd: directory, env, controls, deadline, requireCompleteOutput: true,
      args: ['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(process|smudge|clean|required)$'],
    });
    if (filters.cancelled || filters.timedOut) {
      throw operationError(filters.timedOut ? 'TIMEOUT' : 'CANCELLED', 'Local integration was interrupted', 409, filters);
    }
    if (![0, 1].includes(filters.code) || (filters.stdout && !filters.stdout.endsWith('\0'))) {
      throw operationError('STALE_CONFIG', 'Local Git filter configuration is unavailable', 409);
    }
    for (const key of filters.stdout.split('\0').filter(Boolean)) {
      if (!/^filter\.[^\0\r\n=]+\.(process|smudge|clean|required)$/i.test(key)) {
        throw operationError('STALE_CONFIG', 'Local Git filter configuration is invalid', 409);
      }
      configArgs.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`);
    }
    return { env, configArgs, secrets: [] };
  };

  const hydrationStatus = (submodules, lfs) => {
    const statuses = [...submodules, ...lfs].map((entry) => entry.status);
    if (!statuses.length || statuses.every((status) => status === 'not-needed')) return 'not-needed';
    for (const status of ['cancelled', 'invalid', 'client-missing', 'authorization-required', 'failed']) {
      if (statuses.includes(status)) return status;
    }
    return 'succeeded';
  };
  const hydrationError = (error) => {
    if (error?.code === 'RUNTIME_UNSUPPORTED') {
      return { status: 'failed', error: publicError('RUNTIME_UNSUPPORTED', 'Checkout hydration transport is unavailable') };
    }
    if (error?.cancelled || error?.timedOut || error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') {
      const timedOut = error?.timedOut || error?.code === 'TIMEOUT';
      return { status: 'cancelled', error: publicError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? 'Checkout hydration timed out' : 'Checkout hydration was cancelled') };
    }
    if (error?.code === 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED') {
      return { status: 'authorization-required', error: publicError('AUTHENTICATION_REQUIRED', 'This checkout endpoint requires an explicit credential grant') };
    }
    if (String(error?.code || '').includes('INVALID') || String(error?.code || '').includes('LIMIT_EXCEEDED')
      || error?.code === 'UNSAFE_LFS_EXECUTABLE_CONFIG') {
      return { status: 'invalid', error: publicError('INVALID_REQUEST', 'Checkout hydration configuration is invalid') };
    }
    return { status: 'failed', error: publicError('TRANSPORT_FAILED', 'Checkout hydration failed') };
  };
  const localGit = async (directory, args, controls, deadline, {
    input, allowedCodes = [0], disableLfsFilters = false,
    maxOutputBytes = outputLimitBytes, rawOutput = false,
  } = {}) => {
    const blocked = phaseError(controls, deadline);
    if (blocked) throw blocked;
    const filterArgs = disableLfsFilters ? [
      '-c', 'filter.lfs.process=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false',
    ] : [];
    const env = {
      ...inheritedEnv, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1',
      GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
    };
    const result = await run({
      cwd: directory,
      args: ['-c', `core.hooksPath=${platform === 'win32' ? 'NUL' : '/dev/null'}`, ...filterArgs, ...args],
      env,
      controls, deadline, input,
      maxOutputBytes, rawOutput, requireCompleteOutput: true,
    });
    if (!allowedCodes.includes(result.code) || result.cancelled || result.timedOut) {
      if (result.cancelled || result.timedOut) throw operationError(result.timedOut ? 'TIMEOUT' : 'CANCELLED', 'Checkout hydration was interrupted', result.timedOut ? 408 : 499, result);
      throw operationError('TRANSPORT_FAILED', 'Checkout hydration Git query failed', 500, result);
    }
    return result.stdout;
  };
  const currentAuxiliaryAuthority = async (hydrationPlan, kind, rawEndpoint, controls, deadline) => {
    const fingerprint = fingerprintRemoteUrl(rawEndpoint);
    const displayUrl = redactRemoteUrl(rawEndpoint);
    if (hydrationPlan.auxiliaryGrants) {
      const grant = hydrationPlan.auxiliaryGrants.find((candidate) => candidate.kind === kind
        && candidate.endpoint.fingerprint === fingerprint && candidate.endpoint.displayUrl === displayUrl);
      if (!grant) throw operationError('GIT_AUXILIARY_AUTHORIZATION_REQUIRED', 'Git auxiliary endpoint authorization is required', 409);
      return { endpoint: rawEndpoint, endpointFingerprint: fingerprint, transportMode: grant.transportMode, credentialId: grant.credentialId };
    }
    if (!(validateGitAuxiliaryContext instanceof Function) || !hydrationPlan.repositoryAuthority) {
      throw operationError('GIT_AUXILIARY_AUTHORIZATION_REQUIRED', 'Git auxiliary endpoint authorization is required', 409);
    }
    return await awaitPhase(() => validateGitAuxiliaryContext({
      ...hydrationPlan.repositoryAuthority,
      directory: hydrationPlan.directory,
      kind,
      rawEndpoint,
    }), controls, deadline);
  };
  const sameAuxiliaryAuthority = (left, right) => (left.endpoint ?? left.rawEndpoint) === (right.endpoint ?? right.rawEndpoint)
    && left.endpointFingerprint === right.endpointFingerprint
    && left.transportMode === right.transportMode
    && (left.credentialId ?? null) === (right.credentialId ?? null)
    && (left.transportRevision ?? null) === (right.transportRevision ?? null);
  const auxiliaryTransport = async (hydrationPlan, kind, rawEndpoint, controls, deadline) => {
    const pinned = hydrationPlan.plannedAuxiliaryAuthorities?.find((candidate) => candidate.kind === kind
      && candidate.rawEndpoint === rawEndpoint);
    if (hydrationPlan.plannedAuxiliaryAuthorities && !pinned) {
      throw operationError('GIT_AUXILIARY_AUTHORIZATION_REQUIRED', 'Git auxiliary endpoint authorization is required', 409);
    }
    const authority = pinned ?? await currentAuxiliaryAuthority(hydrationPlan, kind, rawEndpoint, controls, deadline);
    if (pinned) {
      const current = await currentAuxiliaryAuthority(hydrationPlan, kind, rawEndpoint, controls, deadline);
      if (!sameAuxiliaryAuthority(authority, current)) {
        throw operationError('REMOTE_CHANGED', 'Git auxiliary endpoint grant changed', 409);
      }
    }
    const auxiliaryPlan = {
      operationId: hydrationPlan.operationId,
      directory: hydrationPlan.directory,
      rawEndpoint,
      transportMode: authority.transportMode,
      credentialId: authority.credentialId,
      auxiliaryKind: kind,
      target: { operation: 'clone' },
    };
    const context = await transport(auxiliaryPlan, { ...controls, updateTransportMetadata: () => {} }, deadline);
    const current = await currentAuxiliaryAuthority(hydrationPlan, kind, rawEndpoint, controls, deadline);
    if (!sameAuxiliaryAuthority(authority, current)) {
      await safeRevoke(context, hydrationPlan.operationId);
      throw operationError('REMOTE_CHANGED', 'Git auxiliary endpoint grant changed', 409);
    }
    return { authority, auxiliaryPlan, context };
  };

  const prepareHydrationPlans = async (plans, deadline) => {
    if (plans.internalPlan.target?.operation !== 'checkout-hydration') return plans;
    const authorities = [];
    const seen = new Set();
    for (const transfer of plans.internalPlan.plannedTransfers ?? []) {
      const key = `${transfer.kind}\0${transfer.endpoint.fingerprint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let authority;
      try {
        authority = await currentAuxiliaryAuthority(
          plans.internalPlan, transfer.kind, transfer.rawEndpoint, undefined, deadline,
        );
      } catch (error) {
        if (error?.code === 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED') continue;
        throw error;
      }
      if (authority.endpoint !== transfer.rawEndpoint
        || authority.endpointFingerprint !== transfer.endpoint.fingerprint
        || !['managed', 'system', 'anonymous'].includes(authority.transportMode)
        || !isString(authority.transportRevision) || !authority.transportRevision
        || (authority.transportMode === 'managed'
          ? !isString(authority.credentialId) || !authority.credentialId
          : authority.credentialId !== undefined)
        || (authority.transportMode === 'anonymous'
          && normalizeGitRemoteEndpoint(transfer.rawEndpoint).protocol !== 'https')) {
        throw operationError('REMOTE_CHANGED', 'Git auxiliary endpoint grant changed', 409);
      }
      const plannedAuthority = {
        kind: transfer.kind,
        rawEndpoint: transfer.rawEndpoint,
        endpointFingerprint: transfer.endpoint.fingerprint,
        transportMode: authority.transportMode,
        transportRevision: authority.transportRevision,
      };
      if (authority.credentialId) plannedAuthority.credentialId = authority.credentialId;
      authorities.push(plannedAuthority);
    }
    return {
      publicPlan: plans.publicPlan,
      internalPlan: { ...plans.internalPlan, plannedAuxiliaryAuthorities: authorities },
    };
  };
  const nullConfigRecords = (output, pattern) => output ? output.split('\0').filter(Boolean).flatMap((record) => {
    const separator = record.indexOf('\n');
    if (separator < 1) return [];
    const key = record.slice(0, separator);
    return pattern.test(key) ? [{ key, value: record.slice(separator + 1) }] : [];
  }) : [];
  const inspectSubmoduleDirectory = async (directory, relativePath) => {
    const parts = relativePath.split('/');
    let current = directory;
    for (let index = 0; index < parts.length; index += 1) {
      current = pathImpl.join(current, parts[index]);
      let stats;
      try {
        stats = await fsImpl.lstat(current);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return { path: pathImpl.join(directory, relativePath), exists: false };
        }
        throw error;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw Object.assign(new Error('Submodule checkout path is not a real directory'), { code: 'INVALID_SUBMODULE_GITLINK' });
      }
    }
    return { path: current, exists: true };
  };
  const ensureSubmoduleParentDirectories = async (directory, relativePath, controls, deadline) => {
    const parts = relativePath.split('/');
    let current = directory;
    for (const part of parts.slice(0, -1)) {
      current = pathImpl.join(current, part);
      let stats;
      try {
        stats = await fsImpl.lstat(current);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await awaitMutation(() => fsImpl.mkdir(current), controls, deadline);
        stats = await awaitPhase(() => fsImpl.lstat(current), controls, deadline);
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw Object.assign(new Error('Submodule checkout path is not a real directory'), { code: 'INVALID_SUBMODULE_GITLINK' });
      }
    }
  };

  const inspectSingleCheckoutHydration = async ({ directory, parentEndpoint, parentRemoteName, controls, deadline = Date.now() + timeoutMs }) => {
    const headSha = (await localGit(directory, ['rev-parse', '--verify', 'HEAD'], controls, deadline)).trim().toLowerCase();
    if (!SHA_PATTERN.test(headSha)) throw operationError('STALE_CONFIG', 'Checkout HEAD is invalid', 409);
    const configOutput = await localGit(directory, [
      'config', '--blob', 'HEAD:.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.(path|url|update)$',
    ], controls, deadline, { allowedCodes: [0, 1, 128] });
    const treeOutput = await localGit(directory, ['ls-tree', '-rz', '--full-tree', 'HEAD'], controls, deadline,
      { maxOutputBytes: LFS_DISCOVERY_LIMITS.maxFilesBytes });
    const gitlinks = treeOutput.split('\0').filter((record) => record.startsWith('160000 ')).map((record) => `${record}\0`).join('');
    const manifest = parseSubmoduleManifest({ gitmodulesConfig: configOutput, gitlinks, recursionDepth: 0 });
    const children = manifest.modules.map((module) => {
      if (!parentEndpoint || !parentRemoteName) return { path: module.path, gitlink: module.gitlink };
      const resolved = resolveGitRelativeEndpoint(module.url, parentEndpoint);
      return { path: module.path, gitlink: module.gitlink, endpoint: resolved.endpoint };
    });
    const requirements = [];
    let sourceRequired = children.some((child) => !child.endpoint);
    const filesOutput = await localGit(directory, ['ls-files', '-z'], controls, deadline,
      { maxOutputBytes: LFS_DISCOVERY_LIMITS.maxFilesBytes, rawOutput: true });
    const scan = await scanLfsFiles(filesOutput, (args, input) => localGit(directory, args, controls, deadline,
      { input, maxOutputBytes: LFS_DISCOVERY_LIMITS.maxBatchBytes, rawOutput: true }), manifest.modules.map((module) => module.path));
    if ((scan.attributesOutput || scan.pointerSamples.length || !scan.pointerScanComplete)
      && (!parentEndpoint || !parentRemoteName)) {
      sourceRequired = true;
    } else if (scan.attributesOutput || scan.pointerSamples.length || !scan.pointerScanComplete) {
      const lfsConfigOutput = await localGit(directory, [
        'config', '--blob', 'HEAD:.lfsconfig', '--null', '--get-regexp', '^(lfs\\.url|remote\\..*\\.lfsurl)$',
      ], controls, deadline, { allowedCodes: [0, 1, 128] });
      const effectiveConfigOutput = await localGit(directory, [
        'config', '--includes', '--null', '--get-regexp', '^(lfs\\.|filter\\.lfs\\.|remote\\..*\\.lfsurl$)',
      ], controls, deadline, { allowedCodes: [0, 1] });
      const remoteLfsUrls = nullConfigRecords(effectiveConfigOutput, /^remote\..*\.lfsurl$/i).map((record) => ({
        remote: record.key.slice('remote.'.length, -'.lfsurl'.length), url: record.value,
      }));
      const binaryResult = await localGit(directory, ['lfs', 'version'], controls, deadline, { allowedCodes: [0, 1, 128] });
      const discovery = discoverLfs({
        ...scan,
        lfsConfigOutput,
        effectiveConfigOutput,
        gitRemoteName: parentRemoteName,
        gitRemoteUrl: parentEndpoint,
        remoteLfsUrls,
        lfsBinaryAvailable: Boolean(binaryResult.trim()),
      });
      if (discovery.needed) {
        if (discovery.endpoint.status !== 'resolved') {
          if (discovery.client.status !== 'missing') {
            throw operationError('INVALID_REQUEST', 'Git LFS endpoint could not be resolved safely', 400);
          }
        } else {
          requirements.push({
            kind: 'lfs',
            path: '.',
            rawEndpoint: discovery.endpoint.candidate.endpoint,
            transferReady: discovery.client.status !== 'missing',
            endpoint: {
              displayUrl: redactRemoteUrl(discovery.endpoint.candidate.endpoint),
              fingerprint: fingerprintRemoteUrl(discovery.endpoint.candidate.endpoint),
            },
          });
        }
      }
    }
    const currentHead = (await localGit(directory, ['rev-parse', '--verify', 'HEAD'], controls, deadline)).trim().toLowerCase();
    if (currentHead !== headSha) throw operationError('STALE_CONFIG', 'Checkout changed during hydration inspection', 409);
    return Object.freeze({ headSha, requirements, children, sourceRequired });
  };

  const inspectCheckoutHydration = async (input) => {
    const requirements = [];
    const transfers = [];
    let requirementCount = 0;
    let sourceRequired = false;
    const controls = input.controls;
    const deadline = input.deadline ?? Date.now() + timeoutMs;
    const visit = async (directory, parentEndpoint, parentRemoteName, prefix, depth) => {
      if (depth > SUBMODULE_DISCOVERY_LIMITS.maxRecursionDepth) {
        throw operationError('INVALID_REQUEST', 'Submodule recursion exceeds its depth limit', 400);
      }
      const inspection = await inspectSingleCheckoutHydration({
        ...input, directory, parentEndpoint, parentRemoteName, deadline,
      });
      sourceRequired ||= inspection.sourceRequired;
      for (const requirement of inspection.requirements) {
        requirementCount += 1;
        if (requirementCount > SUBMODULE_DISCOVERY_LIMITS.maxPublicRecords) {
          throw operationError('INVALID_REQUEST', 'Checkout hydration requirement limit exceeded', 400);
        }
        const path = prefix && requirement.path !== '.' ? `${prefix}/${requirement.path}` : prefix || requirement.path;
        const { rawEndpoint, transferReady = true, ...publicRequirement } = requirement;
        requirements.push({ ...publicRequirement, path });
        if (transferReady) transfers.push({ ...publicRequirement, path, rawEndpoint });
      }
      for (const child of inspection.children) {
        const resultPath = prefix ? `${prefix}/${child.path}` : child.path;
        let location;
        try {
          location = await inspectSubmoduleDirectory(directory, child.path);
        } catch (error) {
          if (error?.code === 'INVALID_SUBMODULE_GITLINK') continue;
          throw error;
        }
        if (!location.exists) {
          if (child.endpoint) {
            requirementCount += 1;
            if (requirementCount > SUBMODULE_DISCOVERY_LIMITS.maxPublicRecords) {
              throw operationError('INVALID_REQUEST', 'Checkout hydration requirement limit exceeded', 400);
            }
            const endpoint = {
              displayUrl: redactRemoteUrl(child.endpoint),
              fingerprint: fingerprintRemoteUrl(child.endpoint),
            };
            requirements.push({ kind: 'submodule', path: resultPath, endpoint });
            transfers.push({ kind: 'submodule', path: resultPath, endpoint, rawEndpoint: child.endpoint });
          }
          continue;
        }
        const childDirectory = location.path;
        let childHead;
        try {
          childHead = (await localGit(
            childDirectory, ['rev-parse', '--verify', 'HEAD'], controls, deadline,
          )).trim().toLowerCase();
        } catch (error) {
          if (error?.cancelled || error?.timedOut) throw error;
          continue;
        }
        if (childHead === child.gitlink && child.endpoint) {
          await visit(childDirectory, child.endpoint, 'origin', resultPath, depth + 1);
        }
      }
      return inspection.headSha;
    };
    const headSha = await visit(input.directory, input.parentEndpoint, input.parentRemoteName, '', 0);
    return Object.freeze({ headSha, requirements, transfers, sourceRequired });
  };

  const hydrateCheckout = async (hydrationPlan, controls, deadline) => {
    const submodules = [];
    const lfs = [];
    let moduleCount = 0;
    const visit = async (directory, parentEndpoint, parentRemoteName, prefix, depth) => {
      if (depth > SUBMODULE_DISCOVERY_LIMITS.maxRecursionDepth) {
        throw Object.assign(new Error('Submodule recursion exceeds its depth limit'), { code: 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED' });
      }
      const configOutput = await localGit(directory, [
        'config', '--blob', 'HEAD:.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.(path|url|update)$',
      ], controls, deadline, { allowedCodes: [0, 1, 128] });
      const treeOutput = await localGit(directory, ['ls-tree', '-rz', '--full-tree', 'HEAD'], controls, deadline,
        { maxOutputBytes: LFS_DISCOVERY_LIMITS.maxFilesBytes });
      const gitlinks = treeOutput.split('\0').filter((record) => record.startsWith('160000 ')).map((record) => `${record}\0`).join('');
      const manifest = parseSubmoduleManifest({ gitmodulesConfig: configOutput, gitlinks, recursionDepth: depth });
      for (const module of hydrationPlan.hydrateSubmodules === false ? [] : manifest.modules) {
        if (phaseError(controls, deadline)) throw phaseError(controls, deadline);
        moduleCount += 1;
        if (moduleCount > SUBMODULE_DISCOVERY_LIMITS.maxPublicRecords) {
          throw Object.assign(new Error('Submodule result limit exceeded'), { code: 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED' });
        }
        const resultPath = prefix ? `${prefix}/${module.path}` : module.path;
        let endpoint;
        try {
          if (!parentEndpoint || !parentRemoteName) {
            submodules.push({ path: resultPath, status: 'authorization-required', error: publicError(
              'AUTHENTICATION_REQUIRED', 'Submodule hydration requires the exact parent fetch source and an explicit endpoint grant; fetch from a selected source and retry',
            ) });
            continue;
          }
          endpoint = resolveGitRelativeEndpoint(module.url, parentEndpoint);
          const publicEndpoint = { displayUrl: redactRemoteUrl(endpoint.endpoint), fingerprint: fingerprintRemoteUrl(endpoint.endpoint) };
          const location = await inspectSubmoduleDirectory(directory, module.path);
          const childDirectory = location.path;
          let childHead = '';
          const childExists = location.exists;
          if (childExists) {
            childHead = (await localGit(
              childDirectory, ['rev-parse', '--verify', 'HEAD'], controls, deadline,
            )).trim().toLowerCase();
          }
          if (childHead && childHead !== module.gitlink) {
            throw Object.assign(new Error('Existing submodule checkout does not match its gitlink'), { code: 'INVALID_SUBMODULE_GITLINK' });
          }
          if (!childHead) {
            const transfer = await auxiliaryTransport({ ...hydrationPlan, directory }, 'submodule', endpoint.endpoint, controls, deadline);
            if (transfer.authority.transportMode === 'managed') await controls.markStepCompleted('authenticated');
            let keepChild = childExists;
            let childIdentity;
            let childBirthtimeHolds = false;
            try {
              if (!childExists) {
                await ensureSubmoduleParentDirectories(directory, module.path, controls, deadline);
                await awaitMutation(() => fsImpl.mkdir(childDirectory), controls, deadline, async () => {
                  const stats = await fsImpl.lstat(childDirectory);
                  if (stats.isSymbolicLink() || !stats.isDirectory()) {
                    throw operationError('CONFLICT', 'Submodule checkout path ownership changed', 409);
                  }
                  childBirthtimeHolds = await birthtimeHoldsStill(fsImpl, pathImpl, childDirectory);
                  childIdentity = directoryIdentity(await fsImpl.lstat(childDirectory), childBirthtimeHolds);
                });
              }
              await commandResult(transfer.auxiliaryPlan, controls, [
                'clone', '--no-checkout', '--no-tags', '--', endpoint.endpoint, childDirectory,
              ], { ...transfer.context, env: { ...transfer.context.env, GIT_LFS_SKIP_SMUDGE: '1' } }, deadline, { transfer: true });
              await controls.markStepCompleted('transferred');
              await localGit(childDirectory, ['checkout', '--force', '--detach', module.gitlink], controls, deadline, { disableLfsFilters: true });
              childHead = (await localGit(childDirectory, ['rev-parse', '--verify', 'HEAD'], controls, deadline)).trim().toLowerCase();
              if (childHead !== module.gitlink) {
                throw Object.assign(new Error('Submodule checkout does not match its gitlink'), { code: 'INVALID_SUBMODULE_GITLINK' });
              }
              keepChild = true;
            } finally {
              const cleanupFailed = await safeRevoke(transfer.context, hydrationPlan.operationId);
              if (!keepChild && childIdentity) {
                const cleanup = await quarantineAndClean(childDirectory, hydrationPlan.operationId, async (moved) => {
                  const stats = await fsImpl.lstat(moved);
                  return stats.isDirectory() && directoryIdentity(stats, childBirthtimeHolds) === childIdentity;
                });
                if (!cleanup.removed) throw operationError('UNKNOWN', 'Submodule checkout cleanup failed', 500);
              }
              if (cleanupFailed) throw operationError('UNKNOWN', 'Submodule credential cleanup failed', 500);
            }
          }
          submodules.push({ path: resultPath, status: 'succeeded', endpoint: publicEndpoint });
          await visit(childDirectory, endpoint.endpoint, 'origin', resultPath, depth + 1);
        } catch (error) {
          const failure = hydrationError(error);
          if (!submodules.some((entry) => entry.path === resultPath)) {
            const failedModule = { path: resultPath, ...failure };
            if (endpoint) failedModule.endpoint = {
              displayUrl: redactRemoteUrl(endpoint.endpoint),
              fingerprint: fingerprintRemoteUrl(endpoint.endpoint),
            };
            submodules.push(failedModule);
          }
          if (failure.status === 'cancelled') throw error;
        }
      }

      const filesOutput = await localGit(directory, ['ls-files', '-z'], controls, deadline,
        { maxOutputBytes: LFS_DISCOVERY_LIMITS.maxFilesBytes, rawOutput: true });
      const scan = await scanLfsFiles(filesOutput, (args, input) => localGit(directory, args, controls, deadline,
        { input, maxOutputBytes: LFS_DISCOVERY_LIMITS.maxBatchBytes, rawOutput: true }), manifest.modules.map((module) => module.path));
      const lfsPath = prefix || '.';
      if (!scan.attributesOutput && !scan.pointerSamples.length && scan.pointerScanComplete) {
        lfs.push({ path: lfsPath, status: 'not-needed' });
        return;
      }
      if (!parentEndpoint || !parentRemoteName) {
        lfs.push({ path: lfsPath, status: 'authorization-required', error: publicError(
          'AUTHENTICATION_REQUIRED', 'Git LFS hydration requires the exact parent fetch source and an explicit HTTPS endpoint grant; fetch from a selected source and retry',
        ) });
        return;
      }
      const lfsConfigOutput = await localGit(directory, [
        'config', '--blob', 'HEAD:.lfsconfig', '--null', '--get-regexp', '^(lfs\\.url|remote\\..*\\.lfsurl)$',
      ], controls, deadline, { allowedCodes: [0, 1, 128] });
      const effectiveConfigOutput = await localGit(directory, [
        'config', '--includes', '--null', '--get-regexp', '^(lfs\\.|filter\\.lfs\\.|remote\\..*\\.lfsurl$)',
      ], controls, deadline, { allowedCodes: [0, 1] });
      const remoteLfsUrls = nullConfigRecords(effectiveConfigOutput, /^remote\..*\.lfsurl$/i).map((record) => ({
        remote: record.key.slice('remote.'.length, -'.lfsurl'.length), url: record.value,
      }));
      const binaryResult = await localGit(directory, ['lfs', 'version'], controls, deadline, { allowedCodes: [0, 1, 128] });
      const discovery = discoverLfs({
        ...scan, lfsConfigOutput, effectiveConfigOutput,
        gitRemoteName: parentRemoteName, gitRemoteUrl: parentEndpoint, remoteLfsUrls,
        lfsBinaryAvailable: Boolean(binaryResult.trim()),
      });
      if (!discovery.needed) lfs.push({ path: lfsPath, status: 'not-needed' });
      else if (discovery.client.status === 'missing') lfs.push({
        path: lfsPath, status: 'client-missing',
        error: publicError('GIT_LFS_CLIENT_MISSING', 'Git LFS is required for this checkout; install git-lfs and retry'),
      });
      else if (discovery.endpoint.status !== 'resolved') lfs.push({
        path: lfsPath, status: 'authorization-required',
        error: publicError('AUTHENTICATION_REQUIRED', 'The Git LFS endpoint requires an explicit HTTPS grant'),
      });
      else {
        const rawEndpoint = discovery.endpoint.candidate.endpoint;
        const endpoint = { displayUrl: redactRemoteUrl(rawEndpoint), fingerprint: fingerprintRemoteUrl(rawEndpoint) };
        try {
          const transfer = await auxiliaryTransport({ ...hydrationPlan, directory }, 'lfs', rawEndpoint, controls, deadline);
          if (transfer.authority.transportMode === 'managed') await controls.markStepCompleted('authenticated');
          try {
            const context = { ...transfer.context, env: { ...transfer.context.env, GIT_LFS_SKIP_SMUDGE: '1' } };
            await commandResult(transfer.auxiliaryPlan, controls, [
              '-c', `lfs.url=${rawEndpoint}`, 'lfs', 'fetch', parentRemoteName, 'HEAD',
            ], context, deadline, { transfer: true });
            await controls.markStepCompleted('transferred');
            await commandResult(transfer.auxiliaryPlan, controls, [
              '-c', `lfs.url=${rawEndpoint}`, 'lfs', 'checkout',
            ], context, deadline);
          } finally {
            if (await safeRevoke(transfer.context, hydrationPlan.operationId)) {
              throw operationError('UNKNOWN', 'Git LFS credential cleanup failed', 500);
            }
          }
          lfs.push({ path: lfsPath, status: 'succeeded', endpoint });
        } catch (error) {
          lfs.push({ path: lfsPath, ...hydrationError(error), endpoint });
        }
      }
    };
    try {
      await visit(hydrationPlan.directory, hydrationPlan.parentEndpoint, hydrationPlan.parentRemoteName, '', 0);
    } catch (error) {
      const failure = hydrationError(error);
      if (!submodules.some((entry) => entry.status === failure.status)
        && !lfs.some((entry) => entry.status === failure.status)) {
        lfs.push({ path: '.', ...failure });
      }
    }
    return Object.freeze({ status: hydrationStatus(submodules, lfs), submodules, lfs });
  };

  const cancellationResult = (plan, controls, error) => {
    if ((plan.target.operation === 'push' || plan.target.operation === 'delete-remote-branch')
      && controls.hasTransferStarted()) {
      return terminal('outcome-unknown', 'OUTCOME_UNKNOWN', 'Push was interrupted after it started; the remote outcome is unknown');
    }
    return terminal('cancelled', error?.timedOut ? 'TIMEOUT' : 'CANCELLED', error?.timedOut
      ? 'Git network operation timed out and the process exited'
      : 'Git network operation was cancelled');
  };

  const safeRevoke = async (context, operationId) => {
    let cleanupFailed = false;
    try {
      if (context && await context.revoke() === false) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
    try { credentialBroker?.revoke(operationId); } catch {}
    return cleanupFailed;
  };

  const prepareLfsPublication = async (plan, controls, deadline) => {
    if (plan.transportMode !== 'managed' || plan.target.operation !== 'push') return false;
    let root;
    let context;
    let auditStarted = false;
    let uploaded = false;
    let failure;
    const operationId = `${plan.operationId}:lfs-upload`;
    const recordId = `git:${operationId}`;
    try {
      // Include historical pointers reachable from this commit, never unrelated refs.
      const objects = await localGit(plan.directory, ['rev-list', '--objects', '--no-object-names', plan.sourceSha, '--'], controls, deadline,
        { maxOutputBytes: LFS_DISCOVERY_LIMITS.maxFilesBytes, rawOutput: true });
      const pointers = await scanLfsPushObjects(objects, (args, input) => localGit(plan.directory, args, controls, deadline,
        { input, maxOutputBytes: LFS_DISCOVERY_LIMITS.maxBatchBytes, rawOutput: true }));
      if (!pointers.length) return false;
      const configRef = `${plan.sourceSha}:.lfsconfig`;
      const configObject = await localGit(plan.directory, ['cat-file', '--batch-check'], controls, deadline,
        { input: Buffer.from(`${configRef}\n`) });
      let lfsConfigOutput = '';
      if (configObject !== `${configRef} missing\n`) {
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})? blob [0-9]+\n$/.test(configObject)) {
          throw operationError('INVALID_REQUEST', 'Committed LFS configuration is unavailable', 409);
        }
        lfsConfigOutput = await localGit(plan.directory, ['config', '--blob', configRef, '--null', '--list'], controls, deadline,
          { maxOutputBytes: LFS_DISCOVERY_LIMITS.maxConfigBytes });
      }
      const effectiveConfigArgs = [
        'config', '--includes', '--null', '--get-regexp', '^(lfs\\.|filter\\.lfs\\.|remote\\..*\\.lfs(push)?url$)',
      ];
      const effectiveConfigOutput = await localGit(plan.directory, effectiveConfigArgs,
        controls, deadline, { allowedCodes: [0, 1], maxOutputBytes: LFS_DISCOVERY_LIMITS.maxConfigBytes });
      const { endpoint, storagePath } = resolveLfsPushConfig({
        lfsConfigOutput, effectiveConfigOutput, gitRemoteName: plan.target.remote.name, gitRemoteUrl: plan.rawEndpoint,
      });
      let version;
      try { version = await localGit(plan.directory, ['lfs', 'version'], controls, deadline); }
      catch (error) {
        if (error.cancelled || error.timedOut) throw error;
        throw operationError('GIT_LFS_CLIENT_MISSING', 'Git LFS client is unavailable', 409);
      }
      if (!/^git-lfs\//.test(version)) throw operationError('GIT_LFS_CLIENT_MISSING', 'Install git-lfs and retry this push; LFS objects must be uploaded before publishing Git refs', 409);
      if (!endpoint) throw operationError('AUTHENTICATION_REQUIRED', 'Configure and grant an explicit HTTPS LFS upload endpoint for this SSH Git remote, then retry', 409);
      // The auxiliary authority reads the checkout directory from the plan itself, like hydration plans do.
      const grantPlan = { directory: plan.directory, repositoryAuthority: {
        directory: plan.directory, repositoryId: plan.target.repositoryId,
        bindingRevision: plan.target.bindingRevision, configRevision: plan.target.configRevision,
      } };
      const authority = await currentAuxiliaryAuthority(grantPlan, 'lfs', endpoint.endpoint, controls, deadline);
      if (authority.endpoint !== endpoint.endpoint || authority.endpointFingerprint !== fingerprintRemoteUrl(endpoint.endpoint)
        || authority.transportMode !== 'managed' || !authority.credentialId) {
        throw operationError('AUTHENTICATION_REQUIRED', 'Grant this exact HTTPS LFS upload endpoint a stored credential, then retry', 409);
      }
      const commonDirectory = (await localGit(plan.directory, ['rev-parse', '--path-format=absolute', '--git-common-dir'], controls, deadline)).trim();
      if (!pathImpl.isAbsolute(commonDirectory) || /[\0\r\n]/.test(commonDirectory)) throw operationError('INVALID_REQUEST', 'Git LFS storage location is invalid', 409);
      const storage = pathImpl.resolve(commonDirectory, storagePath ?? 'lfs');

      // A private bare repository excludes mutable checkout config, URL rewrites,
      // custom transfers and ambient netrc credentials from the upload process.
      await awaitMutation(() => fsImpl.mkdtemp(pathImpl.join(os.tmpdir(), 'openchamber-lfs-upload-')), controls, deadline,
        (directory) => { root = directory; });
      const env = managedEnvironment(inheritedEnv, platform);
      for (const name of Object.keys(env)) if (name.startsWith('GIT_') || name.startsWith('LFS_')) delete env[name];
      delete env.NETRC;
      Object.assign(env, {
        HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
        GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'https', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
      });
      const initialized = await run({ cwd: root, args: ['init', '--bare', '--template=', '.'], env, controls, deadline });
      if (initialized.code !== 0 || initialized.cancelled || initialized.timedOut) {
        throw operationError('TRANSPORT_FAILED', 'LFS upload preparation failed', 500,
          { cancelled: initialized.cancelled, timedOut: initialized.timedOut });
      }
      const auxiliaryPlan = { operationId, directory: root, rawEndpoint: endpoint.endpoint,
        transportMode: 'managed', credentialId: authority.credentialId, auxiliaryKind: 'lfs', target: { operation: 'clone' } };
      if (auditStore) {
        const claimed = await awaitPhase(() => auditStore.plan({
          id: recordId, initiator: 'user', executorKind: 'openchamber-server-git', runtime: runtimeIdentity,
          repositoryId: plan.target.repositoryId, providerAccountId: authoritativeProviderAccountId(auxiliaryPlan),
          transportReference: { kind: 'managed', credentialId: authority.credentialId },
          target: { kind: 'git-network', operation: 'push', remotes: [{ role: 'push', name: 'lfs-upload',
            endpointFingerprint: authority.endpointFingerprint, sourceRef: plan.target.sourceRef }] },
        }), controls, deadline);
        if (claimed.status === 'existing') throw operationError('UNKNOWN', 'LFS upload audit identity is already in use', 409);
        auditStarted = true;
        await awaitPhase(() => auditStore.start(recordId), controls, deadline);
      }
      context = await transport(auxiliaryPlan, { ...controls, updateTransportMetadata: () => {} }, deadline);
      if (context.env.OPENCHAMBER_GIT_SSH_KEY) throw operationError('AUTHENTICATION_REQUIRED', 'The LFS upload grant requires an HTTPS credential', 409);
      context.env = env;
      const currentConfig = await localGit(plan.directory, effectiveConfigArgs,
        controls, deadline, { allowedCodes: [0, 1], maxOutputBytes: LFS_DISCOVERY_LIMITS.maxConfigBytes });
      if (currentConfig !== effectiveConfigOutput) throw operationError('STALE_CONFIG', 'LFS publication configuration changed', 409);
      await revalidate(plan, controls, deadline);
      const current = await currentAuxiliaryAuthority(grantPlan, 'lfs', endpoint.endpoint, controls, deadline);
      if (!sameAuxiliaryAuthority(authority, current)) throw operationError('REMOTE_CHANGED', 'LFS upload endpoint grant changed; retry with the current grant', 409);
      const blocked = phaseError(controls, deadline);
      if (blocked) throw blocked;
      await commandResult(auxiliaryPlan, controls, [
        '-c', `remote.openchamber-lfs.url=${endpoint.endpoint}`,
        '-c', `lfs.url=${endpoint.endpoint}`, '-c', `lfs.pushurl=${endpoint.endpoint}`,
        '-c', `lfs.${endpoint.endpoint}.access=basic`, '-c', `lfs.storage=${storage}`,
        '-c', 'lfs.basictransfersonly=true', '-c', 'lfs.allowincompletepush=false', '-c', 'lfs.locksverify=false',
        'lfs', 'push', '--object-id', 'openchamber-lfs', ...pointers.map((pointer) => pointer.oid),
      ], context, deadline);
      // LFS upload does not publish Git refs and must not mark ref outcome unknown.
      uploaded = true;
    } catch (error) {
      const interrupted = phaseError(controls, deadline);
      const code = interrupted?.code ?? (error.cancelled ? 'CANCELLED' : error.timedOut ? 'TIMEOUT'
        : error.code === 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED' ? 'AUTHENTICATION_REQUIRED'
          : String(error.code).includes('LFS') && error.code !== 'GIT_LFS_CLIENT_MISSING' ? 'INVALID_REQUEST'
            : ['GIT_LFS_CLIENT_MISSING', 'AUTHENTICATION_REQUIRED', 'REMOTE_CHANGED', 'STALE_CONFIG', 'INVALID_REQUEST', 'UNKNOWN'].includes(error.code)
              ? error.code : 'TRANSPORT_FAILED');
      const message = code === 'GIT_LFS_CLIENT_MISSING' ? 'Install git-lfs and retry this push; LFS objects must be uploaded before publishing Git refs'
        : code === 'AUTHENTICATION_REQUIRED' ? 'Grant the exact HTTPS LFS upload endpoint a stored credential, then retry this push'
          : code === 'INVALID_REQUEST' ? 'LFS publication discovery is invalid or incomplete; Git refs were not published'
            : code === 'CANCELLED' ? 'LFS upload was cancelled; Git refs were not published'
              : code === 'TIMEOUT' ? 'LFS upload timed out; Git refs were not published'
                : 'LFS upload preparation or transfer failed; Git refs were not published';
      failure = operationError(code, message, 409, { cancelled: code === 'CANCELLED', timedOut: code === 'TIMEOUT' });
    } finally {
      let cleanupFailed = await safeRevoke(context, operationId);
      if (root) {
        try { await awaitMutation(() => fsImpl.rm(root, { recursive: true, force: true }), undefined, Date.now() + CLEANUP_TIMEOUT_MS); }
        catch { cleanupFailed = true; }
      }
      if (cleanupFailed && !failure) failure = operationError('UNKNOWN', 'LFS upload cleanup failed; Git refs were not published', 500);
      if (auditStarted) {
        try {
          await awaitPhase(() => auditStore.finish(recordId, {
            state: failure ? failure.cancelled || failure.timedOut ? 'cancelled' : 'failed' : 'succeeded',
            errorCode: failure?.code ?? null, steps: uploaded ? ['validated', 'authenticated', 'transferred'] : ['validated'],
          }), undefined, Date.now() + CLEANUP_TIMEOUT_MS);
        } catch { failure ??= operationError('UNKNOWN', 'LFS upload audit completion failed; Git refs were not published', 500); }
      }
    }
    if (failure) throw failure;
    return uploaded;
  };

  const executeExisting = async (plan, controls, deadline = Date.now() + timeoutMs) => {
    let context;
    let result;
    let temporaryRef;
    let integrationContext;
    let mergeStarted = false;
    let pushTransferred = false;
    let lfsUploaded = false;
    try {
      await revalidate(plan, controls, deadline);
      if (plan.target.operation === 'pull') await revalidatePullHead(plan, controls, deadline);
      await controls.markStepCompleted('validated');
      if (controls.isCancellationRequested()) result = cancellationResult(plan, controls, {});
      else {
        lfsUploaded = await prepareLfsPublication(plan, controls, deadline);
        context = await transport(plan, controls, deadline);
        if (plan.transportMode === 'managed') await controls.markStepCompleted('authenticated');
        await revalidate(plan, controls, deadline);
        if (plan.target.operation === 'pull') await revalidatePullHead(plan, controls, deadline);
        if (controls.isCancellationRequested()) result = cancellationResult(plan, controls, {});
        else if (plan.target.operation === 'push' || plan.target.operation === 'delete-remote-branch') {
          const blocked = phaseError(controls, deadline);
          if (blocked) throw blocked;
          const lease = plan.target.forceWithLease
            ? [`--force-with-lease=${plan.target.destinationRef}:${plan.target.forceWithLease.expectedRemoteSha}`]
            : [];
          await commandResult(plan, controls, [
            'push', ...lease, '--', plan.rawEndpoint,
            plan.target.operation === 'delete-remote-branch'
              ? `:${plan.target.destinationRef}`
              : `${plan.sourceSha}:${plan.target.destinationRef}`,
          ], context, deadline, { transfer: true });
          pushTransferred = true;
          await controls.markStepCompleted('transferred');
          if (plan.target.configureUpstream) {
            const localBranch = plan.target.sourceRef.slice('refs/heads/'.length);
            const remoteBranch = plan.target.destinationRef.slice('refs/heads/'.length);
            await commandResult(plan, controls, [
              'config', `branch.${localBranch}.remote`, plan.target.remote.name,
            ], context, deadline);
            await commandResult(plan, controls, [
              'config', `branch.${localBranch}.merge`, `refs/heads/${remoteBranch}`,
            ], context, deadline);
            await controls.markStepCompleted('updated-local-repository');
          }
          result = { state: 'succeeded' };
        } else if (plan.target.operation === 'fetch' && plan.target.fetchScope === 'remote') {
          await commandResult(plan, controls, [
            'fetch', '--atomic', '--no-tags', '--no-prune', '--no-prune-tags', '--no-recurse-submodules', '--refmap=',
            '--', plan.rawEndpoint, plan.fetchRefspec,
          ], context, deadline, { transfer: true });
          await controls.markStepCompleted('transferred');
          result = { state: 'succeeded' };
        } else {
          temporaryRef = plan.target.operation === 'pull' ? `refs/openchamber/network/${plan.operationId}` : plan.target.destinationRef;
          await commandResult(plan, controls, [
            'fetch', '--no-tags', ...(plan.target.operation === 'pull' ? ['--no-recurse-submodules'] : []),
            '--', plan.rawEndpoint, `${plan.target.sourceRef}:${temporaryRef}`,
          ], context, deadline, { transfer: true });
          await controls.markStepCompleted('transferred');
          if (plan.target.operation === 'fetch') result = { state: 'succeeded' };
          else if (controls.isCancellationRequested()) result = cancellationResult(plan, controls, {});
          else {
            if (plan.transportMode === 'managed') {
              if (await safeRevoke(context, plan.operationId)) throw operationError('UNKNOWN', 'Git fetch credential cleanup failed', 500);
              context = undefined;
            }
            integrationContext = plan.transportMode !== 'system'
              ? await localIntegrationContext(plan.directory, controls, deadline) : context;
            await revalidate(plan, controls, deadline);
            await revalidatePullHead(plan, controls, deadline);
            const fetchedSha = String(await awaitPhase(
              () => resolveRefImpl(plan.directory, temporaryRef, { controls, deadline }), controls, deadline,
            )).trim();
            if (!SHA_PATTERN.test(fetchedSha)) throw operationError('STALE_CONFIG', 'Fetched ref is invalid', 409);
            mergeStarted = true;
            await controls.markIntegrationStarted();
            await commandResult(plan, controls, ['merge', '--no-edit', '--no-verify', fetchedSha], integrationContext, deadline);
            mergeStarted = false;
            await controls.markStepCompleted('updated-local-repository');
            result = { state: 'succeeded' };
            if (plan.transportMode !== 'system') {
              const hydrated = await hydrateIntegration(plan, controls, deadline);
              result = hydrated.state === 'succeeded' ? hydrated : { ...hydrated, state: hydrated.state === 'cancelled' ? 'cancelled' : 'partial' };
            }
          }
        }
      }
    } catch (error) {
      const output = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
      if (pushTransferred && plan.target.operation === 'push' && plan.target.configureUpstream) {
        result = terminal('partial', 'TRANSPORT_FAILED', 'Push succeeded, but local upstream configuration failed');
      } else if (plan.target.operation === 'push' && plan.target.forceWithLease && isLeaseConflict(output)) {
        result = terminal('conflicted', 'CONFLICT', 'Push force lease no longer matches the remote ref');
      } else if (plan.target.operation === 'pull' && /\bCONFLICT\b|automatic merge failed|unmerged files/i.test(output)) {
        result = terminal('conflicted', 'CONFLICT', 'Pull left merge conflicts in the local repository');
      } else if (mergeStarted && (error.cancelled || error.timedOut || controls.isCancellationRequested())) {
        let mergeInProgress = false;
        try { mergeInProgress = await hasMergeState(plan.directory); } catch {}
        result = mergeInProgress
          ? terminal('conflicted', 'CONFLICT', 'Pull was interrupted with an active merge state')
          : terminal('outcome-unknown', 'OUTCOME_UNKNOWN', 'Pull integration was interrupted; the local outcome is unknown');
      } else if (error.cancelled || error.timedOut || controls.isCancellationRequested()) {
        result = cancellationResult(plan, controls, error);
      } else {
        const code = [
          'STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED',
          'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'GIT_LFS_CLIENT_MISSING', 'INVALID_REQUEST', 'RUNTIME_UNSUPPORTED', 'UNKNOWN',
        ].includes(error.code) ? error.code : 'TRANSPORT_FAILED';
        result = terminal(code.startsWith('STALE_') || code === 'REMOTE_CHANGED' ? 'conflicted' : 'failed', code,
          `${lfsUploaded ? 'LFS objects were uploaded, but Git ref publication failed. ' : ''}${createGitRedactor({ secrets: [...(context?.secrets ?? []), plan.directory] }).error(error)}`);
      }
    }

    let cleanupFailed = false;
    if (temporaryRef && plan.target.operation === 'pull') {
      try {
        const cleanupContext = integrationContext ?? context ?? {
          env: { ...managedEnvironment(inheritedEnv, platform), GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' },
          configArgs: ['-c', `core.hooksPath=${platform === 'win32' ? 'NUL' : '/dev/null'}`], secrets: [],
        };
        await commandResult(plan, controls, ['update-ref', '-d', temporaryRef], cleanupContext,
          Date.now() + CLEANUP_TIMEOUT_MS, { localRefCleanup: true });
      } catch {
        cleanupFailed = true;
      }
    }
    cleanupFailed = await safeRevoke(context, plan.operationId) || cleanupFailed;
    if (cleanupFailed && result?.state === 'succeeded') {
      return terminal('failed', 'UNKNOWN', 'Git network operation cleanup failed');
    }
    return result ?? terminal('failed', 'UNKNOWN', 'Git network operation failed');
  };

  const executeSync = async (plan, controls, deadline = Date.now() + timeoutMs) => {
    const results = new Map();
    let activeStep = 'fetch';
    let context;
    let mergeStarted = false;
    let hydration;
    let lfsUploaded = false;
    const step = (name, status, error) => {
      const value = { step: name, status };
      if (error) value.error = error;
      results.set(name, value);
    };
    const completion = (state, error) => {
      const value = {
        state,
        stepResults: ['fetch', 'pull', 'push'].map((name) => results.get(name) ?? { step: name, status: 'skipped' }),
      };
      if (error) value.error = error;
      if (hydration) value.hydration = hydration;
      return value;
    };
    const syncPlan = (role) => ({
      ...plan[role],
      operationId: plan.operationId,
      transportRole: role,
    });
    const fetchPlan = syncPlan('fetch');
    let pushPlan = syncPlan('push');
    const headPlan = {
      directory: plan.directory,
      destinationSha: plan.destinationSha,
      target: { destinationRef: plan.target.pull.destinationRef },
    };
    try {
      await revalidate(fetchPlan, controls, deadline);
      await revalidatePullHead(headPlan, controls, deadline);
      await controls.markStepCompleted('validated');
      context = await transport(fetchPlan, controls, deadline);
      if (fetchPlan.transportMode === 'managed') await controls.markStepCompleted('authenticated');
      await revalidate(fetchPlan, controls, deadline);
      await revalidatePullHead(headPlan, controls, deadline);
      await commandResult(fetchPlan, controls, [
        'fetch', '--no-tags', '--no-recurse-submodules', '--', fetchPlan.rawEndpoint,
        `${fetchPlan.target.sourceRef}:${fetchPlan.target.destinationRef}`,
      ], context, deadline, { transfer: true, transferRole: 'fetch' });
      await controls.markStepCompleted('transferred');
      if (await safeRevoke(context, plan.operationId)) {
        throw operationError('UNKNOWN', 'Git fetch credential cleanup failed', 500);
      }
      context = undefined;
      step('fetch', 'succeeded');

      activeStep = 'pull';
      const blockedPull = phaseError(controls, deadline);
      if (blockedPull) throw blockedPull;
      const integrationContext = await localIntegrationContext(plan.directory, controls, deadline);
      await revalidate(fetchPlan, controls, deadline);
      await revalidatePullHead(headPlan, controls, deadline);
      const fetchedSha = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, fetchPlan.target.destinationRef, { controls, deadline }), controls, deadline,
      )).trim();
      if (!SHA_PATTERN.test(fetchedSha)) throw operationError('STALE_CONFIG', 'Fetched ref is invalid', 409);
      mergeStarted = true;
      await controls.markIntegrationStarted();
      await commandResult(fetchPlan, controls, ['merge', '--no-edit', '--no-verify', fetchedSha], integrationContext, deadline);
      mergeStarted = false;
      await controls.markStepCompleted('updated-local-repository');
      const hydrated = await hydrateIntegration(fetchPlan, controls, deadline);
      hydration = hydrated.hydration;
      if (hydrated.state !== 'succeeded') {
        step('pull', hydrated.state === 'cancelled' ? 'cancelled' : 'failed', hydrated.error);
        return completion(hydrated.state === 'cancelled' ? 'cancelled' : 'partial', hydrated.error);
      }
      step('pull', 'succeeded');

      activeStep = 'push';
      const blockedPush = phaseError(controls, deadline);
      if (blockedPush) throw blockedPush;
      const pushSha = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, pushPlan.target.sourceRef, { controls, deadline }), controls, deadline,
      )).toLowerCase();
      if (!SHA_PATTERN.test(pushSha)) throw operationError('STALE_CONFIG', 'Git push source ref is invalid', 409);
      pushPlan = { ...pushPlan, sourceSha: pushSha };
      await revalidate(pushPlan, controls, deadline);
      lfsUploaded = await prepareLfsPublication(pushPlan, controls, deadline);
      await revalidate(pushPlan, controls, deadline);
      context = await transport(pushPlan, controls, deadline);
      if (pushPlan.transportMode === 'managed') await controls.markStepCompleted('authenticated');
      await revalidate(pushPlan, controls, deadline);
      const lease = pushPlan.target.forceWithLease
        ? [`--force-with-lease=${pushPlan.target.destinationRef}:${pushPlan.target.forceWithLease.expectedRemoteSha}`]
        : [];
      await commandResult(pushPlan, controls, [
        'push', ...lease, '--', pushPlan.rawEndpoint, `${pushSha}:${pushPlan.target.destinationRef}`,
      ], context, deadline, { transfer: true, transferRole: 'push' });
      if (await safeRevoke(context, plan.operationId)) {
        throw operationError('UNKNOWN', 'Git push credential cleanup failed', 500);
      }
      context = undefined;
      step('push', 'succeeded');
      return completion('succeeded');
    } catch (error) {
      const cleanupFailed = await safeRevoke(context, plan.operationId);
      const output = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
      const redacted = createGitRedactor({
        secrets: [...(context?.secrets ?? []), plan.directory],
      }).error(error);
      if (activeStep === 'pull' && /\bCONFLICT\b|automatic merge failed|unmerged files/i.test(output)) {
        const publicFailure = publicError('CONFLICT', 'Sync pull left merge conflicts in the local repository');
        step('pull', 'conflicted', publicFailure);
        return completion('conflicted', publicFailure);
      }
      if (activeStep === 'pull' && mergeStarted
        && (error.cancelled || error.timedOut || controls.isCancellationRequested())) {
        let mergeInProgress = false;
        try { mergeInProgress = await hasMergeState(plan.directory); } catch {}
        if (mergeInProgress) {
          const publicFailure = publicError('CONFLICT', 'Sync pull was interrupted with an active merge state');
          step('pull', 'conflicted', publicFailure);
          return completion('conflicted', publicFailure);
        }
        const publicFailure = publicError('OUTCOME_UNKNOWN', 'Sync pull integration was interrupted; the local outcome is unknown');
        step('pull', 'cancelled', publicFailure);
        return completion('outcome-unknown', publicFailure);
      }
      if (error.cancelled || error.timedOut || controls.isCancellationRequested()) {
        const unknownPush = activeStep === 'push' && controls.hasTransferStarted('push');
        const publicFailure = publicError(unknownPush ? 'OUTCOME_UNKNOWN' : (error.timedOut ? 'TIMEOUT' : 'CANCELLED'),
          unknownPush
            ? 'Sync push was interrupted after it started; the remote outcome is unknown'
            : error.timedOut ? 'Git sync operation timed out' : 'Git sync operation was cancelled');
        step(activeStep, 'cancelled', publicFailure);
        return completion(unknownPush ? 'outcome-unknown' : 'cancelled', publicFailure);
      }
      if (activeStep === 'push' && pushPlan.target.forceWithLease && isLeaseConflict(output)) {
        const publicFailure = publicError('CONFLICT', 'Sync push force lease no longer matches the remote ref');
        step('push', 'conflicted', publicFailure);
        return completion('conflicted', publicFailure);
      }
      const code = cleanupFailed ? 'UNKNOWN' : [
        'STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED',
        'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'GIT_LFS_CLIENT_MISSING', 'INVALID_REQUEST', 'UNKNOWN',
      ].includes(error.code) ? error.code : 'TRANSPORT_FAILED';
      const publicFailure = publicError(code, cleanupFailed ? 'Git sync operation cleanup failed'
        : `${lfsUploaded ? 'LFS objects were uploaded, but Git ref publication failed. ' : ''}${redacted}`);
      const status = code.startsWith('STALE_') || code === 'REMOTE_CHANGED' ? 'conflicted' : 'failed';
      step(activeStep, status, publicFailure);
      if (status === 'conflicted') return completion('conflicted', publicFailure);
      const partial = results.get('fetch')?.status === 'succeeded';
      return completion(partial ? 'partial' : 'failed', partial && ['GIT_LFS_CLIENT_MISSING', 'INVALID_REQUEST'].includes(code)
        ? publicError('TRANSPORT_FAILED', publicFailure.message) : publicFailure);
    }
  };

  const copyCheckout = async (source, destination, copiedEntries, controls, deadline, birthtimeHolds) => {
    const entries = await awaitPhase(() => fsImpl.readdir(source), controls, deadline);
    for (const entry of entries) {
      const sourcePath = pathImpl.join(source, entry);
      const destinationPath = pathImpl.join(destination, entry);
      const sourceStats = await awaitPhase(() => fsImpl.lstat(sourcePath), controls, deadline);
      if (sourceStats.isDirectory()) {
        await awaitMutation(() => fsImpl.mkdir(destinationPath), controls, deadline, async () => {
          copiedEntries.push({ path: destinationPath, kind: 'directory', identity: directoryIdentity(await fsImpl.lstat(destinationPath), birthtimeHolds) });
        });
        await copyCheckout(sourcePath, destinationPath, copiedEntries, controls, deadline, birthtimeHolds);
      } else if (sourceStats.isSymbolicLink()) {
        const link = await awaitPhase(() => fsImpl.readlink(sourcePath), controls, deadline);
        await awaitMutation(() => fsImpl.symlink(link, destinationPath), controls, deadline, async () => {
          copiedEntries.push({ path: destinationPath, kind: 'symlink', snapshot: lstatSnapshot(await fsImpl.lstat(destinationPath)), link });
        });
      } else if (sourceStats.isFile()) {
        await awaitMutation(() => fsImpl.copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL), controls, deadline, async () => {
          copiedEntries.push({
            path: destinationPath,
            kind: 'file',
            snapshot: lstatSnapshot(await fsImpl.lstat(destinationPath)),
            contentDigest: contentDigest(await fsImpl.readFile(destinationPath)),
          });
        });
      } else {
        throw operationError('CONFLICT', 'Clone checkout contains an unsupported filesystem entry', 409);
      }
    }
  };

  const checkoutMatches = async (quarantined, destination, destinationIdentity, copiedEntries, birthtimeHolds) => {
    const rootStats = await fsImpl.lstat(quarantined);
    if (!rootStats.isDirectory() || directoryIdentity(rootStats, birthtimeHolds) !== destinationIdentity) return false;
    const expected = new Map(copiedEntries.map((entry) => [pathImpl.relative(destination, entry.path), entry]));
    const inspect = async (directory, relativeDirectory = '') => {
      const names = await fsImpl.readdir(directory);
      for (const name of names) {
        const relative = relativeDirectory ? pathImpl.join(relativeDirectory, name) : name;
        const entry = expected.get(relative);
        if (!entry) return false;
        const entryPath = pathImpl.join(directory, name);
        const stats = await fsImpl.lstat(entryPath);
        if (entry.kind === 'directory') {
          if (!stats.isDirectory() || directoryIdentity(stats, birthtimeHolds) !== entry.identity || !await inspect(entryPath, relative)) return false;
        } else if (!sameLstat(stats, entry.snapshot)) {
          return false;
        } else if (entry.kind === 'symlink') {
          if (!stats.isSymbolicLink() || await fsImpl.readlink(entryPath) !== entry.link) return false;
        } else if (!stats.isFile() || contentDigest(await fsImpl.readFile(entryPath)) !== entry.contentDigest) {
          return false;
        }
        expected.delete(relative);
      }
      return true;
    };
    return await inspect(quarantined) && expected.size === 0;
  };

  const quarantineAndClean = async (target, operationId, matches) => {
    const quarantine = await fsImpl.mkdtemp(pathImpl.join(
      pathImpl.dirname(target), `.openchamber-quarantine-${operationId}-`,
    ));
    const moved = pathImpl.join(quarantine, 'object');
    try {
      await fsImpl.rename(target, moved);
    } catch (error) {
      try { await fsImpl.rm(quarantine, { recursive: true, force: true }); } catch {}
      if (error?.code === 'ENOENT') return { removed: true, changed: false, failed: false };
      return { removed: false, changed: false, failed: true };
    }
    let owned = false;
    try { owned = await matches(moved); } catch {}
    if (owned) {
      try {
        await fsImpl.rm(quarantine, { recursive: true, force: true });
        return { removed: true, changed: false, failed: false };
      } catch {
        return { removed: false, changed: false, failed: true };
      }
    }
    try {
      try {
        await fsImpl.lstat(target);
        return { removed: false, changed: true, failed: true };
      } catch (error) {
        if (error?.code !== 'ENOENT') return { removed: false, changed: true, failed: true };
      }
      await fsImpl.rename(moved, target);
      await fsImpl.rm(quarantine, { recursive: true, force: true });
      return { removed: false, changed: true, failed: false };
    } catch {
      return { removed: false, changed: true, failed: true };
    }
  };

  const executeClone = async (plan, controls, deadline = Date.now() + timeoutMs) => {
    let temporaryIdentity;
    let destinationIdentity;
    let birthtimeHolds = false;
    let context;
    let result;
    let cleanupFailed = false;
    const copiedEntries = [];
    let checkoutPublished = false;
    try {
      await awaitMutation(() => fsImpl.mkdir(pathImpl.dirname(plan.destination), { recursive: true }), controls, deadline);
      await awaitMutation(() => fsImpl.mkdir(plan.temporaryDirectory), controls, deadline, async () => {
        birthtimeHolds = await birthtimeHoldsStill(fsImpl, pathImpl, plan.temporaryDirectory);
        temporaryIdentity = directoryIdentity(await fsImpl.stat(plan.temporaryDirectory), birthtimeHolds);
      });
      await controls.markStepCompleted('validated');
      if (controls.isCancellationRequested()) result = cancellationResult(plan, controls, {});
      else {
        context = await transport(plan, controls, deadline);
        if (plan.transportMode === 'managed') await controls.markStepCompleted('authenticated');
        await commandResult({ ...plan, directory: pathImpl.dirname(plan.destination) }, controls, [
          'clone', '--no-checkout', '--', plan.rawEndpoint, plan.temporaryDirectory,
        ], { ...context, env: { ...context.env, GIT_LFS_SKIP_SMUDGE: '1' } }, deadline, { transfer: true });
        await controls.markStepCompleted('transferred');
        if (directoryIdentity(await awaitPhase(() => fsImpl.stat(plan.temporaryDirectory), controls, deadline), birthtimeHolds) !== temporaryIdentity) {
          throw operationError('CONFLICT', 'Clone temporary directory ownership changed', 409);
        }
        if (controls.isCancellationRequested()) result = cancellationResult(plan, controls, {});
        else {
          if (plan.gitIdentityId) {
            if (resolveGitIdentity instanceof Function) {
              const profile = await awaitPhase(() => resolveGitIdentity(plan.gitIdentityId), controls, deadline);
              if (!profile?.userName || !profile?.userEmail) throw operationError('RUNTIME_UNSUPPORTED', 'Git identity application is unavailable', 501);
              await commandResult({ ...plan, directory: plan.temporaryDirectory }, controls,
                ['config', '--local', 'user.name', profile.userName], context, deadline);
              await commandResult({ ...plan, directory: plan.temporaryDirectory }, controls,
                ['config', '--local', 'user.email', profile.userEmail], context, deadline);
            } else if (applyGitIdentity instanceof Function) {
              await awaitMutation(() => applyGitIdentity(plan.temporaryDirectory, plan.gitIdentityId), controls, deadline);
            } else {
              throw operationError('RUNTIME_UNSUPPORTED', 'Git identity application is unavailable', 501);
            }
          }
          if (controls.isCancellationRequested()) result = cancellationResult(plan, controls, {});
          else {
            if (await safeRevoke(context, plan.operationId)) {
              throw operationError('UNKNOWN', 'Clone credential cleanup failed', 500);
            }
            context = undefined;
            await localGit(plan.temporaryDirectory, ['checkout', '--force'], controls, deadline, { disableLfsFilters: true });
            const hydration = await hydrateCheckout({
              ...plan,
              directory: plan.temporaryDirectory,
              parentEndpoint: plan.rawEndpoint,
              parentRemoteName: 'origin',
            }, controls, deadline);
            if (hydration.status === 'cancelled') {
              const unsupported = [...hydration.submodules, ...hydration.lfs].find((entry) => entry.error?.code === 'RUNTIME_UNSUPPORTED');
              const failure = unsupported?.error ?? publicError(
                controls.isCancellationRequested() ? 'CANCELLED' : 'TIMEOUT', 'Checkout hydration was cancelled',
              );
              result = { state: 'cancelled', error: failure, hydration };
              throw Object.assign(new Error(failure.message), { hydrationHandled: true });
            }
            await awaitMutation(() => fsImpl.mkdir(plan.destination), controls, deadline, async () => {
              destinationIdentity = directoryIdentity(await fsImpl.stat(plan.destination), birthtimeHolds);
            });
            if (directoryIdentity(await awaitPhase(() => fsImpl.stat(plan.temporaryDirectory), controls, deadline), birthtimeHolds) !== temporaryIdentity) {
              throw operationError('CONFLICT', 'Clone temporary directory ownership changed', 409);
            }
            await copyCheckout(plan.temporaryDirectory, plan.destination, copiedEntries, controls, deadline, birthtimeHolds);
            if (directoryIdentity(await awaitPhase(() => fsImpl.lstat(plan.destination), controls, deadline), birthtimeHolds) !== destinationIdentity) {
              throw operationError('CONFLICT', 'Clone destination ownership changed', 409);
            }
            checkoutPublished = true;
            await controls.markStepCompleted('checked-out');
            try {
              // Await persistence to settlement. Cancellation cannot roll back a completed checkout.
              const blocked = phaseError(controls, deadline);
              if (blocked) throw blocked;
              if (!(bindClonedRepository instanceof Function)) throw new Error('Clone binding persistence is unavailable');
              await bindClonedRepository({
                directory: plan.destination, approvedEndpoint: plan.rawEndpoint,
                transportMode: plan.transportMode, credentialId: plan.credentialId,
                unverifiedConfirmed: plan.unverifiedConfirmed,
                providerAccount: plan.providerAccount,
                auxiliaryGrants: plan.auxiliaryGrants.filter((grant) => {
                  const entries = grant.kind === 'submodule' ? hydration.submodules : hydration.lfs;
                  return entries.some((entry) => entry.endpoint?.fingerprint === grant.endpoint.fingerprint);
                }),
              });
              await controls.markStepCompleted('updated-local-repository');
              if (['succeeded', 'not-needed'].includes(hydration.status)) result = { state: 'succeeded', hydration };
              else {
                const unsupported = [...hydration.submodules, ...hydration.lfs].find((entry) => entry.error?.code === 'RUNTIME_UNSUPPORTED');
                const failure = unsupported?.error ?? (hydration.status === 'client-missing'
                  ? publicError('GIT_LFS_CLIENT_MISSING', 'Git LFS is required for this checkout; install git-lfs and retry')
                  : hydration.status === 'authorization-required'
                    ? publicError('AUTHENTICATION_REQUIRED', 'Checkout hydration requires an explicit endpoint grant')
                    : hydration.status === 'invalid'
                      ? publicError('INVALID_REQUEST', 'Checkout hydration configuration is invalid')
                      : publicError('TRANSPORT_FAILED', 'Checkout hydration failed'));
                result = { state: 'partial', error: failure, hydration };
              }
            } catch {
              result = { ...terminal('partial', 'UNKNOWN', 'Checkout retained. Open Git setup to finish repository binding; do not clone again.'), hydration };
            }
          }
        }
      }
    } catch (error) {
      if (error?.hydrationHandled) {
        // The bounded hydration result already contains the terminal reason.
      } else if (error?.code === 'EEXIST') result = terminal('conflicted', 'CONFLICT', 'Clone destination already exists');
      else if (error.cancelled || error.timedOut || controls.isCancellationRequested()) result = cancellationResult(plan, controls, error);
      else {
        const code = error.code === 'CONFLICT' || error.code === 'RUNTIME_UNSUPPORTED' ? error.code : 'TRANSPORT_FAILED';
        result = terminal(code === 'CONFLICT' ? 'conflicted' : 'failed', code, createGitRedactor({
          secrets: [...(context?.secrets ?? []), plan.destination, plan.temporaryDirectory],
        }).error(error));
      }
    }

    cleanupFailed ||= await safeRevoke(context, plan.operationId);
    let cleanupComplete = true;
    if (!checkoutPublished && destinationIdentity) {
      const cleanup = await quarantineAndClean(plan.destination, plan.operationId,
        (moved) => checkoutMatches(moved, plan.destination, destinationIdentity, copiedEntries, birthtimeHolds));
      cleanupFailed ||= cleanup.failed;
      cleanupComplete &&= cleanup.removed;
    }
    if (temporaryIdentity) {
      const cleanup = await quarantineAndClean(plan.temporaryDirectory, plan.operationId, async (moved) => {
        const stats = await fsImpl.lstat(moved);
        return stats.isDirectory() && directoryIdentity(stats, birthtimeHolds) === temporaryIdentity;
      });
      cleanupFailed ||= cleanup.failed || !cleanup.removed;
      cleanupComplete &&= cleanup.removed;
    }
    if (!cleanupFailed && cleanupComplete && temporaryIdentity) await controls.markStepCompleted('cleaned-up');
    if (cleanupFailed) {
      const cleanupResult = terminal(checkoutPublished ? 'partial' : 'failed', 'UNKNOWN',
        checkoutPublished ? 'Checkout retained. Open Git setup and check clone cleanup; do not clone again.' : 'Clone cleanup failed');
      return result?.hydration ? { ...cleanupResult, hydration: result.hydration } : cleanupResult;
    }
    return result ?? terminal('failed', 'UNKNOWN', 'Clone failed');
  };

  const executeHydration = async (plan, controls, deadline = Date.now() + timeoutMs) => {
    const plannedHydration = Array.isArray(plan.plannedTransfers);
    if (plan.preparedHydrationFailure) {
      const hydration = Object.freeze({
        status: plan.preparedHydrationFailure.status,
        submodules: [],
        lfs: [{ path: '.', ...plan.preparedHydrationFailure }],
      });
      if (hydration.status === 'cancelled') {
        return { state: 'cancelled', error: hydration.lfs[0].error, hydration };
      }
      return { state: 'failed', error: hydration.lfs[0].error, hydration };
    }
    if (plannedHydration) {
      try {
        if (plan.target.repositoryId) await revalidate(plan, controls, deadline);
        const inspection = await inspectCheckoutHydration({
          directory: plan.directory,
          parentEndpoint: plan.parentEndpoint,
          parentRemoteName: plan.parentRemoteName,
          controls,
          deadline,
        });
        if (inspection.headSha !== plan.expectedHeadSha
          || inspection.sourceRequired !== plan.plannedSourceRequired
          || JSON.stringify(inspection.requirements) !== JSON.stringify(plan.plannedRequirements)
          || JSON.stringify(inspection.transfers) !== JSON.stringify(plan.plannedTransfers)) {
          return terminal('conflicted', 'STALE_CONFIG', 'Checkout hydration requirements changed; plan again');
        }
        await controls.markStepCompleted('validated');
      } catch (error) {
        if (error?.cancelled || error?.timedOut || controls.isCancellationRequested()) {
          return cancellationResult(plan, controls, error);
        }
        const code = ['STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED'].includes(error?.code)
          ? error.code : authorityCode(error);
        return terminal('conflicted', code, 'Checkout hydration authority changed; plan again');
      }
    }
    const hydration = await hydrateCheckout(plan, controls, deadline);
    if (['succeeded', 'not-needed'].includes(hydration.status)) {
      if (plan.target.operation === 'checkout-hydration') {
        await controls.markStepCompleted('checked-out');
        if (plan.target.repositoryId && onCheckoutHydrated instanceof Function) await onCheckoutHydrated(plan.directory);
      }
      return { state: 'succeeded', hydration };
    }
    if (hydration.status === 'cancelled') {
      const timedOut = [...hydration.submodules, ...hydration.lfs]
        .some((entry) => entry.error?.code === 'TIMEOUT');
      return {
        state: 'cancelled',
        error: publicError(timedOut ? 'TIMEOUT' : 'CANCELLED', timedOut ? 'Checkout hydration timed out' : 'Checkout hydration was cancelled'),
        hydration,
      };
    }
    if (hydration.status === 'client-missing') {
      return { state: 'failed', error: publicError('GIT_LFS_CLIENT_MISSING', 'Git LFS is required for this checkout; install git-lfs and retry'), hydration };
    }
    if (hydration.status === 'authorization-required') {
      return { state: 'failed', error: publicError('AUTHENTICATION_REQUIRED', 'Checkout hydration requires an explicit endpoint grant'), hydration };
    }
    if (hydration.status === 'invalid') {
      return { state: 'failed', error: publicError('INVALID_REQUEST', 'Checkout hydration configuration is invalid'), hydration };
    }
    const unsupported = [...hydration.submodules, ...hydration.lfs].find((entry) => entry.error?.code === 'RUNTIME_UNSUPPORTED');
    return { state: 'failed', error: unsupported?.error ?? publicError('TRANSPORT_FAILED', 'Checkout hydration failed'), hydration };
  };

  // Auxiliary credentials must not replace the fetch or push actor in the operation result.
  const hydrateIntegration = (plan, controls, deadline) => executeHydration({
    operationId: plan.operationId,
    directory: plan.directory,
    target: plan.target,
    parentEndpoint: plan.rawEndpoint,
    parentRemoteName: plan.target.remote.name,
    hydrateSubmodules: false,
    repositoryAuthority: {
      directory: plan.directory,
      repositoryId: plan.target.repositoryId,
      bindingRevision: plan.target.bindingRevision,
      configRevision: plan.target.configRevision,
    },
  }, { ...controls, updateTransportMetadata: () => {} }, deadline);

  const executeContributorFetch = async (plan, controls, deadline = Date.now() + timeoutMs) => {
    let context;
    try {
      await revalidateContributorSource(plan, controls, deadline);
      await controls.markStepCompleted('validated');
      context = await transport(plan, controls, deadline);
      await controls.markStepCompleted('authenticated');
      await revalidateContributorSource(plan, controls, deadline);
      await commandResult(plan, controls, [
        'fetch', '--no-tags', '--', plan.rawEndpoint, `${plan.target.sourceRef}:${plan.target.destinationRef}`,
      ], context, deadline, { transfer: true });
      await controls.markStepCompleted('transferred');
      const fetchedSha = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, plan.target.destinationRef, { controls, deadline }), controls, deadline,
      )).toLowerCase();
      if (fetchedSha !== plan.expectedSha) throw operationError('STALE_CONFIG', 'Fetched change request head did not match', 409);
      return { state: 'succeeded' };
    } catch (error) {
      if (error.cancelled || error.timedOut || controls.isCancellationRequested()) return cancellationResult(plan, controls, error);
      if (error.code === 'STALE_CONFIG') return terminal('conflicted', 'STALE_CONFIG', error.message);
      if (error.code === 'RUNTIME_UNSUPPORTED') return terminal('failed', 'RUNTIME_UNSUPPORTED', error.message);
      if (error.code === 'UNKNOWN') return terminal('failed', 'UNKNOWN', 'Change request source resolution failed');
      return terminal('failed', 'AUTHENTICATION_REQUIRED',
        'The selected account does not authorize the change request head repository');
    } finally {
      await safeRevoke(context, plan.operationId);
    }
  };

  const snapshotCheckoutHook = async (action, operationId, controls, deadline) => {
    const root = await awaitPhase(
      () => fsImpl.mkdtemp(pathImpl.join(os.tmpdir(), `openchamber-checkout-hook-${operationId}-`)),
      controls,
      deadline,
    );
    try {
      await awaitMutation(() => fsImpl.chmod(root, 0o700), controls, deadline);
      const snapshotPath = pathImpl.join(root, 'post-checkout');
      await awaitMutation(
        () => fsImpl.writeFile(snapshotPath, action.content, { flag: 'wx', mode: 0o500 }),
        controls,
        deadline,
      );
      await awaitMutation(() => fsImpl.chmod(snapshotPath, 0o500), controls, deadline);
      const handle = await awaitPhase(
        () => fsImpl.open(snapshotPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW),
        controls,
        deadline,
      );
      try {
        const stats = await awaitPhase(() => handle.stat(), controls, deadline);
        const bytes = await awaitPhase(() => handle.readFile(), controls, deadline);
        if (!stats.isFile() || (platform !== 'win32' && (stats.mode & 0o077) !== 0)
          || contentDigest(bytes) !== action.contentDigest) {
          throw operationError('STALE_CONFIG', 'Checkout hook snapshot verification failed', 409);
        }
      } finally {
        await handle.close().catch(() => {});
      }
      return { root, path: snapshotPath };
    } catch (error) {
      await awaitPhase(() => fsImpl.rm(root, { recursive: true, force: true }), undefined, Date.now() + CLEANUP_TIMEOUT_MS).catch(() => {});
      throw error;
    }
  };

  const execute = (plan, controls, deadline) => {
    if (plan.target.operation === 'checkout-hydration') return executeHydration(plan, controls, deadline);
    if (plan.target.operation === 'checkout-actions') return (async () => {
      const snapshotRoots = [];
      let result;
      try {
        const inspected = await awaitPhase(() => plan.inspect(), controls, deadline);
        if (inspected.digest !== plan.actionDigest) {
          return terminal('conflicted', 'STALE_CONFIG', 'Checkout actions changed; nothing was run');
        }
        await controls.markStepCompleted('validated');
        for (const action of inspected.actions) {
          const snapshot = action.kind === 'post-checkout-hook'
            ? await snapshotCheckoutHook(action, plan.operationId, controls, deadline)
            : null;
          if (snapshot) snapshotRoots.push(snapshot.root);
          const invocation = snapshot
            ? { binary: snapshot.path, args: [plan.nullRef, plan.headSha, '1'] }
            : { binary: platform === 'win32' ? (inheritedEnv.ComSpec || 'cmd.exe') : '/bin/sh', args: platform === 'win32' ? ['/d', '/s', '/c', action.command] : ['-c', action.command] };
          const result = await run({
            ...invocation,
            cwd: plan.directory,
            env: snapshot ? { ...inheritedEnv, GIT_DIR: action.gitDir, GIT_WORK_TREE: action.workTree } : { ...inheritedEnv },
            controls,
            deadline,
          });
          if (result.code !== 0 || result.cancelled || result.timedOut) {
            throw operationError(result.timedOut ? 'TIMEOUT' : result.cancelled ? 'CANCELLED' : 'UNKNOWN', 'Checkout action failed', 500, result);
          }
        }
        result = { state: 'succeeded' };
      } catch (error) {
        result = error.cancelled || error.timedOut || controls.isCancellationRequested()
          ? cancellationResult(plan, controls, error)
          : terminal(error.code === 'STALE_CONFIG' ? 'conflicted' : 'failed', error.code === 'STALE_CONFIG' ? 'STALE_CONFIG' : 'UNKNOWN', 'Checkout action failed');
      } finally {
        let cleanupFailed = false;
        for (const root of snapshotRoots) {
          try {
            await awaitPhase(() => fsImpl.rm(root, { recursive: true, force: true }), undefined, Date.now() + CLEANUP_TIMEOUT_MS);
          } catch {
            cleanupFailed = true;
          }
        }
        if (cleanupFailed && result?.state === 'succeeded') result = terminal('failed', 'UNKNOWN', 'Checkout hook cleanup failed');
      }
      return result;
    })();
    if (plan.target.operation === 'contributor-fetch') return executeContributorFetch(plan, controls, deadline);
    if (plan.target.operation === 'clone') return executeClone(plan, controls, deadline);
    if (plan.target.operation === 'sync') return executeSync(plan, controls, deadline);
    return executeExisting(plan, controls, deadline);
  };
  const auditId = (operationId) => `git:${operationId}`;
  const auditTarget = (plans) => {
    const { target } = plans.publicPlan;
    const remote = (value, role) => {
      if (!value) return null;
      const result = {
        role,
        name: value.name ?? 'clone-source',
        endpointFingerprint: value.endpoint?.fingerprint ?? value.fingerprint,
      };
      if (value.sourceRef) result.sourceRef = value.sourceRef;
      if (value.destinationRef) result.destinationRef = value.destinationRef;
      return result;
    };
    if (target.operation === 'checkout-hydration') {
      const auxiliaries = [];
      const seen = new Set();
      for (const transfer of plans.internalPlan.plannedTransfers ?? []) {
        const key = `${transfer.kind}\0${transfer.endpoint.fingerprint}`;
        if (seen.has(key)) continue;
        seen.add(key);
        auxiliaries.push({ kind: transfer.kind, endpointFingerprint: transfer.endpoint.fingerprint });
      }
      return { kind: 'git-network', operation: target.operation, remotes: [], auxiliaries };
    }
    const remotes = target.operation === 'sync'
      ? [remote(target.fetch, 'fetch'), remote(target.push, 'push')]
      : [remote(target.remote, 'operation')];
    const value = { kind: 'git-network', operation: target.operation, remotes: remotes.filter(Boolean) };
    if (target.operation === 'fetch' && target.fetchScope === 'remote') {
      value.fetchScope = 'remote';
      value.force = target.force;
    }
    if (target.destination) value.destination = target.destination;
    return value;
  };
  const auditTransportPart = (plan, systemMarker = 'system-credentials') => plan.transportMode === 'managed'
    ? { kind: 'managed', credentialId: plan.credentialId }
    : plan.transportMode === 'anonymous' ? { kind: 'anonymous' } : { kind: 'system', marker: systemMarker };
  const auditTransportReference = (plans) => {
    if (plans.internalPlan.target?.operation === 'checkout-hydration') {
      const entries = (plans.internalPlan.plannedAuxiliaryAuthorities ?? []).map((authority) => ({
        kind: authority.kind,
        endpointFingerprint: authority.endpointFingerprint,
        transport: auditTransportPart(authority),
      }));
      return entries.length ? { kind: 'auxiliary', entries } : null;
    }
    if (plans.internalPlan.target?.operation === 'sync') {
      return {
        kind: 'sync',
        fetch: auditTransportPart(plans.internalPlan.fetch),
        push: auditTransportPart(plans.internalPlan.push),
      };
    }
    if (plans.internalPlan.target?.operation === 'checkout-actions') {
      return { kind: 'system', marker: 'local-checkout-actions' };
    }
    return auditTransportPart(plans.internalPlan);
  };
  const authoritativeProviderAccountId = (internalPlan) => {
    if (internalPlan.target?.operation === 'checkout-hydration') return null;
    const managed = internalPlan.target?.operation === 'sync'
      ? [internalPlan.fetch, internalPlan.push].filter((part) => part.transportMode === 'managed')
      : internalPlan.transportMode === 'managed' ? [internalPlan] : [];
    if (!managed.length) return null;
    const identities = managed.map((part) => {
      try {
        const reference = parseGitCredentialReference(part.credentialId);
        if (reference.transport !== 'https') return null;
        return reference.providerUserId;
      } catch {
        return null;
      }
    });
    return identities.every(Boolean) && new Set(identities).size === 1 ? identities[0] : null;
  };
  const planAudit = (plans) => auditStore?.plan({
    id: auditId(plans.publicPlan.operationId),
    initiator: 'user',
    executorKind: 'openchamber-server-git',
    runtime: plans.publicPlan.runtimeIdentity,
    repositoryId: plans.publicPlan.target.repositoryId
      ?? plans.internalPlan.auditRepositoryId
      ?? plans.internalPlan.repositoryAuthority?.repositoryId
      ?? plans.internalPlan.sourceAuthority?.repositoryId
      ?? null,
    providerAccountId: authoritativeProviderAccountId(plans.internalPlan),
    transportReference: auditTransportReference(plans),
    target: auditTarget(plans),
  });
  const auditResult = (snapshot) => ({
    state: snapshot.state,
    errorCode: snapshot.error?.code ?? null,
    steps: [
      ...(snapshot.completedSteps ?? []),
      ...(snapshot.stepResults ?? []).map((step) => `${step.step}:${step.status}`),
    ],
  });
  const registerWithAudit = async (plans) => {
    const registered = await operationRegistry.register(plans);
    try {
      const auditClaim = await planAudit(plans);
      if (auditClaim?.status === 'existing') {
        throw Object.assign(new Error('Source control audit record already exists'), {
          code: 'SOURCE_CONTROL_AUDIT_CONFLICT',
        });
      }
      return registered;
    } catch (error) {
      await operationRegistry.cancel(plans.publicPlan.operationId);
      throw error;
    }
  };
  const planWithDeadline = async (request, deadline) => {
    let plans = await awaitPhase(() => planner.planNetworkOperation(request), undefined, deadline);
    plans = await prepareHydrationPlans(plans, deadline);
    if (plans.internalPlan.target.operation === 'clone' && plans.internalPlan.gitIdentityId) {
      if (!(validateGitIdentity instanceof Function)) throw operationError('INVALID_GIT_IDENTITY', 'Selected Git identity is unavailable', 400);
      try { await awaitPhase(() => validateGitIdentity(plans.internalPlan.gitIdentityId), undefined, deadline); }
      catch (error) {
        if (error?.timedOut || error?.code === 'TIMEOUT') throw error;
        throw operationError('INVALID_GIT_IDENTITY', 'Selected Git identity is unavailable', 400);
      }
    }
    return registerWithAudit(plans);
  };
  const plan = (request) => planWithDeadline(request, Date.now() + timeoutMs);
  const auditedStarts = new Map();
  const auditedExecutions = new Map();
  const executeOperation = (operationId, deadline) => {
    const startRegistry = () => operationRegistry.start(
      operationId, (operationPlan, controls) => execute(operationPlan, controls, deadline),
    );
    if (!auditStore) return startRegistry();
    const active = auditedExecutions.get(operationId);
    if (active) return active;
    const started = Promise.resolve(operationRegistry.get(operationId)).then((snapshot) => {
      if (snapshot.state !== 'planned') return { execution: startRegistry() };
      return auditStore.start(auditId(operationId)).then(() => ({ execution: startRegistry() }));
    });
    auditedStarts.set(operationId, started);
    const operation = started
      .then(({ execution }) => execution)
      .then(async (result) => {
        await auditStore.finish(auditId(operationId), auditResult(result));
        return result;
      });
    auditedExecutions.set(operationId, operation);
    operation.finally(() => {
      if (auditedExecutions.get(operationId) === operation) auditedExecutions.delete(operationId);
      if (auditedStarts.get(operationId) === started) auditedStarts.delete(operationId);
    }).catch(() => {});
    return operation;
  };
  const runHydrationOperation = async ({ directory, parentRemoteName, parentEndpoint, repositoryAuthority }) => {
    const deadline = Date.now() + timeoutMs;
    const operationId = `git_${crypto.randomUUID()}`;
    let inspection;
    let preparedHydrationFailure;
    try {
      inspection = await inspectCheckoutHydration({ directory, parentEndpoint, parentRemoteName, deadline });
    } catch (error) {
      preparedHydrationFailure = hydrationError(error);
      inspection = { headSha: '', requirements: [], transfers: [], sourceRequired: false };
    }
    const publicPlan = Object.freeze({
      operationId,
      runtimeIdentity,
      transport: null,
      target: { operation: 'checkout-hydration' },
      completedSteps: [],
      state: 'planned',
    });
    const internalPlan = {
      ...publicPlan,
      directory,
      parentRemoteName,
      parentEndpoint,
      repositoryAuthority,
      expectedHeadSha: inspection.headSha,
      plannedRequirements: inspection.requirements,
      plannedTransfers: inspection.transfers,
      plannedSourceRequired: inspection.sourceRequired,
    };
    if (preparedHydrationFailure) internalPlan.preparedHydrationFailure = preparedHydrationFailure;
    const plans = await prepareHydrationPlans({
      publicPlan,
      internalPlan,
    }, deadline);
    await registerWithAudit(plans);
    const result = await executeOperation(operationId, deadline);
    return result.hydration;
  };

  return Object.freeze({
    plan,
    issueContributorDestination: planner.issueContributorDestination,
    async transferContributorHead({ directory, sourceRequest, source, credentialId, destinationRef }) {
      const operationId = `git_${crypto.randomUUID()}`;
      const publicPlan = Object.freeze({
        operationId,
        runtimeIdentity,
        transport: publicTransportForContributor(),
        target: {
          operation: 'contributor-fetch',
          remote: { name: source.requestedRemoteName, endpoint: {
            displayUrl: redactGitText(source.endpoint),
            fingerprint: contentDigest(source.endpoint),
          } },
          sourceRef: source.headRef,
          destinationRef,
        },
        completedSteps: [],
        state: 'planned',
      });
      const internalPlan = {
        ...publicPlan,
        directory,
        rawEndpoint: source.endpoint,
        transportMode: 'managed',
        credentialId,
        expectedSha: source.headSha,
        sourceRequest,
        sourceAuthority: {
          repositoryId: source.context.repositoryId,
          bindingRevision: source.context.bindingRevision,
          accountId: source.context.accountId,
          instance: source.context.instance,
          primaryRemote: source.context.primaryRemote,
          sourceProjectId: source.sourceProject.id,
        },
      };
      await registerWithAudit({ internalPlan, publicPlan });
      return executeOperation(operationId, Date.now() + timeoutMs);
    },
    async decideCheckoutTrust({ directory, repositoryId, digest, decision, inspect, headSha, nullRef }) {
      const inspected = await inspect();
      if (inspected.digest !== digest) throw operationError('STALE_CONFIG', 'Checkout actions changed; nothing was run', 409);
      if (decision === 'skip') return Object.freeze({ state: 'skipped', digest });
      if (decision !== 'run') throw operationError('INVALID_REQUEST', 'Checkout trust decision is invalid', 400);
      const operationId = `git_${crypto.randomUUID()}`;
      const publicPlan = {
        operationId, runtimeIdentity, transport: { mode: 'system', verification: { status: 'unverified', reason: 'local-checkout-actions' } },
        target: { operation: 'checkout-actions' }, completedSteps: [], state: 'planned',
      };
      await registerWithAudit({
         publicPlan,
         internalPlan: { ...publicPlan, directory, auditRepositoryId: repositoryId, actionDigest: digest, inspect, headSha, nullRef },
       });
      return executeOperation(operationId, Date.now() + timeoutMs);
    },
    execute: executeOperation,
    async cloneRepository({ remoteUrl, destinationPath, gitIdentityId, unverifiedConfirmed }) {
      const deadline = Date.now() + timeoutMs;
      let planned;
      try {
        planned = await planWithDeadline(
          { operation: 'clone', remoteUrl, destinationPath, transportMode: 'system', unverifiedConfirmed, gitIdentityId }, deadline,
        );
      } catch (error) {
        if (/destination.*already exists/i.test(error?.message || '')) {
          throw operationError('CONFLICT', 'Clone destination already exists', 409);
        }
        throw error;
      }
      const result = await executeOperation(planned.operationId, deadline);
      return result.state === 'succeeded' ? { ...result, output: '' } : result;
    },
    async hydrateCheckout({ directory, parentRemoteName, parentEndpoint, repositoryAuthority }) {
      return runHydrationOperation({ directory, parentRemoteName, parentEndpoint, repositoryAuthority });
    },
    async hydrateBoundCheckout({ directory, parentRemoteName, parentEndpoint, repositoryAuthority }) {
      let endpoint = parentEndpoint;
      if (!endpoint && parentRemoteName && repositoryAuthority) {
        const authority = await validateGitTransportContext({
          directory,
          ...repositoryAuthority,
          remote: parentRemoteName,
          endpointKind: 'fetch',
        });
        endpoint = authority.endpoint;
      }
      return runHydrationOperation({ directory, parentRemoteName, parentEndpoint: endpoint, repositoryAuthority });
    },
    inspectCheckoutHydration: async ({ directory, parentEndpoint, parentRemoteName }) => {
      const { transfers: _transfers, sourceRequired: _sourceRequired, ...inspection } = await inspectCheckoutHydration({
        directory, parentEndpoint, parentRemoteName,
      });
      return inspection;
    },
    get: (operationId) => operationRegistry.get(operationId),
    cancel(operationId) {
      if (!auditStore) return operationRegistry.cancel(operationId);
      return (async () => {
        const pendingStart = auditedStarts.get(operationId);
        if (pendingStart) await pendingStart;
        const result = await operationRegistry.cancel(operationId);
        if (!['planned', 'running'].includes(result.state)) {
          await auditStore.finish(auditId(operationId), auditResult(result));
        }
        return result;
      })();
    },
  });
}
