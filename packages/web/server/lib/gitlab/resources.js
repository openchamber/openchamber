import { mapGitLabCI, mapGitLabCommit, mapGitLabDiff, mapGitLabIssue, mapGitLabMergeRequest, mapGitLabNote, mapGitLabProject, mapGitLabUser, mapGitLabVerdictNote } from './mappers.js';
import { resolveGitLabProjectsFromDirectory } from './repo.js';
import { isPlainObject, isString } from './validation.js';

// GitLab has no draft parameter on merge-request create or edit; draft state is the
// title prefix GitLab itself recognizes ("Draft:", "[Draft]", "(Draft)").
const DRAFT_TITLE_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:)\s*/i;
const asDraftTitle = (title) => (DRAFT_TITLE_PREFIX.test(title) ? title : `Draft: ${title}`);
const asReadyTitle = (title) => title.replace(DRAFT_TITLE_PREFIX, '');
const text = (value) => (isString(value) && value ? value : '');

const PER_PAGE = 20;
// Collections a view shows in full (notes, diffs, branches) are read to the
// end within this bound; past it the read fails instead of passing a capped
// list off as complete.
const COLLECTION_PER_PAGE = 100;
// List filters: the picker's names to GitLab's.
const LIST_STATES = { open: 'opened', closed: 'closed', merged: 'merged', all: 'all' };
const LIST_SCOPES = { any: 'all', assigned: 'assigned_to_me', created: 'created_by_me' };
// The preview's timeline shows the newest commits only.
const TIMELINE_COMMIT_LIMIT = 50;
const COLLECTION_MAX_PAGES = 20;

function requireMapped(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function requestStatus(error) {
  return error?.cause?.response?.status ?? error?.response?.status ?? error?.status;
}

// Reads one page with GitBeaker's expanded response so `hasMore` comes from
// GitLab's own next-page header rather than from over-fetching.
function readPage(payload) {
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) return { items: null, hasMore: false };
  return { items: payload.data, hasMore: Boolean(payload.paginationInfo?.next) };
}

async function readCollection(load, message) {
  const page = readPage(await load({ maxPages: COLLECTION_MAX_PAGES, perPage: COLLECTION_PER_PAGE, showExpanded: true }));
  if (page.hasMore) throw new Error(message);
  return page.items;
}

function projectPath(owner, name) {
  return `${owner}/${name}`;
}

/**
 * One changed file as git prints it. GitLab's diff list carries only the
 * hunks; the `diff --git` header, mode, rename and `---`/`+++` lines are
 * rebuilt from its flags so the comparison view reads GitLab like GitHub. A
 * file GitLab sends without hunks (binary, or too large to diff) keeps its
 * header alone, the way git shows a metadata-only change.
 */
function gitPatchForDiff(file) {
  const oldPath = text(file.old_path) || file.new_path;
  const newPath = text(file.new_path) || file.old_path;
  const lines = [`diff --git a/${oldPath} b/${newPath}`];
  if (file.new_file === true) lines.push(`new file mode ${text(file.b_mode) || '100644'}`);
  else if (file.deleted_file === true) lines.push(`deleted file mode ${text(file.a_mode) || '100644'}`);
  else if (text(file.a_mode) && text(file.b_mode) && file.a_mode !== file.b_mode) lines.push(`old mode ${file.a_mode}`, `new mode ${file.b_mode}`);
  if (file.renamed_file === true) lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  const body = isString(file.diff) ? file.diff : '';
  if (body.startsWith('@@')) {
    lines.push(`--- ${file.new_file === true ? '/dev/null' : `a/${oldPath}`}`);
    lines.push(`+++ ${file.deleted_file === true ? '/dev/null' : `b/${newPath}`}`);
  }
  const header = `${lines.join('\n')}\n`;
  if (!body) return header;
  return `${header}${body.endsWith('\n') ? body : `${body}\n`}`;
}

// How many merge requests and issues one live-state read asks GitLab about at
// once; each is one REST call, so a sidebar full of links stays a short burst.
const LIVE_SUMMARY_CONCURRENCY = 4;
const PIPELINE_PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled']);

const upstreamStatusOf = (error) => error?.cause?.response?.status ?? error?.response?.status ?? error?.status;

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
 * A merge request's live state in the shape GitHub's summaries use, so one
 * badge rule colours both: orange only for a failed pipeline or a conflict,
 * and a merge request still waiting for approval keeps the open colour.
 */
function liveMergeRequestSummary(ref, raw) {
  if (!isPlainObject(raw) || !Number.isInteger(raw.iid)) return null;
  const state = raw.state === 'opened' ? 'open' : raw.state === 'merged' ? 'merged' : 'closed';
  const conflicts = raw.has_conflicts === true;
  const ready = raw.detailed_merge_status === 'mergeable';
  const pipeline = text(raw.head_pipeline?.status);
  let checks = null;
  if (state === 'open' && pipeline) {
    const outcome = pipeline === 'success' || pipeline === 'skipped' ? 'success'
      : pipeline === 'failed' || pipeline === 'canceled' ? 'failure'
        : PIPELINE_PENDING.has(pipeline) ? 'pending' : 'unknown';
    checks = {
      state: outcome,
      total: 1,
      success: outcome === 'success' ? 1 : 0,
      failure: outcome === 'failure' ? 1 : 0,
      pending: outcome === 'pending' ? 1 : 0,
    };
  }
  const summary = {
    owner: ref.owner,
    repo: ref.repo,
    number: raw.iid,
    state,
    draft: raw.draft === true || raw.work_in_progress === true,
    title: isString(raw.title) ? raw.title : '',
    mergeable: conflicts ? false : ready ? true : null,
    mergeableState: conflicts ? 'dirty' : ready ? 'clean' : null,
    checks,
  };
  if (text(raw.sha)) summary.headSha = raw.sha;
  return summary;
}

function liveIssueSummary(ref, raw) {
  if (!isPlainObject(raw) || !Number.isInteger(raw.iid)) return null;
  // GitLab closes an issue without saying whether it was done or dropped.
  return { owner: ref.owner, repo: ref.repo, number: raw.iid, title: isString(raw.title) ? raw.title : '', state: raw.state === 'opened' ? 'open' : 'completed' };
}

/** Above this the full-context view is no longer a readable diff, and the round trip is wasted. */
const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function createGitLabResourceService({ origin, client, resolveProjects = resolveGitLabProjectsFromDirectory, canonicalReads = false }) {
  const identity = { provider: 'gitlab', instance: origin };

  const showProject = async (path, remoteName) => {
    const raw = await client.Projects.show(path);
    if (canonicalReads && raw?.forked_from_project != null
      && (!isPlainObject(raw.forked_from_project) || !Number.isInteger(raw.forked_from_project.id))) {
      throw new Error('GitLab returned invalid fork metadata');
    }
    return { raw, project: requireMapped(mapGitLabProject(raw, identity, remoteName), 'GitLab returned an invalid project') };
  };

  const resolveDirectoryProjects = async (directory, remote) => {
    const resolved = canonicalReads
      ? await resolveProjects(directory, origin, remote, { exactRemote: true })
      : await resolveProjects(directory, origin, remote);
    const projects = [];
    for (const candidate of resolved.projects) {
      const item = await showProject(candidate.projectPath, candidate.remoteName);
      if (!projects.some((known) => known.project.id === item.project.id)) projects.push(item);
    }
    if (!projects.length) throw new Error('No GitLab project found for the repository remotes');
    return { ...resolved, projects };
  };

  const expandTargets = async (sources, options = {}) => {
    const targets = [...sources];
    for (const source of sources) {
      const parent = source.raw?.forked_from_project;
      const parentId = parent?.id;
      if (!Number.isInteger(parentId) || targets.some((item) => item.raw?.id === parentId)) continue;
      try {
        targets.push(await showProject(parentId));
      } catch (error) {
        const status = error?.cause?.response?.status ?? error?.response?.status ?? error?.status;
        if (status === 401 || options.requireComplete) throw error;
        // An inaccessible upstream does not invalidate the source project.
      }
    }
    return targets;
  };

  const constrainedProjectNetwork = async (directory, selector, remote, options = {}) => {
    const resolved = await resolveDirectoryProjects(directory, remote);
    const primary = resolved.projects[0];
    const targets = await expandTargets([primary], { ...options, requireComplete: Boolean(selector) || options.requireComplete });
    if (!selector) return { primary, target: targets[0], targets };
    const target = targets.find((candidate) => candidate.project.owner.toLowerCase() === selector.owner.toLowerCase()
      && candidate.project.name.toLowerCase() === selector.name.toLowerCase());
    if (target) return { primary, target, targets };
    const error = new Error('GitLab project is outside the bound repository network');
    error.status = 404;
    throw error;
  };
  const constrainedProject = async (...args) => (await constrainedProjectNetwork(...args)).target;

  // The account's own user, read once: review requests are filtered by name.
  let currentUsername = null;
  const readCurrentUsername = async () => {
    currentUsername ??= client.Users.showCurrentUser().then((user) => {
      if (!isPlainObject(user) || !isString(user.username) || !user.username.trim()) throw new Error('GitLab returned an invalid current user');
      return user.username;
    });
    return currentUsername;
  };

  /** A list's state and whose items, as GitLab's list parameters. */
  const listFilter = async (options, kind) => {
    const state = LIST_STATES[options.state] ?? 'opened';
    const people = options.people ?? 'any';
    if (people === 'reviewRequested') {
      return kind === 'pull' ? { state, scope: 'all', reviewerUsername: await readCurrentUsername() } : { state, scope: 'all' };
    }
    return { state: kind === 'issue' && state === 'merged' ? 'closed' : state, scope: LIST_SCOPES[people] ?? 'all' };
  };

  const listProjectMRs = (projectId, options) => client.MergeRequests.all({
    projectId,
    scope: options.scope ?? 'all',
    reviewerUsername: options.reviewerUsername,
    maxPages: 1,
    perPage: options.perPage ?? 100,
    page: options.page ?? 1,
    state: options.state,
    sourceBranch: options.sourceBranch,
    search: options.search,
    showExpanded: options.showExpanded,
    orderBy: 'updated_at',
    sort: 'desc',
  });

  const requireMergeRequest = (value, project, requireProjectIds = false) => {
    const mapped = requireMapped(mapGitLabMergeRequest(value, identity, project), 'GitLab returned an invalid merge request');
    if (value.author != null && (!isPlainObject(value.author)
      || !Number.isInteger(value.author.id) || !isString(value.author.username) || !value.author.username.trim())) {
      throw new Error('GitLab returned an invalid merge request');
    }
    if (requireProjectIds && (!Number.isInteger(value.source_project_id) || !Number.isInteger(value.target_project_id))) {
      throw new Error('GitLab returned an invalid merge request');
    }
    return mapped;
  };

  const requireMutationMergeRequest = (value, project) => {
    const request = requireMergeRequest(value, project, true);
    if (![true, false].includes(value.draft) && ![true, false].includes(value.work_in_progress)) {
      throw new Error('GitLab returned an invalid merge request draft state');
    }
    return request;
  };

  const requireUser = (value, message) => {
    if (!isPlainObject(value) || !Number.isInteger(value.id) || value.id < 0
      || !isString(value.username) || !value.username.trim()) throw new Error(message);
  };

  const requireIssue = (value, project) => {
    const mapped = requireMapped(mapGitLabIssue(value, identity, project), 'GitLab returned an invalid issue');
    if (value.author != null) requireUser(value.author, 'GitLab returned an invalid issue');
    if (value.assignees != null) {
      if (!Array.isArray(value.assignees)) throw new Error('GitLab returned an invalid issue');
      for (const assignee of value.assignees) requireUser(assignee, 'GitLab returned an invalid issue');
    }
    if (value.labels != null) {
      if (!Array.isArray(value.labels)) throw new Error('GitLab returned an invalid issue');
      for (const label of value.labels) {
        if (isString(label) && label.trim()) continue;
        if (!isPlainObject(label) || !isString(label.name) || !label.name.trim()
          || (label.color != null && (!isString(label.color) || !label.color.trim()))) {
          throw new Error('GitLab returned an invalid issue');
        }
      }
    }
    return mapped;
  };

  const requireIssueNote = (value, fallbackUrl) => {
    const mapped = requireMapped(mapGitLabNote(value, identity, fallbackUrl), 'GitLab returned an invalid issue note');
    if (value.author != null) requireUser(value.author, 'GitLab returned an invalid issue note');
    return mapped;
  };

  const readMergeRequestList = (payload, project) => {
    if (canonicalReads && !Array.isArray(payload)) throw new Error('GitLab returned an invalid merge request list');
    const items = asArray(payload);
    if (canonicalReads) {
      for (const item of items) requireMergeRequest(item, project, true);
    }
    return items;
  };

  const loadCI = async (targetProjectId, rawMR, details = false) => {
    const pipeline = rawMR?.head_pipeline ?? rawMR?.pipeline;
    if (!isPlainObject(pipeline) || !Number.isInteger(pipeline.id)
      || !isString(pipeline.status) || !pipeline.status.trim()) return null;
    try {
      const jobs = details
        // A fork merge request runs its pipeline in the source project.
        ? await client.Jobs.all(Number.isInteger(pipeline.project_id) ? pipeline.project_id : targetProjectId, {
          pipelineId: pipeline.id, maxPages: 1, perPage: 100,
        })
        : [];
      if (details && (!Array.isArray(jobs) || jobs.some((job) => !isPlainObject(job)
        || !Number.isInteger(job.id) || !isString(job.name) || !job.name.trim()
        || !isString(job.status) || !job.status.trim()))) {
        throw new Error('GitLab returned invalid CI jobs');
      }
      return mapGitLabCI(pipeline, jobs, identity);
    } catch {
      return null;
    }
  };

  const findByNumber = async (directory, number, selector, options = {}) => {
    if (options.constrainToPrimary) {
      const resolved = await resolveDirectoryProjects(directory, options.remote);
      const targets = await expandTargets([resolved.projects[0]], { requireComplete: canonicalReads });
      const selectedTargets = selector
        ? targets.filter((target) => target.project.owner.toLowerCase() === selector.owner.toLowerCase()
          && target.project.name.toLowerCase() === selector.name.toLowerCase())
        : targets;
      if (!selectedTargets.length) {
        const error = new Error('GitLab project is outside the bound repository network');
        error.status = 404;
        throw error;
      }
      for (const target of selectedTargets) {
        try {
          const raw = await client.MergeRequests.show(target.project.id, number);
          if (options.requireNetwork
            && (raw?.target_project_id !== target.raw.id
              || !targets.some((candidate) => candidate.raw.id === raw?.source_project_id))) {
            throw Object.assign(new Error('GitLab merge request is outside the bound repository network'), { status: 404 });
          }
          return { target, raw };
        } catch (error) {
          if (error?.cause?.response?.status === 404 || error?.response?.status === 404) continue;
          throw error;
        }
      }
      throw new Error(`GitLab merge request !${number} was not found`);
    }
    if (selector) {
      const target = await showProject(projectPath(selector.owner, selector.name));
      const raw = await client.MergeRequests.show(target.project.id, number);
      return { target, raw };
    }
    const resolved = await resolveDirectoryProjects(directory);
    const targets = await expandTargets(resolved.projects);
    for (const target of targets) {
      try {
        const raw = await client.MergeRequests.show(target.project.id, number);
        return { target, raw };
      } catch (error) {
        if (error?.cause?.response?.status === 404 || error?.response?.status === 404) continue;
        throw error;
      }
    }
    throw new Error(`GitLab merge request !${number} was not found`);
  };

  const compactProject = (project) => ({ id: project.id, owner: project.owner, name: project.name });
  const resolvedMutationTarget = (context, project, request = {}) => {
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

  const requireExpectedRequest = (expected, actual) => {
    for (const key of ['number', 'head', 'base', 'headSha']) {
      if (expected[key] !== undefined && expected[key] !== actual[key]) {
        throw Object.assign(new Error(`GitLab merge request ${key} changed`), {
          code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH',
          status: 409,
        });
      }
    }
  };

  const requireMutationResponse = (raw, project, providerTarget, expected) => {
    const request = requireMutationMergeRequest(raw, project);
    if (raw.target_project_id !== Number(providerTarget.targetProjectId ?? providerTarget.projectId)
      || (providerTarget.sourceProjectId !== undefined && raw.source_project_id !== Number(providerTarget.sourceProjectId))) {
      throw new Error('GitLab returned a merge request outside the resolved mutation target');
    }
    if (expected) requireExpectedRequest(expected, request);
    return request;
  };

  const readMutationRequest = async (context, expected) => {
    const { target, raw } = await findByNumber(context.directory, expected.number, expected.project, {
      constrainToPrimary: true,
      remote: context.primaryRemote,
      requireNetwork: true,
    });
    const request = requireMutationMergeRequest(raw, target.project);
    requireExpectedRequest(expected, request);
    return {
      providerTarget: { projectId: target.project.id, number: request.number },
      request,
      target: resolvedMutationTarget(context, target.project, request),
    };
  };

  const postNote = async (create) => {
    const raw = await create();
    if (!isPlainObject(raw) || !Number.isInteger(raw.id)) throw new Error('GitLab returned an invalid note');
  };

  // Requesting changes exists only in GitLab's GraphQL API. The path is
  // resolved against the REST base (/api/v4/), so it reaches /api/graphql
  // through the same credential and no-redirect requester.
  const REQUEST_CHANGES_MUTATION = `mutation($path: ID!, $iid: String!) {
  mergeRequestRequestChanges(input: { projectPath: $path, iid: $iid }) {
    mergeRequest { iid }
    errors
  }
}`;
  const requestChanges = async (project, number) => {
    const response = await client.MergeRequests.requester.post('../graphql', {
      body: { query: REQUEST_CHANGES_MUTATION, variables: { path: `${project.owner}/${project.name}`, iid: String(number) } },
    });
    const payload = response?.body;
    const result = payload?.data?.mergeRequestRequestChanges;
    const errors = [
      ...(Array.isArray(payload?.errors) ? payload.errors.map((error) => error?.message) : []),
      ...(Array.isArray(result?.errors) ? result.errors : []),
    ].filter((message) => isString(message) && message.trim());
    // GraphQL answers a refusal (not a reviewer, an older GitLab) with 200
    // and errors: nothing was changed.
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 422 });
    if (!isPlainObject(result?.mergeRequest)) throw new Error('GitLab returned an invalid request-changes result');
  };

  const resolveMutationActionTarget = async (payload) => {
    if (payload.providerTarget) {
      return {
        target: { project: payload.targetProject },
        projectId: payload.providerTarget.projectId ?? payload.targetProject.id,
        number: payload.providerTarget.number ?? payload.number,
      };
    }
    const { target } = await findByNumber(payload.directory, payload.number, payload.targetProject);
    return { target, projectId: target.project.id, number: payload.number };
  };

  return {
    async resolveCreateMutation(context, expected, options = {}) {
      if (options.remote !== undefined && options.remote !== context.primaryRemote) {
        throw Object.assign(new Error('GitLab mutation remote does not match the bound primary remote'), {
          code: 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH', status: 409,
        });
      }
      const headRemote = options.headRemote ?? context.primaryRemote;
      const network = await constrainedProjectNetwork(
        context.directory, expected.project, context.primaryRemote, { requireComplete: true },
      );
      let source = network.primary;
      if (headRemote !== context.primaryRemote) {
        const resolvedHead = await resolveDirectoryProjects(context.directory, headRemote);
        source = resolvedHead.projects[0];
        if (!network.targets.some((candidate) => candidate.project.id === source.project.id)) {
          throw Object.assign(new Error('GitLab mutation head remote is outside the bound repository network'), {
            code: 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH', status: 409,
          });
        }
      }
      return {
        providerTarget: { sourceProjectId: source.project.id, targetProjectId: network.target.project.id },
        target: resolvedMutationTarget(context, network.target.project, { head: expected.head, base: expected.base }),
      };
    },

    resolveChangeRequestMutation: readMutationRequest,

    async resolveIssueMutation(context, expected) {
      if (expected.head !== undefined || expected.base !== undefined || expected.headSha !== undefined) {
        throw Object.assign(new Error('GitLab issue target is invalid'), { code: 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT', status: 400 });
      }
      const target = await constrainedProject(context.directory, expected.project, context.primaryRemote);
      const issue = requireIssue(await client.Issues.show(expected.number, { projectId: target.project.id }), target.project);
      if (issue.number !== expected.number) throw new Error('GitLab returned an invalid issue');
      return {
        providerTarget: { projectId: target.project.id, number: issue.number },
        target: resolvedMutationTarget(context, target.project, { number: issue.number }),
      };
    },

    /** Close or reopen; GitLab refuses to reopen a merged merge request. */
    async setChangeRequestState(payload) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.MergeRequests.edit(projectId, number, { stateEvent: payload.state === 'closed' ? 'close' : 'reopen' });
      const request = requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
      if (request.state !== payload.state) throw new Error('GitLab returned an unexpected merge request state');
      return { state: request.state };
    },

    async setIssueState(payload) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.Issues.edit(projectId, number, { stateEvent: payload.state === 'closed' ? 'close' : 'reopen' });
      const issue = requireIssue(raw, payload.targetProject);
      if (issue.number !== number || issue.state !== payload.state) throw new Error('GitLab returned an unexpected issue state');
      return { state: issue.state };
    },

    /** One page of the project's labels, for the board's picker. */
    async listLabels(directory, selector, remote) {
      const target = await constrainedProject(directory, selector, remote);
      const raw = await client.ProjectLabels.all(target.project.id, { perPage: 100, maxPages: 1 });
      if (!Array.isArray(raw)) throw new Error('GitLab returned an invalid label list');
      return raw.flatMap((label) => {
        if (!isPlainObject(label) || !isString(label.name) || !label.name) return [];
        return [isString(label.color) && label.color ? { name: label.name, color: label.color.replace(/^#/, '') } : { name: label.name }];
      });
    },

    /** One page of the project's active members, inherited ones too: who can be asked to review. */
    async listReviewerCandidates(directory, selector, remote) {
      const target = await constrainedProject(directory, selector, remote);
      const raw = await client.ProjectMembers.all(target.project.id, { includeInherited: true, perPage: 100, maxPages: 1 });
      if (!Array.isArray(raw)) throw new Error('GitLab returned an invalid member list');
      return raw.flatMap((member) => {
        const user = member?.state === 'active' ? mapGitLabUser(member, identity) : null;
        if (!user) return [];
        return [user.avatarUrl ? { id: user.id, login: user.username, avatarUrl: user.avatarUrl } : { id: user.id, login: user.username }];
      });
    },

    /** The whole label set; an empty one clears them. */
    async setLabels(payload) {
      const { projectId, number } = payload.providerTarget;
      const update = { labels: payload.labels.join(',') };
      const raw = payload.kind === 'issue-labels'
        ? await client.Issues.edit(projectId, number, update)
        : await client.MergeRequests.edit(projectId, number, update);
      if (!isPlainObject(raw) || raw.iid !== number) throw new Error('GitLab returned an invalid edit result');
      return {};
    },

    /** The whole reviewer set, by user id; an empty one removes them all. */
    async setReviewers(payload) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.MergeRequests.edit(projectId, number, { reviewerIds: payload.reviewers.map(Number) });
      requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
      return {};
    },

    /** Only a match is certain: another edit since may have moved the set either way. */
    async reconcileSetMutation(providerTarget, kind, names) {
      const { projectId, number } = providerTarget;
      const raw = kind === 'issue-labels'
        ? await client.Issues.show(number, { projectId })
        : await client.MergeRequests.show(projectId, number);
      const current = kind === 'change-request-reviewers'
        ? (Array.isArray(raw?.reviewers) ? raw.reviewers.map((user) => String(user?.id)) : null)
        : (Array.isArray(raw?.labels) ? raw.labels.map((label) => (isString(label) ? label : label?.name)) : null);
      if (!current || current.length !== names.length || !current.every((entry) => names.includes(entry))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    async reconcileStateMutation(providerTarget, kind, state) {
      const { projectId, number } = providerTarget;
      const project = (await showProject(projectId)).project;
      const current = kind === 'issue-state'
        ? requireIssue(await client.Issues.show(number, { projectId }), project).state
        : requireMutationMergeRequest(await client.MergeRequests.show(projectId, number), project).state;
      if (current === state) return { state: 'succeeded', result: { state } };
      if (current === 'open' || current === 'closed') {
        return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
      }
      return { state: 'outcome-unknown' };
    },

    commentChangeRequest(payload) {
      const { projectId, number } = payload.providerTarget;
      return postNote(() => client.MergeRequestNotes.create(projectId, number, payload.body));
    },

    commentIssue(payload) {
      const { projectId, number } = payload.providerTarget;
      return postNote(() => client.IssueNotes.create(projectId, number, payload.body));
    },

    /**
     * The verdict first, then its text as a note: GitLab has no review that
     * carries both. A verdict that lands with a note that does not is still
     * a verdict, reported as `commented: false` so the text is not lost.
     */
    async reviewChangeRequest(payload) {
      const { projectId, number } = payload.providerTarget;
      if (payload.verdict === 'approve') {
        try {
          // The approval is for the commit the user read.
          await client.MergeRequestApprovals.approve(projectId, number, { sha: payload.expectedTarget.headSha });
        } catch (error) {
          const status = requestStatus(error);
          if (status === 409) {
            throw Object.assign(new Error('GitLab merge request headSha changed'), {
              code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409,
            });
          }
          // GitLab answers an approval it does not allow (your own merge
          // request, one already approved) with 401; the account is fine.
          if (status === 401) throw Object.assign(new Error('GitLab did not allow this approval'), { status: 403 });
          throw error;
        }
      } else {
        await requestChanges(payload.targetProject, number);
      }
      if (payload.body === undefined) return { commented: false };
      try {
        await postNote(() => client.MergeRequestNotes.create(projectId, number, payload.body));
        return { commented: true };
      } catch {
        return { commented: false };
      }
    },

    async reconcileCreateMutation(providerTarget, target) {
      const payload = readMergeRequestList(await listProjectMRs(providerTarget.targetProjectId, {
        state: 'all', sourceBranch: target.head, perPage: 100,
      }), target.project);
      const matches = payload.filter((raw) => raw?.source_project_id === Number(providerTarget.sourceProjectId)
        && raw?.target_project_id === Number(providerTarget.targetProjectId)
        && raw?.target_branch === target.base)
        .map((raw) => requireMutationMergeRequest(raw, target.project));
      return matches.length === 1 ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async reconcileChangeRequestMutation(providerTarget, kind) {
      const raw = await client.MergeRequests.show(providerTarget.projectId, providerTarget.number);
      const project = await showProject(providerTarget.projectId);
      const request = requireMutationMergeRequest(raw, project.project);
      if (kind === 'change-request-update') return { state: 'outcome-unknown' };
      if (kind === 'change-request-merge') {
        if (request.state === 'merged') return { state: 'succeeded', result: { merged: true } };
        if (request.state === 'open' || request.state === 'closed') {
          return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
        }
      }
      if (kind === 'change-request-ready') {
        if (!request.draft) return { state: 'succeeded', result: { ready: true } };
        return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
      }
      return { state: 'outcome-unknown' };
    },

    async changeRequestStatus(directory, branch, remote) {
      const resolved = await resolveDirectoryProjects(directory, remote);
      const targets = await expandTargets(resolved.projects, { requireComplete: canonicalReads });
      const sourceIds = new Set(resolved.projects.map((item) => item.raw.id));
      let selected = null;
      for (const target of targets) {
        const requests = readMergeRequestList(
          await listProjectMRs(target.project.id, { state: 'opened', sourceBranch: branch }),
          target.project,
        );
        const raw = requests.find((request) => sourceIds.has(request?.source_project_id)
          && request?.target_project_id === target.raw.id);
        if (raw) {
          selected = { target, raw };
          break;
        }
      }
      if (!selected) {
        const firstSource = resolved.projects[0];
        const historyTargetId = firstSource.raw?.forked_from_project?.id ?? firstSource.raw.id;
        const historyTarget = targets.find((item) => item.raw.id === historyTargetId) ?? firstSource;
        const history = readMergeRequestList(
          await listProjectMRs(historyTarget.project.id, { state: 'all', sourceBranch: branch }),
          historyTarget.project,
        );
        const raw = history.find((request) => request?.state === 'merged' || request?.state === 'closed');
        if (raw && raw.source_project_id === firstSource.raw.id) selected = { target: historyTarget, raw };
      }
      const first = resolved.projects[0];
      if (!selected) {
        return {
          identity,
          project: first.project,
          branch,
          changeRequest: null,
          resolvedRemoteName: first.project.remoteName ?? null,
          defaultBranch: first.project.defaultBranch ?? null,
        };
      }
      const request = canonicalReads
        ? requireMergeRequest(selected.raw, selected.target.project)
        : requireMapped(mapGitLabMergeRequest(selected.raw, identity, selected.target.project), 'GitLab returned an invalid merge request');
      const ci = await loadCI(selected.target.project.id, selected.raw);
      return {
        identity,
        project: selected.target.project,
        branch,
        changeRequest: request,
        ci,
        canMerge: selected.raw?.user?.can_merge === true || request.mergeable === true,
        resolvedRemoteName: first.project.remoteName ?? null,
        defaultBranch: selected.target.project.defaultBranch ?? null,
      };
    },

    async createChangeRequest(payload) {
      const title = payload.draft ? asDraftTitle(payload.title) : payload.title;
      if (payload.providerTarget) {
        const raw = await client.MergeRequests.create(payload.providerTarget.sourceProjectId, payload.head, payload.base, title, {
          description: payload.body,
          targetProjectId: payload.providerTarget.targetProjectId,
        });
        requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
        return {};
      }
      const resolved = await resolveDirectoryProjects(payload.directory, payload.headRemote || payload.remote);
      const source = resolved.projects[0];
      const target = payload.targetProject
        ? await showProject(projectPath(payload.targetProject.owner, payload.targetProject.name))
        : source.raw?.forked_from_project?.id ? await showProject(source.raw.forked_from_project.id) : source;
      const raw = await client.MergeRequests.create(source.project.id, payload.head, payload.base, title, {
        description: payload.body,
        targetProjectId: target.project.id,
      });
      return requireMapped(mapGitLabMergeRequest(raw, identity, target.project), 'GitLab returned an invalid merge request');
    },

    async updateChangeRequest(payload) {
      if (payload.providerTarget) {
        const raw = await client.MergeRequests.edit(payload.providerTarget.projectId, payload.providerTarget.number, {
          title: payload.title,
          description: payload.body,
        });
        requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
        return {};
      }
      const { target } = await findByNumber(payload.directory, payload.number, payload.targetProject);
      const raw = await client.MergeRequests.edit(target.project.id, payload.number, { title: payload.title, description: payload.body });
      return requireMapped(mapGitLabMergeRequest(raw, identity, target.project), 'GitLab returned an invalid merge request');
    },

    async mergeChangeRequest(payload) {
      if (payload.method === 'rebase') {
        const error = new Error('GitLab does not support rebase as an atomic merge method');
        error.status = 400;
        throw error;
      }
      const { target, projectId, number } = await resolveMutationActionTarget(payload);
      const expectedSha = payload.expectedTarget?.headSha;
      const mergeOptions = { squash: payload.method === 'squash' };
      // GitLab refuses the merge with 409 when the source branch moved past
      // the reviewed head, so a late push is never merged unreviewed.
      if (expectedSha) mergeOptions.sha = expectedSha;
      let raw;
      try {
        raw = await client.MergeRequests.merge(projectId, number, mergeOptions);
      } catch (error) {
        if (expectedSha && requestStatus(error) === 409) {
          throw Object.assign(new Error('GitLab merge request headSha changed'), {
            code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH',
            status: 409,
          });
        }
        throw error;
      }
      const request = payload.providerTarget
        ? requireMutationResponse(raw, target.project, payload.providerTarget, payload.expectedTarget)
        : requireMapped(mapGitLabMergeRequest(raw, identity, target.project), 'GitLab returned an invalid merge request');
      return { merged: request.state === 'merged', message: raw?.merge_error || undefined };
    },

    async readyChangeRequest(payload) {
      const { target, projectId, number } = await resolveMutationActionTarget(payload);
      const validate = (raw) => (payload.providerTarget
        ? requireMutationResponse(raw, target.project, payload.providerTarget, payload.expectedTarget)
        : requireMapped(mapGitLabMergeRequest(raw, identity, target.project), 'GitLab returned an invalid merge request'));
      const current = validate(await client.MergeRequests.show(projectId, number));
      if (!current.draft) return { ready: true };
      const request = validate(await client.MergeRequests.edit(projectId, number, { title: asReadyTitle(current.title) }));
      return { ready: !request.draft };
    },

    async listChangeRequests(directory, options = {}) {
      const resolved = await resolveDirectoryProjects(directory, options.remote);
      const targets = await expandTargets([resolved.projects[0]], { requireComplete: canonicalReads });
      const target = targets.at(-1);
      const page = readPage(await listProjectMRs(target.project.id, {
        ...await listFilter(options, 'pull'), page: options.page ?? 1, perPage: PER_PAGE, search: options.query, showExpanded: true,
      }));
      const rawItems = readMergeRequestList(page.items, target.project);
      const items = rawItems.map((raw) => canonicalReads
        ? requireMergeRequest(raw, target.project)
        : requireMapped(mapGitLabMergeRequest(raw, identity, target.project), 'GitLab returned an invalid merge request'));
      return { items, page: options.page ?? 1, hasMore: page.hasMore };
    },

    async changeRequestContext(directory, number, options = {}) {
      const { target, raw } = await findByNumber(directory, number, options.project, {
        constrainToPrimary: options.constrainToPrimary,
        remote: options.remote,
      });
      const [notes, diffs, ci, headProject, commitPage] = await Promise.all([
        readCollection((page) => client.MergeRequestNotes.all(target.project.id, number, page), 'GitLab merge request has more notes than OpenChamber reads'),
        options.includeDiff
          ? readCollection((page) => client.MergeRequests.allDiffs(target.project.id, number, page), 'GitLab merge request has more changed files than OpenChamber reads')
          : Promise.resolve([]),
        loadCI(target.project.id, raw, options.includeCIDetails),
        // A fork merge request's branch lives in the source project.
        Number.isInteger(raw?.source_project_id) && raw.source_project_id !== target.raw?.id
          ? showProject(raw.source_project_id).then((item) => item.project)
          : Promise.resolve(null),
        // The newest commits, newest first as GitLab lists them; only the
        // preview's timeline asks.
        options.includeTimeline
          ? client.MergeRequests.allCommits(target.project.id, number, { maxPages: 1, perPage: TIMELINE_COMMIT_LIMIT, showExpanded: true }).then(readPage)
          : Promise.resolve(null),
      ]);
      if (canonicalReads && !Array.isArray(notes)) throw new Error('GitLab returned an invalid merge request note list');
      if (canonicalReads && !Array.isArray(diffs)) throw new Error('GitLab returned an invalid merge request diff list');
      const mappedNotes = asArray(notes).flatMap((note) => {
        const mapped = mapGitLabNote(note, identity, raw.web_url);
        if (mapped) {
          if (canonicalReads && note.author != null && (!isPlainObject(note.author)
            || !Number.isInteger(note.author.id) || !isString(note.author.username) || !note.author.username.trim())) {
            throw new Error('GitLab returned an invalid merge request note');
          }
          if (canonicalReads && note.position != null && (!isPlainObject(note.position)
            || (!isString(note.position.new_path) && !isString(note.position.old_path)))) {
            throw new Error('GitLab returned an invalid merge request note');
          }
          return [mapped];
        }
        if (note?.system === true) return [];
        if (canonicalReads) throw new Error('GitLab returned an invalid merge request note');
        return [];
      });
      const files = asArray(diffs).flatMap((diff) => {
        const mapped = mapGitLabDiff(diff);
        if (mapped) return [mapped];
        if (canonicalReads) throw new Error('GitLab returned an invalid merge request diff');
        return [];
      });
      const changeRequest = canonicalReads
        ? requireMergeRequest(raw, target.project)
        : requireMapped(mapGitLabMergeRequest(raw, identity, target.project), 'GitLab returned an invalid merge request');
      if (headProject) changeRequest.headProject = headProject;
      const context = {
        identity,
        project: target.project,
        changeRequest,
        issueComments: mappedNotes.filter((note) => !note.path),
        reviewComments: mappedNotes.filter((note) => note.path),
        files,
        diff: files.map((file) => file.patch).filter(Boolean).join('\n'),
        ci,
      };
      if (!options.includeTimeline) return context;
      if (canonicalReads && !Array.isArray(commitPage?.items)) throw new Error('GitLab returned an invalid merge request commit list');
      return {
        ...context,
        commits: asArray(commitPage?.items).flatMap((commit) => {
          const mapped = mapGitLabCommit(commit);
          return mapped ? [mapped] : [];
        }).reverse(),
        // More than one page means the list above is only the newest ones.
        commitsComplete: !commitPage?.hasMore,
        // Who is asked to review, for the preview's reviewer picker.
        reviewers: asArray(raw.reviewers).flatMap((user) => {
          const mapped = mapGitLabUser(user, identity);
          return mapped ? [mapped] : [];
        }),
        verdicts: asArray(notes).flatMap((note) => {
          const mapped = mapGitLabVerdictNote(note, identity, raw.web_url);
          return mapped ? [mapped] : [];
        }),
      };
    },

    async listIssues(directory, options = {}) {
      const resolved = await resolveDirectoryProjects(directory, options.remote);
      const target = resolved.projects[0];
      const page = readPage(await client.Issues.all({
        projectId: target.project.id, ...await listFilter(options, 'issue'), page: options.page ?? 1,
        perPage: PER_PAGE, maxPages: 1, search: options.query, showExpanded: true,
      }));
      if (canonicalReads && !Array.isArray(page.items)) throw new Error('GitLab returned an invalid issue list');
      const rawItems = asArray(page.items);
      const items = rawItems.flatMap((raw) => {
        if (raw?.issue_type === 'incident' || raw?.issue_type === 'test_case') return [];
        if (canonicalReads) return [requireIssue(raw, target.project)];
        const issue = mapGitLabIssue(raw, identity, target.project);
        return issue ? [issue] : [];
      });
      return { items, page: options.page ?? 1, hasMore: page.hasMore };
    },

    async getIssue(directory, number, selector, remote) {
      const target = await constrainedProject(directory, selector, remote);
      const raw = await client.Issues.show(number, { projectId: target.project.id });
      return canonicalReads
        ? requireIssue(raw, target.project)
        : requireMapped(mapGitLabIssue(raw, identity, target.project), 'GitLab returned an invalid issue');
    },

    /**
     * A merge request's changes as one unified diff. GitLab diffs a merge
     * request against its merge base, so, like a GitHub pull request diff,
     * work merged in from the target branch is not part of it. The merge
     * request must belong to the bound repository's network.
     */
    async changeRequestPatch(directory, number, options = {}) {
      const { target } = await findByNumber(directory, number, options.project, {
        constrainToPrimary: true, remote: options.remote, requireNetwork: true,
      });
      const diffs = await readCollection((page) => client.MergeRequests.allDiffs(target.project.id, number, page), 'GitLab merge request has more changed files than OpenChamber reads');
      if (!Array.isArray(diffs)) throw new Error('GitLab returned an invalid merge request diff list');
      const files = diffs.filter((diff) => isPlainObject(diff) && (text(diff.new_path) || text(diff.old_path)));
      if (files.length !== diffs.length) throw new Error('GitLab returned an invalid merge request diff');
      return {
        patch: files.map(gitPatchForDiff).join(''),
        meta: { owner: target.project.owner, repo: target.project.name, number },
      };
    },

    /**
     * Both sides of one file as GitLab has them, for expanding collapsed
     * context without the working tree. The base side is the merge base the
     * diff was taken against, never the target branch tip. A fork's head
     * commit is reachable from the target project, so every read goes there.
     */
    async changeRequestFileContents(directory, number, { project, remote, path, previousPath, status }) {
      const { target, raw } = await findByNumber(directory, number, project, {
        constrainToPrimary: true, remote, requireNetwork: true,
      });
      const baseSha = raw?.diff_refs?.base_sha;
      const headSha = raw?.diff_refs?.head_sha;
      if (!COMMIT_SHA.test(String(baseSha)) || !COMMIT_SHA.test(String(headSha))) {
        throw new Error('GitLab returned invalid merge request refs');
      }
      const readFile = async (filePath, ref) => {
        const content = await client.RepositoryFiles.showRaw(target.project.id, filePath, ref);
        const value = content instanceof Blob ? await content.text() : content;
        if (!isString(value)) throw new Error('GitLab returned invalid file contents');
        if (Buffer.byteLength(value) > MAX_FULL_FILE_BYTES) {
          throw Object.assign(new Error('This file is too large to show in full'), { status: 413, code: 'file-too-large' });
        }
        return value;
      };
      const [original, modified] = await Promise.all([
        status === 'A' ? '' : readFile(previousPath || path, baseSha),
        status === 'D' ? '' : readFile(path, headSha),
      ]);
      return { original, modified };
    },

    /**
     * Live state of merge requests and issues already known by project path
     * and number, for the sidebar and the session's linked items. An item
     * GitLab cannot answer is left out, unknown rather than closed; a refused
     * token fails the whole read so the account is reconciled.
     */
    async liveSummaries({ refs = [], issueRefs = [] }) {
      const read = async (ref, load, map) => {
        try {
          return map(ref, await load(`${ref.owner}/${ref.repo}`, ref.number));
        } catch (error) {
          if (upstreamStatusOf(error) === 401) throw error;
          return null;
        }
      };
      const [summaries, issueSummaries] = await Promise.all([
        mapLimited(refs, LIVE_SUMMARY_CONCURRENCY, (ref) => read(ref, (path, number) => client.MergeRequests.show(path, number), liveMergeRequestSummary)),
        mapLimited(issueRefs, LIVE_SUMMARY_CONCURRENCY, (ref) => read(ref, (path, number) => client.Issues.show(number, { projectId: path }), liveIssueSummary)),
      ]);
      return { summaries: summaries.filter(Boolean), issueSummaries: issueSummaries.filter(Boolean) };
    },

    async issueComments(directory, number, selector, remote) {
      const target = await constrainedProject(directory, selector, remote);
      const issue = await client.Issues.show(number, { projectId: target.project.id });
      const mappedIssue = canonicalReads
        ? requireIssue(issue, target.project)
        : requireMapped(mapGitLabIssue(issue, identity, target.project), 'GitLab returned an invalid issue');
      const notes = await readCollection((page) => client.IssueNotes.all(target.project.id, number, page), 'GitLab issue has more comments than OpenChamber reads');
      if (canonicalReads && !Array.isArray(notes)) throw new Error('GitLab returned an invalid issue note list');
      return asArray(notes).flatMap((note) => {
        if (note?.system === true) return [];
        if (canonicalReads) return [requireIssueNote(note, mappedIssue.url)];
        const mapped = mapGitLabNote(note, identity, mappedIssue.url);
        return mapped ? [mapped] : [];
      });
    },

    async projectUpstream(directory, remote) {
      const source = (await resolveDirectoryProjects(directory, remote)).projects[0];
      const parentId = source.raw?.forked_from_project?.id;
      if (!Number.isInteger(parentId)) return { identity, isFork: false, upstream: null };
      const parent = await showProject(parentId);
      return { identity, isFork: true, upstream: parent.project };
    },

    async projectBranches(directory, selector, remote) {
      const target = await constrainedProject(directory, selector, remote, { requireComplete: true });
      const payload = await readCollection((page) => client.Branches.all(target.project.id, page), 'GitLab project has more branches than OpenChamber reads');
      if (canonicalReads && !Array.isArray(payload)) throw new Error('GitLab returned an invalid branch list');
      return asArray(payload).flatMap((branch) => {
        if (isString(branch?.name) && branch.name.trim()) return [branch.name];
        if (canonicalReads) throw new Error('GitLab returned an invalid branch');
        return [];
      });
    },
  };
}
