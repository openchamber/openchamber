import { isPlainObject, isString } from '../shared/guards.js';
import { changeRequestNetworkTarget } from '../source-control/repository-network.js';
import {
  asDraftTitle, asReadyTitle, branchRepoId, liveChangeRequestSummary, liveIssueSummary,
  mapGiteaChangedFile, mapGiteaCI, mapGiteaComment, mapGiteaCommit, mapGiteaIssue, mapGiteaPull, mapGiteaRepo,
  mapGiteaReviewBody, mapGiteaReviewComment, mapGiteaUser, mapGiteaVerdict, splitUnifiedDiff,
} from './mappers.js';
import { resolveGiteaReposFromDirectory } from './repo.js';

// Gitea caps a page at `[api] MAX_RESPONSE_ITEMS` (50 by default).
const PAGE_LIMIT = 50;
const LIST_PAGE = 20;
// Whole collections (comments, files, branches) are read to the end within
// this bound; past it the read fails instead of passing a capped list off as complete.
const COLLECTION_MAX_ITEMS = 2000;
// The fallback scan for a branch's open pull request reads at most this many
// pages; past it the status read fails rather than answer "no pull request".
const STATUS_SCAN_MAX_PAGES = 5;
const TIMELINE_COMMIT_LIMIT = 50;
const LIVE_SUMMARY_CONCURRENCY = 4;
const LIST_DETAIL_CONCURRENCY = 4;
const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const LIST_STATES = { open: 'open', closed: 'closed', merged: 'closed', all: 'all' };
/** Review states that keep a user among a pull request's reviewers; `REQUEST_REVIEW` and `PENDING` do not. */
const SUBMITTED_REVIEW_STATES = new Set(['APPROVED', 'REQUEST_CHANGES', 'COMMENT']);

const statusOf = (error) => error?.status ?? error?.response?.status;
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const malformed = (message) => new Error(message);
const seg = (value) => encodeURIComponent(value);
const repoPath = (repo) => `/repos/${seg(repo.owner)}/${seg(repo.name)}`;

function requireMapped(value, message) {
  if (!value) throw malformed(message);
  return value;
}

async function mapLimited(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Gitea reads and writes for one session, as neutral DTOs. Every read is
 * bound to the repository network of the directory's remote on this
 * instance: the remote's repository and its fork parent. Forgejo speaks the
 * same API: `provider` is the id the DTOs carry and `providerLabel` names the server
 * in the errors a person reads.
 */
export function createGiteaResourceService({
  origin, client, resolveRepos = resolveGiteaReposFromDirectory, provider = 'gitea', providerLabel = 'Gitea',
}) {
  const identity = { provider, instance: origin };
  const mismatch = (key) => Object.assign(new Error(`${providerLabel} pull request ${key} changed`), {
    code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409,
  });
  const sameName = (a, b) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

  const showRepo = async (selector, remoteName) => {
    const raw = Number.isInteger(selector) ? await client.get(`/repositories/${selector}`) : await client.get(repoPath(selector));
    return { raw, project: requireMapped(mapGiteaRepo(raw, identity, remoteName), `${providerLabel} returned an invalid repository`) };
  };

  const resolveDirectoryRepos = async (directory, remote) => {
    const resolved = await resolveRepos(directory, origin, remote);
    const repos = [];
    for (const candidate of resolved.repos) {
      const item = await showRepo({ owner: candidate.owner, name: candidate.name }, candidate.remoteName);
      if (!repos.some((known) => known.project.id === item.project.id)) repos.push(item);
    }
    if (!repos.length) throw malformed(`No ${providerLabel} repository found for the repository remotes`);
    return repos;
  };

  /** The repositories and their fork parents; an unreadable parent is skipped unless the read needs it. */
  const withParents = async (sources, { requireComplete = false } = {}) => {
    const targets = [...sources];
    for (const source of sources) {
      const parent = source.raw?.parent;
      if (!isPlainObject(parent) || !Number.isInteger(parent.id) || targets.some((item) => item.raw.id === parent.id)) continue;
      try {
        targets.push(await showRepo(parent.id));
      } catch (error) {
        if (statusOf(error) === 401 || requireComplete) throw error;
      }
    }
    return targets;
  };

  /** The primary repository's network, and the one repository a selector names in it. */
  const network = async (directory, selector, remote, { requireComplete = false } = {}) => {
    const [primary] = await resolveDirectoryRepos(directory, remote);
    const targets = await withParents([primary], { requireComplete: requireComplete || Boolean(selector) });
    if (!selector) return { primary, target: targets[0], targets };
    const target = targets.find((candidate) => sameName(candidate.project, selector));
    if (!target) throw notFound(`${providerLabel} repository is outside the bound repository network`);
    return { primary, target, targets };
  };

  let currentLogin = null;
  const readCurrentLogin = () => {
    currentLogin ??= client.get('/user').then((user) => {
      if (!isPlainObject(user) || !isString(user.login) || !user.login) throw malformed(`${providerLabel} returned an invalid current user`);
      return user.login;
    });
    return currentLogin;
  };

  const requirePull = (raw, project) => requireMapped(mapGiteaPull(raw, identity, project), `${providerLabel} returned an invalid pull request`);
  const requireIssue = (raw, project) => {
    if (isPlainObject(raw) && raw.pull_request != null) throw notFound(`${providerLabel} issue #${raw.number} is a pull request`);
    return requireMapped(mapGiteaIssue(raw, identity, project), `${providerLabel} returned an invalid issue`);
  };

  const readCI = async (repo, sha) => {
    if (!isString(sha) || !sha) return null;
    try {
      return mapGiteaCI(await client.get(`${repoPath(repo)}/commits/${seg(sha)}/status`, { limit: PAGE_LIMIT }), identity);
    } catch (error) {
      if (statusOf(error) === 401) throw error;
      return null;
    }
  };

  /**
   * A pull request by number, targeting a repository of the bound network.
   * Its head may come from any fork: the pull request is the authority for
   * it (`changeRequestNetworkTarget`).
   */
  const findPull = async (directory, number, selector, { remote } = {}) => {
    const net = await network(directory, selector, remote, { requireComplete: true });
    const candidates = selector ? [net.target] : net.targets;
    for (const target of candidates) {
      let raw;
      try {
        raw = await client.get(`${repoPath(target.project)}/pulls/${number}`);
      } catch (error) {
        if (statusOf(error) === 404) continue;
        throw error;
      }
      if (changeRequestNetworkTarget(net.targets, branchRepoId(raw?.base), (candidate, id) => candidate.raw.id === id) !== target) {
        throw malformed(`${providerLabel} returned a pull request of another repository`);
      }
      return { target, raw, request: requirePull(raw, target.project), net };
    }
    throw notFound(`${providerLabel} pull request #${number} was not found`);
  };

  /** The fork a pull request's head lives in, when it is not the target repository. */
  const headProjectOf = async (raw, target, targets) => {
    const headId = branchRepoId(raw.head);
    if (headId === null || headId === target.raw.id) return null;
    const known = targets.find((candidate) => candidate.raw.id === headId);
    if (known) return known.project;
    const embedded = mapGiteaRepo(raw.head?.repo, identity);
    return embedded ?? (await showRepo(headId)).project;
  };

  /**
   * The open pull request from `branch` of one of `sourceIds` into `target`,
   * else the newest closed one as history. First the direct lookup on the
   * default branch (Gitea 1.22+; 1.21 answers 404), then a bounded scan of
   * open pull requests: a scan cut off by the bound fails instead of
   * reporting that there is none. The direct lookup answers one pull request
   * of the pair, not the open or newest one, so a closed answer only joins
   * the history candidates from the first page of closed pull requests.
   */
  const findBranchPull = async (target, branch, sources) => {
    const sourceIds = new Set(sources.map((source) => source.raw.id));
    const matches = (raw) => isPlainObject(raw) && raw.head?.ref === branch
      && sourceIds.has(branchRepoId(raw.head)) && branchRepoId(raw.base) === target.raw.id;
    const closed = [];
    const base = target.project.defaultBranch;
    if (base) {
      for (const source of sources) {
        // Encoded, a slash in either branch name stays inside its path segment.
        const head = source.raw.id === target.raw.id ? seg(branch) : `${seg(source.project.owner)}:${seg(branch)}`;
        try {
          const raw = await client.get(`${repoPath(target.project)}/pulls/${seg(base)}/${head}`);
          if (matches(raw)) {
            if (raw.state === 'open') return { raw, history: null };
            closed.push(raw);
          }
        } catch (error) {
          if (statusOf(error) !== 404) throw error;
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
      const history = closed.reduce((newest, candidate) => (!newest || candidate.number > newest.number ? candidate : newest), null);
      return { raw: null, history };
    }
    throw malformed(`${providerLabel} repository has more open pull requests than OpenChamber scans for a branch`);
  };

  const compactProject = (project) => ({ id: project.id, owner: project.owner, name: project.name });
  const mutationTarget = (context, project, request = {}) => {
    const target = {
      repositoryId: context.repositoryId,
      bindingRevision: context.bindingRevision,
      primaryRemote: context.primaryRemote,
      project: compactProject(project),
    };
    for (const key of ['number', 'head', 'base', 'headSha']) {
      if (request[key] !== undefined) target[key] = request[key];
    }
    return target;
  };
  const requireExpected = (expected, actual) => {
    for (const key of ['number', 'head', 'base', 'headSha']) {
      if (expected[key] !== undefined && expected[key] !== actual[key]) throw mismatch(key);
    }
  };
  const targetRepo = (providerTarget) => ({ owner: providerTarget.owner, name: providerTarget.name });
  const readTargetPull = async (providerTarget) => {
    const raw = await client.get(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`);
    if (branchRepoId(raw?.base) !== Number(providerTarget.repoId)) throw malformed(`${providerLabel} returned a pull request outside the resolved mutation target`);
    return raw;
  };
  const projectOfTarget = (providerTarget) => ({
    ...identity, id: String(providerTarget.repoId), owner: providerTarget.owner, name: providerTarget.name, url: `${origin}/${providerTarget.owner}/${providerTarget.name}`,
  });

  /** Repository labels by name, for a label set given by name. */
  const labelIds = async (providerTarget, names) => {
    if (names.length === 0) return [];
    const labels = await client.collection(`${repoPath(targetRepo(providerTarget))}/labels`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS });
    return names.map((name) => {
      const label = labels.find((candidate) => isPlainObject(candidate) && candidate.name === name && Number.isInteger(candidate.id));
      if (!label) throw Object.assign(new Error(`${providerLabel} label "${name}" does not exist in this repository`), { status: 422 });
      return label.id;
    });
  };

  const collaborators = (repo) => client.collection(`${repoPath(repo)}/collaborators`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS });

  /** Pull requests a list names by issue number, read in full. */
  const pullsOfIssues = async (repo, issues, { mergedOnly = false } = {}) => {
    const pulls = await mapLimited(issues, LIST_DETAIL_CONCURRENCY, (issue) => client.get(`${repoPath(repo.project)}/pulls/${issue.number}`));
    return pulls.filter((raw) => !mergedOnly || raw?.merged === true).map((raw) => requirePull(raw, repo.project));
  };

  /**
   * The newest commits, oldest first. Gitea pages a pull request's commits
   * in `git log` order, newest first (1.21 and 1.27), so the first page holds
   * the newest ones; reversing it keeps commits made within one second in
   * order, which sorting by their second-precision dates would not.
   */
  const readTimelineCommits = async (repo, number) => {
    const first = await client.page(`${repo}/pulls/${number}/commits`, { files: false, verification: false }, { page: 1, limit: TIMELINE_COMMIT_LIMIT });
    const items = first.items.flatMap((commit) => {
      const mapped = mapGiteaCommit(commit);
      return mapped ? [mapped] : [];
    }).reverse();
    return { items, complete: !first.hasMore };
  };

  /**
   * An issue's or pull request's comments. Gitea answers them all in one
   * list and ignores `page` and `limit` here (1.21 and 1.27), so paging would
   * read the same list again.
   */
  const readIssueComments = async (repo, number) => {
    const comments = await client.get(`${repoPath(repo)}/issues/${number}/comments`);
    if (!Array.isArray(comments)) throw malformed(`${providerLabel} returned an invalid comment list`);
    return comments;
  };

  return {
    async changeRequestStatus(directory, branch, remote) {
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

    /**
     * One page of pull requests of the network's upstream. A plain state
     * reads Gitea's pull list; a search, a people filter or "merged" reads
     * the issue list (which has those filters) and then each pull request.
     */
    async listChangeRequests(directory, options = {}) {
      const page = options.page ?? 1;
      const { targets } = await network(directory, null, options.remote);
      const target = targets.at(-1);
      const people = options.people ?? 'any';
      const state = options.state ?? 'open';
      if (!options.query && people === 'any' && state !== 'merged') {
        const result = await client.page(`${repoPath(target.project)}/pulls`, { state: LIST_STATES[state] ?? 'open', sort: 'recentupdate' }, { page, limit: LIST_PAGE });
        return { items: result.items.map((raw) => requirePull(raw, target.project)), page, hasMore: result.hasMore };
      }
      let result;
      if (people === 'reviewRequested') {
        // Only the cross-repository search filters on review requests; it is
        // narrowed to the owner here and to the repository below.
        result = await client.page('/repos/issues/search', {
          type: 'pulls', state: LIST_STATES[state] ?? 'open', q: options.query, owner: target.project.owner, review_requested: true,
        }, { page, limit: LIST_PAGE });
        result.items = result.items.filter((item) => isPlainObject(item?.repository)
          && Number(item.repository.id) === target.raw.id);
      } else {
        const query = { type: 'pulls', state: LIST_STATES[state] ?? 'open', q: options.query };
        if (people === 'created') query.created_by = await readCurrentLogin();
        if (people === 'assigned') query.assigned_by = await readCurrentLogin();
        result = await client.page(`${repoPath(target.project)}/issues`, query, { page, limit: LIST_PAGE });
      }
      const items = await pullsOfIssues(target, result.items, { mergedOnly: state === 'merged' });
      return { items, page, hasMore: result.hasMore };
    },

    async changeRequestContext(directory, number, options = {}) {
      const { target, raw, request, net } = await findPull(directory, number, options.project, { remote: options.remote });
      const repo = repoPath(target.project);
      const [comments, reviews, diffText, changedFiles, ci, headProject, commits] = await Promise.all([
        readIssueComments(target.project, number),
        client.collection(`${repo}/pulls/${number}/reviews`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS, message: `${providerLabel} pull request has more reviews than OpenChamber reads` }),
        options.includeDiff ? client.text(`${repo}/pulls/${number}.diff`) : Promise.resolve(''),
        options.includeDiff
          ? client.collection(`${repo}/pulls/${number}/files`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS, message: `${providerLabel} pull request has more changed files than OpenChamber reads` })
          : Promise.resolve([]),
        readCI(target.project, request.headSha),
        headProjectOf(raw, target, net.targets),
        options.includeTimeline ? readTimelineCommits(repo, number) : Promise.resolve(null),
      ]);
      const reviewsWithComments = reviews.filter((review) => isPlainObject(review) && Number.isInteger(review.id) && review.comments_count > 0);
      const reviewComments = (await mapLimited(reviewsWithComments, LIST_DETAIL_CONCURRENCY, (review) => client.get(`${repo}/pulls/${number}/reviews/${review.id}/comments`)))
        .flatMap((list) => (Array.isArray(list) ? list : []))
        .flatMap((comment) => {
          const mapped = mapGiteaReviewComment(comment, identity, request.url);
          return mapped ? [mapped] : [];
        });
      const issueComments = [
        ...comments.flatMap((comment) => {
          const mapped = mapGiteaComment(comment, identity, request.url);
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
      if (!options.includeTimeline) return context;
      return {
        ...context,
        commits: commits.items,
        commitsComplete: commits.complete,
        reviewers: (Array.isArray(raw.requested_reviewers) ? raw.requested_reviewers : []).flatMap((user) => {
          const mapped = mapGiteaUser(user, identity);
          return mapped ? [mapped] : [];
        }),
        verdicts: reviews.flatMap((review) => {
          const mapped = mapGiteaVerdict(review, identity, request.url);
          return mapped ? [mapped] : [];
        }),
      };
    },

    async listIssues(directory, options = {}) {
      const page = options.page ?? 1;
      const { primary } = await network(directory, null, options.remote);
      const query = { type: 'issues', state: LIST_STATES[options.state] ?? 'open', q: options.query };
      if (options.people === 'created') query.created_by = await readCurrentLogin();
      if (options.people === 'assigned') query.assigned_by = await readCurrentLogin();
      const result = await client.page(`${repoPath(primary.project)}/issues`, query, { page, limit: LIST_PAGE });
      const items = result.items.flatMap((raw) => (raw?.pull_request != null ? [] : [requireIssue(raw, primary.project)]));
      return { items, page, hasMore: result.hasMore };
    },

    async getIssue(directory, number, selector, remote) {
      const { target } = await network(directory, selector, remote);
      return requireIssue(await client.get(`${repoPath(target.project)}/issues/${number}`), target.project);
    },

    async issueComments(directory, number, selector, remote) {
      const { target } = await network(directory, selector, remote);
      const issue = requireIssue(await client.get(`${repoPath(target.project)}/issues/${number}`), target.project);
      const comments = await readIssueComments(target.project, number);
      return comments.map((comment) => requireMapped(mapGiteaComment(comment, identity, issue.url), `${providerLabel} returned an invalid issue comment`));
    },

    async projectUpstream(directory, remote) {
      const { primary, targets } = await network(directory, null, remote);
      const parentId = primary.raw?.parent?.id;
      if (!Number.isInteger(parentId)) return { identity, isFork: false, upstream: null };
      const parent = targets.find((candidate) => candidate.raw.id === parentId) ?? await showRepo(parentId);
      return { identity, isFork: true, upstream: parent.project };
    },

    async projectBranches(directory, selector, remote) {
      const { target } = await network(directory, selector, remote, { requireComplete: true });
      const branches = await client.collection(`${repoPath(target.project)}/branches`, {}, {
        limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS, message: `${providerLabel} repository has more branches than OpenChamber reads`,
      });
      return branches.map((branch) => {
        if (!isString(branch?.name) || !branch.name) throw malformed(`${providerLabel} returned an invalid branch`);
        return branch.name;
      });
    },

    async listLabels(directory, selector, remote) {
      const { target } = await network(directory, selector, remote);
      const labels = await client.collection(`${repoPath(target.project)}/labels`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS });
      return labels.flatMap((label) => {
        if (!isPlainObject(label) || !isString(label.name) || !label.name) return [];
        return [isString(label.color) && label.color ? { name: label.name, color: label.color.replace(/^#/, '') } : { name: label.name }];
      });
    },

    /** Collaborators: who can be asked to review. Ids are numeric, as reviewer mutations take them. */
    async listReviewerCandidates(directory, selector, remote) {
      const { target } = await network(directory, selector, remote);
      return (await collaborators(target.project)).flatMap((user) => {
        const mapped = mapGiteaUser(user, identity);
        if (!mapped) return [];
        return [mapped.avatarUrl ? { id: mapped.id, login: mapped.username, avatarUrl: mapped.avatarUrl } : { id: mapped.id, login: mapped.username }];
      });
    },

    /** The pull request's changes as one unified diff; its target must be in the bound network. */
    async changeRequestPatch(directory, number, { project, remote } = {}) {
      const { target } = await findPull(directory, number, project, { remote });
      const patch = await client.text(`${repoPath(target.project)}/pulls/${number}.diff`);
      if (!isString(patch)) throw malformed(`${providerLabel} returned an invalid pull request diff`);
      return { patch, meta: { owner: target.project.owner, repo: target.project.name, number } };
    },

    /**
     * Both sides of one file: the merge base the diff was taken against and
     * the head commit. Gitea keeps a fork pull request's head under the
     * target repository's `refs/pull/<n>/head`, so both reads go there.
     */
    async changeRequestFileContents(directory, number, { project, remote, path, previousPath, status }) {
      const { target, raw } = await findPull(directory, number, project, { remote });
      const baseSha = raw?.merge_base;
      const headSha = raw?.head?.sha;
      if (!COMMIT_SHA.test(String(baseSha)) || !COMMIT_SHA.test(String(headSha))) throw malformed(`${providerLabel} returned invalid pull request refs`);
      const readFile = async (filePath, ref) => {
        const content = await client.text(`${repoPath(target.project)}/raw/${filePath.split('/').map(seg).join('/')}`, { ref });
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

    /**
     * Live state of known pull requests and issues. An item Gitea cannot
     * answer is left out, unknown rather than closed; a refused token fails
     * the whole read so the account is reconciled.
     */
    async liveSummaries({ refs = [], issueRefs = [] }) {
      const read = async (ref, task) => {
        try {
          return await task(repoPath({ owner: ref.owner, name: ref.repo }));
        } catch (error) {
          if (statusOf(error) === 401) throw error;
          return null;
        }
      };
      const [summaries, issueSummaries] = await Promise.all([
        mapLimited(refs, LIVE_SUMMARY_CONCURRENCY, (ref) => read(ref, async (repo) => {
          const raw = await client.get(`${repo}/pulls/${ref.number}`);
          const open = raw?.state === 'open' && raw?.merged !== true;
          const ci = open ? await readCI({ owner: ref.owner, name: ref.repo }, raw?.head?.sha) : null;
          return liveChangeRequestSummary(ref, raw, ci);
        })),
        mapLimited(issueRefs, LIVE_SUMMARY_CONCURRENCY, (ref) => read(ref, async (repo) => liveIssueSummary(ref, await client.get(`${repo}/issues/${ref.number}`)))),
      ]);
      return { summaries: summaries.filter(Boolean), issueSummaries: issueSummaries.filter(Boolean) };
    },

    /** A pull request by number in the bound network, with the fork its head lives in. */
    async findChangeRequest(directory, number, selector, remote) {
      const { target, raw, request, net } = await findPull(directory, number, selector, { remote });
      return { target, request, headProject: await headProjectOf(raw, target, net.targets) };
    },

    // Mutations.

    async resolveCreateMutation(context, expected, options = {}) {
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

    async resolveChangeRequestMutation(context, expected) {
      const { target, request } = await findPull(context.directory, expected.number, expected.project, { remote: context.primaryRemote });
      requireExpected(expected, request);
      return {
        providerTarget: { repoId: Number(target.project.id), owner: target.project.owner, name: target.project.name, number: request.number },
        target: mutationTarget(context, target.project, request),
      };
    },

    async resolveIssueMutation(context, expected) {
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

    /** Cross-repository pull requests name the fork's branch as `owner:branch`. */
    async createChangeRequest({ providerTarget, title, body, draft, head, base, expectedTarget }) {
      const fork = providerTarget.sourceRepoId !== providerTarget.repoId;
      const payload = { head: fork ? `${providerTarget.sourceOwner}:${head}` : head, base, title: draft ? asDraftTitle(title) : title };
      if (body !== undefined) payload.body = body;
      const raw = await client.post(`${repoPath(targetRepo(providerTarget))}/pulls`, payload);
      if (branchRepoId(raw?.base) !== providerTarget.repoId || branchRepoId(raw?.head) !== providerTarget.sourceRepoId) {
        throw malformed(`${providerLabel} returned a pull request outside the resolved mutation target`);
      }
      const request = requirePull(raw, projectOfTarget(providerTarget));
      requireExpected({ head: expectedTarget.head, base: expectedTarget.base }, request);
      return { number: request.number };
    },

    async reconcileCreateMutation(providerTarget, target) {
      const matches = [];
      for (let page = 1; page <= STATUS_SCAN_MAX_PAGES; page += 1) {
        const result = await client.page(`${repoPath(targetRepo(providerTarget))}/pulls`, { state: 'all', sort: 'recentupdate' }, { page, limit: PAGE_LIMIT });
        matches.push(...result.items.filter((raw) => raw?.head?.ref === target.head && raw?.base?.ref === target.base
          && branchRepoId(raw.head) === providerTarget.sourceRepoId && branchRepoId(raw.base) === providerTarget.repoId));
        if (!result.hasMore) {
          return matches.length === 1 ? { state: 'succeeded', result: { number: matches[0].number } } : { state: 'outcome-unknown' };
        }
      }
      return { state: 'outcome-unknown' };
    },

    async updateChangeRequest({ providerTarget, title, body, expectedTarget }) {
      const payload = { title };
      if (body !== undefined) payload.body = body;
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`, payload);
      if (branchRepoId(raw?.base) !== providerTarget.repoId) throw malformed(`${providerLabel} returned a pull request outside the resolved mutation target`);
      requireExpected({ number: expectedTarget.number }, requirePull(raw, projectOfTarget(providerTarget)));
      return {};
    },

    /**
     * Merges only the head that was reviewed: `head_commit_id` makes Gitea
     * refuse with 409 once the branch moved. Gitea checks mergeability
     * first, so a push that also made the pull request unmergeable answers
     * 405 instead; both are re-read to tell a moved head from a refusal of
     * the reviewed one.
     */
    async mergeChangeRequest({ providerTarget, method, expectedTarget }) {
      const payload = { Do: method };
      if (expectedTarget.headSha) payload.head_commit_id = expectedTarget.headSha;
      try {
        await client.post(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}/merge`, payload);
      } catch (error) {
        if ((statusOf(error) === 409 || statusOf(error) === 405) && expectedTarget.headSha) {
          const current = await readTargetPull(providerTarget).catch(() => null);
          if (current && current.head?.sha !== expectedTarget.headSha) throw mismatch('headSha');
        }
        throw error;
      }
      const raw = await readTargetPull(providerTarget);
      return { merged: raw.merged === true };
    },

    async readyChangeRequest({ providerTarget, expectedTarget }) {
      const current = requirePull(await readTargetPull(providerTarget), projectOfTarget(providerTarget));
      requireExpected({ number: expectedTarget.number, headSha: expectedTarget.headSha }, current);
      if (!current.draft) return { ready: true };
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}`, { title: asReadyTitle(current.title) });
      const request = requirePull(raw, projectOfTarget(providerTarget));
      return { ready: !request.draft };
    },

    /** Close or reopen, through the issue a pull request also is. */
    async setState({ providerTarget, state, kind }) {
      const raw = await client.patch(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}`, { state });
      if (!isPlainObject(raw) || raw.number !== providerTarget.number || raw.state !== state) {
        throw malformed(`${providerLabel} returned an unexpected ${kind.startsWith('issue') ? 'issue' : 'pull request'} state`);
      }
      return { state };
    },

    async reconcileStateMutation(providerTarget, kind, state) {
      const repo = repoPath(targetRepo(providerTarget));
      const raw = kind === 'issue-state'
        ? await client.get(`${repo}/issues/${providerTarget.number}`)
        : await client.get(`${repo}/pulls/${providerTarget.number}`);
      const current = raw?.merged === true ? 'merged' : raw?.state;
      if (current === state) return { state: 'succeeded', result: { state } };
      if (current === 'open' || current === 'closed') return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
      return { state: 'outcome-unknown' };
    },

    async reconcileChangeRequestMutation(providerTarget, kind) {
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
      return { state: 'outcome-unknown' };
    },

    /** The whole label set by name; an empty one clears them. */
    async setLabels({ providerTarget, labels }) {
      const ids = await labelIds(providerTarget, labels);
      const raw = await client.put(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}/labels`, { labels: ids });
      if (!Array.isArray(raw)) throw malformed(`${providerLabel} returned an invalid label list`);
      return {};
    },

    /**
     * The whole reviewer set by user id. Gitea's API adds and removes review
     * requests by username, so ids are looked up among the collaborators and
     * the current requests, then the difference is sent: additions, then
     * removals.
     */
    async setReviewers({ providerTarget, reviewers }) {
      const repo = targetRepo(providerTarget);
      const raw = await readTargetPull(providerTarget);
      const current = (Array.isArray(raw.requested_reviewers) ? raw.requested_reviewers : []).filter((user) => Number.isInteger(user?.id) && isString(user?.login));
      const known = new Map([...current, ...(await collaborators(repo))].filter((user) => Number.isInteger(user?.id) && isString(user?.login))
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
        // Gitea answers 204 to removing someone who already reviewed and keeps
        // them, so that removal is refused before anything is sent.
        const reviews = await client.collection(`${repoPath(repo)}/pulls/${providerTarget.number}/reviews`, {}, { limit: PAGE_LIMIT, maxItems: COLLECTION_MAX_ITEMS, message: `${providerLabel} pull request has more reviews than OpenChamber reads` });
        const reviewed = remove.filter((login) => reviews.some((review) => isPlainObject(review) && review.user?.login === login
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

    /** Only a match is certain: another edit since may have moved the set either way. */
    async reconcileSetMutation(providerTarget, kind, names) {
      const repo = repoPath(targetRepo(providerTarget));
      const raw = kind === 'issue-labels'
        ? await client.get(`${repo}/issues/${providerTarget.number}`)
        : await client.get(`${repo}/pulls/${providerTarget.number}`);
      // Gitea 1.21 answers no review requests as `null`, not an empty list.
      const reviewers = isPlainObject(raw) && raw.requested_reviewers === null ? [] : raw?.requested_reviewers;
      const current = kind === 'change-request-reviewers'
        ? (Array.isArray(reviewers) ? reviewers.map((user) => String(user?.id)) : null)
        : (Array.isArray(raw?.labels) ? raw.labels.map((label) => label?.name) : null);
      if (!current || current.length !== names.length || !current.every((entry) => names.includes(entry))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    async comment({ providerTarget, body }) {
      const raw = await client.post(`${repoPath(targetRepo(providerTarget))}/issues/${providerTarget.number}/comments`, { body });
      if (!isPlainObject(raw) || !Number.isInteger(raw.id)) throw malformed(`${providerLabel} returned an invalid comment`);
      return {};
    },

    /**
     * A verdict with its text in one review, for the commit the user read:
     * the head is checked first, and `commit_id` pins the review to it.
     */
    async reviewChangeRequest({ providerTarget, verdict, body, expectedTarget }) {
      const current = await readTargetPull(providerTarget);
      if (current.head?.sha !== expectedTarget.headSha) throw mismatch('headSha');
      const payload = { event: verdict === 'approve' ? 'APPROVED' : 'REQUEST_CHANGES', commit_id: expectedTarget.headSha, body: body ?? '' };
      const raw = await client.post(`${repoPath(targetRepo(providerTarget))}/pulls/${providerTarget.number}/reviews`, payload);
      if (!isPlainObject(raw) || !Number.isInteger(raw.id)) throw malformed(`${providerLabel} returned an invalid review`);
      return { commented: body !== undefined };
    },
  };
}
