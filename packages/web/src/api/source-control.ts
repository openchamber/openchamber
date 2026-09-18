import type {
  GitTransportBindingIntent,
  GitTransportBindingResult,
  GitTransportBindingRemovalIntent,
  GitTransportBindingRemovalResult,
  GitAuxiliaryBindingIntent,
  GitAuxiliaryBindingResult,
  ChangeRequest,
  ChangeRequestContext,
  ChangeRequestFile,
  ChangeRequestReviewComment,
  ChangeRequestStatus,
  CI,
  CIRun,
  GitHubAuthStatus,
  GitHubCheckRun,
  GitHubChecksSummary,
  GitHubDeviceFlowComplete,
  GitHubDeviceFlowStart,
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueCommentsResult,
  GitHubIssueGetResult,
  GitHubIssuesListResult,
  GitHubPullRequest,
  GitHubPullRequestContextResult,
  GitHubPullRequestStatus,
  GitHubPullRequestSummary,
  GitHubPullRequestsListResult,
  GitHubRepoUpstreamResult,
  GitHubUserSummary,
  Issue,
  IssueComment,
  CreateChangeRequestInput,
  MergeChangeRequestInput,
  PageResult,
  Project,
  ProjectUpstream,
  ReadyChangeRequestInput,
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
  SourceControlMergeMutationResult,
  SourceControlMutationContext,
  SourceControlMutationReceipt,
  SourceControlReadyMutationResult,
  SourceControlResolvedMutationTarget,
  SourceControlBindingRead,
  SourceControlRepositoryBinding,
  SourceControlRepositoryBindingResetIntent,
  SourceControlRepositoryContext,
  SourceControlRepositoryRemote,
  SourceControlReadContext,
  SourceControlUser,
  UpdateChangeRequestInput,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import type { RuntimeFetchOptions } from '@openchamber/ui/lib/runtime-fetch';
import { isSafeRepositoryEndpoint, parseBindingResponse, resolveBindingReadiness } from '../../server/lib/source-control/binding-contract.js';

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

interface GitHubRepoDTO {
  owner: string;
  repo: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
  defaultBranch?: string;
  defaultBranchSha?: string | null;
  remoteName?: string | null;
}

interface GitHubBranchesDTO {
  branches?: string[];
}

interface AuthStatusDTO extends GitHubAuthStatus {
  status?: 'disconnected' | 'unavailable' | 'unreachable' | 'temporarily-unavailable';
  message?: string;
}

type DisconnectedSourceControlAuthStatus = Extract<SourceControlAuthStatus, { status: 'disconnected' }>;
type GitLabAuthStatusDTO = SourceControlAuthStatus | {
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
  ready?: boolean;
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
  | MutationBody;

interface WebSourceControlAPIOptions {
  fetch?: SourceControlFetch;
}

const GITHUB_IDENTITY: SourceControlIdentity = { provider: 'github', instance: 'github.com' };

const normalizeIdentity = (identity: SourceControlIdentity): SourceControlIdentity => {
  if (identity.provider === 'gitlab') {
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
      throw new Error(`Invalid GitLab instance: ${identity.instance}`);
    }
    return { provider: 'gitlab', instance: url.origin };
  }

  const value = identity.instance.trim().toLowerCase().replace(/\.$/, '');
  let host = value;
  if (value.includes('://')) {
    try {
      host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      throw new Error(`Invalid source control instance: ${identity.instance}`);
    }
  }
  if (host !== 'github.com') {
    throw new Error(`GitHub instance "${identity.instance}" is not supported; only github.com is available`);
  }
  return GITHUB_IDENTITY;
};

const providerPath = (identity: SourceControlIdentity, path: string): string => `/api/source-control/${identity.provider}${path}`;

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

const request = async <TResult extends ErrorResponse>(
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
    throw new SourceControlRequestError(payload.error || response.statusText || 'Source control request failed', payload.code);
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

const parseIncompleteGitHubProjectIds = (
  failedRepos: GitHubPullRequestsListResult['failedRepos'] | GitHubIssuesListResult['failedRepos'],
): string[] | undefined => {
  if (failedRepos === undefined) return undefined;
  if (!Array.isArray(failedRepos)) throw new Error('Source control response contained invalid incomplete repositories');
  return failedRepos.map((repo) => {
    if (!repo || !isStringValue(repo.owner) || !repo.owner || !isStringValue(repo.repo) || !repo.repo) {
      throw new Error('Source control response contained an invalid incomplete repository');
    }
    return `${repo.owner}/${repo.repo}`;
  });
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
    || !isNonEmptyString(payload.accountId) || !isPositiveSafeInteger(payload.bindingRevision)
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

const providerAccountMatches = (identity: SourceControlIdentity, providerAccountId: string): boolean => {
  if (identity.provider === 'github') return /^github\.com#\d+$/.test(providerAccountId);
  return providerAccountId.startsWith(`${identity.instance}#`)
    && /^\d+$/.test(providerAccountId.slice(identity.instance.length + 1));
};

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
    || !isNonEmptyString(target.repositoryId) || !isPositiveSafeInteger(target.bindingRevision)
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

const parseMergeMutationResult = (result: MutationResultDTO): SourceControlMergeMutationResult => {
  const keys = result.message === undefined ? ['merged'] : ['merged', 'message'];
  if (!hasExactKeys(result, keys) || !isBooleanValue(result.merged)
    || (result.message !== undefined && !isStringValue(result.message))) {
    throw new Error('Source control response contained an invalid merge result');
  }
  return result.message === undefined ? { merged: result.merged } : { merged: result.merged, message: result.message };
};

const parseReadyMutationResult = (result: MutationResultDTO): SourceControlReadyMutationResult => {
  if (!hasExactKeys(result, ['ready']) || !isBooleanValue(result.ready)) {
    throw new Error('Source control response contained an invalid ready result');
  }
  return { ready: result.ready };
};

const mapUser = (user: GitHubUserSummary, identity: SourceControlIdentity = GITHUB_IDENTITY): SourceControlUser => {
  const result: SourceControlUser = {
    ...identity,
    id: String(user.id ?? user.login),
    username: user.login,
  };
  if (user.avatarUrl) result.avatarUrl = user.avatarUrl;
  if (user.name) result.name = user.name;
  if (user.email) result.email = user.email;
  return result;
};

const mapProject = (repo: GitHubRepoDTO, identity: SourceControlIdentity = GITHUB_IDENTITY): Project => {
  if (!repo || !isNonEmptyString(repo.owner) || !isNonEmptyString(repo.repo) || !isHttpUrl(repo.url)
    || (repo.cloneUrl !== undefined && !isNonEmptyString(repo.cloneUrl))
    || (repo.sshUrl !== undefined && !isNonEmptyString(repo.sshUrl))
    || (repo.defaultBranch !== undefined && !isNonEmptyString(repo.defaultBranch))
    || (repo.defaultBranchSha !== undefined && repo.defaultBranchSha !== null && !isNonEmptyString(repo.defaultBranchSha))
    || (repo.remoteName !== undefined && repo.remoteName !== null && !isNonEmptyString(repo.remoteName))) {
    throw new Error('Source control response contained an invalid project');
  }
  const result: Project = {
    ...identity,
    id: `${repo.owner}/${repo.repo}`,
    owner: repo.owner,
    name: repo.repo,
    url: repo.url,
  };
  if (repo.cloneUrl) result.cloneUrl = repo.cloneUrl;
  if (repo.sshUrl) result.sshUrl = repo.sshUrl;
  if (repo.defaultBranch) result.defaultBranch = repo.defaultBranch;
  if (repo.defaultBranchSha !== undefined) result.defaultBranchSha = repo.defaultBranchSha;
  if (repo.remoteName !== undefined) result.remoteName = repo.remoteName;
  return result;
};

const projectFromSelector = (repo: { owner: string; repo: string; url?: string }, identity: SourceControlIdentity = GITHUB_IDENTITY): Project => mapProject({
  ...repo,
  url: repo.url ?? `https://github.com/${repo.owner}/${repo.repo}`,
}, identity);

const resolveListProject = (repo: { owner: string; repo: string } | null | undefined, fallback: Project | null): Project => {
  if (repo) return projectFromSelector(repo);
  if (fallback) return fallback;
  throw new Error('GitHub list item did not include a repository');
};

const mapReviewComment = (comment: NonNullable<GitHubPullRequestContextResult['reviewComments']>[number]): ChangeRequestReviewComment => {
  const result: ChangeRequestReviewComment = mapComment(comment);
  if (comment.path) result.path = comment.path;
  if (comment.line !== undefined) result.line = comment.line;
  if (comment.position !== undefined) result.position = comment.position;
  return result;
};

const mapFile = (file: NonNullable<GitHubPullRequestContextResult['files']>[number]): ChangeRequestFile => {
  const result: ChangeRequestFile = { path: file.filename };
  if (file.status) result.status = file.status;
  if (file.additions !== undefined) result.additions = file.additions;
  if (file.deletions !== undefined) result.deletions = file.deletions;
  if (file.changes !== undefined) result.changes = file.changes;
  if (file.patch) result.patch = file.patch;
  return result;
};

const mapChecks = (summary: GitHubChecksSummary, runs?: GitHubCheckRun[]): CI => {
  validateCISummary(summary);
  const result: CI = {
    summary: {
      state: summary.state,
      total: summary.total,
      success: summary.success,
      failure: summary.failure,
      pending: summary.pending,
    },
  };
  if (summary.inProgress !== undefined) result.summary.inProgress = summary.inProgress;
  if (summary.queued !== undefined) result.summary.queued = summary.queued;
  if (summary.startedAt) result.summary.startedAt = summary.startedAt;
  if (runs) result.runs = runs.map(mapCheckRun);
  return result;
};

const hasInvalidGitHubCheckRunApplication = (app: GitHubCheckRun['app']): boolean => (
  app !== undefined && (
    Object.prototype.toString.call(app) !== '[object Object]'
    || (app.name !== undefined && !isStringValue(app.name))
    || (app.slug !== undefined && !isStringValue(app.slug))
  )
);

const hasInvalidGitHubCheckRunJob = (job: GitHubCheckRun['job']): boolean => (
  job !== undefined && (
    Object.prototype.toString.call(job) !== '[object Object]'
    || (job.runId !== undefined && (!Number.isInteger(job.runId) || job.runId < 0))
    || (job.jobId !== undefined && (!Number.isInteger(job.jobId) || job.jobId < 0))
    || (job.url !== undefined && !isHttpUrl(job.url))
    || (job.name !== undefined && !isStringValue(job.name))
    || (job.workflowName !== undefined && !isStringValue(job.workflowName))
    || (job.conclusion !== undefined && job.conclusion !== null && !isStringValue(job.conclusion))
  )
);

const hasInvalidGitHubCheckRunSteps = (steps: NonNullable<GitHubCheckRun['job']>['steps']): boolean => (
  steps !== undefined && (
    !Array.isArray(steps)
    || steps.some((step) => !step
      || !isNonEmptyString(step.name)
      || (step.status !== undefined && !isStringValue(step.status))
      || (step.conclusion !== undefined && step.conclusion !== null && !isStringValue(step.conclusion))
      || (step.number !== undefined && (!Number.isInteger(step.number) || step.number < 0))
      || (step.startedAt !== undefined && !isNonEmptyString(step.startedAt))
      || (step.completedAt !== undefined && !isNonEmptyString(step.completedAt)))
  )
);

const hasInvalidGitHubCheckRunOutput = (output: GitHubCheckRun['output']): boolean => (
  output !== undefined && (
    Object.prototype.toString.call(output) !== '[object Object]'
    || (output.title !== undefined && !isStringValue(output.title))
    || (output.summary !== undefined && !isStringValue(output.summary))
    || (output.text !== undefined && !isStringValue(output.text))
  )
);

const hasInvalidGitHubCheckRunAnnotations = (annotations: GitHubCheckRun['annotations']): boolean => (
  annotations !== undefined && (
    !Array.isArray(annotations)
    || annotations.some((annotation) => !annotation
      || !isNonEmptyString(annotation.message)
      || (annotation.path !== undefined && !isStringValue(annotation.path))
      || (annotation.startLine !== undefined && (!Number.isInteger(annotation.startLine) || annotation.startLine < 0))
      || (annotation.endLine !== undefined && (!Number.isInteger(annotation.endLine) || annotation.endLine < 0))
      || (annotation.level !== undefined && !isStringValue(annotation.level))
      || (annotation.title !== undefined && !isStringValue(annotation.title))
      || (annotation.rawDetails !== undefined && !isStringValue(annotation.rawDetails)))
  )
);

const validateGitHubCheckRun = (run: GitHubCheckRun): void => {
  if (!run || !isNonEmptyString(run.name)
    || (run.id !== undefined && (!Number.isInteger(run.id) || run.id < 0))
    || (run.startedAt !== undefined && !isNonEmptyString(run.startedAt))
    || (run.completedAt !== undefined && !isNonEmptyString(run.completedAt))
    || (run.status !== undefined && !isNonEmptyString(run.status))
    || (run.conclusion !== undefined && run.conclusion !== null && !isStringValue(run.conclusion))
    || (run.detailsUrl !== undefined && !isHttpUrl(run.detailsUrl))) {
    throw new Error('Source control response contained invalid GitHub check-run fields');
  }
  if (hasInvalidGitHubCheckRunApplication(run.app)) {
    throw new Error('Source control response contained an invalid GitHub check-run application');
  }
  if (hasInvalidGitHubCheckRunJob(run.job)) {
    throw new Error('Source control response contained an invalid GitHub check-run job');
  }
  if (hasInvalidGitHubCheckRunSteps(run.job?.steps)) {
    throw new Error('Source control response contained invalid GitHub check-run steps');
  }
  if (hasInvalidGitHubCheckRunOutput(run.output)) {
    throw new Error('Source control response contained invalid GitHub check-run output');
  }
  if (hasInvalidGitHubCheckRunAnnotations(run.annotations)) {
    throw new Error('Source control response contained invalid GitHub check-run annotations');
  }
};

const mapCheckRun = (run: GitHubCheckRun, index: number): CIRun => {
  validateGitHubCheckRun(run);
  const result: CIRun = {
    ...GITHUB_IDENTITY,
    id: String(run.id ?? `${run.name}:${run.startedAt ?? index}`),
    name: run.name,
  };
  if (run.startedAt) result.startedAt = run.startedAt;
  if (run.completedAt) result.completedAt = run.completedAt;
  if (run.status) result.status = run.status;
  if (run.conclusion !== undefined) result.conclusion = run.conclusion;
  if (run.detailsUrl) result.detailsUrl = run.detailsUrl;
  if (run.app) result.application = { name: run.app.name, slug: run.app.slug };
  if (run.job) {
    result.job = {
      runId: run.job.runId === undefined ? undefined : String(run.job.runId),
      jobId: run.job.jobId === undefined ? undefined : String(run.job.jobId),
      url: run.job.url,
      name: run.job.name,
      workflowName: run.job.workflowName,
      conclusion: run.job.conclusion,
      steps: run.job.steps?.map((step) => ({
        name: step.name,
        status: step.status,
        conclusion: step.conclusion,
        number: step.number,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
      })),
    };
  }
  if (run.output) result.output = { title: run.output.title, summary: run.output.summary, text: run.output.text };
  if (run.annotations) {
    result.annotations = run.annotations.map((annotation) => ({
      message: annotation.message,
      path: annotation.path,
      startLine: annotation.startLine,
      endLine: annotation.endLine,
      level: annotation.level,
      title: annotation.title,
      rawDetails: annotation.rawDetails,
    }));
  }
  return result;
};

const mapChangeRequest = (pr: GitHubPullRequest | GitHubPullRequestSummary, project: Project): ChangeRequest => {
  if (!Number.isInteger(pr.number) || pr.number < 1
    || !isNonEmptyString(pr.title) || !isHttpUrl(pr.url)
    || !['open', 'closed', 'merged'].includes(pr.state)
    || !isBooleanValue(pr.draft)
    || !isNonEmptyString(pr.base) || !isNonEmptyString(pr.head)
    || (pr.body !== undefined && !isStringValue(pr.body))
    || (pr.headSha !== undefined && !isNonEmptyString(pr.headSha))
    || (pr.mergeable !== undefined && pr.mergeable !== null && !isBooleanValue(pr.mergeable))
    || (pr.mergeableState !== undefined && pr.mergeableState !== null && !isStringValue(pr.mergeableState))) {
    throw new Error('Source control response contained an invalid change request');
  }
  const result: ChangeRequest = {
    ...GITHUB_IDENTITY,
    id: `${project.id}#${pr.number}`,
    number: pr.number,
    project,
    title: pr.title,
    url: pr.url,
    state: pr.state,
    draft: pr.draft,
    base: pr.base,
    head: pr.head,
  };
  if (pr.body !== undefined) result.body = pr.body;
  if (pr.headSha) result.headSha = pr.headSha;
  if ('author' in pr && pr.author) result.author = mapUser(pr.author);
  if ('createdAt' in pr && pr.createdAt) result.createdAt = pr.createdAt;
  if ('updatedAt' in pr && pr.updatedAt) result.updatedAt = pr.updatedAt;
  if ('headLabel' in pr && pr.headLabel) result.headLabel = pr.headLabel;
  if ('headRepo' in pr && pr.headRepo) result.headProject = mapProject(pr.headRepo);
  if (pr.mergeable !== undefined) result.mergeable = pr.mergeable;
  if (pr.mergeableState !== undefined) result.mergeableState = pr.mergeableState;
  return result;
};

const mapIssue = (issue: GitHubIssue, project: Project, identity: SourceControlIdentity = GITHUB_IDENTITY): Issue => {
  if (!issue || !Number.isInteger(issue.number) || issue.number < 1
    || !isNonEmptyString(issue.title) || !isHttpUrl(issue.url)
    || (issue.state !== 'open' && issue.state !== 'closed')
    || (issue.body !== undefined && !isStringValue(issue.body))
    || (issue.createdAt !== undefined && !isNonEmptyString(issue.createdAt))
    || (issue.updatedAt !== undefined && !isNonEmptyString(issue.updatedAt))) {
    throw new Error('Source control response contained an invalid issue');
  }
  if (issue.author !== undefined && issue.author !== null) validateGitHubUser(issue.author);
  if (issue.assignees !== undefined) {
    if (!Array.isArray(issue.assignees)) throw new Error('Source control response contained invalid issue assignees');
    issue.assignees.forEach(validateGitHubUser);
  }
  if (issue.labels !== undefined && (!Array.isArray(issue.labels) || issue.labels.some((label) => !label
    || !isNonEmptyString(label.name) || (label.color !== undefined && !isStringValue(label.color))))) {
    throw new Error('Source control response contained invalid issue labels');
  }
  const result: Issue = {
    ...identity,
    id: `${project.id}#${issue.number}`,
    number: issue.number,
    project,
    title: issue.title,
    url: issue.url,
    state: issue.state,
  };
  if (issue.body !== undefined) result.body = issue.body;
  if (issue.author) result.author = mapUser(issue.author, identity);
  if (issue.assignees) result.assignees = issue.assignees.map((user) => mapUser(user, identity));
  if (issue.labels) result.labels = issue.labels.map((label) => ({ name: label.name, color: label.color }));
  if (issue.createdAt) result.createdAt = issue.createdAt;
  if (issue.updatedAt) result.updatedAt = issue.updatedAt;
  return result;
};

const mapComment = (comment: GitHubIssueComment, identity: SourceControlIdentity = GITHUB_IDENTITY): IssueComment => {
  if (!comment || !Number.isInteger(comment.id) || comment.id < 1 || !isHttpUrl(comment.url)
    || !isStringValue(comment.body)
    || (comment.createdAt !== undefined && !isNonEmptyString(comment.createdAt))
    || (comment.updatedAt !== undefined && !isNonEmptyString(comment.updatedAt))) {
    throw new Error('Source control response contained an invalid comment');
  }
  if (comment.author !== undefined && comment.author !== null) validateGitHubUser(comment.author);
  const result: IssueComment = {
    ...identity,
    id: String(comment.id),
    url: comment.url,
    body: comment.body,
  };
  if (comment.author) result.author = mapUser(comment.author, identity);
  if (comment.createdAt) result.createdAt = comment.createdAt;
  if (comment.updatedAt) result.updatedAt = comment.updatedAt;
  return result;
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
    || (request.mergeableState !== undefined && request.mergeableState !== null && !isStringValue(request.mergeableState))) {
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

const parseSourceComment = (comment: IssueComment, identity: SourceControlIdentity): IssueComment => {
  if (!comment || !isValidId(comment.id) || !isNonEmptyString(comment.url) || !isStringValue(comment.body)
    || !hasMatchingIdentity(comment, identity)
    || (comment.author !== undefined && comment.author !== null && !hasMatchingIdentity(comment.author, identity))
    || (comment.createdAt !== undefined && !isNonEmptyString(comment.createdAt))
    || (comment.updatedAt !== undefined && !isNonEmptyString(comment.updatedAt))) {
    throw new Error('Source control response contained an invalid comment');
  }
  const result: IssueComment = { ...identity, id: String(comment.id), url: comment.url, body: comment.body };
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
const validateGitHubUser = (user: GitHubUserSummary): void => {
  if (!user || !isNonEmptyString(user.login)
    || (user.id !== undefined && (!Number.isInteger(user.id) || user.id < 0))
    || (user.avatarUrl !== undefined && !isHttpUrl(user.avatarUrl))
    || (user.name !== undefined && !isStringValue(user.name))
    || (user.email !== undefined && !isStringValue(user.email))) {
    throw new Error('Source control response contained an invalid user');
  }
};
const parsePageFields = (page: number | undefined, hasMore: boolean | undefined): Pick<PageResult<never>, 'page' | 'hasMore'> => {
  if (!isNumberValue(page) || !Number.isInteger(page) || page < 1 || !isBooleanValue(hasMore)) {
    throw new Error('Source control response contained invalid pagination');
  }
  return { page, hasMore };
};
const parseBranches = (payload: GitHubBranchesDTO): string[] => {
  if (!payload || !Array.isArray(payload.branches) || payload.branches.some((branch) => !isNonEmptyString(branch))) {
    throw new Error('Source control response contained invalid branches');
  }
  return [...payload.branches];
};
const validateCISummary = (summary: GitHubChecksSummary | CI['summary']): void => {
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

const parseGitHubChangeRequestStatus = (
  payload: GitHubPullRequestStatus,
  branch: string,
): ChangeRequestStatus => {
  if (!payload || !isBooleanValue(payload.connected) || payload.connected !== true
    || !isNonEmptyString(payload.branch) || payload.branch !== branch
    || (payload.fetchedAt !== undefined && (!Number.isFinite(payload.fetchedAt) || payload.fetchedAt < 0))
    || (payload.canMerge !== undefined && !isBooleanValue(payload.canMerge))
    || (payload.defaultBranch !== undefined && payload.defaultBranch !== null && !isNonEmptyString(payload.defaultBranch))
    || (payload.resolvedRemoteName !== undefined && payload.resolvedRemoteName !== null && !isNonEmptyString(payload.resolvedRemoteName))) {
    throw new Error('Source control response contained an invalid GitHub change request status');
  }
  if (payload.repo !== undefined && payload.repo !== null) {
    if (!isNonEmptyString(payload.repo.owner) || !isNonEmptyString(payload.repo.repo) || !isHttpUrl(payload.repo.url)) {
      throw new Error('Source control response contained an invalid project');
    }
  }
  if (payload.pr !== undefined && payload.pr !== null && !payload.repo) {
    throw new Error('Source control response contained a change request without a project');
  }
  const project = payload.repo ? projectFromSelector(payload.repo) : null;
  const result: ChangeRequestStatus = {
    identity: GITHUB_IDENTITY,
    project,
    branch: payload.branch,
    changeRequest: payload.pr !== undefined && payload.pr !== null && project ? mapChangeRequest(payload.pr, project) : null,
  };
  if (payload.fetchedAt !== undefined) result.fetchedAt = payload.fetchedAt;
  if (payload.checks !== undefined) result.ci = payload.checks === null ? null : mapChecks(payload.checks);
  if (payload.canMerge !== undefined) result.canMerge = payload.canMerge;
  if (payload.defaultBranch !== undefined) result.defaultBranch = payload.defaultBranch;
  if (payload.resolvedRemoteName !== undefined) result.resolvedRemoteName = payload.resolvedRemoteName;
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

const parseGitHubAuthAccounts = (
  accounts: GitHubAuthStatus['accounts'],
  identity: SourceControlIdentity,
): SourceControlAuthAccount[] => (accounts ?? []).map((account) => {
  let source: SourceControlAuthAccount['source'] = 'oauth';
  if (account.source === 'gh-cli' || account.source === 'cli') source = 'cli';
  else if (account.source === 'pat') source = 'pat';

  if (!isNonEmptyString(account.id) || account.id !== account.credentialId
    || !isPositiveSafeInteger(account.credentialRevision) || !isNonEmptyString(account.providerUserId)
    || !['available', 'unavailable'].includes(account.providerUserStatus)) {
    throw new Error('Source control response contained an invalid GitHub auth credential');
  }
  return {
    id: account.id,
    credentialId: account.credentialId,
    credentialRevision: account.credentialRevision,
    providerUserId: account.providerUserId,
    providerUserStatus: account.providerUserStatus,
    user: mapUser(account.user, identity),
    scope: account.scope,
    current: Boolean(account.current),
    source,
    status: account.status === 'invalid' ? 'invalid' : 'valid',
  };
});

const parseGitLabAuthStatus = (payload: GitLabAuthStatusDTO, identity: SourceControlIdentity): SourceControlAuthStatus => {
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

const requireConnected = (connected: boolean): void => {
  if (!isBooleanValue(connected)) throw new Error('Source control response contained an invalid connection state');
  if (!connected) throw new Error('GitHub is not connected');
};

const mapAuthStatus = (payload: AuthStatusDTO, identity: SourceControlIdentity): SourceControlAuthStatus => {
  if (!payload.connected || !payload.user) {
    if (payload.status === 'unreachable' || payload.status === 'temporarily-unavailable' || payload.status === 'unavailable') {
      if (payload.message) return { ...identity, status: payload.status, connected: false, message: payload.message };
      return { ...identity, status: payload.status, connected: false };
    }
    return {
      ...identity,
      status: 'disconnected',
      connected: false,
      accounts: parseGitHubAuthAccounts(payload.accounts, identity),
    };
  }
  const result: Extract<SourceControlAuthStatus, { status: 'connected' }> = {
    ...identity,
    status: 'connected',
    connected: true,
    user: mapUser(payload.user, identity),
    accounts: parseGitHubAuthAccounts(payload.accounts, identity),
  };
  if (payload.scope) result.scope = payload.scope;
  if (payload.ghCli) {
    result.cli = {
      available: payload.ghCli.available,
      disabled: payload.ghCli.disabled,
      active: payload.ghCli.active,
    };
    if (payload.ghCli.user) result.cli.user = mapUser(payload.ghCli.user, identity);
  }
  return result;
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
      if (normalized.provider === 'gitlab') {
        return parseGitLabAuthStatus(await request<GitLabAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/status'), normalized);
      }
      return mapAuthStatus(await request<AuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/status'), normalized);
    },
    authStart: async (identity): Promise<SourceControlDeviceFlowStart> => {
      const payload = await request<GitHubDeviceFlowStart & ErrorResponse>(fetch, identity, '/auth/start', {
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
      let payload: GitHubDeviceFlowComplete & ErrorResponse;
      try {
        payload = await post<GitHubDeviceFlowComplete & ErrorResponse>(fetch, identity, '/auth/complete', { flowId });
      } catch (error) {
        if (error instanceof SourceControlRequestError && error.code === 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE') {
          return { status: 'error', code: 'expired', message: error.message };
        }
        throw error;
      }
      if (payload.connected) {
        const result: SourceControlDeviceFlowComplete = { status: 'connected', user: mapUser(payload.user, normalizeIdentity(identity)) };
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
      return { status: 'error', code, message: payload.error || payload.status || 'GitHub authentication failed' };
    },
    authSetToken: async (identity, token) => {
      const normalized = normalizeIdentity(identity);
      await post<{ connected: boolean; user?: GitHubUserSummary; error?: string }>(fetch, normalized, '/auth/token', { token });
      if (normalized.provider === 'gitlab') {
        return parseGitLabAuthStatus(await request<GitLabAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/status'), normalized);
      }
      return mapAuthStatus(await request<GitHubAuthStatus & ErrorResponse>(fetch, normalized, '/auth/status'), normalized);
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
      if (normalized.provider === 'gitlab') {
        return parseGitLabAuthStatus(await post<GitLabAuthStatusDTO & ErrorResponse>(fetch, normalized, '/auth/activate', { accountId }), normalized);
      }
      return mapAuthStatus(await post<GitHubAuthStatus & ErrorResponse>(fetch, normalized, '/auth/activate', { accountId }), normalized);
    },
    authSetCliDisabled: async (identity, disabled) => {
      const normalized = normalizeIdentity(identity);
      const payload = await post<{ disabled?: boolean; error?: string }>(fetch, normalized, normalized.provider === 'gitlab' ? '/auth/cli' : '/auth/gh-cli', { disabled });
      return { disabled: Boolean(payload.disabled) };
    },

    changeRequestStatus: async (context, branch, requestOptions): Promise<ChangeRequestStatus> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('branch', branch);
      if (requestOptions?.force) query.set('force', 'true');

      if (normalized.provider === 'gitlab') {
        const payload = await request<ChangeRequestStatus & ErrorResponse>(fetch, normalized, '/pr/status', {}, query);
        return parseSourceChangeRequestStatus(payload, normalized, branch);
      }
      const payload = await request<GitHubPullRequestStatus & ErrorResponse>(fetch, normalized, '/pr/status', {}, query);
      return parseGitHubChangeRequestStatus(payload, branch);
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
      return parseMutationReceipt(result, payload, identity, parseEmptyMutationResult);
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
    changeRequestsList: async (context, listOptions): Promise<PageResult<ChangeRequest>> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('page', String(listOptions?.page ?? 1));
      if (listOptions?.query) query.set('query', listOptions.query);
      if (normalized.provider === 'gitlab') {
        const payload = await request<PageResult<ChangeRequest> & ErrorResponse>(fetch, normalized, '/pulls/list', {}, query);
        return { items: payload.items.map((item) => parseSourceChangeRequest(item, normalized)), page: payload.page, hasMore: payload.hasMore };
      }
      const payload = await request<GitHubPullRequestsListResult & ErrorResponse>(fetch, normalized, '/pulls/list', {}, query);
      requireConnected(payload.connected);
      const fallback = payload.repo ? projectFromSelector(payload.repo) : null;
      const items = (payload.prs ?? []).map((pr) => mapChangeRequest(pr, resolveListProject(pr.sourceRepo, fallback)));
      const result: PageResult<ChangeRequest> = { items, page: payload.page ?? listOptions?.page ?? 1, hasMore: Boolean(payload.hasMore) };
      const incompleteProjectIds = parseIncompleteGitHubProjectIds(payload.failedRepos);
      if (incompleteProjectIds?.length) result.incompleteProjectIds = incompleteProjectIds;
      return result;
    },
    changeRequestContext: async (context, number, contextOptions): Promise<ChangeRequestContext> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (contextOptions?.includeDiff) query.set('diff', '1');
      if (contextOptions?.includeCIDetails) query.set('checkDetails', '1');
      if (contextOptions?.project) {
        query.set('owner', contextOptions.project.owner);
        query.set('repo', contextOptions.project.name);
      }
      if (normalized.provider === 'gitlab') {
        const payload = await request<ChangeRequestContext & ErrorResponse>(fetch, normalized, '/pulls/context', {}, query);
        return {
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
      }
      const payload = await request<GitHubPullRequestContextResult & ErrorResponse>(fetch, normalized, '/pulls/context', {}, query);
      requireConnected(payload.connected);
      if (payload.checkRuns !== undefined) {
        if (!Array.isArray(payload.checkRuns) || !payload.checks) {
          throw new Error('Source control response contained invalid GitHub check-run details');
        }
        payload.checkRuns.forEach(validateGitHubCheckRun);
      }
      const project = payload.repo ? projectFromSelector(payload.repo) : null;
      const result: ChangeRequestContext = {
        identity: GITHUB_IDENTITY,
        project,
        changeRequest: payload.pr && project ? mapChangeRequest(payload.pr, project) : null,
        issueComments: (payload.issueComments ?? []).map((comment) => mapComment(comment)),
        reviewComments: (payload.reviewComments ?? []).map(mapReviewComment),
        files: (payload.files ?? []).map(mapFile),
      };
      if (payload.fetchedAt !== undefined) result.fetchedAt = payload.fetchedAt;
      if (payload.diff) result.diff = payload.diff;
      if (payload.checks) result.ci = parseSourceCI(mapChecks(payload.checks, payload.checkRuns), GITHUB_IDENTITY);
      return result;
    },

    issuesList: async (context, listOptions): Promise<PageResult<Issue>> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('page', String(listOptions?.page ?? 1));
      if (listOptions?.query) query.set('query', listOptions.query);
      if (normalized.provider === 'gitlab') {
        const payload = await request<PageResult<Issue> & ErrorResponse>(fetch, normalized, '/issues/list', {}, query);
        if (!payload || !Array.isArray(payload.items)) throw new Error('Source control response contained invalid issues');
        return { items: payload.items.map((item) => parseSourceIssue(item, normalized)), ...parsePageFields(payload.page, payload.hasMore) };
      }
      const payload = await request<GitHubIssuesListResult & ErrorResponse>(fetch, normalized, '/issues/list', {}, query);
      requireConnected(payload.connected);
      if (!Array.isArray(payload.issues) || payload.repo === undefined) {
        throw new Error('Source control response contained invalid issues');
      }
      const pagination = parsePageFields(payload.page, payload.hasMore);
      const fallback = payload.repo ? projectFromSelector(payload.repo, normalized) : null;
      const items = payload.issues.map((issue) => mapIssue(issue, resolveListProject(issue.sourceRepo, fallback), normalized));
      const result: PageResult<Issue> = { items, ...pagination };
      const incompleteProjectIds = parseIncompleteGitHubProjectIds(payload.failedRepos);
      if (incompleteProjectIds?.length) result.incompleteProjectIds = incompleteProjectIds;
      return result;
    },
    issueGet: async (context, number, projectSelector) => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (projectSelector) {
        query.set('owner', projectSelector.owner);
        query.set('repo', projectSelector.name);
      }
      if (normalized.provider === 'gitlab') {
        const payload = await request<Issue & ErrorResponse>(fetch, normalized, '/issues/get', {}, query);
        return parseSourceIssue(payload, normalized);
      }
      const payload = await request<GitHubIssueGetResult & ErrorResponse>(fetch, normalized, '/issues/get', {}, query);
      requireConnected(payload.connected);
      if (payload.issue === undefined || payload.repo === undefined || (payload.issue !== null && !payload.repo)) {
        throw new Error('Source control response contained an invalid issue result');
      }
      if (payload.repo) projectFromSelector(payload.repo, normalized);
      return payload.issue && payload.repo ? mapIssue(payload.issue, projectFromSelector(payload.repo, normalized), normalized) : null;
    },
    issueComments: async (context, number, projectSelector): Promise<IssueComment[]> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('number', String(number));
      if (projectSelector) {
        query.set('owner', projectSelector.owner);
        query.set('repo', projectSelector.name);
      }
      if (normalized.provider === 'gitlab') {
        const payload = await request<IssueComment[] & ErrorResponse>(fetch, normalized, '/issues/comments', {}, query);
        if (!Array.isArray(payload)) throw new Error('Source control response contained invalid comments');
        return payload.map((comment) => parseSourceComment(comment, normalized));
      }
      const payload = await request<GitHubIssueCommentsResult & ErrorResponse>(fetch, normalized, '/issues/comments', {}, query);
      requireConnected(payload.connected);
      if (!Array.isArray(payload.comments) || payload.repo === undefined) {
        throw new Error('Source control response contained invalid comments');
      }
      if (payload.repo) projectFromSelector(payload.repo, normalized);
      return payload.comments.map((comment) => mapComment(comment, normalized));
    },
    projectUpstream: async (context): Promise<ProjectUpstream> => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      if (normalized.provider === 'gitlab') {
        const payload = await request<ProjectUpstream & ErrorResponse>(fetch, normalized, '/repo/upstream', {}, query);
        if (!payload || !hasMatchingIdentity(payload.identity, normalized) || !isBooleanValue(payload.isFork)
          || (payload.upstream !== null && payload.upstream === undefined)
          || payload.isFork !== Boolean(payload.upstream)) {
          throw new Error('Source control response contained an invalid upstream');
        }
        return { identity: normalized, isFork: payload.isFork, upstream: payload.upstream ? parseSourceProject(payload.upstream, normalized) : null };
      }
      const payload = await request<GitHubRepoUpstreamResult & ErrorResponse>(fetch, normalized, '/repo/upstream', {}, query);
      requireConnected(payload.connected);
      if (!isBooleanValue(payload.isFork) || (payload.upstream !== null && payload.upstream === undefined)
        || payload.isFork !== Boolean(payload.upstream)) {
        throw new Error('Source control response contained an invalid upstream');
      }
      return { identity: normalized, isFork: payload.isFork, upstream: payload.upstream ? mapProject(payload.upstream, normalized) : null };
    },
    projectBranches: async (context, owner, project) => {
      const normalized = normalizeIdentity(context);
      const query = boundReadQuery(context);
      query.set('owner', owner);
      query.set('repo', project);
      const payload = await request<GitHubBranchesDTO & ErrorResponse>(fetch, normalized, '/repo/branches', {}, query);
      return parseBranches(payload);
    },
  };
};
