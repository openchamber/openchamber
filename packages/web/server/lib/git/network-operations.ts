import { resolveHydrationSource } from './hydration-source.js';
import { isGitString as isString } from './input-guards.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import os from 'node:os';
import { createGitCredentialBroker, GIT_CREDENTIAL_NONCE_ENV } from './credential-broker.js';
import { helperShellCommand } from './helper-launch.js';
import { gitLfsCredentialEndpointAliases, normalizeGitRemoteEndpoint, parseGitCredentialReference } from './credential-resolver.js';
import { createNetworkOperationPlanner, isChangeReviewRemote } from './network-operation-plan.js';
import { createNetworkOperationRegistry, expectedHydrationStatus } from './network-operation-registry.js';
import { createGitRedactor, redactGitText } from './redaction.js';
import { createGitlinksStream, SUBMODULE_DISCOVERY_LIMITS } from './submodule-discovery.js';
import { createLfsFileScanner, discoverLfs, scanLfsPushObjects, resolveLfsPushConfig, LFS_DISCOVERY_LIMITS, SAFE_FILTERS } from './lfs-discovery.js';
import { checkoutAuxiliaryOf, hydrationError, hydrationFailure, parseHydrationSubmodules, resolveHydrationSubmodule, withDerivedFromRemote } from './hydration-results.js';
import { fingerprintRemoteUrl, redactRemoteUrl } from '../source-control/url-redaction.js';
import { birthtimeHoldsStill } from './directory-birthtime.js';
import type { ChildProcess } from 'node:child_process';
import type { Stats } from 'node:fs';
import type { BinaryLike } from 'node:crypto';
import type { LfsEndpoint, LfsObjectEntry } from './lfs-discovery.js';
import type { JsonValue } from '../shared/json-values.js';
import type { AuditPlan, AuditResultInput } from '../source-control/audit-storage.js';
import type { EndpointDisplay, HydrationRequirement, HydrationTransfer } from './network-plan-contracts.js';
import type {
  AuditPlans, AuxiliaryAuthority, CheckoutActionsPlan, CheckoutHydration, CheckoutTrustInput, ClonePlan,
  Completion, ContributorPlan, ContributorTransferSource, CopiedCheckoutEntry,
  ExecutionControls, ExecutionPlan, ExistingPlan, HydrationInput,
  HydrationInspectionInput, HydrationPart, HydrationPlan, HydrationRequirementWithEndpoint,
  LeasedTransportContext, LocalGitOptions, LstatSnapshot, NetworkOperationsOptions,
  PhaseControls, PhaseOptions, PostCheckoutHookAction,
  PublicFailure, RunOptions, RunResult, SourceRequest, SyncPlan, TransportContext,
  TransportPlan, TrustedDirectoriesOptions,
} from './network-execution-contracts.js';

const occupied = <Value>(value: Value | undefined): Value => {
  if (value === undefined) throw new TypeError('Git execution invariant value is missing');
  return value;
};
type ErrorFields = {
  code?: unknown; message?: unknown; reason?: unknown; status?: unknown;
  cancelled?: unknown; timedOut?: unknown; stderr?: unknown; stdout?: unknown;
  hydrationHandled?: unknown;
};
const hasErrorFields = (value: unknown): value is ErrorFields => value !== null && value !== undefined;
const errorFields = <Value>(value: Value): ErrorFields => hasErrorFields(value) ? value : {};
const requiredErrorFields = <Value>(value: Value): ErrorFields => {
  if (!hasErrorFields(value)) throw new TypeError('Git error fields are missing');
  return value;
};
const isClonePlan = (plan: ExecutionPlan): plan is ClonePlan => plan.target.operation === 'clone';
const isSyncPlan = (plan: ExecutionPlan): plan is SyncPlan => plan.target.operation === 'sync';
const isHydrationPlan = (plan: ExecutionPlan): plan is HydrationPlan => plan.target.operation === 'checkout-hydration';
const isContributorPlan = (plan: ExecutionPlan): plan is ContributorPlan => plan.target.operation === 'contributor-fetch';
const isActionsPlan = (plan: ExecutionPlan): plan is CheckoutActionsPlan => plan.target.operation === 'checkout-actions';
const isExistingPlan = (plan: ExecutionPlan): plan is ExistingPlan => !isClonePlan(plan)
  && !isSyncPlan(plan) && !isHydrationPlan(plan) && !isContributorPlan(plan) && !isActionsPlan(plan);
const existingPlan = (plan: ExecutionPlan) => {
  if (!isExistingPlan(plan)) throw new TypeError('Existing Git execution plan is missing');
  return plan;
};
const resolvedLfsEndpoint = (endpoint: LfsEndpoint) => {
  if (endpoint.status !== 'resolved') throw new TypeError('Required LFS endpoint is missing');
  return endpoint;
};
const knownErrorCode = <Code>(code: Code) => {
  if (!isString(code)) throw new TypeError('Validated Git error code is missing');
  return code;
};
const isHydrationTransport = (plan: ExecutionPlan | TransportPlan): plan is HydrationPlan => plan.target.operation === 'checkout-hydration';
const isSyncTransport = (plan: ExecutionPlan | TransportPlan): plan is SyncPlan => plan.target.operation === 'sync';
const stringInvariant = (value: JsonValue | undefined) => {
  if (!isString(value)) throw new TypeError('Validated Git reference is missing');
  return value;
};
const hasNetworkRemote = (value: unknown): value is { name: string; endpoint: EndpointDisplay } => value !== null
  && typeof value === 'object' && 'name' in value && isString(value.name)
  && 'endpoint' in value && value.endpoint !== null && typeof value.endpoint === 'object'
  && 'displayUrl' in value.endpoint && isString(value.endpoint.displayUrl)
  && 'fingerprint' in value.endpoint && isString(value.endpoint.fingerprint);
const syncRemote = (value: JsonValue | undefined) => {
  if (!hasNetworkRemote(value)) throw new TypeError('Validated Git remote is missing');
  return value;
};
type ContributorFields = {
  context?: unknown; sourceProject?: unknown; repositoryId?: unknown; bindingRevision?: unknown;
  accountId?: unknown; instance?: unknown; primaryRemote?: unknown; id?: unknown;
  headSha?: unknown; headRef?: unknown; endpoint?: unknown;
};
const hasContributorFields = (value: unknown): value is ContributorFields => value !== null && value !== undefined;
const contributorFields = <Value>(value: Value): ContributorFields => {
  if (!hasContributorFields(value)) throw new TypeError('Contributor source fields are missing');
  return value;
};
type ResolvedCredential = Awaited<ReturnType<NonNullable<NetworkOperationsOptions['credentialResolver']>['resolve']>>;
const managedCredential = (credential: ResolvedCredential) => {
  if (!('transport' in credential)) throw new TypeError('Managed Git credential is missing');
  return credential;
};
const requireHttpsCredential = (credential: ResolvedCredential | undefined) => {
  const managed = managedCredential(occupied(credential));
  if (managed.transport !== 'https') throw new TypeError('HTTPS Git credential is missing');
  return managed;
};
const requireSshCredential = (credential: ResolvedCredential | undefined) => {
  const managed = managedCredential(occupied(credential));
  if (managed.transport !== 'ssh') throw new TypeError('SSH Git credential is missing');
  return managed;
};
const isContributorTransport = (plan: TransportPlan): plan is TransportPlan & ContributorPlan => plan.target.operation === 'contributor-fetch';
const hasExistingTransport = (plan: TransportPlan): plan is TransportPlan & ExistingPlan => plan.target.operation !== 'clone';
const existingTransport = (plan: TransportPlan) => {
  if (!hasExistingTransport(plan)) throw new TypeError('Existing Git transport is missing');
  return plan;
};
const hasHydrationExistingPlan = (plan: HydrationPlan): plan is HydrationPlan & ExistingPlan => Boolean(plan.target.repositoryId);
const hydrationExistingPlan = (plan: HydrationPlan) => {
  if (!hasHydrationExistingPlan(plan)) throw new TypeError('Bound checkout hydration plan is missing');
  return plan;
};
const rethrow = (error: Error): never => { throw error; };
const commandAction = (action: Awaited<ReturnType<CheckoutTrustInput['inspect']>>['actions'][number]) => {
  if (action.kind === 'post-checkout-hook') throw new TypeError('Checkout command is missing');
  return action;
};
const hookAction = (action: Awaited<ReturnType<CheckoutTrustInput['inspect']>>['actions'][number]) => {
  if (action.kind !== 'post-checkout-hook') throw new TypeError('Checkout hook is missing');
  return action;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const SSH_WRAPPER_PATH = fileURLToPath(new URL('./ssh-wrapper.js', import.meta.url));

export const managedSshCommand = (privateKeyPath: string) =>
  `OPENCHAMBER_GIT_SSH_KEY=${shellQuote(privateKeyPath)} ${helperShellCommand(SSH_WRAPPER_PATH)}`;
const MANAGED_ENV_NAMES = new Set([
  'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GIT_CONFIG_COUNT',
  'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT',
  'GIT_PROXY_COMMAND', 'SSH_AUTH_SOCK', 'OPENCHAMBER_GIT_SSH_KEY', 'OPENCHAMBER_GIT_SSH_PASSPHRASE',
  'OPENCHAMBER_GIT_SSH_EXECUTABLE',
  'GIT_SSL_CERT', 'GIT_SSL_KEY', 'GIT_SSL_CAINFO', 'GIT_SSL_CAPATH',
  'GIT_SSL_CIPHER_LIST', 'GIT_SSL_VERSION', 'GIT_SSL_NO_VERIFY',
  'GIT_SSL_CERT_PASSWORD_PROTECTED', 'CURL_CA_BUNDLE', 'SSL_CERT_FILE',
  'SSL_CERT_DIR', 'SSLKEYLOGFILE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY',
  'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NETRC',
]);
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const INDEX_FILE_MODES = new Set(['100644', '100755', '120000', '160000']);
const LINE_ENDING_CONFIG_PATTERN = 'core\\.(autocrlf|eol|safecrlf|attributesfile)';

const operationError = <Details extends object, Status = number>(code: string, message: string, status: Status | number = 500, details: Details | Record<never, never> = {}) => Object.assign(new Error(message), details, { code, status });
const publicError = <Code, Message>(code: Code, message: Message) => ({ code, message });
const terminal = <Code, Message>(state: string, code: Code, message: Message): Completion => ({ state, error: publicError(code, message) });
const INDEX_ENTRY_PATTERN = /^([0-7]{6}) ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-3])\t([^]+)$/;
const createIndexFilesStream = (scanner: ReturnType<typeof createLfsFileScanner>) => {
  let remainder: Buffer = Buffer.alloc(0);
  let batch: string[] = [];
  let objectEntries = new Map<string, LfsObjectEntry>();
  let batchBytes = 0;
  let previousStageZeroPath: string | null = null;
  const flush = async () => {
    if (!batch.length) return;
    const pending = batch;
    const pendingObjectEntries = objectEntries;
    batch = [];
    objectEntries = new Map();
    batchBytes = 0;
    await scanner.scanBatch(pending, pendingObjectEntries);
  };
  const add = async (record: Buffer) => {
    const text = record.toString('utf8');
    if (text.includes('\ufffd')) throw operationError('INVALID_REQUEST', 'Tracked-file listing is not valid UTF-8', 409);
    const match = text.match(INDEX_ENTRY_PATTERN);
    if (!match) throw operationError('INVALID_REQUEST', 'Tracked-file listing is invalid', 409);
    if (match[3] !== '0') return;
    const file = occupied(match[4]);
    if (!INDEX_FILE_MODES.has(occupied(match[1])) || previousStageZeroPath === file) {
      throw operationError('INVALID_REQUEST', 'Tracked-file listing is invalid', 409);
    }
    previousStageZeroPath = file;
    if (match[1] === '160000') return;
    const bytes = Buffer.byteLength(file) + 32;
    if (bytes > LFS_DISCOVERY_LIMITS.maxBatchBytes) {
      throw operationError('LFS_DISCOVERY_LIMIT_EXCEEDED', 'Tracked path exceeds its byte limit', 409);
    }
    if (batch.length >= LFS_DISCOVERY_LIMITS.fileBatchSize || batchBytes + bytes > LFS_DISCOVERY_LIMITS.maxBatchBytes) {
      await flush();
    }
    batch.push(file);
    batchBytes += bytes;
    objectEntries.set(file, { oid: occupied(match[2]), type: 'blob' });
  };
  return Object.freeze({
    async write(chunk: Buffer) {
      const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      remainder = remainder.length ? Buffer.concat([remainder, input]) : input;
      for (let separator; (separator = remainder.indexOf(0)) >= 0;) {
        const record = remainder.subarray(0, separator);
        remainder = remainder.subarray(separator + 1);
        if (!record.length) throw operationError('INVALID_REQUEST', 'Tracked-file listing is invalid', 409);
        await add(record);
      }
      if (remainder.length > LFS_DISCOVERY_LIMITS.maxBatchBytes) {
        throw operationError('LFS_DISCOVERY_LIMIT_EXCEEDED', 'Tracked-file listing record exceeds its byte limit', 409);
      }
    },
    async complete() {
      if (remainder.length) throw operationError('INVALID_REQUEST', 'Tracked-file listing is incomplete', 409);
      await flush();
      return scanner.result();
    },
  });
};
const singleRefFetchRefspec = (sourceRef: string, destinationRef: string) => (
  `${destinationRef.startsWith('refs/remotes/') ? '+' : ''}${sourceRef}:${destinationRef}`
);
const fileIdentity = (stats: Stats) => `${stats.dev}:${stats.ino}`;
const directoryIdentity = (stats: Stats, birthtimeHolds: boolean) => (birthtimeHolds
  ? `${fileIdentity(stats)}:${stats.birthtimeMs}` : fileIdentity(stats));
const lstatSnapshot = (stats: Stats) => ({
  identity: fileIdentity(stats),
  mode: stats.mode,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  ctimeMs: stats.ctimeMs,
});
const sameLstat = (stats: Stats, snapshot: LstatSnapshot) => stats
  && fileIdentity(stats) === snapshot.identity
  && stats.mode === snapshot.mode
  && stats.size === snapshot.size
  && stats.mtimeMs === snapshot.mtimeMs
  && stats.ctimeMs === snapshot.ctimeMs;
const shellQuote = (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const contentDigest = (value: BinaryLike) => crypto.createHash('sha256').update(value).digest('base64url');
const publicTransportForContributor = () => ({
  mode: 'managed', verification: { status: 'verified', method: 'credential' },
});

const managedEnvironment = (source: NodeJS.ProcessEnv, platform: NodeJS.Platform) => {
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

const TRUSTED_DIRECTORIES_READ_TIMEOUT_MS = 5_000;
const gitConfigValue = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const createTrustedDirectoriesConfig = ({
  gitBinary = 'git',
  inheritedEnv = process.env,
  spawnImpl = spawn,
  fsImpl = fs,
  pathImpl = path,
  tmpdir = os.tmpdir,
}: TrustedDirectoriesOptions = {}) => {
  let directory: string | null = null;
  const readValues = () => new Promise<string[]>((resolve) => {
    let child: ReturnType<typeof spawn> & { stdout: NonNullable<ChildProcess['stdout']> };
    try {
      child = spawnImpl(gitBinary, ['config', '--null', '--includes', '--get-all', 'safe.directory'], {
        cwd: tmpdir(), env: { ...inheritedEnv }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      resolve([]);
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), TRUSTED_DIRECTORIES_READ_TIMEOUT_MS);
    timer.unref?.();
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.once('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8').split('\0').slice(0, -1) : []);
    });
  });
  const write = async (content: string) => {
    directory ??= await fsImpl.mkdtemp(pathImpl.join(tmpdir(), 'openchamber-git-trust-'));
    const target = pathImpl.join(directory, 'config');
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    await fsImpl.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await fsImpl.rename(temporary, target);
    return target;
  };
  return async () => {
    const values = (await readValues()).filter((value) => !/[\r\n]/.test(value));
    if (values.length === 0) return null;
    const content = `[safe]\n${values.map((value) => `\tdirectory = ${gitConfigValue(value)}\n`).join('')}`;
    try {
      return await write(content);
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.code !== 'ENOENT') throw cause;
      directory = null;
      return write(content);
    }
  };
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
const configResetValue = (key: string) => {
  const normalized = key.toLowerCase();
  const suffix = normalized.slice(normalized.lastIndexOf('.') + 1);
  if (normalized.startsWith('http.')) return HTTP_CONFIG_RESETS.get(suffix);
  if (normalized.startsWith('credential.')) return CREDENTIAL_CONFIG_RESETS.get(suffix);
  return undefined;
};

const terminateProcessTree = (child: ChildProcess, { platform, spawnImpl, escalationMs }: {
  platform: NodeJS.Platform; spawnImpl: typeof spawn; escalationMs: number;
}) => {
  if (!child || child.exitCode !== null || child.signalCode) return;
  try {
    if (platform === 'win32' && Number.isInteger(child.pid)) {
      const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/t'], {
        shell: false, windowsHide: true, stdio: 'ignore',
      });
      killer.unref?.();
    } else if (Number.isInteger(child.pid)) {
      try { process.kill(-occupied(child.pid), 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { void 0; } }
    } else {
      try { child.kill('SIGTERM'); } catch { void 0; }
    }
  } catch { void 0; }
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode) return;
    try {
      if (platform === 'win32' && Number.isInteger(child.pid)) {
        const killer = spawnImpl('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          shell: false, windowsHide: true, stdio: 'ignore',
        });
        killer.unref?.();
      } else if (Number.isInteger(child.pid)) {
        try { process.kill(-occupied(child.pid), 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { void 0; } }
      } else {
        try { child.kill('SIGKILL'); } catch { void 0; }
      }
    } catch { void 0; }
  }, escalationMs);
  timer.unref?.();
  child.once?.('close', () => clearTimeout(timer));
};

const appendBounded = (chunks: Buffer[], chunk: Buffer, state: { bytes: number }, limit: number) => {
  if (state.bytes >= limit) return;
  const value = Buffer.from(chunk);
  const remaining = limit - state.bytes;
  chunks.push(value.subarray(0, remaining));
  state.bytes += Math.min(value.length, remaining);
};

const authorityCode = (cause: unknown) => {
  const error = errorFields(cause);
  if (error?.reason === 'needs-attention') return 'AUTHENTICATION_REQUIRED';
  if (error?.code === 'SOURCE_CONTROL_BINDING_STALE') return 'STALE_BINDING';
  if (error?.code === 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY') return 'STALE_REPOSITORY';
  if (error?.code === 'INVALID_GIT_TRANSPORT_CONTEXT') return 'INVALID_REQUEST';
  return 'REMOTE_CHANGED';
};
const transportFailureCode = (text: string) => /authentication failed|permission denied|could not read username/i.test(text)
  ? 'AUTHENTICATION_FAILED' : 'TRANSPORT_FAILED';
const isLeaseConflict = (text: string) => /stale info|force-with-lease|rejected.*stale/i.test(text);

const phaseError = (controls: PhaseControls | undefined, deadline: number) => {
  if (controls?.isCancellationRequested()) {
    return operationError('CANCELLED', 'Git network operation was cancelled', 499, { cancelled: true });
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    return operationError('TIMEOUT', 'Git network operation timed out', 408, { timedOut: true });
  }
  return null;
};

const awaitPhase = <Value>(work: () => Value | PromiseLike<Value>, controls: PhaseControls | undefined, deadline: number): Promise<Value> => {
  const blocked = phaseError(controls, deadline);
  if (blocked) return Promise.reject(blocked);
  const remaining = deadline - Date.now();
  const pending = Promise.resolve().then(work);
  return new Promise<Value>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => {};
    const finish = <Result>(callback: (value: Result) => void, value: Result) => {
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

const awaitMutation = async <Value>(work: () => Promise<Value>, controls: PhaseControls | undefined, deadline: number, record: (value: Value) => void | Promise<void> = async () => {}) => {
  const blocked = phaseError(controls, deadline);
  if (blocked) throw blocked;
  const value = await work();
  await record(value);
  const interrupted = phaseError(controls, deadline);
  if (interrupted) throw interrupted;
  return value;
};

const REJECTED_LINE_RE = /^!\s*\[(?:remote )?rejected\]/;
const REMOTE_ERROR_LINE_RE = /^remote:\s*(?:error|fatal)\b/i;
const remoteRejection = (detail: string) => {
  const lines = [...new Set(detail.split('\n').map((line) => line.trim()).filter(Boolean))];
  const rejected = lines.filter((line) => REJECTED_LINE_RE.test(line));
  const errors = lines.filter((line) => REMOTE_ERROR_LINE_RE.test(line));
  return rejected.length || errors.length ? [...rejected, ...errors].slice(0, 12).join('\n') : null;
};
const leadWithRejection = (text: string) => remoteRejection(text) ?? text;

export function createNetworkOperations({
  validateGitTransportContext,
  validateManagedSshCredential,
  resolveSourceControlAccount,
  sourceControlProviders,
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
  trustedDirectoriesConfig,
}: NetworkOperationsOptions = {}) {
  if (!(validateGitTransportContext instanceof Function) || !(credentialResolver?.resolve instanceof Function)) {
    throw new TypeError('Git network operation dependencies are invalid');
  }
  const managedGitEnvironment = async () => {
    const env = managedEnvironment(inheritedEnv, platform);
    const trusted = trustedDirectoriesConfig instanceof Function
      ? await trustedDirectoriesConfig().catch(() => null)
      : null;
    if (trusted) env.GIT_CONFIG_GLOBAL = trusted;
    return env;
  };

  const cancelChild = (child: ChildProcess) => terminateProcessTree(child, { platform, spawnImpl, escalationMs });
  const registryOptions = { cancelChild, store: operationStore };
  const operationRegistry = registry ?? createNetworkOperationRegistry(registryOptions);
  if (auditStore && (!(auditStore.plan instanceof Function)
    || !(auditStore.start instanceof Function) || !(auditStore.finish instanceof Function))) {
    throw new TypeError('Git network operation audit store is invalid');
  }
  let brokerStart: Promise<void> | null = null;
  const startBroker = () => {
    credentialBroker ??= createGitCredentialBroker();
    brokerStart ??= credentialBroker.start().catch((error) => {
      brokerStart = null;
      throw error;
    });
    return brokerStart;
  };

  async function run(options: RunOptions & { rawOutput: true }): Promise<RunResult<Buffer>>;
  async function run(options: RunOptions & { rawOutput?: false }): Promise<RunResult>;
  async function run(options: RunOptions): Promise<RunResult<string | Buffer>>;
  async function run({
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
    onStdout,
  }: RunOptions): Promise<RunResult<string | Buffer>> {
    if (transfer) await controls?.markTransferStarted(transferRole);
    return new Promise<RunResult<string | Buffer>>((resolve, reject) => {
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = { bytes: 0 };
    const stderrState = { bytes: 0 };
    let timedOut = false;
    let settled = false;
    let outputExceeded = false;
    let inputError: unknown;
    let stdoutWork = Promise.resolve();
    let resolveStdoutEnd: () => void = () => {};
    const stdoutEnd = onStdout && child.stdout
      ? new Promise<void>((resolve) => { resolveStdoutEnd = resolve; })
      : Promise.resolve();
    if (onStdout && child.stdout) child.stdout.once('end', () => resolveStdoutEnd());
    child.stdout?.on('data', (chunk) => {
      if (onStdout) {
        child.stdout?.pause();
        stdoutWork = stdoutWork.then(() => onStdout(chunk)).catch((error) => {
          inputError = error;
          cancelChild(child);
        }).finally(() => child.stdout?.resume());
        return;
      }
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
    const settle = <Failure>(error: Failure, code: number | null, signal: NodeJS.Signals | null) => {
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
      else if (error || inputError) {
        const cause = error || inputError;
        const causeCode = errorFields(cause).code;
        const updated = Object.assign(cause ?? {}, result);
        if (causeCode) Object.assign(updated, { code: causeCode });
        reject(cause);
      }
      else resolve(result);
    };
    child.once('error', (error) => {
      stdoutWork.then(() => settle(error, null, null), () => settle(error, null, null));
    });
    child.once('close', (code, signal) => {
      Promise.all([stdoutWork, stdoutEnd]).then(
        () => settle(null, code, signal),
        (error) => settle(error, code, signal),
      );
    });
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
  }

  const queryGit = async (directory: string, args: string[], { controls, deadline = Date.now() + timeoutMs }: PhaseOptions = {}) => {
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
  const enumerateManagedConfigKeysImpl = enumerateManagedConfigKeys ?? (async (plan: TransportPlan, controls: ExecutionControls, deadline: number, env: NodeJS.ProcessEnv) => {
    const result = await run({
      cwd: plan.directory ?? pathImpl.dirname(occupied(plan.destination)),
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
  const resolveRemoteFetchMappingImpl = resolveRemoteFetchMapping ?? (async (directory: string, remoteName: string, { controls, deadline = Date.now() + timeoutMs }: PhaseOptions = {}) => {
    let result;
    try {
      result = await run({
        cwd: directory, args: ['config', '--includes', '--null', '--get-all', `remote.${remoteName}.fetch`],
        env: { ...inheritedEnv, GIT_CONFIG: undefined }, controls, deadline,
        maxOutputBytes: 8192, requireCompleteOutput: true,
      });
    } catch (cause) {
      const error = errorFields(cause);
      if (error.cancelled || error.timedOut) throw cause;
      throw operationError('STALE_CONFIG', 'Remote Fetch configuration is unavailable', 409);
    }
    if (result.cancelled || result.timedOut || (result.code !== 0 && result.code !== 1)) {
      throw operationError('STALE_CONFIG', 'Remote Fetch configuration is unavailable', 409, result);
    }
    return result.stdout;
  });
  const checkBranchNameImpl = async (directory: string, name: string) => {
    const result = await run({
      cwd: directory,
      args: ['check-ref-format', '--branch', name],
      env: { ...inheritedEnv, GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' },
      deadline: Date.now() + timeoutMs,
    });
    return result.code === 0 && !result.timedOut && !result.cancelled ? result.stdout.trim() : null;
  };
  const planner = createNetworkOperationPlanner({
    validateGitTransportContext,
    validateManagedSshCredential,
    resolveSourceControlAccount,
    sourceControlProviders,
    contributorProvenance,
    resolveRef: resolveRefImpl,
    resolveSymbolicRef: resolveSymbolicRefImpl,
    resolveRemoteFetchMapping: resolveRemoteFetchMappingImpl,
    checkBranchName: checkBranchNameImpl,
    inspectCheckoutHydration: (input) => inspectCheckoutHydration(input),
    runtimeIdentity,
    idFactory,
    fsImpl,
    pathImpl,
  });

  const mergedTransportRevision = async (plan: ExistingPlan, controls: ExecutionControls, deadline: number) => {
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
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.cancelled || error?.timedOut) throw cause;
      throw operationError(authorityCode(error), 'Git network operation authority changed', error?.status ?? 409);
    }
    return authority.transportRevision;
  };

  const revalidate = async (plan: ExistingPlan, controls: ExecutionControls, deadline: number) => {
    if (plan.contributorAuthority) {
      const record = await awaitPhase(() => occupied(contributorProvenance).read(plan.directory), controls, deadline);
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
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.cancelled || error?.timedOut) throw cause;
      throw operationError(authorityCode(error), 'Git network operation authority changed', error?.status ?? 409);
    }
    if (authority.endpoint !== plan.rawEndpoint
      || authority.endpointFingerprint !== plan.target.remote.endpoint.fingerprint
      || authority.transportMode !== plan.transportMode
      || authority.transportRevision !== plan.transportRevision
      || (authority.credentialId ?? null) !== (plan.credentialId ?? null)) {
      throw operationError('REMOTE_CHANGED', 'Git remote or transport binding changed', 409);
    }
    if (plan.changeReviewRemote && !isChangeReviewRemote(authority, sourceControlProviders)) {
      throw operationError('REMOTE_CHANGED', 'The remote is no longer a change host\'s primary remote', 409);
    }
    if (plan.sourceSha) {
      const sourceSha = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, occupied(plan.target.sourceRef), { controls, deadline }), controls, deadline,
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
  const revalidateContributorSource = async (plan: ContributorPlan, controls: ExecutionControls, deadline: number) => {
    if (!(resolveChangeRequestSource instanceof Function)) {
      throw operationError('RUNTIME_UNSUPPORTED', 'Contributor source resolution is unavailable', 501);
    }
    let current;
    try {
      current = await awaitPhase(() => resolveChangeRequestSource(plan.sourceRequest), controls, deadline);
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.status === 409 || String(error?.code || '').includes('STALE')
        || String(error?.code || '').includes('BINDING')) {
        throw operationError('STALE_CONFIG', 'Change request source authority changed', 409);
      }
      if (error?.code === 'MALFORMED_PROVIDER_RESPONSE') {
        throw operationError('UNKNOWN', 'Change request source response was invalid', 502);
      }
      throw cause;
    }
    if (contributorFields(contributorFields(current).context).repositoryId !== plan.sourceAuthority.repositoryId
      || contributorFields(contributorFields(current).context).bindingRevision !== plan.sourceAuthority.bindingRevision
      || contributorFields(contributorFields(current).context).accountId !== plan.sourceAuthority.accountId
      || contributorFields(contributorFields(current).context).instance !== plan.sourceAuthority.instance
      || contributorFields(contributorFields(current).context).primaryRemote !== plan.sourceAuthority.primaryRemote
      || contributorFields(contributorFields(current).sourceProject).id !== plan.sourceAuthority.sourceProjectId
      || contributorFields(current).headSha !== plan.expectedSha || contributorFields(current).headRef !== plan.target.sourceRef
      || contributorFields(current).endpoint !== plan.rawEndpoint) {
      throw operationError('STALE_CONFIG', 'Change request source changed', 409);
    }
  };

  const revalidatePullHead = async (plan: { directory: string; destinationSha?: string; target: { destinationRef?: string } }, controls: ExecutionControls, deadline: number) => {
    const headRef = await awaitPhase(() => resolveSymbolicRefImpl(plan.directory, { controls, deadline }), controls, deadline);
    const headSha = await awaitPhase(() => resolveRefImpl(plan.directory, occupied(plan.target.destinationRef), { controls, deadline }), controls, deadline);
    if (headRef !== plan.target.destinationRef || String(headSha).toLowerCase() !== plan.destinationSha) {
      throw operationError('STALE_CONFIG', 'Checked out branch changed after pull planning', 409);
    }
  };
  const hasMergeState = inspectMergeState ?? (async (directory: string) => {
    const dotGit = pathImpl.join(directory, '.git');
    let gitDirectory = dotGit;
    const stats = await fsImpl.stat(dotGit);
    if (!stats.isDirectory()) {
      const contents = await fsImpl.readFile(dotGit, 'utf8');
      const match = contents.match(/^gitdir: (.+)\s*$/);
      if (!match) return false;
      gitDirectory = pathImpl.resolve(directory, occupied(match[1]));
    }
    for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD']) {
      try {
        await fsImpl.stat(pathImpl.join(gitDirectory, marker));
        return true;
      } catch (cause) {
        if (errorFields(cause)?.code !== 'ENOENT') throw cause;
      }
    }
    return false;
  });

  const transport = async (plan: TransportPlan, controls: ExecutionControls, deadline: number): Promise<LeasedTransportContext> => {
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
    let credential: Extract<Awaited<ReturnType<NonNullable<NetworkOperationsOptions['credentialResolver']>['resolve']>>, { mode: 'managed' }> | undefined;
    try {
      if (!anonymous) credential = managedCredential(await awaitPhase(() => occupied(credentialResolver).resolve({
        mode: 'managed',
        credentialId: plan.credentialId,
        endpoint: normalizeGitRemoteEndpoint(occupied(plan.rawEndpoint)),
        operationId: plan.operationId,
        deadline,
        controls,
      }), controls, deadline));
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.cancelled || error?.timedOut || error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') throw cause;
      throw operationError('AUTHENTICATION_REQUIRED', 'Managed Git credential is unavailable', 409);
    }
    const env = await managedGitEnvironment();
    if (anonymous || occupied(credential).transport === 'https') {
      for (const name of Object.keys(env)) {
        if (['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'HOMEDRIVE', 'HOMEPATH'].includes(name.toUpperCase())) delete env[name];
      }
      env.HOME = env.USERPROFILE = env.XDG_CONFIG_HOME = platform === 'win32' ? 'NUL' : '/dev/null';
    }
    if (anonymous) {
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
    if (anonymous || occupied(credential).transport === 'https') {
      const configuredKeys = await awaitPhase(
        () => enumerateManagedConfigKeysImpl(plan, controls, deadline, env), controls, deadline,
      );
      if (anonymous && configuredKeys.some((key) => /^url\./i.test(key))) {
        throw operationError('RUNTIME_UNSUPPORTED', 'Anonymous transport does not support repository URL rewrites', 501);
      }
      if (isContributorTransport(plan)) await revalidateContributorSource(plan, controls, deadline);
      else if (plan.target.operation !== 'clone') await revalidate(existingTransport(plan), controls, deadline);
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
      const httpsCredential = requireHttpsCredential(credential);
      await awaitPhase(startBroker, controls, deadline);
      const lease = occupied(credentialBroker).issue({
        operationId: plan.operationId,
        credential: httpsCredential,
        endpointAliases: plan.auxiliaryKind === 'lfs' ? gitLfsCredentialEndpointAliases(httpsCredential.allowedEndpoint, plan.lfsDerivedFromRemote) : [],
      });
      if (httpsCredential.actor) controls.updateTransportMetadata(httpsCredential.actor, plan.transportRole);
      configArgs.push(...lease.gitConfigArgs);
      Object.assign(env, lease.env);
      return {
        env,
        configArgs,
        revoke: async () => { try { lease.revoke(); return true; } catch { return false; } },
        secrets: [httpsCredential.password, ...(lease.redactionSecrets ?? [])],
      };
    }
    if (occupied(credential).transport !== 'ssh') {
      throw operationError('AUTHENTICATION_REQUIRED', 'Managed Git credential is unavailable', 409);
    }
    const sshCredential = requireSshCredential(credential);
    env.OPENCHAMBER_GIT_SSH_KEY = sshCredential.key.privateKeyPath;
    Object.assign(env, sshCredential.key.askpassEnv);
    env.GIT_SSH_COMMAND = helperShellCommand(SSH_WRAPPER_PATH);
    env.GIT_SSH_VARIANT = 'ssh';
    controls.updateTransportMetadata({ fingerprint: sshCredential.key.fingerprint }, plan.transportRole);
    return {
      env,
      configArgs,
      revoke: async () => {
        try { return sshCredential.key.cleanup ? await sshCredential.key.cleanup() : true; } catch { return false; }
      },
      secrets: [sshCredential.key.sourcePath, sshCredential.key.privateKeyPath,
        ...(sshCredential.key.askpassEnv ? [sshCredential.key.askpassEnv.OPENCHAMBER_GIT_SSH_PASSPHRASE] : [])],
    };
  };

  const trackingRefOf = (plan: ExistingPlan, remoteRef: string) => (remoteRef.startsWith('refs/heads/')
    ? `refs/remotes/${plan.target.remote.name}/${remoteRef.slice('refs/heads/'.length)}`
    : null);
  const recordRemoteTrackingRef = async (plan: ExistingPlan, controls: ExecutionControls, context: TransportContext | undefined, deadline: number, sha: string | null | undefined, remoteRef = plan.target.destinationRef) => {
    const trackingRef = trackingRefOf(plan, occupied(remoteRef));
    if (!trackingRef) return null;
    try {
      await commandResult(plan, controls, sha ? ['update-ref', trackingRef, sha] : ['update-ref', '-d', trackingRef], context, deadline);
      return sha ? trackingRef : null;
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.cancelled || error?.timedOut || error?.code === 'CANCELLED' || error?.code === 'TIMEOUT') throw cause;
      return null;
    }
  };

  const pullRebaseArgs = (fetchedSha: string, trackingRef: string | null) => (trackingRef
    ? ['rebase', '--no-verify', '--no-autostash', '--fork-point', '--onto', fetchedSha, trackingRef]
    : ['rebase', '--no-verify', '--no-autostash', fetchedSha]);

  const commandResult = async (plan: Pick<TransportPlan, 'operationId' | 'directory' | 'destination' | 'temporaryDirectory'>, controls: ExecutionControls, args: string[], context: TransportContext | undefined, deadline: number, options: {
    localRefCleanup?: boolean; cwd?: string; transfer?: boolean; transferRole?: string;
  } = {}) => {
    const localRefCleanup = options.localRefCleanup === true
      && args.length === 3
      && args[0] === 'update-ref'
      && args[1] === '-d'
      && args[2] === `refs/openchamber/network/${plan.operationId}`;
    const result = await run({
      cwd: options.cwd ?? plan.directory,
      args: [...occupied(context).configArgs, ...args],
      env: occupied(context).env,
      controls,
      deadline,
      transfer: options.transfer === true,
      transferRole: options.transferRole,
      allowAfterCancellation: localRefCleanup,
    });
    if (result.code === 0 && !result.timedOut && (!result.cancelled || localRefCleanup)) return result;
    const redactor = createGitRedactor({
      secrets: [occupied(context).secrets, plan.directory, plan.destination, plan.temporaryDirectory].flat().filter((value): value is string => Boolean(value)),
    });
    const detail = redactor.error(`${result.stderr}\n${result.stdout}`, 'Git transport failed');
    throw operationError(transportFailureCode(detail), detail, 500, result);
  };

  const refuseRemoteDefaultBranch = async (plan: ExistingPlan, controls: ExecutionControls, deadline: number) => {
    const probe = await transport(plan, controls, deadline);
    let output;
    try {
      output = await commandResult(plan, controls, ['ls-remote', '--symref', '--', occupied(plan.rawEndpoint), 'HEAD'], probe, deadline);
    } finally {
      if (await safeRevoke(probe, plan.operationId)) rethrow(operationError('UNKNOWN', 'Git credential cleanup failed', 500));
    }
    const defaultRef = /^ref: (\S+)\tHEAD$/m.exec(String(output.stdout))?.[1];
    if (defaultRef === plan.target.destinationRef) {
      throw operationError('INVALID_REQUEST', "The remote's default branch can't be deleted", 409);
    }
  };

  const localIntegrationContext = async (directory: string, controls: ExecutionControls, deadline: number) => {
    const env = {
      ...await managedGitEnvironment(),
      GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_LFS_SKIP_SMUDGE: '1',
    };
    const configArgs = [
      '-c', `core.hooksPath=${platform === 'win32' ? 'NUL' : '/dev/null'}`,
      '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-c', 'merge.autoStash=false',
      '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.required=false',
    ];
    const readConfig = async (configEnv: NodeJS.ProcessEnv, args: string[], unavailable: string): Promise<[string, string?][]> => {
      const result = await run({
        cwd: directory, env: configEnv, controls, deadline, requireCompleteOutput: true,
        args: ['config', '--includes', '--null', ...args],
      });
      if (result.cancelled || result.timedOut) {
        throw operationError(result.timedOut ? 'TIMEOUT' : 'CANCELLED', 'Local integration was interrupted', 409, result);
      }
      if (![0, 1].some((code) => code === result.code) || (result.stdout && !result.stdout.endsWith('\0'))) {
        throw operationError('STALE_CONFIG', unavailable, 409);
      }
      return result.stdout.split('\0').filter(Boolean).map((entry) => {
        const separator = entry.indexOf('\n');
        return separator < 0 ? [entry] : [entry.slice(0, separator), entry.slice(separator + 1)];
      });
    };
    const blocked = phaseError(controls, deadline);
    if (blocked) throw blocked;
    const filterKeys = (await readConfig(env, [
      '--name-only', '--get-regexp', '^filter\\..*\\.(process|smudge|clean|required)$',
    ], 'Local Git filter configuration is unavailable')).map(([key]) => key);
    for (const key of filterKeys) {
      if (!/^filter\.[^\0\r\n=]+\.(process|smudge|clean|required)$/i.test(key)) {
        throw operationError('STALE_CONFIG', 'Local Git filter configuration is invalid', 409);
      }
      configArgs.push('-c', `${key}=${key.toLowerCase().endsWith('.required') ? 'false' : ''}`);
    }
    let lfsClean;
    let lfsExtension = false;
    for (const [key, value] of await readConfig({ ...inheritedEnv, GIT_CONFIG: undefined }, [
      '--get-regexp', `^(${LINE_ENDING_CONFIG_PATTERN}|filter\\.lfs\\.clean|lfs\\.extension\\..*)$`,
    ], 'Git configuration is unavailable')) {
      if (key === 'filter.lfs.clean') lfsClean = value;
      else if (key.startsWith('lfs.extension.')) lfsExtension = true;
      else configArgs.push('-c', value === undefined ? key : `${key}=${value}`);
    }
    if (lfsClean === SAFE_FILTERS['filter.lfs.clean'] && !lfsExtension && !filterKeys.includes('filter.lfs.process')) {
      configArgs.push('-c', `filter.lfs.clean=${lfsClean}`);
    } else {
      configArgs.push('-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=');
    }
    return { env, configArgs, secrets: [] };
  };

  function localGit(directory: string, args: string[], controls: ExecutionControls | undefined, deadline: number, options: LocalGitOptions & { rawOutput: true }): Promise<Buffer>;
  function localGit(directory: string, args: string[], controls: ExecutionControls | undefined, deadline: number, options?: LocalGitOptions & { rawOutput?: false }): Promise<string>;
  async function localGit(directory: string, args: string[], controls: ExecutionControls | undefined, deadline: number, {
    input, allowedCodes = [0], disableLfsFilters = false,
    maxOutputBytes = outputLimitBytes, rawOutput = false,
    onStdout,
  }: LocalGitOptions = {}): Promise<string | Buffer> {
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
      maxOutputBytes, rawOutput, onStdout, requireCompleteOutput: !onStdout,
    });
    if (!allowedCodes.includes(result.code) || result.cancelled || result.timedOut) {
      if (result.cancelled || result.timedOut) throw operationError(result.timedOut ? 'TIMEOUT' : 'CANCELLED', 'Checkout hydration was interrupted', result.timedOut ? 408 : 499, result);
      throw operationError('TRANSPORT_FAILED', 'Checkout hydration Git query failed', 500, result);
    }
    return result.stdout;
  }
  const currentAuxiliaryAuthority = async (hydrationPlan: Pick<HydrationPlan, 'auxiliaryGrants' | 'repositoryAuthority' | 'directory' | 'authorityDirectory' | 'parentRemoteName'>, kind: 'submodule' | 'lfs', rawEndpoint: string, controls: ExecutionControls | undefined, deadline: number, derivedFromRemote?: string): Promise<AuxiliaryAuthority> => {
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
    const input: Parameters<NonNullable<NetworkOperationsOptions['validateGitAuxiliaryContext']>>[0] = {
      ...occupied(hydrationPlan.repositoryAuthority),
      directory: hydrationPlan.authorityDirectory ?? hydrationPlan.directory,
      kind, rawEndpoint,
    };
    if (hydrationPlan.parentRemoteName) input.parentRemote = hydrationPlan.parentRemoteName;
    return await awaitPhase(() => validateGitAuxiliaryContext(withDerivedFromRemote(input, derivedFromRemote)), controls, deadline);
  };
  const sameAuxiliaryAuthority = (left: AuxiliaryAuthority, right: AuxiliaryAuthority) => (left.endpoint ?? left.rawEndpoint) === (right.endpoint ?? right.rawEndpoint)
    && left.endpointFingerprint === right.endpointFingerprint
    && left.transportMode === right.transportMode
    && (left.credentialId ?? null) === (right.credentialId ?? null)
    && (left.transportRevision ?? null) === (right.transportRevision ?? null);
  const auxiliaryTransport = async (hydrationPlan: HydrationPlan, kind: 'submodule' | 'lfs', rawEndpoint: string, controls: ExecutionControls, deadline: number, foundAfterPlanning = false, lfsDerivedFromRemote?: string) => {
    const pinned = hydrationPlan.plannedAuxiliaryAuthorities?.find((candidate) => candidate.kind === kind
      && candidate.rawEndpoint === rawEndpoint);
    if (hydrationPlan.plannedAuxiliaryAuthorities && !pinned && !foundAfterPlanning) {
      throw operationError('GIT_AUXILIARY_AUTHORIZATION_REQUIRED', 'Git auxiliary endpoint authorization is required', 409);
    }
    const authority = pinned ?? await currentAuxiliaryAuthority(hydrationPlan, kind, rawEndpoint, controls, deadline, lfsDerivedFromRemote);
    if (pinned) {
      const current = await currentAuxiliaryAuthority(hydrationPlan, kind, rawEndpoint, controls, deadline, lfsDerivedFromRemote);
      if (!sameAuxiliaryAuthority(authority, current)) {
        throw operationError('REMOTE_CHANGED', 'Git auxiliary endpoint grant changed', 409);
      }
    }
    const auxiliaryPlan: TransportPlan & { rawEndpoint: string; auxiliaryKind: 'submodule' | 'lfs' } = {
      operationId: hydrationPlan.operationId,
      directory: hydrationPlan.directory,
      rawEndpoint,
      transportMode: authority.transportMode,
      credentialId: authority.credentialId,
      auxiliaryKind: kind, lfsDerivedFromRemote,
      target: { operation: 'clone' },
    };
    const context = await transport(auxiliaryPlan, { ...controls, updateTransportMetadata: () => {} }, deadline);
    const current = await currentAuxiliaryAuthority(hydrationPlan, kind, rawEndpoint, controls, deadline, lfsDerivedFromRemote);
    if (!sameAuxiliaryAuthority(authority, current)) {
      await safeRevoke(context, hydrationPlan.operationId);
      throw operationError('REMOTE_CHANGED', 'Git auxiliary endpoint grant changed', 409);
    }
    return { authority, auxiliaryPlan, context, foundAfterPlanning };
  };

  const auxiliaryTransfer = async (transfer: Awaited<ReturnType<typeof auxiliaryTransport>>, hydrationPlan: HydrationPlan, controls: ExecutionControls, args: string[], context: TransportContext, deadline: number, { ownAudit = false }: { ownAudit?: boolean } = {}) => {
    const execute = () => commandResult(transfer.auxiliaryPlan, controls, args, context, deadline, { transfer: true });
    if (!auditStore || !(transfer.foundAfterPlanning || ownAudit)) return execute();
    const { authority, auxiliaryPlan } = transfer;
    const endpointFingerprint = fingerprintRemoteUrl(auxiliaryPlan.rawEndpoint);
    const kind = auxiliaryPlan.auxiliaryKind;
    const recordId = `git:${hydrationPlan.operationId}:auxiliary:${crypto.randomUUID()}`;
    const claimed = await awaitPhase(() => auditStore.plan({
      id: recordId, initiator: 'user', executorKind: 'openchamber-server-git', runtime: occupied(runtimeIdentity),
      repositoryId: hydrationPlan.repositoryAuthority?.repositoryId ?? null, providerAccountId: null,
      target: { kind: 'git-network', operation: 'checkout-hydration', remotes: [], auxiliaries: [{ kind, endpointFingerprint }] },
      transportReference: { kind: 'auxiliary', entries: [{ kind, endpointFingerprint, transport: auditTransportPart(authority) }] },
    }), controls, deadline);
    if (claimed?.status === 'existing') throw operationError('UNKNOWN', 'Git auxiliary audit identity is already in use', 409);
    let failure: unknown;
    try {
      await awaitMutation(() => auditStore.start(recordId), controls, deadline);
      const current = await currentAuxiliaryAuthority(hydrationPlan, kind, auxiliaryPlan.rawEndpoint, controls, deadline, auxiliaryPlan.lfsDerivedFromRemote);
      if (!sameAuxiliaryAuthority(authority, current)) throw operationError('REMOTE_CHANGED', 'Git auxiliary endpoint grant changed', 409);
      return await execute();
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        await awaitPhase(() => auditStore.finish(recordId, {
          state: failure ? errorFields(failure).cancelled || errorFields(failure).timedOut ? 'cancelled' : 'failed' : 'succeeded',
          errorCode: failure ? hydrationError(failure).error.code : null,
          steps: failure ? ['validated'] : ['validated', 'transferred'],
        }), undefined, Date.now() + CLEANUP_TIMEOUT_MS);
      } catch {
        if (!failure) rethrow(operationError('UNKNOWN', 'Git auxiliary audit completion failed', 500));
      }
    }
  };

  const prepareHydrationPlans = async (plans: AuditPlans, deadline: number): Promise<AuditPlans> => {
    if (plans.internalPlan.target?.operation !== 'checkout-hydration') return plans;
    const authorities = [];
    const seen = new Set();
    for (const transfer of isHydrationPlan(plans.internalPlan) ? plans.internalPlan.plannedTransfers ?? [] : []) {
      const key = `${transfer.kind}\0${transfer.endpoint.fingerprint}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let authority;
      try {
        authority = await currentAuxiliaryAuthority(
          occupied(isHydrationPlan(plans.internalPlan) ? plans.internalPlan : undefined), transfer.kind, transfer.rawEndpoint, undefined, deadline, transfer.derivedFromRemote,
        );
      } catch (cause) {
        if (errorFields(cause)?.code === 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED') continue;
        throw cause;
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
      const plannedAuthority: AuxiliaryAuthority = {
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
  const nullConfigRecords = (output: string, pattern: RegExp) => output ? output.split('\0').filter(Boolean).flatMap((record) => {
    const separator = record.indexOf('\n');
    if (separator < 1) return [];
    const key = record.slice(0, separator);
    return pattern.test(key) ? [{ key, value: record.slice(separator + 1) }] : [];
  }) : [];
  const inspectSubmoduleDirectory = async (directory: string, relativePath: string) => {
    const parts = relativePath.split('/');
    let current = directory;
    for (let index = 0; index < parts.length; index += 1) {
      current = pathImpl.join(current, occupied(parts[index]));
      let stats;
      try {
        stats = await fsImpl.lstat(current);
      } catch (cause) {
        if (errorFields(cause)?.code === 'ENOENT') {
          return { path: pathImpl.join(directory, relativePath), exists: false };
        }
        throw cause;
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw Object.assign(new Error('Submodule checkout path is not a real directory'), { code: 'INVALID_SUBMODULE_GITLINK' });
      }
    }
    try {
      await fsImpl.lstat(pathImpl.join(current, '.git'));
    } catch (cause) {
      if (errorFields(cause)?.code === 'ENOENT') return { path: current, exists: true, ownsRepository: false };
      throw cause;
    }
    return { path: current, exists: true, ownsRepository: true };
  };
  const ensureSubmoduleParentDirectories = async (directory: string, relativePath: string, controls: ExecutionControls, deadline: number) => {
    const parts = relativePath.split('/');
    let current = directory;
    for (const part of parts.slice(0, -1)) {
      current = pathImpl.join(current, part);
      let stats;
      try {
        stats = await fsImpl.lstat(current);
      } catch (cause) {
        if (errorFields(cause)?.code !== 'ENOENT') throw cause;
        await awaitMutation(() => fsImpl.mkdir(current), controls, deadline);
        stats = await awaitPhase(() => fsImpl.lstat(current), controls, deadline);
      }
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw Object.assign(new Error('Submodule checkout path is not a real directory'), { code: 'INVALID_SUBMODULE_GITLINK' });
      }
    }
  };

  const inspectSingleCheckoutHydration = async ({ directory, parentEndpoint, parentRemoteName, prefix = '', controls, deadline = Date.now() + timeoutMs }: HydrationInspectionInput & { prefix?: string }) => {
    const headSha = (await localGit(directory, ['rev-parse', '--verify', 'HEAD'], controls, deadline)).trim().toLowerCase();
    if (!SHA_PATTERN.test(headSha)) throw operationError('STALE_CONFIG', 'Checkout HEAD is invalid', 409);
    const configOutput = await localGit(directory, [
      'config', '--blob', 'HEAD:.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.(path|url|update)$',
    ], controls, deadline, { allowedCodes: [0, 1, 128] });
    const gitlinks = createGitlinksStream();
    await localGit(directory, ['ls-tree', '-rz', '--full-tree', 'HEAD'], controls, deadline, { onStdout: (chunk) => gitlinks.write(chunk) });
    const manifest = parseHydrationSubmodules({ gitmodulesConfig: configOutput, gitlinks: gitlinks.complete(), recursionDepth: 0 }, prefix);
    const scanner = createLfsFileScanner((args, input) => localGit(directory, args, controls, deadline,
      { input, maxOutputBytes: LFS_DISCOVERY_LIMITS.maxBatchBytes, rawOutput: true }), manifest.modules.map((module) => module.path));
    const files = createIndexFilesStream(scanner);
    await localGit(directory, ['ls-files', '-z', '--stage'], controls, deadline, { onStdout: (chunk) => files.write(chunk) });
    const scan = await files.complete();
    const children = manifest.modules.map((module) => {
      if (!parentEndpoint || !parentRemoteName) return { path: module.path, gitlink: module.gitlink };
      const resolved = resolveHydrationSubmodule(module, parentEndpoint, prefix);
      return { path: module.path, gitlink: module.gitlink, endpoint: resolved.endpoint };
    });
    const requirements: HydrationRequirementWithEndpoint[] = [];
    let sourceRequired = children.some((child) => !child.endpoint);
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
          gitRemoteName: occupied(parentRemoteName),
          gitRemoteUrl: occupied(parentEndpoint),
        remoteLfsUrls,
        lfsBinaryAvailable: Boolean(binaryResult.trim()),
      });
      if (discovery.needed) {
        requirements.push(withDerivedFromRemote({
          kind: 'lfs',
          path: '.',
          rawEndpoint: resolvedLfsEndpoint(discovery.endpoint).candidate.endpoint,
          transferReady: discovery.client.status !== 'missing',
          endpoint: {
            displayUrl: redactRemoteUrl(resolvedLfsEndpoint(discovery.endpoint).candidate.endpoint),
            fingerprint: fingerprintRemoteUrl(resolvedLfsEndpoint(discovery.endpoint).candidate.endpoint),
          },
        }, resolvedLfsEndpoint(discovery.endpoint).source === 'git-remote' ? parentEndpoint : undefined));
      }
    }
    const currentHead = (await localGit(directory, ['rev-parse', '--verify', 'HEAD'], controls, deadline)).trim().toLowerCase();
    if (currentHead !== headSha) throw operationError('STALE_CONFIG', 'Checkout changed during hydration inspection', 409);
    return Object.freeze({ headSha, requirements, children, sourceRequired });
  };

  const inspectCheckoutHydration = async (input: HydrationInspectionInput) => {
    const requirements: HydrationRequirement[] = [];
    const transfers: HydrationTransfer[] = [];
    let requirementCount = 0;
    let sourceRequired = false;
    const controls = input.controls;
    const deadline = input.deadline ?? Date.now() + timeoutMs;
    const visit = async (directory: string, parentEndpoint: string | undefined, parentRemoteName: string | undefined, prefix: string, depth: number): Promise<string> => {
      if (depth > SUBMODULE_DISCOVERY_LIMITS.maxRecursionDepth) {
        throw operationError('INVALID_REQUEST', 'Submodule recursion exceeds its depth limit', 400);
      }
      const inspection = await inspectSingleCheckoutHydration({
        ...input, directory, parentEndpoint, parentRemoteName, prefix, deadline,
      });
      sourceRequired ||= inspection.sourceRequired;
      for (const requirement of inspection.requirements) {
        requirementCount += 1;
        if (requirementCount > SUBMODULE_DISCOVERY_LIMITS.maxPublicRecords) {
          throw operationError('INVALID_REQUEST', 'Checkout hydration requirement limit exceeded', 400);
        }
        const path = prefix && requirement.path !== '.' ? `${prefix}/${requirement.path}` : prefix || requirement.path;
        const { rawEndpoint, transferReady = true, derivedFromRemote, ...publicRequirement } = requirement;
        requirements.push({ ...publicRequirement, path });
        if (transferReady) transfers.push(withDerivedFromRemote({ ...publicRequirement, path, rawEndpoint }, derivedFromRemote));
      }
      for (const child of inspection.children) {
        const resultPath = prefix ? `${prefix}/${child.path}` : child.path;
        let location;
        try {
          location = await inspectSubmoduleDirectory(directory, child.path);
        } catch (cause) {
          if (errorFields(cause)?.code === 'INVALID_SUBMODULE_GITLINK') continue;
          throw cause;
        }
        if (!location.ownsRepository) {
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
        } catch (cause) {
          const error = errorFields(cause);
          if (error?.cancelled || error?.timedOut) throw cause;
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

  const hydrateCheckout = async (hydrationPlan: HydrationPlan, controls: ExecutionControls, deadline: number): Promise<CheckoutHydration> => {
    const submodules: HydrationPart[] = [];
    const lfs: HydrationPart[] = [];
    const diagnostics: HydrationPart[] = [];
    let moduleCount = 0;
    const childPlan = (directory: string) => ({ ...hydrationPlan, directory, authorityDirectory: hydrationPlan.directory });
    const visit = async (directory: string, parentEndpoint: string | undefined, parentRemoteName: string | undefined, prefix: string, depth: number, foundAfterPlanning = false): Promise<void> => {
      if (depth > SUBMODULE_DISCOVERY_LIMITS.maxRecursionDepth) {
        throw Object.assign(new Error('Submodule recursion exceeds its depth limit'), { code: 'SUBMODULE_DISCOVERY_LIMIT_EXCEEDED' });
      }
      const configOutput = await localGit(directory, [
        'config', '--blob', 'HEAD:.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.(path|url|update)$',
      ], controls, deadline, { allowedCodes: [0, 1, 128] });
      const gitlinks = createGitlinksStream();
      await localGit(directory, ['ls-tree', '-rz', '--full-tree', 'HEAD'], controls, deadline, { onStdout: (chunk) => gitlinks.write(chunk) });
      const manifest = parseHydrationSubmodules({ gitmodulesConfig: configOutput, gitlinks: gitlinks.complete(), recursionDepth: depth }, prefix);
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
            submodules.push({ path: resultPath, status: 'invalid', error: publicError(
              'SUBMODULE_SOURCE_LOCAL', 'Submodules weren\'t fetched: OpenChamber fetches them only through a network remote, and this worktree has none to use. The repository\'s remote is a folder on this computer, it has no remote, or its branch tracks none. Work in the repository folder itself, or start the worktree from a branch whose upstream is a network remote.',
            ) });
            continue;
          }
          endpoint = resolveHydrationSubmodule(module, parentEndpoint, prefix);
          const publicEndpoint = { displayUrl: redactRemoteUrl(endpoint.endpoint), fingerprint: fingerprintRemoteUrl(endpoint.endpoint) };
          const location = await inspectSubmoduleDirectory(directory, module.path);
          const childDirectory = location.path;
          let childHead = '';
          const childExists = location.exists;
          if (location.ownsRepository) {
            childHead = (await localGit(
              childDirectory, ['rev-parse', '--verify', 'HEAD'], controls, deadline,
            )).trim().toLowerCase();
          }
          if (childHead && childHead !== module.gitlink) {
            throw Object.assign(new Error('Existing submodule checkout does not match its gitlink'), { code: 'INVALID_SUBMODULE_GITLINK' });
          }
          const clonesChild = !childHead;
          if (clonesChild) {
            const transfer = await auxiliaryTransport(
              childPlan(directory), 'submodule', endpoint.endpoint, controls, deadline, foundAfterPlanning,
            );
            if (transfer.authority.transportMode === 'managed') await controls.markStepCompleted('authenticated');
            let keepChild = childExists;
            let childIdentity: string | undefined;
            let childBirthtimeHolds = false;
            let leasedContext: LeasedTransportContext | undefined = transfer.context;
            let clonedGitIdentity: string | undefined;
            let clonedGitBirthtimeHolds = false;
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
              await auxiliaryTransfer(transfer, hydrationPlan, controls, [
                'clone', '--no-checkout', '--no-tags', '--', endpoint.endpoint, childDirectory,
              ], { ...transfer.context, env: { ...transfer.context.env, GIT_LFS_SKIP_SMUDGE: '1' } }, deadline);
              if (childExists) {
                const clonedGit = pathImpl.join(childDirectory, '.git');
                clonedGitBirthtimeHolds = await birthtimeHoldsStill(fsImpl, pathImpl, clonedGit);
                clonedGitIdentity = directoryIdentity(await fsImpl.lstat(clonedGit), clonedGitBirthtimeHolds);
              }
              await controls.markStepCompleted('transferred');
              const gitlinkObject = await localGit(childDirectory, ['cat-file', '--batch-check'], controls, deadline,
                { input: Buffer.from(`${module.gitlink}\n`) });
              if (gitlinkObject === `${module.gitlink} missing\n`) {
                leasedContext = undefined;
                if (await safeRevoke(transfer.context, hydrationPlan.operationId)) rethrow(operationError('UNKNOWN', 'Submodule credential cleanup failed', 500));
                const fetchTransfer = await auxiliaryTransport(
                  childPlan(childDirectory), 'submodule', endpoint.endpoint, controls, deadline, foundAfterPlanning,
                );
                leasedContext = fetchTransfer.context;
                await auxiliaryTransfer(fetchTransfer, hydrationPlan, controls, [
                  'fetch', '--no-tags', '--no-recurse-submodules', '--', endpoint.endpoint, module.gitlink,
                ], fetchTransfer.context, deadline, { ownAudit: true });
              }
              await localGit(childDirectory, ['checkout', '--force', '--detach', module.gitlink], controls, deadline, { disableLfsFilters: true });
              childHead = (await localGit(childDirectory, ['rev-parse', '--verify', 'HEAD'], controls, deadline)).trim().toLowerCase();
              if (childHead !== module.gitlink) {
                throw Object.assign(new Error('Submodule checkout does not match its gitlink'), { code: 'INVALID_SUBMODULE_GITLINK' });
              }
              keepChild = true;
            } finally {
              const cleanupFailed = await safeRevoke(leasedContext, hydrationPlan.operationId);
              if (!keepChild && childIdentity) {
                const cleanup = await quarantineAndClean(childDirectory, hydrationPlan.operationId, async (moved) => {
                  const stats = await fsImpl.lstat(moved);
                  return stats.isDirectory() && directoryIdentity(stats, childBirthtimeHolds) === childIdentity;
                });
                if (!cleanup.removed) rethrow(operationError('UNKNOWN', 'Submodule checkout cleanup failed', 500));
              }
              if (childHead !== module.gitlink && clonedGitIdentity) {
                const cleanup = await quarantineAndClean(pathImpl.join(childDirectory, '.git'), hydrationPlan.operationId, async (moved) => {
                  const stats = await fsImpl.lstat(moved);
                  return stats.isDirectory() && directoryIdentity(stats, clonedGitBirthtimeHolds) === clonedGitIdentity;
                });
                if (!cleanup.removed) rethrow(operationError('UNKNOWN', 'Submodule checkout cleanup failed', 500));
              }
              if (cleanupFailed) rethrow(operationError('UNKNOWN', 'Submodule credential cleanup failed', 500));
            }
          }
          submodules.push({ path: resultPath, status: 'succeeded', endpoint: publicEndpoint });
          await visit(childDirectory, endpoint.endpoint, 'origin', resultPath, depth + 1, foundAfterPlanning || clonesChild);
        } catch (error) {
          const failure = hydrationError(error);
          const existing = submodules.findIndex((entry) => entry.path === resultPath);
          if (existing !== -1 && occupied(submodules[existing]).status === 'succeeded' && failure.status !== 'cancelled') {
            submodules[existing] = { path: resultPath, ...failure, endpoint: occupied(submodules[existing]).endpoint };
          } else if (existing === -1) {
            const failedModule: HydrationPart = { path: resultPath, ...failure };
            if (endpoint) failedModule.endpoint = {
              displayUrl: redactRemoteUrl(endpoint.endpoint),
              fingerprint: fingerprintRemoteUrl(endpoint.endpoint),
            };
            submodules.push(failedModule);
          }
          const detail = hydrationFailure(error).submodules[0];
          if (detail && detail.path !== resultPath) diagnostics.push(detail);
          if (failure.status === 'cancelled') throw error;
        }
      }

      const scanner = createLfsFileScanner((args, input) => localGit(directory, args, controls, deadline,
        { input, maxOutputBytes: LFS_DISCOVERY_LIMITS.maxBatchBytes, rawOutput: true }), manifest.modules.map((module) => module.path));
      const files = createIndexFilesStream(scanner);
      await localGit(directory, ['ls-files', '-z', '--stage'], controls, deadline, { onStdout: (chunk) => files.write(chunk) });
      const scan = await files.complete();
      const lfsPath = prefix || '.';
      if (!scan.attributesOutput && !scan.pointerSamples.length && scan.pointerScanComplete) {
        lfs.push({ path: lfsPath, status: 'not-needed' });
        return;
      }
      if (!parentEndpoint || !parentRemoteName) {
        lfs.push({ path: lfsPath, status: 'invalid', error: publicError(
          'LFS_SOURCE_LOCAL', 'Git LFS files weren\'t fetched: OpenChamber fetches them only through a network remote, and this worktree has none to use. The repository\'s remote is a folder on this computer, it has no remote, or its branch tracks none. Work in the repository folder itself, or start the worktree from a branch whose upstream is a network remote.',
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
      else {
        const { candidate: { endpoint: rawEndpoint }, source } = resolvedLfsEndpoint(discovery.endpoint);
        const endpoint = { displayUrl: redactRemoteUrl(rawEndpoint), fingerprint: fingerprintRemoteUrl(rawEndpoint) };
        try {
          const transfer = await auxiliaryTransport(childPlan(directory), 'lfs', rawEndpoint, controls, deadline, foundAfterPlanning, source === 'git-remote' ? parentEndpoint : undefined);
          if (transfer.authority.transportMode === 'managed') await controls.markStepCompleted('authenticated');
          try {
            const context = { ...transfer.context, env: { ...transfer.context.env, GIT_LFS_SKIP_SMUDGE: '1' } };
            await auxiliaryTransfer(transfer, hydrationPlan, controls, [
              '-c', `lfs.url=${rawEndpoint}`, 'lfs', 'fetch', parentRemoteName, 'HEAD',
            ], context, deadline);
            await controls.markStepCompleted('transferred');
            await commandResult(transfer.auxiliaryPlan, controls, [
              '-c', `lfs.url=${rawEndpoint}`, 'lfs', 'checkout',
            ], context, deadline);
          } finally {
            if (await safeRevoke(transfer.context, hydrationPlan.operationId)) {
              rethrow(operationError('UNKNOWN', 'Git LFS credential cleanup failed', 500));
            }
          }
          lfs.push({ path: lfsPath, status: 'succeeded', endpoint });
        } catch (error) {
          lfs.push({ path: lfsPath, ...hydrationError(error), endpoint });
        }
      }
    };
    let visitError: unknown;
    try {
      await visit(hydrationPlan.directory, hydrationPlan.parentEndpoint, hydrationPlan.parentRemoteName, '', 0);
    } catch (error) {
      visitError = error;
    }
    submodules.push(...diagnostics.slice(0, Math.max(0, SUBMODULE_DISCOVERY_LIMITS.maxPublicRecords - submodules.length)));
    if (visitError !== undefined) {
      const failure = hydrationFailure(visitError);
      if (!submodules.some((entry) => entry.status === failure.status)
        && !lfs.some((entry) => entry.status === failure.status)) {
        submodules.push(...failure.submodules);
        lfs.push(...failure.lfs);
      }
    }
    return Object.freeze({ status: expectedHydrationStatus([...submodules, ...lfs]), submodules, lfs });
  };

  const cancellationResult = (plan: { target: { operation: string } }, controls: ExecutionControls, cause: unknown) => {
    const error = errorFields(cause);
    if ((plan.target.operation === 'push' || plan.target.operation === 'delete-remote-branch')
      && controls.hasTransferStarted()) {
      return terminal('outcome-unknown', 'OUTCOME_UNKNOWN', 'Push was interrupted after it started; the remote outcome is unknown');
    }
    return terminal('cancelled', error?.timedOut ? 'TIMEOUT' : 'CANCELLED', error?.timedOut
      ? 'Git network operation timed out and the process exited'
      : 'Git network operation was cancelled');
  };

  const safeRevoke = async (context: LeasedTransportContext | undefined, operationId: string) => {
    let cleanupFailed = false;
    try {
      if (context && await context.revoke() === false) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
    try { credentialBroker?.revoke(operationId); } catch { void 0; }
    return cleanupFailed;
  };

  const prepareLfsPublication = async (plan: ExistingPlan, controls: ExecutionControls, deadline: number) => {
    if (plan.transportMode !== 'managed' || plan.target.operation !== 'push') return false;
    let root: string | undefined;
    let context: LeasedTransportContext | undefined;
    let auditStarted = false;
    let uploaded = false;
    let failure: (Error & { code: string; cancelled?: boolean; timedOut?: boolean }) | undefined;
    const operationId = `${plan.operationId}:lfs-upload`;
    const recordId = `git:${operationId}`;
    try {
      const objects = await localGit(plan.directory, ['rev-list', '--objects', '--no-object-names', occupied(plan.sourceSha), '--'], controls, deadline,
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
        lfsConfigOutput, effectiveConfigOutput, gitRemoteName: plan.target.remote.name, gitRemoteUrl: occupied(plan.rawEndpoint),
      });
      let version;
      try { version = await localGit(plan.directory, ['lfs', 'version'], controls, deadline); }
      catch (cause) {
        const error = requiredErrorFields(cause);
        if (error.cancelled || error.timedOut) throw cause;
        throw operationError('GIT_LFS_CLIENT_MISSING', 'Git LFS client is unavailable', 409);
      }
      if (!/^git-lfs\//.test(version)) throw operationError('GIT_LFS_CLIENT_MISSING', 'Install git-lfs and retry this push; LFS objects must be uploaded before publishing Git refs', 409);
      if (!endpoint) throw operationError('AUTHENTICATION_REQUIRED', 'Configure and grant an explicit HTTPS LFS upload endpoint for this SSH Git remote, then retry', 409);
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
      const auxiliaryPlan: TransportPlan = { operationId, directory: root, rawEndpoint: endpoint.endpoint,
        transportMode: 'managed', credentialId: authority.credentialId, auxiliaryKind: 'lfs', target: { operation: 'clone' } };
      if (auditStore) {
        const claimed = await awaitPhase(() => auditStore.plan({
          id: recordId, initiator: 'user', executorKind: 'openchamber-server-git', runtime: occupied(runtimeIdentity),
          repositoryId: plan.target.repositoryId, providerAccountId: authoritativeProviderAccountId(auxiliaryPlan) ?? null,
          transportReference: { kind: 'managed', credentialId: occupied(authority.credentialId) },
          target: { kind: 'git-network', operation: 'push', remotes: [{ role: 'push', name: 'lfs-upload',
            endpointFingerprint: authority.endpointFingerprint, sourceRef: occupied(plan.target.sourceRef) }] },
        }), controls, deadline);
        if (claimed.status === 'existing') throw operationError('UNKNOWN', 'LFS upload audit identity is already in use', 409);
        auditStarted = true;
        await awaitPhase(() => auditStore.start(recordId), controls, deadline);
      }
      context = await transport(auxiliaryPlan, { ...controls, updateTransportMetadata: () => {} }, deadline);
      if (context.env.OPENCHAMBER_GIT_SSH_KEY) throw operationError('AUTHENTICATION_REQUIRED', 'The LFS upload grant requires an HTTPS credential', 409);
      context.env = { ...env, [GIT_CREDENTIAL_NONCE_ENV]: context.env[GIT_CREDENTIAL_NONCE_ENV] };
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
      uploaded = true;
    } catch (cause) {
      const error = errorFields(cause);
      const interrupted = phaseError(controls, deadline);
      const code = interrupted?.code ?? (requiredErrorFields(cause).cancelled ? 'CANCELLED' : error.timedOut ? 'TIMEOUT'
        : error.code === 'GIT_AUXILIARY_AUTHORIZATION_REQUIRED' ? 'AUTHENTICATION_REQUIRED'
          : String(error.code).includes('LFS') && error.code !== 'GIT_LFS_CLIENT_MISSING' ? 'INVALID_REQUEST'
            : ['GIT_LFS_CLIENT_MISSING', 'AUTHENTICATION_REQUIRED', 'REMOTE_CHANGED', 'STALE_CONFIG', 'INVALID_REQUEST', 'UNKNOWN'].some((code) => code === error.code)
              ? error.code : 'TRANSPORT_FAILED');
      const message = code === 'GIT_LFS_CLIENT_MISSING' ? 'Install git-lfs and retry this push; LFS objects must be uploaded before publishing Git refs'
        : code === 'AUTHENTICATION_REQUIRED' ? 'Grant the exact HTTPS LFS upload endpoint a stored credential, then retry this push'
          : code === 'INVALID_REQUEST' ? 'LFS publication discovery is invalid or incomplete; Git refs were not published'
            : code === 'CANCELLED' ? 'LFS upload was cancelled; Git refs were not published'
              : code === 'TIMEOUT' ? 'LFS upload timed out; Git refs were not published'
                : 'LFS upload preparation or transfer failed; Git refs were not published';
      failure = operationError(knownErrorCode(code), message, 409, { cancelled: code === 'CANCELLED', timedOut: code === 'TIMEOUT' });
    } finally {
      let cleanupFailed = await safeRevoke(context, operationId);
      if (root) {
        try { await awaitMutation(() => fsImpl.rm(occupied(root), { recursive: true, force: true }), undefined, Date.now() + CLEANUP_TIMEOUT_MS); }
        catch { cleanupFailed = true; }
      }
      if (cleanupFailed && !failure) failure = operationError('UNKNOWN', 'LFS upload cleanup failed; Git refs were not published', 500);
      if (auditStarted) {
        try {
          await awaitPhase(() => occupied(auditStore).finish(recordId, {
            state: failure ? failure.cancelled || failure.timedOut ? 'cancelled' : 'failed' : 'succeeded',
            errorCode: failure?.code ?? null, steps: uploaded ? ['validated', 'authenticated', 'transferred'] : ['validated'],
          }), undefined, Date.now() + CLEANUP_TIMEOUT_MS);
        } catch { failure ??= operationError('UNKNOWN', 'LFS upload audit completion failed; Git refs were not published', 500); }
      }
    }
    if (failure) throw failure;
    return uploaded;
  };

  const executeExisting = async (plan: ExistingPlan, controls: ExecutionControls, deadline = Date.now() + timeoutMs): Promise<Completion> => {
    let context: LeasedTransportContext | undefined;
    let result: Completion | undefined;
    let temporaryRef: string | undefined;
    let integrationContext: TransportContext | undefined;
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
        if (plan.target.operation === 'delete-remote-branch') await refuseRemoteDefaultBranch(plan, controls, deadline);
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
            'push', ...lease, '--', occupied(plan.rawEndpoint),
            plan.target.operation === 'delete-remote-branch'
              ? `:${plan.target.destinationRef}`
              : plan.pushRefspec ?? `${plan.sourceSha}:${plan.target.destinationRef}`,
          ], context, deadline, { transfer: true });
          pushTransferred = true;
          await controls.markStepCompleted('transferred');
          await recordRemoteTrackingRef(plan, controls, context, deadline,
            plan.target.operation === 'delete-remote-branch' ? null : plan.sourceSha);
          if (plan.target.configureUpstream) {
            const localBranch = occupied(plan.target.sourceRef).slice('refs/heads/'.length);
            const remoteBranch = occupied(plan.target.destinationRef).slice('refs/heads/'.length);
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
            '--', occupied(plan.rawEndpoint), occupied(plan.fetchRefspec),
          ], context, deadline, { transfer: true });
          await controls.markStepCompleted('transferred');
          result = { state: 'succeeded' };
        } else {
          temporaryRef = plan.target.operation === 'pull' ? `refs/openchamber/network/${plan.operationId}` : plan.target.destinationRef;
          await commandResult(plan, controls, [
            'fetch', '--no-tags', '--no-recurse-submodules',
            '--', occupied(plan.rawEndpoint), singleRefFetchRefspec(occupied(plan.target.sourceRef), occupied(temporaryRef)),
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
              () => resolveRefImpl(plan.directory, occupied(temporaryRef), { controls, deadline }), controls, deadline,
            )).trim();
            if (!SHA_PATTERN.test(fetchedSha)) throw operationError('STALE_CONFIG', 'Fetched ref is invalid', 409);
            const trackingRef = await recordRemoteTrackingRef(plan, controls, integrationContext, deadline, fetchedSha, plan.target.sourceRef);
            mergeStarted = true;
            await controls.markIntegrationStarted();
            await commandResult(plan, controls, pullRebaseArgs(fetchedSha, trackingRef), integrationContext, deadline);
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
    } catch (cause) {
      const error = requiredErrorFields(cause);
      const output = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
      if (pushTransferred && plan.target.operation === 'push' && plan.target.configureUpstream) {
        result = terminal('partial', 'TRANSPORT_FAILED', 'Push succeeded, but local upstream configuration failed');
      } else if (plan.target.operation === 'push' && plan.target.forceWithLease && isLeaseConflict(output)) {
        result = terminal('conflicted', 'CONFLICT', 'Push force lease no longer matches the remote ref');
      } else if (plan.target.operation === 'pull' && /\bCONFLICT\b|automatic merge failed|unmerged files|could not apply/i.test(output)) {
        result = terminal('conflicted', 'CONFLICT', 'Pull left conflicts in the local repository; resolve them and continue the rebase');
      } else if (mergeStarted && (error.cancelled || error.timedOut || controls.isCancellationRequested())) {
        let mergeInProgress = false;
        try { mergeInProgress = await hasMergeState(plan.directory); } catch { void 0; }
        result = mergeInProgress
          ? terminal('conflicted', 'CONFLICT', 'Pull was interrupted with an active merge state')
          : terminal('outcome-unknown', 'OUTCOME_UNKNOWN', 'Pull integration was interrupted; the local outcome is unknown');
      } else if (error.cancelled || error.timedOut || controls.isCancellationRequested()) {
        result = cancellationResult(plan, controls, error);
      } else {
        const code = [
          'STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED',
          'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'GIT_LFS_CLIENT_MISSING', 'INVALID_REQUEST', 'RUNTIME_UNSUPPORTED', 'UNKNOWN',
        ].some((code) => code === error.code) ? knownErrorCode(error.code) : 'TRANSPORT_FAILED';
        result = terminal(code.startsWith('STALE_') || code === 'REMOTE_CHANGED' ? 'conflicted' : 'failed', code,
          `${lfsUploaded ? 'LFS objects were uploaded, but Git ref publication failed. ' : ''}${leadWithRejection(createGitRedactor({ secrets: [...(context?.secrets ?? []), plan.directory] }).error(cause))}`);
      }
    }

    let cleanupFailed = false;
    if (temporaryRef && plan.target.operation === 'pull') {
      try {
        const cleanupContext = integrationContext ?? context ?? {
          env: { ...await managedGitEnvironment(), GIT_ALLOW_PROTOCOL: '', GIT_NO_LAZY_FETCH: '1' },
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

  const executeSync = async (plan: SyncPlan, controls: ExecutionControls, deadline = Date.now() + timeoutMs) => {
    const results = new Map<string, { step: string; status: string; error?: PublicFailure }>();
    let activeStep = 'fetch';
    let context: LeasedTransportContext | undefined;
    let mergeStarted = false;
    let hydration: CheckoutHydration | undefined;
    let lfsUploaded = false;
    const step = (name: string, status: string, error?: PublicFailure) => {
      const value: NonNullable<Completion['stepResults']>[number] = { step: name, status };
      if (error) value.error = error;
      results.set(name, value);
    };
    const completion = (state: string, error?: PublicFailure) => {
      const value: Completion = {
        state,
        stepResults: ['fetch', 'pull', 'push'].map((name) => results.get(name) ?? { step: name, status: 'skipped' }),
      };
      if (error) value.error = error;
      if (hydration) value.hydration = hydration;
      return value;
    };
    const syncPlan = (role: 'fetch' | 'push') => ({
      ...plan[role],
      operationId: plan.operationId,
      transportRole: role,
      target: { ...plan[role].target, remote: syncRemote(plan[role].target.remote),
        sourceRef: stringInvariant(plan[role].target.sourceRef), destinationRef: stringInvariant(plan[role].target.destinationRef) },
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
        singleRefFetchRefspec(fetchPlan.target.sourceRef, fetchPlan.target.destinationRef),
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
      const headBefore = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, headPlan.target.destinationRef, { controls, deadline }), controls, deadline,
      )).trim().toLowerCase();
      mergeStarted = true;
      await controls.markIntegrationStarted();
      const fetchedTrackingRef = fetchPlan.target.destinationRef.startsWith('refs/remotes/') ? fetchPlan.target.destinationRef : null;
      await commandResult(fetchPlan, controls, pullRebaseArgs(fetchedSha, fetchedTrackingRef), integrationContext, deadline);
      mergeStarted = false;
      await controls.markStepCompleted('updated-local-repository');
      const hydrated = await hydrateIntegration(fetchPlan, controls, deadline);
      hydration = hydrated.hydration;
      if (hydrated.state !== 'succeeded') {
        step('pull', hydrated.state === 'cancelled' ? 'cancelled' : 'failed', hydrated.error);
        return completion(hydrated.state === 'cancelled' ? 'cancelled' : 'partial', hydrated.error);
      }
      const headAfter = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, headPlan.target.destinationRef, { controls, deadline }), controls, deadline,
      )).trim().toLowerCase();
      step('pull', headAfter === headBefore ? 'skipped' : 'succeeded');

      activeStep = 'push';
      const blockedPush = phaseError(controls, deadline);
      if (blockedPush) throw blockedPush;
      const pushSha = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, pushPlan.target.sourceRef, { controls, deadline }), controls, deadline,
      )).toLowerCase();
      if (!SHA_PATTERN.test(pushSha)) throw operationError('STALE_CONFIG', 'Git push source ref is invalid', 409);
      if (pushSha === fetchedSha.toLowerCase() && !pushPlan.target.forceWithLease
        && pushPlan.rawEndpoint === fetchPlan.rawEndpoint
        && pushPlan.target.destinationRef === fetchPlan.target.sourceRef) {
        step('push', 'skipped');
        return completion('succeeded');
      }
      pushPlan = { ...pushPlan, sourceSha: pushSha };
      pushPlan = { ...pushPlan, transportRevision: await mergedTransportRevision(pushPlan, controls, deadline) };
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
      await recordRemoteTrackingRef(pushPlan, controls, context, deadline, pushSha);
      if (await safeRevoke(context, plan.operationId)) {
        throw operationError('UNKNOWN', 'Git push credential cleanup failed', 500);
      }
      context = undefined;
      step('push', 'succeeded');
      return completion('succeeded');
    } catch (cause) {
      const cleanupFailed = await safeRevoke(context, plan.operationId);
      const error = requiredErrorFields(cause);
      const output = `${error.stderr ?? ''}\n${error.stdout ?? ''}`;
      const redacted = leadWithRejection(createGitRedactor({
        secrets: [...(context?.secrets ?? []), plan.directory],
      }).error(cause));
      if (activeStep === 'pull' && /\bCONFLICT\b|automatic merge failed|unmerged files|could not apply/i.test(output)) {
        const publicFailure = publicError('CONFLICT', 'Sync pull left conflicts in the local repository; resolve them and continue the rebase');
        step('pull', 'conflicted', publicFailure);
        return completion('conflicted', publicFailure);
      }
      if (activeStep === 'pull' && mergeStarted
        && (error.cancelled || error.timedOut || controls.isCancellationRequested())) {
        let mergeInProgress = false;
        try { mergeInProgress = await hasMergeState(plan.directory); } catch { void 0; }
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
      ].some((code) => code === error.code) ? knownErrorCode(error.code) : 'TRANSPORT_FAILED';
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

  const copyCheckout = async (source: string, destination: string, copiedEntries: CopiedCheckoutEntry[], controls: ExecutionControls, deadline: number, birthtimeHolds: boolean): Promise<void> => {
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

  const checkoutMatches = async (quarantined: string, destination: string, destinationIdentity: string | undefined, copiedEntries: CopiedCheckoutEntry[], birthtimeHolds: boolean) => {
    const rootStats = await fsImpl.lstat(quarantined);
    if (!rootStats.isDirectory() || directoryIdentity(rootStats, birthtimeHolds) !== destinationIdentity) return false;
    const expected = new Map(copiedEntries.map((entry) => [pathImpl.relative(destination, entry.path), entry]));
    const inspect = async (directory: string, relativeDirectory = ''): Promise<boolean> => {
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

  const quarantineAndClean = async (target: string, operationId: string, matches: (moved: string) => Promise<boolean>) => {
    const quarantine = await fsImpl.mkdtemp(pathImpl.join(
      pathImpl.dirname(target), `.openchamber-quarantine-${operationId}-`,
    ));
    const moved = pathImpl.join(quarantine, 'object');
    try {
      await fsImpl.rename(target, moved);
    } catch (cause) {
      const error = errorFields(cause);
      try { await fsImpl.rm(quarantine, { recursive: true, force: true }); } catch { void 0; }
      if (error?.code === 'ENOENT') return { removed: true, changed: false, failed: false };
      return { removed: false, changed: false, failed: true };
    }
    let owned = false;
    try { owned = await matches(moved); } catch { void 0; }
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
      } catch (cause) {
        if (errorFields(cause)?.code !== 'ENOENT') return { removed: false, changed: true, failed: true };
      }
      await fsImpl.rename(moved, target);
      await fsImpl.rm(quarantine, { recursive: true, force: true });
      return { removed: false, changed: true, failed: false };
    } catch {
      return { removed: false, changed: true, failed: true };
    }
  };

  const executeClone = async (plan: ClonePlan, controls: ExecutionControls, deadline = Date.now() + timeoutMs) => {
    let temporaryIdentity: string | undefined;
    let destinationIdentity: string | undefined;
    let birthtimeHolds = false;
    let context: LeasedTransportContext | undefined;
    let result: Completion | undefined;
    let cleanupFailed = false;
    const copiedEntries: CopiedCheckoutEntry[] = [];
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
          'clone', '--no-checkout', '--', occupied(plan.rawEndpoint), plan.temporaryDirectory,
        ], { ...context, env: { ...context.env, GIT_LFS_SKIP_SMUDGE: '1' } }, deadline, { transfer: true });
        await controls.markStepCompleted('transferred');
        if (directoryIdentity(await awaitPhase(() => fsImpl.stat(plan.temporaryDirectory), controls, deadline), birthtimeHolds) !== temporaryIdentity) {
          throw operationError('CONFLICT', 'Clone temporary directory ownership changed', 409);
        }
        if (controls.isCancellationRequested()) result = cancellationResult(plan, controls, {});
        else {
          if (plan.gitIdentityId) {
            if (resolveGitIdentity instanceof Function) {
              const profile = await awaitPhase(() => resolveGitIdentity(occupied(plan.gitIdentityId)), controls, deadline);
              if (!profile?.userName || !profile?.userEmail) throw operationError('RUNTIME_UNSUPPORTED', 'Git identity application is unavailable', 501);
              await commandResult({ ...plan, directory: plan.temporaryDirectory }, controls,
                ['config', '--local', 'user.name', profile.userName], context, deadline);
              await commandResult({ ...plan, directory: plan.temporaryDirectory }, controls,
                ['config', '--local', 'user.email', profile.userEmail], context, deadline);
            } else if (applyGitIdentity instanceof Function) {
              await awaitMutation(() => applyGitIdentity(plan.temporaryDirectory, occupied(plan.gitIdentityId)), controls, deadline);
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
              const blocked = phaseError(controls, deadline);
              if (blocked) throw blocked;
              if (!(bindClonedRepository instanceof Function)) throw new Error('Clone binding persistence is unavailable');
              await bindClonedRepository({
                directory: plan.destination, approvedEndpoint: occupied(plan.rawEndpoint),
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
                const specific = [...hydration.submodules, ...hydration.lfs]
                  .find((entry) => ['RUNTIME_UNSUPPORTED', 'CHECKOUT_TOO_LARGE'].some((code) => code === entry.error?.code));
                const failure = specific?.error ?? (hydration.status === 'client-missing'
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
    } catch (cause) {
      const error = errorFields(cause);
      if (error?.hydrationHandled) {
        void 0;
      } else if (error?.code === 'EEXIST') result = terminal('conflicted', 'CONFLICT', 'Clone destination already exists');
      else if (requiredErrorFields(cause).cancelled || error.timedOut || controls.isCancellationRequested()) result = cancellationResult(plan, controls, error);
      else {
        const code = error.code === 'CONFLICT' || error.code === 'RUNTIME_UNSUPPORTED' ? error.code : 'TRANSPORT_FAILED';
        result = terminal(code === 'CONFLICT' ? 'conflicted' : 'failed', code, createGitRedactor({
          secrets: [...(context?.secrets ?? []), plan.destination, plan.temporaryDirectory],
        }).error(cause));
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

  const executeHydration = async (plan: HydrationPlan, controls: ExecutionControls, deadline = Date.now() + timeoutMs): Promise<Completion> => {
    const plannedHydration = Array.isArray(plan.plannedTransfers);
    if (plan.preparedHydrationFailure) {
      const hydration = plan.preparedHydrationFailure;
      const error = occupied([...hydration.submodules, ...hydration.lfs][0]).error;
      return { state: hydration.status === 'cancelled' ? 'cancelled' : 'failed', error, hydration };
    }
    if (plannedHydration) {
      try {
        if (plan.target.repositoryId) await revalidate(hydrationExistingPlan(plan), controls, deadline);
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
      } catch (cause) {
        const error = errorFields(cause);
        if (error?.cancelled || error?.timedOut || controls.isCancellationRequested()) {
          return cancellationResult(plan, controls, error);
        }
        const code = ['STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED'].some((code) => code === error?.code)
          ? error.code : authorityCode(error);
        return code === 'AUTHENTICATION_REQUIRED'
          ? terminal('failed', code, 'Checkout hydration needs the repository access fixed')
          : terminal('conflicted', code, 'Checkout hydration authority changed; plan again');
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
      const tooLarge = [...hydration.submodules, ...hydration.lfs].find((entry) => entry.error?.code === 'CHECKOUT_TOO_LARGE');
      return { state: 'failed', error: tooLarge?.error ?? publicError('INVALID_REQUEST', 'Checkout hydration configuration is invalid'), hydration };
    }
    const unsupported = [...hydration.submodules, ...hydration.lfs].find((entry) => entry.error?.code === 'RUNTIME_UNSUPPORTED');
    return { state: 'failed', error: unsupported?.error ?? publicError('TRANSPORT_FAILED', 'Checkout hydration failed'), hydration };
  };

  const hydrateIntegration = (plan: ExistingPlan, controls: ExecutionControls, deadline: number) => executeHydration({
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

  const executeContributorFetch = async (plan: ContributorPlan, controls: ExecutionControls, deadline = Date.now() + timeoutMs) => {
    let context;
    try {
      await revalidateContributorSource(plan, controls, deadline);
      await controls.markStepCompleted('validated');
      context = await transport(plan, controls, deadline);
      await controls.markStepCompleted('authenticated');
      await revalidateContributorSource(plan, controls, deadline);
      await commandResult(plan, controls, [
        'fetch', '--no-tags', '--', plan.rawEndpoint, singleRefFetchRefspec(plan.target.sourceRef, plan.target.destinationRef),
      ], context, deadline, { transfer: true });
      await controls.markStepCompleted('transferred');
      const fetchedSha = String(await awaitPhase(
        () => resolveRefImpl(plan.directory, plan.target.destinationRef, { controls, deadline }), controls, deadline,
      )).toLowerCase();
      if (fetchedSha !== plan.expectedSha) throw operationError('STALE_CONFIG', 'Fetched change request head did not match', 409);
      return { state: 'succeeded' };
    } catch (cause) {
      const error = requiredErrorFields(cause);
      if (error.cancelled || error.timedOut || controls.isCancellationRequested()) return cancellationResult(plan, controls, error);
      if (error.code === 'STALE_CONFIG') return terminal('conflicted', 'STALE_CONFIG', error.message);
      if (error.code === 'RUNTIME_UNSUPPORTED') return terminal('failed', 'RUNTIME_UNSUPPORTED', error.message);
      if (error.code === 'UNKNOWN') return terminal('failed', 'UNKNOWN', 'Change request source resolution failed');
      if (error.code === 'TRANSPORT_FAILED') return terminal('failed', 'TRANSPORT_FAILED', error.message);
      return terminal('failed', 'AUTHENTICATION_REQUIRED',
        'The selected account does not authorize the change request head repository');
    } finally {
      await safeRevoke(context, plan.operationId);
    }
  };

  const snapshotCheckoutHook = async (action: PostCheckoutHookAction, operationId: string, controls: ExecutionControls, deadline: number) => {
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

  const execute = (plan: ExecutionPlan, controls: ExecutionControls, deadline: number | undefined): Promise<Completion> => {
    if (isHydrationPlan(plan)) return executeHydration(plan, controls, deadline);
    if (isActionsPlan(plan)) return (async () => {
      const checkoutDeadline = Number(deadline);
      const snapshotRoots: string[] = [];
      let result: Completion | undefined;
      try {
        const inspected = await awaitPhase(() => plan.inspect(), controls, checkoutDeadline);
        if (inspected.digest !== plan.actionDigest) {
          return terminal('conflicted', 'STALE_CONFIG', 'Checkout actions changed; nothing was run');
        }
        await controls.markStepCompleted('validated');
        for (const action of inspected.actions) {
          const snapshot = action.kind === 'post-checkout-hook'
            ? await snapshotCheckoutHook(action, plan.operationId, controls, checkoutDeadline)
            : null;
          if (snapshot) snapshotRoots.push(snapshot.root);
          const invocation = snapshot
            ? { binary: snapshot.path, args: [plan.nullRef, plan.headSha, '1'] }
            : { binary: platform === 'win32' ? (inheritedEnv.ComSpec || 'cmd.exe') : '/bin/sh', args: platform === 'win32' ? ['/d', '/s', '/c', commandAction(action).command] : ['-c', commandAction(action).command] };
          const result = await run({
            ...invocation,
            cwd: plan.directory,
            env: snapshot ? { ...inheritedEnv, GIT_DIR: hookAction(action).gitDir, GIT_WORK_TREE: hookAction(action).workTree } : { ...inheritedEnv },
            controls,
            deadline: checkoutDeadline,
          });
          if (result.code !== 0 || result.cancelled || result.timedOut) {
            throw operationError(result.timedOut ? 'TIMEOUT' : result.cancelled ? 'CANCELLED' : 'UNKNOWN', 'Checkout action failed', 500, result);
          }
        }
        result = { state: 'succeeded' };
      } catch (cause) {
        const error = requiredErrorFields(cause);
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
    if (isContributorPlan(plan)) return executeContributorFetch(plan, controls, deadline);
    if (isClonePlan(plan)) return executeClone(plan, controls, deadline);
    if (isSyncPlan(plan)) return executeSync(plan, controls, deadline);
    return executeExisting(existingPlan(plan), controls, deadline);
  };
  const auditId = (operationId: string) => `git:${operationId}`;
  const auditTarget = (plans: AuditPlans): Extract<AuditPlan['target'], { kind: 'git-network' }> => {
    const { target } = plans.publicPlan;
    const remote = (value: AuditPlans['publicPlan']['target']['remote'], role: 'operation' | 'fetch' | 'push') => {
      if (!value) return null;
      const result: Extract<AuditPlan['target'], { kind: 'git-network' }>['remotes'][number] = {
        role,
        name: value.name ?? 'clone-source',
        endpointFingerprint: occupied(value.endpoint?.fingerprint ?? value.fingerprint),
      };
      if (value.sourceRef) result.sourceRef = value.sourceRef;
      if (value.destinationRef) result.destinationRef = value.destinationRef;
      return result;
    };
    if (target.operation === 'checkout-hydration') {
      const auxiliaries = [];
      const seen = new Set();
      for (const transfer of isHydrationPlan(plans.internalPlan) ? plans.internalPlan.plannedTransfers ?? [] : []) {
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
    const value: Extract<AuditPlan['target'], { kind: 'git-network' }> = { kind: 'git-network', operation: target.operation, remotes: remotes.filter((entry) => entry !== null) };
    if (target.operation === 'fetch' && target.fetchScope === 'remote') {
      value.fetchScope = 'remote';
      value.force = occupied(target.force);
    }
    if (target.destination) value.destination = target.destination;
    return value;
  };
  const auditTransportPart = (plan: Pick<TransportPlan, 'transportMode' | 'credentialId'>, systemMarker: 'system-credentials' | 'local-checkout-actions' = 'system-credentials'): Extract<AuditPlan['transportReference'], { kind: 'managed' | 'anonymous' | 'system' }> => plan.transportMode === 'managed'
    ? { kind: 'managed', credentialId: occupied(plan.credentialId) }
    : plan.transportMode === 'anonymous' ? { kind: 'anonymous' } : { kind: 'system', marker: systemMarker };
  const auditTransportReference = (plans: AuditPlans): AuditPlan['transportReference'] => {
    if (isHydrationPlan(plans.internalPlan)) {
      const entries = (plans.internalPlan.plannedAuxiliaryAuthorities ?? []).map((authority) => ({
        kind: occupied(authority.kind),
        endpointFingerprint: authority.endpointFingerprint,
        transport: auditTransportPart(authority),
      }));
      return entries.length ? { kind: 'auxiliary', entries } : null;
    }
    if (isSyncPlan(plans.internalPlan)) {
      return {
        kind: 'sync',
        fetch: auditTransportPart(plans.internalPlan.fetch),
        push: auditTransportPart(plans.internalPlan.push),
      };
    }
    if (isActionsPlan(plans.internalPlan)) {
      return { kind: 'system', marker: 'local-checkout-actions' };
    }
    return auditTransportPart(plans.internalPlan);
  };
  const authoritativeProviderAccountId = (internalPlan: ExecutionPlan | TransportPlan) => {
    if (isHydrationTransport(internalPlan)) return null;
    const managed = isSyncTransport(internalPlan)
      ? [internalPlan.fetch, internalPlan.push].filter((part) => part.transportMode === 'managed')
       : 'transportMode' in internalPlan && internalPlan.transportMode === 'managed' ? [internalPlan] : [];
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
  const planAudit = (plans: AuditPlans) => auditStore?.plan({
    id: auditId(plans.publicPlan.operationId),
    initiator: 'user',
    executorKind: 'openchamber-server-git',
    runtime: occupied(plans.publicPlan.runtimeIdentity),
    repositoryId: plans.publicPlan.target.repositoryId
      ?? (isActionsPlan(plans.internalPlan) ? plans.internalPlan.auditRepositoryId : undefined)
      ?? (isHydrationPlan(plans.internalPlan) ? plans.internalPlan.repositoryAuthority?.repositoryId : undefined)
      ?? (isContributorPlan(plans.internalPlan) ? plans.internalPlan.sourceAuthority?.repositoryId : undefined)
      ?? null,
    providerAccountId: authoritativeProviderAccountId(plans.internalPlan) ?? null,
    transportReference: auditTransportReference(plans),
    target: auditTarget(plans),
  });
  const auditResult = (snapshot: { state: string; error?: { code: string }; completedSteps?: string[]; stepResults?: { step: string; status: string }[] | undefined }): AuditResultInput => ({
    state: snapshot.state,
    errorCode: snapshot.error?.code ?? null,
    steps: [
      ...(snapshot.completedSteps ?? []),
      ...(snapshot.stepResults ?? []).map((step) => `${step.step}:${step.status}`),
    ],
  });
  const registerWithAudit = async (plans: AuditPlans) => {
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
  const planWithDeadline = async (request: JsonValue, deadline: number) => {
    let plans: AuditPlans = await awaitPhase(() => planner.planNetworkOperation(request), undefined, deadline);
    plans = await prepareHydrationPlans(plans, deadline);
    if (isClonePlan(plans.internalPlan) && plans.internalPlan.gitIdentityId) {
      if (!(validateGitIdentity instanceof Function)) throw operationError('INVALID_GIT_IDENTITY', 'Selected Git identity is unavailable', 400);
      const gitIdentityId = plans.internalPlan.gitIdentityId;
      try { await awaitPhase(() => validateGitIdentity(gitIdentityId), undefined, deadline); }
      catch (cause) {
        const error = errorFields(cause);
        if (error?.timedOut || error?.code === 'TIMEOUT') throw cause;
        throw operationError('INVALID_GIT_IDENTITY', 'Selected Git identity is unavailable', 400);
      }
    }
    return registerWithAudit(plans);
  };
  const plan = (request: JsonValue) => planWithDeadline(request, Date.now() + timeoutMs);
  const auditedStarts = new Map();
  const auditedExecutions = new Map();
  const executeOperation = (operationId: string, deadline?: number) => {
    const startRegistry = () => operationRegistry.start(
      operationId, (operationPlan: ExecutionPlan, controls: ExecutionControls) => execute(operationPlan, controls, deadline),
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
  const runHydrationOperation = async ({ directory, parentRemoteName, parentEndpoint, repositoryAuthority }: HydrationInput) => {
    const deadline = Date.now() + timeoutMs;
    const operationId = `git_${crypto.randomUUID()}`;
    let inspection;
    let preparedHydrationFailure;
    try {
      inspection = await inspectCheckoutHydration({ directory, parentEndpoint, parentRemoteName, deadline });
    } catch (error) {
      preparedHydrationFailure = hydrationFailure(error);
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
    const internalPlan: HydrationPlan = {
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
    return result.hydration ?? (result.error ? rethrow(Object.assign(new Error(result.error.message), { code: result.error.code })) : undefined);
  };

  return Object.freeze({
    plan,
    issueContributorDestination: planner.issueContributorDestination,
    async transferContributorHead({ directory, sourceRequest, source, credentialId, destinationRef }: {
      directory: string; sourceRequest: SourceRequest; source: ContributorTransferSource; credentialId: string; destinationRef: string;
    }) {
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
      const internalPlan: ContributorPlan = {
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
    async decideCheckoutTrust({ directory, repositoryId, digest, decision, inspect, headSha, nullRef }: CheckoutTrustInput) {
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
    async cloneRepository({ remoteUrl, destinationPath, gitIdentityId, unverifiedConfirmed }: {
      remoteUrl: string; destinationPath: string; gitIdentityId?: string | undefined; unverifiedConfirmed?: boolean;
    }) {
      const deadline = Date.now() + timeoutMs;
      let planned;
      try {
        planned = await planWithDeadline(
          { operation: 'clone', remoteUrl, destinationPath, transportMode: 'system', unverifiedConfirmed, gitIdentityId }, deadline,
        );
      } catch (error) {
        if (/destination.*already exists/i.test(String(errorFields(error)?.message || ''))) {
          throw operationError('CONFLICT', 'Clone destination already exists', 409);
        }
        throw error;
      }
      const result = await executeOperation(planned.operationId, deadline);
      return result.state === 'succeeded' ? { ...result, output: '' } : result;
    },
    async hydrateCheckout({ directory, parentRemoteName, parentEndpoint, repositoryAuthority }: HydrationInput) {
      return runHydrationOperation({ directory, parentRemoteName, parentEndpoint, repositoryAuthority });
    },
    async hydrateBoundCheckout({ directory, parentRemoteName, parentEndpoint, repositoryAuthority }: HydrationInput) {
      const deadline = Date.now() + timeoutMs;
      const endpoint = parentEndpoint || !parentRemoteName || !repositoryAuthority ? parentEndpoint : await resolveHydrationSource({
        directory, parentRemoteName, repositoryAuthority, validateGitTransportContext,
        readConfiguredUrl: () => localGit(directory, ['remote', 'get-url', parentRemoteName], undefined, deadline, { allowedCodes: [0, 2, 128] }),
        inspect: (configured) => inspectCheckoutHydration({ directory, parentEndpoint: configured, parentRemoteName, deadline }),
      });
      return runHydrationOperation({ directory, parentRemoteName, parentEndpoint: endpoint, repositoryAuthority });
    },
    inspectCheckoutHydration: async ({ directory, parentEndpoint, parentRemoteName }: HydrationInput) => {
      const { transfers: _transfers, sourceRequired: _sourceRequired, ...inspection } = await inspectCheckoutHydration({
        directory, parentEndpoint, parentRemoteName,
      });
      return inspection;
    },
    inspectCheckoutAuxiliary: async ({ kind, path, ...input }: HydrationInput & Pick<HydrationTransfer, 'kind' | 'path'>) => checkoutAuxiliaryOf(await inspectCheckoutHydration(input), kind, path),
    get: (operationId: string) => operationRegistry.get(operationId),
    cancel(operationId: string) {
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
