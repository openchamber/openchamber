import { documentDataUrl } from '../source-control/document-versions.js';
import { createHash } from 'node:crypto';
import { pairedDiffLine } from '../source-control/review-position.js';
import { changeRequestNetworkTarget } from '../source-control/repository-network.js';
import { mapGitLabCI, mapGitLabCommit, mapGitLabDiff, mapGitLabIssue, mapGitLabMergeRequest, mapGitLabNote, mapGitLabProject, mapGitLabUser, mapGitLabVerdictNote } from './mappers.js';
import { resolveGitLabProjectsFromDirectory } from './repo.js';
import { isPlainObject as isPlain, isPresent, isString } from './validation.js';
import type { SourceControlMutationTarget, SourceControlProjectRef } from '@openchamber/sdk';
import type { ProviderReadContext } from '../source-control/provider-contract.js';
import type { reviewCommentPosition } from '../source-control/review-position.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { createGitLabClient, createGitLabDownloader, GitLabDownloadOptions, GitLabRequesterOptions } from './client.js';
import type { GitLabMappedProject } from './mappers.js';

type Client = ReturnType<typeof createGitLabClient>;
type Query = NonNullable<GitLabRequesterOptions['searchParams']>;
type Reply = Awaited<ReturnType<Client['Projects']['show']>>;
type Field = JsonValue | undefined;
type Selector = Pick<SourceControlProjectRef, 'owner' | 'name'> | null | undefined;
type Remote = string | undefined;
type Project = { raw: JsonObject & { id: number }; project: GitLabMappedProject };
type Projects = [Project, ...Project[]];
type ReadOptions = { remote?: Remote; linked?: boolean | undefined; requireComplete?: boolean | undefined;
  constrainToPrimary?: boolean | undefined; requireNetwork?: boolean | undefined; project?: Selector };
type ListOptions = { labels?: string[] | undefined; state?: string | undefined; people?: string | undefined; remote?: Remote;
  page?: number | undefined; query?: string | undefined };
type ListFilter = { state: string; scope: string; reviewerUsername?: string; labels?: string };
type MRListOptions = { state: string; scope?: string; reviewerUsername?: string; perPage?: number; page?: number;
  sourceBranch?: string | undefined; search?: string | undefined; showExpanded?: boolean; labels?: string };
type ListPage = { maxPages: number; perPage: number; showExpanded: true };
type Context = Pick<ProviderReadContext, 'directory' | 'repositoryId' | 'bindingRevision' | 'primaryRemote'>;
type Coordinates = { [K in 'number' | 'head' | 'base' | 'headSha']?: SourceControlMutationTarget[K] | undefined };
type Expected = Coordinates & { project: NonNullable<Selector> };
type NumberedTarget = { projectId: string; number: number };
type CreateTarget = { sourceProjectId: string; targetProjectId: string };
type ExistingMutation = { providerTarget: NumberedTarget; targetProject: SourceControlProjectRef; expectedTarget?: Coordinates; number?: number };
type CreateMutation = { providerTarget: CreateTarget; targetProject: SourceControlProjectRef; expectedTarget?: Coordinates };
type LegacyMutation = { providerTarget?: undefined; directory: string; number: number; targetProject?: Selector; expectedTarget?: Coordinates };
type ActionPayload = ExistingMutation | LegacyMutation;
type TitleBody = { title: string; body?: string | undefined };
type CreateFields = TitleBody & { head: string; base: string; draft: boolean };
type LegacyCreate = { providerTarget?: undefined; directory: string; headRemote?: Remote; remote?: Remote; targetProject?: Selector };
type ContextOptions = ReadOptions & { includeDiff?: boolean | undefined; includeCIDetails?: boolean | undefined; includeTimeline?: boolean | undefined };
type WithTarget = { providerTarget: NumberedTarget };
type WithBody = { body: string };
type WithComment = { commentId: string };
type Position = ReturnType<typeof reviewCommentPosition>;
type Permissions = { resolve: Map<Field, boolean>; reply: boolean };
type ReviewFields = { id: number; note: string };
type ChainLink = JsonObject & { iid: number; source_branch: string; target_branch: string; web_url: string };
type Ref = { owner: string; repo: string; number: number };
type LiveDetails = { failedChecks: string[]; recentActivity: Array<{ author: string; at: string }> };

export interface GitLabResourceOptions {
  origin: string;
  client: Client;
  download?: ReturnType<typeof createGitLabDownloader>;
  resolveProjects?: typeof resolveGitLabProjectsFromDirectory;
  canonicalReads?: boolean;
  providerUserId?: string;
}

const isPlainObject = (value: Reply | undefined): value is JsonObject => isPlain(value);
const hasFields = (value: unknown): value is JsonObject => value != null;
const obj = (value: Reply | undefined): JsonObject | undefined => hasFields(value) ? value : undefined;
const record = (value: Reply | undefined): JsonObject => {
  if (!hasFields(value)) throw new TypeError('Missing response object');
  return value;
};
const array = (value: Reply | undefined): value is JsonValue[] => Array.isArray(value);
const integer = (value: Field): value is number => Number.isInteger(value);
const hasIid = (value: Reply | undefined): value is JsonObject & { iid: number } => isPlainObject(value) && integer(value.iid);
const hasId = (value: Reply): value is JsonObject & { id: number } => isPlainObject(value) && integer(value.id);
const last = (values: Projects): Project => values.at(-1) ?? values[0];

const DRAFT_TITLE_PREFIX = /^\s*(?:\[draft\]|\(draft\)|draft:)\s*/i;
const asDraftTitle = (title: string) => (DRAFT_TITLE_PREFIX.test(title) ? title : `Draft: ${title}`);
const asReadyTitle = (title: string) => title.replace(DRAFT_TITLE_PREFIX, '');
const text = (value: Field) => (isString(value) && value ? value : '');

const PER_PAGE = 20;
const COLLECTION_PER_PAGE = 100;
interface ListValues { [key: string]: string | undefined }
const LIST_STATES: ListValues = { open: 'opened', closed: 'closed', merged: 'merged', all: 'all' };
const LIST_SCOPES: ListValues = { any: 'all', assigned: 'assigned_to_me', created: 'created_by_me' };

const labelFilter = (labels: ListOptions['labels']) => {
  if (!Array.isArray(labels) || labels.length === 0) return null;
  if (labels.some((label) => !isString(label) || label.includes(','))) {
    throw Object.assign(new Error('A GitLab label name cannot contain a comma'), {
      code: 'INVALID_SOURCE_CONTROL_READ_CONTEXT', status: 400,
    });
  }
  return labels.join(',');
};
const TIMELINE_COMMIT_LIMIT = 50;
const COLLECTION_MAX_PAGES = 20;
// external: https://gitlab.com/gitlab-org/gitlab/-/issues/427168 GitLab before 18.0 answers a merge request's diff list with 500 for any page larger than 30, and self-managed instances still run those versions.
const DIFF_PER_PAGE = 30;

function requireMapped<T>(value: T | null, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function asArray(value: Reply | undefined) {
  return array(value) ? value : [];
}

interface Failure { status?: unknown; response?: { status?: unknown }; cause?: { response?: { status?: unknown } } }
const hasFailure = (value: unknown): value is Failure => value != null;
function requestStatus(cause: unknown) {
  const error = hasFailure(cause) ? cause : undefined;
  return error?.cause?.response?.status ?? error?.response?.status ?? error?.status;
}

function readPage(payload: Reply) {
  if (!isPlainObject(payload) || !array(payload.data)) return { items: null, hasMore: false };
  return { items: payload.data, hasMore: Boolean(obj(payload.paginationInfo)?.next) };
}

async function readCollection(load: (options: ListPage) => Promise<Reply>, message: string, perPage = COLLECTION_PER_PAGE) {
  const maxPages = Math.ceil((COLLECTION_MAX_PAGES * COLLECTION_PER_PAGE) / perPage);
  const page = readPage(await load({ maxPages, perPage, showExpanded: true }));
  if (page.hasMore) throw new Error(message);
  return page.items;
}

function projectPath(owner: string, name: string) {
  return `${owner}/${name}`;
}

function gitPatchForDiff(file: JsonObject) {
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

const LIVE_SUMMARY_CONCURRENCY = 4;
const PIPELINE_PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled']);

async function mapLimited<Item, Result>(items: Item[], limit: number, task: (item: Item | undefined) => Promise<Result>) {
  const results = new Array<Result>(items.length);
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

function liveMergeRequestSummary(ref: Ref, raw: Reply) {
  if (!hasIid(raw)) return null;
  const state = raw.state === 'opened' ? 'open' : raw.state === 'merged' ? 'merged' : 'closed';
  const conflicts = raw.has_conflicts === true;
  const ready = raw.detailed_merge_status === 'mergeable';
  const pipeline = text(obj(raw.head_pipeline)?.status);
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
  if (text(raw.sha)) Object.assign(summary, { headSha: raw.sha });
  if (text(raw.target_branch)) Object.assign(summary, { base: raw.target_branch });
  if (integer(raw.user_notes_count)) Object.assign(summary, { activity: raw.user_notes_count });
  return summary;
}

function liveIssueSummary(ref: Ref, raw: Reply) {
  if (!hasIid(raw)) return null;
  return { owner: ref.owner, repo: ref.repo, number: raw.iid, title: isString(raw.title) ? raw.title : '', state: raw.state === 'opened' ? 'open' : 'completed' };
}

const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function createGitLabResourceService({ origin, client, download, resolveProjects = resolveGitLabProjectsFromDirectory, canonicalReads = false, providerUserId = '' }: GitLabResourceOptions) {
  const identity = { provider: 'gitlab', instance: origin };

  const accountUserId = (() => {
    if (!isString(providerUserId)) return null;
    const id = Number(providerUserId.slice(providerUserId.lastIndexOf('#') + 1));
    return Number.isSafeInteger(id) ? id : null;
  })();
  const noteCapabilities = (note: Reply) => {
    const mine = accountUserId !== null && obj(obj(note)?.author)?.id === accountUserId;
    return { canUpdate: mine, canDelete: mine };
  };

  const showProject = async (path: Field, remoteName?: string): Promise<Project> => {
    const raw = await client.Projects.show(path);
    const fork = obj(raw)?.forked_from_project;
    if (canonicalReads && fork != null && !hasId(fork)) {
      throw new Error('GitLab returned invalid fork metadata');
    }
    if (!hasId(raw)) throw new Error('GitLab returned an invalid project');
    return { raw, project: requireMapped(mapGitLabProject(raw, identity, remoteName), 'GitLab returned an invalid project') };
  };

  const resolveDirectoryProjects = async (directory: string, remote?: Remote) => {
    const resolved = canonicalReads
      ? await resolveProjects(directory, origin, remote, { exactRemote: true })
      : await resolveProjects(directory, origin, remote);
    const projects: Project[] = [];
    for (const candidate of resolved.projects) {
      const item = await showProject(candidate.projectPath, candidate.remoteName);
      if (!projects.some((known) => known.project.id === item.project.id)) projects.push(item);
    }
    const [first, ...rest] = projects;
    if (!first) throw new Error('No GitLab project found for the repository remotes');
    const ordered: Projects = [first, ...rest];
    return { ...resolved, projects: ordered };
  };

  const expandTargets = async (sources: Projects, options: ReadOptions = {}) => {
    const targets: Projects = [...sources];
    for (const source of sources) {
      const parent = source.raw?.forked_from_project;
      const parentId = obj(parent)?.id;
      if (!integer(parentId) || targets.some((item) => item.raw?.id === parentId)) continue;
      try {
        targets.push(await showProject(parentId));
      } catch (error) {
        const status = requestStatus(error);
        if (status === 401 || options.requireComplete) throw error;
      }
    }
    return targets;
  };

  const constrainedProjectNetwork = async (directory: string, selector: Selector, remote: Remote, options: ReadOptions = {}): Promise<{ primary: Project; target: Project; targets: Projects }> => {
    if (options.linked && selector) {
      const target = await showProject(projectPath(selector.owner, selector.name));
      return { primary: target, target, targets: [target] };
    }
    const resolved = await resolveDirectoryProjects(directory, remote);
    const primary = resolved.projects[0];
    const targets = await expandTargets([primary], { ...options, requireComplete: Boolean(selector) || options.requireComplete });
    if (!selector) return { primary, target: targets[0], targets };
    const target = targets.find((candidate) => candidate.project.owner.toLowerCase() === selector.owner.toLowerCase()
      && candidate.project.name.toLowerCase() === selector.name.toLowerCase());
    if (target) return { primary, target, targets };
    throw Object.assign(new Error('GitLab project is outside the bound repository network'), { status: 404 });
  };
  const constrainedProject = async (...args: Parameters<typeof constrainedProjectNetwork>) => (await constrainedProjectNetwork(...args)).target;

  let currentUsername: Promise<string> | null = null;
  const readCurrentUsername = async () => {
    currentUsername ??= client.Users.showCurrentUser().then((user) => {
      if (!isPlainObject(user) || !isString(user.username) || !user.username.trim()) throw new Error('GitLab returned an invalid current user');
      return user.username;
    });
    return currentUsername;
  };

  const listFilter = async (options: ListOptions, kind: 'issue' | 'pull') => {
    const labels = labelFilter(options.labels);
    const state = LIST_STATES[String(options.state)] ?? 'opened';
    const people = options.people ?? 'any';
    const filter: ListFilter = people === 'reviewRequested'
      ? { state, scope: 'all' }
      : { state: kind === 'issue' && state === 'merged' ? 'closed' : state, scope: LIST_SCOPES[people] ?? 'all' };
    if (people === 'reviewRequested' && kind === 'pull') filter.reviewerUsername = await readCurrentUsername();
    return labels === null ? filter : { ...filter, labels };
  };

  const listProjectMRs = (projectId: string, options: MRListOptions) => {
    const query: Query = {
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
      withLabelsDetails: true,
      orderBy: 'updated_at',
      sort: 'desc',
    };
    if (options.labels) query.labels = options.labels;
    return client.MergeRequests.all(query);
  };

  const CHAIN_LINK_LIMIT = 10;
  const isChainLink = (raw: Reply | undefined, projectId: number): raw is ChainLink => hasIid(raw)
    && isString(raw.source_branch) && isString(raw.target_branch) && isString(raw.web_url)
    && raw.source_branch !== raw.target_branch
    && String(raw.source_project_id) === String(projectId) && String(raw.target_project_id) === String(projectId);
  const openMergeRequestOn = async (projectId: number, filter: { sourceBranch: string } | { targetBranch: string }) => {
    const page = readPage(await client.MergeRequests.all({ projectId, state: 'opened', maxPages: 1, perPage: 2, showExpanded: true, ...filter }));
    const items = asArray(page.items);
    const [first] = items;
    return items.length === 1 && isChainLink(first, projectId) ? first : null;
  };
  const chainLayer = (raw: ChainLink) => ({
    number: raw.iid,
    title: isString(raw.title) ? raw.title : '',
    url: isString(raw.web_url) ? raw.web_url : '',
    state: raw.state === 'opened' ? 'open' : raw.state === 'merged' ? 'merged' : 'closed',
    draft: raw.draft === true || raw.work_in_progress === true,
    head: raw.source_branch,
  });
  const readChain = async (raw: Reply, defaultBranch: string | null) => {
    const fields = obj(raw);
    const projectId = fields?.target_project_id;
    if (fields?.state !== 'opened' || !integer(projectId) || !isChainLink(raw, projectId)) return null;
    const seen = new Set([raw.iid]);
    const below = [];
    let base = raw.target_branch;
    for (let link = 0; link < CHAIN_LINK_LIMIT && base !== defaultBranch; link += 1) {
      const next = await openMergeRequestOn(projectId, { sourceBranch: base });
      if (!next || seen.has(next.iid)) break;
      seen.add(next.iid);
      below.unshift(chainLayer(next));
      base = next.target_branch;
    }
    const above = [];
    let head = raw.source_branch;
    for (let link = 0; link < CHAIN_LINK_LIMIT && head !== defaultBranch; link += 1) {
      const next = await openMergeRequestOn(projectId, { targetBranch: head });
      if (!next || seen.has(next.iid)) break;
      seen.add(next.iid);
      above.push(chainLayer(next));
      head = next.source_branch;
    }
    if (below.length === 0 && above.length === 0) return null;
    return { number: null, base, layers: [...below, chainLayer(raw), ...above] };
  };

  const requireMergeRequest = <P extends SourceControlProjectRef>(raw: Reply | undefined, project: P, requireProjectIds = false) => {
    const value = obj(raw);
    const mapped = requireMapped(mapGitLabMergeRequest(value, identity, project), 'GitLab returned an invalid merge request');
    if (!value) throw new Error('GitLab returned an invalid merge request');
    if (value.author != null && (!isPlainObject(value.author)
      || !Number.isInteger(value.author.id) || !isString(value.author.username) || !value.author.username.trim())) {
      throw new Error('GitLab returned an invalid merge request');
    }
    if (requireProjectIds && (!Number.isInteger(value.source_project_id) || !Number.isInteger(value.target_project_id))) {
      throw new Error('GitLab returned an invalid merge request');
    }
    return mapped;
  };

  const requireMutationMergeRequest = <P extends SourceControlProjectRef>(raw: Reply | undefined, project: P) => {
    const request = requireMergeRequest(raw, project, true);
    const value = record(raw);
    if (value.draft !== true && value.draft !== false && value.work_in_progress !== true && value.work_in_progress !== false) {
      throw new Error('GitLab returned an invalid merge request draft state');
    }
    return request;
  };

  const requireUser = (value: Field, message: string) => {
    if (!isPlainObject(value) || !integer(value.id) || value.id < 0
      || !isString(value.username) || !value.username.trim()) throw new Error(message);
  };

  const requireIssue = <P extends SourceControlProjectRef>(raw: Reply, project: P) => {
    const value = obj(raw);
    const mapped = requireMapped(mapGitLabIssue(value, identity, project), 'GitLab returned an invalid issue');
    if (!value) throw new Error('GitLab returned an invalid issue');
    if (value.author != null) requireUser(value.author, 'GitLab returned an invalid issue');
    if (value.assignees != null) {
      if (!array(value.assignees)) throw new Error('GitLab returned an invalid issue');
      for (const assignee of value.assignees) requireUser(assignee, 'GitLab returned an invalid issue');
    }
    if (value.labels != null) {
      if (!array(value.labels)) throw new Error('GitLab returned an invalid issue');
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

  const requireIssueNote = (raw: Reply, fallbackUrl: string) => {
    const value = obj(raw);
    const mapped = requireMapped(mapGitLabNote(value, identity, fallbackUrl), 'GitLab returned an invalid issue note');
    if (value?.author != null) requireUser(value.author, 'GitLab returned an invalid issue note');
    return mapped;
  };

  const readMergeRequestList = (payload: Reply, project: SourceControlProjectRef) => {
    if (canonicalReads && !Array.isArray(payload)) throw new Error('GitLab returned an invalid merge request list');
    const items = asArray(payload);
    if (canonicalReads) {
      for (const item of items) requireMergeRequest(item, project, true);
    }
    return items;
  };

  const loadCI = async (targetProjectId: string, rawMR: Reply, details = false) => {
    const raw = obj(rawMR);
    const pipeline = raw?.head_pipeline ?? raw?.pipeline;
    if (!isPlainObject(pipeline) || !integer(pipeline.id)
      || !isString(pipeline.status) || !pipeline.status.trim()) return null;
    try {
      const jobs = details
        ? await client.Jobs.all(integer(pipeline.project_id) ? pipeline.project_id : targetProjectId, {
          pipelineId: pipeline.id, maxPages: 1, perPage: 100,
        })
        : [];
      if (details && (!array(jobs) || jobs.some((job) => !isPlainObject(job)
        || !Number.isInteger(job.id) || !isString(job.name) || !job.name.trim()
        || !isString(job.status) || !job.status.trim()))) {
        throw new Error('GitLab returned invalid CI jobs');
      }
      return mapGitLabCI(pipeline, asArray(jobs).map(obj).filter((job) => job !== undefined), identity);
    } catch {
      return null;
    }
  };

  const mergeRequestDetails = async (path: string, value: Reply): Promise<LiveDetails> => {
    const raw = obj(value);
    const pipeline = obj(raw?.head_pipeline);
    const [jobs, notes] = await Promise.all([
      raw?.state === 'opened' && pipeline && integer(pipeline.id) && pipeline.status === 'failed'
        ? client.Jobs.all(integer(pipeline.project_id) ? pipeline.project_id : path, {
          pipelineId: pipeline.id, scope: 'failed', maxPages: 1, perPage: 100,
        }).catch(() => [])
        : [],
      client.MergeRequestNotes.all(path, raw?.iid, { sort: 'desc', orderBy: 'created_at', maxPages: 1, perPage: 30 }).catch(() => []),
    ]);
    return {
      failedChecks: asArray(jobs).flatMap((job) => {
        const name = obj(job)?.name;
        return isString(name) && name ? [name] : [];
      }),
      recentActivity: asArray(notes)
        .flatMap((value) => {
          const note = obj(value);
          if (note?.system === true) return [];
          const author = obj(note?.author)?.username;
          const at = note?.created_at;
          return isString(author) && author && isString(at) && at ? [{ author, at }] : [];
        }).slice(0, 10),
    };
  };

  const findByNumber = async (directory: string, number: number, selector?: Selector, options: ReadOptions = {}) => {
    if (options.constrainToPrimary && !(options.linked && selector)) {
      const resolved = await resolveDirectoryProjects(directory, options.remote);
      const targets = await expandTargets([resolved.projects[0]], { requireComplete: canonicalReads });
      const selectedTargets = selector
        ? targets.filter((target) => target.project.owner.toLowerCase() === selector.owner.toLowerCase()
          && target.project.name.toLowerCase() === selector.name.toLowerCase())
        : targets;
      if (!selectedTargets.length) {
        throw Object.assign(new Error('GitLab project is outside the bound repository network'), { status: 404 });
      }
      for (const target of selectedTargets) {
        try {
          const raw = await client.MergeRequests.show(target.project.id, number);
          if (options.requireNetwork
            && changeRequestNetworkTarget(targets, obj(raw)?.target_project_id, (candidate, id) => candidate.raw.id === id) !== target) {
            throw Object.assign(new Error('GitLab merge request is outside the bound repository network'), { status: 404 });
          }
          return { target, raw };
        } catch (error) {
          if (hasFailure(error) && (error.cause?.response?.status === 404 || error.response?.status === 404)) continue;
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
        if (hasFailure(error) && (error.cause?.response?.status === 404 || error.response?.status === 404)) continue;
        throw error;
      }
    }
    throw new Error(`GitLab merge request !${number} was not found`);
  };

  const compactProject = (project: SourceControlProjectRef) => ({ id: project.id, owner: project.owner, name: project.name });
  const resolvedMutationTarget = (context: Context, project: SourceControlProjectRef, request: Coordinates = {}) => {
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

  const requireExpectedRequest = (expected: Coordinates, actual: Coordinates) => {
    for (const key of ['number', 'head', 'base', 'headSha'] as const) {
      if (expected[key] !== undefined && expected[key] !== actual[key]) {
        throw Object.assign(new Error(`GitLab merge request ${key} changed`), {
          code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH',
          status: 409,
        });
      }
    }
  };

  type WriteTarget = { projectId?: string; sourceProjectId?: string; targetProjectId?: string };
  const requireMutationResponse = (raw: Reply, project: SourceControlProjectRef, providerTarget: WriteTarget, expected?: Coordinates) => {
    const request = requireMutationMergeRequest(raw, project);
    const fields = record(raw);
    if (fields.target_project_id !== Number(providerTarget.targetProjectId ?? providerTarget.projectId)
      || (providerTarget.sourceProjectId !== undefined && fields.source_project_id !== Number(providerTarget.sourceProjectId))) {
      throw new Error('GitLab returned a merge request outside the resolved mutation target');
    }
    if (expected) requireExpectedRequest(expected, request);
    return request;
  };

  const readMutationRequest = async (context: Context, expected: Expected & { number: number }) => {
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

  const postNote = async (create: () => Promise<Reply>) => {
    const raw = await create();
    if (!isPlainObject(raw) || !Number.isInteger(raw.id)) throw new Error('GitLab returned an invalid note');
  };

  const mutationTargetInvalid = (message: string) => Object.assign(new Error(message), {
    code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', status: 409,
  });
  const requireNoteOnTarget = (raw: Reply, providerTarget: NumberedTarget, noteableType: string) => {
    if (!isPlainObject(raw) || !Number.isInteger(raw.id)) throw new Error('GitLab returned an invalid note');
    if ((raw.noteable_iid !== undefined && String(raw.noteable_iid) !== String(providerTarget.number))
      || (raw.noteable_type !== undefined && raw.noteable_type !== noteableType)) {
      throw mutationTargetInvalid('GitLab note is outside the resolved mutation target');
    }
    return raw;
  };
  const readNoteBeforeWrite = async (notes: Client['IssueNotes'], providerTarget: NumberedTarget, commentId: string, noteableType: string) => requireNoteOnTarget(
    await notes.show(providerTarget.projectId, providerTarget.number, Number(commentId)), providerTarget, noteableType,
  );
  const reconcileNote = async (notes: Client['IssueNotes'], providerTarget: NumberedTarget, action: 'update' | 'delete', { commentId, body }: WithComment & { body?: string }) => {
    try {
      const raw = await notes.show(providerTarget.projectId, providerTarget.number, Number(commentId));
      if (action === 'delete') return { state: 'outcome-unknown' };
      return isPlainObject(raw) && raw.body === body ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    } catch (error) {
      return action === 'delete' && requestStatus(error) === 404
        ? { state: 'succeeded', result: {} }
        : { state: 'outcome-unknown' };
    }
  };

  const REQUEST_CHANGES_MUTATION = `mutation($path: ID!, $iid: String!) {
  mergeRequestRequestChanges(input: { projectPath: $path, iid: $iid }) {
    mergeRequest { iid }
    errors
  }
}`;
  const requestChanges = async (project: SourceControlProjectRef, number: number) => {
    const response = await client.MergeRequests.requester.post('../graphql', {
      body: { query: REQUEST_CHANGES_MUTATION, variables: { path: `${project.owner}/${project.name}`, iid: String(number) } },
    });
    const payload = obj(response?.body);
    const result = obj(obj(payload?.data)?.mergeRequestRequestChanges);
    const errors = [
      ...(array(payload?.errors) ? payload.errors.map((error) => obj(error)?.message) : []),
      ...(array(result?.errors) ? result.errors : []),
    ].filter((message) => isString(message) && message.trim());
    if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 422 });
    if (!isPlainObject(result?.mergeRequest)) throw new Error('GitLab returned an invalid request-changes result');
  };

  const notesOfDiscussions = (discussions: JsonValue[] | null, permissions: Permissions | null) => {
    if (!array(discussions)) return discussions;
    return discussions.flatMap((discussion) => {
      if (!isPlainObject(discussion) || !array(discussion.notes)) return [discussion];
      if (discussion.individual_note === true || !isString(discussion.id) || !discussion.id) return discussion.notes;
      const opener = discussion.notes.find((note) => isPlainObject(note) && note.system !== true);
      const resolvable = discussion.notes.filter((note): note is JsonObject => isPlainObject(note) && note.resolvable === true);
      type ThreadState = { id: string; resolvable: boolean; resolved: boolean; canResolve?: boolean; canReply?: boolean };
      const state: ThreadState = {
        id: discussion.id,
        resolvable: resolvable.length > 0,
        resolved: resolvable.length > 0 && resolvable.every((note) => note.resolved === true),
      };
      const canResolve = permissions?.resolve.get(discussion.id);
      if (canResolve !== undefined) state.canResolve = canResolve;
      if (permissions) state.canReply = permissions.reply;
      return discussion.notes.map((note) => (isPlainObject(note) && note.system !== true
        ? { ...note, discussionThread: { ...state, first: note === opener } }
        : note));
    });
  };
  const THREAD_PERMISSIONS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) {
      discussionLocked
      userPermissions { createNote }
      discussions(first: 100) { nodes { id notes(first: 1) { nodes { userPermissions { resolveNote } } } } }
    }
  }
}`;
  const readThreadPermissions = async (project: SourceControlProjectRef, number: number): Promise<Permissions | null> => {
    try {
      const response = await client.MergeRequests.requester.post('../graphql', {
        body: { query: THREAD_PERMISSIONS_QUERY, variables: { path: `${project.owner}/${project.name}`, iid: String(number) } },
      });
      const request = obj(obj(obj(response?.body)?.data)?.project)?.mergeRequest;
      const nodes = obj(obj(request)?.discussions)?.nodes;
      if (!isPlainObject(request) || !array(nodes)) return null;
      const resolve = new Map<Field, boolean>();
      for (const value of nodes) {
        const node = obj(value);
        const id = isString(node?.id) ? node.id.split('/').at(-1) : '';
        const first = obj(obj(node?.notes)?.nodes)?.[0];
        const allowed = obj(obj(first)?.userPermissions)?.resolveNote;
        if (id && (allowed === true || allowed === false)) resolve.set(id, allowed);
      }
      return { reply: request.discussionLocked !== true && obj(request.userPermissions)?.createNote !== false, resolve };
    } catch {
      return null;
    }
  };

  const validDraftNotes = (value: Reply): value is Array<JsonObject & ReviewFields> =>
    array(value) && !value.some((note) => !hasId(note) || !isString(note.note));
  const readDraftNotes = (value: Reply) => {
    if (!validDraftNotes(value)) {
      throw new Error('GitLab returned invalid draft notes');
    }
    return value;
  };
  const toReviewPerson = (value: Reply | undefined) => {
    const user = obj(value);
    return isString(user?.username) ? { login: user.username, avatarUrl: isString(user.avatar_url) ? user.avatar_url : undefined } : null;
  };
  const positionOfNote = (value: Field) => {
    const position = obj(value);
    const path = position?.new_path ?? position?.old_path ?? '';
    if (position?.position_type === 'file') return { path, side: 'new', line: null, startLine: null };
    const side = Number.isInteger(position?.new_line) ? 'new' : 'old';
    const key = side === 'new' ? 'new_line' : 'old_line';
    const start = obj(obj(position?.line_range)?.start)?.[key];
    return { path, side, line: position?.[key] ?? null, startLine: integer(start) && start !== position?.[key] ? start : null };
  };
  const lineRangeEnd = (path: string, pair: NonNullable<ReturnType<typeof pairedDiffLine>>) => ({
    lineCode: `${createHash('sha1').update(path).digest('hex')}_${pair.oldLine ?? pair.newLine}_${pair.newLine ?? pair.oldLine}`,
    type: pair.newLine === null ? 'old' : 'new',
    oldLine: pair.oldLine ?? undefined,
    newLine: pair.newLine ?? undefined,
  });
  const draftPosition = (position: Position, diff: JsonObject, refs: JsonObject) => {
    const base = {
      baseSha: refs.base_sha, startSha: refs.start_sha, headSha: refs.head_sha,
      oldPath: diff.old_path, newPath: diff.new_path,
    };
    if (position.line === undefined) return { ...base, positionType: 'file' };
    const pairOf = (line: number) => {
      const pair = pairedDiffLine(String(diff.diff ?? ''), position.side === 'old' ? 'old' : 'new', line);
      if (!pair) throw Object.assign(new Error('This line is not in the merge request diff'), { status: 422 });
      return pair;
    };
    const end = pairOf(position.line);
    const range = () => {
      if (position.startLine === undefined) return undefined;
      if (!isString(diff.new_path)) throw new TypeError('Invalid diff path');
      return { start: lineRangeEnd(diff.new_path, pairOf(position.startLine)), end: lineRangeEnd(diff.new_path, end) };
    };
    return {
      ...base,
      positionType: 'text',
      oldLine: end.oldLine ?? undefined,
      newLine: end.newLine ?? undefined,
      lineRange: range(),
    };
  };

  const discussionResolved = (raw: Reply) => {
    if (!isPlainObject(raw) || !array(raw.notes)) return null;
    const resolvable = raw.notes.filter((note): note is JsonObject => isPlainObject(note) && note.resolvable === true);
    return resolvable.length > 0 && resolvable.every((note) => note.resolved === true);
  };

  const DIFF_STATS_QUERY = `query($path: ID!, $iid: String!) {
  project(fullPath: $path) {
    mergeRequest(iid: $iid) { diffStats { path additions deletions } }
  }
}`;
  const readDiffStats = async (project: SourceControlProjectRef, number: number) => {
    try {
      const response = await client.MergeRequests.requester.post('../graphql', {
        body: { query: DIFF_STATS_QUERY, variables: { path: `${project.owner}/${project.name}`, iid: String(number) } },
      });
      const stats = obj(obj(obj(obj(response?.body)?.data)?.project)?.mergeRequest)?.diffStats;
      if (!array(stats)) return null;
      const byPath = new Map<string, { additions: number; deletions: number }>();
      for (const entry of stats) {
        if (!isPlainObject(entry) || !isString(entry.path) || !integer(entry.additions) || !integer(entry.deletions)) return null;
        byPath.set(entry.path, { additions: entry.additions, deletions: entry.deletions });
      }
      return byPath;
    } catch {
      return null;
    }
  };

  const resolveMutationActionTarget = async (payload: ActionPayload) => {
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
    async resolveCreateMutation(context: Context, expected: Expected, options: { remote?: Remote; headRemote?: Remote } = {}) {
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

    async resolveIssueMutation(context: Context, expected: Expected & { number: number }) {
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

    async setChangeRequestState(payload: ExistingMutation & { state: string }) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.MergeRequests.edit(projectId, number, { stateEvent: payload.state === 'closed' ? 'close' : 'reopen' });
      const request = requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
      if (request.state !== payload.state) throw new Error('GitLab returned an unexpected merge request state');
      return { state: request.state };
    },

    async setIssueState(payload: ExistingMutation & { state: string }) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.Issues.edit(projectId, number, { stateEvent: payload.state === 'closed' ? 'close' : 'reopen' });
      const issue = requireIssue(raw, payload.targetProject);
      if (issue.number !== number || issue.state !== payload.state) throw new Error('GitLab returned an unexpected issue state');
      return { state: issue.state };
    },

    async updateIssue(payload: ExistingMutation & TitleBody) {
      const { projectId, number } = payload.providerTarget;
      const update: Query = { title: payload.title };
      if (payload.body !== undefined) update.description = payload.body;
      const issue = requireIssue(await client.Issues.edit(projectId, number, update), payload.targetProject);
      if (issue.number !== number || issue.title !== payload.title
        || (payload.body !== undefined && (issue.body ?? '') !== payload.body)) {
        throw new Error('GitLab returned an unexpected issue');
      }
      return {};
    },

    async listLabels(directory: string, selector?: Selector, remote?: Remote) {
      const target = await constrainedProject(directory, selector, remote);
      const raw = await client.ProjectLabels.all(target.project.id, { perPage: 100, maxPages: 1 });
      if (!array(raw)) throw new Error('GitLab returned an invalid label list');
      return raw.flatMap((label) => {
        if (!isPlainObject(label) || !isString(label.name) || !label.name) return [];
        return [isString(label.color) && label.color ? { name: label.name, color: label.color.replace(/^#/, '') } : { name: label.name }];
      });
    },

    async readUpload(directory: string, selector: Selector, remote: Remote, { secret, filename, range, signal, linked }: GitLabDownloadOptions & {
      secret: string; filename: string; linked?: boolean | undefined;
    }) {
      if (!download) throw new Error('GitLab file downloads are unavailable');
      const target = await constrainedProject(directory, selector, remote, { linked });
      return download(`projects/${target.project.id}/uploads/${secret}/${encodeURIComponent(filename)}`, { range, signal });
    },

    async listReviewerCandidates(directory: string, selector?: Selector, remote?: Remote) {
      const target = await constrainedProject(directory, selector, remote);
      const raw = await client.ProjectMembers.all(target.project.id, { includeInherited: true, perPage: 100, maxPages: 1 });
      if (!array(raw)) throw new Error('GitLab returned an invalid member list');
      return raw.flatMap((value) => {
        const member = obj(value);
        const user = member?.state === 'active' ? mapGitLabUser(member, identity) : null;
        if (!user) return [];
        return [user.avatarUrl ? { id: user.id, login: user.username, avatarUrl: user.avatarUrl } : { id: user.id, login: user.username }];
      });
    },

    async replyToThread(payload: WithTarget & WithBody & { threadId: string }) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.MergeRequestDiscussions.addNote(projectId, number, payload.threadId, payload.body);
      if (!isPlainObject(raw) || !Number.isInteger(raw.id)) throw new Error('GitLab returned an invalid note');
      return {};
    },

    async resolveThread(payload: WithTarget & { threadId: string; resolved: boolean }) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.MergeRequestDiscussions.resolve(projectId, number, payload.threadId, payload.resolved);
      if (!isPlainObject(raw) || raw.id !== payload.threadId || discussionResolved(raw) !== payload.resolved) {
        throw new Error('GitLab returned an invalid thread');
      }
      return {};
    },

    async startThread(payload: WithTarget & WithBody) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.MergeRequestDiscussions.create(projectId, number, payload.body);
      if (!isPlainObject(raw) || !isString(raw.id) || !raw.id) throw new Error('GitLab returned an invalid thread');
      return {};
    },

    async reviewState(directory: string, number: number, project?: Selector, remote?: Remote) {
      const { target, raw } = await findByNumber(directory, number, project, { remote, constrainToPrimary: true });
      const request = requireMutationMergeRequest(raw, target.project);
      const headSha = obj(obj(raw)?.diff_refs)?.head_sha ?? request.headSha;
      const [drafts, discussions, viewer, permissions] = await Promise.all([
        client.MergeRequestDraftNotes.all(target.project.id, number).then(readDraftNotes),
        readCollection((page) => client.MergeRequestDiscussions.all(target.project.id, number, page), 'GitLab merge request has more threads than OpenChamber reads'),
        client.Users.showCurrentUser(),
        readThreadPermissions(target.project, number),
      ]);
      const me = toReviewPerson(viewer);
      if (!discussions) throw new TypeError('Missing GitLab discussion list');
      return {
        connected: true,
        viewerIsAuthor: obj(obj(raw)?.author)?.username === obj(viewer)?.username,
        headSha,
        draft: drafts.length > 0 ? {
          id: String(number),
          body: '',
          comments: drafts.map((note) => ({
            ...positionOfNote(note.position),
            id: String(note.id),
            body: note.note,
            author: me,
          })),
        } : null,
        threads: discussions.flatMap((value) => {
          const discussion = obj(value);
          const notes = asArray(discussion?.notes).filter((note): note is JsonObject => isPlainObject(note) && note.system !== true);
          const [first] = notes;
          if (first?.type !== 'DiffNote' || !isPlainObject(first.position) || first.position.head_sha !== headSha) return [];
          return [{
            ...positionOfNote(first.position),
            id: discussion?.id,
            resolved: discussionResolved(value) === true,
            canReply: permissions?.reply ?? false,
            canResolve: permissions?.resolve.get(discussion?.id) ?? false,
            comments: notes.map((note) => ({
              id: String(note.id),
              body: note.body,
              createdAt: note.created_at,
              url: `${request.url}#note_${note.id}`,
              author: toReviewPerson(note.author),
            })),
          }];
        }),
        truncated: false,
      };
    },

    async addReviewComment({ providerTarget, position, body }: WithTarget & WithBody & { position: Position }) {
      const { projectId, number } = providerTarget;
      const raw = await client.MergeRequests.show(projectId, number);
      const refs = obj(obj(raw)?.diff_refs);
      if (!isString(refs?.base_sha) || !isString(refs?.start_sha) || !isString(refs?.head_sha)) throw new Error('GitLab returned an invalid merge request');
      const diffs = await readCollection((page) => client.MergeRequests.allDiffs(projectId, number, page), 'GitLab merge request has more changed files than OpenChamber reads', DIFF_PER_PAGE);
      if (!diffs) throw new TypeError('Missing GitLab diff list');
      const diff = diffs.find((entry): entry is JsonObject => hasFields(entry)
        && (entry.new_path === position.path || entry.old_path === position.path));
      if (!diff) throw Object.assign(new Error('This file is not in the merge request'), { status: 422 });
      const created = await client.MergeRequestDraftNotes.create(projectId, number, body, {
        position: draftPosition(position, diff, refs),
      });
      if (!isPlainObject(created) || !Number.isInteger(created.id)) throw new Error('GitLab returned an invalid draft note');
      return {};
    },

    async updateReviewComment({ providerTarget, commentId, body }: WithTarget & WithComment & WithBody) {
      const { projectId, number } = providerTarget;
      const updated = await client.MergeRequestDraftNotes.edit(projectId, number, Number(commentId), { note: body });
      if (!isPlainObject(updated) || !Number.isInteger(updated.id)) throw new Error('GitLab returned an invalid draft note');
      return {};
    },

    async deleteReviewComment({ providerTarget, commentId }: WithTarget & WithComment) {
      await client.MergeRequestDraftNotes.remove(providerTarget.projectId, providerTarget.number, Number(commentId));
      return {};
    },

    async discardReview({ providerTarget }: WithTarget) {
      const { projectId, number } = providerTarget;
      for (const note of readDraftNotes(await client.MergeRequestDraftNotes.all(projectId, number))) {
        await client.MergeRequestDraftNotes.remove(projectId, number, note.id);
      }
      return {};
    },

    async reconcileThreadResolve(providerTarget: NumberedTarget, threadId: string, resolved: boolean) {
      const { projectId, number } = providerTarget;
      const current = discussionResolved(await client.MergeRequestDiscussions.show(projectId, number, threadId));
      return current === resolved ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async setLabels(payload: WithTarget & { labels: string[]; kind: string }) {
      const { projectId, number } = payload.providerTarget;
      const update = { labels: payload.labels.join(',') };
      const raw = payload.kind === 'issue-labels'
        ? await client.Issues.edit(projectId, number, update)
        : await client.MergeRequests.edit(projectId, number, update);
      if (!isPlainObject(raw) || raw.iid !== number) throw new Error('GitLab returned an invalid edit result');
      return {};
    },

    async setReviewers(payload: ExistingMutation & { reviewers: string[] }) {
      const { projectId, number } = payload.providerTarget;
      const raw = await client.MergeRequests.edit(projectId, number, { reviewerIds: payload.reviewers.map(Number) });
      requireMutationResponse(raw, payload.targetProject, payload.providerTarget, payload.expectedTarget);
      return {};
    },

    async reconcileSetMutation(providerTarget: NumberedTarget, kind: string, names: string[]) {
      const { projectId, number } = providerTarget;
      const raw = kind === 'issue-labels'
        ? await client.Issues.show(number, { projectId })
        : await client.MergeRequests.show(projectId, number);
      const fields = obj(raw);
      const current = kind === 'change-request-reviewers'
        ? (array(fields?.reviewers) ? fields.reviewers.map((user) => String(obj(user)?.id)) : null)
        : (array(fields?.labels) ? fields.labels.map((label) => (isString(label) ? label : obj(label)?.name)) : null);
      const wanted: readonly Field[] = names;
      if (!current || current.length !== names.length || !current.every((entry) => wanted.includes(entry))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    async reconcileIssueUpdate(providerTarget: NumberedTarget, { title, body }: TitleBody) {
      const { projectId, number } = providerTarget;
      const project = (await showProject(projectId)).project;
      const issue = requireIssue(await client.Issues.show(number, { projectId }), project);
      if (issue.title !== title || (body !== undefined && (issue.body ?? '') !== body)) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    async reconcileStateMutation(providerTarget: NumberedTarget, kind: string, state: string) {
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

    commentChangeRequest(payload: WithTarget & WithBody) {
      const { projectId, number } = payload.providerTarget;
      return postNote(() => client.MergeRequestNotes.create(projectId, number, payload.body));
    },

    commentIssue(payload: WithTarget & WithBody) {
      const { projectId, number } = payload.providerTarget;
      return postNote(() => client.IssueNotes.create(projectId, number, payload.body));
    },

    async updateChangeRequestComment(payload: WithTarget & WithComment & WithBody) {
      const { projectId, number } = payload.providerTarget;
      await readNoteBeforeWrite(client.MergeRequestNotes, payload.providerTarget, payload.commentId, 'MergeRequest');
      const raw = await client.MergeRequestNotes.edit(projectId, number, Number(payload.commentId), { body: payload.body });
      if (!isPlainObject(raw) || String(raw.id) !== String(payload.commentId) || raw.body !== payload.body) {
        throw new Error('GitLab returned an unexpected note');
      }
      return {};
    },

    async deleteChangeRequestComment(payload: WithTarget & WithComment) {
      await readNoteBeforeWrite(client.MergeRequestNotes, payload.providerTarget, payload.commentId, 'MergeRequest');
      await client.MergeRequestNotes.remove(payload.providerTarget.projectId, payload.providerTarget.number, Number(payload.commentId));
      return {};
    },

    reconcileChangeRequestComment(providerTarget: NumberedTarget, action: 'update' | 'delete', input: WithComment & { body?: string }) {
      return reconcileNote(client.MergeRequestNotes, providerTarget, action, input);
    },

    async updateIssueComment(payload: WithTarget & WithComment & WithBody) {
      const { projectId, number } = payload.providerTarget;
      await readNoteBeforeWrite(client.IssueNotes, payload.providerTarget, payload.commentId, 'Issue');
      const raw = await client.IssueNotes.edit(projectId, number, Number(payload.commentId), { body: payload.body });
      if (!isPlainObject(raw) || String(raw.id) !== String(payload.commentId) || raw.body !== payload.body) {
        throw new Error('GitLab returned an unexpected note');
      }
      return {};
    },

    async deleteIssueComment(payload: WithTarget & WithComment) {
      await readNoteBeforeWrite(client.IssueNotes, payload.providerTarget, payload.commentId, 'Issue');
      await client.IssueNotes.remove(payload.providerTarget.projectId, payload.providerTarget.number, Number(payload.commentId));
      return {};
    },

    reconcileIssueComment(providerTarget: NumberedTarget, action: 'update' | 'delete', input: WithComment & { body?: string }) {
      return reconcileNote(client.IssueNotes, providerTarget, action, input);
    },

    async reviewChangeRequest(payload: ExistingMutation & { expectedTarget: Coordinates; verdict: string; body?: string | undefined }) {
      const { projectId, number } = payload.providerTarget;
      const drafts = readDraftNotes(await client.MergeRequestDraftNotes.all(projectId, number));
      if (payload.verdict === 'comment' && drafts.length === 0 && payload.body === undefined) {
        throw Object.assign(new Error('A review with no comments needs text'), { status: 422 });
      }
      if (drafts.length > 0) await client.MergeRequestDraftNotes.publishBulk(projectId, number);
      if (payload.verdict === 'approve') {
        try {
          await client.MergeRequestApprovals.approve(projectId, number, { sha: payload.expectedTarget.headSha });
        } catch (error) {
          const status = requestStatus(error);
          if (status === 409) {
            throw Object.assign(new Error('GitLab merge request headSha changed'), {
              code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409,
            });
          }
          if (status === 401) throw Object.assign(new Error('GitLab did not allow this approval'), { status: 403 });
          throw error;
        }
      } else if (payload.verdict === 'request-changes') {
        await requestChanges(payload.targetProject, number);
      }
      const { body } = payload;
      if (body === undefined) return { commented: false };
      try {
        await postNote(() => client.MergeRequestNotes.create(projectId, number, body));
        return { commented: true };
      } catch {
        return { commented: false };
      }
    },

    async reconcileCreateMutation(providerTarget: CreateTarget, target: SourceControlMutationTarget) {
      const payload = readMergeRequestList(await listProjectMRs(providerTarget.targetProjectId, {
        state: 'all', sourceBranch: target.head, perPage: 100,
      }), target.project);
      const matches = payload.filter((value) => {
        const raw = obj(value);
        return raw?.source_project_id === Number(providerTarget.sourceProjectId)
          && raw?.target_project_id === Number(providerTarget.targetProjectId)
          && raw?.target_branch === target.base;
      })
        .map((raw) => requireMutationMergeRequest(raw, target.project));
      return matches.length === 1 ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    },

    async reconcileChangeRequestMutation(providerTarget: NumberedTarget, kind: string) {
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
      if (kind === 'change-request-draft') {
        if (request.draft) return { state: 'succeeded', result: { draft: true } };
        return { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };
      }
      return { state: 'outcome-unknown' };
    },

    async changeRequestStatus(directory: string, branch: string, remote?: Remote) {
      const resolved = await resolveDirectoryProjects(directory, remote);
      const targets = await expandTargets(resolved.projects, { requireComplete: canonicalReads });
      const sourceIds: Pick<ReadonlySet<Field>, 'has'> = new Set(resolved.projects.map((item) => item.raw.id));
      let selected: { target: Project; raw: JsonObject } | null = null;
      for (const target of targets) {
        const requests = readMergeRequestList(
          await listProjectMRs(target.project.id, { state: 'opened', sourceBranch: branch }),
          target.project,
        );
        const raw = obj(requests.find((value) => {
          const request = obj(value);
          return sourceIds.has(request?.source_project_id) && request?.target_project_id === target.raw.id;
        }));
        if (raw) {
          selected = { target, raw };
          break;
        }
      }
      if (!selected) {
        const firstSource = resolved.projects[0];
        const historyTargetId = obj(firstSource.raw.forked_from_project)?.id ?? firstSource.raw.id;
        const historyTarget = targets.find((item) => item.raw.id === historyTargetId) ?? firstSource;
        const history = readMergeRequestList(
          await listProjectMRs(historyTarget.project.id, { state: 'all', sourceBranch: branch }),
          historyTarget.project,
        );
        const raw = obj(history.find((value) => {
          const request = obj(value);
          return request?.state === 'merged' || request?.state === 'closed';
        }));
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
        canMerge: obj(selected.raw.user)?.can_merge === true || request.mergeable === true,
        resolvedRemoteName: first.project.remoteName ?? null,
        defaultBranch: selected.target.project.defaultBranch ?? null,
      };
    },

    async createChangeRequest(payload: (CreateMutation | LegacyCreate) & CreateFields) {
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
      const parentId = () => obj(source.raw.forked_from_project)?.id;
      const target = payload.targetProject
        ? await showProject(projectPath(payload.targetProject.owner, payload.targetProject.name))
        : parentId() ? await showProject(parentId()) : source;
      const raw = await client.MergeRequests.create(source.project.id, payload.head, payload.base, title, {
        description: payload.body,
        targetProjectId: target.project.id,
      });
      return requireMapped(mapGitLabMergeRequest(obj(raw), identity, target.project), 'GitLab returned an invalid merge request');
    },

    async updateChangeRequest(payload: ActionPayload & TitleBody) {
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
      return requireMapped(mapGitLabMergeRequest(obj(raw), identity, target.project), 'GitLab returned an invalid merge request');
    },

    async mergeChangeRequest(payload: ActionPayload & { method: string }) {
      if (payload.method === 'rebase') {
        throw Object.assign(new Error('GitLab does not support rebase as an atomic merge method'), { status: 400 });
      }
      const { target, projectId, number } = await resolveMutationActionTarget(payload);
      const expectedSha = payload.expectedTarget?.headSha;
      const mergeOptions: Query = { squash: payload.method === 'squash' };
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
        : requireMapped(mapGitLabMergeRequest(obj(raw), identity, target.project), 'GitLab returned an invalid merge request');
      return { merged: request.state === 'merged', message: obj(raw)?.merge_error || undefined };
    },

    async readyChangeRequest(payload: ActionPayload) {
      const { target, projectId, number } = await resolveMutationActionTarget(payload);
      const validate = (raw: Reply) => (payload.providerTarget
        ? requireMutationResponse(raw, target.project, payload.providerTarget, payload.expectedTarget)
        : requireMapped(mapGitLabMergeRequest(obj(raw), identity, target.project), 'GitLab returned an invalid merge request'));
      const current = validate(await client.MergeRequests.show(projectId, number));
      if (!current.draft) return { ready: true };
      const request = validate(await client.MergeRequests.edit(projectId, number, { title: asReadyTitle(current.title) }));
      return { ready: !request.draft };
    },

    async draftChangeRequest(payload: ActionPayload) {
      const { target, projectId, number } = await resolveMutationActionTarget(payload);
      const validate = (raw: Reply) => (payload.providerTarget
        ? requireMutationResponse(raw, target.project, payload.providerTarget, payload.expectedTarget)
        : requireMapped(mapGitLabMergeRequest(obj(raw), identity, target.project), 'GitLab returned an invalid merge request'));
      const current = validate(await client.MergeRequests.show(projectId, number));
      if (current.draft) return { draft: true };
      const request = validate(await client.MergeRequests.edit(projectId, number, { title: asDraftTitle(current.title) }));
      return { draft: request.draft };
    },

    async listChangeRequests(directory: string, options: ListOptions = {}) {
      const filter = await listFilter(options, 'pull');
      const resolved = await resolveDirectoryProjects(directory, options.remote);
      const targets = await expandTargets([resolved.projects[0]], { requireComplete: canonicalReads });
      const target = last(targets);
      const page = readPage(await listProjectMRs(target.project.id, {
        ...filter, page: options.page ?? 1, perPage: PER_PAGE, search: options.query, showExpanded: true,
      }));
      const rawItems = readMergeRequestList(page.items, target.project);
      const items = rawItems.map((raw) => canonicalReads
        ? requireMergeRequest(raw, target.project)
        : requireMapped(mapGitLabMergeRequest(obj(raw), identity, target.project), 'GitLab returned an invalid merge request'));
      return { items, page: options.page ?? 1, hasMore: page.hasMore };
    },

    async changeRequestContext(directory: string, number: number, options: ContextOptions = {}) {
      const { target, raw: reply } = await findByNumber(directory, number, options.project, {
        constrainToPrimary: options.constrainToPrimary,
        remote: options.remote,
        linked: options.linked,
      });
      const raw = obj(reply);
      const [noteSource, diffs, ci, headProject, commitPage, diffStats, threadPermissions, chain] = await Promise.all([
        options.includeTimeline
          ? readCollection((page) => client.MergeRequestDiscussions.all(target.project.id, number, page), 'GitLab merge request has more threads than OpenChamber reads')
          : readCollection((page) => client.MergeRequestNotes.all(target.project.id, number, page), 'GitLab merge request has more notes than OpenChamber reads'),
        options.includeDiff
          ? readCollection((page) => client.MergeRequests.allDiffs(target.project.id, number, page), 'GitLab merge request has more changed files than OpenChamber reads', DIFF_PER_PAGE)
          : Promise.resolve([]),
        loadCI(target.project.id, reply, options.includeCIDetails),
        integer(raw?.source_project_id) && raw.source_project_id !== target.raw?.id
          ? showProject(raw.source_project_id).then((item) => item.project)
          : Promise.resolve(null),
        options.includeTimeline
          ? client.MergeRequests.allCommits(target.project.id, number, { maxPages: 1, perPage: TIMELINE_COMMIT_LIMIT, showExpanded: true }).then(readPage)
          : Promise.resolve(null),
        options.includeDiff ? readDiffStats(target.project, number) : Promise.resolve(null),
        options.includeTimeline ? readThreadPermissions(target.project, number) : Promise.resolve(null),
        readChain(reply, isString(target.raw?.default_branch) ? target.raw.default_branch : null).catch(() => undefined),
      ]);
      const notes = options.includeTimeline ? notesOfDiscussions(noteSource, threadPermissions) : noteSource;
      if (canonicalReads && !Array.isArray(notes)) throw new Error('GitLab returned an invalid merge request note list');
      if (canonicalReads && !Array.isArray(diffs)) throw new Error('GitLab returned an invalid merge request diff list');
      const mappedNotes = asArray(notes).flatMap((value) => {
        const note = obj(value);
        const mapped = mapGitLabNote(note, identity, record(raw).web_url);
        if (mapped) {
          if (canonicalReads && note?.author != null && (!isPlainObject(note.author)
            || !Number.isInteger(note.author.id) || !isString(note.author.username) || !note.author.username.trim())) {
            throw new Error('GitLab returned an invalid merge request note');
          }
          if (canonicalReads && note?.position != null && (!isPlainObject(note.position)
            || (!isString(note.position.new_path) && !isString(note.position.old_path)))) {
            throw new Error('GitLab returned an invalid merge request note');
          }
          return [{ ...mapped, ...noteCapabilities(value) }];
        }
        if (note?.system === true) return [];
        if (canonicalReads) throw new Error('GitLab returned an invalid merge request note');
        return [];
      });
      const files = asArray(diffs).flatMap((diff) => {
        const mapped = mapGitLabDiff(obj(diff));
        if (mapped) {
          const stats = isString(mapped.path) ? diffStats?.get(mapped.path) : null;
          if (stats) Object.assign(mapped, stats);
          return [mapped];
        }
        if (canonicalReads) throw new Error('GitLab returned an invalid merge request diff');
        return [];
      });
      const changeRequest = canonicalReads
        ? requireMergeRequest(reply, target.project)
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
      const withStack = chain === undefined ? context : { ...context, stack: chain };
      if (!options.includeTimeline) return withStack;
      if (canonicalReads && !Array.isArray(commitPage?.items)) throw new Error('GitLab returned an invalid merge request commit list');
      return {
        ...withStack,
        commits: asArray(commitPage?.items).flatMap((commit) => {
          const mapped = mapGitLabCommit(obj(commit));
          return mapped ? [mapped] : [];
        }).reverse(),
        commitsComplete: !commitPage?.hasMore,
        reviewers: asArray(record(raw).reviewers).flatMap((user) => {
          const mapped = mapGitLabUser(obj(user), identity);
          return mapped ? [mapped] : [];
        }),
        verdicts: asArray(notes).flatMap((note) => {
          const mapped = mapGitLabVerdictNote(obj(note), identity, record(raw).web_url);
          return mapped ? [mapped] : [];
        }),
      };
    },

    async listIssues(directory: string, options: ListOptions = {}) {
      const filter = await listFilter(options, 'issue');
      const resolved = await resolveDirectoryProjects(directory, options.remote);
      const target = resolved.projects[0];
      const page = readPage(await client.Issues.all({
        projectId: target.project.id, ...filter, page: options.page ?? 1,
        perPage: PER_PAGE, maxPages: 1, search: options.query, showExpanded: true, withLabelsDetails: true,
      }));
      if (canonicalReads && !Array.isArray(page.items)) throw new Error('GitLab returned an invalid issue list');
      const rawItems = asArray(page.items);
      const items = rawItems.flatMap((value) => {
        const raw = obj(value);
        if (raw?.issue_type === 'incident' || raw?.issue_type === 'test_case') return [];
        if (canonicalReads) return [requireIssue(value, target.project)];
        const issue = mapGitLabIssue(raw, identity, target.project);
        return issue ? [issue] : [];
      });
      return { items, page: options.page ?? 1, hasMore: page.hasMore };
    },

    async getIssue(directory: string, number: number, selector?: Selector, remote?: Remote, { linked }: ReadOptions = {}) {
      const target = await constrainedProject(directory, selector, remote, { linked });
      const raw = await client.Issues.show(number, { projectId: target.project.id });
      return canonicalReads
        ? requireIssue(raw, target.project)
        : requireMapped(mapGitLabIssue(obj(raw), identity, target.project), 'GitLab returned an invalid issue');
    },

    async changeRequestPatch(directory: string, number: number, options: ReadOptions = {}) {
      const { target } = await findByNumber(directory, number, options.project, {
        constrainToPrimary: true, remote: options.remote, requireNetwork: true, linked: options.linked,
      });
      const diffs = await readCollection((page) => client.MergeRequests.allDiffs(target.project.id, number, page), 'GitLab merge request has more changed files than OpenChamber reads', DIFF_PER_PAGE);
      if (!array(diffs)) throw new Error('GitLab returned an invalid merge request diff list');
      const files = diffs.filter((diff): diff is JsonObject => isPlainObject(diff) && Boolean(text(diff.new_path) || text(diff.old_path)));
      if (files.length !== diffs.length) throw new Error('GitLab returned an invalid merge request diff');
      return {
        patch: files.map(gitPatchForDiff).join(''),
        meta: { owner: target.project.owner, repo: target.project.name, number },
      };
    },

    async changeRequestFileContents(directory: string, number: number, { project, remote, path, previousPath, status, binary, linked }: ReadOptions & {
      path: string; previousPath?: string | undefined; status?: string | undefined; binary?: boolean | undefined;
    }) {
      const { target, raw } = await findByNumber(directory, number, project, {
        constrainToPrimary: true, remote, requireNetwork: true, linked,
      });
      const refs = obj(obj(raw)?.diff_refs);
      const baseSha = refs?.base_sha;
      const headSha = refs?.head_sha;
      if (!COMMIT_SHA.test(String(baseSha)) || !COMMIT_SHA.test(String(headSha))) {
        throw new Error('GitLab returned invalid merge request refs');
      }
      const readFile = async (filePath: string, ref: Field) => {
        const content = await client.RepositoryFiles.showRaw(target.project.id, filePath, ref);
        if (binary) {
          if (!(content instanceof Blob)) throw new Error('GitLab returned invalid file contents');
          return documentDataUrl(Buffer.from(await content.arrayBuffer()));
        }
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

    async liveSummaries({ refs = [], issueRefs = [], details = false }: { refs?: Ref[] | undefined; issueRefs?: Ref[] | undefined; details?: boolean | undefined }) {
      const read = async <T, R>(ref: Ref | undefined, load: (path: string, number: number) => Promise<T>, map: (ref: Ref, loaded: T) => R) => {
        try {
          if (!ref) throw new TypeError('Missing GitLab reference');
          return map(ref, await load(`${ref.owner}/${ref.repo}`, ref.number));
        } catch (error) {
          if (requestStatus(error) === 401) throw error;
          return null;
        }
      };
      const loadMergeRequest = async (path: string, number: number): Promise<{ raw: Reply } & Partial<LiveDetails>> => {
        const raw = await client.MergeRequests.show(path, number);
        return details ? { raw, ...(await mergeRequestDetails(path, raw)) } : { raw };
      };
      const mapMergeRequest = (ref: Ref, { raw, failedChecks, recentActivity }: Awaited<ReturnType<typeof loadMergeRequest>>) => {
        const summary = liveMergeRequestSummary(ref, raw);
        if (summary && details) Object.assign(summary, { failedChecks, recentActivity });
        return summary;
      };
      const [summaries, issueSummaries] = await Promise.all([
        mapLimited(refs, LIVE_SUMMARY_CONCURRENCY, (ref) => read(ref, loadMergeRequest, mapMergeRequest)),
        mapLimited(issueRefs, LIVE_SUMMARY_CONCURRENCY, (ref) => read(ref, (path, number) => client.Issues.show(number, { projectId: path }), liveIssueSummary)),
      ]);
      return { summaries: summaries.filter(isPresent), issueSummaries: issueSummaries.filter(isPresent) };
    },

    async issueComments(directory: string, number: number, selector?: Selector, remote?: Remote, { linked }: ReadOptions = {}) {
      const target = await constrainedProject(directory, selector, remote, { linked });
      const issue = await client.Issues.show(number, { projectId: target.project.id });
      const mappedIssue = canonicalReads
        ? requireIssue(issue, target.project)
        : requireMapped(mapGitLabIssue(obj(issue), identity, target.project), 'GitLab returned an invalid issue');
      const notes = await readCollection((page) => client.IssueNotes.all(target.project.id, number, page), 'GitLab issue has more comments than OpenChamber reads');
      if (canonicalReads && !Array.isArray(notes)) throw new Error('GitLab returned an invalid issue note list');
      return asArray(notes).flatMap((note) => {
        if (obj(note)?.system === true) return [];
        if (canonicalReads) return [{ ...requireIssueNote(note, mappedIssue.url), ...noteCapabilities(note) }];
        const mapped = mapGitLabNote(obj(note), identity, mappedIssue.url);
        return mapped ? [{ ...mapped, ...noteCapabilities(note) }] : [];
      });
    },

    async projectUpstream(directory: string, remote?: Remote) {
      const source = (await resolveDirectoryProjects(directory, remote)).projects[0];
      const parentId = obj(source.raw.forked_from_project)?.id;
      if (!integer(parentId)) return { identity, isFork: false, upstream: null };
      const parent = await showProject(parentId);
      return { identity, isFork: true, upstream: parent.project };
    },

    async projectBranches(directory: string, selector?: Selector, remote?: Remote) {
      const target = await constrainedProject(directory, selector, remote, { requireComplete: true });
      const payload = await readCollection((page) => client.Branches.all(target.project.id, page), 'GitLab project has more branches than OpenChamber reads');
      if (canonicalReads && !Array.isArray(payload)) throw new Error('GitLab returned an invalid branch list');
      return asArray(payload).flatMap((branch) => {
        const name = obj(branch)?.name;
        if (isString(name) && name.trim()) return [name];
        if (canonicalReads) throw new Error('GitLab returned an invalid branch');
        return [];
      });
    },
  };
}
