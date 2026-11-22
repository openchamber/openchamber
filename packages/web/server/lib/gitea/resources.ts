import { documentDataUrl } from '../source-control/document-versions.js';
import { isPlainObject, isPresent, isString } from '../shared/guards.js';
import { mapLimited } from '../shared/map-limited.js';
import { changeRequestNetworkTarget } from '../source-control/repository-network.js';
import {
  asDraftTitle, asReadyTitle, branchRepoId, liveChangeRequestSummary, liveIssueSummary,
  mapGiteaChangedFile, mapGiteaCI, mapGiteaComment, mapGiteaIssue, mapGiteaPull, mapGiteaRepo,
  mapGiteaReviewBody, mapGiteaReviewComment, mapGiteaReviewerStates, mapGiteaUser, mapGiteaVerdict, splitUnifiedDiff, SUBMITTED_REVIEW_STATES,
} from './mappers.js';
import { resolveGiteaReposFromDirectory } from './repo.js';
import { readTimelineCommits, readTimelineReferences, withIssueReferences, withReferences } from './references.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { ProviderMutationContext, ProviderReadContext } from '../source-control/provider-contract.js';
import type { reviewCommentPosition } from '../source-control/review-position.js';
import type { SourceControlMutationTarget } from '@openchamber/sdk';
import type { GiteaBody, GiteaQuery, createGiteaClient } from './client.js';
import type { GiteaProject } from './mappers.js';

export interface GiteaResourceOptions {
  origin: string;
  client: ReturnType<typeof createGiteaClient>;
  resolveRepos?: typeof resolveGiteaReposFromDirectory;
  provider?: string;
  providerLabel?: string;
  sshUrl?: string | null;
}
type Input = JsonValue | undefined;
type Repository = Pick<GiteaProject, 'owner' | 'name'>;
type Repo = { raw: JsonObject & { id: number }; project: GiteaProject };
type Repos = [Repo, ...Repo[]];
type Remote = string | null | undefined;
type Selector = Repository | null | undefined;
type NetworkOptions = { requireComplete?: boolean; linked?: boolean | undefined };
type ReadOptions = { remote?: Remote; linked?: boolean | undefined; project?: Selector; includeReferences?: boolean | undefined };
type Ref = { owner: string; repo: string; number: number };
type ListOptions = {
  labels?: string[] | undefined;
  page?: number | undefined;
  remote?: Remote;
  people?: string | undefined;
  query?: string | undefined;
  state?: string | undefined;
};
type Coordinates = { [K in 'number' | 'head' | 'base' | 'headSha']?: SourceControlMutationTarget[K] | undefined };
type Context = Pick<ProviderReadContext, 'directory' | 'repositoryId' | 'bindingRevision' | 'primaryRemote'>;
type ProviderRepo = Repository & { repoId: number };
type ExistingTarget = ProviderRepo & { number: number };
type CreateTarget = ProviderRepo & { sourceRepoId: number; sourceOwner: string };
type MutationCall = { providerTarget: ExistingTarget; expectedTarget: Coordinates };
type TitleBody = { title: string; body?: string | undefined };
type WithTarget = Pick<MutationCall, 'providerTarget'>;
type WithComment = { commentId: string };
type WithBody = { body: string };
type Failure = { status?: number; response?: { status?: number } };

const plainObject = (value: Input): value is JsonObject => isPlainObject(value);
const array = (value: Input): value is JsonValue[] => Array.isArray(value);
const integer = (value: Input): value is number => Number.isInteger(value);
const hasRepoId = (value: Input): value is Repo['raw'] => plainObject(value) && integer(value.id);
const hasFields = (value: Input): value is JsonObject => value != null;
const field = (value: Input, key: string): Input => hasFields(value) ? value[key] : undefined;
const record = (value: Input): JsonObject => {
  if (!hasFields(value)) throw new TypeError('Missing response object');
  return value;
};
const last = <T>(values: [T, ...T[]]): T => values.at(-1) ?? values[0];
const primitive = (value: Input) => plainObject(value) || array(value) ? String(value) : value;
const greater = (left: Input, right: Input) => {
  const a = primitive(left);
  const b = primitive(right);
  return isString(a) && isString(b) ? a > b : Number(a) > Number(b);
};

const PAGE_LIMIT = 50;
const LIST_PAGE = 20;
const COLLECTION_MAX_ITEMS = 2000;
const STATUS_SCAN_MAX_PAGES = 5;
const LIVE_SUMMARY_CONCURRENCY = 4;
const LIST_DETAIL_CONCURRENCY = 4;
const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
interface ListStates { [state: string]: string | undefined }
const LIST_STATES: ListStates = { open: 'open', closed: 'closed', merged: 'closed', all: 'all' };

const carriesLabels = (item: Input, wanted: string[] | null | undefined) => !wanted
  || wanted.every((name) => {
    const labels = hasFields(item) ? item.labels : undefined;
    return (array(labels) ? labels : []).some((label) => hasFields(label) && label.name === name);
  });

const labelFilter = (labels: ListOptions['labels'], label: string) => {
  if (!Array.isArray(labels) || labels.length === 0) return null;
  if (labels.some((name) => !isString(name) || name.includes(','))) {
    throw Object.assign(new Error(`A ${label} label name cannot contain a comma`), {
      code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400,
    });
  }
  return labels.join(',');
};
const REVIEW_EVENTS = Object.freeze({ approve: 'APPROVED', 'request-changes': 'REQUEST_CHANGES', comment: 'COMMENT' });

const hasFailureFields = (value: unknown): value is Failure => value != null;
const statusOf = (error: Failure | null | undefined) => error?.status ?? error?.response?.status;
const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });
const malformed = (message: string) => new Error(message);
const seg = (value: string) => encodeURIComponent(value);
const repoPath = (repo: Repository) => `/repos/${seg(repo.owner)}/${seg(repo.name)}`;

function requireMapped<T>(value: T | null, message: string): T {
  if (!value) throw malformed(message);
  return value;
}

export function createGiteaResourceService({
  origin, client, resolveRepos = resolveGiteaReposFromDirectory, provider = 'gitea', providerLabel = 'Gitea', sshUrl = null,
}: GiteaResourceOptions) {
  const identity = { provider, instance: origin };
  const mismatch = (key: keyof Coordinates) => Object.assign(new Error(`${providerLabel} pull request ${key} changed`), {
    code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409,
  });
  const sameName = (a: Repository, b: Repository) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

  const showRepo = async (selector: Repository | number, remoteName?: string): Promise<Repo> => {
    const raw = integer(selector) ? await client.get(`/repositories/${selector}`) : await client.get(repoPath(selector));
    if (!hasRepoId(raw)) throw malformed(`${providerLabel} returned an invalid repository`);
    const project = requireMapped(mapGiteaRepo(raw, identity, remoteName), `${providerLabel} returned an invalid repository`);
    return { raw, project };
  };

  const resolveDirectoryRepos = async (directory: string, remote: Remote): Promise<Repos> => {
    const resolved = await resolveRepos(directory, origin, remote, { sshUrl });
    const repos: Repo[] = [];
    for (const candidate of resolved.repos) {
      const item = await showRepo({ owner: candidate.owner, name: candidate.name }, candidate.remoteName);
      if (!repos.some((known) => known.project.id === item.project.id)) repos.push(item);
    }
    const [first, ...rest] = repos;
    if (!first) throw malformed(`No ${providerLabel} repository found for the repository remotes`);
    return [first, ...rest];
  };

  const withParents = async (sources: Repos, { requireComplete = false } = {}): Promise<Repos> => {
    const targets: Repos = [...sources];
    for (const source of sources) {
      const parent = source.raw?.parent;
      if (!plainObject(parent) || !integer(parent.id) || targets.some((item) => item.raw.id === parent.id)) continue;
      try {
        targets.push(await showRepo(parent.id));
      } catch (error) {
        if (hasFailureFields(error) && statusOf(error) === 401 || requireComplete) throw error;
      }
    }
    return targets;
  };

  const network = async (directory: string, selector: Selector, remote: Remote, { requireComplete = false, linked = false }: NetworkOptions = {}): Promise<{ primary: Repo; target: Repo; targets: Repos }> => {
    if (linked && selector) {
      const target = await showRepo({ owner: selector.owner, name: selector.name });
      return { primary: target, target, targets: [target] };
    }
    const [primary] = await resolveDirectoryRepos(directory, remote);
    const targets = await withParents([primary], { requireComplete: requireComplete || Boolean(selector) });
    if (!selector) return { primary, target: targets[0], targets };
    const target = targets.find((candidate) => sameName(candidate.project, selector));
    if (!target) throw notFound(`${providerLabel} repository is outside the bound repository network`);
    return { primary, target, targets };
  };

  const reviewsPath = (providerTarget: ExistingTarget) => `${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}/reviews`;
  const readPendingReview = async (providerTarget: ExistingTarget) => {
    const [reviews, viewer] = await Promise.all([client.get(reviewsPath(providerTarget)), readCurrentLogin()]);
    if (!array(reviews)) throw malformed(`${providerLabel} returned an invalid review list`);
    return reviews.find((review): review is JsonObject => hasFields(review) && review.state === 'PENDING' && field(review.user, 'login') === viewer) ?? null;
  };
  const readPendingComments = async (providerTarget: ExistingTarget) => {
    const pending = await readPendingReview(providerTarget);
    const comments = pending ? await client.get(`${reviewsPath(providerTarget)}/${pending.id}/comments`) : [];
    if (!array(comments)) throw malformed(`${providerLabel} returned invalid review comments`);
    return comments;
  };
  const requirePendingComment = async (providerTarget: ExistingTarget, commentId: string) => {
    if (!(await readPendingComments(providerTarget)).some((comment) => String(field(comment, 'id')) === commentId)) {
      throw Object.assign(new Error('Review comment is not a draft of yours on this pull request'), { code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', status: 409 });
    }
  };
  const commentIssue = (comment: Input) => {
    const issueUrl = field(comment, 'issue_url');
    const href = isString(issueUrl) && issueUrl !== '' ? issueUrl : field(comment, 'pull_request_url');
    if (!isString(href)) return null;
    let url;
    try { url = new URL(href); } catch { return null; }
    if (url.origin !== origin) return null;
    const match = /^\/([^/]+)\/([^/]+)\/(?:issues|pulls)\/(\d+)\/?$/.exec(url.pathname);
    if (!match) return null;
    try {
      return { owner: decodeURIComponent(match[1] ?? ''), name: decodeURIComponent(match[2] ?? ''), number: Number(match[3]) };
    } catch {
      return null;
    }
  };
  const requireIssueComment = async (providerTarget: ExistingTarget, expectedTarget: Coordinates, commentId: string) => {
    const comment = await client.get(`${repoPath(targetRepo(providerTarget))}/issues/comments/${seg(commentId)}`);
    const issue = commentIssue(comment);
    if (!issue || issue.number !== expectedTarget.number || !sameName(issue, targetRepo(providerTarget))) {
      throw Object.assign(new Error(`Comment is not on this ${providerLabel} issue`), {
        code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', status: 409,
      });
    }
    return comment;
  };
  const reviewPerson = (user: Input) => (hasFields(user) && isString(user.login) ? { login: user.login, avatarUrl: isString(user.avatar_url) ? user.avatar_url : undefined } : null);
  const reviewCommentAt = (comment: JsonObject) => (Number(comment?.position) > 0
    ? { path: comment.path, side: 'new', line: comment.position, startLine: null }
    : { path: comment?.path, side: 'old', line: comment?.original_position ?? null, startLine: null });

  let currentLogin: Promise<string> | null = null;
  const readCurrentLogin = () => {
    currentLogin ??= client.get('/user').then((user) => {
      if (!plainObject(user) || !isString(user.login) || !user.login) throw malformed(`${providerLabel} returned an invalid current user`);
      return user.login;
    });
    return currentLogin;
  };

  const requirePull = (raw: Input, project: GiteaProject) => requireMapped(mapGiteaPull(raw, identity, project), `${providerLabel} returned an invalid pull request`);
  const requireIssue = (raw: Input, project: GiteaProject) => {
    if (plainObject(raw) && raw.pull_request != null) throw notFound(`${providerLabel} issue #${raw.number} is a pull request`);
    return requireMapped(mapGiteaIssue(raw, identity, project), `${providerLabel} returned an invalid issue`);
  };

  const readCI = async (repo: Repository, sha: Input) => {
    if (!isString(sha) || !sha) return null;
    try {
      return mapGiteaCI(await client.get(`${repoPath(repo)}/commits/${seg(sha)}/status`, { limit: PAGE_LIMIT }), identity);
    } catch (error) {
      if (hasFailureFields(error) && statusOf(error) === 401) throw error;
      return null;
    }
  };

  const findPull = async (directory: string, number: number, selector: Selector, { remote, linked }: ReadOptions = {}) => {
    const net = await network(directory, selector, remote, { requireComplete: true, linked });
    const candidates = selector ? [net.target] : net.targets;
    for (const target of candidates) {
      let raw;
      try {
        raw = await client.get(`${repoPath(target.project)}/pulls/${number}`);
      } catch (error) {
        if (hasFailureFields(error) && statusOf(error) === 404) continue;
        throw error;
      }
      if (changeRequestNetworkTarget(net.targets, branchRepoId(field(raw, 'base')), (candidate, id) => candidate.raw.id === id) !== target) {
        throw malformed(`${providerLabel} returned a pull request of another repository`);
      }
      return { target, raw: record(raw), request: requirePull(raw, target.project), net };
    }
    throw notFound(`${providerLabel} pull request #${number} was not found`);
  };

  const headProjectOf = async (raw: JsonObject, target: Repo, targets: Repos) => {
    const headId = branchRepoId(raw.head);
    if (headId === null || headId === target.raw.id) return null;
    const known = targets.find((candidate) => candidate.raw.id === headId);
    if (known) return known.project;
    const embedded = mapGiteaRepo(field(raw.head, 'repo'), identity);
    return embedded ?? (await showRepo(headId)).project;
  };

  const findBranchPull = async (target: Repo, branch: string, sources: Repos) => {
    const sourceIds: Pick<ReadonlySet<number | null>, 'has'> = new Set(sources.map((source) => source.raw.id));
    const matches = (raw: Input): raw is JsonObject => plainObject(raw) && field(raw.head, 'ref') === branch
      && sourceIds.has(branchRepoId(raw.head)) && branchRepoId(raw.base) === target.raw.id;
    const closed: JsonObject[] = [];
    const base = target.project.defaultBranch;
    if (base) {
      for (const source of sources) {
        const head = source.raw.id === target.raw.id ? seg(branch) : `${seg(source.project.owner)}:${seg(branch)}`;
        try {
          const raw = await client.get(`${repoPath(target.project)}/pulls/${seg(base)}/${head}`);
          if (matches(raw)) {
            if (raw.state === 'open') return { raw, history: null };
            closed.push(raw);
          }
        } catch (error) {
          if (!hasFailureFields(error) || statusOf(error) !== 404) throw error;
        }
      }
    }
    for (let page = 1; page <= STATUS_SCAN_MAX_PAGES; page += 1) {
      const result = await client.page(`${repoPath(target.project)}/pulls`, { state: 'open', sort: 'recentupdate' }, { page, limit: PAGE_LIMIT });
      const raw = result.items.find(matches);
      if (raw) return { raw, history: null };
      if (result.hasMore) continue;
      const recent = await client.page(`${repoPath(target.project)}/pulls`, { state: 'closed', sort: 'recentupdate' }, { page: 1, limit: PAGE_LIMIT });
      closed.push(...recent.items.filter(matches));
      const history = closed.reduce<JsonObject | null>((newest, candidate) => (!newest || greater(candidate.number, newest.number) ? candidate : newest), null);
      return { raw: null, history };
    }
    throw malformed(`${providerLabel} repository has more open pull requests than OpenChamber scans for a branch`);
  };

  const compactProject = (project: GiteaProject) => ({ id: project.id, owner: project.owner, name: project.name });
  const mutationTarget = (context: Context, project: GiteaProject, request: Coordinates = {}) => {
    const target: SourceControlMutationTarget = {
      repositoryId: context.repositoryId,
      bindingRevision: context.bindingRevision,
      primaryRemote: context.primaryRemote,
      project: compactProject(project),
    };
    for (const key of ['number', 'head', 'base', 'headSha'] as const) {
      if (request[key] !== undefined) Object.assign(target, { [key]: request[key] });
    }
    return target;
  };
  const requireExpected = (expected: Coordinates, actual: Coordinates) => {
    for (const key of ['number', 'head', 'base', 'headSha'] as const) {
      if (expected[key] !== undefined && expected[key] !== actual[key]) throw mismatch(key);
    }
  };
  const targetRepo = (providerTarget: Repository) => ({ owner: providerTarget.owner, name: providerTarget.name });
  const readTargetPull = async (providerTarget: ExistingTarget) => {
    const raw = await client.get(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`);
    if (branchRepoId(field(raw, 'base')) !== Number(providerTarget.repoId)) throw malformed(`${providerLabel} returned a pull request outside the resolved mutation target`);
    return record(raw);
  };
  const projectOfTarget = (providerTarget: ProviderRepo) => ({
    ...identity, id: String(providerTarget.repoId), owner: providerTarget.owner, name: providerTarget.name, url: `${origin}/${providerTarget.owner}/${providerTarget.name}`,
  });

  const labelIds = async (providerTarget: ExistingTarget, names: string[]) => {
    if (names.length === 0) return [];
    const labels = await client.collection(`${repoPath(targetRepo(providerTarget))}/labels`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS });
    return names.map((name) => {
      const label = labels.find((candidate): candidate is JsonObject & { id: number } => plainObject(candidate) && candidate.name === name && integer(candidate.id));
      if (!label) throw Object.assign(new Error(`${providerLabel} label "${name}" does not exist in this repository`), { status: 422 });
      return label.id;
    });
  };

  const collaborators = (repo: Repository) => client.collection(`${repoPath(repo)}/collaborators`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS });

  const pullsOfIssues = async (repo: Repo, issues: JsonValue[], { mergedOnly = false } = {}) => {
    const pulls = await mapLimited(issues, LIST_DETAIL_CONCURRENCY, (issue) => client.get(`${repoPath(repo.project)}/pulls/${record(issue).number}`));
    return pulls.filter((raw) => !mergedOnly || field(raw, 'merged') === true).map((raw) => requirePull(raw, repo.project));
  };

  const readIssueComments = async (repo: Repository, number: number) => {
    const comments = await client.get(`${repoPath(repo)}/issues/${number}/comments`);
    if (!array(comments)) throw malformed(`${providerLabel} returned an invalid comment list`);
    return comments;
  };

  return {
    async changeRequestStatus(directory: string, branch: string, remote?: Remote) {
      const sources = await resolveDirectoryRepos(directory, remote);
      const targets = await withParents(sources, { requireComplete: true });
      const first = sources[0];
      let selected = null;
      let history = null;
      for (const target of targets) {
        const found = await findBranchPull(target, branch, sources);
        if (found.raw) {
          selected = { target, raw: found.raw };
          break;
        }
        if (!history && found.history && branchRepoId(found.history.head) === first.raw.id) history = { target, raw: found.history };
      }
      selected ??= history;
      if (!selected) {
        return {
          identity, project: first.project, branch, changeRequest: null,
          resolvedRemoteName: first.project.remoteName ?? null, defaultBranch: first.project.defaultBranch ?? null,
        };
      }
      const request = requirePull(selected.raw, selected.target.project);
      return {
        identity,
        project: selected.target.project,
        branch,
        changeRequest: request,
        ci: await readCI(selected.target.project, request.headSha),
        canMerge: request.state === 'open' && request.mergeable === true,
        resolvedRemoteName: first.project.remoteName ?? null,
        defaultBranch: selected.target.project.defaultBranch ?? null,
      };
    },

    async listChangeRequests(directory: string, options: ListOptions = {}) {
      const labels = labelFilter(options.labels, providerLabel);
      const wanted = labels === null ? null : options.labels;
      const page = options.page ?? 1;
      const { targets } = await network(directory, null, options.remote);
      const target = last(targets);
      const people = options.people ?? 'any';
      const state = options.state ?? 'open';
      if (!labels && !options.query && people === 'any' && state !== 'merged') {
        const result = await client.page(`${repoPath(target.project)}/pulls`, { state: LIST_STATES[state] ?? 'open', sort: 'recentupdate' }, { page, limit: LIST_PAGE });
        return { items: result.items.map((raw) => requirePull(raw, target.project)), page, hasMore: result.hasMore };
      }
      let result;
      if (people === 'reviewRequested') {
        const searchQuery: GiteaQuery = {
          type: 'pulls', state: LIST_STATES[state] ?? 'open', q: options.query, owner: target.project.owner, review_requested: true,
        };
        if (labels) searchQuery.labels = labels;
        result = await client.page('/repos/issues/search', searchQuery, { page, limit: LIST_PAGE });
        result.items = result.items.filter((item) => {
          const repository = field(item, 'repository');
          return plainObject(repository) && Number(repository.id) === target.raw.id && carriesLabels(item, wanted);
        });
      } else {
        const query: GiteaQuery = { type: 'pulls', state: LIST_STATES[state] ?? 'open', q: options.query };
        if (labels) query.labels = labels;
        if (people === 'created') query.created_by = await readCurrentLogin();
        if (people === 'assigned') query.assigned_by = await readCurrentLogin();
        result = await client.page(`${repoPath(target.project)}/issues`, query, { page, limit: LIST_PAGE });
        result.items = result.items.filter((item) => carriesLabels(item, wanted));
      }
      const items = await pullsOfIssues(target, result.items, { mergedOnly: state === 'merged' });
      return { items, page, hasMore: result.hasMore };
    },

    async changeRequestContext(directory: string, number: number, options: ReadOptions & { includeDiff?: boolean | undefined; includeTimeline?: boolean | undefined } = {}) {
      const { target, raw, request, net } = await findPull(directory, number, options.project, { remote: options.remote, linked: options.linked });
      const repo = repoPath(target.project);
      const [comments, reviews, diffText, changedFiles, ci, headProject, commits, references, viewer] = await Promise.all([
        readIssueComments(target.project, number),
        client.collection(`${repo}/pulls/${number}/reviews`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS, message: `${providerLabel} pull request has more reviews than OpenChamber reads` }),
        options.includeDiff ? client.text(`${repo}/pulls/${number}.diff`) : Promise.resolve(''),
        options.includeDiff
          ? client.collection(`${repo}/pulls/${number}/files`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS, message: `${providerLabel} pull request has more changed files than OpenChamber reads` })
          : Promise.resolve([]),
        readCI(target.project, request.headSha),
        headProjectOf(raw, target, net.targets),
        options.includeTimeline ? readTimelineCommits(client, repo, number) : Promise.resolve(null),
        options.includeTimeline && options.includeReferences ? readTimelineReferences(client, repo, number) : Promise.resolve([]),
        readCurrentLogin().catch(() => null),
      ]);
      const reviewsWithComments = reviews.filter((review): review is JsonObject => plainObject(review) && integer(review.id) && Number(review.comments_count) > 0);
      const reviewComments = (await mapLimited(reviewsWithComments, LIST_DETAIL_CONCURRENCY, (review) => client.get(`${repo}/pulls/${number}/reviews/${record(review).id}/comments`)))
        .flatMap((list) => (array(list) ? list : []))
        .flatMap((comment) => {
          const mapped = mapGiteaReviewComment(comment, identity, request.url);
          return mapped ? [mapped] : [];
        });
      const issueComments = [
        ...comments.flatMap((comment) => {
          const mapped = mapGiteaComment(comment, identity, request.url, viewer);
          if (!mapped) throw malformed(`${providerLabel} returned an invalid pull request comment`);
          return [mapped];
        }),
        ...reviews.flatMap((review) => {
          const mapped = mapGiteaReviewBody(review, identity, request.url);
          return mapped ? [mapped] : [];
        }),
      ].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
      const patches = splitUnifiedDiff(diffText);
      const files = changedFiles.map((file) => {
        const mapped = requireMapped(mapGiteaChangedFile(file), `${providerLabel} returned an invalid changed file`);
        const patch = patches.get(mapped.path);
        if (patch) mapped.patch = patch;
        return mapped;
      });
      if (headProject) request.headProject = headProject;
      const context = {
        identity,
        project: target.project,
        changeRequest: request,
        issueComments,
        reviewComments,
        files,
        diff: diffText,
        ci,
      };
      if (!options.includeTimeline || !commits) return context;
      return {
        ...withReferences(context, references),
        commits: commits.items,
        commitsComplete: commits.complete,
        reviewers: (array(raw.requested_reviewers) ? raw.requested_reviewers : []).flatMap((user) => {
          const mapped = mapGiteaUser(user, identity);
          return mapped ? [mapped] : [];
        }),
        reviewerStates: mapGiteaReviewerStates(reviews, raw.requested_reviewers, identity),
        verdicts: reviews.flatMap((review) => {
          const mapped = mapGiteaVerdict(review, identity, request.url);
          return mapped ? [mapped] : [];
        }),
      };
    },

    async listIssues(directory: string, options: ListOptions = {}) {
      const labels = labelFilter(options.labels, providerLabel);
      const wanted = labels === null ? null : options.labels;
      const page = options.page ?? 1;
      const { primary } = await network(directory, null, options.remote);
      const query: GiteaQuery = { type: 'issues', state: LIST_STATES[String(options.state)] ?? 'open', q: options.query };
      if (labels) query.labels = labels;
      if (options.people === 'created') query.created_by = await readCurrentLogin();
      if (options.people === 'assigned') query.assigned_by = await readCurrentLogin();
      const result = await client.page(`${repoPath(primary.project)}/issues`, query, { page, limit: LIST_PAGE });
      const items = result.items
        .filter((raw) => carriesLabels(raw, wanted))
        .flatMap((raw) => (field(raw, 'pull_request') != null ? [] : [requireIssue(raw, primary.project)]));
      return { items, page, hasMore: result.hasMore };
    },

    async getIssue(directory: string, number: number, selector?: Selector, remote?: Remote, { linked, includeReferences }: ReadOptions = {}) {
      const { target } = await network(directory, selector, remote, { linked });
      const issue = requireIssue(await client.get(`${repoPath(target.project)}/issues/${number}`), target.project);
      return includeReferences ? withIssueReferences(client, repoPath(target.project), issue, number) : issue;
    },

    async issueComments(directory: string, number: number, selector?: Selector, remote?: Remote, { linked }: ReadOptions = {}) {
      const { target } = await network(directory, selector, remote, { linked });
      const issue = requireIssue(await client.get(`${repoPath(target.project)}/issues/${number}`), target.project);
      const [comments, viewer] = await Promise.all([
        readIssueComments(target.project, number),
        readCurrentLogin().catch(() => null),
      ]);
      return comments.map((comment) => requireMapped(mapGiteaComment(comment, identity, issue.url, viewer), `${providerLabel} returned an invalid issue comment`));
    },

    async projectUpstream(directory: string, remote?: Remote) {
      const { primary, targets } = await network(directory, null, remote);
      const parentId = field(primary.raw.parent, 'id');
      if (!integer(parentId)) return { identity, isFork: false, upstream: null };
      const parent = targets.find((candidate) => candidate.raw.id === parentId) ?? await showRepo(parentId);
      return { identity, isFork: true, upstream: parent.project };
    },

    async projectBranches(directory: string, selector?: Selector, remote?: Remote) {
      const { target } = await network(directory, selector, remote, { requireComplete: true });
      const branches = await client.collection(`${repoPath(target.project)}/branches`, {}, {
        limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS, message: `${providerLabel} repository has more branches than OpenChamber reads`,
      });
      return branches.map((branch) => {
        const name = field(branch, 'name');
        if (!isString(name) || !name) throw malformed(`${providerLabel} returned an invalid branch`);
        return name;
      });
    },

    async listLabels(directory: string, selector?: Selector, remote?: Remote) {
      const { target } = await network(directory, selector, remote);
      const labels = await client.collection(`${repoPath(target.project)}/labels`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS });
      return labels.flatMap((label) => {
        if (!plainObject(label) || !isString(label.name) || !label.name) return [];
        return [isString(label.color) && label.color ? { name: label.name, color: label.color.replace(/^#/, '') } : { name: label.name }];
      });
    },

    async listReviewerCandidates(directory: string, selector?: Selector, remote?: Remote) {
      const { target } = await network(directory, selector, remote);
      return (await collaborators(target.project)).flatMap((user) => {
        const mapped = mapGiteaUser(user, identity);
        if (!mapped) return [];
        return [mapped.avatarUrl ? { id: mapped.id, login: mapped.username, avatarUrl: mapped.avatarUrl } : { id: mapped.id, login: mapped.username }];
      });
    },

    async changeRequestPatch(directory: string, number: number, { project, remote, linked }: ReadOptions = {}) {
      const { target } = await findPull(directory, number, project, { remote, linked });
      const patch = await client.text(`${repoPath(target.project)}/pulls/${number}.diff`);
      if (!isString(patch)) throw malformed(`${providerLabel} returned an invalid pull request diff`);
      return { patch, meta: { owner: target.project.owner, repo: target.project.name, number } };
    },

    async changeRequestFileContents(directory: string, number: number, { project, remote, path, previousPath, status, binary, linked }: ReadOptions & {
      path: string; previousPath?: string | undefined; status?: string | undefined; binary?: boolean | undefined;
    }) {
      const { target, raw } = await findPull(directory, number, project, { remote, linked });
      const baseSha = raw?.merge_base;
      const headSha = field(raw.head, 'sha');
      if (!COMMIT_SHA.test(String(baseSha)) || !COMMIT_SHA.test(String(headSha))) throw malformed(`${providerLabel} returned invalid pull request refs`);
      const readFile = async (filePath: string, ref: Input) => {
        const rawPath = `${repoPath(target.project)}/raw/${filePath.split('/').map(seg).join('/')}`;
        if (binary) {
          const bytes = await client.bytes(rawPath, { ref });
          if (bytes === null) throw new TypeError('Missing file bytes');
          return documentDataUrl(bytes);
        }
        const content = await client.text(rawPath, { ref });
        if (!isString(content)) throw malformed(`${providerLabel} returned invalid file contents`);
        if (Buffer.byteLength(content) > MAX_FULL_FILE_BYTES) {
          throw Object.assign(new Error('This file is too large to show in full'), { status: 413, code: 'file-too-large' });
        }
        return content;
      };
      const [original, modified] = await Promise.all([
        status === 'A' ? '' : readFile(previousPath || path, baseSha),
        status === 'D' ? '' : readFile(path, headSha),
      ]);
      return { original, modified };
    },

    async liveSummaries({ refs = [], issueRefs = [] }: { refs?: Ref[] | undefined; issueRefs?: Ref[] | undefined }) {
      const read = async <T>(ref: Ref | undefined, task: (repo: string) => Promise<T>) => {
        try {
          if (!ref) throw new TypeError('Missing repository reference');
          return await task(repoPath({ owner: ref.owner, name: ref.repo }));
        } catch (error) {
          if (hasFailureFields(error) && statusOf(error) === 401) throw error;
          return null;
        }
      };
      const [summaries, issueSummaries] = await Promise.all([
        mapLimited(refs, LIVE_SUMMARY_CONCURRENCY, (ref) => read(ref, async (repo) => {
          if (!ref) return null;
          const raw = await client.get(`${repo}/pulls/${ref.number}`);
          const open = field(raw, 'state') === 'open' && field(raw, 'merged') !== true;
          const ci = open ? await readCI({ owner: ref.owner, name: ref.repo }, field(field(raw, 'head'), 'sha')) : null;
          return liveChangeRequestSummary(ref, raw, ci);
        })),
        mapLimited(issueRefs, LIVE_SUMMARY_CONCURRENCY, (ref) => read(ref, async (repo) => ref ? liveIssueSummary(ref, await client.get(`${repo}/issues/${ref.number}`)) : null)),
      ]);
      return { summaries: summaries.filter(isPresent), issueSummaries: issueSummaries.filter(isPresent) };
    },

    async findChangeRequest(directory: string, number: number, selector?: Selector, remote?: Remote) {
      const { target, raw, request, net } = await findPull(directory, number, selector, { remote });
      return { target, request, headProject: await headProjectOf(raw, target, net.targets) };
    },

    async resolveCreateMutation(context: Context, expected: ProviderMutationContext['target'], options: { remote?: Remote; headRemote?: Remote } = {}) {
      if (options.remote !== undefined && options.remote !== context.primaryRemote) {
        throw Object.assign(new Error(`${providerLabel} mutation remote does not match the bound primary remote`), { code: 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH', status: 409 });
      }
      const headRemote = options.headRemote ?? context.primaryRemote;
      const net = await network(context.directory, expected.project, context.primaryRemote, { requireComplete: true });
      let source = net.primary;
      if (headRemote !== context.primaryRemote) {
        [source] = await resolveDirectoryRepos(context.directory, headRemote);
        if (!net.targets.some((candidate) => candidate.project.id === source.project.id)) {
          throw Object.assign(new Error(`${providerLabel} mutation head remote is outside the bound repository network`), { code: 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH', status: 409 });
        }
      }
      return {
        providerTarget: {
          sourceRepoId: source.raw.id, sourceOwner: source.project.owner,
          repoId: net.target.raw.id, owner: net.target.project.owner, name: net.target.project.name,
        },
        target: mutationTarget(context, net.target.project, { head: expected.head, base: expected.base }),
      };
    },

    async resolveChangeRequestMutation(context: Context, expected: ProviderMutationContext['target'] & { number: number }) {
      const { target, request } = await findPull(context.directory, expected.number, expected.project, { remote: context.primaryRemote });
      requireExpected(expected, request);
      return {
        providerTarget: { repoId: Number(target.project.id), owner: target.project.owner, name: target.project.name, number: request.number },
        target: mutationTarget(context, target.project, request),
      };
    },

    async resolveIssueMutation(context: Context, expected: ProviderMutationContext['target'] & { number: number }) {
      if (expected.head !== undefined || expected.base !== undefined || expected.headSha !== undefined) {
        throw Object.assign(new Error(`${providerLabel} issue target is invalid`), { code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400 });
      }
      const { target } = await network(context.directory, expected.project, context.primaryRemote);
      const issue = requireIssue(await client.get(`${repoPath(target.project)}/issues/${expected.number}`), target.project);
      return {
        providerTarget: { repoId: Number(target.project.id), owner: target.project.owner, name: target.project.name, number: issue.number },
        target: mutationTarget(context, target.project, { number: issue.number }),
      };
    },

    async createChangeRequest({ providerTarget, title, body, draft, head, base, expectedTarget }: TitleBody & {
      providerTarget: CreateTarget; draft: boolean; head: string; base: string; expectedTarget: Coordinates;
    }) {
      const fork = providerTarget.sourceRepoId !== providerTarget.repoId;
      const payload: GiteaBody = { head: fork ? `${providerTarget.sourceOwner}:${head}` : head, base, title: draft ? asDraftTitle(title) : title };
      if (body !== undefined) payload.body = body;
      const raw = await client.post(`${repoPath(targetRepo(providerTarget))}/pulls`, payload);
      if (branchRepoId(field(raw, 'base')) !== providerTarget.repoId || branchRepoId(field(raw, 'head')) !== providerTarget.sourceRepoId) {
        throw malformed(`${providerLabel} returned a pull request outside the resolved mutation target`);
      }
      const request = requirePull(raw, projectOfTarget(providerTarget));
      requireExpected({ head: expectedTarget.head, base: expectedTarget.base }, request);
      return { number: request.number };
    },

    async reconcileCreateMutation(providerTarget: CreateTarget, target: Coordinates) {
      const matches: JsonObject[] = [];
      for (let page = 1; page <= STATUS_SCAN_MAX_PAGES; page += 1) {
        const result = await client.page(`${repoPath(targetRepo(providerTarget))}/pulls`, { state: 'all', sort: 'recentupdate' }, { page, limit: PAGE_LIMIT });
        matches.push(...result.items.filter((raw): raw is JsonObject => hasFields(raw) && field(raw.head, 'ref') === target.head && field(raw.base, 'ref') === target.base
          && branchRepoId(raw.head) === providerTarget.sourceRepoId && branchRepoId(raw.base) === providerTarget.repoId));
        if (!result.hasMore) {
          return matches.length === 1 ? { state: 'succeeded', result: { number: record(matches[0]).number } } : { state: 'outcome-unknown' };
        }
      }
      return { state: 'outcome-unknown' };
    },

    async updateChangeRequest({ providerTarget, title, body, expectedTarget }: MutationCall & TitleBody) {
      const payload: GiteaBody = { title };
      if (body !== undefined) payload.body = body;
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`, payload);
      if (branchRepoId(field(raw, 'base')) !== providerTarget.repoId) throw malformed(`${providerLabel} returned a pull request outside the resolved mutation target`);
      requireExpected({ number: expectedTarget.number }, requirePull(raw, projectOfTarget(providerTarget)));
      return {};
    },

    async updateIssue({ providerTarget, expectedTarget, title, body }: MutationCall & TitleBody) {
      const payload: GiteaBody = { title };
      if (body !== undefined) payload.body = body;
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`, payload);
      const issue = requireIssue(raw, projectOfTarget(providerTarget));
      requireExpected({ number: expectedTarget.number }, issue);
      if (issue.title !== title || (body !== undefined && (issue.body ?? '') !== body)) {
        throw malformed(`${providerLabel} returned an unexpected issue title or body`);
      }
      return {};
    },

    async mergeChangeRequest({ providerTarget, method, expectedTarget }: MutationCall & { method: string }) {
      const payload: GiteaBody = { Do: method };
      if (expectedTarget.headSha) payload.head_commit_id = expectedTarget.headSha;
      try {
        await client.post(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}/merge`, payload);
      } catch (error) {
        if (hasFailureFields(error) && (statusOf(error) === 409 || statusOf(error) === 405) && expectedTarget.headSha) {
          const current = await readTargetPull(providerTarget).catch(() => null);
          if (current && field(current.head, 'sha') !== expectedTarget.headSha) throw mismatch('headSha');
        }
        throw error;
      }
      const raw = await readTargetPull(providerTarget);
      return { merged: raw.merged === true };
    },

    async readyChangeRequest({ providerTarget, expectedTarget }: MutationCall) {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      requireExpected({ number: expectedTarget.number, headSha: expectedTarget.headSha }, current);
      if (!current.draft) return { ready: true };
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`, { title: asReadyTitle(current.title) });
      const request = requirePull(raw, projectOfTarget(providerTarget));
      return { ready: !request.draft };
    },

    async draftChangeRequest({ providerTarget, expectedTarget }: MutationCall) {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      requireExpected({ number: expectedTarget.number, headSha: expectedTarget.headSha }, current);
      if (current.draft) return { draft: true };
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`, { title: asDraftTitle(current.title) });
      const request = requirePull(raw, projectOfTarget(providerTarget));
      return { draft: request.draft };
    },

    async setState({ providerTarget, state, kind }: WithTarget & { state: string; kind: string }) {
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`, { state });
      if (!plainObject(raw) || raw.number !== providerTarget.number || raw.state !== state) {
        throw malformed(`${providerLabel} returned an unexpected ${kind.startsWith('issue') ? 'issue' : 'pull request'} state`);
      }
      return { state };
    },

    async reconcileStateMutation(providerTarget: ExistingTarget, kind: string, state: string) {
      const repo = repoPath(targetRepo(providerTarget));
      const raw = kind === 'issue-state'
        ? await client.get(`${repo}/issues/${providerTarget.number}`)
        : await client.get(`${repo}/pulls/${providerTarget.number}`);
      const current = field(raw, 'merged') === true ? 'merged' : field(raw, 'state');
      if (current === state) return { state: 'succeeded', result: { state } };
      if (current === 'open' || current === 'closed') return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
      return { state: 'outcome-unknown' };
    },

    async reconcileIssueUpdate(providerTarget: ExistingTarget, title: string, body?: string) {
      const issue = requireIssue(await client.get(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`), projectOfTarget(providerTarget));
      const bodyMatches = body === undefined || (issue.body ?? '') === body;
      if (issue.title === title && bodyMatches) return { state: 'succeeded', result: {} };
      return { state: 'outcome-unknown' };
    },

    async reconcileIssueCommentUpdate(providerTarget: ExistingTarget, commentId: string, body: string) {
      const comment = await client.get(`${repoPath(targetRepo(providerTarget))}/issues/comments/${seg(commentId)}`)
        .then((value) => value, () => null);
      return plainObject(comment) && comment.body === body
        ? { state: 'succeeded', result: {} }
        : { state: 'outcome-unknown' };
    },

    async reconcileIssueCommentDelete(providerTarget: ExistingTarget, commentId: string) {
      const gone = await client.get(`${repoPath(targetRepo(providerTarget))}/issues/comments/${seg(commentId)}`)
        .then(() => false, (error: Failure | null | undefined) => statusOf(error) === 404);
      return gone ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async reconcileChangeRequestMutation(providerTarget: ExistingTarget, kind: string) {
      if (kind === 'change-request-update') return { state: 'outcome-unknown' };
      const request = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      if (kind === 'change-request-merge') {
        if (request.state === 'merged') return { state: 'succeeded', result: { merged: true } };
        return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
      }
      if (kind === 'change-request-ready') {
        if (!request.draft) return { state: 'succeeded', result: { ready: true } };
        return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
      }
      if (kind === 'change-request-draft') {
        if (request.draft) return { state: 'succeeded', result: { draft: true } };
        return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
      }
      return { state: 'outcome-unknown' };
    },

    async setLabels({ providerTarget, labels }: WithTarget & { labels: string[] }) {
      const ids = await labelIds(providerTarget, labels);
      const raw = await client.put(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}/labels`, { labels: ids });
      if (!Array.isArray(raw)) throw malformed(`${providerLabel} returned an invalid label list`);
      return {};
    },

    async setReviewers({ providerTarget, reviewers }: WithTarget & { reviewers: string[] }) {
      const repo = targetRepo(providerTarget);
      const raw = await readTargetPull(providerTarget);
      const reviewer = (user: Input): user is JsonObject & { id: number; login: string } => hasFields(user) && integer(user.id) && isString(user.login);
      const current = (array(raw.requested_reviewers) ? raw.requested_reviewers : []).filter(reviewer);
      const known = new Map([...current, ...(await collaborators(repo))].filter(reviewer)
        .map((user) => [String(user.id), user.login]));
      const wanted = reviewers.map((id) => {
        const login = known.get(id);
        if (!login) throw Object.assign(new Error(`${providerLabel} user ${id} cannot review in this repository`), { status: 422 });
        return login;
      });
      const currentLogins = current.map((user) => user.login);
      const add = wanted.filter((login) => !currentLogins.includes(login));
      const remove = currentLogins.filter((login) => !wanted.includes(login));
      if (remove.length) {
        const reviews = await client.collection(`${repoPath(repo)}/pulls/${providerTarget.number}/reviews`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS, message: `${providerLabel} pull request has more reviews than OpenChamber reads` });
        const reviewed = remove.filter((login) => reviews.some((review) => plainObject(review) && field(review.user, 'login') === login
          && SUBMITTED_REVIEW_STATES.has(review.state) && review.dismissed !== true));
        if (reviewed.length) {
          throw Object.assign(new Error(`${reviewed.join(', ')} already reviewed this pull request; ${providerLabel} keeps reviewers who reviewed`), {
            status: 400, code: 'GITEA_REVIEWER_HAS_REVIEWED',
          });
        }
      }
      const path = `${repoPath(repo)}/pulls/${providerTarget.number}/requested_reviewers`;
      if (add.length) await client.post(path, { reviewers: add });
      if (remove.length) await client.delete(path, { reviewers: remove });
      return {};
    },

    async reconcileSetMutation(providerTarget: ExistingTarget, kind: string, names: string[]) {
      const repo = repoPath(targetRepo(providerTarget));
      const raw = kind === 'issue-labels'
        ? await client.get(`${repo}/issues/${providerTarget.number}`)
        : await client.get(`${repo}/pulls/${providerTarget.number}`);
      const reviewers = plainObject(raw) && raw.requested_reviewers === null ? [] : field(raw, 'requested_reviewers');
      const labels = field(raw, 'labels');
      const current = kind === 'change-request-reviewers'
        ? (array(reviewers) ? reviewers.map((user) => String(field(user, 'id'))) : null)
        : (array(labels) ? labels.map((label) => field(label, 'name')) : null);
      const wanted: readonly Input[] = names;
      if (!current || current.length !== names.length || !current.every((entry) => wanted.includes(entry))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    async comment({ providerTarget, body }: WithTarget & WithBody) {
      const raw = await client.post(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}/comments`, { body });
      if (!plainObject(raw) || !integer(raw.id)) throw malformed(`${providerLabel} returned an invalid comment`);
      return {};
    },

    async updateIssueComment({ providerTarget, expectedTarget, commentId, body }: MutationCall & WithComment & WithBody) {
      await requireIssueComment(providerTarget, expectedTarget, commentId);
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/issues/comments/${seg(commentId)}`, { body });
      if (!plainObject(raw) || raw.body !== body) throw malformed(`${providerLabel} returned an unexpected comment body`);
      return {};
    },

    async deleteIssueComment({ providerTarget, expectedTarget, commentId }: MutationCall & WithComment) {
      await requireIssueComment(providerTarget, expectedTarget, commentId);
      const path = `${repoPath(targetRepo(providerTarget))}/issues/comments/${seg(commentId)}`;
      await client.delete(path);
      const gone = await client.get(path).then(() => false, (error: Failure | null | undefined) => {
        if (statusOf(error) === 404) return true;
        throw error;
      });
      if (!gone) throw new Error(`${providerLabel} kept a comment it was asked to delete`);
      return {};
    },

    async reviewChangeRequest({ providerTarget, verdict, body, expectedTarget }: MutationCall & { verdict: keyof typeof REVIEW_EVENTS; body?: string | undefined }) {
      const current = await readTargetPull(providerTarget);
      if (field(current.head, 'sha') !== expectedTarget.headSha) throw mismatch('headSha');
      const event = REVIEW_EVENTS[verdict];
      const reviews = reviewsPath(providerTarget);
      const pending = await readPendingReview(providerTarget);
      if (!pending && verdict === 'comment' && body === undefined) {
        throw Object.assign(new Error('A review with no comments needs text'), { status: 422 });
      }
      if (pending && verdict !== 'comment' && pending.commit_id !== expectedTarget.headSha) {
        throw Object.assign(new Error('This review draft was started on an older commit. Send it as a comment, then give your verdict.'), { status: 409 });
      }
      const raw = pending
        ? await client.post(`${reviews}/${pending.id}`, { event, body: body ?? '' })
        : await client.post(reviews, { event, commit_id: expectedTarget.headSha, body: body ?? '' });
      if (!plainObject(raw) || !integer(raw.id)) throw malformed(`${providerLabel} returned an invalid review`);
      return { commented: body !== undefined };
    },

    async reviewState(directory: string, number: number, project?: Selector, remote?: Remote) {
      const { target, raw } = await findPull(directory, number, project, { remote });
      const repo = repoPath(target.project);
      const [reviews, viewer] = await Promise.all([client.get(`${repo}/pulls/${number}/reviews`), readCurrentLogin()]);
      if (!array(reviews)) throw malformed(`${providerLabel} returned an invalid review list`);
      const headSha = field(raw.head, 'sha');
      const commentsOf = (review: Input) => client.get(`${repo}/pulls/${number}/reviews/${record(review).id}/comments`).then((value) => {
        if (!array(value)) throw malformed(`${providerLabel} returned invalid review comments`);
        return value;
      });
      const pending = reviews.find((review): review is JsonObject => hasFields(review) && review.state === 'PENDING' && field(review.user, 'login') === viewer) ?? null;
      const published = reviews.filter((review) => field(review, 'state') !== 'PENDING' && Number(field(review, 'comments_count')) > 0 && field(review, 'stale') !== true);
      const [draftComments, ...publishedComments] = await Promise.all([
        pending ? commentsOf(pending) : Promise.resolve([]),
        ...published.map(commentsOf),
      ]);
      return {
        connected: true,
        viewerIsAuthor: field(raw.user, 'login') === viewer,
        headSha,
        draft: pending ? {
          id: String(pending.id),
          body: isString(pending.body) ? pending.body : '',
          comments: draftComments.map((value) => {
            const comment = record(value);
            return { ...reviewCommentAt(comment), id: String(comment.id), body: comment.body, author: reviewPerson(comment.user) };
          }),
        } : null,
        threads: publishedComments.flat().filter((comment) => field(comment, 'commit_id') === headSha).map((value) => {
          const comment = record(value);
          return {
            ...reviewCommentAt(comment),
            id: String(comment.id),
            resolved: Boolean(comment.resolver),
            canReply: false,
            canResolve: false,
            comments: [{ id: String(comment.id), body: comment.body, createdAt: comment.created_at, url: comment.html_url, author: reviewPerson(comment.user) }],
          };
        }),
        truncated: false,
      };
    },

    async addReviewComment({ providerTarget, position, body, expectedTarget }: MutationCall & WithBody & { position: ReturnType<typeof reviewCommentPosition> }) {
      const comment = {
        path: position.path,
        body,
        new_position: position.side === 'new' ? position.line : 0,
        old_position: position.side === 'old' ? position.line : 0,
      };
      const raw = await client.post(reviewsPath(providerTarget), { event: 'PENDING', commit_id: expectedTarget.headSha, body: '', comments: [comment] });
      if (!plainObject(raw) || !integer(raw.id)) throw malformed(`${providerLabel} returned an invalid review comment`);
      return {};
    },

    async updateReviewComment({ providerTarget, commentId, body }: WithTarget & WithComment & WithBody) {
      await requirePendingComment(providerTarget, commentId);
      const updated = await client.patch(`${repoPath(targetRepo(providerTarget))}/issues/comments/${seg(commentId)}`, { body });
      if (!isPlainObject(updated)) throw Object.assign(new Error(`This ${providerLabel} version cannot edit a review comment`), { status: 422 });
      return {};
    },

    async deleteReviewComment({ providerTarget, commentId }: WithTarget & WithComment) {
      await requirePendingComment(providerTarget, commentId);
      await client.delete(`${repoPath(targetRepo(providerTarget))}/issues/comments/${seg(commentId)}`);
      const left = await readPendingComments(providerTarget);
      if (left.some((comment) => String(field(comment, 'id')) === commentId)) {
        throw Object.assign(new Error(`This ${providerLabel} version cannot remove one review comment; discard the review instead`), { status: 422 });
      }
      return {};
    },

    async discardReview({ providerTarget }: WithTarget) {
      const pending = await readPendingReview(providerTarget);
      if (!pending) throw Object.assign(new Error('There is no review draft on this pull request'), { status: 409 });
      await client.delete(`${reviewsPath(providerTarget)}/${pending.id}`);
      return {};
    },
  };
}
