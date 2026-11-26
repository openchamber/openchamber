import { z } from 'zod';
import { registerGitStatusBatchRoute } from './status-batch.js';
import { registerGitRangeRoutes } from './range-routes.js';
import { isPlainObject, isString } from '../shared/guards.js';
import { whileReachable } from '../directory-reachability/while-reachable.js';
import { DIRECTORY_UNREACHABLE } from '../directory-reachability/index.js';
import { readProjects } from './project-batch.js';
import { OpenCode } from '@opencode/client';
import { createGitRedactor } from './redaction.js';
import { runAsUserAction } from '../environment/refresh-scope.js';
import { isDiskPathRemoteUrl, redactRemoteUrl } from '../source-control/url-redaction.js';
import { parsePublicGitIdentityProfile, toPublicGitIdentityProfile } from './identity-storage.js';
import { WorktreeCreationError, createWorktreeCreation, hasClientContributorAuthority } from './worktree-creation.js';
import type { Application, NextFunction, Request, Response } from '../shared/http-contracts.js';
import type { JsonValue } from '../shared/json-values.js';
import type { registerSourceControlRoutes } from '../source-control/routes.js';
import type { createBindingService } from '../source-control/binding-service.js';
import type { ContributorProvenance, createContributorProvenanceStore } from './contributor-provenance-storage.js';
import type { createManagedSshInventory } from './credentials.js';
import type { createHttpsCredentialReference } from './credential-resolver.js';
import type { createNetworkOperations } from './network-operations.js';
import type { subscribeWorktreeTopologyChanges } from './service.js';
import type { createWorktreeBootstrapStore } from './worktree-bootstrap-storage.js';

type BindingRoutes = ReturnType<typeof registerSourceControlRoutes>;

export interface GitRouteDependencies {
  networkOperations?: ReturnType<typeof createNetworkOperations>;
  managedSshInventory?: ReturnType<typeof createManagedSshInventory>;
  contributorProvenance?: ReturnType<typeof createContributorProvenanceStore>;
  getSourceControlBinding?: ReturnType<typeof createBindingService>['get'];
  resolveChangeRequestSource?: BindingRoutes['resolveChangeRequestSource'];
  backfillIdentities?: BindingRoutes['backfillConnectedIdentities'];
  createHttpsCredentialReference?: typeof createHttpsCredentialReference;
  resolveSourceControlAccount?: NonNullable<Parameters<typeof createNetworkOperations>[0]>['resolveSourceControlAccount'];
  errorRedactionSecrets?: NonNullable<Parameters<typeof createGitRedactor>[0]>['secrets'];
  worktreeBootstrapStore?: ReturnType<typeof createWorktreeBootstrapStore>;
  emitWorktreeChanged?: Parameters<typeof subscribeWorktreeTopologyChanges>[0];
  buildOpenCodeUrl?: (path: string, prefix?: string | null) => string;
  getOpenCodeAuthHeaders?: () => Record<string, string>;
  onBranchRewritten?: BindingRoutes['invalidateBranchStatus'];
}
type InstanceDisposerDependencies = {
  buildOpenCodeUrl: (path: string, prefix: string) => string;
  getOpenCodeAuthHeaders: () => Record<string, string>;
};
type GitLibraries = typeof import('./index.js');
type WorktreeCreationErrorBody = { error: unknown; code: unknown; remoteName?: unknown };
type UncheckedFields = {
  readonly operation?: unknown; readonly passphrase?: unknown; readonly candidateId?: unknown;
  readonly expectedFingerprint?: unknown; readonly confirmed?: unknown; readonly directory?: unknown;
  readonly destinationPath?: unknown; readonly digest?: unknown; readonly decision?: unknown;
  readonly fields?: unknown; readonly directories?: unknown; readonly shas?: unknown;
  readonly tempWorktreePath?: unknown; readonly plan?: unknown; readonly state?: unknown;
  readonly repoRoot?: unknown; readonly sourceBranch?: unknown; readonly targetBranch?: unknown;
  readonly commits?: unknown; readonly targetSha?: unknown; readonly pickBase?: unknown; readonly skippedCommits?: unknown; readonly remainingCommits?: unknown;
  readonly currentCommit?: unknown; readonly paths?: unknown; readonly staged?: unknown; readonly context?: unknown;
  readonly path?: unknown; readonly scope?: unknown; readonly patch?: unknown; readonly action?: unknown;
  readonly refs?: unknown; readonly remote?: unknown; readonly expectedHead?: unknown; readonly onto?: unknown;
  readonly branch?: unknown; readonly message?: unknown; readonly addAll?: unknown; readonly files?: unknown;
  readonly stageFiles?: unknown; readonly branches?: unknown; readonly name?: unknown; readonly startPoint?: unknown;
  readonly force?: unknown; readonly oldName?: unknown; readonly newName?: unknown; readonly hash?: unknown;
  readonly mode?: unknown; readonly deleteLocalBranch?: unknown; readonly teardownCommand?: unknown;
  readonly ref?: unknown; readonly id?: unknown; readonly sessionIds?: unknown; readonly title?: unknown;
  readonly deleteBranch?: unknown; readonly worktreeRoot?: unknown; readonly user?: unknown;
  readonly login?: unknown; readonly username?: unknown;
};
type ErrorFields = {
  readonly message?: unknown; readonly code?: unknown; readonly status?: unknown; readonly statusCode?: unknown;
  readonly reason?: unknown; readonly stderr?: unknown; readonly stdout?: unknown; readonly remoteName?: unknown;
};
type RouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<void | Response>;

const hasFields = (value: unknown): value is UncheckedFields => value !== null && value !== undefined;
const hasErrorFields = (value: unknown): value is ErrorFields => value !== null && value !== undefined;
const fieldsOf = <Value>(value: Value) => (hasFields(value) ? value : undefined);
const requiredFields = <Value>(value: Value) => {
  if (!hasFields(value)) throw new TypeError('Request body is missing');
  return value;
};
const errorFields = <Value>(error: Value) => (hasErrorFields(error) ? error : undefined);
const messageOf = <Value>(error: Value) => errorFields(error)?.message;
const statusOf = <Value>(error: Value) => {
  const status = errorFields(error)?.status;
  return isInteger(status) ? status : undefined;
};
const textOf = <Value>(value: Value) => (isString(value) ? value : undefined);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const isJsonScalar = (value: unknown): value is null | string | number | boolean => value === null
  || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
const isJsonContainer = (value: unknown): value is object => typeof value === 'object' && value !== null;
const isJsonValue = (value: unknown): value is JsonValue => {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (isJsonScalar(current)) continue;
    if (!isJsonContainer(current)) return false;
    for (const item of Array.isArray(current) ? current : Object.values(current)) pending.push(item);
  }
  return true;
};
const jsonBody = <Value>(value: Value) => (isJsonValue(value) ? value : null);
const SSH_INVENTORY_OPERATIONS = ['inventory', 'discover', 'import'] as const;
const isSshInventoryOperation = (value: unknown): value is typeof SSH_INVENTORY_OPERATIONS[number] =>
  SSH_INVENTORY_OPERATIONS.some((operation) => operation === value);
const RESET_MODES = ['soft', 'mixed', 'hard'] as const;
const isResetMode = (value: unknown): value is typeof RESET_MODES[number] => RESET_MODES.some((mode) => mode === value);

const NETWORK_OPERATION_ID = /^[A-Za-z0-9_-]{1,200}$/;
const toGitIdentitySummary = (identity: { userName?: string | null; userEmail?: string | null } | null | undefined) => identity ? {
  userName: identity.userName ?? null,
  userEmail: identity.userEmail ?? null,
} : null;
const toGitRemoteSummary = (remote: { name?: unknown; fetchUrl?: string | null; pushUrl?: string | null } | null | undefined) => ({
  name: String(remote?.name || ''),
  fetchUrl: redactRemoteUrl(remote?.fetchUrl),
  pushUrl: redactRemoteUrl(remote?.pushUrl),
});

const WORKTREE_INSTANCE_DISPOSE_TIMEOUT_MS = 5_000;

const toLocationKey = (directory: string) => String(directory || '').replace(/\\/g, '/').replace(/\/+$/, '');

export const createWorktreeInstanceDisposer = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders }: InstanceDisposerDependencies) => {
  return async (worktreeDirectory: string) => {
    const client = OpenCode.make({
      baseUrl: buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      headers: getOpenCodeAuthHeaders(),
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(WORKTREE_INSTANCE_DISPOSE_TIMEOUT_MS) }),
    });
    const root = toLocationKey(worktreeDirectory);
    const errors: unknown[] = [];
    const inside = await client.debug.location.list().then(
      (locations) => locations.map((location) => location.directory)
        .filter((directory) => toLocationKey(directory).startsWith(`${root}/`)),
      (error) => {
        errors.push(error);
        return [];
      },
    );
    const evictions = await Promise.allSettled([worktreeDirectory, ...inside].map((directory) => (
      client.debug.location.evict({ location: { directory } })
    )));
    for (const eviction of evictions) {
      if (eviction.status === 'rejected') errors.push(eviction.reason);
    }
    if (errors.length > 0) throw errors[0];
  };
};


const worktreeTitleBodySchema = z.object({ title: z.string(), by: z.enum(['user', 'agent']).default('user'), session: z.string().optional() });
const worktreePinBodySchema = z.object({ pinned: z.boolean(), list: z.string().nullable().optional() });

const userAction = (handler: RouteHandler) => (req: Request, res: Response, next: NextFunction) => runAsUserAction(() => handler(req, res, next));
export function registerGitRoutes(app: Application, {
  networkOperations, managedSshInventory, getSourceControlBinding, contributorProvenance, resolveChangeRequestSource,
  backfillIdentities,
  createHttpsCredentialReference, resolveSourceControlAccount, errorRedactionSecrets = [], worktreeBootstrapStore,
  emitWorktreeChanged, buildOpenCodeUrl, getOpenCodeAuthHeaders, onBranchRewritten,
}: GitRouteDependencies = {}) {
  let gitLibraries: GitLibraries | null = null;
  const getGitLibraries = async () => {
    if (!gitLibraries) {
      gitLibraries = await import('./index.js');
      if (emitWorktreeChanged) {
        gitLibraries.subscribeWorktreeTopologyChanges(emitWorktreeChanged);
      }
    }
    return gitLibraries;
  };

  const GIT_DIFFS_MAX_PATHS = 1000;
  const GIT_PATH_ERROR_STATUS = new Map<unknown, number>([['path_not_found', 404], ['nested_repository', 422], ['untracked_directory', 422]]);
  const sendGitPathError = <Cause>(res: Response, error: Cause) => {
    const status = GIT_PATH_ERROR_STATUS.get(errorFields(error)?.code);
    if (!status) return false;
    res.status(status).json({ error: messageOf(error), code: errorFields(error)?.code });
    return true;
  };

  const resolveDirectoryQuery = <Value>(value: Value, preserveWhitespace = false) => {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!isString(raw)) {
      return null;
    }
    const normalized = preserveWhitespace ? raw : raw.trim();
    return normalized || null;
  };

  const extractGitErrorText = <Cause>(error: Cause) => {
    const fields = errorFields(error);
    const message = isString(fields?.message) ? fields.message : '';
    const stderr = isString(fields?.stderr) ? fields.stderr : '';
    const stdout = isString(fields?.stdout) ? fields.stdout : '';
    const fallback = !message && error != null ? String(error) : '';
    return [message, stderr, stdout, fallback]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join('\n');
  };

  const isNonRepoGitError = <Cause>(error: Cause) => /not a git repository/i.test(extractGitErrorText(error));
  const isUnreadableRepositoryError = <Cause>(error: Cause) => ['GIT_REPOSITORY_UNREADABLE', DIRECTORY_UNREACHABLE].some((code) => errorFields(error)?.code === code);
  const unreadableRepositoryBody = <Cause>(error: Cause) => ({ error: messageOf(error), code: 'GIT_REPOSITORY_UNREADABLE' });
  const probeOptions = { failOnGitError: true };

  const instanceDisposer = () => (buildOpenCodeUrl && getOpenCodeAuthHeaders
    ? createWorktreeInstanceDisposer({ buildOpenCodeUrl, getOpenCodeAuthHeaders })
    : undefined);

  const nonRepoStatusPayload = () => ({
    isGitRepository: false,
    files: [],
    branch: null,
    ahead: 0,
    behind: 0,
  });

  type ListedWorktree = { path: string; provenance?: { kind: 'contributor-fork'; revision: number; trust: 'untrusted'; push: 'destination-selection-required' } };
  const enrichWorktreeProvenance = async <Worktree extends ListedWorktree>(worktrees: Worktree[]) => {
    if (contributorProvenance?.readMany instanceof Function) {
      const records = await contributorProvenance.readMany(worktrees.map((worktree) => worktree.path));
      for (let index = 0; index < worktrees.length; index += 1) {
        const worktree = worktrees[index];
        const record = records[index];
        if (worktree && record?.provenance?.kind === 'contributor-fork') {
          worktree.provenance = {
            kind: 'contributor-fork', revision: record.revision,
            trust: 'untrusted', push: 'destination-selection-required',
          };
        }
      }
    }
    return worktrees;
  };

  const isContributorCheckout = contributorProvenance?.read instanceof Function
    ? async (worktreeDirectory: string) => (await contributorProvenance.read(worktreeDirectory)).provenance?.kind === 'contributor-fork'
    : undefined;
  const checkoutProvenance = (provenance: ContributorProvenance) => {
    const { sourceSha } = provenance;
    if (!isString(sourceSha)) {
      throw Object.assign(new Error('Contributor worktree HEAD changed'), { code: 'STALE_CONFIG', status: 409 });
    }
    return { ...provenance, sourceSha };
  };
  const worktreeTeardownCodeOf = <Cause>(error: Cause) => (errorFields(error)?.code === 'WORKTREE_TEARDOWN_FAILED' ? 'WORKTREE_TEARDOWN_FAILED' : undefined);

  const NETWORK_ERROR_MESSAGES = {
    NOT_FOUND: 'Git network operation was not found',
    INVALID_REQUEST: 'Invalid Git network operation request',
    STALE_REPOSITORY: 'Git repository authority changed',
    STALE_BINDING: 'Source control binding changed',
    STALE_CONFIG: 'Git repository configuration changed',
    REMOTE_CHANGED: 'Git remote or transport binding changed',
    REMOTE_URL_USERINFO: 'Remove the name before @ from remote URL',
    AUTHENTICATION_REQUIRED: 'Git authentication is required',
    DESTINATION_SELECTION_REQUIRED: 'Contributor push destination selection is required',
    CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED: 'Contributor transfers require managed credentials',
    TIMEOUT: 'Git network operation timed out',
    RUNTIME_UNSUPPORTED: 'Git network operations are unavailable',
    UNKNOWN: 'Git network operation request failed',
  };
  type PublicNetworkCode = keyof typeof NETWORK_ERROR_MESSAGES;
  const PRESERVED_NETWORK_CODES: readonly PublicNetworkCode[] = [
    'STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED',
    'AUTHENTICATION_REQUIRED', 'TIMEOUT', 'RUNTIME_UNSUPPORTED',
    'DESTINATION_SELECTION_REQUIRED', 'CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED',
  ];
  const sendNetworkOperationError = <Cause>(req: Request, res: Response, error: Cause) => {
    const fields = errorFields(error);
    const code = isString(fields?.code) ? fields.code : 'UNKNOWN';
    const storageFailure = code === 'GIT_NETWORK_OPERATION_STORAGE_INVALID';
    let status = 500;
    const errorStatus = fields?.status;
    if (isInteger(errorStatus)) status = errorStatus;
    else if (code === 'GIT_NETWORK_OPERATION_NOT_FOUND') status = 404;
    else if (!storageFailure && code.includes('INVALID')) status = 400;
    else if (code.includes('STALE') || code.includes('CHANGED') || code.includes('CONFLICT')) status = 409;
    else if (code === 'AUTHENTICATION_REQUIRED') status = 401;
    else if (code === 'DESTINATION_SELECTION_REQUIRED' || code === 'CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED') status = 409;
    else if (code === 'RUNTIME_UNSUPPORTED') status = 501;

    let publicCode: PublicNetworkCode | undefined;
    if (code === 'GIT_NETWORK_OPERATION_NOT_FOUND') publicCode = 'NOT_FOUND';
    else if (fields?.reason === 'needs-attention') publicCode = 'AUTHENTICATION_REQUIRED';
    else if (code === 'SOURCE_CONTROL_BINDING_STALE') publicCode = 'STALE_BINDING';
    else if (code === 'UNSUPPORTED_SOURCE_CONTROL_REPOSITORY') publicCode = 'STALE_REPOSITORY';
    else if (code === 'GIT_NETWORK_OPERATION_AUTHORITY_CHANGED') publicCode = 'REMOTE_CHANGED';
    else if (code === 'INVALID_GIT_REMOTE_USERINFO') publicCode = 'REMOTE_URL_USERINFO';
    if (!publicCode && !storageFailure && code.includes('INVALID')) publicCode = 'INVALID_REQUEST';
    if (!publicCode) publicCode = PRESERVED_NETWORK_CODES.find((preserved) => preserved === code);
    publicCode ??= 'UNKNOWN';
    const body = fieldsOf(req.body);
    const requestPaths = [body?.directory, body?.destinationPath].filter(isString);
    const redactor = createGitRedactor({ secrets: [...errorRedactionSecrets, ...requestPaths] });
    const reason = redactor.error(error, NETWORK_ERROR_MESSAGES[publicCode]);
    console.error('Git network operation request failed:', reason);
    return res.status(status).json({ error: publicCode === 'INVALID_REQUEST' ? reason : NETWORK_ERROR_MESSAGES[publicCode], code: publicCode });
  };
  const operationId = (req: Request) => {
    const id = fieldsOf(req.params)?.id;
    return isString(id) && NETWORK_OPERATION_ID.test(id) ? id : null;
  };
  const hasEmptyBody = (req: Request) => req.body === undefined
    || Boolean(req.body && Object.getPrototypeOf(req.body) === Object.prototype && Object.keys(req.body).length === 0);
  app.post('/api/git/managed-ssh-credentials', async (req, res) => {
    const input = fieldsOf(req.body);
    const keys = input?.operation === 'import' ? ['operation', 'candidateId', 'expectedFingerprint', 'confirmed'] : ['operation'];
    if (input?.operation !== 'inventory' && Object.hasOwn(input ?? {}, 'passphrase')) keys.push('passphrase');
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || !isSshInventoryOperation(input.operation)
      || Object.keys(input).length !== keys.length || !keys.every((key) => Object.hasOwn(input, key))
      || (Object.hasOwn(input, 'passphrase') && (!isString(input.passphrase)
        || input.passphrase.length > 1024 || /[\0\r\n]/.test(input.passphrase)))
      || (input.operation === 'import' && (input.confirmed !== true || !isString(input.candidateId)
        || !/^[A-Za-z0-9_-]{1,200}$/.test(input.candidateId) || !isString(input.expectedFingerprint)
        || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(input.expectedFingerprint)))) {
      return res.status(400).json({ code: 'INVALID_REQUEST', error: 'Invalid managed SSH inventory request' });
    }
    const { operation, passphrase, candidateId, expectedFingerprint } = input;
    const passphraseInput = isString(passphrase) ? { passphrase } : {};
    res.set('Cache-Control', 'no-store');
    if (!managedSshInventory) return res.status(501).json({ code: 'RUNTIME_UNSUPPORTED', error: 'Managed SSH inventory is unavailable' });
    try {
      if (operation === 'inventory') return res.json(await managedSshInventory.inventory());
      if (operation === 'discover') return res.json(await managedSshInventory.discover(passphraseInput));
      if (!isString(candidateId) || !isString(expectedFingerprint)) throw new TypeError('Managed SSH import input is invalid');
      return res.json(await managedSshInventory.import({ candidateId, expectedFingerprint, confirmed: true, ...passphraseInput }));
    } catch {
      const errors = {
        inventory: 'Managed SSH inventory could not be read',
        discover: 'Managed SSH keys could not be discovered',
        import: 'Managed SSH key could not be imported',
      };
      return res.status(500).json({ code: 'UNKNOWN', error: errors[operation] });
    }
  });
  const worktreeCreation = createWorktreeCreation({
    getGitLibraries,
    networkOperations,
    getSourceControlBinding,
    contributorProvenance,
    resolveChangeRequestSource,
    createHttpsCredentialReference,
    resolveSourceControlAccount,
    worktreeBootstrapStore, disposeInstance: instanceDisposer(),
  });
  const rejectLegacyNetworkOperation = async (directory: string, res: Response) => {
    if (contributorProvenance?.read instanceof Function) {
      try {
        const record = await contributorProvenance.read(directory);
        if (record.provenance?.kind === 'contributor-fork') {
          res.status(409).json({
            error: 'Contributor worktrees require an exact managed destination selection',
            code: 'DESTINATION_SELECTION_REQUIRED',
          });
          return true;
        }
      } catch {
        res.status(500).json({ error: 'Failed to verify contributor worktree provenance', code: 'UNKNOWN' });
        return true;
      }
    }
    res.status(409).json({
      error: 'Git network operations require the planned operation API',
      code: 'GIT_NETWORK_OPERATION_REQUIRED',
    });
    return true;
  };

  app.post('/api/git/network-operations', async (req, res) => {
    if (!networkOperations) return res.status(501).json({ error: 'Git network operations are unavailable', code: 'RUNTIME_UNSUPPORTED' });
    try {
      return res.status(201).json(await networkOperations.plan(jsonBody(req.body)));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.post('/api/git/contributor-destinations', async (req, res) => {
    if (!(networkOperations?.issueContributorDestination instanceof Function)) {
      return res.status(501).json({ error: 'Contributor destination selection is unavailable', code: 'RUNTIME_UNSUPPORTED' });
    }
    try {
      return res.status(201).json(await networkOperations.issueContributorDestination(jsonBody(req.body)));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.get('/api/git/contributor-destinations', async (req, res) => {
    const directory = resolveDirectoryQuery(req.query?.directory);
    if (!directory || !(getSourceControlBinding instanceof Function)
      || !(contributorProvenance?.read instanceof Function)) {
      return res.status(501).json({ error: 'Contributor destination selection is unavailable', code: 'RUNTIME_UNSUPPORTED' });
    }
    try {
      const [record, bindingRead] = await Promise.all([
        contributorProvenance.read(directory), getSourceControlBinding(directory),
      ]);
      const provenance = record.provenance;
      if (provenance?.kind !== 'contributor-fork') {
        return res.json({ kind: 'ordinary' });
      }
      const binding = bindingRead.binding;
      if (!binding || binding.repositoryId !== record.repositoryId
        || binding.repositoryId !== bindingRead.repository.repositoryId || binding.revision !== bindingRead.revision) {
        return res.status(409).json({ error: 'Contributor push destination selection is required', code: 'DESTINATION_SELECTION_REQUIRED' });
      }
      type BoundProvider = (typeof binding.providers)[number];
      const accountCache = new Map<string, Promise<unknown>>();
      const accountFor = async (provider: BoundProvider) => {
        const key = `${provider.provider}\0${provider.instance}\0${provider.accountId}`;
        if (!accountCache.has(key)) {
          accountCache.set(key, resolveSourceControlAccount instanceof Function
            ? Promise.resolve(resolveSourceControlAccount(provider)).catch(() => null)
            : Promise.resolve(null));
        }
        return accountCache.get(key);
      };
      const currentRemotes = new Map(bindingRead.repository.remotes.map((remote) => [remote.name, remote]));
      const candidates = await Promise.all(binding.remotes
        .filter((remote) => {
          const current = currentRemotes.get(remote.name);
          return remote.mode === 'managed' && remote.credentialId && remote.readiness === 'ready' && current
            && remote.fetch.fingerprint === current.fetch.fingerprint && remote.push.fingerprint === current.push.fingerprint;
        })
        .map(async (remote) => {
          let classification = 'other';
          const providers = binding.providers.filter((provider) => provider.primaryRemote === remote.name
            && provider.readiness === 'ready' && provider.endpoint?.fingerprint === remote.fetch.fingerprint);
          const boundRepository = providers.some((provider) => provider.provider === provenance.provider
            && provider.instance === provenance.instance
            && provider.accountId === provenance.accountId
            && remote.name === provenance.primaryRemote);
          if (remote.push.fingerprint === provenance.endpointFingerprint) {
            classification = 'contributor-fork';
          } else if (boundRepository) {
            classification = 'bound-repository';
          } else {
            for (const provider of providers) {
              const user = fieldsOf(fieldsOf(await accountFor(provider))?.user);
              const login = String(user?.login || user?.username || '').toLowerCase();
              if (login && provider.repository?.owner?.toLowerCase() === login) {
                classification = 'own-fork';
                break;
              }
            }
          }
          return {
            remote: { name: remote.name, endpoint: remote.push },
            transportMode: 'managed',
            classification,
          };
        }));
      if (!candidates.length) {
        return res.status(409).json({ error: 'Contributor push destination selection is required', code: 'DESTINATION_SELECTION_REQUIRED' });
      }
      return res.json({
        kind: 'contributor',
        repositoryId: binding.repositoryId,
        bindingRevision: binding.revision,
        configRevision: bindingRead.repository.configRevision,
        provenanceRevision: record.revision,
        candidates,
      });
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.get('/api/git/worktrees/checkout-trust', async (req, res) => {
    const directory = resolveDirectoryQuery(req.query?.directory);
    if (!directory || !(contributorProvenance?.read instanceof Function)) {
      return res.status(400).json({ error: 'Contributor worktree is required', code: 'INVALID_REQUEST' });
    }
    try {
      const { inspectContributorCheckoutActions } = await getGitLibraries();
      const record = await contributorProvenance.read(directory);
      if (record.provenance?.kind !== 'contributor-fork') {
        return res.status(409).json({ error: 'Contributor worktree is required', code: 'STALE_CONFIG' });
      }
      const inspection = await inspectContributorCheckoutActions(directory, checkoutProvenance(record.provenance));
      return res.json({
        state: inspection.state,
        digest: inspection.digest,
        actions: inspection.actions.map((action) => ({
          kind: action.kind,
          label: action.kind === 'post-checkout-hook' ? 'post-checkout' : action.command,
        })),
      });
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.post('/api/git/worktrees/checkout-trust', async (req, res) => {
    const directory = resolveDirectoryQuery(req.query?.directory);
    const digest = fieldsOf(req.body)?.digest;
    const decision = fieldsOf(req.body)?.decision;
    if (!directory || !isString(digest) || (decision !== 'run' && decision !== 'skip')
      || Object.keys(req.body || {}).some((key) => !['digest', 'decision'].includes(key))) {
      return res.status(400).json({ error: 'Invalid checkout trust decision', code: 'INVALID_REQUEST' });
    }
    try {
      const { inspectContributorCheckoutActions } = await getGitLibraries();
      if (!contributorProvenance) throw new TypeError('Contributor provenance is unavailable');
      const record = await contributorProvenance.read(directory);
      if (record.provenance?.kind !== 'contributor-fork') {
        return res.status(409).json({ error: 'Contributor worktree changed', code: 'STALE_CONFIG' });
      }
      const provenance = checkoutProvenance(record.provenance);
      if (!networkOperations) throw new TypeError('Git network operations are unavailable');
      const result = await networkOperations.decideCheckoutTrust({
        directory,
        repositoryId: record.repositoryId,
        digest,
        decision,
        headSha: provenance.sourceSha,
        nullRef: '0'.repeat(40),
        inspect: () => inspectContributorCheckoutActions(directory, provenance),
      });
      return res.json(result);
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.post('/api/git/network-operations/:id/execute', async (req, res) => {
    const id = operationId(req);
    if (!id || !hasEmptyBody(req)) return res.status(400).json({ error: 'Invalid Git network operation request', code: 'INVALID_REQUEST' });
    if (!networkOperations) return res.status(501).json({ error: 'Git network operations are unavailable', code: 'RUNTIME_UNSUPPORTED' });
    try {
      return res.json(await networkOperations.execute(id));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.get('/api/git/network-operations/:id', async (req, res) => {
    const id = operationId(req);
    if (!id) return res.status(400).json({ error: 'Invalid Git network operation ID', code: 'INVALID_REQUEST' });
    if (!networkOperations) return res.status(501).json({ error: 'Git network operations are unavailable', code: 'RUNTIME_UNSUPPORTED' });
    try {
      return res.json(await networkOperations.get(id));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  app.post('/api/git/network-operations/:id/cancel', async (req, res) => {
    const id = operationId(req);
    if (!id || !hasEmptyBody(req)) return res.status(400).json({ error: 'Invalid Git network operation request', code: 'INVALID_REQUEST' });
    if (!networkOperations) return res.status(501).json({ error: 'Git network operations are unavailable', code: 'RUNTIME_UNSUPPORTED' });
    try {
      return res.json(await networkOperations.cancel(id));
    } catch (error) {
      return sendNetworkOperationError(req, res, error);
    }
  });

  let identitiesBackfilled = false;
  app.get('/api/git/identities', async (req, res) => {
    const { getProfiles } = await getGitLibraries();
    try {
      if (!identitiesBackfilled && backfillIdentities instanceof Function) {
        identitiesBackfilled = true;
        await backfillIdentities();
      }
      const profiles = getProfiles();
      res.set('Cache-Control', 'no-store');
      res.json(profiles.map(toPublicGitIdentityProfile));
    } catch {
      console.error('Failed to list git identity profiles');
      res.status(500).json({ error: 'Failed to list git identity profiles' });
    }
  });

  app.post('/api/git/identities', async (req, res) => {
    const { createProfile } = await getGitLibraries();
    try {
      const profile = createProfile(parsePublicGitIdentityProfile(req.body));
      res.json(toPublicGitIdentityProfile(profile));
    } catch {
      console.error('Failed to create git identity profile');
      res.status(400).json({ error: 'Failed to create git identity profile' });
    }
  });

  app.put<unknown, { id: string }>('/api/git/identities/:id', async (req, res) => {
    const { updateProfile } = await getGitLibraries();
    try {
      const profile = updateProfile(req.params.id, parsePublicGitIdentityProfile(req.body, req.params.id));
      res.json(toPublicGitIdentityProfile(profile));
    } catch {
      console.error('Failed to update git identity profile');
      res.status(400).json({ error: 'Failed to update git identity profile' });
    }
  });

  app.delete<unknown, { id: string }>('/api/git/identities/:id', async (req, res) => {
    const { deleteProfile } = await getGitLibraries();
    try {
      deleteProfile(req.params.id);
      res.json({ success: true });
    } catch {
      console.error('Failed to delete git identity profile');
      res.status(400).json({ error: 'Failed to delete git identity profile' });
    }
  });

  app.get('/api/git/global-identity', async (req, res) => {
    const { getGlobalIdentity } = await getGitLibraries();
    try {
      const identity = await getGlobalIdentity();
      res.json(toGitIdentitySummary(identity));
    } catch (error) {
      console.error('Failed to get global git identity:', error);
      res.status(500).json({ error: 'Failed to get global git identity' });
    }
  });

  app.get('/api/git/check', async (req, res) => {
    const { isGitRepository } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const isRepo = await isGitRepository(directory, probeOptions);
      res.json({ isGitRepository: isRepo });
    } catch (error) {
      if (isUnreadableRepositoryError(error)) {
        return res.status(500).json(unreadableRepositoryBody(error));
      }
      if (isNonRepoGitError(error)) {
        console.warn('Git check treated non-repository path as not a git repo:', extractGitErrorText(error));
        return res.json({ isGitRepository: false });
      }
      console.error('Failed to check git repository:', error);
      res.status(500).json({ error: 'Failed to check git repository' });
    }
  });

  const PROJECT_BATCH_MAX_DIRECTORIES = 200;

  const resolveBatchDirectories = <Body>(body: Body) => {
    if (!isPlainObject(body) || !Array.isArray(body.directories)) return null;
    const directories: string[] = [];
    const seen = new Set<string>();
    const values: unknown[] = body.directories;
    for (const value of values) {
      const directory = resolveDirectoryQuery(value);
      if (!directory || seen.has(directory)) continue;
      seen.add(directory);
      directories.push(directory);
    }
    return directories;
  };

  const readProjectBatch = async <Entry>(req: Request, res: Response, readDirectory: (directory: string) => Promise<Entry>, failedDirectory: (directory: string, message: string) => Entry) => {
    const directories = resolveBatchDirectories(req.body);
    if (!directories || directories.length === 0) {
      return res.status(400).json({ error: 'directories array is required' });
    }
    if (directories.length > PROJECT_BATCH_MAX_DIRECTORIES) {
      return res.status(400).json({ error: `At most ${PROJECT_BATCH_MAX_DIRECTORIES} directories may be read at once` });
    }

    return res.json({ projects: await readProjects(directories, readDirectory, failedDirectory) });
  };

  app.post('/api/git/projects', async (req, res) => {
    const { isGitRepository, getStatus, resolvePrimaryWorktreeRoot, observeWorktreeTopology } = await getGitLibraries();
    const requestedFields = fieldsOf(req.body)?.fields;
    const fields: unknown[] = Array.isArray(requestedFields) ? requestedFields : [];
    const wantsStatus = fields.includes('status');
    const wantsRoot = fields.includes('root');
    type ProjectEntry = { directory: string; isGitRepository: boolean; status?: unknown; root?: string | null; errors?: string[] };
    const nonRepoEntry = (directory: string) => {
      const entry: ProjectEntry = { directory, isGitRepository: false };
      if (wantsStatus) entry.status = nonRepoStatusPayload();
      if (wantsRoot) entry.root = null;
      return entry;
    };
    return readProjectBatch(req, res, async (directory) => {
      try {
        const isRepo = await isGitRepository(directory, probeOptions);
        if (!isRepo) {
          return nonRepoEntry(directory);
        }

        const entry: ProjectEntry = { directory, isGitRepository: true };
        const failures: string[] = [];
        const reads: Promise<void>[] = [];
        if (wantsStatus) {
          void observeWorktreeTopology(directory);
          reads.push((async () => {
            try {
              entry.status = await getStatus(directory);
            } catch (error) {
              console.error('Git project batch status failed:', directory, error);
              entry.status = null;
              failures.push('status');
            }
          })());
        }
        if (wantsRoot) {
          reads.push((async () => {
            try {
              entry.root = (await resolvePrimaryWorktreeRoot(directory)).root;
            } catch (error) {
              console.error('Git project batch primary root failed:', directory, error);
              entry.root = null;
              failures.push('root');
            }
          })());
        }
        await Promise.all(reads);
        if (failures.length > 0) entry.errors = failures;
        return entry;
      } catch (error) {
        if (isUnreadableRepositoryError(error)) {
          return { directory, ...unreadableRepositoryBody(error) };
        }
        if (isNonRepoGitError(error)) {
          return nonRepoEntry(directory);
        }
        console.error('Failed to read git project overview:', directory, error);
        return { directory, error: 'Failed to read project repository' };
      }
    }, (directory, error) => ({ directory, error }));
  });

  app.post('/api/git/project-worktrees', async (req, res) => {
    const { getWorktrees, observeWorktreeTopology } = await getGitLibraries();
    return readProjectBatch(req, res, async (directory) => {
      try {
        const worktrees = await enrichWorktreeProvenance(await getWorktrees(directory));
        if (worktrees.length > 0) {
          void observeWorktreeTopology(directory);
        }
        return { directory, worktrees };
      } catch (error) {
        console.error('Git project worktree batch failed:', directory, error);
        return { directory, worktrees: null, errors: ['worktrees'] };
      }
    }, (directory) => ({ directory, worktrees: null, errors: ['worktrees'] }));
  });

  app.get('/api/git/remote-url', async (req, res) => {
    const { getRemoteUrl } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const remote = textOf(req.query.remote) || 'origin';

      const url = await getRemoteUrl(directory, remote);
      const displayUrl = url ? redactRemoteUrl(url) : '';
      res.json({ url: displayUrl || null });
    } catch (error) {
      console.error('Failed to get remote url:', error);
      res.status(500).json({ error: 'Failed to get remote url' });
    }
  });

  app.get('/api/git/current-identity', async (req, res) => {
    const { getCurrentIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const identity = await getCurrentIdentity(directory);
      res.json(toGitIdentitySummary(identity));
    } catch (error) {
      console.error('Failed to get current git identity:', error);
      res.status(500).json({ error: 'Failed to get current git identity' });
    }
  });

  app.get('/api/git/has-local-identity', async (req, res) => {
    const { hasLocalIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const hasLocal = await hasLocalIdentity(directory);
      res.json({ hasLocalIdentity: hasLocal });
    } catch (error) {
      console.error('Failed to check local git identity:', error);
      res.status(500).json({ error: 'Failed to check local git identity' });
    }
  });

  app.post('/api/git/set-identity', async (req, res) => {
    const { getProfile, setLocalIdentity, clearLocalIdentity, getGlobalIdentity } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const body = req.body;
      const profileId = isPlainObject(body) && Object.keys(body).length === 1 && isString(body.profileId)
        ? body.profileId.trim() : '';
      if (!profileId) {
        return res.status(400).json({ error: 'profileId is required' });
      }

      let profile = null;

      if (profileId === 'global') {
        await clearLocalIdentity(directory);
        const globalIdentity = await getGlobalIdentity();
        const profile = globalIdentity?.userName && globalIdentity?.userEmail
          ? toPublicGitIdentityProfile({
            id: 'global',
            name: globalIdentity.userName,
            userName: globalIdentity.userName,
            userEmail: globalIdentity.userEmail,
          })
          : null;
        return res.json({ success: true, profile });
      } else {
        profile = getProfile(profileId);
        if (!profile) {
          return res.status(404).json({ error: 'Profile not found' });
        }
      }

      const publicProfile = toPublicGitIdentityProfile(profile);
      await setLocalIdentity(directory, publicProfile);
      res.json({ success: true, profile: publicProfile });
    } catch (error) {
      console.error('Failed to set git identity:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to set git identity' });
    }
  });

  registerGitStatusBatchRoute(app, (directory, mode) => whileReachable(directory, async () => {
    const { getStatus, isGitRepository, observeWorktreeTopology } = await getGitLibraries();
    const isRepo = await isGitRepository(directory, probeOptions);
    if (!isRepo) return {
      isGitRepository: false,
      status: { current: '', tracking: null, ahead: 0, behind: 0, files: [], isClean: true },
    };
    void observeWorktreeTopology(directory);
    return { isGitRepository: true, status: await getStatus(directory, { mode }) };
  }));

  app.get('/api/git/status', async (req, res) => {
    const { getStatus, isGitRepository, observeWorktreeTopology } = await getGitLibraries();

    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const isRepo = await isGitRepository(directory, probeOptions);
      if (!isRepo) {
        return res.json(nonRepoStatusPayload());
      }

      void observeWorktreeTopology(directory);

      const mode = req.query.mode === 'light' ? 'light' : undefined;
      const status = await getStatus(directory, { mode });
      res.json(status);
    } catch (error) {
      if (isUnreadableRepositoryError(error)) {
        return res.status(500).json(unreadableRepositoryBody(error));
      }
      if (isNonRepoGitError(error)) {
        console.warn('Git status skipped for non-repository path:', extractGitErrorText(error));
        return res.json(nonRepoStatusPayload());
      }
      console.error('Failed to get git status:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get git status' });
    }
  });

  app.get('/api/git/primary-root', async (req, res) => {
    const { resolvePrimaryWorktreeRoot } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await resolvePrimaryWorktreeRoot(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to resolve git primary root:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to resolve git primary root' });
    }
  });

  app.get('/api/git/toplevel', async (req, res) => {
    const { resolveWorktreeTopLevel } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await resolveWorktreeTopLevel(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to resolve git worktree toplevel:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to resolve git worktree toplevel' });
    }
  });

  app.post('/api/git/commit-summaries', async (req, res) => {
    const { getCommitSummaries } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const result = await getCommitSummaries(directory, fieldsOf(req.body)?.shas);
      res.json(result);
    } catch (error) {
      console.error('Failed to get git commit summaries:', error);
      res.status(400).json({ error: messageOf(error) || 'Failed to get git commit summaries' });
    }
  });

  const handleIntegrateAction = <Result>(action: string, loadHandler: () => Promise<(body: UncheckedFields) => Promise<Result>>) => {
    app.post(`/api/git/integrate/${action}`, async (req, res) => {
      try {
        const handler = await loadHandler();
        const result = await handler(requiredFields(req.body || {}));
        res.json(result);
      } catch (error) {
        console.error(`Failed to run git integrate ${action}:`, error);
        res.status(400).json({ error: messageOf(error) || `Failed to run git integrate ${action}` });
      }
    });
  };

  handleIntegrateAction('plan', async () => (await getGitLibraries()).computeIntegratePlan);

  handleIntegrateAction('conflicts', async () => (body: UncheckedFields) => getGitLibraries().then((git) => git.listIntegrateConflicts(body.directory)));

  handleIntegrateAction('conflict-details', async () => {
    const { getIntegrateConflictDetails } = await getGitLibraries();
    return (body: UncheckedFields) => getIntegrateConflictDetails(body.tempWorktreePath);
  });

  handleIntegrateAction('cherry-pick-status', async () => {
    const { isIntegrateInProgress } = await getGitLibraries();
    return (body: UncheckedFields) => isIntegrateInProgress(body.tempWorktreePath);
  });

  handleIntegrateAction('run', async () => {
    const { integrateWorktreeCommits } = await getGitLibraries();
    return (body: UncheckedFields) => runAsUserAction(() => integrateWorktreeCommits(fieldsOf(body.plan)));
  });

  handleIntegrateAction('abort', async () => {
    const { abortIntegrate } = await getGitLibraries();
    return (body: UncheckedFields) => abortIntegrate(fieldsOf(body.state));
  });

  handleIntegrateAction('continue', async () => {
    const { continueIntegrate } = await getGitLibraries();
    return (body: UncheckedFields) => runAsUserAction(() => continueIntegrate(fieldsOf(body.state)));
  });

  app.get('/api/git/diff', async (req, res) => {
    const { getPathDiff } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const path = req.query.path;
      if (!path || !isString(path)) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const staged = req.query.staged === 'true';
      const context = req.query.context ? parseInt(String(req.query.context), 10) : undefined;
      const previousPath = String(req.query.previousPath ?? '') || undefined;

      const { diff, submodule } = await getPathDiff(directory, {
        path,
        staged,
        previousPath,
        contextLines: Number.isFinite(context) ? context : 3,
      });

      res.json({ diff, submodule });
    } catch (error) {
      if (sendGitPathError(res, error)) return;
      if (isNonRepoGitError(error)) {
        return res.status(409).json({ error: 'This directory is not a Git repository.', code: 'not_repository' });
      }
      console.error('Failed to get git diff:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get git diff' });
    }
  });

  app.post('/api/git/diffs', async (req, res) => {
    const { getPathDiffs } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!isString(directory) || !directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const paths = fieldsOf(req.body)?.paths;
      if (!Array.isArray(paths) || paths.length === 0 || paths.length > GIT_DIFFS_MAX_PATHS || !paths.every((path) => isString(path) && path)) {
        return res.status(400).json({ error: `paths must be 1 to ${GIT_DIFFS_MAX_PATHS} non-empty strings` });
      }

      const staged = fieldsOf(req.body)?.staged === true;
      const context = Number(fieldsOf(req.body)?.context);

      const diffs = await getPathDiffs(directory, {
        paths,
        staged,
        contextLines: Number.isInteger(context) && context >= 0 ? context : 3,
      });

      res.json({ diffs });
    } catch (error) {
      if (isNonRepoGitError(error)) {
        return res.status(409).json({ error: 'This directory is not a Git repository.', code: 'not_repository' });
      }
      console.error('Failed to get git diffs:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get git diffs' });
    }
  });

  app.get('/api/git/file-diff', async (req, res) => {
    const { getFileDiff } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const pathParam = req.query.path;
      if (!pathParam || !isString(pathParam)) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const staged = req.query.staged === 'true';
      const previousPath = String(req.query.previousPath ?? '') || undefined;

      const result = await getFileDiff(directory, {
        path: pathParam,
        staged,
        previousPath,
      });

      res.json({
        original: result.original,
        modified: result.modified,
        path: result.path,
        isBinary: Boolean(result.isBinary),
        submodule: result.submodule ?? null,
      });
    } catch (error) {
      if (sendGitPathError(res, error)) return;
      if (isNonRepoGitError(error)) {
        return res.status(409).json({ error: 'This directory is not a Git repository.', code: 'not_repository' });
      }
      console.error('Failed to get git file diff:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get git file diff' });
    }
  });

  registerGitRangeRoutes(app, getGitLibraries, { networkOperations, getSourceControlBinding });

  app.post('/api/git/revert', async (req, res) => {
    const { revertFile } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, scope } = fieldsOf(req.body) ?? {};
      if (!path || !isString(path)) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await revertFile(directory, path, { scope });
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to revert git file:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to revert git file' });
    }
  });

  app.post('/api/git/stage', async (req, res) => {
    const { stageFiles } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, paths } = fieldsOf(req.body) ?? {};
      const filePaths = Array.isArray(paths) ? paths : [path];
      if (!filePaths.some((value) => isString(value) && value.trim())) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await stageFiles(directory, filePaths);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to stage git file:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to stage git file' });
    }
  });

  app.post('/api/git/unstage', async (req, res) => {
    const { unstageFiles } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path, paths } = fieldsOf(req.body) ?? {};
      const filePaths = Array.isArray(paths) ? paths : [path];
      if (!filePaths.some((value) => isString(value) && value.trim())) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      await unstageFiles(directory, filePaths);
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to unstage git file:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to unstage git file' });
    }
  });

  app.post('/api/git/apply-hunk', async (req, res) => {
    const { applyHunk } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { path: filePath, patch, action } = fieldsOf(req.body) ?? {};
      if (!filePath || !isString(filePath)) {
        return res.status(400).json({ error: 'path parameter is required' });
      }
      if (!isString(patch) || !patch.trim()) {
        return res.status(400).json({ error: 'patch is required' });
      }
      if (action !== 'stage' && action !== 'unstage' && action !== 'discard') {
        return res.status(400).json({ error: 'action must be stage, unstage, or discard' });
      }

      await applyHunk(directory, filePath, { patch, action });
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to apply git hunk:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to apply git hunk' });
    }
  });

  app.post('/api/git/pull', async (req, res) => {
    const directory = req.query.directory;
    if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
    await rejectLegacyNetworkOperation(directory, res);
  });

  app.post('/api/git/push', async (req, res) => {
    const directory = req.query.directory;
    if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
    await rejectLegacyNetworkOperation(directory, res);
  });

  app.get('/api/git/stashes', async (req, res) => {
    const { listStashes } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
      res.json({ stashes: await listStashes(directory) });
    } catch (error) {
      console.error('Failed to list stashes:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to list stashes' });
    }
  });

  app.post('/api/git/stashes/file-counts', async (req, res) => {
    const { countStashFiles } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
      res.json({ counts: await countStashFiles(directory, fieldsOf(req.body)?.refs) });
    } catch (error) {
      console.error('Failed to count stash files:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to count stash files' });
    }
  });

  app.post('/api/git/stash', async (req, res) => {
    const { stashPush } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await stashPush(directory, fieldsOf(req.body)));
    } catch (error) {
      console.error('Failed to stash changes:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to stash changes' });
    }
  });

  app.post('/api/git/stash/apply', async (req, res) => {
    const { stashApply } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await stashApply(directory, fieldsOf(req.body)));
    } catch (error) {
      console.error('Failed to apply stash:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to apply stash' });
    }
  });

  app.post('/api/git/stash/pop', async (req, res) => {
    const { stashPop } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await stashPop(directory, fieldsOf(req.body)));
    } catch (error) {
      console.error('Failed to pop stash:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to pop stash' });
    }
  });

  app.post('/api/git/stash/drop', async (req, res) => {
    const { stashDrop } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
      res.json(await stashDrop(directory, fieldsOf(req.body)));
    } catch (error) {
      console.error('Failed to drop stash:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to drop stash' });
    }
  });

  app.post('/api/git/fetch', async (req, res) => {
    const directory = req.query.directory;
    if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
    await rejectLegacyNetworkOperation(directory, res);
  });

  app.get('/api/git/remotes', async (req, res) => {
    const { getRemotes, getRepositoryRemoteUrls } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const [remotes, addresses] = await Promise.all([getRemotes(directory), getRepositoryRemoteUrls(directory)]);
      const onDisk = new Set(addresses
        .filter((remote) => isDiskPathRemoteUrl(remote.fetchUrl) || isDiskPathRemoteUrl(remote.pushUrl))
        .map((remote) => remote.name));
      res.json(remotes.filter((remote) => !onDisk.has(remote.name)).map(toGitRemoteSummary));
    } catch (error) {
      console.error('Failed to get remotes:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get remotes' });
    }
  });

  app.delete('/api/git/remotes', async (req, res) => {
    const { removeRemote } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const remote = String(fieldsOf(req.body)?.remote || '').trim();
      if (!remote) {
        return res.status(400).json({ error: 'remote is required' });
      }

      const result = await removeRemote(directory, { remote });
      res.json(result);
    } catch (error) {
      console.error('Failed to remove remote:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to remove remote' });
    }
  });

  app.post('/api/git/change-id', userAction(async (req, res) => {
    const directory = resolveDirectoryQuery(req.query?.directory);
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    try {
      const { addChangeIdToHead } = await import('../source-control/change-id.js');
      const { sha, changeId, branch } = await addChangeIdToHead(directory, fieldsOf(req.body)?.expectedHead);
      onBranchRewritten?.({ directory, branch });
      return res.json({ sha, changeId });
    } catch (error) {
      const status = statusOf(error);
      if (status !== undefined && status < 500) return res.status(status).json({ error: messageOf(error), code: errorFields(error)?.code });
      console.error('Failed to add a Change-Id:', messageOf(error));
      return res.status(500).json({ error: 'Failed to add a Change-Id', code: errorFields(error)?.code ?? 'CHANGE_ID_FAILED' });
    }
  }));

  app.post('/api/git/rebase', userAction(async (req, res) => {
    const { rebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const onto = textOf(fieldsOf(req.body)?.onto);
      const result = await rebase(directory, onto === undefined ? {} : { onto });
      res.json(result);
    } catch (error) {
      console.error('Failed to rebase:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to rebase' });
    }
  }));

  app.post('/api/git/rebase/abort', async (req, res) => {
    const { abortRebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await abortRebase(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to abort rebase:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to abort rebase' });
    }
  });

  app.post('/api/git/merge', userAction(async (req, res) => {
    const { merge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const branch = textOf(fieldsOf(req.body)?.branch);
      const result = await merge(directory, branch === undefined ? {} : { branch });
      res.json(result);
    } catch (error) {
      console.error('Failed to merge:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to merge' });
    }
  }));

  app.post('/api/git/merge/abort', async (req, res) => {
    const { abortMerge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await abortMerge(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to abort merge:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to abort merge' });
    }
  });

  app.post('/api/git/rebase/continue', userAction(async (req, res) => {
    const { continueRebase } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await continueRebase(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to continue rebase:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to continue rebase' });
    }
  }));

  app.post('/api/git/merge/continue', userAction(async (req, res) => {
    const { continueMerge } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await continueMerge(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to continue merge:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to continue merge' });
    }
  }));

  app.get('/api/git/conflict-details', async (req, res) => {
    const { getConflictDetails } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const result = await getConflictDetails(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to get conflict details:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get conflict details' });
    }
  });

  app.post('/api/git/commit', userAction(async (req, res) => {
    const { commit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { message, addAll, files, stageFiles } = requiredFields(req.body);
      if (!message || !isString(message)) {
        return res.status(400).json({ error: 'message is required' });
      }

      const result = await commit(directory, message, {
        addAll,
        files,
        stageFiles,
      });
      res.json(result);
    } catch (error) {
      console.error('Failed to commit:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to create commit' });
    }
  }));

  app.get('/api/git/branches', async (req, res) => {
    const { getBranches } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const branches = await getBranches(directory, { remote: req.query.remote === 'live' ? 'live' : 'local' });
      res.json(branches);
    } catch (error) {
      console.error('Failed to get branches:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get branches' });
    }
  });

  app.post('/api/git/branch-push-status', async (req, res) => {
    const { getUnpushedBranchCounts } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      const branches = fieldsOf(req.body)?.branches;
      if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
      const branchNames: unknown[] = Array.isArray(branches) ? branches : [];
      if (!Array.isArray(branches) || !branchNames.every(isString)) {
        return res.status(400).json({ error: 'branches must be an array of branch names' });
      }
      res.json(await getUnpushedBranchCounts(directory, branchNames));
    } catch (error) {
      console.error('Failed to get branch push status:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get branch push status' });
    }
  });

  app.post('/api/git/branches', userAction(async (req, res) => {
    const { createBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { name, startPoint } = requiredFields(req.body);
      if (!name || !isString(name)) {
        return res.status(400).json({ error: 'name is required' });
      }

      const branchStart = textOf(startPoint);
      const result = await createBranch(directory, name, branchStart === undefined ? {} : { startPoint: branchStart });
      res.json(result);
    } catch (error) {
      console.error('Failed to create branch:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to create branch' });
    }
  }));

  app.delete('/api/git/branches', async (req, res) => {
    const { deleteBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch, force } = requiredFields(req.body);
      if (!branch || !isString(branch)) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await deleteBranch(directory, branch, { force });
      res.json(result);
    } catch (error) {
      console.error('Failed to delete branch:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to delete branch' });
    }
  });

  app.put('/api/git/branches/rename', async (req, res) => {
    const { renameBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { oldName, newName } = requiredFields(req.body);
      if (!oldName || !isString(oldName)) {
        return res.status(400).json({ error: 'oldName is required' });
      }
      if (!newName || !isString(newName)) {
        return res.status(400).json({ error: 'newName is required' });
      }

      const result = await renameBranch(directory, oldName, newName);
      res.json(result);
    } catch (error) {
      if (errorFields(error)?.statusCode === 409) {
        return res.status(409).json({ error: messageOf(error) });
      }
      console.error('Failed to rename branch:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to rename branch' });
    }
  });
  app.delete('/api/git/remote-branches', async (req, res) => {
    const directory = req.query.directory;
    if (!directory || !isString(directory)) return res.status(400).json({ error: 'directory parameter is required' });
    await rejectLegacyNetworkOperation(directory, res);
  });

  app.post('/api/git/checkout', userAction(async (req, res) => {
    const { checkoutBranch } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const { branch } = requiredFields(req.body);
      if (!branch || !isString(branch)) {
        return res.status(400).json({ error: 'branch is required' });
      }

      const result = await checkoutBranch(directory, branch);
      res.json(result);
    } catch (error) {
      console.error('Failed to checkout branch:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to checkout branch' });
    }
  }));

  app.post('/api/git/checkout-commit', userAction(async (req, res) => {
    const { checkoutCommit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = requiredFields(req.body);
      if (!hash || !isString(hash) || !/^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await checkoutCommit(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to checkout commit:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to checkout commit' });
    }
  }));

  app.post('/api/git/cherry-pick', userAction(async (req, res) => {
    const { cherryPick } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = requiredFields(req.body);
      if (!hash || !isString(hash) || !/^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await cherryPick(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to cherry-pick:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to cherry-pick' });
    }
  }));

  app.post('/api/git/revert-commit', userAction(async (req, res) => {
    const { revertCommit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash } = requiredFields(req.body);
      if (!hash || !isString(hash) || !/^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      const result = await revertCommit(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to revert commit:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to revert commit' });
    }
  }));

  app.post('/api/git/reset-to-commit', async (req, res) => {
    const { resetToCommit } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const { hash, mode, force } = requiredFields(req.body);
      if (!hash || !isString(hash) || !/^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return res.status(400).json({ error: 'Invalid commit hash' });
      }
      if (!isResetMode(mode)) {
        return res.status(400).json({ error: 'mode must be soft, mixed, or hard' });
      }
      const result = await resetToCommit(directory, hash, mode, force === true);
      res.json(result);
    } catch (error) {
      console.error('Failed to reset to commit:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to reset' });
    }
  });

  app.get('/api/git/worktrees', async (req, res) => {
    const { getWorktrees, observeWorktreeTopology } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const worktrees = await enrichWorktreeProvenance(await getWorktrees(directory));
      if (worktrees.length > 0) {
        void observeWorktreeTopology(directory);
      }
      res.json(worktrees);
    } catch (error) {
      if (errorFields(error)?.code === 'CONTRIBUTOR_PROVENANCE_STORE_INVALID') {
        return res.status(500).json({ error: 'Failed to verify contributor worktree provenance', code: 'UNKNOWN' });
      }
      console.error('Failed to get worktrees:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get worktrees' });
    }
  });

  app.put('/api/git/worktrees/title', userAction(async (req, res) => {
    const { setLinkedTaskTitle } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const body = worktreeTitleBodySchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: 'title must be a string' });
      }
      res.json(await setLinkedTaskTitle(directory, body.data));
    } catch (error) {
      console.error('Failed to set the worktree task title:', error);
      res.status(statusOf(error) ?? 500).json({ error: messageOf(error) || 'Failed to set the task title' });
    }
  }));

  app.put('/api/git/worktrees/pin', userAction(async (req, res) => {
    const { setWorktreePinned } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const body = worktreePinBodySchema.safeParse(req.body);
      if (!body.success) {
        return res.status(400).json({ error: 'pinned must be a boolean' });
      }
      res.json(await setWorktreePinned(directory, body.data.pinned, body.data.list ?? null));
    } catch (error) {
      console.error('Failed to pin the worktree:', error);
      res.status(statusOf(error) ?? 500).json({ error: messageOf(error) || 'Failed to pin the worktree' });
    }
  }));

  app.post('/api/git/worktrees/validate', async (req, res) => {
    const { validateWorktreeCreate } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      if (hasClientContributorAuthority(req.body || {})) {
        return res.status(400).json({ error: 'Invalid contributor worktree request', code: 'INVALID_CONTRIBUTOR_WORKTREE' });
      }
      const input = await worktreeCreation.validationInput(directory, req.body || {});
      const result = await validateWorktreeCreate(directory, input, { bootstrapStore: worktreeBootstrapStore });
      res.json(result);
    } catch (error) {
      if (error instanceof WorktreeCreationError) {
        return res.status(error.status).json({ error: messageOf(error), code: errorFields(error)?.code });
      }
      console.error('Failed to validate worktree creation:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to validate worktree creation' });
    }
  });

  app.post('/api/git/worktrees', userAction(async (req, res) => {
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      res.json(await worktreeCreation.create(directory, req.body || {}));
    } catch (error) {
      if (error instanceof WorktreeCreationError) {
        const { remoteName } = errorFields(error) ?? {};
        const body: WorktreeCreationErrorBody = { error: messageOf(error), code: errorFields(error)?.code };
        if (remoteName !== undefined) body.remoteName = remoteName;
        return res.status(error.status).json(body);
      }
      console.error('Failed to create worktree:', error);
      res.status(statusOf(error) ?? 500).json({
        error: messageOf(error) || 'Failed to create worktree',
        code: errorFields(error)?.code,
      });
    }
  }));

  app.post('/api/git/worktrees/preview', async (req, res) => {
    const { previewWorktreeCreate } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const preview = await previewWorktreeCreate(directory, req.body || {});
      res.json(preview);
    } catch (error) {
      console.error('Failed to preview worktree:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to preview worktree' });
    }
  });

  app.get('/api/git/worktrees/bootstrap-status', async (req, res) => {
    const { getWorktreeBootstrapStatus } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!(worktreeBootstrapStore?.read instanceof Function)
        || !(worktreeBootstrapStore?.write instanceof Function)) {
        return res.status(501).json({ error: 'Worktree bootstrap storage is not available' });
      }

      const status = await getWorktreeBootstrapStatus(directory, { bootstrapStore: worktreeBootstrapStore });
      res.json(status);
    } catch (error) {
      console.error('Failed to get worktree bootstrap status:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get worktree bootstrap status' });
    }
  });

  app.delete('/api/git/worktrees', userAction(async (req, res) => {
    const { removeWorktree } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const worktreeDirectory = textOf(fieldsOf(req.body)?.directory) ?? '';
      if (!worktreeDirectory) {
        return res.status(400).json({ error: 'worktree directory is required' });
      }
      if (!(worktreeBootstrapStore?.remove instanceof Function)) {
        return res.status(501).json({ error: 'Worktree bootstrap storage is not available' });
      }

      const result = await removeWorktree(directory, {
        directory: worktreeDirectory,
        deleteLocalBranch: fieldsOf(req.body)?.deleteLocalBranch === true,
        teardownCommand: z.string().safeParse(fieldsOf(req.body)?.teardownCommand).data,
        isContributorCheckout,
        disposeInstance: instanceDisposer(),
      }, {
        bootstrapStore: worktreeBootstrapStore,
      });
      res.json({ success: Boolean(result) });
    } catch (error) {
      console.error('Failed to remove worktree:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to remove worktree', code: worktreeTeardownCodeOf(error) });
    }
  }));

  app.post('/api/git/worktrees/teardown', userAction(async (req, res) => {
    const { teardownWorktree } = await getGitLibraries();
    const directory = resolveDirectoryQuery(req.query.directory);
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    const worktreeDirectory = z.string().min(1).safeParse(fieldsOf(req.body)?.directory).data;
    if (!worktreeDirectory) return res.status(400).json({ error: 'worktree directory is required' });
    try {
      await teardownWorktree(directory, {
        directory: worktreeDirectory,
        teardownCommand: z.string().safeParse(fieldsOf(req.body)?.teardownCommand).data,
        isContributorCheckout,
      });
      res.json({ success: true });
    } catch (error) {
      console.error('Failed to tear down worktree:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to tear down worktree', code: worktreeTeardownCodeOf(error) });
    }
  }));

  app.post('/api/git/worktrees/snapshot', async (req, res) => {
    const { snapshotWorktree } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      if (!directory) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      res.json(await snapshotWorktree(directory, { ref: fieldsOf(req.body)?.ref }));
    } catch (error) {
      console.error('Failed to snapshot worktree:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to snapshot worktree' });
    }
  });

  const ARCHIVE_ERROR_STATUS = new Map<unknown, number>([
    ['WORKTREE_ARCHIVE_NOT_FOUND', 404],
    ['WORKTREE_ARCHIVE_IN_PROGRESS', 409],
    ['WORKTREE_ARCHIVE_NOT_APPLIED', 409],
  ]);
  const sendArchiveError = <Cause>(res: Response, error: Cause, fallback: string) => {
    const status = ARCHIVE_ERROR_STATUS.get(errorFields(error)?.code) ?? 500;
    if (status === 500) console.error(`${fallback}:`, error);
    res.status(status).json({ error: messageOf(error) || fallback, code: errorFields(error)?.code });
  };

  app.get('/api/git/worktrees/archives', async (req, res) => {
    const { listWorktreeArchives } = await getGitLibraries();
    const directory = resolveDirectoryQuery(req.query.directory);
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    try {
      res.json({ archives: await listWorktreeArchives(directory) });
    } catch (error) {
      sendArchiveError(res, error, 'Failed to list worktree archives');
    }
  });

  app.post('/api/git/worktrees/archives', userAction(async (req, res) => {
    const { archiveWorktree } = await getGitLibraries();
    const directory = resolveDirectoryQuery(req.query.directory);
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    const worktreeDirectory = z.string().min(1).safeParse(fieldsOf(req.body)?.directory).data;
    if (!worktreeDirectory) return res.status(400).json({ error: 'worktree directory is required' });
    if (!(worktreeBootstrapStore?.remove instanceof Function)) {
      return res.status(501).json({ error: 'Worktree bootstrap storage is not available' });
    }
    try {
      res.json(await archiveWorktree(directory, {
        directory: worktreeDirectory,
        id: fieldsOf(req.body)?.id,
        sessionIds: fieldsOf(req.body)?.sessionIds,
        title: fieldsOf(req.body)?.title,
        disposeInstance: instanceDisposer(),
      }, { bootstrapStore: worktreeBootstrapStore }));
    } catch (error) {
      sendArchiveError(res, error, 'Failed to archive worktree');
    }
  }));

  app.post('/api/git/worktrees/archives/restore', userAction(async (req, res) => {
    const { restoreWorktreeArchive } = await getGitLibraries();
    const directory = resolveDirectoryQuery(req.query.directory);
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    try {
      res.json(await restoreWorktreeArchive(directory, { id: fieldsOf(req.body)?.id }));
    } catch (error) {
      sendArchiveError(res, error, 'Failed to restore worktree archive');
    }
  }));

  app.delete('/api/git/worktrees/archives', userAction(async (req, res) => {
    const { deleteWorktreeArchive } = await getGitLibraries();
    const directory = resolveDirectoryQuery(req.query.directory);
    if (!directory) return res.status(400).json({ error: 'directory parameter is required' });
    try {
      res.json(await deleteWorktreeArchive(directory, { id: fieldsOf(req.body)?.id, deleteBranch: fieldsOf(req.body)?.deleteBranch === true }));
    } catch (error) {
      sendArchiveError(res, error, 'Failed to delete worktree archive');
    }
  }));

  app.get('/api/git/worktree-type', async (req, res) => {
    const { isLinkedWorktree } = await getGitLibraries();
    try {
      const { directory } = req.query;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      const linked = await isLinkedWorktree(directory);
      res.json({ linked });
    } catch (error) {
      console.error('Failed to determine worktree type:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to determine worktree type' });
    }
  });

  app.post('/api/git/validate-directory', async (req, res) => {
    const { validateWorktreeDirectory } = await getGitLibraries();
    try {
      const { directory, worktreeRoot } = fieldsOf(req.body) ?? {};
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory is required' });
      }
      if (!worktreeRoot || !isString(worktreeRoot)) {
        return res.status(400).json({ error: 'worktreeRoot is required' });
      }
      const result = await validateWorktreeDirectory(directory, worktreeRoot);
      res.json(result);
    } catch (error) {
      console.error('Failed to validate worktree directory:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to validate worktree directory' });
    }
  });

  app.post('/api/git/canonicalize-worktree-state', async (req, res) => {
    const { canonicalizeWorktreeState } = await getGitLibraries();
    try {
      const { directory } = fieldsOf(req.body) ?? {};
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory is required' });
      }
      const result = await canonicalizeWorktreeState(directory);
      res.json(result);
    } catch (error) {
      console.error('Failed to canonicalize worktree state:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to canonicalize worktree state' });
    }
  });

  app.get('/api/git/log', async (req, res) => {
    const { getLog } = await getGitLibraries();
    try {
      const directory = req.query.directory;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }

      const maxCount = textOf(req.query.maxCount);
      const all = req.query.all === 'true';
      const log = await getLog(directory, {
        maxCount: maxCount ? parseInt(maxCount) : undefined,
        from: textOf(req.query.from),
        to: textOf(req.query.to),
        file: textOf(req.query.file),
        all
      });
      res.json(log);
    } catch (error) {
      if (errorFields(error)?.code === 'revision_not_found') {
        return res.status(404).json({ error: messageOf(error), code: errorFields(error)?.code });
      }
      console.error('Failed to get log:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get commit log' });
    }
  });

  app.get('/api/git/commit-files', async (req, res) => {
    const { getCommitFiles } = await getGitLibraries();
    try {
      const { directory, hash } = req.query;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!hash) {
        return res.status(400).json({ error: 'hash parameter is required' });
      }

      const result = await getCommitFiles(directory, hash);
      res.json(result);
    } catch (error) {
      console.error('Failed to get commit files:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get commit files' });
    }
  });

  app.get('/api/git/commit-diff', async (req, res) => {
    const { getCommitDiff } = await getGitLibraries();
    try {
      const directory = resolveDirectoryQuery(req.query.directory);
      const hash = resolveDirectoryQuery(req.query.hash);
      if (!directory || !hash) return res.status(400).json({ error: 'directory and hash are required' });
      const context = Number(req.query.context ?? 3);
      const diff = await getCommitDiff(directory, {
        hash,
        path: resolveDirectoryQuery(req.query.path, true) ?? undefined,
        previousPath: resolveDirectoryQuery(req.query.previousPath, true) ?? undefined,
        contextLines: Number.isFinite(context) ? context : 3,
      });
      res.json({ diff });
    } catch (error) {
      res.status(500).json({ error: messageOf(error) || 'Failed to get commit diff' });
    }
  });

  app.get('/api/git/commit-file-diff', async (req, res) => {
    const { getCommitFileDiff } = await getGitLibraries();
    try {
      const { directory, hash, path: filePath } = req.query;
      if (!directory || !isString(directory)) {
        return res.status(400).json({ error: 'directory parameter is required' });
      }
      if (!hash || !isString(hash)) {
        return res.status(400).json({ error: 'hash parameter is required' });
      }
      if (!/^[0-9a-fA-F]{7,40}$/.test(hash)) {
        return res.status(400).json({ error: 'hash must be a valid commit SHA' });
      }
      if (!filePath || !isString(filePath)) {
        return res.status(400).json({ error: 'path parameter is required' });
      }

      const isBinary = req.query.binary === 'true';
      const result = await getCommitFileDiff(directory, hash, filePath, isBinary, String(req.query.previousPath ?? '') || undefined);
      res.json(result);
    } catch (error) {
      console.error('Failed to get commit file diff:', error);
      res.status(500).json({ error: messageOf(error) || 'Failed to get commit file diff' });
    }
  });

  return { createWorktree: worktreeCreation.create, createWorktreeInstanceDisposer };
}
