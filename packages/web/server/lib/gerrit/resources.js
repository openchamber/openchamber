import { isPlainObject, isString } from '../shared/guards.js';
import { mapLimited } from '../shared/map-limited.js';
import { joinProjectPath } from '../source-control/project-path.js';
import { readLocalRevision as readLocalRevisionDefault, readUpstreamBranch as readUpstreamBranchDefault } from './local-revision.js';
import {
  changePath, changeState, diffOfPatch, gerritTimestamp, liveChangeSummary, mapGerritChange, mapGerritFiles, mapGerritInlineComment,
  mapGerritMessage, mapGerritProject, mapGerritRelatedStack, mapGerritRevisions, mapGerritSubmitRequirements, mapGerritUser,
  mapGerritVoteLabels, splitUnifiedDiff,
} from './mappers.js';
import { resolveGerritProjectsFromDirectory } from './repo.js';

const LIST_PAGE = 20;
const STATUS_CANDIDATES = 10;
const BRANCH_PAGE = 500;
// Whole collections (branches) are read to the end within this bound; past
// it the read fails instead of passing a capped list off as complete.
const COLLECTION_MAX_ITEMS = 2000;
const REVIEWER_SAMPLE = 25;
const LIVE_SUMMARY_CONCURRENCY = 4;
const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

// `o=` options per read: each asks for what its answer maps, no more.
const STATUS_OPTIONS = ['ALL_REVISIONS', 'LABELS', 'SUBMITTABLE', 'DETAILED_ACCOUNTS'];
const LIST_OPTIONS = ['CURRENT_REVISION', 'LABELS', 'SUBMITTABLE', 'DETAILED_ACCOUNTS'];
// `DETAILED_LABELS` alone leaves out each label's `approved` / `rejected` /
// `recommended` / `disliked` summary on 3.8 (3.10 sends it), so `LABELS` is asked too.
const CONTEXT_OPTIONS = ['ALL_REVISIONS', 'CURRENT_COMMIT', 'LABELS', 'DETAILED_LABELS', 'DETAILED_ACCOUNTS', 'MESSAGES', 'SUBMITTABLE', 'SUBMIT_REQUIREMENTS'];
const HEAD_OPTIONS = ['ALL_REVISIONS'];
// `reviewers` comes with `LABELS`; nothing is answered without a label option.
const MUTATION_OPTIONS = ['CURRENT_REVISION', 'LABELS', 'DETAILED_ACCOUNTS'];
const CANDIDATE_OPTIONS = ['LABELS', 'DETAILED_ACCOUNTS'];
const LIVE_OPTIONS = ['CURRENT_REVISION', 'SUBMITTABLE'];

const LIST_STATES = { open: 'status:open', closed: 'status:closed', merged: 'status:merged', all: '' };
const LIST_PEOPLE = { any: '', created: 'owner:self', assigned: 'attention:self', reviewRequested: 'reviewer:self -owner:self' };

const statusOf = (error) => error?.status ?? error?.response?.status;
const notFound = (message) => Object.assign(new Error(message), { status: 404 });
const malformed = (message) => new Error(message);
const mismatch = (key) => Object.assign(new Error(`Gerrit change ${key} changed`), {
  code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409,
});
const notApplied = () => ({ state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } });
const enc = (value) => encodeURIComponent(value);

function requireMapped(value, message) {
  if (!value) throw malformed(message);
  return value;
}

/** Free text as one quoted search term; a bare number is the change itself. */
const searchTerm = (query) => {
  const value = isString(query) ? query.trim() : '';
  if (!value) return '';
  if (/^\d+$/.test(value)) return `change:${value}`;
  const words = value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? `message:"${words}"` : '';
};

/**
 * Among the changes that carry one Change-Id (cherry-picks to other
 * branches), the one a local branch is for: the open change on the branch
 * it tracks, else on the project's default branch, else the only open one,
 * else the most recently updated open one, else the newest closed one as
 * history.
 */
export function selectChangeForBranch(candidates, { upstreamBranch, defaultBranch }) {
  const newest = (list) => list.reduce((best, raw) => (!best || String(raw.updated) > String(best.updated) ? raw : best), null);
  const open = candidates.filter((raw) => raw.status === 'NEW');
  return (upstreamBranch ? open.find((raw) => raw.branch === upstreamBranch) : null)
    ?? (defaultBranch ? open.find((raw) => raw.branch === defaultBranch) : null)
    ?? (open.length === 1 ? open[0] : null)
    ?? newest(open)
    ?? newest(candidates.filter((raw) => raw.status !== 'NEW'));
}

/**
 * Gerrit reads and writes for one session, as neutral DTOs. Every read is
 * bound to the project the directory's remote names on this instance;
 * Gerrit has no forks, so that project is the whole network.
 */
export function createGerritResourceService({
  origin,
  client,
  resolveProjects = resolveGerritProjectsFromDirectory,
  readLocalRevision = readLocalRevisionDefault,
  readUpstreamBranch = readUpstreamBranchDefault,
}) {
  const identity = { provider: 'gerrit', instance: origin };

  const primaryProject = async (directory, remote) => {
    const [primary] = (await resolveProjects(directory, origin, remote)).repos;
    if (!primary) throw malformed('No Gerrit project found for the repository remotes');
    return primary;
  };

  /** The bound project, and the one a selector names, which must be it. */
  const boundProject = async (directory, selector, remote) => {
    const primary = await primaryProject(directory, remote);
    if (selector && joinProjectPath(selector.owner, selector.name) !== primary.project) throw notFound('Gerrit project is outside the bound project');
    return primary;
  };

  /** The branch the project's HEAD names; unknown (null) when it cannot be read, except a refused account. */
  const readDefaultBranch = async (name) => {
    try {
      const head = await client.get(`/projects/${enc(name)}/HEAD`);
      return isString(head) && head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : null;
    } catch (error) {
      if (statusOf(error) === 401) throw error;
      return null;
    }
  };

  const projectOf = (primary, options) => requireMapped(mapGerritProject(primary.project, identity, options), 'Gerrit returned an invalid project');

  /** A change by number in the bound project, read with `options`. */
  const readChange = async (name, number, options) => {
    const raw = await client.get(changePath(name, number), { o: options });
    if (!isPlainObject(raw) || raw._number !== number) throw malformed('Gerrit returned another change');
    if (raw.project !== name) throw notFound(`Gerrit change ${number} is not in ${name}`);
    return raw;
  };

  const requireChange = (raw, project) => requireMapped(mapGerritChange(raw, identity, project), 'Gerrit returned an invalid change');

  const findChange = async (directory, number, selector, remote, options) => {
    const primary = await boundProject(directory, selector, remote);
    const project = projectOf(primary, { remoteName: primary.remoteName });
    const raw = await readChange(primary.project, number, options);
    return { primary, project, raw, request: requireChange(raw, project) };
  };

  /** The patchset a read asks for, by commit SHA; the current one when none is named. */
  const revisionOf = (raw, revision) => {
    if (revision === undefined || revision === null || revision === '') {
      if (!COMMIT_SHA.test(String(raw.current_revision))) throw malformed('Gerrit returned a change without a current patchset');
      return raw.current_revision;
    }
    if (!isPlainObject(raw.revisions) || !Object.hasOwn(raw.revisions, revision)) {
      throw notFound(`Gerrit change ${raw._number} has no patchset ${revision}`);
    }
    return revision;
  };

  /** The relation chain around a change; absent (undefined) when it cannot be read. */
  const readStack = async (name, number, base) => {
    try {
      return mapGerritRelatedStack(await client.get(`${changePath(name, number)}/revisions/current/related`), { origin, project: name, base });
    } catch (error) {
      if (statusOf(error) === 401) throw error;
      return undefined;
    }
  };

  const compactProject = (project) => ({ id: project.id, owner: project.owner, name: project.name });
  const mutationTarget = (context, project, request) => {
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
  const readTarget = (providerTarget, options = MUTATION_OPTIONS) => readChange(providerTarget.project, providerTarget.number, options);
  const targetPath = (providerTarget) => changePath(providerTarget.project, providerTarget.number);
  const reviewerIds = (raw) => (Array.isArray(raw?.reviewers?.REVIEWER) ? raw.reviewers.REVIEWER : [])
    .filter((account) => Number.isInteger(account?._account_id)).map((account) => String(account._account_id));
  const requireCurrent = (raw, headSha) => {
    if (raw.current_revision !== headSha) throw mismatch('headSha');
  };

  return {
    /**
     * A local branch's change, found by the Change-Id trailer of its tip
     * commit, not by its name: a Gerrit change has no source branch.
     * `localRevision.uploadedAs` is the patchset whose commit is the local
     * tip, null when the local commit is not uploaded yet.
     */
    async changeRequestStatus(directory, branch, remote) {
      const primary = await primaryProject(directory, remote);
      const defaultBranch = await readDefaultBranch(primary.project);
      const project = projectOf(primary, { defaultBranch, remoteName: primary.remoteName });
      const base = { identity, project, branch, resolvedRemoteName: primary.remoteName ?? null, defaultBranch };
      const local = await readLocalRevision(directory, branch);
      if (!local.changeId) return { ...base, changeRequest: null, localRevision: { sha: local.sha, changeId: null, uploadedAs: null } };
      const answer = await client.get('/changes/', { q: `change:${local.changeId} project:${primary.project}`, o: STATUS_OPTIONS, n: STATUS_CANDIDATES });
      if (!Array.isArray(answer)) throw malformed('Gerrit returned an invalid change list');
      const candidates = answer.filter((raw) => isPlainObject(raw) && raw.project === primary.project && raw.change_id === local.changeId);
      const upstreamBranch = await readUpstreamBranch(directory, branch, primary.remoteName).catch(() => null);
      const selected = selectChangeForBranch(candidates, { upstreamBranch, defaultBranch });
      if (!selected) return { ...base, changeRequest: null, localRevision: { sha: local.sha, changeId: local.changeId, uploadedAs: null } };
      const request = requireChange(selected, project);
      const uploaded = Object.entries(isPlainObject(selected.revisions) ? selected.revisions : {})
        .find(([sha]) => sha === local.sha)?.[1]?._number;
      const status = {
        ...base,
        changeRequest: request,
        ci: null,
        canMerge: request.state === 'open' && request.mergeable === true,
        localRevision: { sha: local.sha, changeId: local.changeId, uploadedAs: Number.isInteger(uploaded) ? uploaded : null },
      };
      if (request.state === 'open') {
        const stack = await readStack(primary.project, request.number, request.base);
        if (stack !== undefined) status.stack = stack;
      }
      return status;
    },

    /** One page of the bound project's changes, newest update first. */
    async listChangeRequests(directory, options = {}) {
      const page = options.page ?? 1;
      const primary = await primaryProject(directory, options.remote);
      const project = projectOf(primary, { remoteName: primary.remoteName });
      const q = [`project:${primary.project}`, LIST_STATES[options.state ?? 'open'] ?? LIST_STATES.open,
        LIST_PEOPLE[options.people ?? 'any'] ?? '', searchTerm(options.query)].filter(Boolean).join(' ');
      const result = await client.page('/changes/', { q, o: LIST_OPTIONS }, { start: (page - 1) * LIST_PAGE, limit: LIST_PAGE });
      return { items: result.items.map((raw) => requireChange(raw, project)), page, hasMore: result.hasMore };
    },

    /**
     * A change with its votes, submit requirements, patchsets, messages and
     * inline comments. Files and diff are those of `revision` (a patchset's
     * commit SHA), the current patchset when none is named.
     */
    async changeRequestContext(directory, number, options = {}) {
      const { primary, project, raw, request } = await findChange(directory, number, options.project, options.remote, CONTEXT_OPTIONS);
      const sha = revisionOf(raw, options.revision);
      const path = changePath(primary.project, number);
      const [files, patch, inline, stack] = await Promise.all([
        options.includeDiff ? client.get(`${path}/revisions/${sha}/files/`) : Promise.resolve({}),
        options.includeDiff ? client.base64(`${path}/revisions/${sha}/patch`) : Promise.resolve(null),
        client.get(`${path}/comments`),
        request.state === 'open' ? readStack(primary.project, number, request.base) : Promise.resolve(null),
      ]);
      const diff = patch ? diffOfPatch(patch.toString('utf8')) : '';
      const patches = splitUnifiedDiff(diff);
      const changedFiles = requireMapped(mapGerritFiles(files), 'Gerrit returned an invalid file list').map((file) => {
        const filePatch = patches.get(file.path);
        return filePatch ? { ...file, patch: filePatch } : file;
      });
      const issueComments = (Array.isArray(raw.messages) ? raw.messages : []).map((message) => requireMapped(
        mapGerritMessage(message, identity, request.url), 'Gerrit returned an invalid change message',
      ));
      const reviewComments = Object.entries(isPlainObject(inline) ? inline : {}).flatMap(([filePath, comments]) => (
        Array.isArray(comments) ? comments : []
      ).flatMap((comment) => {
        const mapped = mapGerritInlineComment(filePath, comment, identity, request.url);
        return mapped ? [mapped] : [];
      }));
      const context = {
        identity,
        project,
        changeRequest: request,
        issueComments,
        reviewComments,
        files: changedFiles,
        diff,
        ci: null,
        voteLabels: mapGerritVoteLabels(raw, identity),
        submitRequirements: mapGerritSubmitRequirements(raw),
        revisions: mapGerritRevisions(raw, identity),
      };
      if (stack !== undefined) context.stack = stack;
      if (!options.includeTimeline) return context;
      // A change is one commit: its timeline is the current patchset's.
      const commit = raw.revisions?.[raw.current_revision]?.commit;
      return {
        ...context,
        commits: isPlainObject(commit) ? [{
          sha: raw.current_revision,
          headline: isString(commit.subject) ? commit.subject : request.title,
          authorName: isString(commit.author?.name) ? commit.author.name : null,
          committedAt: gerritTimestamp(commit.committer?.date),
          url: request.url,
        }] : [],
        commitsComplete: true,
        reviewers: (Array.isArray(raw.reviewers?.REVIEWER) ? raw.reviewers.REVIEWER : []).flatMap((account) => {
          const mapped = mapGerritUser(account, identity);
          return mapped ? [mapped] : [];
        }),
      };
    },

    /** Gerrit has no forks. */
    async projectUpstream(directory, remote) {
      await primaryProject(directory, remote);
      return { identity, isFork: false, upstream: null };
    },

    async projectBranches(directory, selector, remote) {
      const primary = await boundProject(directory, selector, remote);
      const names = [];
      for (let start = 0; ; start += BRANCH_PAGE) {
        const result = await client.page(`/projects/${enc(primary.project)}/branches/`, {}, { start, limit: BRANCH_PAGE, changes: false });
        for (const branch of result.items) {
          if (!isString(branch?.ref)) throw malformed('Gerrit returned an invalid branch');
          if (branch.ref.startsWith('refs/heads/')) names.push(branch.ref.slice('refs/heads/'.length));
        }
        if (!result.hasMore) return names;
        if (start + BRANCH_PAGE >= COLLECTION_MAX_ITEMS) throw malformed('Gerrit project has more branches than OpenChamber reads');
      }
    },

    /**
     * Who can be asked to review. Gerrit has no project-member list a user
     * can read, so candidates are the owners and reviewers of the project's
     * recent changes. Ids are numeric account ids.
     */
    async listReviewerCandidates(directory, selector, remote) {
      const primary = await boundProject(directory, selector, remote);
      const changes = await client.get('/changes/', { q: `project:${primary.project}`, o: CANDIDATE_OPTIONS, n: REVIEWER_SAMPLE });
      if (!Array.isArray(changes)) throw malformed('Gerrit returned an invalid change list');
      const candidates = new Map();
      for (const raw of changes) {
        for (const account of [raw?.owner, ...(Array.isArray(raw?.reviewers?.REVIEWER) ? raw.reviewers.REVIEWER : [])]) {
          const user = mapGerritUser(account, identity);
          if (!user || candidates.has(user.id)) continue;
          candidates.set(user.id, user.avatarUrl ? { id: user.id, login: user.username, avatarUrl: user.avatarUrl } : { id: user.id, login: user.username });
        }
      }
      return [...candidates.values()];
    },

    /** A patchset's changes as one unified diff (`/patch` is a base64 mail; its diff part is kept). */
    async changeRequestPatch(directory, number, { project, remote, revision } = {}) {
      const { primary, raw } = await findChange(directory, number, project, remote, HEAD_OPTIONS);
      const sha = revisionOf(raw, revision);
      const patch = await client.base64(`${changePath(primary.project, number)}/revisions/${sha}/patch`);
      return { patch: diffOfPatch(patch.toString('utf8')), meta: { owner: primary.owner, repo: primary.name, number } };
    },

    /**
     * Both sides of one file: the patchset's first parent (`parent=1`) and
     * the patchset. `/COMMIT_MSG` is the commit message, which has no
     * earlier side.
     */
    async changeRequestFileContents(directory, number, { project, remote, path, previousPath, status, revision }) {
      const { primary, raw } = await findChange(directory, number, project, remote, HEAD_OPTIONS);
      const sha = revisionOf(raw, revision);
      const readFile = async (filePath, parent) => {
        const content = await client.base64(`${changePath(primary.project, number)}/revisions/${sha}/files/${enc(filePath)}/content`, parent ? { parent: 1 } : undefined);
        if (content.length > MAX_FULL_FILE_BYTES) {
          throw Object.assign(new Error('This file is too large to show in full'), { status: 413, code: 'file-too-large' });
        }
        return content.toString('utf8');
      };
      const [original, modified] = await Promise.all([
        status === 'A' || path === '/COMMIT_MSG' ? '' : readFile(previousPath || path, true),
        status === 'D' ? '' : readFile(path, false),
      ]);
      return { original, modified };
    },

    /**
     * Live state of known changes. A change Gerrit cannot answer is left
     * out, unknown rather than closed; a refused account fails the whole
     * read so it is reconciled. Gerrit has no issues.
     */
    async liveSummaries({ refs = [] }) {
      const summaries = await mapLimited(refs, LIVE_SUMMARY_CONCURRENCY, async (ref) => {
        try {
          return liveChangeSummary(ref, await client.get(changePath(joinProjectPath(ref.owner, ref.repo), ref.number), { o: LIVE_OPTIONS }));
        } catch (error) {
          if (statusOf(error) === 401) throw error;
          return null;
        }
      });
      return { summaries: summaries.filter(Boolean), issueSummaries: [] };
    },

    /** A change by number in the bound project, with every patchset. */
    async findChangeRequest(directory, number, selector, remote) {
      const { project, raw, request } = await findChange(directory, number, selector, remote, HEAD_OPTIONS);
      return { project, raw, request };
    },

    // Mutations.

    async resolveChangeRequestMutation(context, expected) {
      const { primary, project, request } = await findChange(context.directory, expected.number, expected.project, context.primaryRemote, MUTATION_OPTIONS);
      requireExpected(expected, request);
      return {
        providerTarget: { project: primary.project, number: request.number },
        target: mutationTarget(context, project, request),
      };
    },

    /** Submits only the patchset that was reviewed: a newer upload is a target mismatch. */
    async submit({ providerTarget, expectedTarget }) {
      requireCurrent(await readTarget(providerTarget), expectedTarget.headSha);
      const raw = await client.post(`${targetPath(providerTarget)}/submit`, {});
      return { merged: raw?.status === 'MERGED' };
    },

    async ready({ providerTarget }) {
      const current = await readTarget(providerTarget);
      if (current.work_in_progress !== true) return { ready: true };
      await client.post(`${targetPath(providerTarget)}/ready`, {});
      return { ready: true };
    },

    /** Closed is abandoned; open is restored. */
    async setState({ providerTarget, state }) {
      const raw = await client.post(`${targetPath(providerTarget)}/${state === 'closed' ? 'abandon' : 'restore'}`, {});
      if (!isPlainObject(raw) || raw._number !== providerTarget.number || changeState(raw.status) !== state) {
        throw malformed('Gerrit returned an unexpected change state');
      }
      return { state };
    },

    async reconcileChangeRequestMutation(providerTarget, kind) {
      const raw = await readTarget(providerTarget);
      if (kind === 'change-request-merge') return raw.status === 'MERGED' ? { state: 'succeeded', result: { merged: true } } : notApplied();
      if (kind === 'change-request-ready') return raw.work_in_progress !== true ? { state: 'succeeded', result: { ready: true } } : notApplied();
      return { state: 'outcome-unknown' };
    },

    async reconcileStateMutation(providerTarget, state) {
      const current = changeState((await readTarget(providerTarget)).status);
      if (current === state) return { state: 'succeeded', result: { state } };
      return current ? notApplied() : { state: 'outcome-unknown' };
    },

    /**
     * The whole reviewer set by account id: the difference is sent, one
     * account per call (additions, then removals), so the calls are not
     * atomic and reconciliation succeeds only when the set matches.
     */
    async setReviewers({ providerTarget, reviewers }) {
      const current = reviewerIds(await readTarget(providerTarget));
      const path = targetPath(providerTarget);
      for (const id of reviewers.filter((candidate) => !current.includes(candidate))) {
        const result = await client.post(`${path}/reviewers`, { reviewer: id });
        if (isString(result?.error) && result.error) throw Object.assign(new Error(result.error), { status: 400 });
      }
      for (const id of current.filter((candidate) => !reviewers.includes(candidate))) {
        await client.post(`${path}/reviewers/${enc(id)}/delete`, {});
      }
      return {};
    },

    /** Only a match is certain: another edit since may have moved the set either way. */
    async reconcileReviewers(providerTarget, names) {
      const current = reviewerIds(await readTarget(providerTarget));
      if (current.length !== names.length || !current.every((id) => names.includes(id))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    /** A change message, without votes. */
    async comment({ providerTarget, body }) {
      const result = await client.post(`${targetPath(providerTarget)}/revisions/current/review`, { message: body });
      if (!isPlainObject(result)) throw malformed('Gerrit returned an invalid review result');
      return {};
    },

    /**
     * Votes with an optional message, on the patchset the user read: the
     * current patchset is checked first and the review is posted to that
     * commit, so a newer upload is a target mismatch, never a vote on code
     * nobody looked at.
     */
    async vote({ providerTarget, votes, body, expectedTarget }) {
      requireCurrent(await readTarget(providerTarget), expectedTarget.headSha);
      const payload = { labels: votes };
      if (body !== undefined) payload.message = body;
      const result = await client.post(`${targetPath(providerTarget)}/revisions/${expectedTarget.headSha}/review`, payload);
      if (!isPlainObject(result)) throw malformed('Gerrit returned an invalid review result');
      if (isString(result.error) && result.error) throw Object.assign(new Error(result.error), { status: 400 });
      return { commented: body !== undefined };
    },
  };
}
