import { z } from 'zod';
import type {
  GitStatus,
  GitDiffResponse,
  GetGitDiffOptions,
  GetGitRangeDiffOptions,
  GetGitRangeFilesOptions,
  GetGitCommitDiffOptions,
  GitFileDiffResponse,
  GitPathDiffResponse,
  GetGitFileDiffOptions,
  GitBranch,
  GitUnpushedBranchCounts,
  GitDeleteBranchPayload,
  GitRemoveRemotePayload,
  GeneratedCommitMessage,
  GitWorktreeInfo,
  CreateGitWorktreePayload,
  GitWorktreeCreateResult,
  RemoveGitWorktreePayload,
  GitWorktreeValidationResult,
  CreateGitCommitOptions,
  GitCommitResult,
  GitPushResult,
  GitPullResult,
  GitPullOptions,
  GitNetworkOperation,
  GitNetworkOperationPlan,
  GitNetworkOperationRequest,
  GitCheckoutHydrationStatus,
  GitContributorDestinationRequest,
  GitContributorDestinationSelection,
  GitContributorDestinationCandidates,
  GitCheckoutTrustInspection,
  GitStashEntry,
  GitLogOptions,
  GitLogResponse,
  GitCommitFilesResponse,
  CommitFileDiffResponse,
  GitIdentityProfile,
  GitIdentitySummary,
  GitRemote,
  MergeConflictDetails,
  CheckoutCommitResponse,
  CherryPickResponse,
  RevertCommitResponse,
  ResetToCommitResponse,
} from './api/types';
import { GitNetworkOperationRequestError, GitWorktreeRequestError } from './api/types';
import {
  gitIdentityMutationResultSchema,
  gitIdentityProfileSchema,
  gitIdentityProfilesSchema,
  gitIdentitySummarySchema,
} from './api/git-identity';
import { normalizePath } from './pathNormalization';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { getRuntimeKey } from './runtime-switch';
import { notifyGitStatusInvalidated, subscribeGitStatusInvalidations } from './gitStatusInvalidation';
import { notifyGitPush } from './gitPushEvents';
import { GitPathUnavailableError, gitPathUnavailableBodySchema, gitSubmoduleStateSchema } from './api/git-path-diff';

const API_BASE = '/api/git';
const gitRangeDiffSchema = z.object({ diff: z.string() });
const gitRangeFilesSchema = z.object({ files: z.array(z.object({ path: z.string(), status: z.string() })) });
const gitRangeErrorSchema = z.object({ error: z.string() });
const gitCommitFilesSchema = z.object({ files: z.array(z.object({
  path: z.string(), previousPath: z.string().optional(), changeType: z.string(),
  insertions: z.number(), deletions: z.number(), isBinary: z.boolean(),
})) });
const gitLogEntrySchema = z.object({
  hash: z.string(), date: z.string(), message: z.string(), refs: z.string(), body: z.string(),
  author_name: z.string(), author_email: z.string(), filesChanged: z.number(),
  insertions: z.number(), deletions: z.number(), parents: z.array(z.string()),
});
const gitLogSchema = z.object({ all: z.array(gitLogEntrySchema), latest: gitLogEntrySchema.nullable(), total: z.number() });

// Servers before #3586 send no `submodule`; that means "not known to be one".
const gitPathDiffSchema = z.object({ diff: z.string(), submodule: gitSubmoduleStateSchema.nullable().default(null) });
const gitFileDiffSchema = z.object({
  original: z.string(),
  modified: z.string(),
  path: z.string(),
  isBinary: z.boolean().optional(),
  submodule: gitSubmoduleStateSchema.nullable().default(null),
});

async function pathDiffResponseError(response: Response, fallback: string): Promise<Error> {
  const parsed = gitPathUnavailableBodySchema.safeParse(await response.json().catch(() => null));
  if (parsed.success && (response.status === 404 || response.status === 422)) {
    return new GitPathUnavailableError(parsed.data.error, parsed.data.code);
  }
  return new Error(`${fallback}: ${response.statusText}`);
}

async function rangeResponseError(response: Response, fallback: string): Promise<Error> {
  const parsed = gitRangeErrorSchema.safeParse(await response.json().catch(() => null));
  return new Error(parsed.success ? parsed.data.error : `${fallback}: ${response.statusText}`);
}
const GIT_STATUS_CACHE_TTL_MS = 1200;
const GIT_REPO_CHECK_CACHE_TTL_MS = 5000;
const gitStatusCache = new Map<string, { value: GitStatus; expiresAt: number }>();
const gitStatusInFlight = new Map<string, Promise<GitStatus>>();
const gitStatusCacheVersions = new Map<string, number>();
const gitRepoCache = new Map<string, { value: boolean; expiresAt: number }>();
const gitRepoInFlight = new Map<string, Promise<boolean>>();
const NETWORK_OPERATION_TRACKING_MAX_ENTRIES = 256;
const NETWORK_OPERATION_ACTIVE_RETENTION_MS = 15 * 60 * 1000;
const NETWORK_OPERATION_TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const NETWORK_OPERATION_ERROR_MESSAGE_MAX_CHARS = 8192;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SSH_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}=?$/;
const boundedString = (max: number) => z.string().trim().min(1).max(max);
const operationIdSchema = z.string().regex(OPERATION_ID_PATTERN);
const fingerprintSchema = z.string().regex(FINGERPRINT_PATTERN);
const refSchema = boundedString(1024);
const endpointSchema = boundedString(4096);
const identityStringSchema = boundedString(512);
const checkoutPathSchema = z.string().min(1).max(4096).refine((value) => value.trim() === value
  && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) && value !== '..'
  && !value.startsWith('/') && !value.startsWith('../') && !value.includes('/../')
  && !value.includes('\\') && !/^[A-Za-z]:\//.test(value), 'Checkout path must be repository-relative');
const remoteDisplayUrlSchema = z.string().max(4096).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash;
  } catch {
    if (value.includes('://')) return false;
    return !/[?#]/.test(value);
  }
}, 'Git remote display URLs must not contain credentials, query parameters, or fragments');
export const gitRemoteListSchema = z.array(z.object({
  name: identityStringSchema,
  fetchUrl: remoteDisplayUrlSchema,
  pushUrl: remoteDisplayUrlSchema,
}).strict()).max(256);
const contributorDestinationSchema = z.object({
  selectionId: operationIdSchema,
  provenanceRevision: z.number().int().safe().positive(),
  sourceSha: z.string().regex(SHA_PATTERN),
  expiresInMs: z.number().int().safe().positive().max(15 * 60 * 1000),
}).strict();
const contributorDestinationCandidateSchema = z.object({
  remote: z.object({ name: identityStringSchema, endpoint: z.object({
    displayUrl: endpointSchema, fingerprint: fingerprintSchema,
  }).strict() }).strict(),
  transportMode: z.literal('managed'),
  classification: z.enum(['contributor-fork', 'own-fork', 'bound-repository', 'other']),
}).strict();
const contributorDestinationCandidatesSchema = z.discriminatedUnion('kind', [z.object({
  kind: z.literal('ordinary'),
}).strict(), z.object({
  kind: z.literal('contributor'),
  repositoryId: identityStringSchema,
  bindingRevision: z.number().int().safe().positive(),
  configRevision: identityStringSchema,
  provenanceRevision: z.number().int().safe().positive(),
  candidates: z.array(contributorDestinationCandidateSchema).max(128),
}).strict()]);
const checkoutTrustSchema = z.object({
  state: z.literal('awaiting-trust'),
  digest: fingerprintSchema,
  actions: z.array(z.object({
    kind: z.enum(['post-checkout-hook', 'project-start-command', 'setup-command']),
    label: z.string().max(65536),
  }).strict()).max(3),
}).strict();

type NetworkOperationTracking = {
  operationId: string;
  runtimeKey: string;
  directory: string;
  runtimeIdentity: GitNetworkOperation['runtimeIdentity'];
  transport: GitNetworkOperation['transport'];
  target: GitNetworkOperation['target'];
  observedAt: number;
  terminalState?: Exclude<GitNetworkOperation['state'], 'planned' | 'running'>;
};

const networkOperationTracking = new Map<string, NetworkOperationTracking>();

const isSafeDisplayEndpoint = (value: string): boolean => {
  if (!value.includes('://')) {
    const match = value.match(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:([^\s:\\]+)$/);
    return Boolean(match && !/[?#]/.test(value) && !match[1].startsWith('-')
      && match[1].split('/').every((part) => part && part !== '.' && part !== '..'));
  }
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    return (url.protocol === 'https:' || url.protocol === 'ssh:')
      && !url.username && !url.password && !url.search && !url.hash
      && Boolean(url.hostname && url.pathname && url.pathname !== '/')
      && !/[\0-\x20\x7f\\]/.test(pathname)
      && pathname.split('/').slice(1).every((part) => part && part !== '.' && part !== '..');
  } catch {
    return false;
  }
};

const redactedEndpointSchema = z.object({
  displayUrl: endpointSchema.refine(isSafeDisplayEndpoint),
  fingerprint: fingerprintSchema,
}).strict();
const redactedDestinationSchema = z.object({
  displayName: boundedString(1024),
  fingerprint: fingerprintSchema,
}).strict();
const runtimeIdentitySchema = z.object({
  id: identityStringSchema,
  platform: z.enum(['web', 'desktop', 'vscode']),
  label: boundedString(512).optional(),
}).strict();
const transportActorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('provider'),
    provider: identityStringSchema,
    instance: endpointSchema,
    accountId: identityStringSchema,
    login: identityStringSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('ssh-key'),
    fingerprint: z.string().regex(SSH_FINGERPRINT_PATTERN),
  }).strict(),
]);
const transportSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('anonymous'),
    verification: z.object({ status: z.literal('anonymous') }).strict(),
  }).strict(),
  z.object({
    mode: z.literal('managed'),
    verification: z.object({
      status: z.literal('verified'),
      method: z.enum(['credential', 'git-identity']),
    }).strict(),
    actor: transportActorSchema.optional(),
  }).strict(),
  z.object({
    mode: z.literal('system'),
    verification: z.object({
      status: z.literal('unverified'),
      reason: z.literal('system-credentials'),
    }).strict(),
  }).strict(),
]);
const operationTransportSchema = z.union([
  transportSchema,
  z.object({ fetch: transportSchema, push: transportSchema }).strict(),
]);
const remoteTargetSchema = z.object({
  name: identityStringSchema,
  endpoint: redactedEndpointSchema,
}).strict();
const existingTargetFields = {
  repositoryId: identityStringSchema,
  bindingRevision: z.number().int().safe().positive(),
  configRevision: identityStringSchema,
  remote: remoteTargetSchema,
  sourceRef: refSchema,
  destinationRef: refSchema,
};
const targetSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('push'),
    ...existingTargetFields,
    forceWithLease: z.object({ expectedRemoteSha: z.string().regex(SHA_PATTERN) }).strict().optional(),
    configureUpstream: z.boolean().optional(),
  }).strict(),
  z.discriminatedUnion('fetchScope', [
    z.object({ operation: z.literal('fetch'), fetchScope: z.literal('ref').optional(), ...existingTargetFields }).strict(),
    z.object({
      operation: z.literal('fetch'),
      fetchScope: z.literal('remote'),
      repositoryId: identityStringSchema,
      bindingRevision: z.number().int().safe().positive(),
      configRevision: identityStringSchema,
      remote: remoteTargetSchema,
      force: z.boolean(),
    }).strict(),
  ]),
  z.object({ operation: z.literal('pull'), ...existingTargetFields }).strict(),
  z.object({
    operation: z.literal('delete-remote-branch'),
    repositoryId: identityStringSchema,
    bindingRevision: z.number().int().safe().positive(),
    configRevision: identityStringSchema,
    remote: remoteTargetSchema,
    destinationRef: refSchema,
  }).strict(),
  z.object({
    operation: z.literal('checkout-hydration'),
    repositoryId: identityStringSchema,
    bindingRevision: z.number().int().safe().positive(),
    configRevision: identityStringSchema,
    remote: remoteTargetSchema,
    requirements: z.array(z.object({
      kind: z.enum(['submodule', 'lfs']),
      path: checkoutPathSchema,
      endpoint: redactedEndpointSchema,
    }).strict()).max(256),
  }).strict(),
  z.object({
    operation: z.literal('sync'),
    repositoryId: identityStringSchema,
    bindingRevision: z.number().int().safe().positive(),
    configRevision: identityStringSchema,
    fetch: z.object({
      name: identityStringSchema,
      endpoint: redactedEndpointSchema,
      sourceRef: refSchema,
      destinationRef: refSchema,
    }).strict(),
    pull: z.object({ destinationRef: refSchema }).strict(),
    push: z.object({
      name: identityStringSchema,
      endpoint: redactedEndpointSchema,
      sourceRef: refSchema,
      destinationRef: refSchema,
      forceWithLease: z.object({ expectedRemoteSha: z.string().regex(SHA_PATTERN) }).strict().optional(),
    }).strict(),
  }).strict(),
  z.object({
    operation: z.literal('clone'),
    remote: redactedEndpointSchema,
    destination: redactedDestinationSchema,
  }).strict(),
]);
const completedStepSchema = z.enum([
  'validated',
  'authenticated',
  'transferred',
  'updated-local-repository',
  'checked-out',
  'cleaned-up',
]);
const operationErrorCodeSchema = z.enum([
    'INVALID_REQUEST',
    'NOT_FOUND',
    'STALE_REPOSITORY',
    'STALE_BINDING',
    'STALE_CONFIG',
    'REMOTE_CHANGED',
    'AUTHENTICATION_REQUIRED',
    'ACKNOWLEDGEMENT_REQUIRED',
    'DESTINATION_SELECTION_REQUIRED',
    'CONTRIBUTOR_MANAGED_TRANSPORT_REQUIRED',
    'AUTHENTICATION_FAILED',
    'TRANSPORT_FAILED',
    'CONFLICT',
    'CANCELLED',
    'TIMEOUT',
    'OUTCOME_UNKNOWN',
    'RUNTIME_UNSUPPORTED',
    'GIT_LFS_CLIENT_MISSING',
    'UNKNOWN',
  ]);
const operationErrorSchema = <const Code extends readonly [string, ...string[]]>(codes: Code) => z.object({
  code: z.enum(codes),
  message: boundedString(NETWORK_OPERATION_ERROR_MESSAGE_MAX_CHARS),
}).strict();
const syncStepResultSchema = z.object({
  step: z.enum(['fetch', 'pull', 'push']),
  status: z.enum(['succeeded', 'skipped', 'conflicted', 'failed', 'cancelled']),
  error: z.object({
    code: operationErrorCodeSchema,
    message: boundedString(NETWORK_OPERATION_ERROR_MESSAGE_MAX_CHARS),
  }).strict().optional(),
}).strict();
const hydrationStatusSchema = z.enum([
  'succeeded', 'authorization-required', 'invalid', 'client-missing', 'failed', 'cancelled', 'not-needed',
]);
const hydrationFailurePriority: GitCheckoutHydrationStatus[] = [
  'cancelled', 'invalid', 'client-missing', 'authorization-required', 'failed',
];
const hydrationPartSchema = z.object({
  path: checkoutPathSchema,
  status: hydrationStatusSchema,
  endpoint: redactedEndpointSchema.optional(),
  error: z.object({
    code: operationErrorCodeSchema,
    message: boundedString(NETWORK_OPERATION_ERROR_MESSAGE_MAX_CHARS),
  }).strict().optional(),
}).strict().superRefine((part, context) => {
  const needsError = part.status !== 'succeeded' && part.status !== 'not-needed';
  if (needsError !== (part.error !== undefined)) {
    context.addIssue({ code: 'custom', message: 'Git hydration status and error do not match' });
  }
});
const hydrationSchema = z.object({
  status: hydrationStatusSchema,
  submodules: z.array(hydrationPartSchema).max(256),
  lfs: z.array(hydrationPartSchema).max(256),
}).strict().superRefine((hydration, context) => {
  const statuses = [...hydration.submodules, ...hydration.lfs].map((part) => part.status);
  let expected = 'succeeded';
  if (!statuses.length || statuses.every((status) => status === 'not-needed')) expected = 'not-needed';
  else {
    expected = hydrationFailurePriority.find((status) => statuses.includes(status)) ?? 'succeeded';
  }
  if (hydration.status !== expected) {
    context.addIssue({ code: 'custom', message: 'Git hydration summary does not match its results' });
  }
});
const worktreeBootstrapStatusSchema = z.object({
  status: z.enum(['pending', 'ready', 'failed']),
  phase: z.enum(['directory-created', 'git-ready', 'setup-ready']).optional(),
  error: boundedString(NETWORK_OPERATION_ERROR_MESSAGE_MAX_CHARS).nullable(),
  errorCode: operationErrorCodeSchema.optional(),
  updatedAt: z.number().int().safe().nonnegative(),
  hydration: hydrationSchema.optional(),
}).strict().superRefine((status, context) => {
  if (status.status !== 'failed' && (status.errorCode || status.hydration)) {
    context.addIssue({ code: 'custom', message: 'Only failed worktree bootstrap status may include failure details' });
  }
});
const routeErrorSchema = z.object({
  error: boundedString(NETWORK_OPERATION_ERROR_MESSAGE_MAX_CHARS),
  code: operationErrorCodeSchema,
}).strict();
const operationBaseFields = {
  operationId: operationIdSchema,
  runtimeIdentity: runtimeIdentitySchema,
  transport: operationTransportSchema,
  target: targetSchema,
  completedSteps: z.array(completedStepSchema),
  stepResults: z.array(syncStepResultSchema).length(3).optional(),
  hydration: hydrationSchema.optional(),
};
export const gitNetworkOperationSchema = z.discriminatedUnion('state', [
  z.object({ ...operationBaseFields, state: z.literal('planned') }).strict(),
  z.object({ ...operationBaseFields, state: z.literal('running') }).strict(),
  z.object({ ...operationBaseFields, state: z.literal('succeeded') }).strict(),
  z.object({
    ...operationBaseFields,
    state: z.literal('partial'),
    error: operationErrorSchema([
      'INVALID_REQUEST', 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'TRANSPORT_FAILED',
      'RUNTIME_UNSUPPORTED', 'GIT_LFS_CLIENT_MISSING', 'UNKNOWN',
    ]),
  }).strict(),
  z.object({
    ...operationBaseFields,
    state: z.literal('failed'),
    error: operationErrorSchema([
      'INVALID_REQUEST',
      'AUTHENTICATION_REQUIRED',
      'AUTHENTICATION_FAILED',
      'TRANSPORT_FAILED',
      'RUNTIME_UNSUPPORTED',
      'GIT_LFS_CLIENT_MISSING',
      'UNKNOWN',
    ]),
  }).strict(),
  z.object({
    ...operationBaseFields,
    state: z.literal('cancelled'),
    error: operationErrorSchema(['CANCELLED', 'TIMEOUT']),
  }).strict(),
  z.object({
    ...operationBaseFields,
    state: z.literal('outcome-unknown'),
    error: operationErrorSchema(['OUTCOME_UNKNOWN']),
  }).strict(),
  z.object({
    ...operationBaseFields,
    state: z.literal('conflicted'),
    error: operationErrorSchema(['STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED', 'CONFLICT']),
  }).strict(),
]).superRefine((operation, context) => {
  if (operation.target.operation === 'clone' && operation.state === 'partial'
    && !operation.completedSteps.includes('checked-out')) {
    context.addIssue({ code: 'custom', message: 'Partial clone must retain a completed checkout' });
  }
  const isSync = operation.target.operation === 'sync';
  const isTerminal = operation.state !== 'planned' && operation.state !== 'running';
  if (isSync && isTerminal && operation.stepResults === undefined) {
    context.addIssue({ code: 'custom', message: 'Sync operation result is missing step results' });
  }
  for (const result of operation.stepResults ?? []) {
    const needsError = result.status !== 'succeeded' && result.status !== 'skipped';
    if (needsError !== (result.error !== undefined)) {
      context.addIssue({ code: 'custom', message: 'Git sync step status and error do not match' });
    }
  }
  if (!isSync && operation.stepResults !== undefined) {
    context.addIssue({ code: 'custom', message: 'Non-sync operation contains sync step results' });
  }
  if (operation.state === 'succeeded' && operation.hydration
    && operation.hydration.status !== 'succeeded' && operation.hydration.status !== 'not-needed') {
    context.addIssue({ code: 'custom', message: 'Successful Git operation contains incomplete hydration' });
  }
  if (isSync !== ('fetch' in operation.transport)) {
    context.addIssue({ code: 'custom', message: 'Git operation transport does not match its target' });
  }
});

const normalizeDirectoryKey = (directory: string): string => directory.trim();
const getDirectoryCacheKey = (runtimeKey: string, directory: string): string =>
  JSON.stringify([runtimeKey, normalizeDirectoryKey(directory)]);
const getStatusCacheKey = (runtimeKey: string, directory: string, mode?: 'light'): string =>
  JSON.stringify([runtimeKey, normalizeDirectoryKey(directory), mode ?? 'full']);

const getStatusCacheVersion = (runtimeKey: string, directory: string): number =>
  gitStatusCacheVersions.get(getDirectoryCacheKey(runtimeKey, directory)) ?? 0;

const clearGitStatusCache = (runtimeKey: string, directory: string): void => {
  const key = getDirectoryCacheKey(runtimeKey, directory);
  gitStatusCacheVersions.set(key, getStatusCacheVersion(runtimeKey, directory) + 1);
  for (const mode of [undefined, 'light'] as const) {
    const statusKey = getStatusCacheKey(runtimeKey, directory, mode);
    gitStatusCache.delete(statusKey);
    gitStatusInFlight.delete(statusKey);
  }
};

const getTrackingKey = (runtimeKey: string, serverRuntimeId: string, operationId: string): string =>
  JSON.stringify([runtimeKey, serverRuntimeId, operationId]);

const pruneNetworkOperationTracking = (now = Date.now()): void => {
  for (const [key, tracking] of networkOperationTracking) {
    const retention = tracking.terminalState
      ? NETWORK_OPERATION_TERMINAL_RETENTION_MS
      : NETWORK_OPERATION_ACTIVE_RETENTION_MS;
    if (tracking.observedAt <= now - retention) networkOperationTracking.delete(key);
  }
  while (networkOperationTracking.size > NETWORK_OPERATION_TRACKING_MAX_ENTRIES) {
    let oldest: { key: string; observedAt: number } | null = null;
    for (const [key, tracking] of networkOperationTracking) {
      if (!tracking.terminalState) continue;
      if (!oldest || tracking.observedAt < oldest.observedAt) {
        oldest = { key, observedAt: tracking.observedAt };
      }
    }
    if (!oldest) {
      for (const [key, tracking] of networkOperationTracking) {
        if (!oldest || tracking.observedAt < oldest.observedAt) {
          oldest = { key, observedAt: tracking.observedAt };
        }
      }
    }
    if (!oldest) return;
    networkOperationTracking.delete(oldest.key);
  }
};

const findNetworkOperationTracking = (
  runtimeKey: string,
  operationId: string,
  serverRuntimeId?: string,
): { key: string; value: NetworkOperationTracking } | null => {
  pruneNetworkOperationTracking();
  for (const [key, value] of networkOperationTracking) {
    if (value.runtimeKey === runtimeKey
      && value.operationId === operationId
      && (!serverRuntimeId || value.runtimeIdentity.id === serverRuntimeId)) {
      return { key, value };
    }
  }
  return null;
};

const removeNetworkOperationTracking = (runtimeKey: string, operationId: string): void => {
  let match: string | null = null;
  for (const [key, value] of networkOperationTracking) {
    if (value.runtimeKey === runtimeKey && value.operationId === operationId) {
      if (match) return;
      match = key;
    }
  }
  if (match) networkOperationTracking.delete(match);
};

const touchNetworkOperationTracking = (runtimeKey: string, operationId: string): void => {
  pruneNetworkOperationTracking();
  const now = Date.now();
  for (const tracking of networkOperationTracking.values()) {
    if (tracking.runtimeKey === runtimeKey
      && tracking.operationId === operationId
      && !tracking.terminalState) {
      tracking.observedAt = now;
    }
  }
};

const sameValue = <T>(left: T, right: T): boolean => JSON.stringify(left) === JSON.stringify(right);
const durableTargetText = (target: GitNetworkOperation['target']): string => JSON.stringify(target, (key, value) => {
  if (key === 'forceWithLease') return undefined;
  if (key !== 'displayUrl') return value;
  const displayUrl = z.string().safeParse(value);
  if (!displayUrl.success || displayUrl.data.includes('://')) return value;
  const match = displayUrl.data.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  return match ? `${match[1]}:${match[2]}` : displayUrl.data;
});

const redactRemoteUrl = (value: string): string => {
  const remote = value.trim();
  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    url.hostname = url.hostname.toLowerCase();
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    const scpRemote = remote.match(/^([^@/:\s]+)@([^/:\s]+):(.+)$/);
    return scpRemote
      ? `${scpRemote[1]}@${scpRemote[2].toLowerCase()}:${scpRemote[3].replace(/[?#].*$/, '')}`
      : remote.replace(/[?#].*$/, '');
  }
};

const assertPlanMatchesRequest = (
  request: GitNetworkOperationRequest,
  operation: GitNetworkOperationPlan,
): void => {
  if (operation.target.operation !== request.operation) {
    throw new Error('Malformed Git network operation plan response');
  }
  if (request.operation === 'sync') {
    if (!('fetch' in operation.transport)
      || operation.transport.fetch.mode !== request.fetch.transportMode
      || operation.transport.push.mode !== request.push.transportMode) {
      throw new Error('Malformed Git network operation plan response');
    }
    const expectedPush = {
      ...request.push.remote,
      sourceRef: request.push.sourceRef,
      destinationRef: request.push.destinationRef,
      forceWithLease: request.push.forceWithLease,
    };
    const expectedTarget = {
      operation: 'sync' as const,
      repositoryId: request.repositoryId,
      bindingRevision: request.bindingRevision,
      configRevision: request.configRevision,
      fetch: {
        ...request.fetch.remote,
        sourceRef: request.fetch.sourceRef,
        destinationRef: request.fetch.destinationRef,
      },
      pull: request.pull,
      push: expectedPush,
    };
    if (!sameValue(operation.target, expectedTarget)) {
      throw new Error('Malformed Git network operation plan response');
    }
    return;
  }
  if ('fetch' in operation.transport) {
    throw new Error('Malformed Git network operation plan response');
  }
  if (request.operation === 'checkout-hydration') {
    const target = operation.target;
    if (target.operation !== 'checkout-hydration' || !sameValue({
      repositoryId: target.repositoryId,
      bindingRevision: target.bindingRevision,
      configRevision: target.configRevision,
      remote: target.remote,
    }, {
      repositoryId: request.repositoryId,
      bindingRevision: request.bindingRevision,
      configRevision: request.configRevision,
      remote: request.remote,
    })) throw new Error('Malformed Git network operation plan response');
    return;
  }
  if (operation.transport.mode !== request.transportMode) {
    throw new Error('Malformed Git network operation plan response');
  }
  if (request.operation === 'clone') {
    const target = operation.target;
    if (target.operation !== 'clone') {
      throw new Error('Malformed Git network operation plan response');
    }
    const destinationName = request.destinationPath.trim().split(/[\\/]/).filter(Boolean).at(-1);
    if (target.remote.displayUrl !== redactRemoteUrl(request.remoteUrl)
      || target.destination.displayName !== destinationName) {
      throw new Error('Malformed Git network operation plan response');
    }
    return;
  }
  if (request.operation === 'delete-remote-branch') {
    if (!sameValue(operation.target, {
      operation: 'delete-remote-branch',
      repositoryId: request.repositoryId,
      bindingRevision: request.bindingRevision,
      configRevision: request.configRevision,
      remote: request.remote,
      destinationRef: request.destinationRef,
    })) {
      throw new Error('Malformed Git network operation plan response');
    }
    return;
  }
  if (request.operation === 'fetch' && request.fetchScope === 'remote') {
    const target = operation.target;
    if (target.operation !== 'fetch' || target.fetchScope !== 'remote' || !sameValue(target, {
      operation: 'fetch', fetchScope: 'remote',
      repositoryId: request.repositoryId, bindingRevision: request.bindingRevision,
      configRevision: request.configRevision, remote: request.remote, force: target.force,
    })) throw new Error('Malformed Git network operation plan response');
    return;
  }
  const commonTarget = {
    repositoryId: request.repositoryId,
    bindingRevision: request.bindingRevision,
    configRevision: request.configRevision,
    remote: request.remote,
    sourceRef: request.sourceRef,
    destinationRef: request.destinationRef,
  };
  const expectedTarget: GitNetworkOperation['target'] = request.operation === 'fetch'
    ? { operation: 'fetch', fetchScope: request.fetchScope, ...commonTarget }
    : { operation: request.operation, ...commonTarget };
  if (request.operation === 'push' && request.forceWithLease) {
    Object.assign(expectedTarget, { forceWithLease: request.forceWithLease });
  }
  if (request.operation === 'push' && request.configureUpstream) {
    Object.assign(expectedTarget, { configureUpstream: true });
  }
  if (!sameValue(operation.target, expectedTarget)) {
    throw new Error('Malformed Git network operation plan response');
  }
};

const shouldInvalidateForTerminalOperation = (operation: GitNetworkOperation): boolean => {
  if (operation.target.operation === 'clone') return false;
  if (operation.state === 'succeeded') return true;
  return operation.completedSteps.includes('transferred')
    || operation.completedSteps.includes('updated-local-repository');
};

const transportMatches = (
  expected: GitNetworkOperation['transport'],
  actual: GitNetworkOperation['transport'],
  allowMissingActor = false,
): boolean => {
  if ('fetch' in expected || 'fetch' in actual) {
    return 'fetch' in expected && 'fetch' in actual
      && transportMatches(expected.fetch, actual.fetch, allowMissingActor)
      && transportMatches(expected.push, actual.push, allowMissingActor);
  }
  return expected.mode === actual.mode
    && sameValue(expected.verification, actual.verification)
    && (expected.mode !== 'managed'
      || (actual.mode === 'managed' && (!expected.actor
        || allowMissingActor && !actual.actor
        || sameValue(expected.actor, actual.actor))));
};

subscribeGitStatusInvalidations((directory) => {
  clearGitStatusCache(getRuntimeKey(), directory);
});

const invalidateGitStatusCache = (directory: string): void => {
  notifyGitStatusInvalidated(directory);
};

// Shared success path for status-affecting mutations. The payload is parsed
// before invalidating so a failed mutation (non-ok response handled by the
// caller, or a malformed body) cannot publish a false state change.
const completeStatusMutation = async <T>(directory: string, response: Response): Promise<T> => {
  // SAFETY: every caller rejects non-ok responses before reaching here, and on
  // success each git route returns the body declared by that route's return
  // type in `./api/types`. The assertion names that per-route contract; there is
  // no narrower type available at this shared success path.
  const result = await response.json() as T;
  invalidateGitStatusCache(directory);
  return result;
};

function buildUrl(
  path: string,
  directory: string | null | undefined,
  params?: Record<string, string | number | boolean | undefined>
): string {
  const query: Record<string, string | number | boolean | undefined> = { ...params };
  if (directory) query.directory = directory;

  return getRuntimeUrlResolver().api(path, query);
}

export async function checkIsGitRepository(directory: string): Promise<boolean> {
  const key = getDirectoryCacheKey(getRuntimeKey(), directory);
  const now = Date.now();
  const cached = gitRepoCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitRepoInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const response = await runtimeFetch(buildUrl(`${API_BASE}/check`, directory));
    if (!response.ok) {
      throw new Error(`Failed to check git repository: ${response.statusText}`);
    }
    const data = await response.json();
    const isGitRepository = Boolean(data.isGitRepository);
    gitRepoCache.set(key, {
      value: isGitRepository,
      expiresAt: Date.now() + GIT_REPO_CHECK_CACHE_TTL_MS,
    });
    return isGitRepository;
  })();

  gitRepoInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitRepoInFlight.get(key) === task) {
      gitRepoInFlight.delete(key);
    }
  }
}

export class GitDirectoriesUnsupportedError extends Error {
  constructor() {
    super('Nested git repository discovery is not supported by this runtime');
    this.name = 'GitDirectoriesUnsupportedError';
  }
}

export async function listGitDirectories(root: string): Promise<string[]> {
  const response = await runtimeFetch('/api/fs/git-dirs', { query: { path: root, directory: root } });
  if (response.status === 501) {
    throw new GitDirectoriesUnsupportedError();
  }
  if (!response.ok) {
    throw new Error(`Failed to list git directories: ${response.statusText}`);
  }
  // SAFETY: the route is ours (`GET /api/fs/git-dirs`) and answers this exact
  // shape on every 2xx; a malformed body fails the array check below.
  const data = await response.json() as { repositories?: Array<{ path?: string | null }> };
  if (!Array.isArray(data?.repositories)) {
    throw new Error('Unexpected git directories response');
  }
  // The server joins paths with the platform separator; every other git
  // directory key in the UI is normalized, so match that here or a Windows
  // repository never equals its own selection or root prefix.
  return data.repositories
    .map((entry) => normalizePath(entry?.path ?? null))
    .filter((path): path is string => path !== null);
}

export async function getGitStatus(directory: string, options?: { mode?: 'light'; fresh?: boolean }): Promise<GitStatus> {
  const mode = options?.mode;
  const runtimeKey = getRuntimeKey();
  if (options?.fresh) {
    // A forced read must cross the transport cache boundary too. Advancing the
    // version also prevents an older in-flight response from repopulating it.
    clearGitStatusCache(runtimeKey, directory);
  }
  const key = getStatusCacheKey(runtimeKey, directory, mode);
  const now = Date.now();
  const cached = gitStatusCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = gitStatusInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }

  const task = (async () => {
    const cacheVersion = getStatusCacheVersion(runtimeKey, directory);
    const response = await runtimeFetch(buildUrl(`${API_BASE}/status`, directory, mode ? { mode } : undefined));
    if (!response.ok) {
      throw new Error(`Failed to get git status: ${response.statusText}`);
    }
    const payload = await response.json() as GitStatus;
    if (getStatusCacheVersion(runtimeKey, directory) === cacheVersion) {
      gitStatusCache.set(key, {
        value: payload,
        expiresAt: Date.now() + GIT_STATUS_CACHE_TTL_MS,
      });
    }
    return payload;
  })();

  gitStatusInFlight.set(key, task);
  try {
    return await task;
  } finally {
    if (gitStatusInFlight.get(key) === task) {
      gitStatusInFlight.delete(key);
    }
  }
}

export async function resolveGitPrimaryRoot(directory: string): Promise<{ root: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/primary-root`, directory));
  if (!response.ok) {
    throw new Error(`Failed to resolve git primary root: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as { root?: string };
  return { root: typeof payload.root === 'string' && payload.root ? payload.root : directory };
}

export async function resolveGitTopLevel(directory: string): Promise<{ root: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/toplevel`, directory));
  if (!response.ok) {
    throw new Error(`Failed to resolve git toplevel: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as { root?: string };
  return { root: typeof payload.root === 'string' && payload.root ? payload.root : directory };
}

export async function getGitCommitSummaries(
  directory: string,
  shas: string[]
): Promise<{ commits: Array<{ sha: string; short: string; subject: string }> }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit-summaries`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shas }),
  });
  if (!response.ok) {
    throw new Error(`Failed to get git commit summaries: ${response.statusText}`);
  }
  const payload = await response.json().catch(() => ({})) as {
    commits?: Array<{ sha?: string; short?: string; subject?: string }>;
  };
  return {
    commits: Array.isArray(payload.commits)
      ? payload.commits
          .map((entry) => ({
            sha: typeof entry.sha === 'string' ? entry.sha : '',
            short: typeof entry.short === 'string' ? entry.short : '',
            subject: typeof entry.subject === 'string' ? entry.subject : '',
          }))
          .filter((entry) => entry.sha && entry.short)
      : [],
  };
}

export async function getGitDiff(directory: string, options: GetGitDiffOptions): Promise<GitPathDiffResponse> {
  const { path, staged, contextLines } = options;
  if (!path) {
    throw new Error('path is required to fetch git diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
      context: contextLines,
    })
  );

  if (!response.ok) {
    throw await pathDiffResponseError(response, 'Failed to get git diff');
  }

  return gitPathDiffSchema.parse(await response.json());
}

export async function getGitRangeDiff(
  directory: string,
  options: GetGitRangeDiffOptions
): Promise<GitDiffResponse> {
  const { base, head, path, contextLines, includeWorkingTree } = options;
  if (!base || !head) {
    throw new Error('base and head are required to fetch git range diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/range-diff`, directory, {
      base,
      head,
      path: path || undefined,
      context: contextLines,
      includeWorkingTree,
    })
  );

  if (!response.ok) {
    throw await rangeResponseError(response, 'Failed to get git range diff');
  }

  return gitRangeDiffSchema.parse(await response.json());
}

export async function getGitCommitDiff(directory: string, options: GetGitCommitDiffOptions): Promise<GitDiffResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit-diff`, directory, {
    hash: options.hash,
    path: options.path,
    previousPath: options.previousPath,
    context: options.contextLines,
  }));
  if (!response.ok) throw await rangeResponseError(response, 'Failed to get commit diff');
  return gitRangeDiffSchema.parse(await response.json());
}

export async function getGitRangeFiles(
  directory: string,
  options: GetGitRangeFilesOptions
): Promise<import('./api/types').GitRangeFileEntry[]> {
  const { base, head, includeWorkingTree } = options;
  if (!base || !head) {
    throw new Error('base and head are required to fetch git range files');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/range-files`, directory, { base, head, includeWorkingTree })
  );

  if (!response.ok) {
    throw await rangeResponseError(response, 'Failed to get git range files');
  }

  return gitRangeFilesSchema.parse(await response.json()).files;
}

export async function getBranchBase(
  directory: string,
  branch: string
): Promise<import('./api/types').GitBranchBaseResponse> {
  if (!branch) {
    throw new Error('branch is required to get branch base');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/branch-base`, directory, { branch })
  );

  if (!response.ok) {
    throw new Error(`Failed to get branch base: ${response.statusText}`);
  }

  return response.json();
}

export async function getGitFileDiff(directory: string, options: GetGitFileDiffOptions): Promise<GitFileDiffResponse> {
  const { path, staged } = options;
  if (!path) {
    throw new Error('path is required to fetch git file diff');
  }

  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/file-diff`, directory, {
      path,
      staged: staged ? 'true' : undefined,
    })
  );

  if (!response.ok) {
    throw await pathDiffResponseError(response, 'Failed to get git file diff');
  }

  return gitFileDiffSchema.parse(await response.json());
}

export async function revertGitFile(
  directory: string,
  filePath: string,
  options?: { scope?: 'all' | 'working' }
): Promise<void> {
  if (!filePath) {
    throw new Error('path is required to revert git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/revert`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, scope: options?.scope }),
  });

  if (!response.ok) {
    const message = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to revert git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function stageGitFile(directory: string, filePath: string): Promise<void> {
  await stageGitFiles(directory, [filePath]);
}

export async function stageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const paths = filePaths.map((path) => path.trim()).filter(Boolean);

  if (paths.length === 0) {
    throw new Error('path is required to stage git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/stage`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to stage git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function unstageGitFile(directory: string, filePath: string): Promise<void> {
  await unstageGitFiles(directory, [filePath]);
}

export async function unstageGitFiles(directory: string, filePaths: string[]): Promise<void> {
  const paths = filePaths.map((path) => path.trim()).filter(Boolean);

  if (paths.length === 0) {
    throw new Error('path is required to unstage git changes');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/unstage`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to unstage git changes');
  }

  invalidateGitStatusCache(directory);
}

export async function stageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'stage');
}

export async function unstageGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'unstage');
}

export async function revertGitHunk(directory: string, filePath: string, patch: string): Promise<void> {
  await applyGitHunk(directory, filePath, patch, 'discard');
}

async function applyGitHunk(
  directory: string,
  filePath: string,
  patch: string,
  action: 'stage' | 'unstage' | 'discard',
): Promise<void> {
  if (!filePath) {
    throw new Error('path is required to apply a git hunk');
  }
  if (typeof patch !== 'string' || !patch.trim()) {
    throw new Error('patch is required to apply a git hunk');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/apply-hunk`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, patch, action }),
  });

  if (!response.ok) {
    const message = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(message.error || 'Failed to apply git hunk');
  }

  invalidateGitStatusCache(directory);
}

export async function isLinkedWorktree(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktree-type`, directory));
  if (!response.ok) {
    throw new Error(`Failed to detect worktree type: ${response.statusText}`);
  }
  const data = await response.json();
  return Boolean(data.linked);
}

export async function getGitBranches(directory: string): Promise<GitBranch> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get branches: ${response.statusText}`);
  }
  return response.json();
}

export async function getGitUnpushedBranchCounts(directory: string, branches: string[]): Promise<GitUnpushedBranchCounts> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branch-push-status`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branches }),
  });
  if (!response.ok) throw new Error(`Failed to get branch push status: ${response.statusText}`);
  return response.json();
}

export async function deleteGitBranch(directory: string, payload: GitDeleteBranchPayload): Promise<{ success: boolean }> {
  if (!payload?.branch) {
    throw new Error('branch is required to delete a branch');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete branch');
  }

  return completeStatusMutation(directory, response);
}


export async function removeRemote(directory: string, payload: GitRemoveRemotePayload): Promise<{ success: boolean }> {
  const remote = payload?.remote?.trim();
  if (!remote) {
    throw new Error('remote is required to remove a remote');
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/remotes`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remote }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to remove remote');
  }

  return completeStatusMutation(directory, response);
}

export async function generateCommitMessage(
  directory: string,
  files: string[],
  options?: { zenModel?: string; providerId?: string; modelId?: string }
): Promise<{ message: GeneratedCommitMessage }> {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('No files provided to generate commit message');
  }

  const body: Record<string, unknown> = { files };
  if (options?.zenModel) {
    body.zenModel = options.zenModel;
  }
  if (options?.providerId) {
    body.providerId = options.providerId;
  }
  if (options?.modelId) {
    body.modelId = options.modelId;
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit-message`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    console.error('[git-generation][browser] http error', {
      status: response.status,
      statusText: response.statusText,
      error,
    });
    const traceSuffix = typeof error?.traceId === 'string' && error.traceId
      ? ` (traceId: ${error.traceId})`
      : '';
    throw new Error(`${error.error || 'Failed to generate commit message'}${traceSuffix}`);
  }

  const data = await response.json();

  if (!data?.message || typeof data.message !== 'object') {
    throw new Error('Malformed commit generation response');
  }

  const subject =
    typeof data.message.subject === 'string' && data.message.subject.trim().length > 0
      ? data.message.subject.trim()
      : '';

  const highlights: string[] = Array.isArray(data.message.highlights)
    ? (data.message.highlights as unknown[])
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => (item as string).trim())
    : [];

  return {
    message: {
      subject,
      highlights,
    },
  };
}

export async function generatePullRequestDescription(
  directory: string,
  payload: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string }
): Promise<{ title: string; body: string }> {
  const { base, head, context, zenModel, providerId, modelId } = payload;
  if (!base || !head) {
    throw new Error('base and head are required');
  }

  const requestBody: { base: string; head: string; context?: string; zenModel?: string; providerId?: string; modelId?: string } = { base, head };
  if (context?.trim()) {
    requestBody.context = context.trim();
  }
  if (zenModel) {
    requestBody.zenModel = zenModel;
  }
  if (providerId) {
    requestBody.providerId = providerId;
  }
  if (modelId) {
    requestBody.modelId = modelId;
  }

  const response = await runtimeFetch(buildUrl(`${API_BASE}/pr-description`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to generate PR description');
  }

  const data = await response.json().catch(() => null);
  const title = typeof data?.title === 'string' ? data.title : '';
  const body = typeof data?.body === 'string' ? data.body : '';
  if (!title && !body) {
    throw new Error('Malformed PR description response');
  }
  return { title, body };
}

export async function listGitWorktrees(directory: string): Promise<GitWorktreeInfo[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to list worktrees');
  }
  return response.json();
}

export async function validateGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeValidationResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/validate`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to validate worktree');
  }

  return response.json();
}

export async function getGitWorktreeBootstrapStatus(directory: string): Promise<import('./api/types').GitWorktreeBootstrapStatus> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/bootstrap-status`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to get worktree bootstrap status');
  }
  return worktreeBootstrapStatusSchema.parse(await response.json());
}

export async function previewGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/preview`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to preview worktree');
  }

  return response.json();
}

export async function createGitWorktree(directory: string, payload: CreateGitWorktreePayload): Promise<GitWorktreeCreateResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = z.object({
      error: z.string().optional(),
      code: z.string().optional(),
      remoteName: z.string().optional(),
    }).strict().parse(await response.json().catch(() => ({ error: response.statusText })));
    throw new GitWorktreeRequestError(
      error.code || 'UNKNOWN', error.error || 'Failed to create worktree', response.status, error.remoteName,
    );
  }

  return response.json();
}

export async function deleteGitWorktree(directory: string, payload: RemoveGitWorktreePayload): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees`, directory), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete worktree');
  }

  return response.json();
}

export async function createGitCommit(
  directory: string,
  message: string,
  options: CreateGitCommitOptions = {}
): Promise<GitCommitResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      addAll: options.addAll ?? false,
      files: options.files,
      stageFiles: options.stageFiles,
    }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create commit');
  }
  return completeStatusMutation(directory, response);
}

export async function gitPush(
  directory: string,
  options: { remote?: string; branch?: string; options?: string[] | Record<string, unknown> } = {}
): Promise<GitPushResult> {
  const runtimeKey = getRuntimeKey();
  const response = await runtimeFetch(buildUrl(`${API_BASE}/push`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to push');
  }
  const result = await completeStatusMutation<GitPushResult>(directory, response);
  if (result.success) notifyGitPush(directory, runtimeKey);
  return result;
}

export async function gitPull(
  directory: string,
  options: GitPullOptions = {}
): Promise<GitPullResult> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/pull`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to pull');
  }
  return completeStatusMutation(directory, response);
}

export async function gitFetch(
  directory: string,
  options: { remote?: string; branch?: string } = {}
): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/fetch`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to fetch');
  }
  return completeStatusMutation(directory, response);
}

const requestNetworkOperation = async (
  path: string,
  init?: RequestInit,
  trackedRequest?: { runtimeKey: string; operationId: string },
): Promise<GitNetworkOperation> => {
  const response = await runtimeFetch(path, init);
  if (!response.ok) {
    const envelope = routeErrorSchema.parse(await response.json());
    if (envelope.code === 'NOT_FOUND' && trackedRequest) {
      removeNetworkOperationTracking(trackedRequest.runtimeKey, trackedRequest.operationId);
    }
    throw new GitNetworkOperationRequestError(envelope.code, envelope.error, response.status);
  }
  return gitNetworkOperationSchema.parse(await response.json());
};

const handleNetworkOperationSnapshot = (
  operationId: string,
  requestRuntimeKey: string,
  operation: GitNetworkOperation,
): GitNetworkOperation => {
  if (operation.operationId !== operationId) {
    throw new Error('Malformed Git network operation response');
  }
  const tracked = findNetworkOperationTracking(requestRuntimeKey, operationId, operation.runtimeIdentity.id);
  if (!tracked && findNetworkOperationTracking(requestRuntimeKey, operationId)) {
    throw new Error('Malformed Git network operation response');
  }
  if (tracked) {
    const expectedTransport = tracked.value.transport;
    const terminal = operation.state !== 'planned' && operation.state !== 'running';
    const targetMatches = sameValue(tracked.value.target, operation.target)
      || terminal
        && durableTargetText(tracked.value.target) === JSON.stringify(operation.target);
    if (!sameValue(tracked.value.runtimeIdentity, operation.runtimeIdentity)
      || !targetMatches
      || !transportMatches(expectedTransport, operation.transport, terminal)) {
      throw new Error('Malformed Git network operation response');
    }
    if (tracked.value.terminalState) {
      if (operation.state === 'planned' || operation.state === 'running'
        || operation.state !== tracked.value.terminalState) {
        throw new Error('Malformed Git network operation response');
      }
    }
    if (sameValue(expectedTransport, operation.transport) === false) {
      tracked.value.transport = operation.transport;
    }
    if (operation.state !== 'planned' && operation.state !== 'running') {
      if (!tracked.value.terminalState) {
        if (shouldInvalidateForTerminalOperation(operation)) {
          // The operation carries the runtime it was planned under, which is
          // not necessarily the active one. Clear that runtime's own cache
          // directly, and announce the mutation only when it belongs to the
          // active runtime: a stale runtime's completion says nothing about
          // the state the user is now looking at.
          clearGitStatusCache(tracked.value.runtimeKey, tracked.value.directory);
          if (tracked.value.runtimeKey === getRuntimeKey()) {
            notifyGitStatusInvalidated(tracked.value.directory);
          }
        }
        tracked.value.terminalState = operation.state;
        tracked.value.observedAt = Date.now();
      }
    } else {
      tracked.value.observedAt = Date.now();
    }
  }
  if (getRuntimeKey() !== requestRuntimeKey) {
    throw new Error('Git network operation response belongs to a stale runtime');
  }
  return operation;
};

export async function planNetworkOperation(request: GitNetworkOperationRequest): Promise<GitNetworkOperationPlan> {
  const runtimeKey = getRuntimeKey();
  const operation = await requestNetworkOperation(`${API_BASE}/network-operations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (operation.state !== 'planned') {
    throw new Error('Malformed Git network operation plan response');
  }
  if (getRuntimeKey() !== runtimeKey) {
    throw new Error('Git network operation response belongs to a stale runtime');
  }
  assertPlanMatchesRequest(request, operation);
  const key = getTrackingKey(runtimeKey, operation.runtimeIdentity.id, operation.operationId);
  const tracked = findNetworkOperationTracking(runtimeKey, operation.operationId, operation.runtimeIdentity.id);
  if (tracked?.value.terminalState) {
    throw new Error('Malformed Git network operation plan response');
  }
  networkOperationTracking.set(key, {
    operationId: operation.operationId,
    runtimeKey,
    directory: request.operation === 'clone' ? request.destinationPath : request.directory,
    runtimeIdentity: operation.runtimeIdentity,
    transport: operation.transport,
    target: operation.target,
    observedAt: Date.now(),
  });
  pruneNetworkOperationTracking();
  return operation;
}


export async function issueContributorDestination(
  request: GitContributorDestinationRequest,
): Promise<GitContributorDestinationSelection> {
  const response = await runtimeFetch(`${API_BASE}/contributor-destinations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const envelope = routeErrorSchema.parse(await response.json());
    throw new GitNetworkOperationRequestError(envelope.code, envelope.error, response.status);
  }
  return contributorDestinationSchema.parse(await response.json());
}

export async function listContributorDestinations(directory: string): Promise<GitContributorDestinationCandidates> {
  const runtimeKey = getRuntimeKey();
  const response = await runtimeFetch(buildUrl(`${API_BASE}/contributor-destinations`, directory));
  if (!response.ok) {
    const envelope = routeErrorSchema.parse(await response.json());
    throw new GitNetworkOperationRequestError(envelope.code, envelope.error, response.status);
  }
  const result = contributorDestinationCandidatesSchema.parse(await response.json());
  if (getRuntimeKey() !== runtimeKey) throw new Error('Contributor destinations belong to a stale runtime');
  return result;
}

export async function inspectCheckoutTrust(directory: string): Promise<GitCheckoutTrustInspection> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/checkout-trust`, directory));
  if (!response.ok) throw new Error((await response.json()).error || 'Failed to inspect checkout actions');
  return checkoutTrustSchema.parse(await response.json());
}

export async function decideCheckoutTrust(
  directory: string,
  digest: string,
  decision: 'run' | 'skip',
): Promise<{ state: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/worktrees/checkout-trust`, directory), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest, decision }),
  });
  if (!response.ok) throw new Error((await response.json()).error || 'Failed to apply checkout trust decision');
  return z.object({ state: z.string().min(1) }).passthrough().parse(await response.json());
}

const requestTrackedNetworkOperation = async (
  operationId: string,
  action?: 'execute' | 'cancel',
): Promise<GitNetworkOperation> => {
  const runtimeKey = getRuntimeKey();
  touchNetworkOperationTracking(runtimeKey, operationId);
  const actionPath = action ? `/${action}` : '';
  const init = action ? { method: 'POST' } : undefined;
  const operation = await requestNetworkOperation(
    `${API_BASE}/network-operations/${encodeURIComponent(operationId)}${actionPath}`,
    init,
    { runtimeKey, operationId },
  );
  return handleNetworkOperationSnapshot(operationId, runtimeKey, operation);
};

export async function executeNetworkOperation(operationId: string): Promise<GitNetworkOperation> {
  return requestTrackedNetworkOperation(operationId, 'execute');
}

export async function getNetworkOperation(operationId: string): Promise<GitNetworkOperation> {
  return requestTrackedNetworkOperation(operationId);
}

export async function cancelNetworkOperation(operationId: string): Promise<GitNetworkOperation> {
  return requestTrackedNetworkOperation(operationId, 'cancel');
}

export async function listGitStashes(directory: string): Promise<{ stashes: GitStashEntry[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stashes`, directory));
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to list stashes');
  }
  return response.json();
}

export async function countGitStashFiles(directory: string, refs: string[]): Promise<{ counts: Record<string, number> }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stashes/file-counts`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to count stash files');
  }
  return response.json();
}

export async function stashGitChanges(directory: string, options: { message?: string } = {}): Promise<{ success: boolean; created: boolean; message: string; output: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/stash`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to stash changes');
  }
  return completeStatusMutation(directory, response);
}

const postStashRef = async (directory: string, path: string, options: { ref: string }): Promise<{ success: boolean; ref: string }> => {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/${path}`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || `Failed to ${path}`);
  }
  return completeStatusMutation(directory, response);
};

export const applyGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/apply', options);
export const popGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/pop', options);
export const dropGitStash = (directory: string, options: { ref: string }) => postStashRef(directory, 'stash/drop', options);

export async function checkoutBranch(directory: string, branch: string): Promise<{ success: boolean; branch: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/checkout`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ branch }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to checkout branch');
  }
  return completeStatusMutation(directory, response);
}

export async function createBranch(
  directory: string,
  name: string,
  startPoint?: string
): Promise<{ success: boolean; branch: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, startPoint }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create branch');
  }
  return completeStatusMutation(directory, response);
}

export async function renameBranch(
  directory: string,
  oldName: string,
  newName: string
): Promise<{ success: boolean; branch: string }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/branches/rename`, directory), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldName, newName }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to rename branch');
  }
  return completeStatusMutation(directory, response);
}

export async function getGitLog(
  directory: string,
  options: GitLogOptions = {}
): Promise<GitLogResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/log`, directory, {
      maxCount: options.maxCount,
      from: options.from,
      to: options.to,
      file: options.file,
      all: options.all ? 'true' : undefined,
    })
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(`Failed to get git log: ${errorBody.error || response.statusText}`);
  }
  return gitLogSchema.parse(await response.json());
}

export async function getCommitFiles(
  directory: string,
  hash: string
): Promise<GitCommitFilesResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/commit-files`, directory, { hash })
  );
  if (!response.ok) {
    throw await rangeResponseError(response, 'Failed to get commit files');
  }
  return gitCommitFilesSchema.parse(await response.json());
}

export async function getCommitFileDiff(
  directory: string,
  hash: string,
  filePath: string,
  isBinary: boolean
): Promise<CommitFileDiffResponse> {
  const response = await runtimeFetch(
    buildUrl(`${API_BASE}/commit-file-diff`, directory, {
      hash,
      path: filePath,
      binary: isBinary ? 'true' : undefined,
    })
  );
  if (!response.ok) {
    throw new Error(`Failed to get commit file diff: ${response.statusText}`);
  }
  return response.json();
}

export async function getGitIdentities(): Promise<GitIdentityProfile[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get git identities: ${response.statusText}`);
  }
  return gitIdentityProfilesSchema.parse(await response.json());
}

export async function createGitIdentity(profile: GitIdentityProfile): Promise<GitIdentityProfile> {
  const input = gitIdentityProfileSchema.parse(profile);
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities`, undefined), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to create git identity');
  }
  return gitIdentityProfileSchema.parse(await response.json());
}

export async function updateGitIdentity(id: string, updates: GitIdentityProfile): Promise<GitIdentityProfile> {
  const input = gitIdentityProfileSchema.parse(updates);
  if (input.id !== id) throw new Error('Git identity profile ID does not match the update target');
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities/${id}`, undefined), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to update git identity');
  }
  return gitIdentityProfileSchema.parse(await response.json());
}

export async function deleteGitIdentity(id: string): Promise<void> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/identities/${id}`, undefined), {
    method: 'DELETE',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to delete git identity');
  }
}

export async function getCurrentGitIdentity(directory: string): Promise<GitIdentitySummary | null> {
  if (!directory) {
    return null;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/current-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get current git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data) {
    return null;
  }
  return gitIdentitySummarySchema.parse(data);
}

export async function getAgentGitAuthority(directory: string): Promise<boolean> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/agent-authority`, directory));
  if (!response.ok) throw new Error(`Failed to read the Git agent authority: ${response.statusText}`);
  return (await response.json())?.enabled === true;
}

export async function setAgentGitAuthority(directory: string, enabled: boolean): Promise<boolean> {
  const response = await runtimeFetch(`${API_BASE}/agent-authority`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, enabled }),
  });
  if (!response.ok) throw new Error(`Failed to set the Git agent authority: ${response.statusText}`);
  return (await response.json())?.enabled === true;
}

export async function hasLocalIdentity(directory: string): Promise<boolean> {
  if (!directory) {
    return false;
  }
  const response = await runtimeFetch(buildUrl(`${API_BASE}/has-local-identity`, directory));
  if (!response.ok) {
    throw new Error(`Failed to check local identity: ${response.statusText}`);
  }
  const data = await response.json().catch(() => null);
  return data?.hasLocalIdentity === true;
}

export async function getGlobalGitIdentity(): Promise<GitIdentitySummary | null> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/global-identity`, undefined));
  if (!response.ok) {
    throw new Error(`Failed to get global git identity: ${response.statusText}`);
  }
  const data = await response.json();
  if (!data) {
    return null;
  }
  const identity = gitIdentitySummarySchema.parse(data);
  return identity.userName || identity.userEmail ? identity : null;
}

export async function setGitIdentity(
  directory: string,
  profileId: string
): Promise<{ success: boolean; profile: GitIdentityProfile | null }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/set-identity`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profileId }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to set git identity');
  }
  return gitIdentityMutationResultSchema.parse(await response.json());
}

export async function getRemotes(directory: string): Promise<GitRemote[]> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/remotes`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get remotes: ${response.statusText}`);
  }
  return gitRemoteListSchema.parse(await response.json());
}

export async function rebase(
  directory: string,
  options: { onto: string }
): Promise<{ success: boolean; conflict?: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to rebase');
  }
  return completeStatusMutation(directory, response);
}

export async function abortRebase(directory: string): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to abort rebase');
  }
  return completeStatusMutation(directory, response);
}

export async function merge(
  directory: string,
  options: { branch: string }
): Promise<{ success: boolean; conflict?: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to merge');
  }
  return completeStatusMutation(directory, response);
}

export async function checkoutCommit(
  directory: string,
  hash: string
): Promise<CheckoutCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/checkout-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to checkout commit');
  }
  return completeStatusMutation(directory, response);
}

export async function cherryPick(
  directory: string,
  hash: string
): Promise<CherryPickResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/cherry-pick`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to cherry-pick');
  }
  return completeStatusMutation(directory, response);
}

export async function revertCommit(
  directory: string,
  hash: string
): Promise<RevertCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/revert-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to revert commit');
  }
  return completeStatusMutation(directory, response);
}

export async function resetToCommit(
  directory: string,
  hash: string,
  mode: 'soft' | 'mixed' | 'hard',
  force?: boolean
): Promise<ResetToCommitResponse> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/reset-to-commit`, directory), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash, mode, force }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to reset');
  }
  return completeStatusMutation(directory, response);
}

export async function abortMerge(directory: string): Promise<{ success: boolean }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge/abort`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to abort merge');
  }
  return completeStatusMutation(directory, response);
}

export async function continueRebase(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/rebase/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to continue rebase');
  }
  return completeStatusMutation(directory, response);
}

export async function continueMerge(directory: string): Promise<{ success: boolean; conflict: boolean; conflictFiles?: string[] }> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/merge/continue`, directory), {
    method: 'POST',
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error || 'Failed to continue merge');
  }
  return completeStatusMutation(directory, response);
}

export async function stash(
  directory: string,
  options?: { message?: string; includeUntracked?: boolean }
): Promise<{ success: boolean }> {
  await stashGitChanges(directory, { message: options?.message });
  return { success: true };
}

export async function stashPop(directory: string): Promise<{ success: boolean }> {
  await popGitStash(directory, { ref: 'stash@{0}' });
  return { success: true };
}

export async function getConflictDetails(directory: string): Promise<MergeConflictDetails> {
  const response = await runtimeFetch(buildUrl(`${API_BASE}/conflict-details`, directory));
  if (!response.ok) {
    throw new Error(`Failed to get conflict details: ${response.statusText}`);
  }
  return response.json();
}

export async function validateWorktreeDirectory(
  directory: string,
  worktreeRoot: string
): Promise<{
  valid: boolean;
  insideWorktreeRoot: boolean;
  resolvedWorktreeRoot: string | null;
  resolvedCwd: string | null;
}> {
  const response = await runtimeFetch(`${API_BASE}/validate-directory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, worktreeRoot }),
  });
  if (!response.ok) {
    throw new Error(`Failed to validate worktree directory: ${response.statusText}`);
  }
  return response.json();
}

export async function canonicalizeWorktreeState(
  directory: string
): Promise<{
  worktreeRoot: string | null;
  cwd: string | null;
  branch: string | null;
  headState: 'branch' | 'detached' | 'unborn';
  worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';
  legacy: boolean;
  degraded: boolean;
  attentionReason?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;
}> {
  const response = await runtimeFetch(`${API_BASE}/canonicalize-worktree-state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory }),
  });
  if (!response.ok) {
    throw new Error(`Failed to canonicalize worktree state: ${response.statusText}`);
  }
  return response.json();
}
