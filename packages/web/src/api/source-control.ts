import type {
  GitTransportBindingIntent,
  GitTransportBindingResult,
  GitTransportBindingRemovalIntent,
  GitTransportBindingRemovalResult,
  GitAuxiliaryBindingIntent,
  GitAuxiliaryBindingResult,
  ChangeRequest,
  ChangeRequestCommit,
  ChangeRequestContext,
  ChangeRequestVerdict,
  PullRequestStack,
  ChangeRequestStatus,
  CI,
  CISummary,
  Issue,
  IssueComment,
  CreateChangeRequestInput,
  MergeChangeRequestInput,
  PageResult,
  Project,
  ProjectUpstream,
  ReadyChangeRequestInput,
  CommentInput,
  ReviewChangeRequestInput,
  SetStateInput,
  SetLabelsInput,
  SetReviewersInput,
  ThreadReplyInput,
  ThreadResolveInput,
  SourceControlAPI,
  SourceControlAuthAccount,
  SourceControlAuthStatus,
  SourceControlCapabilities,
  SourceControlDeviceFlowComplete,
  SourceControlDeviceFlowStart,
  SourceControlIdentity,
  SourceControlEmptyMutationResult,
  SourceControlCreateMutationTarget,
  SourceControlExistingMutationTarget,
  SourceControlExpectedMutationTarget,
  SourceControlCreateMutationResult,
  SourceControlMergeMutationResult,
  SourceControlMutationContext,
  SourceControlMutationReceipt,
  SourceControlReadyMutationResult,
  SourceControlReviewMutationResult,
  SourceControlStateMutationResult,
  SourceControlResolvedMutationTarget,
  SourceControlBindingRead,
  SourceControlRepositoryBinding,
  SourceControlRepositoryBindingResetIntent,
  SourceControlRepositoryContext,
  SourceControlRepositoryRemote,
  SourceControlReadContext,
  SourceControlUser,
  UpdateChangeRequestInput,
  Label,
  RepositoryReferenceReviewer,
  RepositorySelector,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { isSafeRepositoryEndpoint, parseBindingResponse, resolveBindingReadiness } from '../../server/lib/source-control/binding-contract.js';
import type { SourceControlProviderDescriptor } from '@openchamber/ui/lib/source-control/providers/descriptor';
import { fetchChangeRequestListStatuses, fetchRepositoryReferenceDetail, fetchRepositoryReferences, fetchRepositoryReferencesAcross } from './repository-references';
import { BUILT_IN_SOURCE_CONTROL_PROVIDERS, fetchSourceControlProviders, providerPath } from './source-control-providers';

interface ErrorResponse {
  error?: string;
  code?: string;
}

class SourceControlRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

interface SourceControlInstancesResponse extends ErrorResponse {
  instances: SourceControlIdentity[];
}

interface RepositoryContextDTO extends ErrorResponse {
  supported?: boolean;
  repositoryId: string;
  configRevision: string;
  bare: boolean;
  remotes: SourceControlRepositoryRemote[];
}

interface RepositoryBindingDTO extends ErrorResponse {
  repository: RepositoryContextDTO;
  revision: number;
  binding: SourceControlRepositoryBinding | null;
}

interface BranchesDTO {
  branches?: string[];
}

interface DeviceFlowStartDTO {
  flowId: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
  scope?: string;
}

type DeviceFlowCompleteDTO =
  | { connected: true; user: SourceUserDTO; scope?: string }
  | { connected: false; status?: string; error?: string };

type DisconnectedSourceControlAuthStatus = Extract<SourceControlAuthStatus, { status: 'disconnected' }>;
type ProviderAuthStatusDTO = SourceControlAuthStatus | {
  connected: false;
  status?: undefined;
  accounts?: SourceControlAuthAccount[];
  cli?: DisconnectedSourceControlAuthStatus['cli'];
};

interface SourceUserDTO {
  id: string | number;
  provider?: string;
  instance?: string;
  username?: string;
  login?: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
}

type MutationBody<TTarget extends SourceControlExpectedMutationTarget = SourceControlExpectedMutationTarget> = SourceControlMutationContext<TTarget>;

interface CreateBody extends MutationBody<SourceControlCreateMutationTarget> {
  title: string;
  body?: string;
  draft?: boolean;
  remote?: string;
  headRemote?: string;
}

interface UpdateBody extends MutationBody<SourceControlExistingMutationTarget> {
  title: string;
  body?: string;
}

interface MutationReceiptDTO extends ErrorResponse {
  status: string;
  actor: { provider: string; instance: string; providerAccountId: string };
  target: {
    repositoryId: string;
    bindingRevision: number;
    primaryRemote: string;
    project: { id: string; owner: string; name: string };
    number?: number;
    head?: string;
    base?: string;
    headSha?: string;
  };
  replayed: boolean;
  result: MutationResultDTO;
}

interface MutationResultDTO {
  merged?: boolean;
  message?: string;
  outcome?: string;
  stacked?: boolean;
  ready?: boolean;
  commented?: boolean;
  state?: string;
}

type SourceControlFetch = (input: string, init?: RuntimeFetchOptions) => Promise<Response>;
type PostBody =
  | { flowId: string }
  | { token: string }
  | { accountId: string }
  | { disabled: boolean }
  | CreateBody
  | UpdateBody
  | (MutationBody<SourceControlExistingMutationTarget> & { method: 'merge' | 'squash' | 'rebase' })
  | (MutationBody<SourceControlExistingMutationTarget> & { body: string })
  | (MutationBody<SourceControlExistingMutationTarget> & { threadId: string; body: string })
  | (MutationBody<SourceControlExistingMutationTarget> & { threadId: string; resolved: boolean })
  | (MutationBody<SourceControlExistingMutationTarget> & { state: SetStateInput['state'] })
  | (MutationBody<SourceControlExistingMutationTarget> & { labels: string[] })
  | (MutationBody<SourceControlExistingMutationTarget> & { reviewers: string[] })
  | (MutationBody<SourceControlExistingMutationTarget> & { verdict: ReviewChangeRequestInput['verdict']; body?: string })
  | MutationBody;

interface WebSourceControlAPIOptions {
  fetch?: SourceControlFetch;
}

/**
 * How each provider writes its instance, and its name for errors: seeded with
 * the built-in providers and replaced by whatever `providers()` last read, so
 * an instance is normalized the way the provider's descriptor says. A provider
 * no descriptor named yet reads as an origin, the form every self-hosted forge
 * uses.
 */
type InstanceFormat = SourceControlProviderDescriptor['instances']['format'];
const providerInstances = new Map<string, { format: InstanceFormat; label: string }>();

const rememberProviderInstances = (descriptors: readonly SourceControlProviderDescriptor[]): void => {
  for (const descriptor of descriptors) {
    providerInstances.set(descriptor.id, { format: descriptor.instances.format, label: descriptor.label });
  }
};
rememberProviderInstances(BUILT_IN_SOURCE_CONTROL_PROVIDERS);

const providerLabel = (identity: SourceControlIdentity): string => providerInstances.get(identity.provider)?.label ?? identity.provider;

const normalizeOriginInstance = (identity: SourceControlIdentity): SourceControlIdentity => {
  const raw = identity.instance.trim();
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    throw new Error(`Invalid source control instance: ${identity.instance}`);
  }
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== '/')
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
    throw new Error(`Invalid ${providerLabel(identity)} instance: ${identity.instance}`);
  }
  return { provider: identity.provider, instance: url.origin };
};

const normalizeHostInstance = (identity: SourceControlIdentity): SourceControlIdentity => {
  const value = identity.instance.trim().toLowerCase().replace(/\.$/, '');
  let host = value;
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
        || (url.pathname && url.pathname !== '/')) {
        throw new Error(`Invalid ${providerLabel(identity)} instance: ${identity.instance}`);
      }
      host = url.hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      throw new Error(`Invalid ${providerLabel(identity)} instance: ${identity.instance}`);
    }
  }
  return { provider: identity.provider, instance: host };
};

const normalizeIdentity = (identity: SourceControlIdentity): SourceControlIdentity => (
  (providerInstances.get(identity.provider)?.format ?? 'origin') === 'host'
    ? normalizeHostInstance(identity)
    : normalizeOriginInstance(identity)
);

const parseRepositoryContext = (payload: RepositoryContextDTO): SourceControlRepositoryContext => {
  if (!payload || !isStringValue(payload.repositoryId) || !payload.repositoryId
    || !isStringValue(payload.configRevision) || !payload.configRevision
    || Object.prototype.toString.call(payload.bare) !== '[object Boolean]' || !Array.isArray(payload.remotes)) {
    throw new Error('Source control response contained an invalid repository context');
  }
  const remotes = payload.remotes.map((remote) => {
    if (!remote || !isStringValue(remote.name) || !remote.name
      || !isSafeRepositoryEndpoint(remote.fetch) || !isSafeRepositoryEndpoint(remote.push)) {
      throw new Error('Source control response contained an invalid repository remote');
    }
    return {
      name: remote.name,
      fetch: { displayUrl: remote.fetch.displayUrl, fingerprint: remote.fetch.fingerprint },
      push: { displayUrl: remote.push.displayUrl, fingerprint: remote.push.fingerprint },
    };
  });
  return { repositoryId: payload.repositoryId, configRevision: payload.configRevision, bare: payload.bare, remotes };
};

const parseRepositoryBinding = (payload: RepositoryBindingDTO): SourceControlBindingRead => {
  const repository = parseRepositoryContext(payload.repository);
  if (!Number.isInteger(payload.revision) || payload.revision < 0) {
    throw new Error('Source control response contained an invalid binding revision');
  }
  if (payload.binding === null) return { status: 'missing', repository, revision: payload.revision, binding: null };
  const binding = parseBindingResponse(payload.binding);
  if (!binding || binding.repositoryId !== repository.repositoryId || binding.revision !== payload.revision
    || !isStringValue(binding.configRevision) || !Array.isArray(binding.providers) || !Array.isArray(binding.auxiliary)
    || (binding.state !== 'bound' && binding.state !== 'needs-attention')) {
    throw new Error('Source control response contained an invalid repository binding');
  }
  const parsedBinding = resolveBindingReadiness({ ...binding,
    providers: binding.providers.map((provider) => ({ ...provider, ...normalizeIdentity(provider) })),
  }, repository);
  return { status: parsedBinding.state, repository, revision: payload.revision, binding: parsedBinding };
};

const repositoryRequest = async <TResult extends ErrorResponse>(fetch: SourceControlFetch, path: string, directory: string): Promise<TResult> => {
  const response = await fetch(path, {
    query: new URLSearchParams({ directory }),
    headers: { Accept: 'application/json' },
  });
  const payload: TResult = await response.json();
  if (!response.ok) throw new SourceControlRequestError(payload.error || response.statusText || 'Source control repository request failed', payload.code);
  return payload;
};

export const configureWebTransportBinding = async (
  intent: GitTransportBindingIntent,
  fetch: SourceControlFetch = runtimeFetch,
): Promise<GitTransportBindingResult> => {
  const response = await fetch('/api/source-control/binding/transport', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
  const payload: RepositoryBindingDTO = await response.json();
  if (!response.ok) throw new SourceControlRequestError(payload.error || 'Git transport configuration failed', payload.code);
  return { status: 'configured', binding: parseRepositoryBinding(payload) };
};

export const removeWebTransportBinding = async (
  intent: GitTransportBindingRemovalIntent,
  fetch: SourceControlFetch = runtimeFetch,
): Promise<GitTransportBindingRemovalResult> => {
  const response = await fetch('/api/source-control/binding/transport/remove', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
  const payload: RepositoryBindingDTO = await response.json();
  if (!response.ok) throw new SourceControlRequestError(payload.error || 'Git transport removal failed', payload.code);
  return { status: 'removed', binding: parseRepositoryBinding(payload) };
};

export const configureWebAuxiliaryBinding = async (
  intent: GitAuxiliaryBindingIntent,
  fetch: SourceControlFetch = runtimeFetch,
): Promise<GitAuxiliaryBindingResult> => {
  const response = await fetch('/api/source-control/binding/auxiliary', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(intent),
  });
  const payload: RepositoryBindingDTO = await response.json();
  if (!response.ok) throw new SourceControlRequestError(payload.error || 'Git auxiliary transport configuration failed', payload.code);
  return { status: 'configured', binding: parseRepositoryBinding(payload) };
};

const request = async <TResult extends ErrorResponse | null>(
  fetch: SourceControlFetch,
  identity: SourceControlIdentity,
  path: string,
  init: RequestInit = {},
  query?: URLSearchParams,
): Promise<TResult> => {
  const normalized = normalizeIdentity(identity);
  const response = await fetch(providerPath(normalized, path), {
    ...init,
    query: new URLSearchParams([
      ['instance', normalized.instance],
      ...(query ? Array.from(query.entries()) : []),
    ]),
    headers: { Accept: 'application/json', ...init.headers },
  });
  const payload: TResult = await response.json();
  if (!response.ok) {
    throw new SourceControlRequestError(payload?.error || response.statusText || 'Source control request failed', payload?.code);
  }
  return payload;
};

const boundReadQuery = (context: SourceControlReadContext): URLSearchParams => new URLSearchParams({
  directory: context.directory,
  repositoryId: context.repositoryId,
  accountId: context.accountId,
  bindingRevision: String(context.bindingRevision),
  primaryRemote: context.primaryRemote,
});

/** The projects a multi-project list could not read; their earlier items stay where the caller keeps them. */
const parseIncompleteProjectIds = (ids: PageResult<never>['incompleteProjectIds']): string[] | undefined => {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.some((id) => !isNonEmptyString(id))) {
    throw new Error('Source control response contained invalid incomplete projects');
  }
  return [...ids];
};

const post = <TResult extends ErrorResponse>(
  fetch: SourceControlFetch,
  identity: SourceControlIdentity,
  path: string,
  body: PostBody,
): Promise<TResult> => request<TResult>(fetch, identity, path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

type ExactKeyValue = MutationReceiptDTO
  | MutationReceiptDTO['actor']
  | MutationReceiptDTO['target']
  | MutationReceiptDTO['target']['project']
  | MutationResultDTO;

const hasExactKeys = (value: ExactKeyValue, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

function mutationBody(
  payload: SourceControlMutationContext<SourceControlCreateMutationTarget>,
  identity: SourceControlIdentity,
  operation: 'create',
): MutationBody<SourceControlCreateMutationTarget>;
function mutationBody(
  payload: SourceControlMutationContext<SourceControlExistingMutationTarget>,
  identity: SourceControlIdentity,
  operation: 'existing',
): MutationBody<SourceControlExistingMutationTarget>;
function mutationBody(
  payload: SourceControlMutationContext,
  identity: SourceControlIdentity,
  operation: 'create' | 'existing',
): MutationBody {
  const target = payload.target;
  if (!isNonEmptyString(payload.directory) || !isNonEmptyString(payload.repositoryId)
    || !isNonEmptyString(payload.accountId) || !isNonNegativeSafeInteger(payload.bindingRevision)
    || !isNonEmptyString(payload.primaryRemote) || !isNonEmptyString(payload.idempotencyKey)
    || !target || !isNonEmptyString(target.project?.owner) || !isNonEmptyString(target.project?.name)
    || (operation === 'create' && ('number' in target || 'headSha' in target))
    || (operation === 'create' && (!isNonEmptyString(target.head) || !isNonEmptyString(target.base)))
    || (operation === 'existing' && !isPositiveSafeInteger(target.number))
    || (target.number !== undefined && !isPositiveSafeInteger(target.number))
    || (target.head !== undefined && !isNonEmptyString(target.head))
    || (target.base !== undefined && !isNonEmptyString(target.base))
    || (target.headSha !== undefined && !isNonEmptyString(target.headSha))) {
    throw new Error('Source control mutation context is invalid');
  }
  const context = {
    ...identity,
    directory: payload.directory,
    repositoryId: payload.repositoryId,
    accountId: payload.accountId,
    bindingRevision: payload.bindingRevision,
    primaryRemote: payload.primaryRemote,
    idempotencyKey: payload.idempotencyKey,
  };
  if (operation === 'create') {
    if (!isNonEmptyString(target.head) || !isNonEmptyString(target.base)) {
      throw new Error('Source control mutation context is invalid');
    }
    return {
      ...context,
      target: {
        project: { owner: target.project.owner, name: target.project.name },
        head: target.head,
        base: target.base,
      },
    };
  }
  if (!isPositiveSafeInteger(target.number)) {
    throw new Error('Source control mutation context is invalid');
  }
  const expectedTarget: SourceControlExistingMutationTarget = {
    project: { owner: target.project.owner, name: target.project.name },
    number: target.number,
  };
  if (target.head !== undefined) expectedTarget.head = target.head;
  if (target.base !== undefined) expectedTarget.base = target.base;
  if (target.headSha !== undefined) expectedTarget.headSha = target.headSha;
  return { ...context, target: expectedTarget };
}

const mutationTargetMatches = (
  target: MutationReceiptDTO['target'],
  context: SourceControlMutationContext,
): boolean => target.repositoryId === context.repositoryId
  && target.bindingRevision === context.bindingRevision
  && target.primaryRemote === context.primaryRemote
  && target.project.owner === context.target.project.owner
  && target.project.name === context.target.project.name
  && (context.target.number === undefined || target.number === context.target.number)
  && (context.target.head === undefined || target.head === context.target.head)
  && (context.target.base === undefined || target.base === context.target.base)
  && (context.target.headSha === undefined || target.headSha === context.target.headSha);

/** A provider user is `<instance>#<numeric user id>` on every provider, host and origin instances alike. */
const providerAccountMatches = (identity: SourceControlIdentity, providerAccountId: string): boolean => (
  providerAccountId.startsWith(`${identity.instance}#`)
    && /^\d+$/.test(providerAccountId.slice(identity.instance.length + 1))
);

const parseMutationReceipt = <TResult>(
  payload: MutationReceiptDTO,
  context: SourceControlMutationContext,
  identity: SourceControlIdentity,
  parseResult: (result: MutationResultDTO) => TResult,
): SourceControlMutationReceipt<TResult> => {
  const actor = payload?.actor;
  const target = payload?.target;
  const project = target?.project;
  if (!payload || !hasExactKeys(payload, ['status', 'actor', 'target', 'replayed', 'result'])
    || payload.status !== 'succeeded' || !isBooleanValue(payload.replayed)
    || !actor || !hasExactKeys(actor, ['provider', 'instance', 'providerAccountId'])
    || actor.provider !== identity.provider || actor.instance !== identity.instance
    || !isNonEmptyString(actor.providerAccountId) || !providerAccountMatches(identity, actor.providerAccountId)
    || !target || !hasExactKeys(target, [
      'repositoryId', 'bindingRevision', 'primaryRemote', 'project',
      ...(['number', 'head', 'base', 'headSha'] as const).filter((key) => target[key] !== undefined),
    ])
    || !isNonEmptyString(target.repositoryId) || !isNonNegativeSafeInteger(target.bindingRevision)
    || !isNonEmptyString(target.primaryRemote) || !project || !hasExactKeys(project, ['id', 'owner', 'name'])
    || !isNonEmptyString(project.id) || !isNonEmptyString(project.owner) || !isNonEmptyString(project.name)
    || (target.number !== undefined && !isPositiveSafeInteger(target.number))
    || (target.head !== undefined && !isNonEmptyString(target.head))
    || (target.base !== undefined && !isNonEmptyString(target.base))
    || (target.headSha !== undefined && !isNonEmptyString(target.headSha))
    || !mutationTargetMatches(target, context)
    || !payload.result || Object.prototype.toString.call(payload.result) !== '[object Object]') {
    throw new Error('Source control response contained an invalid mutation receipt');
  }
  const resolvedTarget: SourceControlResolvedMutationTarget = {
    repositoryId: target.repositoryId,
    bindingRevision: target.bindingRevision,
    primaryRemote: target.primaryRemote,
    project: { id: project.id, owner: project.owner, name: project.name },
  };
  if (target.number !== undefined) resolvedTarget.number = target.number;
  if (target.head !== undefined) resolvedTarget.head = target.head;
  if (target.base !== undefined) resolvedTarget.base = target.base;
  if (target.headSha !== undefined) resolvedTarget.headSha = target.headSha;
  return {
    status: 'succeeded',
    actor: { ...identity, providerAccountId: actor.providerAccountId },
    target: resolvedTarget,
    replayed: payload.replayed,
    result: parseResult(payload.result),
  };
};

const parseEmptyMutationResult = (result: MutationResultDTO): SourceControlEmptyMutationResult => {
  if (!hasExactKeys(result, [])) throw new Error('Source control response contained an invalid mutation result');
  return {};
};

const MERGE_OUTCOMES = ['queued', 'merging'] as const;
const mergeOutcomeOf = (value: string): SourceControlMergeMutationResult['outcome'] | null => (
  MERGE_OUTCOMES.find((outcome) => outcome === value) ?? null
);

const parseCreateMutationResult = (result: MutationResultDTO): SourceControlCreateMutationResult => {
  if (!hasExactKeys(result, result.stacked === undefined ? [] : ['stacked'])
    || (result.stacked !== undefined && !isBooleanValue(result.stacked))) {
    throw new Error('Source control response contained an invalid create result');
  }
  return result.stacked === undefined ? {} : { stacked: result.stacked };
};

const parseMergeMutationResult = (result: MutationResultDTO): SourceControlMergeMutationResult => {
  const keys = ['merged', ...(result.message === undefined ? [] : ['message']), ...(result.outcome === undefined ? [] : ['outcome'])];
  const outcome = result.outcome === undefined ? undefined : mergeOutcomeOf(result.outcome);
  if (!hasExactKeys(result, keys) || !isBooleanValue(result.merged)
    || (result.message !== undefined && !isStringValue(result.message)) || outcome === null) {
    throw new Error('Source control response contained an invalid merge result');
  }
  const parsed: SourceControlMergeMutationResult = { merged: result.merged };
  if (result.message !== undefined) parsed.message = result.message;
  if (outcome !== undefined) parsed.outcome = outcome;
  return parsed;
};

const parseReviewMutationResult = (result: MutationResultDTO): SourceControlReviewMutationResult => {
  if (!hasExactKeys(result, ['commented']) || !isBooleanValue(result.commented)) {
    throw new Error('Source control response contained an invalid review result');
  }
  return { commented: result.commented };
};

interface RepositoryChoicesDTO extends ErrorResponse {
  connected?: boolean;
  items?: Array<{ name?: string; color?: string; id?: string; login?: string; avatarUrl?: string }>;
}

/** Labels or reviewer candidates of one project in the bound repository's network. */
const readRepositoryChoices = async (
  fetch: SourceControlFetch,
  context: SourceControlReadContext,
  project: RepositorySelector,
  path: string,
): Promise<NonNullable<RepositoryChoicesDTO['items']>> => {
  const identity = normalizeIdentity(context);
  const query = boundReadQuery(context);
  query.set('owner', project.owner);
  query.set('repo', project.repo);
  const payload = await request<RepositoryChoicesDTO>(fetch, identity, path, {}, query);
  if (payload.connected !== true) throw new Error(`${providerLabel(identity)} is not connected`);
  if (!Array.isArray(payload.items)) throw new Error('Source control response contained an invalid list');
  return payload.items;
};

const parseLabelChoices = (items: NonNullable<RepositoryChoicesDTO['items']>): Label[] => items.map((item) => {
  if (!isNonEmptyString(item.name) || (item.color !== undefined && !isStringValue(item.color))) {
    throw new Error('Source control response contained an invalid label');
  }
  return item.color ? { name: item.name, color: item.color } : { name: item.name };
});

const parseReviewerChoices = (items: NonNullable<RepositoryChoicesDTO['items']>): RepositoryReferenceReviewer[] => items.map((item) => {
  if (!isNonEmptyString(item.id) || !isNonEmptyString(item.login) || (item.avatarUrl !== undefined && !isHttpUrl(item.avatarUrl))) {
    throw new Error('Source control response contained an invalid user');
  }
  return item.avatarUrl ? { id: item.id, login: item.login, avatarUrl: item.avatarUrl } : { id: item.id, login: item.login };
});

const parseStateMutationResult = (result: MutationResultDTO): SourceControlStateMutationResult => {
  if (!hasExactKeys(result, ['state']) || (result.state !== 'open' && result.state !== 'closed')) {
    throw new Error('Source control response contained an invalid state result');
  }
  return { state: result.state };
};

const parseReadyMutationResult = (result: MutationResultDTO): SourceControlReadyMutationResult => {
  if (!hasExactKeys(result, ['ready']) || !isBooleanValue(result.ready)) {
    throw new Error('Source control response contained an invalid ready result');
  }
  return { ready: result.ready };
};

const parseSourceUser = (user: SourceUserDTO, identity: SourceControlIdentity): SourceControlUser => {
  const username = user?.username || user?.login;
  if (!user || !isValidId(user.id) || !isNonEmptyString(username)
    || !hasCompatibleIdentity(user, identity)
    || (user.avatarUrl !== undefined && !isHttpUrl(user.avatarUrl))
    || (user.name !== undefined && !isStringValue(user.name))
    || (user.email !== undefined && !isStringValue(user.email))) {
    throw new Error('Source control response contained an invalid user');
  }
  const result: SourceControlUser = { ...identity, id: String(user.id), username };
  if (user.avatarUrl) result.avatarUrl = user.avatarUrl;
  if (user.name) result.name = user.name;
  if (user.email) result.email = user.email;
  return result;
};

const parseSourceProject = (project: Project, identity: SourceControlIdentity): Project => {
  if (!project || !isValidId(project.id) || !isNonEmptyString(project.owner) || !isNonEmptyString(project.name)
    || !isHttpUrl(project.url) || !hasMatchingIdentity(project, identity)
    || (project.cloneUrl !== undefined && !isNonEmptyString(project.cloneUrl))
    || (project.sshUrl !== undefined && !isNonEmptyString(project.sshUrl))
    || (project.defaultBranch !== undefined && !isNonEmptyString(project.defaultBranch))
    || (project.defaultBranchSha !== undefined && project.defaultBranchSha !== null && !isNonEmptyString(project.defaultBranchSha))
    || (project.remoteName !== undefined && project.remoteName !== null && !isNonEmptyString(project.remoteName))) {
    throw new Error('Source control response contained an invalid project');
  }
  const result: Project = { ...identity, id: String(project.id), owner: project.owner, name: project.name, url: project.url };
  if (project.cloneUrl) result.cloneUrl = project.cloneUrl;
  if (project.sshUrl) result.sshUrl = project.sshUrl;
  if (project.defaultBranch) result.defaultBranch = project.defaultBranch;
  if (project.defaultBranchSha !== undefined) result.defaultBranchSha = project.defaultBranchSha;
  if (project.remoteName !== undefined) result.remoteName = project.remoteName;
  return result;
};

const parseSourceCI = (ci: CI | null | undefined, identity: SourceControlIdentity): CI | null => {
  if (ci === null || ci === undefined) return null;
  if (!ci.summary) throw new Error('Source control response contained an invalid CI summary');
  validateCISummary(ci.summary);
  if (ci.runs !== undefined) {
    if (!Array.isArray(ci.runs) || ci.runs.some((run) => !run || !isValidId(run.id)
      || !isNonEmptyString(run.name) || !hasMatchingIdentity(run, identity)
      || (run.detailsUrl !== undefined && !isHttpUrl(run.detailsUrl)))) {
      throw new Error('Source control response contained invalid CI runs');
    }
    for (const run of ci.runs) {
      if ((run.startedAt !== undefined && !isNonEmptyString(run.startedAt))
        || (run.completedAt !== undefined && !isNonEmptyString(run.completedAt))
        || (run.status !== undefined && !isNonEmptyString(run.status))
        || (run.conclusion !== undefined && run.conclusion !== null && !isStringValue(run.conclusion))) {
        throw new Error('Source control response contained invalid CI run fields');
      }
      if (run.application !== undefined && (Object.prototype.toString.call(run.application) !== '[object Object]'
        || (run.application.name !== undefined && !isStringValue(run.application.name))
        || (run.application.slug !== undefined && !isStringValue(run.application.slug)))) {
        throw new Error('Source control response contained an invalid CI application');
      }
      if (run.job !== undefined && (Object.prototype.toString.call(run.job) !== '[object Object]'
        || (run.job.runId !== undefined && !isValidId(run.job.runId))
        || (run.job.jobId !== undefined && !isValidId(run.job.jobId))
        || (run.job.url !== undefined && !isHttpUrl(run.job.url))
        || (run.job.name !== undefined && !isStringValue(run.job.name))
        || (run.job.workflowName !== undefined && !isStringValue(run.job.workflowName))
        || (run.job.conclusion !== undefined && run.job.conclusion !== null && !isStringValue(run.job.conclusion)))) {
        throw new Error('Source control response contained an invalid CI job');
      }
      if (run.job?.steps !== undefined && (!Array.isArray(run.job.steps) || run.job.steps.some((step) => !step
        || !isNonEmptyString(step.name)
        || (step.status !== undefined && !isStringValue(step.status))
        || (step.conclusion !== undefined && step.conclusion !== null && !isStringValue(step.conclusion))
        || (step.number !== undefined && (!Number.isInteger(step.number) || step.number < 0))
        || (step.startedAt !== undefined && !isNonEmptyString(step.startedAt))
        || (step.completedAt !== undefined && !isNonEmptyString(step.completedAt))))) {
        throw new Error('Source control response contained invalid CI steps');
      }
      if (run.output !== undefined && (Object.prototype.toString.call(run.output) !== '[object Object]'
        || (run.output.title !== undefined && !isStringValue(run.output.title))
        || (run.output.summary !== undefined && !isStringValue(run.output.summary))
        || (run.output.text !== undefined && !isStringValue(run.output.text)))) {
        throw new Error('Source control response contained invalid CI output');
      }
      if (run.annotations !== undefined && (!Array.isArray(run.annotations) || run.annotations.some((annotation) => !annotation
        || !isNonEmptyString(annotation.message)
        || (annotation.path !== undefined && !isStringValue(annotation.path))
        || (annotation.startLine !== undefined && (!Number.isInteger(annotation.startLine) || annotation.startLine < 0))
        || (annotation.endLine !== undefined && (!Number.isInteger(annotation.endLine) || annotation.endLine < 0))
        || (annotation.level !== undefined && !isStringValue(annotation.level))
        || (annotation.title !== undefined && !isStringValue(annotation.title))
        || (annotation.rawDetails !== undefined && !isStringValue(annotation.rawDetails))))) {
        throw new Error('Source control response contained invalid CI annotations');
      }
    }
  }
  return {
    summary: {
      state: ci.summary.state,
      total: ci.summary.total,
      success: ci.summary.success,
      failure: ci.summary.failure,
      pending: ci.summary.pending,
      inProgress: ci.summary.inProgress,
      queued: ci.summary.queued,
      startedAt: ci.summary.startedAt,
    },
    runs: ci.runs?.map((run) => ({
      ...identity,
      id: String(run.id),
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      detailsUrl: run.detailsUrl,
      application: run.application,
      job: run.job,
      output: run.output,
      annotations: run.annotations,
    })),
  };
};

const parseSourceChangeRequest = (request: ChangeRequest, identity: SourceControlIdentity): ChangeRequest => {
  if (!request || !isValidId(request.id) || !Number.isInteger(request.number) || request.number < 1
    || !isNonEmptyString(request.title) || !isHttpUrl(request.url)
    || !['open', 'closed', 'merged'].includes(request.state)
    || !isBooleanValue(request.draft)
    || !isNonEmptyString(request.base) || !isNonEmptyString(request.head)
    || !hasMatchingIdentity(request, identity)
    || (request.body !== undefined && !isStringValue(request.body))
    || (request.headSha !== undefined && !isNonEmptyString(request.headSha))
    || (request.author !== undefined && request.author !== null && !hasMatchingIdentity(request.author, identity))
    || (request.createdAt !== undefined && !isNonEmptyString(request.createdAt))
    || (request.updatedAt !== undefined && !isNonEmptyString(request.updatedAt))
    || (request.headLabel !== undefined && !isNonEmptyString(request.headLabel))
    || (request.mergeable !== undefined && request.mergeable !== null && !isBooleanValue(request.mergeable))
    || (request.mergeableState !== undefined && request.mergeableState !== null && !isStringValue(request.mergeableState))
    || (request.labels !== undefined && (!Array.isArray(request.labels) || request.labels.some((label) => !label
      || !isNonEmptyString(label.name) || (label.color !== undefined && !isStringValue(label.color)))))) {
    throw new Error('Source control response contained an invalid change request');
  }
  const result: ChangeRequest = {
    ...identity,
    id: String(request.id),
    number: request.number,
    project: parseSourceProject(request.project, identity),
    title: request.title,
    url: request.url,
    state: request.state,
    draft: request.draft,
    base: request.base,
    head: request.head,
  };
  if (request.body !== undefined) result.body = request.body;
  if (request.headSha) result.headSha = request.headSha;
  if (request.author !== undefined && request.author !== null) result.author = parseSourceUser(request.author, identity);
  if (request.createdAt) result.createdAt = request.createdAt;
  if (request.updatedAt) result.updatedAt = request.updatedAt;
  if (request.headLabel) result.headLabel = request.headLabel;
  if (request.headProject !== undefined && request.headProject !== null) {
    result.headProject = parseSourceProject(request.headProject, identity);
  }
  if (request.mergeable !== undefined) result.mergeable = request.mergeable;
  if (request.mergeableState !== undefined) result.mergeableState = request.mergeableState;
  if (request.labels !== undefined) result.labels = request.labels.map((label) => ({ name: label.name, color: label.color }));
  return result;
};

const parseSourceIssue = (issue: Issue, identity: SourceControlIdentity): Issue => {
  if (!issue || !isValidId(issue.id) || !Number.isInteger(issue.number) || issue.number < 1
    || !isNonEmptyString(issue.title) || !isHttpUrl(issue.url)
    || (issue.state !== 'open' && issue.state !== 'closed') || !hasMatchingIdentity(issue, identity)
    || (issue.body !== undefined && !isStringValue(issue.body))
    || (issue.author !== undefined && issue.author !== null && !hasMatchingIdentity(issue.author, identity))
    || (issue.createdAt !== undefined && !isNonEmptyString(issue.createdAt))
    || (issue.updatedAt !== undefined && !isNonEmptyString(issue.updatedAt))) {
    throw new Error('Source control response contained an invalid issue');
  }
  if (issue.assignees !== undefined && (!Array.isArray(issue.assignees)
    || issue.assignees.some((user) => !hasMatchingIdentity(user, identity)))) {
    throw new Error('Source control response contained invalid issue assignees');
  }
  if (issue.labels !== undefined && (!Array.isArray(issue.labels) || issue.labels.some((label) => !label
    || !isNonEmptyString(label.name) || (label.color !== undefined && !isStringValue(label.color))))) {
    throw new Error('Source control response contained invalid issue labels');
  }
  const result: Issue = {
    ...identity,
    id: String(issue.id),
    number: issue.number,
    project: parseSourceProject(issue.project, identity),
    title: issue.title,
    url: issue.url,
    state: issue.state,
  };
  if (issue.body !== undefined) result.body = issue.body;
  if (issue.author !== undefined) result.author = issue.author ? parseSourceUser(issue.author, identity) : null;
  if (issue.assignees !== undefined) result.assignees = issue.assignees.map((user) => parseSourceUser(user, identity));
  if (issue.labels !== undefined) result.labels = issue.labels.map((label) => ({ name: label.name, color: label.color }));
  if (issue.createdAt) result.createdAt = issue.createdAt;
  if (issue.updatedAt) result.updatedAt = issue.updatedAt;
  return result;
};

const parseSourceCommit = (commit: ChangeRequestCommit): ChangeRequestCommit => {
  if (!commit || !isNonEmptyString(commit.sha) || !isStringValue(commit.headline)
    || (commit.authorName !== null && !isStringValue(commit.authorName))
    || (commit.committedAt !== null && !isNonEmptyString(commit.committedAt))
    || (commit.url !== null && !isHttpUrl(commit.url))) {
    throw new Error('Source control response contained an invalid commit');
  }
  return { sha: commit.sha, headline: commit.headline, authorName: commit.authorName, committedAt: commit.committedAt, url: commit.url };
};

const STACK_LAYER_STATES = ['open', 'closed', 'merged'] as const;

/** A merge request chain as the server read it; its layers are bottom first. */
const parseSourceStack = (stack: PullRequestStack): PullRequestStack => {
  if (!stack || !isNonEmptyString(stack.base) || !Array.isArray(stack.layers)
    || (stack.number !== null && !Number.isSafeInteger(stack.number))) {
    throw new Error('Source control response contained an invalid merge request chain');
  }
  return {
    number: stack.number,
    base: stack.base,
    layers: stack.layers.map((layer) => {
      const state = STACK_LAYER_STATES.find((candidate) => candidate === layer?.state);
      if (!layer || !Number.isSafeInteger(layer.number) || !isStringValue(layer.title) || !isHttpUrl(layer.url)
        || !state || !isBooleanValue(layer.draft) || !isNonEmptyString(layer.head)) {
        throw new Error('Source control response contained an invalid merge request chain');
      }
      return { number: layer.number, title: layer.title, url: layer.url, state, draft: layer.draft, head: layer.head };
    }),
  };
};

/** The stack a context names; one that does not hold together is unknown, never a failed read of the rest. */
const parseOptionalStack = (stack: PullRequestStack): PullRequestStack | undefined => {
  try {
    return parseSourceStack(stack);
  } catch {
    return undefined;
  }
};

const parseSourceVerdict = (verdict: ChangeRequestVerdict, identity: SourceControlIdentity): ChangeRequestVerdict => {
  if (!verdict || (verdict.state !== 'approved' && verdict.state !== 'changes_requested') || !isNonEmptyString(verdict.url)
    || (verdict.createdAt !== null && !isNonEmptyString(verdict.createdAt))) {
    throw new Error('Source control response contained an invalid review verdict');
  }
  const result: ChangeRequestVerdict = { state: verdict.state, url: verdict.url, createdAt: verdict.createdAt };
  if (verdict.author) result.author = parseSourceUser(verdict.author, identity);
  return result;
};

const parseSourceComment = (comment: IssueComment, identity: SourceControlIdentity): IssueComment => {
  if (!comment || !isValidId(comment.id) || !isNonEmptyString(comment.url) || !isStringValue(comment.body)
    || !hasMatchingIdentity(comment, identity)
    || (comment.author !== undefined && comment.author !== null && !hasMatchingIdentity(comment.author, identity))
    || (comment.createdAt !== undefined && !isNonEmptyString(comment.createdAt))
    || (comment.updatedAt !== undefined && !isNonEmptyString(comment.updatedAt))) {
    throw new Error('Source control response contained an invalid comment');
  }
  const thread = comment.thread;
  if (thread !== undefined && (!thread || !isValidId(thread.id) || !isBooleanValue(thread.resolved)
    || !isBooleanValue(thread.resolvable) || !isBooleanValue(thread.first)
    || (thread.canResolve !== undefined && !isBooleanValue(thread.canResolve))
    || (thread.canReply !== undefined && !isBooleanValue(thread.canReply)))) {
    throw new Error('Source control response contained an invalid comment thread');
  }
  const result: IssueComment = { ...identity, id: String(comment.id), url: comment.url, body: comment.body };
  if (thread) {
    result.thread = { id: String(thread.id), resolved: thread.resolved, resolvable: thread.resolvable, first: thread.first };
    if (thread.canResolve !== undefined) result.thread.canResolve = thread.canResolve;
    if (thread.canReply !== undefined) result.thread.canReply = thread.canReply;
  }
  if (comment.author) result.author = parseSourceUser(comment.author, identity);
  if (comment.createdAt) result.createdAt = comment.createdAt;
  if (comment.updatedAt) result.updatedAt = comment.updatedAt;
  return result;
};

type BoundaryScalar = string | number | boolean | null | undefined;
const isStringValue = (value: BoundaryScalar): value is string => Object.prototype.toString.call(value) === '[object String]';
const isBooleanValue = (value: BoundaryScalar): value is boolean => Object.prototype.toString.call(value) === '[object Boolean]';
const isNumberValue = (value: BoundaryScalar): value is number => Object.prototype.toString.call(value) === '[object Number]';
const isNonEmptyString = (value: BoundaryScalar): value is string => isStringValue(value) && value.trim().length > 0;
const isPositiveSafeInteger = (value: BoundaryScalar): value is number => isNumberValue(value) && Number.isSafeInteger(value) && value >= 1;
// A binding revision of 0 is the unbound repository, read with the account the client is signed in to.
const isNonNegativeSafeInteger = (value: BoundaryScalar): value is number => isNumberValue(value) && Number.isSafeInteger(value) && value >= 0;
const isValidId = (value: string | number | undefined): boolean => isNonEmptyString(value) || Number.isFinite(value);
const isHttpUrl = (value: BoundaryScalar): value is string => {
  if (!isNonEmptyString(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};
const hasMatchingIdentity = (
  value: { provider?: string; instance?: string } | null | undefined,
  identity: SourceControlIdentity,
): boolean => value?.provider === identity.provider && value.instance === identity.instance;
const hasCompatibleIdentity = (
  value: { provider?: string; instance?: string },
  identity: SourceControlIdentity,
): boolean => value.provider === undefined && value.instance === undefined
  ? true
  : hasMatchingIdentity(value, identity);
const parsePageFields = (page: number | undefined, hasMore: boolean | undefined): Pick<PageResult<never>, 'page' | 'hasMore'> => {
  if (!isNumberValue(page) || !Number.isInteger(page) || page < 1 || !isBooleanValue(hasMore)) {
    throw new Error('Source control response contained invalid pagination');
  }
  return { page, hasMore };
};
/** A page of a list, with the projects it could not read when the server named any. */
const parsePage = <TItem>(payload: PageResult<TItem>, items: TItem[]): PageResult<TItem> => {
  const result: PageResult<TItem> = { items, ...parsePageFields(payload.page, payload.hasMore) };
  const incompleteProjectIds = parseIncompleteProjectIds(payload.incompleteProjectIds);
  if (incompleteProjectIds?.length) result.incompleteProjectIds = incompleteProjectIds;
  return result;
};
const parseBranches = (payload: BranchesDTO): string[] => {
  if (!payload || !Array.isArray(payload.branches) || payload.branches.some((branch) => !isNonEmptyString(branch))) {
    throw new Error('Source control response contained invalid branches');
  }
  return [...payload.branches];
};
const validateCISummary = (summary: CISummary | CI['summary']): void => {
  if (!['success', 'failure', 'pending', 'unknown'].includes(summary.state)
    || !Number.isInteger(summary.total) || summary.total < 0
    || !Number.isInteger(summary.success) || summary.success < 0
    || !Number.isInteger(summary.failure) || summary.failure < 0
    || !Number.isInteger(summary.pending) || summary.pending < 0
    || (summary.inProgress !== undefined && (!Number.isInteger(summary.inProgress) || summary.inProgress < 0))
    || (summary.queued !== undefined && (!Number.isInteger(summary.queued) || summary.queued < 0))
    || (summary.startedAt !== undefined && !isNonEmptyString(summary.startedAt))) {
    throw new Error('Source control response contained an invalid CI summary');
  }
};

const parseSourceChangeRequestStatus = (
  payload: ChangeRequestStatus,
  identity: SourceControlIdentity,
  requestedBranch: string,
): ChangeRequestStatus => {
  if (!payload || !hasMatchingIdentity(payload.identity, identity)
    || !isNonEmptyString(payload.branch) || payload.branch !== requestedBranch
    || payload.project === undefined || payload.changeRequest === undefined
    || (payload.fetchedAt !== undefined && (!Number.isFinite(payload.fetchedAt) || payload.fetchedAt < 0))
    || (payload.canMerge !== undefined && !isBooleanValue(payload.canMerge))
    || (payload.defaultBranch !== undefined && payload.defaultBranch !== null && !isNonEmptyString(payload.defaultBranch))
    || (payload.resolvedRemoteName !== undefined && payload.resolvedRemoteName !== null && !isNonEmptyString(payload.resolvedRemoteName))) {
    throw new Error('Source control response contained an invalid change request status');
  }
  const result: ChangeRequestStatus = {
    identity,
    project: payload.project === null ? null : parseSourceProject(payload.project, identity),
    branch: payload.branch,
    changeRequest: payload.changeRequest === null ? null : parseSourceChangeRequest(payload.changeRequest, identity),
  };
  if (payload.ci !== undefined) result.ci = parseSourceCI(payload.ci, identity);
  if (payload.canMerge !== undefined) result.canMerge = payload.canMerge;
  if (payload.defaultBranch !== undefined) result.defaultBranch = payload.defaultBranch;
  if (payload.resolvedRemoteName !== undefined) result.resolvedRemoteName = payload.resolvedRemoteName;
  if (payload.fetchedAt !== undefined) result.fetchedAt = payload.fetchedAt;
  return result;
};

const parseAuthAccounts = (
  accounts: SourceControlAuthAccount[] | undefined,
  identity: SourceControlIdentity,
): SourceControlAuthAccount[] => (accounts ?? []).map((account) => {
  if (!isNonEmptyString(account.id) || account.id !== account.credentialId
    || !isPositiveSafeInteger(account.credentialRevision) || !isNonEmptyString(account.providerUserId)
    || !['available', 'unavailable'].includes(account.providerUserStatus)
    || !isBooleanValue(account.current) || !['oauth', 'pat', 'cli'].includes(account.source)
    || !['valid', 'invalid'].includes(account.status)) {
    throw new Error('Source control response contained an invalid auth credential');
  }
  return {
    id: account.id,
    credentialId: account.credentialId,
    credentialRevision: account.credentialRevision,
    providerUserId: account.providerUserId,
    providerUserStatus: account.providerUserStatus,
    user: parseSourceUser(account.user, identity),
    scope: account.scope,
    current: account.current,
    source: account.source,
    status: account.status,
  };
});

const parseProviderAuthStatus = (payload: ProviderAuthStatusDTO, identity: SourceControlIdentity): SourceControlAuthStatus => {
  if (!payload.connected) {
    if (!payload.status) {
      const result: Extract<SourceControlAuthStatus, { status: 'disconnected' }> = {
        ...identity,
        status: 'disconnected',
        connected: false,
      };
      if (payload.cli) {
        result.cli = {
          available: payload.cli.available,
          disabled: payload.cli.disabled,
          active: payload.cli.active,
          user: payload.cli.user ? parseSourceUser(payload.cli.user, identity) : undefined,
        };
      }
      result.accounts = parseAuthAccounts(payload.accounts, identity);
      return result;
    }
    return { ...payload, ...identity, connected: false, accounts: parseAuthAccounts(payload.accounts, identity) };
  }
  return {
    ...identity,
    status: 'connected',
    connected: true,
    user: parseSourceUser(payload.user, identity),
    scope: payload.scope,
    accounts: parseAuthAccounts(payload.accounts, identity),
    cli: payload.cli ? {
      available: payload.cli.available,
      disabled: payload.cli.disabled,
      active: payload.cli.active,
      user: payload.cli.user ? parseSourceUser(payload.cli.user, identity) : undefined,
    } : undefined,
  };
};

export const createWebSourceControlAPI = (options: WebSourceControlAPIOptions = {}): SourceControlAPI => {
  const fetch = options.fetch ?? runtimeFetch;

  return {
    repositoryContext: async (directory) => parseRepositoryContext(await repositoryRequest<RepositoryContextDTO>(
      fetch, '/api/source-control/repository-context', directory,
    )),
    repositoryBinding: async (directory) => parseRepositoryBinding(await repositoryRequest<RepositoryBindingDTO>(
      fetch, '/api/source-control/binding', directory,
    )),
    resetRepositoryBinding: async (input: SourceControlRepositoryBindingResetIntent) => {
      const response = await fetch('/api/source-control/binding/reset', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const payload: RepositoryBindingDTO = await response.json();
      if (!response.ok) {
        throw new SourceControlRequestError(payload.error || response.statusText || 'Source control binding reset failed', payload.code);
      }
      return parseRepositoryBinding(payload);
    },
    repositoryProviderBindingMutate: async (input) => {
      const response = await fetch('/api/source-control/binding/provider', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const payload: RepositoryBindingDTO = await response.json();
      if (!response.ok) {
        throw new SourceControlRequestError(payload.error || response.statusText || 'Source control binding request failed', payload.code);
      }
      return parseRepositoryBinding(payload);
    },
    providers: async () => {
      const descriptors = await fetchSourceControlProviders(fetch);
      rememberProviderInstances(descriptors);
      return descriptors;
    },
    authInstances: async () => {
      const response = await fetch('/api/source-control/instances', { headers: { Accept: 'application/json' } });
      const payload: SourceControlInstancesResponse = await response.json();
      if (!response.ok) throw new Error(payload.error || response.statusText || 'Failed to list source control instances');
      return payload.instances.map(normalizeIdentity);
    },
    capabilities: async (identity): Promise<SourceControlCapabilities> => {
      const payload = await request<SourceControlCapabilities & ErrorResponse>(fetch, identity, '/capabilities');
      return {
        identity: normalizeIdentity(payload.identity),
        authentication: payload.authentication,
        authenticationMethods: payload.authenticationMethods,
        multipleAccounts: payload.multipleAccounts,
        projects: payload.projects,
        issues: payload.issues,
        changeRequests: payload.changeRequests,
        draftChangeRequests: payload.draftChangeRequests,
        mergeChangeRequests: payload.mergeChangeRequests,
        mergeMethods: payload.mergeMethods ? [...payload.mergeMethods] : undefined,
        ci: payload.ci,
      };
    },
    authStatus: async (identity) => {
      const normalized = normalizeIdentity(identity);
      return parseProviderAuthStatus(await request<ProviderAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/status'), normalized);
    },
    authStart: async (identity): Promise<SourceControlDeviceFlowStart> => {
      const payload = await request<DeviceFlowStartDTO & ErrorResponse>(fetch, identity, '/auth/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const result: SourceControlDeviceFlowStart = {
        flowId: payload.flowId,
        userCode: payload.userCode,
        verificationUri: payload.verificationUri,
        expiresIn: payload.expiresIn,
        interval: payload.interval,
      };
      if (payload.verificationUriComplete) result.verificationUriComplete = payload.verificationUriComplete;
      if (payload.scope) result.scope = payload.scope;
      return result;
    },
    authComplete: async (identity, flowId): Promise<SourceControlDeviceFlowComplete> => {
      let payload: DeviceFlowCompleteDTO & ErrorResponse;
      try {
        payload = await post<DeviceFlowCompleteDTO & ErrorResponse>(fetch, identity, '/auth/complete', { flowId });
      } catch (error) {
        if (error instanceof SourceControlRequestError && error.code === 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE') {
          return { status: 'error', code: 'expired', message: error.message };
        }
        throw error;
      }
      if (payload.connected) {
        const result: SourceControlDeviceFlowComplete = { status: 'connected', user: parseSourceUser(payload.user, normalizeIdentity(identity)) };
        if (payload.scope) result.scope = payload.scope;
        return result;
      }
      if (payload.status === 'authorization_pending' || payload.status === 'slow_down') {
        const result: SourceControlDeviceFlowComplete = { status: 'pending' };
        if (payload.status === 'slow_down') result.slowDown = true;
        return result;
      }
      let code: 'access-denied' | 'expired' | 'provider-error' = 'provider-error';
      if (payload.status === 'access_denied') {
        code = 'access-denied';
      } else if (payload.status === 'expired_token') {
        code = 'expired';
      }
      return { status: 'error', code, message: payload.error || payload.status || `${providerLabel(identity)} authentication failed` };
    },
    authSetToken: async (identity, token) => {
      const normalized = normalizeIdentity(identity);
      await post<ErrorResponse>(fetch, normalized, '/auth/token', { token });
      return parseProviderAuthStatus(await request<ProviderAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/status'), normalized);
    },
    authDisconnect: async (identity, accountId) => {
      if (!isNonEmptyString(accountId) || accountId.trim() !== accountId) {
        throw new Error('Source control credential accountId is required');
      }
      const query = new URLSearchParams({ accountId });
      const payload = await request<{ removed?: boolean; error?: string }>(fetch, identity, '/auth', { method: 'DELETE' }, query);
      if (!isBooleanValue(payload.removed)) {
        throw new Error('Source control response contained an invalid account removal result');
      }
      return { removed: payload.removed };
    },
    authActivate: async (identity, accountId) => {
      const normalized = normalizeIdentity(identity);
      return parseProviderAuthStatus(await post<ProviderAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/activate', { accountId }), normalized);
    },
    authSetCliDisabled: async (identity, disabled) => {
      const normalized = normalizeIdentity(identity);
      const payload = await post<{ disabled?: boolean; error?: string }>(fetch, normalized, '/auth/cli', { disabled });
      return { disabled: Boolean(payload.disabled) };
    },

    changeRequestStatus: async (context, branch, requestOptions): Promise<ChangeRequestStatus> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('branch', branch);
      if (requestOptions?.force) query.set('force', 'true');
      const payload = await request<ChangeRequestStatus & ErrorResponse>(fetch, normalized, '/pr/status', {}, query);
      return parseSourceChangeRequestStatus(payload, normalized, branch);
    },
    changeRequestCreate: async (payload: CreateChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const context = mutationBody(payload, identity, 'create');
      const body: CreateBody = {
        ...context,
        title: payload.title,
      };
      if (payload.body !== undefined) body.body = payload.body;
      if (payload.draft !== undefined) body.draft = payload.draft;
      if (payload.remote) body.remote = payload.remote;
      if (payload.headRemote) body.headRemote = payload.headRemote;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/create', body);
      return parseMutationReceipt(result, payload, identity, parseCreateMutationResult);
    },
    changeRequestUpdate: async (payload: UpdateChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const body: UpdateBody = { ...mutationBody(payload, identity, 'existing'), title: payload.title };
      if (payload.body !== undefined) body.body = payload.body;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/update', body);
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestMerge: async (payload: MergeChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/merge', {
        ...mutationBody(payload, identity, 'existing'), method: payload.method,
      });
      return parseMutationReceipt(result, payload, identity, parseMergeMutationResult);
    },
    changeRequestReady: async (payload: ReadyChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/ready', mutationBody(payload, identity, 'existing'));
      return parseMutationReceipt(result, payload, identity, parseReadyMutationResult);
    },
    changeRequestComment: async (payload: CommentInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/comment', {
        ...mutationBody(payload, identity, 'existing'), body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestStartThread: async (payload: CommentInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/thread/start', {
        ...mutationBody(payload, identity, 'existing'), body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestReplyToThread: async (payload: ThreadReplyInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/thread/reply', {
        ...mutationBody(payload, identity, 'existing'), threadId: payload.threadId, body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestResolveThread: async (payload: ThreadResolveInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/thread/resolve', {
        ...mutationBody(payload, identity, 'existing'), threadId: payload.threadId, resolved: payload.resolved,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestReview: async (payload: ReviewChangeRequestInput) => {
      const identity = normalizeIdentity(payload);
      const body: MutationBody<SourceControlExistingMutationTarget> & { verdict: ReviewChangeRequestInput['verdict']; body?: string } = {
        ...mutationBody(payload, identity, 'existing'), verdict: payload.verdict,
      };
      if (payload.body !== undefined) body.body = payload.body;
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/review', body);
      return parseMutationReceipt(result, payload, identity, parseReviewMutationResult);
    },
    changeRequestSetState: async (payload: SetStateInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/state', {
        ...mutationBody(payload, identity, 'existing'), state: payload.state,
      });
      return parseMutationReceipt(result, payload, identity, parseStateMutationResult);
    },
    issueSetState: async (payload: SetStateInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/state', {
        ...mutationBody(payload, identity, 'existing'), state: payload.state,
      });
      return parseMutationReceipt(result, payload, identity, parseStateMutationResult);
    },
    changeRequestSetLabels: async (payload: SetLabelsInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/labels', {
        ...mutationBody(payload, identity, 'existing'), labels: payload.labels,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    issueSetLabels: async (payload: SetLabelsInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/labels', {
        ...mutationBody(payload, identity, 'existing'), labels: payload.labels,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestSetReviewers: async (payload: SetReviewersInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/pr/reviewers', {
        ...mutationBody(payload, identity, 'existing'), reviewers: payload.reviewers,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    refreshProviderReads: async (identity, scope) => {
      const query = 'item' in scope
        ? new URLSearchParams({ scope: 'item', owner: scope.item.owner, repo: scope.item.repo, number: String(scope.item.number) })
        : new URLSearchParams({ scope: 'lists' });
      await request<ErrorResponse>(fetch, identity, '/read-cache/refresh', { method: 'POST' }, query);
    },
    referenceLabels: async (context, project) => parseLabelChoices(await readRepositoryChoices(fetch, context, project, '/references/labels')),
    referenceReviewers: async (context, project) => parseReviewerChoices(await readRepositoryChoices(fetch, context, project, '/references/reviewers')),
    issueComment: async (payload: CommentInput) => {
      const identity = normalizeIdentity(payload);
      const result = await post<MutationReceiptDTO>(fetch, identity, '/issues/comment', {
        ...mutationBody(payload, identity, 'existing'), body: payload.body,
      });
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
    },
    changeRequestsList: async (context, listOptions): Promise<PageResult<ChangeRequest>> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('page', String(listOptions?.page ?? 1));
      if (listOptions?.query) query.set('query', listOptions.query);
      if (listOptions?.state) query.set('state', listOptions.state);
      if (listOptions?.people) query.set('people', listOptions.people);
      const payload = await request<PageResult<ChangeRequest> & ErrorResponse>(fetch, normalized, '/pulls/list', {}, query);
      if (!payload || !Array.isArray(payload.items)) throw new Error('Source control response contained invalid change requests');
      return parsePage(payload, payload.items.map((item) => parseSourceChangeRequest(item, normalized)));
    },
    changeRequestContext: async (context, number, contextOptions): Promise<ChangeRequestContext> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (contextOptions?.includeDiff) query.set('diff', '1');
      if (contextOptions?.includeCIDetails) query.set('checkDetails', '1');
      if (contextOptions?.includeTimeline) query.set('timeline', '1');
      if (contextOptions?.project) {
        query.set('owner', contextOptions.project.owner);
        query.set('repo', contextOptions.project.name);
      }
      const payload = await request<ChangeRequestContext & ErrorResponse>(fetch, normalized, '/pulls/context', {}, query);
      const result: ChangeRequestContext = {
        identity: normalized,
        project: payload.project ? parseSourceProject(payload.project, normalized) : null,
        changeRequest: payload.changeRequest ? parseSourceChangeRequest(payload.changeRequest, normalized) : null,
        issueComments: payload.issueComments.map((comment) => parseSourceComment(comment, normalized)),
        reviewComments: payload.reviewComments.map((comment) => ({ ...parseSourceComment(comment, normalized), path: comment.path, line: comment.line, position: comment.position })),
        files: payload.files.map((file) => ({ ...file })),
        diff: payload.diff,
        ci: parseSourceCI(payload.ci, normalized),
        fetchedAt: payload.fetchedAt,
      };
      // Only the preview's timeline asks for commits and verdicts.
      if (payload.commits) {
        result.commits = payload.commits.map(parseSourceCommit);
        result.commitsComplete = payload.commitsComplete !== false;
        result.verdicts = (payload.verdicts ?? []).map((verdict) => parseSourceVerdict(verdict, normalized));
        if (payload.reviewers) result.reviewers = payload.reviewers.map((user) => parseSourceUser(user, normalized));
      }
      if (payload.stack === null) result.stack = null;
      else if (payload.stack !== undefined) {
        const stack = parseOptionalStack(payload.stack);
        if (stack) result.stack = stack;
      }
      return result;
    },

    issuesList: async (context, listOptions): Promise<PageResult<Issue>> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('page', String(listOptions?.page ?? 1));
      if (listOptions?.query) query.set('query', listOptions.query);
      if (listOptions?.state) query.set('state', listOptions.state);
      if (listOptions?.people) query.set('people', listOptions.people);
      const payload = await request<PageResult<Issue> & ErrorResponse>(fetch, normalized, '/issues/list', {}, query);
      if (!payload || !Array.isArray(payload.items)) throw new Error('Source control response contained invalid issues');
      return parsePage(payload, payload.items.map((item) => parseSourceIssue(item, normalized)));
    },
    issueGet: async (context, number, projectSelector) => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (projectSelector) {
        query.set('owner', projectSelector.owner);
        query.set('repo', projectSelector.name);
      }
      // Null is an issue outside the bound repository network.
      const payload = await request<(Issue & ErrorResponse) | null>(fetch, normalized, '/issues/get', {}, query);
      return payload === null ? null : parseSourceIssue(payload, normalized);
    },
    issueComments: async (context, number, projectSelector): Promise<IssueComment[]> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (projectSelector) {
        query.set('owner', projectSelector.owner);
        query.set('repo', projectSelector.name);
      }
      const payload = await request<IssueComment[] & ErrorResponse>(fetch, normalized, '/issues/comments', {}, query);
      if (!Array.isArray(payload)) throw new Error('Source control response contained invalid comments');
      return payload.map((comment) => parseSourceComment(comment, normalized));
    },
    projectUpstream: async (context): Promise<ProjectUpstream> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      const payload = await request<ProjectUpstream & ErrorResponse>(fetch, normalized, '/repo/upstream', {}, query);
      if (!payload || !hasMatchingIdentity(payload.identity, normalized) || !isBooleanValue(payload.isFork)
        || (payload.upstream !== null && payload.upstream === undefined)
        || payload.isFork !== Boolean(payload.upstream)) {
        throw new Error('Source control response contained an invalid upstream');
      }
      return { identity: normalized, isFork: payload.isFork, upstream: payload.upstream ? parseSourceProject(payload.upstream, normalized) : null };
    },
    projectBranches: async (context, owner, project) => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('owner', owner);
      query.set('repo', project);
      const payload = await request<BranchesDTO & ErrorResponse>(fetch, normalized, '/repo/branches', {}, query);
      return parseBranches(payload);
    },
    references: (context, referenceOptions) => fetchRepositoryReferences(fetch, context, referenceOptions),
    referencesAcross: (contexts, referenceOptions) => fetchRepositoryReferencesAcross(fetch, contexts, referenceOptions),
    referenceDetail: (context, item) => fetchRepositoryReferenceDetail(fetch, context, item),
    changeRequestListStatuses: (context, refs) => fetchChangeRequestListStatuses(fetch, context, refs),
  };
};
