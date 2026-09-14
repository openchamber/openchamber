import { mapGitLabCI, mapGitLabDiff, mapGitLabIssue, mapGitLabMergeRequest, mapGitLabNote, mapGitLabProject } from './mappers.js';
import { resolveGitLabProjectsFromDirectory } from './repo.js';
import { isPlainObject, isString } from './validation.js';

// GitLab has no draft parameter on merge-request create or edit; draft state is the
// title prefix GitLab itself recognizes ("Draft:", "[Draft]", "(Draft)").
const DRAFT_TITLE_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:)\s*/i;
const asDraftTitle = (title) => (DRAFT_TITLE_PREFIX.test(title) ? title : `Draft: ${title}`);
const asReadyTitle = (title) => title.replace(DRAFT_TITLE_PREFIX, '');

const PER_PAGE = 20;

function requireMapped(value, message) {
  if (!value) throw new Error(message);
  return value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function projectPath(owner, name) {
  return `${owner}/${name}`;
}

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

  const listProjectMRs = (projectId, options) => client.MergeRequests.all({
    projectId,
    scope: 'all',
    maxPages: 1,
    perPage: options.perPage ?? 100,
    page: options.page ?? 1,
    state: options.state,
    sourceBranch: options.sourceBranch,
    search: options.search,
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
        ? await client.Jobs.all(targetProjectId, { pipelineId: pipeline.id, maxPages: 1, perPage: 100 })
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
      const raw = await client.MergeRequests.merge(projectId, number, { squash: payload.method === 'squash' });
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
      const rawItems = readMergeRequestList(await listProjectMRs(target.project.id, {
        state: 'opened', page: options.page ?? 1, perPage: PER_PAGE + 1, search: options.query,
      }), target.project);
      const items = rawItems.slice(0, PER_PAGE).map((raw) => canonicalReads
        ? requireMergeRequest(raw, target.project)
        : requireMapped(mapGitLabMergeRequest(raw, identity, target.project), 'GitLab returned an invalid merge request'));
      return { items, page: options.page ?? 1, hasMore: rawItems.length > PER_PAGE };
    },

    async changeRequestContext(directory, number, options = {}) {
      const { target, raw } = await findByNumber(directory, number, options.project, {
        constrainToPrimary: options.constrainToPrimary,
        remote: options.remote,
      });
      const [notes, diffs, ci] = await Promise.all([
        client.MergeRequestNotes.all(target.project.id, number, { maxPages: 2, perPage: 100 }),
        options.includeDiff ? client.MergeRequests.allDiffs(target.project.id, number, { maxPages: 2, perPage: 100 }) : Promise.resolve([]),
        loadCI(target.project.id, raw, options.includeCIDetails),
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
      return {
        identity,
        project: target.project,
        changeRequest: canonicalReads
          ? requireMergeRequest(raw, target.project)
          : requireMapped(mapGitLabMergeRequest(raw, identity, target.project), 'GitLab returned an invalid merge request'),
        issueComments: mappedNotes.filter((note) => !note.path),
        reviewComments: mappedNotes.filter((note) => note.path),
        files,
        diff: files.map((file) => file.patch).filter(Boolean).join('\n'),
        ci,
      };
    },

    async listIssues(directory, options = {}) {
      const resolved = await resolveDirectoryProjects(directory, options.remote);
      const target = resolved.projects[0];
      const payload = await client.Issues.all({
        projectId: target.project.id, scope: 'all', state: 'opened', page: options.page ?? 1,
        perPage: PER_PAGE + 1, maxPages: 1, search: options.query,
      });
      if (canonicalReads && !Array.isArray(payload)) throw new Error('GitLab returned an invalid issue list');
      const rawItems = asArray(payload);
      const items = rawItems.slice(0, PER_PAGE).flatMap((raw) => {
        if (raw?.issue_type === 'incident' || raw?.issue_type === 'test_case') return [];
        if (canonicalReads) return [requireIssue(raw, target.project)];
        const issue = mapGitLabIssue(raw, identity, target.project);
        return issue ? [issue] : [];
      });
      return { items, page: options.page ?? 1, hasMore: rawItems.length > PER_PAGE };
    },

    async getIssue(directory, number, selector, remote) {
      const target = await constrainedProject(directory, selector, remote);
      const raw = await client.Issues.show(target.project.id, number);
      return canonicalReads
        ? requireIssue(raw, target.project)
        : requireMapped(mapGitLabIssue(raw, identity, target.project), 'GitLab returned an invalid issue');
    },

    async issueComments(directory, number, selector, remote) {
      const target = await constrainedProject(directory, selector, remote);
      const issue = await client.Issues.show(target.project.id, number);
      const mappedIssue = canonicalReads
        ? requireIssue(issue, target.project)
        : requireMapped(mapGitLabIssue(issue, identity, target.project), 'GitLab returned an invalid issue');
      const notes = await client.IssueNotes.all(target.project.id, number, { maxPages: 2, perPage: 100 });
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
      const payload = await client.Branches.all(target.project.id, { maxPages: 2, perPage: 100 });
      if (canonicalReads && !Array.isArray(payload)) throw new Error('GitLab returned an invalid branch list');
      return asArray(payload).flatMap((branch) => {
        if (isString(branch?.name) && branch.name.trim()) return [branch.name];
        if (canonicalReads) throw new Error('GitLab returned an invalid branch');
        return [];
      });
    },
  };
}
