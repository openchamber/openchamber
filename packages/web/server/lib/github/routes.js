import { digestMutationInput, mutationReceipt } from '../source-control/mutation-executor.js';

const PR_STATUS_CACHE_TTL_MS = 90_000;
const PR_STATUS_CACHE_MAX_ENTRIES = 200;
// Upper bound for resolving a single PR status. resolveGitHubPrStatus makes many
// serial GitHub API calls; under GitHub secondary-rate-limiting a single request
// can otherwise hang 20s+. We bound it so the route fails fast instead of holding
// the response (and a client socket) open — the client keeps its last-known
// status on error, and a later poll fills it in.
const PR_STATUS_RESOLVE_TIMEOUT_MS = 12_000;
const prStatusCache = new Map();
const pendingPrStatusWrites = new Map();
let resolvedAuthLoginPromise = null;
const PR_CONTEXT_CACHE_TTL_MS = 30_000;
const PR_CONTEXT_CACHE_MAX_ENTRIES = 50;
const prContextCache = new Map();
const pendingPrContextWrites = new Map();
const GITHUB_OAUTH_INSTANCE = 'github.com';

const githubAuthRoutePaths = (suffix) => [
  `/api/github${suffix}`,
  `/api/source-control/github${suffix}`,
];
const canonicalGitHubRoutePath = (suffix) => `/api/source-control/github${suffix}`;
const retiredLegacyGitHubGetRoutes = [
  '/pr/status', '/repo/upstream', '/repo/branches', '/issues/list', '/issues/get',
  '/issues/comments', '/pulls/list', '/pulls/context',
];
const retiredLegacyGitHubPostRoutes = ['/pr/create', '/pr/update', '/pr/merge', '/pr/ready'];

function cacheAuthorityMatches(candidate, authority) {
  return !authority || (candidate
    && candidate.cacheIdentity === authority.cacheIdentity
    && candidate.repositoryId === authority.repositoryId
    && candidate.bindingRevision === authority.bindingRevision
    && candidate.primaryRemote === authority.primaryRemote);
}

function invalidatePrContextCache(directory, number, authority = null) {
  for (const key of prContextCache.keys()) {
    try {
      const parsed = JSON.parse(key);
      const [cachedDirectory, cachedNumber] = parsed;
      const authorityMatches = !authority || (parsed.length === 8
        && parsed[4] === authority.cacheIdentity
        && parsed[5] === authority.repositoryId
        && parsed[6] === authority.bindingRevision
        && parsed[7] === authority.primaryRemote);
      if (authorityMatches && (directory == null || cachedDirectory === directory) && (number == null || cachedNumber === number)) {
        prContextCache.delete(key);
      }
    } catch {
      if (!authority) prContextCache.delete(key);
    }
  }
  for (const [token, pending] of pendingPrContextWrites) {
    if (cacheAuthorityMatches(pending, authority)
      && (directory == null || pending.directory === directory)
      && (number == null || pending.number === number)) {
      pendingPrContextWrites.delete(token);
    }
  }
}

// Aggregate check runs into the summary shape shared by pr/status and
// pulls/context. Keeps `pending` as queued+in_progress+unconcluded for
// existing consumers while exposing the split and the earliest start time so
// the UI can show live "running for N minutes" state.
// A re-run leaves the previous completed check run in the listForRef payload
// alongside the new in-progress one. GitHub's UI shows only the latest run
// per (app, name); mirror that so counts match what users see on github.com.
function dedupeCheckRuns(checkRuns) {
  const byName = new Map();
  for (const run of checkRuns) {
    const key = `${run?.app?.id ?? run?.app?.slug ?? ''}::${run?.name ?? ''}`;
    const previous = byName.get(key);
    if (!previous) {
      byName.set(key, run);
      continue;
    }
    const previousStartedAt = Date.parse(previous?.started_at || '') || 0;
    const startedAt = Date.parse(run?.started_at || '') || 0;
    if (startedAt > previousStartedAt
      || (startedAt === previousStartedAt && (run?.id ?? 0) > (previous?.id ?? 0))) {
      byName.set(key, run);
    }
  }
  return Array.from(byName.values());
}

function summarizeCheckRuns(checkRuns) {
  const counts = { success: 0, failure: 0, pending: 0, inProgress: 0, queued: 0 };
  let startedAt = null;
  for (const run of checkRuns) {
    const status = run?.status;
    const conclusion = run?.conclusion;
    if (status === 'in_progress') {
      counts.pending += 1;
      counts.inProgress += 1;
      const runStartedAt = typeof run?.started_at === 'string' ? run.started_at : null;
      if (runStartedAt && (!startedAt || runStartedAt < startedAt)) {
        startedAt = runStartedAt;
      }
      continue;
    }
    if (status === 'queued') {
      counts.pending += 1;
      counts.queued += 1;
      continue;
    }
    if (!conclusion) {
      counts.pending += 1;
      continue;
    }
    if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') {
      counts.success += 1;
    } else {
      counts.failure += 1;
    }
  }
  const total = counts.success + counts.failure + counts.pending;
  const state = counts.failure > 0
    ? 'failure'
    : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
  return { state, total, ...counts, ...(startedAt ? { startedAt } : {}) };
}

function summarizeCombinedStatuses(statuses) {
  const counts = { success: 0, failure: 0, pending: 0 };
  statuses.forEach((s) => {
    if (s.state === 'success') counts.success += 1;
    else if (s.state === 'failure' || s.state === 'error') counts.failure += 1;
    else if (s.state === 'pending') counts.pending += 1;
  });
  const total = counts.success + counts.failure + counts.pending;
  const state = counts.failure > 0
    ? 'failure'
    : (counts.pending > 0 ? 'pending' : (total > 0 ? 'success' : 'unknown'));
  return { state, total, ...counts, inProgress: counts.pending, queued: 0 };
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function readQueryString(req, name) {
  const value = req.query?.[name];
  return Object.prototype.toString.call(value) === '[object String]' ? value.trim() : '';
}

function readPositiveIntegerQuery(req, name) {
  const value = readQueryString(req, name);
  if (!/^[1-9]\d*$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';
const isProviderString = (value) => Object.prototype.toString.call(value) === '[object String]';

function invalidProviderPayload(message) {
  const error = new Error(message);
  error.code = 'MALFORMED_PROVIDER_RESPONSE';
  return error;
}

function requireProviderArray(value, message) {
  if (!Array.isArray(value)) throw invalidProviderPayload(message);
  return value;
}

function requireGitHubRepoNetwork(value, primaryRepo) {
  if (value === null) return value;
  const network = requireProviderArray(value, 'GitHub returned invalid fork metadata');
  if (network.length === 0) throw invalidProviderPayload('GitHub returned invalid fork metadata');
  for (const repo of network) {
    if (!isPlainObject(repo)
      || !isProviderString(repo.owner) || !repo.owner.trim()
      || !isProviderString(repo.repo) || !repo.repo.trim()
      || (repo.source !== 'origin' && repo.source !== 'upstream')) {
      throw invalidProviderPayload('GitHub returned invalid fork metadata');
    }
  }
  if (primaryRepo && !network.some((repo) => repo.source === 'origin'
    && repo.owner === primaryRepo.owner && repo.repo === primaryRepo.repo)) {
    throw invalidProviderPayload('GitHub returned invalid fork metadata');
  }
  return network;
}

function requireGitHubUser(value, message) {
  if (value == null) return;
  if (!isPlainObject(value) || !Number.isSafeInteger(value.id) || !isProviderString(value.login) || !value.login.trim()) {
    throw invalidProviderPayload(message);
  }
}

function requireGitHubLabels(value, message) {
  if (value == null) return;
  for (const label of requireProviderArray(value, message)) {
    if (!isPlainObject(label) || !isProviderString(label.name) || !label.name.trim()) {
      throw invalidProviderPayload(message);
    }
  }
}

function requireGitHubIssue(value, message) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.number) || value.number <= 0
    || !isProviderString(value.title)
    || !isProviderString(value.html_url) || !value.html_url.trim()
    || (value.state !== 'open' && value.state !== 'closed')) {
    throw invalidProviderPayload(message);
  }
  requireGitHubUser(value.user, message);
  requireGitHubLabels(value.labels, message);
  if (value.assignees != null) {
    for (const assignee of requireProviderArray(value.assignees, message)) requireGitHubUser(assignee, message);
  }
  return value;
}

function requireGitHubComment(value, message) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.id)
    || !isProviderString(value.html_url) || !value.html_url.trim()
    || !isProviderString(value.body)) {
    throw invalidProviderPayload(message);
  }
  requireGitHubUser(value.user, message);
  return value;
}

function matchesGitHubRepositoryUrl(value, owner, repo) {
  if (!isProviderString(value) || !value.trim()) return false;
  const expectedPath = `${owner}/${repo}`.toLowerCase();
  const raw = value.trim();
  const scpMatch = raw.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (scpMatch) return `${scpMatch[1]}/${scpMatch[2]}`.toLowerCase() === expectedPath;

  try {
    const url = new URL(raw);
    if (!['https:', 'ssh:'].includes(url.protocol)
      || url.host.toLowerCase() !== 'github.com'
      || url.password || url.search || url.hash
      || (url.protocol === 'https:' && url.username)
      || (url.protocol === 'ssh:' && url.username !== 'git')) {
      return false;
    }
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return path.toLowerCase() === expectedPath;
  } catch {
    return false;
  }
}

function requireGitHubPullRequest(value, message) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.number) || value.number <= 0
    || !isProviderString(value.title)
    || !isProviderString(value.html_url) || !value.html_url.trim()
    || (value.state !== 'open' && value.state !== 'closed')
    || !isPlainObject(value.base) || !isProviderString(value.base.ref) || !value.base.ref.trim()
    || !isPlainObject(value.head) || !isProviderString(value.head.ref) || !value.head.ref.trim()) {
    throw invalidProviderPayload(message);
  }
  requireGitHubUser(value.user, message);
  if (value.head.repo != null) {
    const repo = value.head.repo;
    if (!isPlainObject(repo)
      || !isPlainObject(repo.owner) || !isProviderString(repo.owner.login) || !repo.owner.login.trim()
      || !isProviderString(repo.name) || !repo.name.trim()
      || !matchesGitHubRepositoryUrl(repo.html_url, repo.owner.login, repo.name)
      || (repo.clone_url != null && !matchesGitHubRepositoryUrl(repo.clone_url, repo.owner.login, repo.name))
      || (repo.ssh_url != null && !matchesGitHubRepositoryUrl(repo.ssh_url, repo.owner.login, repo.name))) {
      throw invalidProviderPayload(message);
    }
  }
  return value;
}

function requireGitHubReviewComment(value) {
  const comment = requireGitHubComment(value, 'GitHub returned an invalid review comment');
  if (!isProviderString(comment.path) || !comment.path.trim()) {
    throw invalidProviderPayload('GitHub returned an invalid review comment');
  }
  return comment;
}

function requireGitHubPullFile(value) {
  if (!isPlainObject(value)
    || !isProviderString(value.filename) || !value.filename.trim()
    || !isProviderString(value.status) || !value.status.trim()
    || !Number.isSafeInteger(value.additions) || value.additions < 0
    || !Number.isSafeInteger(value.deletions) || value.deletions < 0
    || !Number.isSafeInteger(value.changes) || value.changes < 0
    || (value.patch != null && !isProviderString(value.patch))) {
    throw invalidProviderPayload('GitHub returned an invalid pull request file');
  }
  return value;
}

function requireGitHubCheckRuns(value) {
  const runs = requireProviderArray(value, 'GitHub returned invalid check runs');
  for (const run of runs) {
    if (!isPlainObject(run) || !Number.isSafeInteger(run.id)
      || !isProviderString(run.name) || !run.name.trim()
      || !isProviderString(run.status) || !run.status.trim()) {
      throw invalidProviderPayload('GitHub returned an invalid check run');
    }
  }
  return runs;
}

function requireGitHubStatuses(value) {
  const statuses = requireProviderArray(value, 'GitHub returned invalid combined status');
  for (const status of statuses) {
    if (!isPlainObject(status) || !isProviderString(status.state) || !status.state.trim()) {
      throw invalidProviderPayload('GitHub returned an invalid combined status item');
    }
  }
  return statuses;
}

function requireGitHubWorkflowJobs(value) {
  const jobs = requireProviderArray(value, 'GitHub returned invalid workflow jobs');
  for (const job of jobs) {
    if (!isPlainObject(job) || !Number.isSafeInteger(job.id)
      || !isProviderString(job.name) || !job.name.trim()) {
      throw invalidProviderPayload('GitHub returned an invalid workflow job');
    }
  }
  return jobs;
}

async function resolveRepoForRequest(octokit, directory, requestedRepo, remoteName = 'origin', dependencies = {}) {
  const resolveDirectoryRepo = dependencies.resolveGitHubRepoFromDirectory
    ?? (await import('./index.js')).resolveGitHubRepoFromDirectory;
  const { repo } = await resolveDirectoryRepo(directory, remoteName);
  if (!repo && dependencies.requireResolvedRepo) {
    throw new Error(`Unable to resolve GitHub repo from git remote "${remoteName}"`);
  }
  const resolveNetwork = dependencies.resolveRepoNetwork
    ?? (await import('./repo/fork-detection.js')).resolveRepoNetwork;
  const mustResolveNetwork = Boolean(requestedRepo) || dependencies.strictMetadataErrors;
  const networkPromise = mustResolveNetwork
    ? (dependencies.strictMetadataErrors
        ? resolveNetwork(octokit, directory, remoteName, { strictErrors: true })
        : resolveNetwork(octokit, directory, remoteName))
    : Promise.resolve(null);
  const network = dependencies.strictNetworkErrors
    ? requireGitHubRepoNetwork(await networkPromise, repo)
    : await networkPromise.catch(() => null);
  if (!requestedRepo) return repo;
  if (repo?.owner === requestedRepo.owner && repo?.repo === requestedRepo.repo) return requestedRepo;
  const allowed = Array.isArray(network)
    ? network.some((item) => item?.owner === requestedRepo.owner && item?.repo === requestedRepo.repo)
    : false;
  return allowed ? requestedRepo : null;
}

function setPrStatusCache(key, data, fetchedAt, authority = null) {
  // Evict oldest entry when cache exceeds max size
  if (prStatusCache.size >= PR_STATUS_CACHE_MAX_ENTRIES && !prStatusCache.has(key)) {
    const oldest = prStatusCache.entries().next().value;
    if (oldest) {
      prStatusCache.delete(oldest[0]);
    }
  }
  prStatusCache.set(key, { data, fetchedAt, authority });
}

export function registerGitHubRoutes(app, options = {}) {
  const retireLegacyResourceRoute = (_req, res) => res.status(410).json({
    error: 'Legacy GitHub repository API is retired',
    code: 'SOURCE_CONTROL_CONTEXT_REQUIRED',
  });
  for (const suffix of retiredLegacyGitHubGetRoutes) app.get(`/api/github${suffix}`, retireLegacyResourceRoute);
  for (const suffix of retiredLegacyGitHubPostRoutes) app.post(`/api/github${suffix}`, retireLegacyResourceRoute);
  let githubLibraries = null;
  let oauthFlowRegistry = options.oauthFlowRegistry ?? null;
  const getGitHubLibraries = async () => {
    if (!githubLibraries) {
      githubLibraries = await import('./index.js');
    }
    return githubLibraries;
  };
  const getOAuthFlowRegistry = async () => {
    if (oauthFlowRegistry) return oauthFlowRegistry;
    const { createOAuthFlowRegistry } = await import('../source-control/oauth-flow-registry.js');
    oauthFlowRegistry = createOAuthFlowRegistry();
    return oauthFlowRegistry;
  };
  const sendOAuthFlowError = (res, error) => {
    if (error?.code === 'SOURCE_CONTROL_OAUTH_FLOW_BUSY') {
      return res.status(409).json({ error: 'OAuth flow is busy', code: error.code });
    }
    if (error?.code === 'SOURCE_CONTROL_OAUTH_FLOW_UNAVAILABLE') {
      return res.status(410).json({ error: 'OAuth flow is unavailable', code: error.code });
    }
    return null;
  };
  const sendAuthStorageError = (res, error) => {
    if (error?.code?.startsWith('SOURCE_CONTROL_LOCK_')) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    if (error?.code === 'INVALID_GITHUB_AUTH') {
      return res.status(500).json({ error: error.message, code: error.code });
    }
    return null;
  };
  const accountIdentity = (accountId) => ({ provider: 'github', instance: 'github.com', accountId });
  const cliAccountView = (user, current) => ({
    id: `github.com#cli:${user.id}`,
    credentialId: `github.com#cli:${user.id}`,
    credentialRevision: 1,
    providerUserId: `github.com#${user.id}`,
    providerUserStatus: 'available',
    user,
    current,
    source: 'gh-cli',
    status: 'valid',
  });
  const invalidateAccount = async (accountId) => {
    const { markGitHubAuthAccountInvalid } = await getGitHubLibraries();
    await options.onAccountInvalidated?.(accountIdentity(accountId));
    await markGitHubAuthAccountInvalid(accountId, 'unauthorized');
  };
  const invalidateRequestAccount = async (error) => {
    const identity = error?.sourceControlIdentity;
    if (error?.status !== 401 || error?.sourceControlAccountUnavailable || !identity?.accountId) return false;
    if (error.sourceControlInvalidated) return true;
    if (error.sourceControlPersistedAccount) await invalidateAccount(identity.accountId);
    else await options.onAccountInvalidated?.(identity);
    return true;
  };
  const getOctokitForRequest = async (req, exactAccountId = '') => {
    const accountIdValue = exactAccountId || req.query?.accountId || req.body?.accountId;
    const accountId = Object.prototype.toString.call(accountIdValue) === '[object String]' ? accountIdValue.trim() : '';
    const libraries = await getGitHubLibraries();
    if (!accountId) {
      const octokit = await libraries.getOctokitOrNull();
      return octokit ? {
        octokit,
        cacheIdentity: libraries.getOctokitCacheIdentity(octokit),
        user: (await libraries.getGitHubAuth())?.user ?? null,
      } : null;
    }
    const context = await libraries.getOctokitForAccountId(accountId, {
      onUnauthorized: async (identity, persisted) => {
        if (persisted) await invalidateAccount(identity.accountId);
        else await options.onAccountInvalidated?.(identity);
      },
    });
    if (context) {
      return {
        ...context,
        cacheIdentity: libraries.getOctokitCacheIdentity(context.octokit),
      };
    }
    const error = new Error('GitHub account is unavailable');
    error.status = 401;
    error.sourceControlAccountUnavailable = true;
    throw error;
  };
  const getOctokitForRead = async (req, trustedContext) => {
    if (trustedContext) return getOctokitForRequest(req, trustedContext.accountId);
    const libraries = await getGitHubLibraries();
    const octokit = await libraries.getOctokitOrNull();
    return octokit ? {
      octokit,
      cacheIdentity: libraries.getOctokitCacheIdentity(octokit),
      user: (await libraries.getGitHubAuth())?.user ?? null,
    } : null;
  };
  const sendExactAccountError = (res, error) => {
    const storageError = sendAuthStorageError(res, error);
    if (storageError) return storageError;
    if (!error?.sourceControlAccountUnavailable && !(error?.status === 401 && error?.sourceControlIdentity)) return null;
    return res.status(401).json({ error: 'GitHub account is unavailable' });
  };
  const validateReadContext = (req, directory) => options.validateReadContext?.({
    directory,
    repositoryId: req.query?.repositoryId,
    provider: 'github',
    instance: req.query?.instance,
    accountId: req.query?.accountId,
    bindingRevision: Number(req.query?.bindingRevision),
    primaryRemote: req.query?.primaryRemote,
  });
  const isReadContextError = (error) => error?.code?.startsWith('SOURCE_CONTROL_BINDING_')
    || error?.code?.startsWith('SOURCE_CONTROL_LOCK_')
    || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT'
    || error?.code === 'INVALID_SOURCE_CONTROL_BINDING';
  const readContextErrorBody = (error) => {
    const body = { error: error.message, code: error.code };
    if (error.current !== undefined) body.current = error.current;
    return body;
  };
  const isMutationContextError = (error) => error?.code?.startsWith('SOURCE_CONTROL_BINDING_')
    || error?.code?.startsWith('SOURCE_CONTROL_LOCK_')
    || error?.code === 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT'
    || error?.code === 'INVALID_SOURCE_CONTROL_BINDING';

  const canonicalMutationError = (message, code = 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status = 400) => {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    return error;
  };
  const requiredMutationText = (value, name) => {
    if (!isProviderString(value) || !value.trim()) throw canonicalMutationError(`${name} is required`);
    return value.trim();
  };
  const optionalMutationText = (value, name, trim = false) => {
    if (value === undefined) return undefined;
    if (!isProviderString(value)) throw canonicalMutationError(`${name} is invalid`);
    const normalized = trim ? value.trim() : value;
    if (trim && !normalized) throw canonicalMutationError(`${name} is invalid`);
    return normalized;
  };
  const sameProject = (left, right) => left?.owner === right?.owner && left?.name === right?.name;
  const repoProject = (repo) => ({ owner: repo.owner, name: repo.repo });
  const requireMutationPullRequest = (value, message) => {
    const pr = requireGitHubPullRequest(value, message);
    if (!isProviderString(pr.head?.sha) || !pr.head.sha.trim()
      || Object.prototype.toString.call(pr.draft) !== '[object Boolean]'
      || Object.prototype.toString.call(pr.merged) !== '[object Boolean]'
      || !isPlainObject(pr.base?.repo)
      || !isPlainObject(pr.base.repo.owner)
      || !isProviderString(pr.base.repo.owner.login) || !pr.base.repo.owner.login.trim()
      || !isProviderString(pr.base.repo.name) || !pr.base.repo.name.trim()
      || !matchesGitHubRepositoryUrl(pr.base.repo.html_url, pr.base.repo.owner.login, pr.base.repo.name)) {
      throw invalidProviderPayload(message);
    }
    return pr;
  };
  const pullTargetProject = (pr) => ({ owner: pr.base.repo.owner.login, name: pr.base.repo.name });
  const actualMutationTarget = (context, project, pr = null, expected = null) => {
    const target = {
      repositoryId: context.repositoryId,
      bindingRevision: context.bindingRevision,
      primaryRemote: context.primaryRemote,
      project: { id: `${project.owner}/${project.name}`, owner: project.owner, name: project.name },
    };
    if (pr) {
      target.number = pr.number;
      target.head = pr.head.ref;
      target.base = pr.base.ref;
      target.headSha = pr.head.sha;
    } else {
      target.head = expected.head;
      target.base = expected.base;
    }
    return target;
  };
  const mutationTargetMatches = (expected, pr) => pr.number === expected.number
    && (expected.head === undefined || pr.head.ref === expected.head)
    && (expected.base === undefined || pr.base.ref === expected.base)
    && (expected.headSha === undefined || pr.head.sha === expected.headSha);
  const definiteFailure = (code) => ({ state: 'failed', result: { failureStatus: 409, failureCode: code } });
  const reconcileCreateMutation = async (octokit, expectedProject, sourceProject, head, base) => {
    const response = await octokit.rest.pulls.list({
      owner: expectedProject.owner,
      repo: expectedProject.name,
      state: 'all',
      head: `${sourceProject.owner}:${head}`,
      base,
      per_page: 100,
    });
    const candidates = requireProviderArray(response?.data, 'GitHub returned an invalid pull request list')
      .map((pr) => requireMutationPullRequest(pr, 'GitHub returned an invalid pull request'))
      .filter((pr) => pr.head.ref === head && pr.base.ref === base)
      .filter((pr) => sameProject(pullTargetProject(pr), expectedProject))
      .filter((pr) => pr.head.repo
        && sameProject({ owner: pr.head.repo.owner.login, name: pr.head.repo.name }, sourceProject));
    return candidates.length === 1 ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
  };
  const reconcileExistingMutation = async (octokit, kind, target) => {
    const current = await octokit.rest.pulls.get({
      owner: target.project.owner,
      repo: target.project.name,
      pull_number: target.number,
    });
    const currentPr = requireMutationPullRequest(current?.data, 'GitHub returned an invalid pull request');
    if (kind === 'merge') {
      if (currentPr.merged === true || isProviderString(currentPr.merged_at)) {
        return { state: 'succeeded', result: { merged: true } };
      }
      if (currentPr.state === 'open' && currentPr.merged === false) {
        return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
      }
    } else if (kind === 'ready') {
      if (currentPr.draft === false) return { state: 'succeeded', result: { ready: true } };
      if (currentPr.draft === true && currentPr.state === 'open') {
        return definiteFailure('SOURCE_CONTROL_MUTATION_NOT_APPLIED');
      }
    }
    return { state: 'outcome-unknown' };
  };
  const classifyMutationError = (error) => {
    const status = error?.response?.status ?? error?.status;
    if (Number.isSafeInteger(status) && status >= 400 && status <= 499) {
      if (!Number.isSafeInteger(error.status)) error.status = status;
      if (!isProviderString(error.code)) error.code = 'GITHUB_MUTATION_REJECTED';
      return 'failed';
    }
    return 'outcome-unknown';
  };
  const sendCanonicalMutationError = async (res, error) => {
    if (error?.status === 401) await invalidateRequestAccount(error);
    const status = Number.isSafeInteger(error?.status) && error.status >= 400 && error.status <= 599
      ? error.status
      : 500;
    const code = isProviderString(error?.code) && error.code
      ? error.code
      : 'GITHUB_MUTATION_FAILED';
    const message = isMutationContextError(error) || code.startsWith('SOURCE_CONTROL_MUTATION_') || code.startsWith('SOURCE_CONTROL_LOCK_')
      ? error.message
      : status === 401 ? 'GitHub account is unavailable' : 'GitHub mutation failed';
    const body = { error: message, code };
    if (error?.current !== undefined) body.current = error.current;
    return res.status(status).json(body);
  };

  const mutationConflict = () => canonicalMutationError(
    'Source control mutation idempotency key was already used with different input',
    'SOURCE_CONTROL_MUTATION_CONFLICT',
    409,
  );
  const normalizeMutationOperation = (kind, req, context, actor, credential) => {
    if (kind === 'create') {
      const title = requiredMutationText(req.body?.title, 'title');
      const body = optionalMutationText(req.body?.body, 'body');
      if (req.body?.draft !== undefined && Object.prototype.toString.call(req.body.draft) !== '[object Boolean]') {
        throw canonicalMutationError('draft is invalid');
      }
      const draft = req.body?.draft;
      const remote = optionalMutationText(req.body?.remote, 'remote', true);
      const headRemote = optionalMutationText(req.body?.headRemote, 'headRemote', true) ?? context.primaryRemote;
      const head = requiredMutationText(context.target.head, 'target head');
      const base = requiredMutationText(context.target.base, 'target base');
      if (context.target.number !== undefined || context.target.headSha !== undefined) {
        throw canonicalMutationError('Create target is invalid');
      }
      return {
        title, body, draft, remote, headRemote, head, base,
        digest(target) {
          const input = { kind, actor, credential, target, title, headRemote };
          if (body !== undefined) input.body = body;
          if (draft !== undefined) input.draft = draft;
          if (remote) input.remote = remote;
          return digestMutationInput(input);
        },
      };
    }

    if (!Number.isSafeInteger(context.target.number) || context.target.number < 1) {
      throw canonicalMutationError('target number is required');
    }
    if (kind === 'update') {
      const title = requiredMutationText(req.body?.title, 'title');
      const body = optionalMutationText(req.body?.body, 'body');
      return {
        title, body,
        digest(target) {
          const input = { kind, actor, credential, target, title };
          if (body !== undefined) input.body = body;
          return digestMutationInput(input);
        },
      };
    }
    if (kind === 'merge') {
      const method = requiredMutationText(req.body?.method, 'method');
      if (!['merge', 'squash', 'rebase'].includes(method)) throw canonicalMutationError('merge method is invalid');
      return { method, digest: (target) => digestMutationInput({ kind, actor, credential, target, method }) };
    }
    if (kind === 'ready') return { digest: (target) => digestMutationInput({ kind, actor, credential, target }) };
    throw canonicalMutationError('Mutation kind is invalid');
  };
  const storedMutationAuthorityMatches = (record, kind, actor, context) => {
    const target = record?.target;
    const expected = context.target;
    return record?.kind === `change-request-${kind}`
      && record.actor?.provider === actor.provider
      && record.actor?.instance === actor.instance
      && record.actor?.accountId === actor.accountId
      && target?.repositoryId === context.repositoryId
      && target?.bindingRevision === context.bindingRevision
      && target?.primaryRemote === context.primaryRemote
      && target?.project?.id === `${expected.project.owner}/${expected.project.name}`
      && target?.project?.owner === expected.project.owner
      && target?.project?.name === expected.project.name
      && (expected.number === undefined || target?.number === expected.number)
      && (expected.head === undefined || target?.head === expected.head)
      && (expected.base === undefined || target?.base === expected.base)
      && (expected.headSha === undefined || target?.headSha === expected.headSha);
  };

  const invalidateCanonicalMutationCaches = async (context, accountContext, target) => {
    const authority = {
      cacheIdentity: accountContext.cacheIdentity,
      repositoryId: context.repositoryId,
      bindingRevision: context.bindingRevision,
      primaryRemote: context.primaryRemote,
    };
    for (const [key, entry] of prStatusCache) {
      if (cacheAuthorityMatches(entry.authority, authority)) {
        prStatusCache.delete(key);
      }
    }
    for (const [token, pending] of pendingPrStatusWrites) {
      if (cacheAuthorityMatches(pending, authority)) pendingPrStatusWrites.delete(token);
    }
    invalidatePrContextCache(null, target.number, authority);
    const { invalidateRepoPullsCache } = await import('./pr-status.js');
    invalidateRepoPullsCache(target.project.owner, target.project.name, accountContext.octokit);
  };

  const runCanonicalMutation = async (kind, req, res) => {
    try {
      if (!(options.validateMutationContext instanceof Function)
        || !(options.mutationExecutor?.execute instanceof Function)
        || !(options.mutationExecutor?.read instanceof Function)) {
        return res.status(501).json({
          error: 'Bound source control mutations are unavailable',
          code: 'SOURCE_CONTROL_MUTATION_UNAVAILABLE',
        });
      }
      const context = await options.validateMutationContext(req.body ?? {});
      const accountContext = await getOctokitForRequest(req, context.accountId);
      const octokit = accountContext.octokit;
      const actor = { provider: 'github', instance: context.instance, accountId: context.accountId };
      if (accountContext.accountId !== context.accountId
        || !Number.isSafeInteger(accountContext.credentialRevision) || accountContext.credentialRevision < 1
        || !isProviderString(accountContext.providerUserId)
        || !/^github\.com#\d+$/.test(accountContext.providerUserId)) {
        throw canonicalMutationError('GitHub account is unavailable', 'SOURCE_CONTROL_ACCOUNT_UNAVAILABLE', 401);
      }
      const credential = {
        accountId: accountContext.accountId,
        credentialRevision: accountContext.credentialRevision,
      };
      const operation = normalizeMutationOperation(kind, req, context, actor, credential);
      const stored = await options.mutationExecutor.read(context.idempotencyKey);
      const resolveDirectoryRepo = async (...args) => {
        const resolver = options.resolveGitHubRepoFromDirectory
          ?? (await import('./index.js')).resolveGitHubRepoFromDirectory;
        return resolver(...args);
      };
      if (stored) {
        if (!storedMutationAuthorityMatches(stored, kind, actor, context)) throw mutationConflict();
        const inputDigest = operation.digest(stored.target);
        if (stored.inputDigest !== inputDigest) throw mutationConflict();
        const reconcile = async () => {
          const target = stored.target;
          const expectedProject = target.project;
          if (kind === 'create') {
            const sourceRepo = (await resolveDirectoryRepo(context.directory, operation.headRemote))?.repo;
            const sourceProject = sourceRepo ? repoProject(sourceRepo) : null;
            if (!sourceProject) return { state: 'outcome-unknown' };
            return reconcileCreateMutation(octokit, expectedProject, sourceProject, operation.head, operation.base);
          }
          return reconcileExistingMutation(octokit, kind, target);
        };
        const execution = await options.mutationExecutor.execute({
          record: {
            key: stored.key,
            inputDigest,
            kind: stored.kind,
            actor: stored.actor,
            target: stored.target,
          },
          providerAccountId: accountContext.providerUserId,
          perform: async () => { throw mutationConflict(); },
          reconcile,
          classifyError: classifyMutationError,
        });
        await invalidateCanonicalMutationCaches(context, accountContext, execution.record.target);
        return res.json(mutationReceipt(execution.record, execution.replayed, accountContext.providerUserId));
      }

      const resolveNetwork = options.resolveRepoNetwork
        ?? (await import('./repo/fork-detection.js')).resolveRepoNetwork;
      const primaryResolved = await resolveDirectoryRepo(context.directory, context.primaryRemote);
      const primaryRepo = primaryResolved?.repo;
      if (!primaryRepo) throw canonicalMutationError('Unable to resolve trusted GitHub primary remote', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      const networkPayload = await resolveNetwork(octokit, context.directory, context.primaryRemote, { strictErrors: true });
      const network = requireGitHubRepoNetwork(networkPayload, primaryRepo);
      const projects = [repoProject(primaryRepo), ...(network ?? []).map((repo) => repoProject(repo))];
      const expectedProject = context.target.project;
      if (!projects.some((project) => sameProject(project, expectedProject))) {
        throw canonicalMutationError('GitHub mutation target is outside the bound repository network', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
      }

      let target;
      let perform;
      let reconcile;

      if (kind === 'create') {
        const { title, body, draft, remote, headRemote, head, base } = operation;
        if (remote) {
          const selected = (await resolveDirectoryRepo(context.directory, remote))?.repo;
          if (!selected || !sameProject(repoProject(selected), expectedProject)) {
            throw canonicalMutationError('remote does not match the mutation target', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
          }
        }
        const sourceRepo = (await resolveDirectoryRepo(context.directory, headRemote))?.repo;
        const sourceProject = sourceRepo ? repoProject(sourceRepo) : null;
        if (!sourceProject || !projects.some((project) => sameProject(project, sourceProject))) {
          throw canonicalMutationError('GitHub mutation source is outside the bound repository network', 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', 409);
        }
        const headRef = sameProject(sourceProject, expectedProject) ? head : `${sourceProject.owner}:${head}`;
        target = actualMutationTarget(context, expectedProject, null, { head, base });
        perform = async () => {
          const createInput = { owner: expectedProject.owner, repo: expectedProject.name, title, head: headRef, base };
          if (body !== undefined) createInput.body = body;
          if (draft !== undefined) createInput.draft = draft;
          const response = await octokit.rest.pulls.create(createInput);
          const created = requireMutationPullRequest(response?.data, 'GitHub returned an invalid created pull request');
          const createdSource = created.head.repo
            ? { owner: created.head.repo.owner.login, name: created.head.repo.name }
            : null;
          if (!mutationTargetMatches({ number: created.number, head, base }, created)
            || !sameProject(pullTargetProject(created), expectedProject)
            || !sameProject(createdSource, sourceProject)) {
            throw invalidProviderPayload('GitHub returned a created pull request with an unexpected target');
          }
          return {};
        };
        reconcile = () => reconcileCreateMutation(octokit, expectedProject, sourceProject, head, base);
      } else {
        if (!Number.isSafeInteger(context.target.number) || context.target.number < 1) {
          throw canonicalMutationError('target number is required');
        }
        const response = await octokit.rest.pulls.get({
          owner: expectedProject.owner, repo: expectedProject.name, pull_number: context.target.number,
        });
        const pr = requireMutationPullRequest(response?.data, 'GitHub returned an invalid pull request');
        if (!sameProject(pullTargetProject(pr), expectedProject) || !mutationTargetMatches(context.target, pr)) {
          throw canonicalMutationError('GitHub pull request no longer matches the mutation target', 'SOURCE_CONTROL_MUTATION_TARGET_CHANGED', 409);
        }
        target = actualMutationTarget(context, expectedProject, pr);

        if (kind === 'update') {
          const { title, body } = operation;
          perform = async () => {
            const updateInput = { owner: expectedProject.owner, repo: expectedProject.name, pull_number: target.number, title };
            if (body !== undefined) updateInput.body = body;
            const updated = await octokit.rest.pulls.update(updateInput);
            const updatedPr = requireMutationPullRequest(updated?.data, 'GitHub returned an invalid updated pull request');
            if (!sameProject(pullTargetProject(updatedPr), expectedProject) || !mutationTargetMatches(target, updatedPr)) {
              throw invalidProviderPayload('GitHub returned an updated pull request with an unexpected target');
            }
            return {};
          };
          reconcile = () => reconcileExistingMutation(octokit, kind, target);
        } else if (kind === 'merge') {
          const { method } = operation;
          perform = async () => {
            const merged = await octokit.rest.pulls.merge({
              owner: expectedProject.owner,
              repo: expectedProject.name,
              pull_number: target.number,
              merge_method: method,
              sha: target.headSha,
            });
            const data = merged?.data;
            if (!isPlainObject(data) || Object.prototype.toString.call(data.merged) !== '[object Boolean]'
              || (data.message !== undefined && !isProviderString(data.message))) {
              throw invalidProviderPayload('GitHub returned an invalid merge result');
            }
            return { merged: data.merged };
          };
          reconcile = () => reconcileExistingMutation(octokit, kind, target);
        } else {
          const alreadyReady = pr.draft === false;
          const nodeId = optionalMutationText(pr.node_id, 'pull request node id', true);
          if (!alreadyReady && !nodeId) throw invalidProviderPayload('GitHub returned an invalid pull request node id');
          perform = async () => {
            if (!alreadyReady) {
              const ready = await octokit.graphql(
                `mutation($pullRequestId: ID!) {\n  markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {\n    pullRequest {\n      id\n      isDraft\n    }\n  }\n}`,
                { pullRequestId: nodeId },
              );
              const result = ready?.markPullRequestReadyForReview?.pullRequest;
              if (!isPlainObject(result) || result.id !== nodeId || result.isDraft !== false) {
                throw invalidProviderPayload('GitHub returned an invalid ready-for-review result');
              }
            }
            return { ready: true };
          };
          reconcile = () => reconcileExistingMutation(octokit, kind, target);
        }
      }

      const execution = await options.mutationExecutor.execute({
        record: {
          key: context.idempotencyKey,
          inputDigest: operation.digest(target),
          kind: `change-request-${kind}`,
          actor,
          target,
        },
        providerAccountId: accountContext.providerUserId,
        perform,
        reconcile,
        classifyError: classifyMutationError,
      });
      await invalidateCanonicalMutationCaches(context, accountContext, execution.record.target);
      return res.json(mutationReceipt(execution.record, execution.replayed, accountContext.providerUserId));
    } catch (error) {
      return sendCanonicalMutationError(res, error);
    }
  };

  const getGitHubUserSummary = async (octokit) => {
    const me = await octokit.rest.users.getAuthenticated();

    let email = typeof me.data.email === 'string' ? me.data.email : null;
    if (!email) {
      try {
        const emails = await octokit.rest.users.listEmailsForAuthenticatedUser({ per_page: 100 });
        const list = Array.isArray(emails?.data) ? emails.data : [];
        const primaryVerified = list.find((e) => e && e.primary && e.verified && typeof e.email === 'string');
        const anyVerified = list.find((e) => e && e.verified && typeof e.email === 'string');
        email = primaryVerified?.email || anyVerified?.email || null;
      } catch {
        // ignore (scope might be missing)
      }
    }

    return {
      login: me.data.login,
      id: me.data.id,
      avatarUrl: me.data.avatar_url,
      name: typeof me.data.name === 'string' ? me.data.name : null,
      email,
    };
  };

  const isGitHubAuthInvalid = (error) => error?.status === 401;
  const isGitHubResourceUnavailable = (error) => error?.status === 403 || error?.status === 404;

  app.get('/api/source-control/github/capabilities', (req, res) => {
    const requestedInstance = typeof req.query?.instance === 'string' ? req.query.instance.trim() : '';
    if (requestedInstance && requestedInstance !== 'github.com') {
      return res.status(400).json({ error: 'Unsupported GitHub instance' });
    }
    const instance = 'github.com';
    return res.json({
      identity: { provider: 'github', instance },
      authentication: true,
      authenticationMethods: {
        device: { available: true },
        pat: { available: false, reason: 'unsupported' },
        cli: { available: true },
      },
      multipleAccounts: true,
      projects: true,
      issues: true,
      changeRequests: true,
      draftChangeRequests: true,
      mergeChangeRequests: true,
      mergeMethods: ['merge', 'squash', 'rebase'],
      ci: true,
    });
  });

  app.get(githubAuthRoutePaths('/auth/status'), async (_req, res) => {
    try {
      const { getGitHubAuth, getOctokitOrNull, getGitHubAuthAccounts, githubCliAccountId, isGhCliActive, isGhCliDisabled, setGhCliActive } = await getGitHubLibraries();
      const { getGhCliToken } = await import('./gh-cli-credential.js');

      const auth = await getGitHubAuth();
      let accounts = await getGitHubAuthAccounts();
      const ghCliDisabled = isGhCliDisabled();
      const ghCliActive = isGhCliActive();
      const ghToken = getGhCliToken();
      const usingOwnToken = Boolean(auth?.accessToken);
      const selectedPersisted = accounts.some((account) => account.current);
      let ghCliUser = null;

      if (ghToken !== null && !ghCliDisabled) {
        try {
          const { createOctokit } = await import('./octokit.js');
          ghCliUser = await getGitHubUserSummary(createOctokit(ghToken));
        } catch {
          ghCliUser = null;
        }
      }
      if (ghCliActive && !ghCliUser) {
        setGhCliActive(false);
      }

      const ghCliCurrent = ghToken !== null && !ghCliDisabled && Boolean(ghCliUser) && (ghCliActive || !selectedPersisted);
      if (ghCliUser) {
        accounts = accounts
          .map((account) => ({ ...account, current: ghCliCurrent ? false : Boolean(account.current) }))
          .concat(cliAccountView(ghCliUser, ghCliCurrent));
      }

      const buildGhCli = (activeUser = null) => ({
        available: ghToken !== null,
        disabled: ghCliDisabled,
        active: ghCliCurrent,
        ...(!ghCliDisabled && (activeUser || ghCliUser) ? { user: activeUser || ghCliUser } : {}),
      });

      if (selectedPersisted && !usingOwnToken) {
        return res.json({ connected: false, accounts, ghCli: buildGhCli() });
      }
      const octokit = await getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false, accounts, ghCli: buildGhCli() });
      }

      let user = null;
      try {
        user = await getGitHubUserSummary(octokit);
      } catch (error) {
        if (isGitHubAuthInvalid(error)) {
          if (usingOwnToken) await invalidateAccount(auth.accountId);
          return res.json({ connected: false, accounts: await getGitHubAuthAccounts(), ghCli: buildGhCli() });
        }
      }

      const fallback = usingOwnToken ? auth.user : null;
      const mergedUser = user || fallback;
      return res.json({
        connected: true,
        user: mergedUser,
        scope: ghCliCurrent ? undefined : auth?.scope,
        accounts,
        ghCli: buildGhCli(ghCliCurrent ? mergedUser : null),
      });
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      console.error('Failed to get GitHub auth status:', error);
      return res.status(500).json({ error: error.message || 'Failed to get GitHub auth status' });
    }
  });

  app.get(githubAuthRoutePaths('/auth/accounts'), async (_req, res) => {
    try {
      const { getGitHubAuthAccounts } = await getGitHubLibraries();
      return res.json({ provider: 'github', instance: 'github.com', accounts: await getGitHubAuthAccounts() });
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      return res.status(500).json({ error: error?.message || 'Failed to list GitHub accounts' });
    }
  });

  app.post(githubAuthRoutePaths('/auth/gh-cli'), async (req, res) => {
    try {
      const { setGhCliDisabled, isGhCliDisabled } = await getGitHubLibraries();

      const disabled = Boolean(req.body?.disabled);
      setGhCliDisabled(disabled);
      return res.json({ disabled: isGhCliDisabled() });
    } catch (error) {
      console.error('Failed to update gh CLI setting:', error);
      return res.status(500).json({ error: error.message || 'Failed to update gh CLI setting' });
    }
  });

  app.post(githubAuthRoutePaths('/auth/start'), async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const { getGitHubClientId, getGitHubScopes, startDeviceFlow } = await getGitHubLibraries();
      const clientId = getGitHubClientId();
      if (!clientId) {
        return res.status(400).json({
          error: 'GitHub OAuth client not configured. Set OPENCHAMBER_GITHUB_CLIENT_ID.',
        });
      }

      const scope = getGitHubScopes();

      const payload = await startDeviceFlow({
        clientId,
        scope,
        fetch: options.fetch,
        timeoutMs: options.timeoutMs,
      });
      const registry = await getOAuthFlowRegistry();
      const { flowId } = registry.register({
        provider: 'github',
        instance: GITHUB_OAUTH_INSTANCE,
        deviceCode: payload.device_code,
        clientId,
        expiresIn: payload.expires_in,
      });

      return res.json({
        flowId,
        userCode: payload.user_code,
        verificationUri: payload.verification_uri,
        verificationUriComplete: payload.verification_uri_complete,
        expiresIn: payload.expires_in,
        interval: payload.interval,
        scope,
      });
    } catch (error) {
      console.error('Failed to start GitHub device flow:', error);
      return res.status(500).json({ error: error.message || 'Failed to start GitHub device flow' });
    }
  });

  app.post(githubAuthRoutePaths('/auth/complete'), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    let registry;
    let flowId = '';
    try {
      const { exchangeDeviceCode, setGitHubAuth, getGitHubAuthAccounts } = await getGitHubLibraries();
      flowId = typeof req.body?.flowId === 'string' ? req.body.flowId.trim() : '';
      if (!flowId) return res.status(400).json({ error: 'flowId is required' });
      registry = await getOAuthFlowRegistry();
      let flow;
      try {
        flow = registry.acquire({ flowId, provider: 'github', instance: GITHUB_OAUTH_INSTANCE });
      } catch (error) {
        return sendOAuthFlowError(res, error);
      }
      const { clientId, deviceCode } = flow;
      const payload = await exchangeDeviceCode({ clientId, deviceCode, fetch: options.fetch, timeoutMs: options.timeoutMs });

      if (payload?.error) {
        if (payload.error === 'authorization_pending' || payload.error === 'slow_down') {
          registry.release(flowId);
        } else {
          registry.consume(flowId);
        }
        return res.json({
          connected: false,
          status: payload.error,
          error: payload.error_description || payload.error,
        });
      }

      const accessToken = payload?.access_token;
      registry.consume(flowId);
      if (!accessToken) {
        return res.status(500).json({ error: 'Missing access_token from GitHub' });
      }

      const { createOctokit } = await import('./octokit.js');
      const octokit = createOctokit(accessToken);
      const user = await getGitHubUserSummary(octokit);

      const credential = await setGitHubAuth({
        accessToken,
        scope: typeof payload.scope === 'string' ? payload.scope : '',
        tokenType: typeof payload.token_type === 'string' ? payload.token_type : 'bearer',
        user,
      });
      // A connected account is a complete identity waiting to be written: who
      // it is, what it authenticates with, and how it signs are all known here.
      // Signing in again renews a credential rather than replacing it, so the
      // ones this supersedes are named too.
      if (credential?.credentialId) {
        const account = { provider: 'github', instance: 'github.com', accountId: credential.credentialId };
        const superseded = (await getGitHubAuthAccounts()).filter((candidate) =>
          candidate.providerUserId === credential.providerUserId && candidate.id !== credential.credentialId);
        options.onAccountConnected?.({
          account,
          user,
          renews: superseded.map((candidate) => ({ ...account, accountId: candidate.id })),
        });
      }

      return res.json({
        connected: true,
        user,
        scope: typeof payload.scope === 'string' ? payload.scope : '',
        accounts: await getGitHubAuthAccounts(),
      });
    } catch (error) {
      if (registry && flowId) registry.release(flowId);
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      console.error('Failed to complete GitHub device flow:', error);
      return res.status(500).json({ error: error.message || 'Failed to complete GitHub device flow' });
    }
  });

  app.post(githubAuthRoutePaths('/auth/activate'), async (req, res) => {
    try {
      const { activateGitHubAuth, getGitHubAuth, getOctokitOrNull, getGitHubAuthAccounts, GH_CLI_ACCOUNT_ID, githubCliAccountId, isGhCliDisabled, setGhCliActive } = await getGitHubLibraries();
      const accountId = typeof req.body?.accountId === 'string' ? req.body.accountId : '';
      if (!accountId) {
        return res.status(400).json({ error: 'accountId is required' });
      }
      if (accountId === GH_CLI_ACCOUNT_ID || accountId.startsWith('github.com#cli:')) {
        const { getGhCliToken } = await import('./gh-cli-credential.js');
        const ghToken = !isGhCliDisabled() ? getGhCliToken() : null;
        if (!ghToken) {
          return res.status(404).json({ error: 'GitHub CLI account not found' });
        }

        const { createOctokit } = await import('./octokit.js');
        const user = await getGitHubUserSummary(createOctokit(ghToken));
        const cliAccountId = githubCliAccountId(user.id);
        if (accountId !== GH_CLI_ACCOUNT_ID && accountId !== cliAccountId) {
          return res.status(404).json({ error: 'GitHub CLI account not found' });
        }
        setGhCliActive(true);
        const accounts = (await getGitHubAuthAccounts())
          .map((account) => ({ ...account, current: false }))
          .concat(cliAccountView(user, true));
        return res.json({
          connected: true,
          user,
          accounts,
          ghCli: {
            available: true,
            disabled: false,
            active: true,
            user,
          },
        });
      }

      const activated = await activateGitHubAuth(accountId);
      if (!activated) {
        return res.status(404).json({ error: 'GitHub account not found' });
      }

      const auth = await getGitHubAuth();
      let accounts = await getGitHubAuthAccounts();
      if (!auth?.accessToken) {
        return res.json({ connected: false, accounts });
      }

      const { getGhCliToken } = await import('./gh-cli-credential.js');
      const ghCliDisabled = isGhCliDisabled();
      const ghToken = !ghCliDisabled ? getGhCliToken() : null;
      let ghCliUser = null;
      if (ghToken) {
        try {
          const { createOctokit } = await import('./octokit.js');
          ghCliUser = await getGitHubUserSummary(createOctokit(ghToken));
          accounts = accounts.concat(cliAccountView(ghCliUser, false));
        } catch {
          ghCliUser = null;
        }
      }

      const octokit = await getOctokitOrNull();
      if (!octokit) {
        return res.json({ connected: false, accounts, ghCli: { available: ghToken !== null, disabled: ghCliDisabled, active: false, ...(ghCliUser ? { user: ghCliUser } : {}) } });
      }

      let user = auth.user || null;
      try {
        user = await getGitHubUserSummary(octokit);
      } catch (error) {
        if (isGitHubAuthInvalid(error)) {
          await invalidateAccount(auth.accountId);
          return res.json({ connected: false, accounts: await getGitHubAuthAccounts() });
        }
      }

      return res.json({
        connected: true,
        user,
        scope: auth.scope,
        accounts,
        ghCli: {
          available: ghToken !== null,
          disabled: ghCliDisabled,
          active: false,
          ...(ghCliUser ? { user: ghCliUser } : {}),
        },
      });
    } catch (error) {
      const lockResponse = sendAuthStorageError(res, error);
      if (lockResponse) return lockResponse;
      console.error('Failed to activate GitHub account:', error);
      return res.status(500).json({ error: error.message || 'Failed to activate GitHub account' });
    }
  });

  app.delete(githubAuthRoutePaths('/auth'), async (req, res) => {
    try {
      const {
        getGitHubAuthAccounts, githubCliAccountId, isGhCliDisabled,
        setGhCliActive, removeGitHubAuthAccount,
      } = await getGitHubLibraries();
      const requested = req.query?.accountId ?? req.body?.accountId;
      const requestedAccountId = Object.prototype.toString.call(requested) === '[object String]' ? requested : '';
      if (!requestedAccountId || requestedAccountId.trim() !== requestedAccountId) {
        return res.status(400).json({ error: 'accountId is required' });
      }
      const accounts = await getGitHubAuthAccounts();
      if (requestedAccountId.startsWith('github.com#cli:')) {
        const { getGhCliToken } = await import('./gh-cli-credential.js');
        const token = isGhCliDisabled() ? null : getGhCliToken();
        if (!token) return res.json({ success: true, removed: false });
        const { createOctokit } = await import('./octokit.js');
        const user = await getGitHubUserSummary(createOctokit(token));
        if (githubCliAccountId(user.id) !== requestedAccountId) {
          return res.json({ success: true, removed: false });
        }
        await options.onAccountRemoved?.(accountIdentity(requestedAccountId));
        setGhCliActive(false);
        return res.json({ success: true, removed: true });
      }
      if (!accounts.some((account) => account.id === requestedAccountId)) return res.json({ success: true, removed: false });
      await options.onAccountRemoved?.(accountIdentity(requestedAccountId));
      const removed = await removeGitHubAuthAccount(requestedAccountId);
      return res.json({ success: true, removed });
    } catch (error) {
      if (error?.code?.startsWith('SOURCE_CONTROL_LOCK_')) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      console.error('Failed to disconnect GitHub:', error);
      return res.status(500).json({ error: error.message || 'Failed to disconnect GitHub' });
    }
  });

  app.get(['/api/github/me'], (_req, res) => res.status(410).json({
    error: 'GitHub account user route is retired',
    code: 'SOURCE_CONTROL_ACCOUNT_CONTEXT_REQUIRED',
  }));

  // ================= GitHub PR APIs =================

  app.get(canonicalGitHubRoutePath('/pr/status'), async (req, res) => {
    let cacheKey = '';
    let writeToken = null;
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const branch = typeof req.query?.branch === 'string' ? req.query.branch.trim() : '';
      const canonical = req.path.startsWith('/api/source-control/');
      const trustedContext = canonical
        ? await validateReadContext(req, directory)
        : null;
      if (canonical && !trustedContext) {
        return res.status(501).json({ error: 'Bound source control status is unavailable' });
      }
      const remote = trustedContext?.primaryRemote
        ?? (typeof req.query?.remote === 'string' ? req.query.remote.trim() : 'origin');
      const force = req.query?.force === 'true' || req.query?.force === '1';
      if (!directory || !branch) {
        return res.status(400).json({ error: 'directory and branch are required' });
      }

      // Resolve exact accounts before consulting caches so removed or invalid
      // credentials can never receive a previously cached response.
      const accountContext = await getOctokitForRequest(req, trustedContext?.accountId);
      const octokit = accountContext?.octokit;
      if (!octokit) {
        return res.json({ connected: false });
      }

      cacheKey = trustedContext
        ? `${directory}::${branch}::${remote}::${accountContext.cacheIdentity}::${trustedContext.repositoryId}::${trustedContext.bindingRevision}`
        : `${directory}::${branch}::${remote}::${accountContext.cacheIdentity}`;
      const cached = prStatusCache.get(cacheKey);
      if (!force && cached && Date.now() - cached.fetchedAt < PR_STATUS_CACHE_TTL_MS) {
        return res.json(cached.data);
      }

      // If GitHub recently rate-limited us, don't pile on more calls that will
      // also fail. Serve whatever we last cached (even if stale); otherwise
      // report a transient failure so the client keeps its last-known status.
      const { isGitHubRateLimited } = await import('./rate-limit.js');
      if (isGitHubRateLimited()) {
        if (cached) {
          return res.json(cached.data);
        }
        return res.status(503).json({ error: 'GitHub rate limited' });
      }

      if (canonical) {
        writeToken = {};
        pendingPrStatusWrites.set(writeToken, {
          cacheIdentity: accountContext.cacheIdentity,
          repositoryId: trustedContext.repositoryId,
          bindingRevision: trustedContext.bindingRevision,
          primaryRemote: trustedContext.primaryRemote,
        });
      }

      // Intercept res.json to cache successful responses before sending
      // Only caches responses with connected:true — error/edge-case responses are not cached
      const originalJson = res.json.bind(res);
      res.json = (data) => {
        if (data && data.connected === true && (!canonical || pendingPrStatusWrites.has(writeToken))) {
          // Freshness stamp travels with the payload (and survives cache
          // serves) so clients can refuse to overwrite newer data with a
          // stale cached response.
          if (typeof data.fetchedAt !== 'number') {
            data.fetchedAt = Date.now();
          }
          setPrStatusCache(cacheKey, data, data.fetchedAt, trustedContext ? {
            directory,
            cacheIdentity: accountContext.cacheIdentity,
            repositoryId: trustedContext.repositoryId,
            bindingRevision: trustedContext.bindingRevision,
            primaryRemote: trustedContext.primaryRemote,
          } : null);
        }
        return originalJson(data);
      };

      const resolveGitHubPrStatus = options.resolveGitHubPrStatus
        ?? (await import('./pr-status.js')).resolveGitHubPrStatus;
      const resolvedStatus = await withTimeout(
        resolveGitHubPrStatus({
          octokit,
          directory,
          branch,
          remoteName: remote,
          force,
        }),
        PR_STATUS_RESOLVE_TIMEOUT_MS,
        'resolveGitHubPrStatus',
      );
      const searchRepo = resolvedStatus.repo;
      const first = resolvedStatus.pr;
      if (!searchRepo) {
        return res.json({ connected: true, repo: null, branch, pr: null, checks: null, canMerge: false, defaultBranch: null, resolvedRemoteName: null });
      }
      if (!first) {
        return res.json({ connected: true, repo: searchRepo, branch, pr: null, checks: null, canMerge: false, defaultBranch: resolvedStatus.defaultBranch ?? null, resolvedRemoteName: resolvedStatus.resolvedRemoteName ?? null });
      }

      // Enrich with mergeability fields
      const prFull = await octokit.rest.pulls.get({ owner: searchRepo.owner, repo: searchRepo.repo, pull_number: first.number });
      const prData = prFull?.data;
      if (!prData) {
        return res.json({ connected: true, repo: searchRepo, branch, pr: null, checks: null, canMerge: false });
      }

      const isMerged = Boolean(prData.merged || prData.merged_at);
      const prState = isMerged ? 'merged' : (prData.state === 'closed' ? 'closed' : 'open');
      // A closed/merged PR is a historical record for this branch: its checks
      // are no longer actionable and it can never be merged from here, so skip
      // the extra GitHub calls those two fields would cost.
      const isHistorical = prState !== 'open';

      // Checks summary: prefer check-runs (Actions), fallback to classic statuses.
      let checks = null;
      const sha = prData.head?.sha;
      if (sha && !isHistorical) {
        try {
          const runs = await octokit.rest.checks.listForRef({
            owner: searchRepo.owner,
            repo: searchRepo.repo,
            ref: sha,
            per_page: 100,
          });
          const checkRuns = dedupeCheckRuns(canonical
            ? requireGitHubCheckRuns(runs?.data?.check_runs)
            : Array.isArray(runs?.data?.check_runs) ? runs.data.check_runs : []);
          if (checkRuns.length > 0) {
            checks = summarizeCheckRuns(checkRuns);
          }
        } catch {
          // ignore and fall back
        }

        if (!checks) {
          try {
            const combined = await octokit.rest.repos.getCombinedStatusForRef({
              owner: searchRepo.owner,
              repo: searchRepo.repo,
              ref: sha,
            });
            const statuses = canonical
              ? requireGitHubStatuses(combined?.data?.statuses)
              : Array.isArray(combined?.data?.statuses) ? combined.data.statuses : [];
            checks = summarizeCombinedStatuses(statuses);
          } catch {
            checks = null;
          }
        }
      }

      // Permission check (best-effort)
      let canMerge = false;
      if (!isHistorical) {
        try {
          // gh-CLI tokens have no persisted user record; resolve the login from
          // the API once (memoized) so permissions still resolve for them.
          let username = accountContext?.user?.login;
          if (!username) {
            if (!resolvedAuthLoginPromise) {
              resolvedAuthLoginPromise = octokit.rest.users.getAuthenticated()
                .then((resp) => resp?.data?.login || null)
                .catch(() => {
                  resolvedAuthLoginPromise = null;
                  return null;
                });
            }
            username = await resolvedAuthLoginPromise;
          }
          if (username) {
            const perm = await octokit.rest.repos.getCollaboratorPermissionLevel({
              owner: searchRepo.owner,
              repo: searchRepo.repo,
              username,
            });
            const level = perm?.data?.permission;
            canMerge = level === 'admin' || level === 'maintain' || level === 'write';
          }
        } catch {
          canMerge = false;
        }
      }

      return res.json({
        connected: true,
        repo: searchRepo,
        branch,
        pr: {
          number: prData.number,
          title: prData.title,
          body: prData.body || '',
          url: prData.html_url,
          state: prState,
          draft: Boolean(prData.draft),
          base: prData.base?.ref,
          head: prData.head?.ref,
          headSha: prData.head?.sha,
          mergeable: prData.mergeable,
          mergeableState: prData.mergeable_state,
        },
        checks,
        canMerge,
        defaultBranch: resolvedStatus.defaultBranch ?? null,
        resolvedRemoteName: resolvedStatus.resolvedRemoteName ?? null,
      });
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(readContextErrorBody(error));
      }
      const accountError = sendExactAccountError(res, error);
      if (accountError) return accountError;
      if (error?.status === 401) {
        await invalidateRequestAccount(error);
        return res.json({ connected: false });
      }
      // Transient failures — a rate limit, or the overall resolve timeout
      // firing — are expected under heavy load and should not be logged as hard
      // errors. Record a rate-limit cooldown when applicable, then serve the
      // last cached status (even if stale) or a 503 so the client keeps its
      // last-known value instead of clearing the badge.
      const { noteIfGitHubRateLimit } = await import('./rate-limit.js');
      const wasRateLimited = noteIfGitHubRateLimit(error);
      const wasTimeout = error?.code === 'ETIMEDOUT';
      if (wasRateLimited || wasTimeout) {
        const cached = cacheKey ? prStatusCache.get(cacheKey) : null;
        if (cached) {
          return res.json(cached.data);
        }
        return res.status(503).json({ error: wasRateLimited ? 'GitHub rate limited' : 'GitHub request timed out' });
      }
      if (isGitHubResourceUnavailable(error)) {
        return res.json({
          connected: true,
          repo: null,
          branch: typeof req.query?.branch === 'string' ? req.query.branch.trim() : '',
          pr: null,
          checks: null,
          canMerge: false,
          defaultBranch: null,
          resolvedRemoteName: null,
        });
      }
      console.error('Failed to load GitHub PR status:', error);
      return res.status(500).json({ error: error.message || 'Failed to load GitHub PR status' });
    } finally {
      if (writeToken) pendingPrStatusWrites.delete(writeToken);
    }
  });

  app.post(canonicalGitHubRoutePath('/pr/create'), (req, res) => runCanonicalMutation('create', req, res));

  app.post(canonicalGitHubRoutePath('/pr/update'), (req, res) => runCanonicalMutation('update', req, res));

  app.post(canonicalGitHubRoutePath('/pr/merge'), (req, res) => runCanonicalMutation('merge', req, res));

  app.post(canonicalGitHubRoutePath('/pr/ready'), (req, res) => runCanonicalMutation('ready', req, res));

  app.get(canonicalGitHubRoutePath('/repo/upstream'), async (req, res) => {
    try {
      const directory = readQueryString(req, 'directory');
      const canonical = req.path.startsWith('/api/source-control/');
      const trustedContext = canonical
        ? await validateReadContext(req, directory)
        : null;
      if (canonical && !trustedContext) {
        return res.status(501).json({ error: 'Bound source control read is unavailable' });
      }
      if (!directory) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const octokit = (await getOctokitForRead(req, trustedContext))?.octokit;
      if (!octokit) {
        return res.json({ connected: false, isFork: false, upstream: null });
      }

      const resolveGitHubRepoFromDirectory = options.resolveGitHubRepoFromDirectory
        ?? (await import('./index.js')).resolveGitHubRepoFromDirectory;
      const resolveRepoNetwork = options.resolveRepoNetwork
        ?? (await import('./repo/fork-detection.js')).resolveRepoNetwork;
      const remoteName = trustedContext?.primaryRemote ?? 'origin';
      if (canonical) {
        const { repo } = await resolveGitHubRepoFromDirectory(directory, remoteName);
        if (!repo) throw new Error(`Unable to resolve GitHub repo from git remote "${remoteName}"`);
      }
      const network = canonical
        ? await resolveRepoNetwork(octokit, directory, remoteName, { strictErrors: true })
        : await resolveRepoNetwork(octokit, directory, remoteName);
      if (canonical) requireGitHubRepoNetwork(network);

      if (!network || network.length <= 1) {
        return res.json({ connected: true, isFork: false, upstream: null });
      }

      const upstream = network.find((r) => r.source === 'upstream') || null;
       let defaultBranch = canonical ? null : 'main';
      let defaultBranchSha = null;
      if (upstream) {
        try {
          const metadata = await octokit.rest.repos.get({ owner: upstream.owner, repo: upstream.repo });
          const metadataDefaultBranch = Object.prototype.toString.call(metadata?.data?.default_branch) === '[object String]'
             ? metadata.data.default_branch.trim()
             : '';
           if (canonical && !metadataDefaultBranch) throw new Error('GitHub returned invalid repository metadata');
           defaultBranch = metadataDefaultBranch || 'main';
          const ref = await octokit.rest.git.getRef({ owner: upstream.owner, repo: upstream.repo, ref: `heads/${defaultBranch}` });
          defaultBranchSha = ref?.data?.object?.sha || null;
        } catch (error) {
           if (canonical) throw error;
          // Fall back if metadata/ref fetch fails
        }
      }

      // Check if a configured git remote points to the upstream repo
      let upstreamRemoteName = null;
      if (upstream) {
        try {
          const { getRemotes } = await import('../git/index.js');
          const { resolveGitHubRepoFromDirectory } = await import('./index.js');
          const remotes = await getRemotes(directory);
          for (const r of remotes) {
            if (r?.name) {
              const resolved = await resolveGitHubRepoFromDirectory(directory, r.name).catch(() => ({ repo: null }));
              if (resolved.repo && resolved.repo.owner === upstream.owner && resolved.repo.repo === upstream.repo) {
                upstreamRemoteName = r.name;
                break;
              }
            }
          }
        } catch {
          // Ignore errors finding remote name
        }
      }

      return res.json({
        connected: true,
        isFork: Boolean(upstream),
        upstream: upstream ? { owner: upstream.owner, repo: upstream.repo, url: upstream.url, defaultBranch, defaultBranchSha, remoteName: upstreamRemoteName } : null,
      });
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(readContextErrorBody(error));
      }
      const accountError = sendExactAccountError(res, error);
      if (accountError) return accountError;
      console.error('Failed to detect upstream repo:', error);
      return res.status(500).json({ error: error.message || 'Failed to detect upstream repo' });
    }
  });

  app.get(canonicalGitHubRoutePath('/repo/branches'), async (req, res) => {
    try {
      const directory = readQueryString(req, 'directory');
      const owner = readQueryString(req, 'owner');
      const repo = readQueryString(req, 'repo');
      const canonical = req.path.startsWith('/api/source-control/');
      if (!owner || !repo) {
        return res.status(400).json({ error: 'owner and repo are required' });
      }
      const trustedContext = canonical
        ? await validateReadContext(req, directory)
        : null;
      if (canonical && !trustedContext) {
        return res.status(501).json({ error: 'Bound source control read is unavailable' });
      }
      if (canonical && !directory) {
        return res.status(400).json({ error: 'directory is required' });
      }
      const octokit = (await getOctokitForRead(req, trustedContext))?.octokit;
      if (!octokit) {
        return res.json({ branches: [] });
      }

      const selectedRepo = canonical
        ? await resolveRepoForRequest(octokit, directory, { owner, repo }, trustedContext.primaryRemote, {
            resolveGitHubRepoFromDirectory: options.resolveGitHubRepoFromDirectory,
            resolveRepoNetwork: options.resolveRepoNetwork,
            strictNetworkErrors: true,
            strictMetadataErrors: true,
            requireResolvedRepo: true,
          })
        : { owner, repo };
      if (!selectedRepo) return res.json({ branches: [] });

      const branches = [];
      let page = 1;
      while (true) {
        const response = await octokit.rest.repos.listBranches({ owner: selectedRepo.owner, repo: selectedRepo.repo, per_page: 100, page });
        const payload = canonical
          ? requireProviderArray(response?.data, 'GitHub returned an invalid branch list')
          : Array.isArray(response?.data) ? response.data : [];
        if (payload.length === 0) break;
        for (const branch of payload) {
          if (canonical && (!isPlainObject(branch) || !isProviderString(branch.name) || !branch.name.trim())) {
            throw invalidProviderPayload('GitHub returned an invalid branch');
          }
          if (isProviderString(branch?.name) && branch.name.trim()) branches.push(branch.name);
        }
        if (payload.length < 100) break;
        page++;
      }

      return res.json({ branches });
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(readContextErrorBody(error));
      }
      const accountError = sendExactAccountError(res, error);
      if (accountError) return accountError;
      console.error('Failed to fetch repo branches:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch repo branches' });
    }
  });

  // ================= GitHub Issue APIs =================

  app.get(canonicalGitHubRoutePath('/issues/list'), async (req, res) => {
    try {
      const directory = readQueryString(req, 'directory');
      const requestedPage = readQueryString(req, 'page');
      const page = requestedPage ? Number(requestedPage) : 1;
      const searchQuery = readQueryString(req, 'query');
      const canonical = req.path.startsWith('/api/source-control/');
      const trustedContext = canonical
        ? await validateReadContext(req, directory)
        : null;
      if (canonical && !trustedContext) {
        return res.status(501).json({ error: 'Bound source control read is unavailable' });
      }
      if (!directory) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const octokit = (await getOctokitForRead(req, trustedContext))?.octokit;
      if (!octokit) {
        return res.json({ connected: false });
      }

      const resolveGitHubRepoFromDirectory = options.resolveGitHubRepoFromDirectory
        ?? (await import('./index.js')).resolveGitHubRepoFromDirectory;
      const resolveRepoNetwork = options.resolveRepoNetwork
        ?? (await import('./repo/fork-detection.js')).resolveRepoNetwork;
      const remoteName = trustedContext?.primaryRemote ?? 'origin';

      const { repo } = await resolveGitHubRepoFromDirectory(directory, remoteName);
      if (!repo) {
        if (canonical) throw new Error(`Unable to resolve GitHub repo from git remote "${remoteName}"`);
        return res.json({ connected: true, repo: null, issues: [] });
      }
      const repoNetwork = canonical
        ? await resolveRepoNetwork(octokit, directory, remoteName, { strictErrors: true })
        : await resolveRepoNetwork(octokit, directory, remoteName);
      if (canonical) requireGitHubRepoNetwork(repoNetwork);

      const effectivePage = Number.isFinite(page) && page > 0 ? page : 1;
      const reposToQuery = repoNetwork || [{ ...repo, source: 'origin' }];

      const mapIssueSummary = (item, repoRef) => ({
        number: item.number,
        title: item.title,
        url: item.html_url,
        state: item.state === 'closed' ? 'closed' : 'open',
        author: item.user ? { login: item.user.login, id: item.user.id, avatarUrl: item.user.avatar_url } : null,
        labels: Array.isArray(item.labels)
          ? item.labels
              .map((label) => {
                if (typeof label === 'string') return null;
                const name = typeof label?.name === 'string' ? label.name : '';
                if (!name) return null;
                return { name, color: typeof label?.color === 'string' ? label.color : undefined };
              })
              .filter(Boolean)
          : [],
        sourceRepo: { owner: repoRef.owner, repo: repoRef.repo, source: repoRef.source },
      });

      if (searchQuery) {
        const repoQualifiers = reposToQuery
          .map((r) => `repo:${r.owner}/${r.repo}`)
          .join(' ');
        const q = `${repoQualifiers} ${searchQuery} type:issue state:open`;
        try {
          const searchResult = await octokit.rest.search.issuesAndPullRequests({
            q,
            per_page: 50,
            page: effectivePage,
          });
          if (canonical && (!isPlainObject(searchResult?.data)
            || !Number.isSafeInteger(searchResult.data.total_count)
            || searchResult.data.total_count < 0)) {
            throw invalidProviderPayload('GitHub returned an invalid issue search result');
          }
          const totalCount = searchResult.data.total_count;
          const items = canonical
            ? requireProviderArray(searchResult.data.items, 'GitHub returned an invalid issue search result')
            : Array.isArray(searchResult.data.items) ? searchResult.data.items : [];
          const findRepoForSearchItem = (item) => {
            const repositoryUrl = Object.prototype.toString.call(item?.repository_url) === '[object String]' ? item.repository_url : '';
            const match = repositoryUrl.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/);
            if (!match) return canonical ? null : reposToQuery[0];
            return reposToQuery.find((repoRef) => repoRef.owner === match[1] && repoRef.repo === match[2])
              ?? (canonical ? null : reposToQuery[0]);
          };
          const issueItems = items.filter((item) => !item?.pull_request);
          const failedSearches = [];
          let issues;
          if (!canonical) {
            issues = issueItems.map((item) => mapIssueSummary(item, findRepoForSearchItem(item)));
          } else {
            const results = await Promise.all(issueItems.map(async (item) => {
              if (!isPlainObject(item) || !Number.isSafeInteger(item.number) || item.number <= 0) {
                throw invalidProviderPayload('GitHub returned an invalid issue search item');
              }
              const repoRef = findRepoForSearchItem(item);
              if (!repoRef) throw invalidProviderPayload('GitHub issue search returned an invalid repository URL');
              try {
                const issue = await octokit.rest.issues.get({
                  owner: repoRef.owner,
                  repo: repoRef.repo,
                  issue_number: item.number,
                });
                return mapIssueSummary(requireGitHubIssue(issue.data, 'GitHub returned an invalid issue'), repoRef);
              } catch (error) {
                if (error?.status === 401 || error?.code === 'MALFORMED_PROVIDER_RESPONSE') throw error;
                failedSearches.push({ repoRef, error });
                return null;
              }
            }));
            issues = results.filter(Boolean);
          }
          if (canonical && issueItems.length > 0 && failedSearches.length === issueItems.length) {
            throw failedSearches[0].error;
          }
          const fetchedCount = (effectivePage - 1) * 50 + items.length;
          const hasMore = fetchedCount < totalCount;
          const response = { connected: true, repo, issues, page: effectivePage, hasMore };
          if (canonical && failedSearches.length > 0) {
            response.failedRepos = [...new Map(failedSearches.map(({ repoRef }) => [
              `${repoRef.owner}/${repoRef.repo}`,
              { owner: repoRef.owner, repo: repoRef.repo },
            ])).values()];
          }
          return res.json(response);
        } catch (error) {
          if (canonical || error?.status === 401) throw error;
          console.error('Failed to search GitHub issues:', error);
          return res.json({ connected: true, repo, issues: [], page: effectivePage, hasMore: false });
        }
      }

      const queryRepo = async (repoRef) => {
        try {
          const list = await octokit.rest.issues.listForRepo({
            owner: repoRef.owner,
            repo: repoRef.repo,
            state: 'open',
            per_page: 50,
            page: effectivePage,
          });
          const link = typeof list?.headers?.link === 'string' ? list.headers.link : '';
          const hasMore = /rel="next"/.test(link);
          const payload = canonical
            ? requireProviderArray(list?.data, 'GitHub returned an invalid issue list')
            : Array.isArray(list?.data) ? list.data : [];
          const issues = payload
            .filter((item) => !item?.pull_request)
            .map((item) => mapIssueSummary(canonical ? requireGitHubIssue(item, 'GitHub returned an invalid issue') : item, repoRef));
          return { issues, hasMore };
        } catch (error) {
          if (error?.status === 401 || error?.code === 'MALFORMED_PROVIDER_RESPONSE') throw error;
          if (canonical) return { error, repoRef };
          console.warn(`Failed to list issues for ${repoRef.owner}/${repoRef.repo}:`, error?.message || error);
          return { issues: [], hasMore: false };
        }
      };

      const results = await Promise.all(reposToQuery.map(queryRepo));
      const successful = results.filter((result) => !result.error);
      const failed = results.filter((result) => result.error);
      if (canonical && successful.length === 0 && failed.length > 0) throw failed[0].error;
      const allIssues = successful.flatMap((result) => result.issues);
      const anyHasMore = successful.some((result) => result.hasMore);

      const response = { connected: true, repo, issues: allIssues, page: effectivePage, hasMore: anyHasMore };
      if (canonical && failed.length > 0) {
        response.failedRepos = failed.map(({ repoRef }) => ({ owner: repoRef.owner, repo: repoRef.repo }));
      }
      return res.json(response);
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(readContextErrorBody(error));
      }
      const accountError = sendExactAccountError(res, error);
      if (accountError) return accountError;
      console.error('Failed to list GitHub issues:', error);
      return res.status(500).json({ error: error.message || 'Failed to list GitHub issues' });
    }
  });

  app.get(canonicalGitHubRoutePath('/issues/get'), async (req, res) => {
    try {
      const directory = readQueryString(req, 'directory');
      const requestedNumber = readQueryString(req, 'number');
      const canonical = req.path.startsWith('/api/source-control/');
      const number = canonical ? readPositiveIntegerQuery(req, 'number') : requestedNumber ? Number(requestedNumber) : null;
      const owner = readQueryString(req, 'owner');
      const repoName = readQueryString(req, 'repo');
      if (canonical && (!number || Boolean(owner) !== Boolean(repoName))) {
        return res.status(400).json({ error: 'valid number and complete repository selector are required' });
      }
      const trustedContext = canonical
        ? await validateReadContext(req, directory)
        : null;
      if (canonical && !trustedContext) {
        return res.status(501).json({ error: 'Bound source control read is unavailable' });
      }
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const octokit = (await getOctokitForRead(req, trustedContext))?.octokit;
      if (!octokit) {
        return res.json({ connected: false });
      }

      const requestedRepo = owner && repoName ? { owner, repo: repoName } : null;
      const repo = await resolveRepoForRequest(
        octokit,
        directory,
        requestedRepo,
        trustedContext?.primaryRemote ?? 'origin',
        {
          resolveGitHubRepoFromDirectory: options.resolveGitHubRepoFromDirectory,
          resolveRepoNetwork: options.resolveRepoNetwork,
          strictNetworkErrors: canonical,
          strictMetadataErrors: canonical,
          requireResolvedRepo: canonical,
        },
      );
      if (!repo) {
        return res.json({ connected: true, repo: null, issue: null });
      }

      const result = await octokit.rest.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: number });
      const issue = canonical
        ? requireGitHubIssue(result?.data, 'GitHub returned an invalid issue')
        : result?.data;
      if (!issue || issue.pull_request) {
        return res.status(400).json({ error: 'Not a GitHub issue' });
      }

      return res.json({
        connected: true,
        repo,
        issue: {
          number: issue.number,
          title: issue.title,
          url: issue.html_url,
          state: issue.state === 'closed' ? 'closed' : 'open',
          body: issue.body || '',
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          author: issue.user ? { login: issue.user.login, id: issue.user.id, avatarUrl: issue.user.avatar_url } : null,
          assignees: Array.isArray(issue.assignees)
            ? issue.assignees
                .map((u) => (u ? { login: u.login, id: u.id, avatarUrl: u.avatar_url } : null))
                .filter(Boolean)
            : [],
          labels: Array.isArray(issue.labels)
            ? issue.labels
                .map((label) => {
                  if (typeof label === 'string') return null;
                  const name = typeof label?.name === 'string' ? label.name : '';
                  if (!name) return null;
                  return { name, color: typeof label?.color === 'string' ? label.color : undefined };
                })
                .filter(Boolean)
            : [],
        },
      });
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(readContextErrorBody(error));
      }
      const accountError = sendExactAccountError(res, error);
      if (accountError) return accountError;
      console.error('Failed to fetch GitHub issue:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitHub issue' });
    }
  });

  app.get(canonicalGitHubRoutePath('/issues/comments'), async (req, res) => {
    try {
      const directory = readQueryString(req, 'directory');
      const requestedNumber = readQueryString(req, 'number');
      const canonical = req.path.startsWith('/api/source-control/');
      const number = canonical ? readPositiveIntegerQuery(req, 'number') : requestedNumber ? Number(requestedNumber) : null;
      const owner = readQueryString(req, 'owner');
      const repoName = readQueryString(req, 'repo');
      if (canonical && (!number || Boolean(owner) !== Boolean(repoName))) {
        return res.status(400).json({ error: 'valid number and complete repository selector are required' });
      }
      const trustedContext = canonical
        ? await validateReadContext(req, directory)
        : null;
      if (canonical && !trustedContext) {
        return res.status(501).json({ error: 'Bound source control read is unavailable' });
      }
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const octokit = (await getOctokitForRead(req, trustedContext))?.octokit;
      if (!octokit) {
        return res.json({ connected: false });
      }

      const requestedRepo = owner && repoName ? { owner, repo: repoName } : null;
      const repo = await resolveRepoForRequest(
        octokit,
        directory,
        requestedRepo,
        trustedContext?.primaryRemote ?? 'origin',
        {
          resolveGitHubRepoFromDirectory: options.resolveGitHubRepoFromDirectory,
          resolveRepoNetwork: options.resolveRepoNetwork,
          strictNetworkErrors: canonical,
          strictMetadataErrors: canonical,
          requireResolvedRepo: canonical,
        },
      );
      if (!repo) {
        return res.json({ connected: true, repo: null, comments: [] });
      }

      const result = await octokit.rest.issues.listComments({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        per_page: 100,
      });
      const payload = canonical
        ? requireProviderArray(result?.data, 'GitHub returned an invalid issue comment list')
        : Array.isArray(result?.data) ? result.data : [];
      const comments = payload
        .map((comment) => canonical ? requireGitHubComment(comment, 'GitHub returned an invalid issue comment') : comment)
        .map((comment) => ({
          id: comment.id,
          url: comment.html_url,
          body: comment.body || '',
          createdAt: comment.created_at,
          updatedAt: comment.updated_at,
          author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
        }));

      return res.json({ connected: true, repo, comments });
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(readContextErrorBody(error));
      }
      const accountError = sendExactAccountError(res, error);
      if (accountError) return accountError;
      console.error('Failed to fetch GitHub issue comments:', error);
      return res.status(500).json({ error: error.message || 'Failed to fetch GitHub issue comments' });
    }
  });

  // ================= GitHub Pull Request Context APIs =================

  app.get(canonicalGitHubRoutePath('/pulls/list'), async (req, res) => {
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const page = typeof req.query?.page === 'string' ? Number(req.query.page) : 1;
      const searchQuery = typeof req.query?.query === 'string' ? req.query.query.trim() : '';
      const canonical = req.path.startsWith('/api/source-control/');
      const trustedContext = canonical
        ? await validateReadContext(req, directory)
        : null;
      if (canonical && !trustedContext) {
        return res.status(501).json({ error: 'Bound source control status is unavailable' });
      }
      if (!directory) {
        return res.status(400).json({ error: 'directory is required' });
      }

      const octokit = (await getOctokitForRequest(req, trustedContext?.accountId))?.octokit;
      if (!octokit) {
        return res.json({ connected: false });
      }

      const resolveGitHubRepoFromDirectory = options.resolveGitHubRepoFromDirectory
        ?? (await import('./index.js')).resolveGitHubRepoFromDirectory;
      const resolveRepoNetwork = options.resolveRepoNetwork
        ?? (await import('./repo/fork-detection.js')).resolveRepoNetwork;
      const remoteName = trustedContext?.primaryRemote ?? 'origin';

      const { repo } = await resolveGitHubRepoFromDirectory(directory, remoteName);
      if (canonical && !repo) {
        throw new Error(`Unable to resolve GitHub repo from git remote "${remoteName}"`);
      }
      if (!repo) {
        return res.json({ connected: true, repo: null, prs: [] });
      }
      const networkPayload = canonical
        ? await resolveRepoNetwork(octokit, directory, remoteName, { strictErrors: true })
        : await resolveRepoNetwork(octokit, directory, remoteName);
      const repoNetwork = canonical ? requireGitHubRepoNetwork(networkPayload, repo) : networkPayload;

      const effectivePage = Number.isFinite(page) && page > 0 ? page : 1;
      const reposToQuery = repoNetwork || [{ ...repo, source: 'origin' }];

      const mapPrSummary = (pr, repoRef) => {
        const mergedState = pr.merged_at ? 'merged' : (pr.state === 'closed' ? 'closed' : 'open');
        const headRepo = pr.head?.repo
          ? {
              owner: pr.head.repo.owner?.login,
              repo: pr.head.repo.name,
              url: pr.head.repo.html_url,
              cloneUrl: pr.head.repo.clone_url,
              sshUrl: pr.head.repo.ssh_url,
            }
          : null;
        return {
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          state: mergedState,
          draft: Boolean(pr.draft),
          base: pr.base?.ref,
          head: pr.head?.ref,
          headSha: pr.head?.sha,
          mergeable: pr.mergeable,
          mergeableState: pr.mergeable_state,
          author: pr.user ? { login: pr.user.login, id: pr.user.id, avatarUrl: pr.user.avatar_url } : null,
          headLabel: pr.head?.label,
          headRepo: headRepo && headRepo.owner && headRepo.repo && headRepo.url
            ? headRepo
            : null,
          sourceRepo: { owner: repoRef.owner, repo: repoRef.repo, source: repoRef.source },
        };
      };

      if (searchQuery) {
        const repoQualifiers = reposToQuery
          .map((r) => `repo:${r.owner}/${r.repo}`)
          .join(' ');
        const q = `${repoQualifiers} ${searchQuery} type:pr state:open`;
        try {
          const searchResult = await octokit.rest.search.issuesAndPullRequests({
            q,
            per_page: 50,
            page: effectivePage,
          });
          const searchData = searchResult?.data;
          if (canonical && (!isPlainObject(searchData)
            || !Number.isSafeInteger(searchData.total_count) || searchData.total_count < 0)) {
            throw invalidProviderPayload('GitHub returned an invalid pull request search result');
          }
          const totalCount = searchData?.total_count ?? 0;
          const items = canonical
            ? requireProviderArray(searchData?.items, 'GitHub returned an invalid pull request search list')
            : Array.isArray(searchData?.items) ? searchData.items : [];
          const findRepoForSearchItem = (item) => {
            const repositoryUrl = typeof item?.repository_url === 'string' ? item.repository_url : '';
            const match = repositoryUrl.match(/\/repos\/([^/]+)\/([^/]+)$/);
            if (!match) {
              if (canonical) throw invalidProviderPayload('GitHub returned invalid pull request repository metadata');
              return reposToQuery[0];
            }
            const matched = reposToQuery.find((repoRef) => repoRef.owner === match[1] && repoRef.repo === match[2]);
            if (!matched && canonical) throw invalidProviderPayload('GitHub returned pull request outside the bound repository network');
            return matched || reposToQuery[0];
          };
          const prRefs = items
            .map((item) => {
              if (canonical && (!isPlainObject(item) || !Number.isSafeInteger(item.number) || item.number <= 0)) {
                throw invalidProviderPayload('GitHub returned an invalid pull request search item');
              }
              return { number: item?.number, repoRef: findRepoForSearchItem(item) };
            })
            .filter((ref) => Number.isFinite(ref.number) && ref.number > 0 && ref.repoRef);
          const failedSearches = [];
          let prs;
          if (prRefs.length === 0) {
            prs = [];
          } else {
            const results = await Promise.all(prRefs.map(async ({ number, repoRef }) => {
              try {
                const pr = await octokit.rest.pulls.get({
                  owner: repoRef.owner,
                  repo: repoRef.repo,
                  pull_number: number,
                });
                return mapPrSummary(canonical
                  ? requireGitHubPullRequest(pr?.data, 'GitHub returned an invalid pull request')
                  : pr.data, repoRef);
              } catch (error) {
                if (error?.status === 401) throw error;
                if (canonical) failedSearches.push({ repoRef, error });
                return null;
              }
            }));
            prs = results.filter(Boolean);
          }
          if (canonical && prRefs.length > 0 && failedSearches.length === prRefs.length) {
            throw failedSearches[0].error;
          }
          const primarySearchFailure = failedSearches.find(({ repoRef }) => repoRef.owner === repo.owner && repoRef.repo === repo.repo);
          if (canonical && primarySearchFailure) throw primarySearchFailure.error;
          const fetchedCount = (effectivePage - 1) * 50 + items.length;
          const hasMore = fetchedCount < totalCount;
          const failedRepos = [...new Map(failedSearches.map(({ repoRef }) => [`${repoRef.owner}/${repoRef.repo}`, repoRef])).values()];
          const response = { connected: true, repo, prs, page: effectivePage, hasMore };
          if (canonical && failedRepos.length > 0) response.failedRepos = failedRepos;
          return res.json(response);
        } catch (error) {
          if (canonical || error?.status === 401) throw error;
          console.error('Failed to search GitHub PRs:', error);
          throw error;
        }
      }

      const queryRepo = async (repoRef) => {
        try {
          const list = await octokit.rest.pulls.list({
            owner: repoRef.owner,
            repo: repoRef.repo,
            state: 'open',
            per_page: 50,
            page: effectivePage,
          });
          const link = typeof list?.headers?.link === 'string' ? list.headers.link : '';
          const hasMore = /rel="next"/.test(link);
           const payload = canonical
             ? requireProviderArray(list?.data, 'GitHub returned an invalid pull request list')
             : Array.isArray(list?.data) ? list.data : [];
           const prs = payload.map((pr) => mapPrSummary(canonical
             ? requireGitHubPullRequest(pr, 'GitHub returned an invalid pull request')
             : pr, repoRef));
          return { prs, hasMore };
        } catch (error) {
          if (error?.status === 401) throw error;
          if (canonical) return { error, repoRef };
          console.warn(`Failed to list PRs for ${repoRef.owner}/${repoRef.repo}:`, error?.message || error);
          throw error;
        }
      };

      const results = await Promise.all(reposToQuery.map(queryRepo));
      const successful = results.filter((result) => !result.error);
      const failed = results.filter((result) => result.error);
      const primaryFailed = failed.find((result) => result.repoRef.owner === repo.owner && result.repoRef.repo === repo.repo);
      if (canonical && primaryFailed) throw primaryFailed.error;
      if (canonical && successful.length === 0 && failed.length > 0) throw failed[0].error;
      const allPrs = successful.flatMap((result) => result.prs);
      const anyHasMore = successful.some((result) => result.hasMore);
      const failedRepos = failed.map((result) => result.repoRef);

      const response = { connected: true, repo, prs: allPrs, page: effectivePage, hasMore: anyHasMore };
      if (canonical && failedRepos.length > 0) response.failedRepos = failedRepos;
      return res.json(response);
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(readContextErrorBody(error));
      }
      const accountError = sendExactAccountError(res, error);
      if (accountError) return accountError;
      if (error?.status === 401) {
        await invalidateRequestAccount(error);
        return res.json({ connected: false });
      }
      console.error('Failed to list GitHub pull requests:', error);
      return res.status(500).json({ error: error.message || 'Failed to list GitHub pull requests' });
    }
  });

  app.get(canonicalGitHubRoutePath('/pulls/context'), async (req, res) => {
    let writeToken = null;
    try {
      const directory = typeof req.query?.directory === 'string' ? req.query.directory.trim() : '';
      const number = typeof req.query?.number === 'string' ? Number(req.query.number) : null;
      const includeDiff = req.query?.diff === '1' || req.query?.diff === 'true';
      const includeCheckDetails = req.query?.checkDetails === '1' || req.query?.checkDetails === 'true';
      const canonical = req.path.startsWith('/api/source-control/');
      const owner = readQueryString(req, 'owner');
      const repoName = readQueryString(req, 'repo');
      if (canonical && Boolean(owner) !== Boolean(repoName)) {
        return res.status(400).json({ error: 'complete repository selector is required' });
      }
      const trustedContext = canonical
        ? await validateReadContext(req, directory)
        : null;
      if (canonical && !trustedContext) {
        return res.status(501).json({ error: 'Bound source control status is unavailable' });
      }
      if (!directory || !number) {
        return res.status(400).json({ error: 'directory and number are required' });
      }

      const accountContext = await getOctokitForRequest(req, trustedContext?.accountId);
      const octokit = accountContext?.octokit;
      if (!octokit) {
        return res.json({ connected: false });
      }

      const requestedRepo = owner && repoName ? { owner, repo: repoName } : null;

      // Short response cache: the checks view, comments view, and the
      // send-to-chat actions request the same context within seconds of each
      // other. Detail-inclusive responses satisfy detail-free requests.
      const contextCacheKey = JSON.stringify(trustedContext
        ? [
            directory,
            number,
            includeDiff,
            requestedRepo ? `${requestedRepo.owner}/${requestedRepo.repo}` : null,
            accountContext.cacheIdentity,
            trustedContext.repositoryId,
            trustedContext.bindingRevision,
            trustedContext.primaryRemote,
          ]
        : [
            directory,
            number,
            includeDiff,
            requestedRepo ? `${requestedRepo.owner}/${requestedRepo.repo}` : null,
            accountContext.cacheIdentity,
          ]);
      const cachedContext = prContextCache.get(contextCacheKey);
      if (cachedContext
        && Date.now() - cachedContext.fetchedAt < PR_CONTEXT_CACHE_TTL_MS
        && (cachedContext.includeCheckDetails || !includeCheckDetails)) {
        return res.json(cachedContext.data);
      }

      if (canonical) {
        writeToken = {};
        pendingPrContextWrites.set(writeToken, {
          directory,
          number,
          cacheIdentity: accountContext.cacheIdentity,
          repositoryId: trustedContext.repositoryId,
          bindingRevision: trustedContext.bindingRevision,
          primaryRemote: trustedContext.primaryRemote,
        });
      }

      const originalJson = res.json.bind(res);
      res.json = (data) => {
        if (data && data.pr && (!canonical || pendingPrContextWrites.has(writeToken))) {
          if (typeof data.fetchedAt !== 'number') {
            data.fetchedAt = Date.now();
          }
          prContextCache.delete(contextCacheKey);
          prContextCache.set(contextCacheKey, { data, includeCheckDetails, fetchedAt: data.fetchedAt });
          if (prContextCache.size > PR_CONTEXT_CACHE_MAX_ENTRIES) {
            const oldest = prContextCache.keys().next().value;
            if (oldest !== undefined) {
              prContextCache.delete(oldest);
            }
          }
        }
        return originalJson(data);
      };

      const repo = await resolveRepoForRequest(
        octokit,
        directory,
        requestedRepo,
        trustedContext?.primaryRemote ?? 'origin',
        {
          resolveGitHubRepoFromDirectory: options.resolveGitHubRepoFromDirectory,
          resolveRepoNetwork: options.resolveRepoNetwork,
          strictNetworkErrors: canonical,
          strictMetadataErrors: canonical,
          requireResolvedRepo: canonical,
        },
      );
      if (!repo) {
        return res.json({ connected: true, repo: null, pr: null });
      }

      const prResp = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
      const prData = canonical
        ? requireGitHubPullRequest(prResp?.data, 'GitHub returned an invalid pull request')
        : prResp?.data;
      if (!prData) {
        return res.status(404).json({ error: 'PR not found' });
      }

      const headRepo = prData.head?.repo
        ? {
            owner: prData.head.repo.owner?.login,
            repo: prData.head.repo.name,
            url: prData.head.repo.html_url,
            cloneUrl: prData.head.repo.clone_url,
            sshUrl: prData.head.repo.ssh_url,
          }
        : null;

      const mergedState = prData.merged ? 'merged' : (prData.state === 'closed' ? 'closed' : 'open');
      const pr = {
        number: prData.number,
        title: prData.title,
        url: prData.html_url,
        state: mergedState,
        draft: Boolean(prData.draft),
        base: prData.base?.ref,
        head: prData.head?.ref,
        headSha: prData.head?.sha,
        mergeable: prData.mergeable,
        mergeableState: prData.mergeable_state,
        author: prData.user ? { login: prData.user.login, id: prData.user.id, avatarUrl: prData.user.avatar_url } : null,
        headLabel: prData.head?.label,
        headRepo: headRepo && headRepo.owner && headRepo.repo && headRepo.url ? headRepo : null,
        body: prData.body || '',
        createdAt: prData.created_at,
        updatedAt: prData.updated_at,
      };

      const issueCommentsResp = await octokit.rest.issues.listComments({
        owner: repo.owner,
        repo: repo.repo,
        issue_number: number,
        per_page: 100,
      });
      const issueCommentPayload = canonical
        ? requireProviderArray(issueCommentsResp?.data, 'GitHub returned an invalid issue comment list')
        : Array.isArray(issueCommentsResp?.data) ? issueCommentsResp.data : [];
      const issueComments = issueCommentPayload.map((comment) => canonical
        ? requireGitHubComment(comment, 'GitHub returned an invalid issue comment')
        : comment).map((comment) => ({
        id: comment.id,
        url: comment.html_url,
        body: comment.body || '',
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
      }));

      const reviewCommentsResp = await octokit.rest.pulls.listReviewComments({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      });
      const reviewCommentPayload = canonical
        ? requireProviderArray(reviewCommentsResp?.data, 'GitHub returned an invalid review comment list')
        : Array.isArray(reviewCommentsResp?.data) ? reviewCommentsResp.data : [];
      const reviewComments = reviewCommentPayload.map((comment) => canonical
        ? requireGitHubReviewComment(comment)
        : comment).map((comment) => ({
        id: comment.id,
        url: comment.html_url,
        body: comment.body || '',
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        path: comment.path,
        line: typeof comment.line === 'number' ? comment.line : null,
        position: typeof comment.position === 'number' ? comment.position : null,
        author: comment.user ? { login: comment.user.login, id: comment.user.id, avatarUrl: comment.user.avatar_url } : null,
      }));

      const filesResp = await octokit.rest.pulls.listFiles({
        owner: repo.owner,
        repo: repo.repo,
        pull_number: number,
        per_page: 100,
      });
      const filePayload = canonical
        ? requireProviderArray(filesResp?.data, 'GitHub returned an invalid pull request file list')
        : Array.isArray(filesResp?.data) ? filesResp.data : [];
      const files = filePayload.map((file) => canonical ? requireGitHubPullFile(file) : file).map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch,
      }));

      // checks summary (same logic as status endpoint)
      let checks = null;
      let checkRunsOut = undefined;
      const sha = prData.head?.sha;
      if (sha) {
        try {
          const runs = await octokit.rest.checks.listForRef({ owner: repo.owner, repo: repo.repo, ref: sha, per_page: 100 });
          const checkRuns = dedupeCheckRuns(canonical
            ? requireGitHubCheckRuns(runs?.data?.check_runs)
            : Array.isArray(runs?.data?.check_runs) ? runs.data.check_runs : []);
          if (checkRuns.length > 0) {
            const parsedJobs = new Map();
            const parsedAnnotations = new Map();
            if (includeCheckDetails) {
              // Prefetch actions jobs per runId.
              const runIds = new Set();
              const jobIds = new Map();
              for (const run of checkRuns) {
                const details = typeof run.details_url === 'string' ? run.details_url : '';
                const match = details.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
                if (match) {
                  const runId = Number(match[1]);
                  const jobId = match[2] ? Number(match[2]) : null;
                  if (Number.isFinite(runId) && runId > 0) {
                    runIds.add(runId);
                    if (jobId && Number.isFinite(jobId) && jobId > 0) {
                      jobIds.set(details, { runId, jobId });
                    } else {
                      jobIds.set(details, { runId, jobId: null });
                    }
                  }
                }
              }

              for (const runId of runIds) {
                try {
                  const jobsResp = await octokit.rest.actions.listJobsForWorkflowRun({
                    owner: repo.owner,
                    repo: repo.repo,
                    run_id: runId,
                    per_page: 100,
                  });
                  const jobs = requireGitHubWorkflowJobs(jobsResp?.data?.jobs);
                  parsedJobs.set(runId, jobs);
                } catch {
                  parsedJobs.set(runId, []);
                }
              }

              for (const run of checkRuns) {
                const runConclusion = typeof run?.conclusion === 'string' ? run.conclusion.toLowerCase() : '';
                const shouldLoadAnnotations = Boolean(
                  run?.id
                  && runConclusion
                  && !['success', 'neutral', 'skipped'].includes(runConclusion)
                );
                if (!shouldLoadAnnotations) {
                  continue;
                }

                const checkRunId = Number(run.id);
                if (!Number.isFinite(checkRunId) || checkRunId <= 0) {
                  continue;
                }

                const annotations = [];
                for (let page = 1; page <= 3; page += 1) {
                  try {
                    const annotationsResp = await octokit.rest.checks.listAnnotations({
                      owner: repo.owner,
                      repo: repo.repo,
                      check_run_id: checkRunId,
                      per_page: 50,
                      page,
                    });
                    const chunk = Array.isArray(annotationsResp?.data) ? annotationsResp.data : [];
                    annotations.push(...chunk);
                    if (chunk.length < 50) {
                      break;
                    }
                  } catch {
                    break;
                  }
                }

                if (annotations.length > 0) {
                  parsedAnnotations.set(checkRunId, annotations);
                }
              }
            }

            checkRunsOut = checkRuns.map((run) => {
              const detailsUrl = typeof run.details_url === 'string' ? run.details_url : undefined;
              let job = undefined;
              if (includeCheckDetails && detailsUrl) {
                const match = detailsUrl.match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
                const runId = match ? Number(match[1]) : null;
                const jobId = match && match[2] ? Number(match[2]) : null;
                if (runId && Number.isFinite(runId)) {
                  const jobs = parsedJobs.get(runId) || [];
                  const matched = jobId
                    ? jobs.find((j) => j.id === jobId)
                    : null;
                  const picked = matched || jobs.find((j) => j.name === run.name) || null;
                  if (picked) {
                    job = {
                      runId,
                      jobId: picked.id,
                      url: picked.html_url,
                      name: picked.name,
                      workflowName: picked.workflow_name || undefined,
                      conclusion: picked.conclusion,
                          steps: Array.isArray(picked.steps)
                            ? picked.steps.map((s) => ({
                                name: s.name,
                                status: s.status,
                                conclusion: s.conclusion,
                                number: s.number,
                                startedAt: s.started_at || undefined,
                                completedAt: s.completed_at || undefined,
                              }))
                            : undefined,
                    };
                  } else {
                    job = { runId, ...(jobId ? { jobId } : {}), url: detailsUrl };
                  }
                }
              }

              return {
                id: run.id,
                name: run.name,
                startedAt: run.started_at || undefined,
                completedAt: run.completed_at || undefined,
                app: run.app
                  ? {
                      name: run.app.name || undefined,
                      slug: run.app.slug || undefined,
                    }
                  : undefined,
                status: run.status,
                conclusion: run.conclusion,
                detailsUrl,
                output: run.output
                  ? {
                      title: run.output.title || undefined,
                      summary: run.output.summary || undefined,
                      text: run.output.text || undefined,
                    }
                  : undefined,
                ...(job ? { job } : {}),
                ...(run.id && parsedAnnotations.has(run.id)
                  ? {
                      annotations: parsedAnnotations.get(run.id).map((a) => ({
                        path: a.path || undefined,
                        startLine: typeof a.start_line === 'number' ? a.start_line : undefined,
                        endLine: typeof a.end_line === 'number' ? a.end_line : undefined,
                        level: a.annotation_level || undefined,
                        message: a.message || '',
                        title: a.title || undefined,
                        rawDetails: a.raw_details || undefined,
                      })).filter((a) => a.message),
                    }
                  : {}),
              };
            });
            checks = summarizeCheckRuns(checkRuns);
          }
        } catch {
          // ignore and fall back
        }
        if (!checks) {
          try {
            const combined = await octokit.rest.repos.getCombinedStatusForRef({ owner: repo.owner, repo: repo.repo, ref: sha });
            const statuses = canonical
              ? requireGitHubStatuses(combined?.data?.statuses)
              : Array.isArray(combined?.data?.statuses) ? combined.data.statuses : [];
            checks = summarizeCombinedStatuses(statuses);
          } catch {
            checks = null;
          }
        }
      }

      let diff = undefined;
      if (includeDiff) {
        const diffResp = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner: repo.owner,
          repo: repo.repo,
          pull_number: number,
          headers: { accept: 'application/vnd.github.v3.diff' },
        });
        if (canonical && !isProviderString(diffResp?.data)) {
          throw invalidProviderPayload('GitHub returned an invalid pull request diff');
        }
        diff = isProviderString(diffResp?.data) ? diffResp.data : undefined;
      }

      return res.json({
        connected: true,
        repo,
        pr,
        issueComments,
        reviewComments,
        files,
        ...(diff ? { diff } : {}),
        checks,
        ...(Array.isArray(checkRunsOut) ? { checkRuns: checkRunsOut } : {}),
      });
    } catch (error) {
      if (isReadContextError(error)) {
        return res.status(error.status ?? 400).json(readContextErrorBody(error));
      }
      const accountError = sendExactAccountError(res, error);
      if (accountError) return accountError;
      if (error?.status === 401) {
        await invalidateRequestAccount(error);
        return res.json({ connected: false });
      }
      console.error('Failed to load GitHub PR context:', error);
      return res.status(500).json({ error: error.message || 'Failed to load GitHub PR context' });
    } finally {
      if (writeToken) pendingPrContextWrites.delete(writeToken);
    }
  });

  return Object.freeze({
    resolveChangeRequestSource: async ({ context, project, number, expectedHeadSha, requestedRemoteName }) => {
      const trusted = await options.validateReadContext(context);
      const account = await getOctokitForRequest({}, trusted.accountId);
      const target = await resolveRepoForRequest(
        account.octokit,
        trusted.directory,
        { owner: project.owner, repo: project.name },
        trusted.primaryRemote,
        {
          resolveGitHubRepoFromDirectory: options.resolveGitHubRepoFromDirectory,
          resolveRepoNetwork: options.resolveRepoNetwork,
          strictNetworkErrors: true,
          strictMetadataErrors: true,
          requireResolvedRepo: true,
        },
      );
      if (!target || `${target.owner}/${target.repo}` !== project.id) {
        throw canonicalMutationError('Change request project does not match the bound fork network', 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', 409);
      }
      const payload = requireGitHubPullRequest((await account.octokit.rest.pulls.get({
        owner: target.owner, repo: target.repo, pull_number: number,
      }))?.data, 'GitHub returned an invalid pull request');
      const headSha = String(payload.head?.sha || '').toLowerCase();
      const headOwner = payload.head?.repo?.owner?.login;
      const headName = payload.head?.repo?.name;
      const headRef = payload.head?.ref;
      const endpoint = payload.head?.repo?.clone_url;
      if (headSha !== expectedHeadSha.toLowerCase() || !headOwner || !headName || !headRef || !endpoint) {
        throw canonicalMutationError('Change request head changed', 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', 409);
      }
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com'
        || parsed.pathname.replace(/^\//, '').replace(/\.git$/, '') !== `${headOwner}/${headName}`) {
        throw invalidProviderPayload('GitHub returned an invalid head repository endpoint');
      }
      return Object.freeze({
        context: trusted,
        sourceProject: { id: `${headOwner}/${headName}`, owner: headOwner, name: headName },
        targetProject: { id: project.id, owner: target.owner, name: target.repo },
        classification: headOwner === target.owner && headName === target.repo ? 'same-repository' : 'contributor-fork',
        headSha,
        headRef: `refs/heads/${headRef}`,
        endpoint,
        requestedRemoteName,
      });
    },
  });
}
