import {
  invalidProviderPayload,
  isPlainObject,
  isProviderString,
  mapAnnotations,
  mapCheckRun,
  mapChangeRequest,
  mapCI,
  mapComment,
  mapFile,
  mapIssue,
  mapProject,
  mapReviewComment,
  mapWorkflowJob,
  requireGitHubCheckRuns,
  requireGitHubComment,
  requireGitHubIssue,
  requireGitHubPullFile,
  requireGitHubPullRequest,
  requireGitHubRepoNetwork,
  requireGitHubReviewComment,
  requireGitHubStatuses,
  requireGitHubWorkflowJobs,
  requireProviderArray,
} from './mappers.js';
import {
  fetchDiscussionDetail,
  fetchPullStack,
  fetchReferenceDetail,
  mapReferencesAcross,
  readPullStatusRefs,
  readReferencePeople,
  readReferenceState,
  readReferencesAcrossRequest,
  searchGitHubReferences,
  searchGitHubReferencesAcross,
} from './reference-search.js';

/**
 * GitHub's bound reads behind the shared route shell: change request status,
 * lists, context, issues, the repository's upstream, branches, labels and
 * reviewer candidates, the reference picker, and the change-request head and
 * source behind worktrees. Every read takes the shell's input (`session`,
 * `directory`, the trusted primary `remote`, the validated `context`) and
 * answers neutral DTOs (`mappers.js`).
 *
 * `accountOf(session)` is the session's Octokit and stored user; the remaining
 * dependencies are GitHub's own libraries, loaded lazily (`load`), and the
 * repository lookups tests replace.
 */

const PR_CONTEXT_CACHE_TTL_MS = 30_000;
const PR_CONTEXT_CACHE_MAX_ENTRIES = 50;
const GITHUB_COM = 'github.com';

/** An error the shell answers with exactly this status and body. */
export const responseError = (status, body) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

const sourceControlError = (message, code, status) => Object.assign(new Error(message), { code, status });

const notInProject = () => responseError(400, { error: 'Repository is not part of this project' });

const rateLimited = () => Object.assign(new Error('GitHub rate limited'), { status: 503 });

const sameRepository = (left, right) => left.owner.toLowerCase() === right.owner.toLowerCase()
  && left.repo.toLowerCase() === right.repo.toLowerCase();

/** GitHub's own words for a refusal, without the documentation URL Octokit appends to the error message. */
export const gitHubRefusalMessage = (error) => {
  const message = error?.response?.data?.message;
  return isProviderString(message) && message.trim() ? message : error?.message;
};

/**
 * A short-lived cache of pull request contexts: the checks view, the comments
 * view and the send-to-chat actions ask for the same context within seconds.
 * A detail-inclusive answer serves a detail-free request. A mutation drops
 * its target's entries, and a read that started before such an invalidation
 * does not store what it read.
 */
function createContextCache() {
  const entries = new Map();
  let epoch = 0;
  return Object.freeze({
    begin: () => epoch,
    read: (key, includeCheckDetails) => {
      const entry = entries.get(key);
      return entry && Date.now() - entry.fetchedAt < PR_CONTEXT_CACHE_TTL_MS && (entry.includeCheckDetails || !includeCheckDetails)
        ? entry.data
        : null;
    },
    store: (key, scope, data, includeCheckDetails, started) => {
      if (started !== epoch) return;
      entries.delete(key);
      entries.set(key, { data, includeCheckDetails, fetchedAt: data.fetchedAt, scope });
      if (entries.size > PR_CONTEXT_CACHE_MAX_ENTRIES) entries.delete(entries.keys().next().value);
    },
    /** Every entry whose scope matches all given fields, in any directory. */
    invalidate: (scope) => {
      epoch += 1;
      for (const [key, entry] of entries) {
        if (Object.entries(scope).every(([field, value]) => entry.scope[field] === value)) entries.delete(key);
      }
    },
  });
}

export function createGitHubResources({
  load,
  accountOf,
  resolveRepo,
  resolveNetwork,
  resolvePrStatus,
  readContributorProvenance,
  invalidateAccount,
}) {
  const contextCache = createContextCache();
  // The login a merge-permission check resolves is memoized per host and
  // credential: an enterprise host's login must never be satisfied from (or
  // replayed onto) the github.com account's memo, and a changed credential
  // resolves its own login.
  const authLoginByCredential = new Map();

  const identityOf = (session) => ({ provider: 'github', instance: session.instance });

  /**
   * The repository a read names, inside the primary remote's fork network,
   * or null for one outside it. Without a selector, the primary repository.
   */
  const resolveRepoForRequest = async (octokit, directory, requestedRepo, remoteName) => {
    const { repo } = await resolveRepo(directory, remoteName);
    if (!repo) throw new Error(`Unable to resolve GitHub repo from git remote "${remoteName}"`);
    const network = requireGitHubRepoNetwork(await resolveNetwork(octokit, directory, remoteName, { strictErrors: true }), repo);
    if (!requestedRepo) return repo;
    if (repo.owner === requestedRepo.owner && repo.repo === requestedRepo.repo) return requestedRepo;
    return Array.isArray(network) && network.some((item) => item?.owner === requestedRepo.owner && item?.repo === requestedRepo.repo)
      ? requestedRepo
      : null;
  };

  /**
   * The primary repository and its network, the primary alone when GitHub
   * reports none. `requirePrimary` also checks the network's origin is it.
   */
  const resolveRepoNetwork = async (octokit, directory, remoteName, { requirePrimary = true } = {}) => {
    const { repo } = await resolveRepo(directory, remoteName);
    if (!repo) throw new Error(`Unable to resolve GitHub repo from git remote "${remoteName}"`);
    const network = requireGitHubRepoNetwork(
      await resolveNetwork(octokit, directory, remoteName, { strictErrors: true }),
      requirePrimary ? repo : undefined,
    );
    return { repo, repos: network ?? [{ ...repo, source: 'origin' }] };
  };

  // A worktree checked out from a contributor's fork PR deliberately has no
  // upstream, so the branch alone looks like it came from the primary remote.
  // Its provenance names the fork remote the branch really came from. Without
  // provenance (or when it cannot be read) status resolves as for any branch.
  const readContributorSourceRemote = async (directory, branch) => {
    if (!(readContributorProvenance instanceof Function)) return null;
    try {
      const { provenance } = await readContributorProvenance(directory);
      return provenance?.kind === 'contributor-fork' && provenance.provider === 'github'
        && provenance.sourceRef === `refs/heads/${branch}` ? provenance.remoteName : null;
    } catch {
      return null;
    }
  };

  /** Checks of a head commit: check runs (Actions), else classic statuses; null when neither answers. */
  const readChecks = async (octokit, repo, sha, { runs: keepRuns = false } = {}) => {
    const { checks: { dedupeCheckRuns, summarizeCheckRuns, summarizeCombinedStatuses } } = await load();
    let summary = null;
    let checkRuns = [];
    try {
      const response = await octokit.rest.checks.listForRef({ owner: repo.owner, repo: repo.repo, ref: sha, per_page: 100 });
      checkRuns = dedupeCheckRuns(requireGitHubCheckRuns(response?.data?.check_runs));
      if (checkRuns.length > 0) summary = summarizeCheckRuns(checkRuns);
    } catch {
      checkRuns = [];
    }
    if (!summary) {
      try {
        const combined = await octokit.rest.repos.getCombinedStatusForRef({ owner: repo.owner, repo: repo.repo, ref: sha });
        summary = summarizeCombinedStatuses(requireGitHubStatuses(combined?.data?.statuses));
      } catch {
        summary = null;
      }
    }
    return { summary, checkRuns: keepRuns && summary && checkRuns.length > 0 ? checkRuns : [] };
  };

  /** Workflow jobs and failure annotations behind the check runs, for the checks view. */
  const readCheckDetails = async (octokit, repo, checkRuns) => {
    const jobsByRun = new Map();
    const annotationsByRun = new Map();
    const runIdOf = (run) => {
      const match = (isProviderString(run.details_url) ? run.details_url : '').match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
      const runId = match ? Number(match[1]) : null;
      return runId && Number.isFinite(runId) && runId > 0 ? { runId, jobId: match[2] ? Number(match[2]) : null } : null;
    };
    for (const runId of new Set(checkRuns.map(runIdOf).filter(Boolean).map((entry) => entry.runId))) {
      try {
        const response = await octokit.rest.actions.listJobsForWorkflowRun({ owner: repo.owner, repo: repo.repo, run_id: runId, per_page: 100 });
        jobsByRun.set(runId, requireGitHubWorkflowJobs(response?.data?.jobs));
      } catch {
        jobsByRun.set(runId, []);
      }
    }
    for (const run of checkRuns) {
      const conclusion = isProviderString(run?.conclusion) ? run.conclusion.toLowerCase() : '';
      if (!run?.id || !conclusion || ['success', 'neutral', 'skipped'].includes(conclusion)) continue;
      const annotations = [];
      for (let page = 1; page <= 3; page += 1) {
        try {
          const response = await octokit.rest.checks.listAnnotations({
            owner: repo.owner, repo: repo.repo, check_run_id: run.id, per_page: 50, page,
          });
          const chunk = Array.isArray(response?.data) ? response.data : [];
          annotations.push(...chunk);
          if (chunk.length < 50) break;
        } catch {
          break;
        }
      }
      if (annotations.length > 0) annotationsByRun.set(run.id, mapAnnotations(annotations));
    }
    return (run) => {
      const ids = runIdOf(run);
      let job;
      if (ids) {
        const jobs = jobsByRun.get(ids.runId) ?? [];
        const matched = (ids.jobId ? jobs.find((entry) => entry.id === ids.jobId) : null)
          ?? jobs.find((entry) => entry.name === run.name) ?? null;
        job = mapWorkflowJob({ runId: ids.runId, jobId: ids.jobId, job: matched, detailsUrl: run.details_url });
      }
      return { job, annotations: annotationsByRun.get(run.id) };
    };
  };

  /** Whether the session's user may merge in `repo`; best effort, false when unknown. */
  const readCanMerge = async (octokit, session, user, repo, host) => {
    try {
      const loginHost = String(host ?? '').trim().toLowerCase() || GITHUB_COM;
      const loginKey = JSON.stringify([loginHost, session.accountId, session.credentialRevision]);
      let username = loginHost === GITHUB_COM ? user?.login : null;
      if (!username) {
        let loginPromise = authLoginByCredential.get(loginKey);
        if (!loginPromise) {
          loginPromise = octokit.rest.users.getAuthenticated()
            .then((response) => response?.data?.login || null)
            .catch(() => {
              authLoginByCredential.delete(loginKey);
              return null;
            });
          authLoginByCredential.set(loginKey, loginPromise);
        }
        username = await loginPromise;
      }
      if (!username) return false;
      const permission = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner: repo.owner, repo: repo.repo, username });
      return ['admin', 'maintain', 'write'].includes(permission?.data?.permission);
    } catch {
      return false;
    }
  };

  /**
   * A rate limit, primary or secondary, as the transient failure the shell
   * answers from its last-known status; a refusal with GitHub's own message.
   */
  const statusFailure = async (error, host) => {
    const { rateLimit } = await load();
    if (rateLimit.noteIfGitHubRateLimit(error, host)) return rateLimited();
    if ((error?.status ?? error?.response?.status) === 403) {
      return Object.assign(new Error(gitHubRefusalMessage(error)), { status: 403 });
    }
    return error;
  };

  /**
   * A reference picker read: a refused token writes the account off and
   * answers `connected: false`; a rate limit answers 503.
   */
  const pickerRead = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      if (error?.sourceControlResponse || error?.sourceControlAccountUnavailable) throw error;
      if ((error?.status ?? error?.response?.status) === 401) {
        // The bound account's refusal is the shell's to answer: it writes the
        // account off. A host's current credential refused answers `connected: false`.
        if (error?.sourceControlIdentity?.accountId) throw error;
        return { connected: false };
      }
      const { summaries, rateLimit } = await load();
      if (summaries.isGraphqlRateLimitError(error) || rateLimit.isGitHubRateLimitError(error)) {
        rateLimit.noteGitHubRateLimit(error);
        throw responseError(503, { error: 'GitHub rate limited' });
      }
      throw error;
    }
  };

  const emptyContext = (identity) => ({ identity, project: null, changeRequest: null, issueComments: [], reviewComments: [], files: [] });

  return Object.freeze({
    /** Cached contexts drop with their mutation's target, whichever directory read them. */
    invalidateContexts: (scope) => contextCache.invalidate(scope),

    changeRequestStatus: async ({ session, directory, branch, remote, force = false }) => {
      const { octokit, user } = accountOf(session);
      const identity = identityOf(session);
      const { rateLimit } = await load();
      // The host this request works on, so the gate short-circuits only that
      // host: an enterprise instance's cooldown must not pause github.com.
      const { repo: hostRepo } = await resolveRepo(directory, remote).catch(() => ({ repo: null }));
      const host = hostRepo?.host ?? session.instance;
      if (rateLimit.isGitHubRateLimited(host)) throw rateLimited();
      const noProject = { identity, project: null, branch, changeRequest: null, ci: null, canMerge: false, defaultBranch: null, resolvedRemoteName: null };
      try {
        const sourceRemoteName = await readContributorSourceRemote(directory, branch);
        const resolved = await resolvePrStatus({
          octokit, directory, branch, remoteName: remote, sourceRemoteName, force, requestHost: hostRepo?.host,
        });
        if (!resolved.repo) return noProject;
        const project = mapProject(resolved.repo, identity);
        const found = {
          identity, project, branch, changeRequest: null, ci: null, canMerge: false,
          defaultBranch: resolved.defaultBranch ?? null, resolvedRemoteName: resolved.resolvedRemoteName ?? null,
        };
        if (!resolved.pr) return found;
        const full = await octokit.rest.pulls.get({ owner: resolved.repo.owner, repo: resolved.repo.repo, pull_number: resolved.pr.number });
        if (!full?.data) return found;
        const changeRequest = mapChangeRequest(full.data, project, identity);
        // A closed or merged PR is the branch's history: its checks are not
        // actionable and it cannot be merged, so neither costs a call.
        if (changeRequest.state !== 'open') return { ...found, changeRequest };
        const { summary } = changeRequest.headSha ? await readChecks(octokit, resolved.repo, changeRequest.headSha) : { summary: null };
        return {
          ...found,
          changeRequest,
          ci: mapCI(summary),
          canMerge: await readCanMerge(octokit, session, user, resolved.repo, hostRepo?.host),
        };
      } catch (error) {
        // A repository GitHub does not show this account is no change request, quietly.
        if ((error?.status ?? error?.response?.status) === 404) return noProject;
        throw await statusFailure(error, host);
      }
    },

    listChangeRequests: async ({ session, directory, page, query, remote }) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const { repo, repos } = await resolveRepoNetwork(octokit, directory, remote);
      const projectOf = (repoRef) => mapProject(repoRef, identity);
      const toChangeRequest = (pr, repoRef) => mapChangeRequest(requireGitHubPullRequest(pr, 'GitHub returned an invalid pull request'), projectOf(repoRef), identity);
      const isPrimary = (repoRef) => repoRef.owner === repo.owner && repoRef.repo === repo.repo;

      if (query) {
        const q = `${repos.map((entry) => `repo:${entry.owner}/${entry.repo}`).join(' ')} ${query} type:pr state:open`;
        const search = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 50, page });
        const data = search?.data;
        if (!isPlainObject(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
          throw invalidProviderPayload('GitHub returned an invalid pull request search result');
        }
        const items = requireProviderArray(data.items, 'GitHub returned an invalid pull request search list');
        const refs = items.map((item) => {
          if (!isPlainObject(item) || !Number.isSafeInteger(item.number) || item.number <= 0) {
            throw invalidProviderPayload('GitHub returned an invalid pull request search item');
          }
          const match = (isProviderString(item.repository_url) ? item.repository_url : '').match(/\/repos\/([^/]+)\/([^/]+)$/);
          if (!match) throw invalidProviderPayload('GitHub returned invalid pull request repository metadata');
          const repoRef = repos.find((entry) => entry.owner === match[1] && entry.repo === match[2]);
          if (!repoRef) throw invalidProviderPayload('GitHub returned pull request outside the bound repository network');
          return { number: item.number, repoRef };
        });
        const failed = [];
        const results = await Promise.all(refs.map(async ({ number, repoRef }) => {
          try {
            const pr = await octokit.rest.pulls.get({ owner: repoRef.owner, repo: repoRef.repo, pull_number: number });
            return toChangeRequest(pr?.data, repoRef);
          } catch (error) {
            if (error?.status === 401) throw error;
            failed.push({ repoRef, error });
            return null;
          }
        }));
        if (refs.length > 0 && failed.length === refs.length) throw failed[0].error;
        const primaryFailure = failed.find(({ repoRef }) => isPrimary(repoRef));
        if (primaryFailure) throw primaryFailure.error;
        const result = { items: results.filter(Boolean), page, hasMore: (page - 1) * 50 + items.length < data.total_count };
        if (failed.length > 0) result.incompleteProjectIds = [...new Set(failed.map(({ repoRef }) => `${repoRef.owner}/${repoRef.repo}`))];
        return result;
      }

      const results = await Promise.all(repos.map(async (repoRef) => {
        try {
          const list = await octokit.rest.pulls.list({ owner: repoRef.owner, repo: repoRef.repo, state: 'open', per_page: 50, page });
          const link = isProviderString(list?.headers?.link) ? list.headers.link : '';
          const prs = requireProviderArray(list?.data, 'GitHub returned an invalid pull request list');
          return { items: prs.map((pr) => toChangeRequest(pr, repoRef)), hasMore: /rel="next"/.test(link) };
        } catch (error) {
          if (error?.status === 401) throw error;
          return { error, repoRef };
        }
      }));
      const failed = results.filter((entry) => entry.error);
      const primaryFailure = failed.find((entry) => isPrimary(entry.repoRef));
      if (primaryFailure) throw primaryFailure.error;
      const succeeded = results.filter((entry) => !entry.error);
      if (succeeded.length === 0 && failed.length > 0) throw failed[0].error;
      const result = { items: succeeded.flatMap((entry) => entry.items), page, hasMore: succeeded.some((entry) => entry.hasMore) };
      if (failed.length > 0) result.incompleteProjectIds = failed.map(({ repoRef }) => `${repoRef.owner}/${repoRef.repo}`);
      return result;
    },

    changeRequestContext: async ({ session, context, directory, number, project, remote, includeDiff, includeCIDetails }) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const requestedRepo = project ? { owner: project.owner, repo: project.name } : null;
      const scope = {
        accountId: session.accountId,
        credentialRevision: session.credentialRevision,
        repositoryId: context?.repositoryId,
        bindingRevision: context?.bindingRevision,
        primaryRemote: remote,
        number,
      };
      const cacheKey = JSON.stringify([directory, number, includeDiff, requestedRepo ? `${requestedRepo.owner}/${requestedRepo.repo}` : null, scope]);
      const cached = contextCache.read(cacheKey, includeCIDetails);
      if (cached) return cached;
      const started = contextCache.begin();

      const repo = await resolveRepoForRequest(octokit, directory, requestedRepo, remote);
      if (!repo) return emptyContext(identity);
      const route = { owner: repo.owner, repo: repo.repo };
      const projectDTO = mapProject(repo, identity);
      const prData = requireGitHubPullRequest((await octokit.rest.pulls.get({ ...route, pull_number: number }))?.data, 'GitHub returned an invalid pull request');
      const issueComments = requireProviderArray(
        (await octokit.rest.issues.listComments({ ...route, issue_number: number, per_page: 100 }))?.data,
        'GitHub returned an invalid issue comment list',
      ).map((comment) => mapComment(requireGitHubComment(comment, 'GitHub returned an invalid issue comment'), identity));
      const reviewComments = requireProviderArray(
        (await octokit.rest.pulls.listReviewComments({ ...route, pull_number: number, per_page: 100 }))?.data,
        'GitHub returned an invalid review comment list',
      ).map((comment) => mapReviewComment(requireGitHubReviewComment(comment), identity));
      const files = requireProviderArray(
        (await octokit.rest.pulls.listFiles({ ...route, pull_number: number, per_page: 100 }))?.data,
        'GitHub returned an invalid pull request file list',
      ).map((file) => mapFile(requireGitHubPullFile(file)));

      let ci = null;
      const sha = prData.head?.sha;
      if (sha) {
        const { summary, checkRuns } = await readChecks(octokit, repo, sha, { runs: true });
        if (summary && checkRuns.length > 0) {
          const details = includeCIDetails ? await readCheckDetails(octokit, repo, checkRuns) : () => ({});
          ci = mapCI(summary, checkRuns.map((run) => mapCheckRun(run, details(run), identity)));
        } else {
          ci = mapCI(summary);
        }
      }

      let diff;
      if (includeDiff) {
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          ...route, pull_number: number, headers: { accept: 'application/vnd.github.v3.diff' },
        });
        if (!isProviderString(response?.data)) throw invalidProviderPayload('GitHub returned an invalid pull request diff');
        diff = response.data;
      }

      const result = {
        identity,
        fetchedAt: Date.now(),
        project: projectDTO,
        changeRequest: mapChangeRequest(prData, projectDTO, identity),
        issueComments,
        reviewComments,
        files,
        ci,
      };
      if (diff) result.diff = diff;
      // A layer of a stack names its layers, so an agent given the PR knows
      // what sits below and above it. GitHub marks a stacked PR's own
      // resource; only then is the stack read, and a failed read leaves it out.
      if (isPlainObject(prData.stack)) {
        const stack = await fetchPullStack({ octokit, owner: repo.owner, repo: repo.repo, number }).catch(() => undefined);
        if (stack !== undefined) result.stack = stack;
      }
      contextCache.store(cacheKey, scope, result, includeCIDetails, started);
      return result;
    },

    listIssues: async ({ session, directory, page, query, remote }) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const { repos } = await resolveRepoNetwork(octokit, directory, remote, { requirePrimary: false });
      const toIssue = (issue, repoRef) => mapIssue(requireGitHubIssue(issue, 'GitHub returned an invalid issue'), mapProject(repoRef, identity), identity);

      if (query) {
        const q = `${repos.map((entry) => `repo:${entry.owner}/${entry.repo}`).join(' ')} ${query} type:issue state:open`;
        const search = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 50, page });
        const data = search?.data;
        if (!isPlainObject(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
          throw invalidProviderPayload('GitHub returned an invalid issue search result');
        }
        const items = requireProviderArray(data.items, 'GitHub returned an invalid issue search result');
        const issueItems = items.filter((item) => !item?.pull_request);
        const failed = [];
        const results = await Promise.all(issueItems.map(async (item) => {
          if (!isPlainObject(item) || !Number.isSafeInteger(item.number) || item.number <= 0) {
            throw invalidProviderPayload('GitHub returned an invalid issue search item');
          }
          const match = (isProviderString(item.repository_url) ? item.repository_url : '').match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/);
          const repoRef = match ? repos.find((entry) => entry.owner === match[1] && entry.repo === match[2]) : null;
          if (!repoRef) throw invalidProviderPayload('GitHub issue search returned an invalid repository URL');
          try {
            const issue = await octokit.rest.issues.get({ owner: repoRef.owner, repo: repoRef.repo, issue_number: item.number });
            return toIssue(issue?.data, repoRef);
          } catch (error) {
            if (error?.status === 401 || error?.code === 'MALFORMED_PROVIDER_RESPONSE') throw error;
            failed.push({ repoRef, error });
            return null;
          }
        }));
        if (issueItems.length > 0 && failed.length === issueItems.length) throw failed[0].error;
        const result = { items: results.filter(Boolean), page, hasMore: (page - 1) * 50 + items.length < data.total_count };
        if (failed.length > 0) result.incompleteProjectIds = [...new Set(failed.map(({ repoRef }) => `${repoRef.owner}/${repoRef.repo}`))];
        return result;
      }

      const results = await Promise.all(repos.map(async (repoRef) => {
        try {
          const list = await octokit.rest.issues.listForRepo({ owner: repoRef.owner, repo: repoRef.repo, state: 'open', per_page: 50, page });
          const link = isProviderString(list?.headers?.link) ? list.headers.link : '';
          const issues = requireProviderArray(list?.data, 'GitHub returned an invalid issue list')
            .filter((item) => !item?.pull_request)
            .map((item) => toIssue(item, repoRef));
          return { items: issues, hasMore: /rel="next"/.test(link) };
        } catch (error) {
          if (error?.status === 401 || error?.code === 'MALFORMED_PROVIDER_RESPONSE') throw error;
          return { error, repoRef };
        }
      }));
      const succeeded = results.filter((entry) => !entry.error);
      const failed = results.filter((entry) => entry.error);
      if (succeeded.length === 0 && failed.length > 0) throw failed[0].error;
      const result = { items: succeeded.flatMap((entry) => entry.items), page, hasMore: succeeded.some((entry) => entry.hasMore) };
      if (failed.length > 0) result.incompleteProjectIds = failed.map(({ repoRef }) => `${repoRef.owner}/${repoRef.repo}`);
      return result;
    },

    /** The issue, null for a selector outside the bound network; a pull request number is refused. */
    getIssue: async ({ session, directory, number, project, remote }) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, project ? { owner: project.owner, repo: project.name } : null, remote);
      if (!repo) return null;
      const issue = requireGitHubIssue((await octokit.rest.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: number }))?.data, 'GitHub returned an invalid issue');
      if (issue.pull_request) throw responseError(400, { error: 'Not a GitHub issue' });
      return mapIssue(issue, mapProject(repo, identity), identity);
    },

    issueComments: async ({ session, directory, number, project, remote }) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, project ? { owner: project.owner, repo: project.name } : null, remote);
      if (!repo) return [];
      const response = await octokit.rest.issues.listComments({ owner: repo.owner, repo: repo.repo, issue_number: number, per_page: 100 });
      return requireProviderArray(response?.data, 'GitHub returned an invalid issue comment list')
        .map((comment) => mapComment(requireGitHubComment(comment, 'GitHub returned an invalid issue comment'), identity));
    },

    projectUpstream: async ({ session, directory, remote }) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const { repos } = await resolveRepoNetwork(octokit, directory, remote, { requirePrimary: false });
      const upstream = repos.length > 1 ? repos.find((entry) => entry.source === 'upstream') ?? null : null;
      if (!upstream) return { identity, isFork: false, upstream: null };
      const metadata = await octokit.rest.repos.get({ owner: upstream.owner, repo: upstream.repo });
      const defaultBranch = isProviderString(metadata?.data?.default_branch) ? metadata.data.default_branch.trim() : '';
      if (!defaultBranch) throw new Error('GitHub returned invalid repository metadata');
      const ref = await octokit.rest.git.getRef({ owner: upstream.owner, repo: upstream.repo, ref: `heads/${defaultBranch}` });
      // Which configured remote points at the upstream, if any.
      let remoteName = null;
      try {
        const { git } = await load();
        for (const candidate of await git.getRemotes(directory)) {
          if (!candidate?.name) continue;
          const resolved = await resolveRepo(directory, candidate.name).catch(() => ({ repo: null }));
          if (resolved.repo && resolved.repo.owner === upstream.owner && resolved.repo.repo === upstream.repo) {
            remoteName = candidate.name;
            break;
          }
        }
      } catch {
        remoteName = null;
      }
      return {
        identity,
        isFork: true,
        upstream: mapProject({
          ...upstream, defaultBranch, defaultBranchSha: ref?.data?.object?.sha || null, remoteName,
        }, identity),
      };
    },

    projectBranches: async ({ session, directory, project, remote }) => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote);
      if (!repo) return [];
      const branches = [];
      for (let page = 1; ; page += 1) {
        const response = await octokit.rest.repos.listBranches({ owner: repo.owner, repo: repo.repo, per_page: 100, page });
        const payload = requireProviderArray(response?.data, 'GitHub returned an invalid branch list');
        for (const branch of payload) {
          if (!isPlainObject(branch) || !isProviderString(branch.name) || !branch.name.trim()) {
            throw invalidProviderPayload('GitHub returned an invalid branch');
          }
          branches.push(branch.name);
        }
        if (payload.length < 100) break;
      }
      return branches;
    },

    // The repository's labels and the people who can be asked to review in
    // it, for the board's pickers: one page of 100, from a repository in the
    // bound project's network.
    listLabels: async ({ session, directory, project, remote }) => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote);
      if (!repo) throw notInProject();
      const response = await octokit.rest.issues.listLabelsForRepo({ owner: repo.owner, repo: repo.repo, per_page: 100 });
      return requireProviderArray(response?.data, 'GitHub returned an invalid label list').flatMap((label) => {
        if (!isProviderString(label?.name) || !label.name) return [];
        return [isProviderString(label.color) && label.color ? { name: label.name, color: label.color } : { name: label.name }];
      });
    },

    listReviewerCandidates: async ({ session, directory, project, remote }) => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote);
      if (!repo) throw notInProject();
      const response = await octokit.rest.issues.listAssignees({ owner: repo.owner, repo: repo.repo, per_page: 100 });
      return requireProviderArray(response?.data, 'GitHub returned an invalid user list').flatMap((user) => {
        if (!isProviderString(user?.login) || !user.login) return [];
        return [isProviderString(user.avatar_url) && user.avatar_url
          ? { id: user.login, login: user.login, avatarUrl: user.avatar_url }
          : { id: user.login, login: user.login }];
      });
    },

    /**
     * One page of issues or PRs for the reference picker, or the item a
     * pasted link or number names, across the repository network.
     */
    references: ({ session, directory, remote, kind, state, people, query, cursor }) => pickerRead(async () => {
      const { octokit } = accountOf(session);
      const { rateLimit } = await load();
      const { repo } = await resolveRepo(directory, remote);
      // The gate short-circuits only this host.
      if (rateLimit.isGitHubRateLimited(repo?.host)) throw responseError(503, { error: 'GitHub rate limited' });
      if (!repo) return { connected: true, repo: null, items: [], cursor: null, hasMore: false, total: 0 };
      const network = requireGitHubRepoNetwork(await resolveNetwork(octokit, directory, remote, { strictErrors: true }), repo);
      const page = await searchGitHubReferences({
        octokit,
        repos: network ?? [{ ...repo, source: 'origin' }],
        kind,
        state: readReferenceState(state),
        people: readReferencePeople(people),
        text: query ?? '',
        cursor: cursor || null,
      });
      return { connected: true, repo, ...page };
    }),

    /**
     * The picker's search across several folders. Every folder's context is
     * validated (`validateReadContext`) and read with its own account; one
     * search per account, so repositories read with different accounts
     * never share a query.
     */
    referencesAcross: async ({ body, validateReadContext, resolveSession }) => {
      const { rateLimit, summaries } = await load();
      const input = readReferencesAcrossRequest(body);
      if (!input) throw responseError(400, { error: 'Invalid references request; at most 100 unique contexts are allowed' });
      if (rateLimit.isGitHubRateLimited()) throw responseError(503, { error: 'GitHub rate limited' });
      const isRateLimit = (error) => summaries.isGraphqlRateLimitError(error) || rateLimit.isGitHubRateLimitError(error);
      const folderFailure = async (error) => {
        if (isRateLimit(error)) {
          rateLimit.noteGitHubRateLimit(error);
          throw error;
        }
        if ((error?.status ?? error?.response?.status) === 401 && !error?.sourceControlAccountUnavailable) {
          if (error?.sourceControlIdentity?.accountId) {
            await invalidateAccount(error.sourceControlIdentity, Boolean(error.sourceControlPersistedAccount));
          }
          return 'disconnected';
        }
        // The folder's account is gone or unreadable: only its folders go.
        if (error?.sourceControlAccountUnavailable) return 'disconnected';
        if (error?.code?.startsWith('SOURCE_CONTROL_BINDING_') || error?.code?.startsWith('SOURCE_CONTROL_LOCK_')
          || error?.code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT' || error?.code === 'INVALID_SOURCE_CONTROL_BINDING') {
          return 'invalid-context';
        }
        console.error('Failed to search GitHub references across repositories:', { status: error?.status, code: error?.code, name: error?.name });
        return 'error';
      };
      try {
        const folders = await mapReferencesAcross(input.contexts, async (context) => {
          const { directory } = context;
          try {
            const trusted = await validateReadContext(context);
            if (!trusted) return { directory, status: 'invalid-context' };
            const { octokit } = accountOf(await resolveSession(trusted));
            const { repo } = await resolveRepo(directory, trusted.primaryRemote);
            if (!repo) return { directory, status: 'no-repo' };
            const network = requireGitHubRepoNetwork(await resolveNetwork(octokit, directory, trusted.primaryRemote, { strictErrors: true }), repo);
            return { directory, status: 'included', repo, repos: network ?? [{ ...repo, source: 'origin' }], octokit, trusted };
          } catch (error) {
            return { directory, status: await folderFailure(error) };
          }
        });
        const accounts = new Map();
        for (const folder of folders) {
          if (folder.status !== 'included') continue;
          const { accountId, instance } = folder.trusted;
          const groupKey = JSON.stringify([instance ?? '', accountId]);
          if (!accounts.has(groupKey)) accounts.set(groupKey, { accountId, octokit: folder.octokit, folders: [], authority: [], repositories: new Map() });
          const group = accounts.get(groupKey);
          group.folders.push(folder);
          group.authority.push(folder.trusted);
          for (const repo of folder.repos) {
            const key = `${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`;
            if (!group.repositories.has(key)) group.repositories.set(key, { ...repo, directory: folder.directory });
          }
        }
        const page = await searchGitHubReferencesAcross({
          groups: [...accounts.values()].map((group) => ({ ...group, repos: [...group.repositories.values()] })),
          kind: input.kind,
          state: input.state ?? 'open',
          people: input.people ?? 'any',
          text: input.query?.trim() ?? '',
          cursor: input.cursor || null,
          onGroupError: async (group, error) => {
            const status = await folderFailure(error);
            for (const folder of group.folders) folder.status = status;
          },
        });
        const repositories = new Map(folders.map((folder) => [folder.directory, folder.status === 'included'
          ? { directory: folder.directory, status: 'included', repo: folder.repo }
          : { directory: folder.directory, status: folder.status }]));
        return { ...page, repositories: input.directories.map((directory) => repositories.get(directory)) };
      } catch (error) {
        if (error?.code === 'INVALID_REFERENCES_CURSOR') throw responseError(400, { error: error.message });
        if (isRateLimit(error)) throw responseError(503, { error: 'GitHub rate limited' });
        console.error('Failed to search GitHub references across repositories:', { status: error?.status, code: error?.code, name: error?.name });
        throw responseError(500, { error: 'Failed to search GitHub issues and pull requests' });
      }
    },

    /**
     * Comments of one issue or PR the picker previews, and a PR's size,
     * review decision and reviewers; with `kind: 'discussion'`, a
     * discussion's comment threads. A named enterprise `host` reads with that
     * host's Octokit; its repository must still be in the bound network.
     */
    referenceDetail: ({ session, directory, remote, project, number, host, kind }) => pickerRead(async () => {
      const { octokit: github, rateLimit } = await load();
      const requestedHost = String(host ?? '').trim().toLowerCase();
      const octokit = requestedHost ? await github.getOctokitOrNull(requestedHost) : accountOf(session).octokit;
      if (!octokit) return { connected: false };
      const { repo: checkoutRepo } = await resolveRepo(directory, remote);
      if (rateLimit.isGitHubRateLimited(requestedHost || checkoutRepo?.host)) throw responseError(503, { error: 'GitHub rate limited' });
      let repo;
      if (requestedHost) {
        if (!checkoutRepo) throw notInProject();
        const checkoutOctokit = await github.getOctokitOrNull(checkoutRepo.host || GITHUB_COM);
        if (!checkoutOctokit) return { connected: false };
        const network = requireGitHubRepoNetwork(await resolveNetwork(checkoutOctokit, directory, remote, { strictErrors: true }), checkoutRepo)
          ?? [{ ...checkoutRepo, source: 'origin' }];
        if (!network.some((entry) => sameRepository(entry, { owner: project.owner, repo: project.name }))) throw notInProject();
        repo = { owner: project.owner, repo: project.name };
      } else {
        repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote);
        if (!repo) throw notInProject();
      }
      const read = kind === 'discussion' ? fetchDiscussionDetail : fetchReferenceDetail;
      return { connected: true, detail: await read({ octokit, owner: repo.owner, repo: repo.repo, number }) };
    }),

    /**
     * What colours the PRs a picker page shows, from the sidebar's summaries.
     * Refs group by host (missing means github.com), each on its own Octokit;
     * an untrusted, cooling or failed enterprise host drops only its refs.
     * Every PR on the checkout's own host must be in the bound network.
     */
    referenceStatuses: ({ directory, remote, pulls }) => pickerRead(async () => {
      const { octokit: github, rateLimit, summaries: summaryReads } = await load();
      const refs = readPullStatusRefs(pulls);
      if (!refs) throw responseError(400, { error: 'directory and pulls (owner/repo#number, comma separated) are required' });
      const refsByHost = new Map();
      for (const ref of refs) {
        const refHost = ref.host ? String(ref.host).toLowerCase() : GITHUB_COM;
        if (!refsByHost.has(refHost)) refsByHost.set(refHost, []);
        refsByHost.get(refHost).push(ref);
      }
      const { repo } = await resolveRepo(directory, remote);
      if (rateLimit.isGitHubRateLimited(repo?.host)) throw responseError(503, { error: 'GitHub rate limited' });
      if (!repo) throw notInProject();
      const checkoutHost = String(repo.host ?? '').trim().toLowerCase() || GITHUB_COM;
      const checkoutOctokit = await github.getOctokitOrNull(checkoutHost);
      if (!checkoutOctokit) return { connected: false };
      const network = requireGitHubRepoNetwork(await resolveNetwork(checkoutOctokit, directory, remote, { strictErrors: true }), repo)
        ?? [{ ...repo, source: 'origin' }];
      if (!(refsByHost.get(checkoutHost) ?? []).every((ref) => network.some((entry) => sameRepository(entry, ref)))) throw notInProject();
      const statuses = [];
      for (const [refHost, hostRefs] of refsByHost) {
        if (rateLimit.isGitHubRateLimited(refHost)) continue;
        const octokit = await github.getOctokitOrNull(refHost);
        if (!octokit) continue;
        try {
          const { summaries } = await summaryReads.fetchPrSummaries({ octokit, refs: hostRefs });
          for (const summary of summaries) {
            statuses.push({
              owner: summary.owner, repo: summary.repo, number: summary.number,
              checks: summary.checks, mergeable: summary.mergeable, mergeableState: summary.mergeableState,
            });
          }
        } catch (error) {
          // github.com's group fails the read as it always has (a 401 answers
          // `connected: false`); a failed enterprise host drops only its refs.
          if (refHost === GITHUB_COM) throw error;
        }
      }
      return { connected: true, statuses };
    }),

    /** A pull request's head on the context's primary remote, by number, for a worktree made from it. */
    readChangeRequestHead: async ({ session, directory, remote, number }) => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, null, remote);
      let response;
      try {
        response = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
      } catch (error) {
        if (error?.status === 404) {
          throw sourceControlError(`Pull request #${number} was not found in ${repo.owner}/${repo.repo}`, 'SOURCE_CONTROL_CHANGE_REQUEST_NOT_FOUND', 404);
        }
        throw error;
      }
      const payload = requireGitHubPullRequest(response?.data, 'GitHub returned an invalid pull request');
      if (!payload.head?.repo) {
        throw sourceControlError(`Pull request #${number} has no branch to check out: its fork was deleted`, 'SOURCE_CONTROL_CHANGE_REQUEST_HEAD_GONE', 409);
      }
      const headSha = isProviderString(payload.head.sha) ? payload.head.sha.toLowerCase() : '';
      if (!/^[0-9a-f]{40}$/.test(headSha)) throw invalidProviderPayload('GitHub returned an invalid pull request head');
      return {
        project: { id: `${repo.owner}/${repo.repo}`, owner: repo.owner, name: repo.repo },
        headSha,
        headBranch: payload.head.ref,
        headOwner: payload.head.repo.owner.login,
      };
    },

    resolveChangeRequestSource: async ({ session, context, project, number, expectedHeadSha, requestedRemoteName }) => {
      const { octokit } = accountOf(session);
      const target = await resolveRepoForRequest(octokit, context.directory, { owner: project.owner, repo: project.name }, context.primaryRemote);
      if (!target || `${target.owner}/${target.repo}` !== project.id) {
        throw sourceControlError('Change request project does not match the bound fork network', 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', 409);
      }
      const payload = requireGitHubPullRequest((await octokit.rest.pulls.get({
        owner: target.owner, repo: target.repo, pull_number: number,
      }))?.data, 'GitHub returned an invalid pull request');
      const headSha = String(payload.head?.sha || '').toLowerCase();
      const headOwner = payload.head?.repo?.owner?.login;
      const headName = payload.head?.repo?.name;
      const headRef = payload.head?.ref;
      const endpoint = payload.head?.repo?.clone_url;
      if (headSha !== expectedHeadSha.toLowerCase() || !headOwner || !headName || !headRef || !endpoint) {
        throw sourceControlError('Change request head changed', 'SOURCE_CONTROL_CHANGE_REQUEST_STALE', 409);
      }
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:' || parsed.pathname.replace(/^\//, '').replace(/\.git$/, '') !== `${headOwner}/${headName}`) {
        throw invalidProviderPayload('GitHub returned an invalid head repository endpoint');
      }
      return Object.freeze({
        context,
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
