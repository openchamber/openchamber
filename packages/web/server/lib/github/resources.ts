import {
  invalidProviderPayload,
  isPlainObject,
  isProviderString,
  mapAnnotations,
  mapCheckRun,
  mapChangeRequest,
  mapCI,
  mapComment,
  mapCommitStatus,
  mapFile,
  mapIssue,
  mapProject,
  mapReviewComment,
  mapWorkflowJob,
  requireGitHubCheckRuns,
  requireGitHubComment,
  requireGitHubIssue,
  requireGitHubPullRequest,
  requireGitHubRepoNetwork,
  requireGitHubStatuses,
  requireGitHubWorkflowJobs,
  requireProviderArray,
} from './mappers.js';
import {
  buildReferenceSearchQuery,
  fetchDiscussionDetail,
  fetchReferenceDetail,
  labelSearchQualifiers,
  mapReferencesAcross,
  readPullStatusRefs,
  readReferencePeople,
  readReferenceState,
  readReferencesAcrossRequest,
  searchGitHubReferences,
  searchGitHubReferencesAcross,
} from './reference-search.js';
import { createContextCache } from './context-cache.js';
import { repositoryOfApiUrl } from './api-host.js';
import { readAssignablePeople } from './people.js';
import { fetchPullStack } from './pull-stack.js';
import { referencesField } from './references.js';
import { parseReferenceLink } from './reference-links.js';
import { fetchReviewState } from './review-draft.js';
import { readPullContextParts } from './pull-context-reads.js';
import type { ContextReviewFields } from './review-summaries.js';
import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest';
import type { ProviderImplementation, ProviderSession } from '../source-control/provider-contract.js';
import type { ContributorProvenanceRead } from '../git/contributor-provenance-storage.js';
import type { AcrossContext, AcrossGroup, DiscoveryRepository, GitHubEnvelope } from './contracts.js';
import type { CI } from './mappers.js';
import { retainedEntry } from './contracts.js';
type ResourceMethods = ProviderImplementation['resources'];
type ResourceInput<Key extends keyof ResourceMethods> = Parameters<NonNullable<ResourceMethods[Key]>>[0];
type Rest = RestEndpointMethodTypes;
type Pull = Rest['pulls']['get']['response']['data'];
type ListedPull = Rest['pulls']['list']['response']['data'][number];
type Issue = Rest['issues']['get']['response']['data'];
type CheckRun = Rest['checks']['listForRef']['response']['data']['check_runs'][number];
type CommitStatus = Rest['repos']['getCombinedStatusForRef']['response']['data']['statuses'][number];
type Job = Rest['actions']['listJobsForWorkflowRun']['response']['data']['jobs'][number];
type Annotation = Rest['checks']['listAnnotations']['response']['data'][number];
type Identity = Pick<ReturnType<typeof mapProject>, 'provider' | 'instance'>;
export interface GitHubResourceModules {
  octokit: typeof import('./octokit.js');
  summaries: typeof import('./pr-summaries.js');
  rateLimit: typeof import('./rate-limit.js');
  patch: typeof import('./change-request-patch.js');
  prStatus: typeof import('./pr-status.js');
  checks: typeof import('./checks-summary.js');
  repo: typeof import('./repo/index.js');
  forks: typeof import('./repo/fork-detection.js');
  git: typeof import('../git/index.js');
}
export interface GitHubResourceOptions {
  load: () => Promise<GitHubResourceModules>;
  accountOf: (session: ProviderSession) => { octokit: Octokit; user: { login?: string } | null };
  resolveRepo: typeof import('./repo/index.js').resolveGitHubRepoFromDirectory;
  resolveNetwork: typeof import('./repo/fork-detection.js').resolveRepoNetwork;
  resolvePrStatus: typeof import('./pr-status.js').resolveGitHubPrStatus;
  readContributorProvenance?: ((directory: string) => Promise<ContributorProvenanceRead>) | undefined;
  invalidateAccount: (identity: GitHubEnvelope['data'], persisted: boolean) => Promise<boolean>;
}
export interface ContextScope {
  accountId: string;
  credentialRevision: number | null;
  repositoryId: string | undefined;
  bindingRevision: number | undefined;
  primaryRemote: string;
  number: number | undefined;
}
export interface PullContext extends ContextReviewFields {
  identity: Identity;
  fetchedAt: number;
  project: ReturnType<typeof mapProject>;
  changeRequest: ReturnType<typeof mapChangeRequest>;
  issueComments: ReturnType<typeof mapComment>[];
  reviewComments: ReturnType<typeof mapReviewComment>[];
  files: ReturnType<typeof mapFile>[];
  ci: CI | null;
  diff?: string;
  stack?: Awaited<ReturnType<typeof fetchPullStack>>;
}
export interface PageResult<Item> {
  items: Item[];
  page: number;
  hasMore: boolean;
  incompleteProjectIds?: string[];
}
interface RepositoryFailure { repoRef: DiscoveryRepository; error: unknown }
type FolderStatus = 'invalid-context' | 'no-repo' | 'disconnected' | 'error';
interface IncludedFolder {
  directory: string;
  status: 'included' | FolderStatus;
  repo: DiscoveryRepository;
  repos: import('./repo/fork-detection.js').NetworkRepository[];
  octokit: Octokit;
  trusted: AcrossContext;
}
type SearchFolder = IncludedFolder | { directory: string; status: FolderStatus };
interface AccountGroup extends Omit<AcrossGroup, 'repos'> {
  folders: IncludedFolder[];
  repositories: Map<string, AcrossGroup['repos'][number]>;
}

const hasErrorField = <Key extends string>(value: unknown, key: Key): value is Record<Key, unknown> =>
  value != null && key in Object(value);
const errorField = (value: GitHubEnvelope['data'], key: string) =>
  hasErrorField(value, key) ? value[key] : undefined;
const errorStatus = (error: GitHubEnvelope['data']) => errorField(error, 'status') ?? errorField(errorField(error, 'response'), 'status');
const isErrorCodeMethod = (value: unknown): value is (prefix: string) => GitHubEnvelope['code'] => typeof value === 'function';
const errorCodeStartsWith = (code: GitHubEnvelope['code'], prefix: string) => {
  if (code == null) return undefined;
  const method = errorField(code, 'startsWith');
  if (!isErrorCodeMethod(method)) throw new TypeError('code.startsWith is not a function');
  return Boolean(method.call(code, prefix));
};

const GITHUB_COM = 'github.com';
const PULL_LIST_STATES = new Set(['open', 'closed', 'merged', 'all']);
const PULL_LIST_PEOPLE = new Set(['any', 'assigned', 'created', 'reviewRequested']);
const isPullListState = (value: string): value is 'open' | 'closed' | 'merged' | 'all' => PULL_LIST_STATES.has(value);
const isPullListPeople = (value: string): value is 'any' | 'assigned' | 'created' | 'reviewRequested' => PULL_LIST_PEOPLE.has(value);
const CAN_MERGE_REFUSAL_TTL_MS = 5 * 60_000;
const CAN_MERGE_REFUSAL_MAX_ENTRIES = 1000;

export const responseError = <Body extends { error: unknown }>(status: number, body: Body) => Object.assign(new Error(body.error), { sourceControlResponse: { status, body } });

const sourceControlError = (message: string, code: string, status: number) => Object.assign(new Error(message), { code, status });

const notInProject = () => responseError(400, { error: 'Repository is not part of this project' });
const rateLimited = () => Object.assign(new Error('GitHub rate limited'), { status: 503 });

const sameRepository = (left: Pick<DiscoveryRepository, 'owner' | 'repo'>, right: Pick<DiscoveryRepository, 'owner' | 'repo'>) => left.owner.toLowerCase() === right.owner.toLowerCase()
  && left.repo.toLowerCase() === right.repo.toLowerCase();

export const gitHubRefusalMessage = (error: GitHubEnvelope['data']) => {
  const message = errorField(errorField(errorField(error, 'response'), 'data'), 'message');
  return isProviderString(message) && message.trim() ? message : errorField(error, 'message');
};

export function createGitHubResources({
  load,
  accountOf,
  resolveRepo,
  resolveNetwork,
  resolvePrStatus,
  readContributorProvenance,
  invalidateAccount,
}: GitHubResourceOptions) {
  const contextCache = createContextCache();
  const authLoginByCredential = new Map<string, Promise<string | null>>();
  const canMergeRefusals = new Map<string, number>();

  const identityOf = (session: ProviderSession) => ({ provider: 'github', instance: session.instance });

  async function resolveRepoForRequest(octokit: Octokit, directory: string, requestedRepo: null, remoteName: string): Promise<DiscoveryRepository>;
  async function resolveRepoForRequest(octokit: Octokit, directory: string, requestedRepo: DiscoveryRepository | null, remoteName: string, options?: { linked?: boolean | undefined }): Promise<DiscoveryRepository | null>;
  async function resolveRepoForRequest(octokit: Octokit, directory: string, requestedRepo: DiscoveryRepository | null, remoteName: string, { linked = false }: { linked?: boolean | undefined } = {}) {
    const { repo } = await resolveRepo(directory, remoteName);
    if (!repo) throw new Error(`Unable to resolve GitHub repo from git remote "${remoteName}"`);
    if (linked && requestedRepo) return requestedRepo;
    const network = requireGitHubRepoNetwork(await resolveNetwork(octokit, directory, remoteName, { strictErrors: true }), repo);
    if (!requestedRepo) return repo;
    if (repo.owner === requestedRepo.owner && repo.repo === requestedRepo.repo) return requestedRepo;
    return Array.isArray(network) && network.some((item) => item?.owner === requestedRepo.owner && item?.repo === requestedRepo.repo)
      ? requestedRepo
      : null;
  }

  const resolveRepoNetwork = async (octokit: Octokit, directory: string, remoteName: string, { requirePrimary = true } = {}) => {
    const { repo } = await resolveRepo(directory, remoteName);
    if (!repo) throw new Error(`Unable to resolve GitHub repo from git remote "${remoteName}"`);
    const network = requireGitHubRepoNetwork(
      await resolveNetwork(octokit, directory, remoteName, { strictErrors: true }),
      requirePrimary ? repo : undefined,
    );
    return { repo, repos: network ?? [{ ...repo, source: 'origin' as const }] };
  };

  const readContributorSourceRemote = async (directory: string, branch: string) => {
    if (!(readContributorProvenance instanceof Function)) return null;
    try {
      const { provenance } = await readContributorProvenance(directory);
      return provenance?.kind === 'contributor-fork' && provenance.provider === 'github'
        && provenance.sourceRef === `refs/heads/${branch}` ? provenance.remoteName : null;
    } catch {
      return null;
    }
  };

  const readChecks = async (octokit: Octokit, repo: DiscoveryRepository, sha: string, { runs: keepRuns = false } = {}) => {
    const { checks: { dedupeCheckRuns, summarizeCheckRead } } = await load();
    const ref = { owner: repo.owner, repo: repo.repo, ref: sha };
    const [checkRuns, statuses]: [CheckRun[] | null, CommitStatus[] | null] = await Promise.all([
      octokit.rest.checks.listForRef({ ...ref, per_page: 100 })
        .then((response: Rest['checks']['listForRef']['response']): CheckRun[] => dedupeCheckRuns(requireGitHubCheckRuns(response?.data?.check_runs)))
        .catch(() => null),
      octokit.rest.repos.getCombinedStatusForRef({ ...ref, per_page: 100 })
        .then((combined: Rest['repos']['getCombinedStatusForRef']['response']) => requireGitHubStatuses(combined?.data?.statuses))
        .catch(() => null),
    ]);
    const summary = summarizeCheckRead(checkRuns, statuses);
    return { summary, checkRuns: keepRuns ? checkRuns ?? [] : [], statuses: keepRuns ? statuses ?? [] : [] };
  };

  const readCheckDetails = async (octokit: Octokit, repo: DiscoveryRepository, checkRuns: CheckRun[]) => {
    const jobsByRun = new Map<number, Job[]>();
    const annotationsByRun = new Map<number, ReturnType<typeof mapAnnotations>>();
    const runIdOf = (run: CheckRun) => {
      const match = (isProviderString(run.details_url) ? run.details_url : '').match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
      const runId = match ? Number(match[1]) : null;
      return runId && Number.isFinite(runId) && runId > 0 ? { runId, jobId: match?.[2] ? Number(match[2]) : null } : null;
    };
    for (const runId of new Set(checkRuns.map(runIdOf).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)).map((entry) => entry.runId))) {
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
      const annotations: Annotation[] = [];
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
    return (run: CheckRun) => {
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

  const readCanMerge = async (octokit: Octokit, session: ProviderSession, user: { login?: string } | null, repo: DiscoveryRepository, host: string | null | undefined) => {
    try {
      const loginHost = String(host ?? '').trim().toLowerCase() || GITHUB_COM;
      const loginKey = JSON.stringify([loginHost, session.accountId, session.credentialRevision]);
      let username = loginHost === GITHUB_COM ? user?.login : null;
      if (!username) {
        let loginPromise = authLoginByCredential.get(loginKey);
        if (!loginPromise) {
          loginPromise = octokit.rest.users.getAuthenticated()
            .then((response: Rest['users']['getAuthenticated']['response']) => response?.data?.login || null)
            .catch(() => {
              authLoginByCredential.delete(loginKey);
              return null;
            });
          if (loginPromise) authLoginByCredential.set(loginKey, loginPromise);
        }
        username = await loginPromise;
      }
      if (!username) return false;
      const refusalKey = JSON.stringify([loginHost, session.accountId, session.credentialRevision, repo.owner, repo.repo]);
      const refusedUntil = canMergeRefusals.get(refusalKey);
      if (refusedUntil !== undefined && Date.now() < refusedUntil) return false;
      canMergeRefusals.delete(refusalKey);
      try {
        const permission = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner: repo.owner, repo: repo.repo, username });
        canMergeRefusals.delete(refusalKey);
        return ['admin', 'maintain', 'write'].includes(permission?.data?.permission);
      } catch (error) {
        const { rateLimit } = await load();
        if (errorStatus(error) === 403 && !rateLimit.isGitHubRateLimitError(error)) {
          const now = Date.now();
          for (const [key, expiresAt] of canMergeRefusals) {
            if (expiresAt <= now) canMergeRefusals.delete(key);
          }
          canMergeRefusals.set(refusalKey, now + CAN_MERGE_REFUSAL_TTL_MS);
          if (canMergeRefusals.size > CAN_MERGE_REFUSAL_MAX_ENTRIES) {
            const oldest = canMergeRefusals.keys().next().value;
            if (oldest !== undefined) canMergeRefusals.delete(oldest);
          }
        }
        throw error;
      }
    } catch {
      return false;
    }
  };

  const statusFailure = async (error: GitHubEnvelope['data'], host: string) => {
    const { rateLimit } = await load();
    if (rateLimit.noteIfGitHubRateLimit(error, host)) return rateLimited();
    if (errorStatus(error) === 403) {
      return Object.assign(new Error(gitHubRefusalMessage(error)), { status: 403 });
    }
    return error;
  };

  const pickerRead = async <Result>(operation: () => Promise<Result>) => {
    try {
      return await operation();
    } catch (error) {
      if (errorField(error, 'sourceControlResponse') || errorField(error, 'sourceControlAccountUnavailable')) throw error;
      if (errorStatus(error) === 401) {
        if (errorField(errorField(error, 'sourceControlIdentity'), 'accountId')) throw error;
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

  const emptyContext = (identity: Identity) => ({ identity, project: null, changeRequest: null, issueComments: [], reviewComments: [], files: [] });

  return Object.freeze({
    invalidateContexts: (scope: Partial<ContextScope>) => contextCache.invalidate(scope),

    changeRequestStatus: async ({ session, directory, branch, remote, force = false }: ResourceInput<'changeRequestStatus'>) => {
      const { octokit, user } = accountOf(session);
      const identity = identityOf(session);
      const { rateLimit } = await load();
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
        if (changeRequest.state !== 'open') return { ...found, changeRequest };
        const { summary } = changeRequest.headSha ? await readChecks(octokit, resolved.repo, changeRequest.headSha) : { summary: null };
        return {
          ...found,
          changeRequest,
          ci: mapCI(summary),
          canMerge: await readCanMerge(octokit, session, user, resolved.repo, hostRepo?.host),
        };
      } catch (error) {
        if (errorStatus(error) === 404) return noProject;
        throw await statusFailure(error, host);
      }
    },

    listChangeRequests: async ({ session, directory, page, query, labels, state, people, remote }: ResourceInput<'listChangeRequests'>) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const { repo, repos } = await resolveRepoNetwork(octokit, directory, remote);
      const projectOf = (repoRef: DiscoveryRepository) => mapProject(repoRef, identity);
      const toChangeRequest = (pr: Pull | ListedPull, repoRef: DiscoveryRepository) => mapChangeRequest(requireGitHubPullRequest(pr, 'GitHub returned an invalid pull request'), projectOf(repoRef), identity);
      const isPrimary = (repoRef: DiscoveryRepository) => repoRef.owner === repo.owner && repoRef.repo === repo.repo;
      const ofState = isPullListState(state) ? state : 'open';
      const ofPeople = isPullListPeople(people) ? people : 'any';

      if (ofState === 'merged' || ofPeople !== 'any' || query || (labels?.length ?? 0) > 0) {
        const q = buildReferenceSearchQuery({ repos, kind: 'pull', state: ofState, people: ofPeople, text: query ?? '', labels });
        const search = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 50, page });
        const data = search?.data;
        if (!isPlainObject(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
          throw invalidProviderPayload('GitHub returned an invalid pull request search result');
        }
        const items = requireProviderArray<Rest['search']['issuesAndPullRequests']['response']['data']['items'][number]>(data.items, 'GitHub returned an invalid pull request search list');
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
        const failed: RepositoryFailure[] = [];
        const results = await Promise.all(refs.map(async ({ number, repoRef }) => {
          try {
            const pr = await octokit.rest.pulls.get({ owner: repoRef.owner, repo: repoRef.repo, pull_number: number });
            return toChangeRequest(pr?.data, repoRef);
          } catch (error) {
            if (errorField(error, 'status') === 401) throw error;
            failed.push({ repoRef, error });
            return null;
          }
        }));
        if (refs.length > 0 && failed.length === refs.length) throw retainedEntry(failed, 0).error;
        const primaryFailure = failed.find(({ repoRef }) => isPrimary(repoRef));
        if (primaryFailure) throw primaryFailure.error;
        const result: PageResult<ReturnType<typeof mapChangeRequest>> = { items: results.filter((item): item is NonNullable<typeof item> => Boolean(item)), page, hasMore: (page - 1) * 50 + items.length < data.total_count };
        if (failed.length > 0) result.incompleteProjectIds = [...new Set(failed.map(({ repoRef }) => `${repoRef.owner}/${repoRef.repo}`))];
        return result;
      }

      const results = await Promise.all(repos.map(async (repoRef) => {
        try {
          const list = await octokit.rest.pulls.list({ owner: repoRef.owner, repo: repoRef.repo, state: ofState, per_page: 50, page });
          const link = isProviderString(list?.headers?.link) ? list.headers.link : '';
          const prs = requireProviderArray<ListedPull>(list?.data, 'GitHub returned an invalid pull request list');
          return { items: prs.map((pr) => toChangeRequest(pr, repoRef)), hasMore: /rel="next"/.test(link) };
        } catch (error) {
          if (errorField(error, 'status') === 401) throw error;
          return { error, repoRef };
        }
      }));
      const failed = results.filter((entry): entry is Extract<typeof entry, { error: unknown }> => Boolean(entry.error));
      const primaryFailure = failed.find((entry) => isPrimary(entry.repoRef));
      if (primaryFailure) throw primaryFailure.error;
      const succeeded = results.filter((entry) => !entry.error);
      if (succeeded.length === 0 && failed.length > 0) throw retainedEntry(failed, 0).error;
      const result: PageResult<ReturnType<typeof mapChangeRequest> | undefined> = { items: succeeded.flatMap((entry) => entry.items), page, hasMore: succeeded.some((entry) => entry.hasMore) };
      if (failed.length > 0) result.incompleteProjectIds = failed.map(({ repoRef }) => `${repoRef.owner}/${repoRef.repo}`);
      return result;
    },

    changeRequestContext: async ({ session, context, directory, number, project, remote, includeDiff, includeCIDetails, includeReferences }: ResourceInput<'changeRequestContext'>) => {
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
      const cacheKey = JSON.stringify([directory, number, includeDiff, includeReferences === true, requestedRepo ? `${requestedRepo.owner}/${requestedRepo.repo}` : null, scope, context?.linked === true]);
      const cached = contextCache.read(cacheKey, includeCIDetails);
      if (cached) return cached;
      const started = contextCache.begin();

      const repo = await resolveRepoForRequest(octokit, directory, requestedRepo, remote, { linked: context?.linked });
      if (!repo) return emptyContext(identity);
      const route = { owner: repo.owner, repo: repo.repo };
      const projectDTO = mapProject(repo, identity);
      const prData = requireGitHubPullRequest((await octokit.rest.pulls.get({ ...route, pull_number: number }))?.data, 'GitHub returned an invalid pull request');
      const readDiff = async () => {
        if (!includeDiff) return undefined;
        const response = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          ...route, pull_number: number, headers: { accept: 'application/vnd.github.v3.diff' },
        });
        if (!isProviderString(response?.data)) throw invalidProviderPayload('GitHub returned an invalid pull request diff');
        return response.data;
      };
      const sha = prData.head?.sha;
      const { issueComments, reviewComments, files, checks, diff, reviewFields } = await readPullContextParts({
        octokit, route, number, identity,
        requestedReviewers: prData.requested_reviewers,
        readChecks: async () => (sha ? readChecks(octokit, repo, sha, { runs: true }) : null),
        readDiff,
      });
      let ci: CI | null = null;
      if (checks) {
        const { summary, checkRuns, statuses } = checks;
        if (summary && checkRuns.length + statuses.length > 0) {
          const details = includeCIDetails ? await readCheckDetails(octokit, repo, checkRuns) : () => ({});
          ci = mapCI(summary, [
            ...checkRuns.map((run) => mapCheckRun(run, details(run), identity)),
            ...statuses.map((status) => mapCommitStatus(status, identity)),
          ]);
        } else {
          ci = mapCI(summary);
        }
      }

      const result: PullContext = {
        identity,
        fetchedAt: Date.now(),
        project: projectDTO,
        changeRequest: mapChangeRequest(prData, projectDTO, identity),
        issueComments,
        reviewComments,
        ...reviewFields,
        files,
        ci,
      };
      if (diff) result.diff = diff;
      if (isPlainObject(prData.stack)) {
        const stack = await fetchPullStack({ octokit, owner: repo.owner, repo: repo.repo, number }).catch(() => undefined);
        if (stack !== undefined) result.stack = stack;
      }
      if (includeReferences) Object.assign(result, await referencesField(octokit, repo.owner, repo.repo, number));
      contextCache.store(cacheKey, scope, result, includeCIDetails, started);
      return result;
    },

    listIssues: async ({ session, directory, page, query, labels, remote }: ResourceInput<'listIssues'>) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const { repos } = await resolveRepoNetwork(octokit, directory, remote, { requirePrimary: false });
      const toIssue = (issue: Issue, repoRef: DiscoveryRepository) => mapIssue(requireGitHubIssue(issue, 'GitHub returned an invalid issue'), mapProject(repoRef, identity), identity);

      if (query) {
        const q = [...repos.map((entry) => `repo:${entry.owner}/${entry.repo}`), query, 'type:issue state:open',
          ...labelSearchQualifiers(labels, query)].join(' ');
        const search = await octokit.rest.search.issuesAndPullRequests({ q, per_page: 50, page });
        const data = search?.data;
        if (!isPlainObject(data) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
          throw invalidProviderPayload('GitHub returned an invalid issue search result');
        }
        const items = requireProviderArray<Rest['search']['issuesAndPullRequests']['response']['data']['items'][number]>(data.items, 'GitHub returned an invalid issue search result');
        const issueItems = items.filter((item) => !item?.pull_request);
        const failed: RepositoryFailure[] = [];
        const results = await Promise.all(issueItems.map(async (item) => {
          if (!isPlainObject(item) || !Number.isSafeInteger(item.number) || item.number <= 0) {
            throw invalidProviderPayload('GitHub returned an invalid issue search item');
          }
          const repoRef = isProviderString(item.repository_url) ? repositoryOfApiUrl(repos, item.repository_url, identity.instance) : null;
          if (!repoRef) throw invalidProviderPayload('GitHub issue search returned an invalid repository URL');
          try {
            const issue = await octokit.rest.issues.get({ owner: repoRef.owner, repo: repoRef.repo, issue_number: item.number });
            return toIssue(issue?.data, repoRef);
          } catch (error) {
            if (errorField(error, 'status') === 401 || errorField(error, 'code') === 'MALFORMED_PROVIDER_RESPONSE') throw error;
            failed.push({ repoRef, error });
            return null;
          }
        }));
        if (issueItems.length > 0 && failed.length === issueItems.length) throw retainedEntry(failed, 0).error;
        const result: PageResult<ReturnType<typeof mapIssue>> = { items: results.filter((item): item is NonNullable<typeof item> => Boolean(item)), page, hasMore: (page - 1) * 50 + items.length < data.total_count };
        if (failed.length > 0) result.incompleteProjectIds = [...new Set(failed.map(({ repoRef }) => `${repoRef.owner}/${repoRef.repo}`))];
        return result;
      }

      const labelParam = labels && labels.length > 0 ? { labels: labels.join(',') } : {};
      const results = await Promise.all(repos.map(async (repoRef) => {
        try {
          const list = await octokit.rest.issues.listForRepo({ owner: repoRef.owner, repo: repoRef.repo, state: 'open', per_page: 50, page, ...labelParam });
          const link = isProviderString(list?.headers?.link) ? list.headers.link : '';
          const issues = requireProviderArray<Rest['issues']['listForRepo']['response']['data'][number]>(list?.data, 'GitHub returned an invalid issue list')
            .filter((item) => !item?.pull_request)
            .map((item) => toIssue(item, repoRef));
          return { items: issues, hasMore: /rel="next"/.test(link) };
        } catch (error) {
          if (errorField(error, 'status') === 401 || errorField(error, 'code') === 'MALFORMED_PROVIDER_RESPONSE') throw error;
          return { error, repoRef };
        }
      }));
      const succeeded = results.filter((entry) => !entry.error);
      const failed = results.filter((entry): entry is Extract<typeof entry, { error: unknown }> => Boolean(entry.error));
      if (succeeded.length === 0 && failed.length > 0) throw retainedEntry(failed, 0).error;
      const result: PageResult<ReturnType<typeof mapIssue> | undefined> = { items: succeeded.flatMap((entry) => entry.items), page, hasMore: succeeded.some((entry) => entry.hasMore) };
      if (failed.length > 0) result.incompleteProjectIds = failed.map(({ repoRef }) => `${repoRef.owner}/${repoRef.repo}`);
      return result;
    },

    getIssue: async ({ session, context, directory, number, project, remote, includeReferences }: ResourceInput<'getIssue'>) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, project ? { owner: project.owner, repo: project.name } : null, remote, { linked: context?.linked });
      if (!repo) return null;
      const issue = requireGitHubIssue((await octokit.rest.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: number }))?.data, 'GitHub returned an invalid issue');
      if (issue.pull_request) throw responseError(400, { error: 'Not a GitHub issue' });
      const mapped = mapIssue(issue, mapProject(repo, identity), identity);
      return includeReferences ? { ...mapped, ...(await referencesField(octokit, repo.owner, repo.repo, number)) } : mapped;
    },

    issueComments: async ({ session, context, directory, number, project, remote }: ResourceInput<'issueComments'>) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, project ? { owner: project.owner, repo: project.name } : null, remote, { linked: context?.linked });
      if (!repo) return [];
      const response = await octokit.rest.issues.listComments({ owner: repo.owner, repo: repo.repo, issue_number: number, per_page: 100 });
      return requireProviderArray<Rest['issues']['listComments']['response']['data'][number]>(response?.data, 'GitHub returned an invalid issue comment list')
        .map((comment) => mapComment(requireGitHubComment(comment, 'GitHub returned an invalid issue comment'), identity));
    },

    projectUpstream: async ({ session, directory, remote }: ResourceInput<'projectUpstream'>) => {
      const { octokit } = accountOf(session);
      const identity = identityOf(session);
      const { repos } = await resolveRepoNetwork(octokit, directory, remote, { requirePrimary: false });
      const upstream = repos.length > 1 ? repos.find((entry) => entry.source === 'upstream') ?? null : null;
      if (!upstream) return { identity, isFork: false, upstream: null };
      const metadata = await octokit.rest.repos.get({ owner: upstream.owner, repo: upstream.repo });
      const defaultBranch = isProviderString(metadata?.data?.default_branch) ? metadata.data.default_branch.trim() : '';
      if (!defaultBranch) throw new Error('GitHub returned invalid repository metadata');
      const ref = await octokit.rest.git.getRef({ owner: upstream.owner, repo: upstream.repo, ref: `heads/${defaultBranch}` });
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

    projectBranches: async ({ session, directory, project, remote }: ResourceInput<'projectBranches'>) => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote);
      if (!repo) return [];
      const branches = [];
      for (let page = 1; ; page += 1) {
        const response = await octokit.rest.repos.listBranches({ owner: repo.owner, repo: repo.repo, per_page: 100, page });
        const payload = requireProviderArray<Rest['repos']['listBranches']['response']['data'][number]>(response?.data, 'GitHub returned an invalid branch list');
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

    listLabels: async ({ session, directory, project, remote }: ResourceInput<'listLabels'>) => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote);
      if (!repo) throw notInProject();
      const response = await octokit.rest.issues.listLabelsForRepo({ owner: repo.owner, repo: repo.repo, per_page: 100 });
      return requireProviderArray<Rest['issues']['listLabelsForRepo']['response']['data'][number]>(response?.data, 'GitHub returned an invalid label list').flatMap((label) => {
        if (!isProviderString(label?.name) || !label.name) return [];
        return [isProviderString(label.color) && label.color ? { name: label.name, color: label.color } : { name: label.name }];
      });
    },

    listReviewerCandidates: async ({ session, directory, project, remote, role }: ResourceInput<'listReviewerCandidates'>) => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote);
      if (!repo) throw notInProject();
      return readAssignablePeople(octokit, repo, role === 'assignee');
    },

    references: ({ session, context, directory, remote, kind, state, people, query, labels = [], cursor }: ResourceInput<'references'> & { labels?: string[] }) => pickerRead(async () => {
      const { octokit } = accountOf(session);
      const { rateLimit } = await load();
      const { repo } = await resolveRepo(directory, remote);
      if (rateLimit.isGitHubRateLimited(repo?.host)) throw responseError(503, { error: 'GitHub rate limited' });
      if (!repo) return { connected: true, repo: null, items: [], cursor: null, hasMore: false, total: 0 };
      if (context?.linked) {
        const link = parseReferenceLink(query ?? '', repo.host || GITHUB_COM);
        if (!link) return { connected: true, repo, items: [], cursor: null, hasMore: false, total: 0 };
        return { connected: true, repo, ...(await searchGitHubReferences({
          octokit,
          repos: [{ owner: retainedEntry([link.owner], 0), repo: retainedEntry([link.repo], 0), source: 'origin' }],
          kind,
          state: readReferenceState(state),
          people: readReferencePeople(people),
          text: `#${link.number}`,
          cursor: null,
        })) };
      }
      const network = requireGitHubRepoNetwork(await resolveNetwork(octokit, directory, remote, { strictErrors: true }), repo);
      const page = await searchGitHubReferences({
        octokit,
        repos: network ?? [{ ...repo, source: 'origin' }],
        kind,
        state: readReferenceState(state),
        people: readReferencePeople(people),
        labels,
        text: query ?? '',
        cursor: cursor || null,
      }, repo.host || GITHUB_COM);
      return { connected: true, repo, ...page };
    }),

    referencesAcross: async ({ body, validateReadContext, resolveSession }: {
      body: Parameters<typeof readReferencesAcrossRequest>[0];
      validateReadContext: (context: AcrossContext) => Promise<AcrossContext | null>;
      resolveSession: (context: AcrossContext) => Promise<ProviderSession>;
    }) => {
      const { rateLimit, summaries } = await load();
      const input = readReferencesAcrossRequest(body);
      if (!input) throw responseError(400, { error: 'Invalid references request; at most 100 unique contexts are allowed' });
      if (rateLimit.isGitHubRateLimited()) throw responseError(503, { error: 'GitHub rate limited' });
      const isRateLimit = (error: GitHubEnvelope['data']) => summaries.isGraphqlRateLimitError(error) || rateLimit.isGitHubRateLimitError(error);
      const folderFailure = async (error: GitHubEnvelope['data']): Promise<FolderStatus> => {
        if (isRateLimit(error)) {
          rateLimit.noteGitHubRateLimit(error);
          throw error;
        }
        if (errorStatus(error) === 401 && !errorField(error, 'sourceControlAccountUnavailable')) {
          if (errorField(errorField(error, 'sourceControlIdentity'), 'accountId')) {
            await invalidateAccount(errorField(error, 'sourceControlIdentity'), Boolean(errorField(error, 'sourceControlPersistedAccount')));
          }
          return 'disconnected';
        }
        if (errorField(error, 'sourceControlAccountUnavailable')) return 'disconnected';
        const code = errorField(error, 'code');
        if (errorCodeStartsWith(code, 'SOURCE_CONTROL_BINDING_') || errorCodeStartsWith(code, 'SOURCE_CONTROL_LOCK_')
          || code === 'INVALID_SOURCE_CONTROL_READ_CONTEXT' || code === 'INVALID_SOURCE_CONTROL_BINDING') {
          return 'invalid-context';
        }
        console.error('Failed to search GitHub references across repositories:', { status: errorField(error, 'status'), code: errorField(error, 'code'), name: errorField(error, 'name') });
        return 'error';
      };
      try {
        const folders = await mapReferencesAcross(input.contexts, async (context): Promise<SearchFolder> => {
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
        const accounts = new Map<string, AccountGroup>();
        for (const folder of folders) {
          if (folder.status !== 'included') continue;
          const { accountId, instance } = folder.trusted;
          const groupKey = JSON.stringify([instance ?? '', accountId]);
          if (!accounts.has(groupKey)) accounts.set(groupKey, { accountId, octokit: folder.octokit, host: instance || GITHUB_COM, folders: [], authority: [], repositories: new Map() });
          const group = accounts.get(groupKey);
          if (!group) throw new Error('Missing reference account group');
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
          labels: input.labels ?? [],
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
        if (errorField(error, 'code') === 'INVALID_REFERENCES_CURSOR') throw responseError(400, { error: errorField(error, 'message') });
        if (isRateLimit(error)) throw responseError(503, { error: 'GitHub rate limited' });
        console.error('Failed to search GitHub references across repositories:', { status: errorField(error, 'status'), code: errorField(error, 'code'), name: errorField(error, 'name') });
        throw responseError(500, { error: 'Failed to search GitHub issues and pull requests' });
      }
    },

    referenceDetail: ({ session, context, directory, remote, project, number, host, kind, includeReferences }: ResourceInput<'referenceDetail'>) => pickerRead(async () => {
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
        repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote, { linked: context?.linked });
        if (!repo) throw notInProject();
      }
      const query = { octokit, owner: repo.owner, repo: repo.repo, number };
      const detail = kind === 'discussion'
        ? await fetchDiscussionDetail(query)
        : await fetchReferenceDetail({ ...query, includeReferences: includeReferences === true });
      return { connected: true, detail };
    }),

    reviewState: ({ session, directory, remote, project, number }: ResourceInput<'reviewState'>) => pickerRead(async () => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, { owner: project.owner, repo: project.name }, remote);
      if (!repo) throw notInProject();
      return fetchReviewState({ octokit, owner: repo.owner, repo: repo.repo, number });
    }),

    referenceStatuses: ({ context, directory, remote, pulls }: ResourceInput<'referenceStatuses'>) => pickerRead(async () => {
      const { octokit: github, rateLimit, summaries: summaryReads } = await load();
      const refs = readPullStatusRefs(pulls);
      if (!refs) throw responseError(400, { error: 'directory and pulls (owner/repo#number, comma separated) are required' });
      const refsByHost = new Map<string, NonNullable<ReturnType<typeof readPullStatusRefs>>>();
      for (const ref of refs) {
        const refHost = ref.host ? String(ref.host).toLowerCase() : GITHUB_COM;
        if (!refsByHost.has(refHost)) refsByHost.set(refHost, []);
        refsByHost.get(refHost)?.push(ref);
      }
      const { repo } = await resolveRepo(directory, remote);
      if (rateLimit.isGitHubRateLimited(repo?.host)) throw responseError(503, { error: 'GitHub rate limited' });
      if (!repo) throw notInProject();
      const checkoutHost = String(repo.host ?? '').trim().toLowerCase() || GITHUB_COM;
      const checkoutOctokit = await github.getOctokitOrNull(checkoutHost);
      if (!checkoutOctokit) return { connected: false };
      const network = requireGitHubRepoNetwork(await resolveNetwork(checkoutOctokit, directory, remote, { strictErrors: true }), repo)
        ?? [{ ...repo, source: 'origin' }];
      if (!context?.linked && !(refsByHost.get(checkoutHost) ?? []).every((ref) => network.some((entry) => sameRepository(entry, ref)))) throw notInProject();
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
          if (refHost === GITHUB_COM) throw error;
        }
      }
      return { connected: true, statuses };
    }),

    readChangeRequestHead: async ({ session, directory, remote, number }: ResourceInput<'readChangeRequestHead'>) => {
      const { octokit } = accountOf(session);
      const repo = await resolveRepoForRequest(octokit, directory, null, remote);
      let response;
      try {
        response = await octokit.rest.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: number });
      } catch (error) {
        if (errorField(error, 'status') === 404) {
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

    resolveChangeRequestSource: async ({ session, context, project, number, expectedHeadSha, requestedRemoteName }: ResourceInput<'resolveChangeRequestSource'>) => {
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
        classification: `${headOwner}/${headName}`.toLowerCase() === `${target.owner}/${target.repo}`.toLowerCase() ? 'same-repository' : 'contributor-fork',
        headSha,
        headRef: `refs/heads/${headRef}`,
        endpoint,
        requestedRemoteName,
      });
    },
  });
}
