import { isPlainObject, isString } from './validation.js';
import { parseGitLabRemoteUrl, parseGitLabSshProjectPath } from './repo.js';
import type { SourceControlProjectRef } from '@openchamber/sdk';
import type { JsonValue } from '../shared/json-values.js';

export interface GitLabIdentity { provider: string; instance: string }
export interface GitLabPayload {
  id?: unknown; iid?: unknown; username?: unknown; avatar_url?: unknown; name?: unknown;
  public_email?: unknown; email?: unknown; path_with_namespace?: unknown; web_url?: unknown;
  http_url_to_repo?: unknown; ssh_url_to_repo?: unknown; default_branch?: unknown;
  state?: unknown; title?: unknown; source_branch?: unknown; target_branch?: unknown;
  draft?: unknown; work_in_progress?: unknown; description?: unknown; sha?: unknown;
  diff_refs?: unknown; author?: unknown;
  created_at?: unknown; updated_at?: unknown; references?: unknown;
  labels?: unknown; detailed_merge_status?: unknown; merge_status?: unknown;
  issue_type?: unknown; assignees?: unknown; body?: unknown; system?: unknown;
  discussionThread?: unknown; position?: unknown; new_path?: unknown; old_path?: unknown;
  new_file?: unknown; deleted_file?: unknown; renamed_file?: unknown; diff?: unknown;
  author_name?: unknown; committed_date?: unknown; status?: unknown; started_at?: unknown;
  allow_failure?: unknown; finished_at?: unknown;
}
export interface GitLabMappedUser extends GitLabIdentity {
  id: string; username: string; avatarUrl?: string; name?: string; email?: unknown;
}
export interface GitLabMappedProject extends GitLabIdentity, SourceControlProjectRef {
  url: string;
  cloneUrl?: string; sshUrl?: string; defaultBranch?: string; remoteName?: string;
}
export interface GitLabMappedLabel { name: string; color?: string }
export interface GitLabMappedMergeRequest<Project = GitLabMappedProject> extends GitLabIdentity {
  id: string; number: number; project: Project; title: string; url: string;
  state: 'open' | 'closed' | 'merged'; draft: boolean; base: string; head: string;
  body?: string; headSha?: string; author?: GitLabMappedUser; createdAt?: string; updatedAt?: string;
  headLabel?: string; labels?: GitLabMappedLabel[]; mergeableState?: string; mergeable?: boolean;
  headProject?: GitLabMappedProject;
}
export interface GitLabMappedIssue<Project = GitLabMappedProject> extends GitLabIdentity {
  id: string; number: number; project: Project; title: string; url: string;
  state: 'open' | 'closed'; body?: string; author?: GitLabMappedUser;
  assignees?: Array<GitLabMappedUser | null>; labels?: GitLabMappedLabel[]; createdAt?: string; updatedAt?: string;
}
export interface GitLabMappedThread {
  id: string; resolved: boolean; resolvable: boolean; first: boolean; canResolve?: boolean; canReply?: boolean;
}
export interface GitLabMappedNote extends GitLabIdentity {
  id: string; url: JsonValue; body: string; author?: GitLabMappedUser; createdAt?: string; updatedAt?: string;
  thread?: GitLabMappedThread; path?: unknown; line?: number;
}
export interface GitLabMappedDiff {
  path: unknown; status: string; patch?: string; additions?: number; deletions?: number;
}
export interface GitLabMappedVerdict {
  state: string; url: JsonValue; createdAt: string | null; author?: GitLabMappedUser;
}
export interface GitLabMappedCISummary {
  state: string; total: number; success: number; failure: number; pending: number; startedAt?: string;
}
export interface GitLabMappedCIRun extends GitLabIdentity {
  id: string; name: string; status: string | undefined; conclusion: string | null;
  detailsUrl?: string; startedAt?: string; completedAt?: string;
}
const text = (value: unknown): value is string => isString(value) && Boolean(value);
const isInteger = (value: unknown): value is number => Number.isInteger(value);
const integer = (value: unknown): value is number => isInteger(value) && value >= 0;
const isPayload = (value: unknown): value is GitLabPayload => isPlainObject(value);
const hasPayloadFields = (value: unknown): value is GitLabPayload => value != null;
const hasHeadShaField = (value: unknown): value is { head_sha?: unknown } => value != null;
const hasFullField = (value: unknown): value is { full?: unknown } => value != null;
const hasHeadSha = (value: GitLabPayload): value is GitLabPayload & { diff_refs: { head_sha: string } } => {
  const refs = value.diff_refs;
  return hasHeadShaField(refs) && text(refs.head_sha);
};
const hasReference = (value: GitLabPayload): value is GitLabPayload & { references: { full: string } } => {
  const references = value.references;
  return hasFullField(references) && text(references.full);
};
const containsStatus = (statuses: Set<string>, value: unknown): value is string => isString(value) && statuses.has(value);
const fieldText = (payload: GitLabPayload, key: keyof GitLabPayload) => {
  const value = payload[key];
  return isString(value) ? value : '';
};
const isMappedState = (value: unknown): value is 'opened' | 'open' | 'locked' | 'merged' | 'closed' =>
  value === 'opened' || value === 'open' || value === 'locked' || value === 'merged' || value === 'closed';

export function mapGitLabUser(value: GitLabPayload | null | undefined, identity: GitLabIdentity) {
  if (!isPayload(value) || !integer(value.id) || !text(value.username)) return null;
  const user: GitLabMappedUser = { ...identity, id: String(value.id), username: value.username };
  if (text(value.avatar_url)) user.avatarUrl = value.avatar_url;
  if (text(value.name)) user.name = value.name;
  if (text(value.public_email || value.email)) user.email = value.public_email || value.email;
  return user;
}

export function mapGitLabProject(value: GitLabPayload | null | undefined, identity: GitLabIdentity, remoteName?: string) {
  if (!isPayload(value) || !integer(value.id) || !text(value.path_with_namespace) || !text(value.web_url)) return null;
  const segments = value.path_with_namespace.split('/').filter(Boolean);
  const name = segments.at(-1);
  if (segments.length < 2 || name === undefined) return null;
  const expectedPath = segments.join('/').toLowerCase();
  const matchesProject = (url: unknown): url is string => parseGitLabRemoteUrl(isString(url) ? url : null, identity.instance)?.projectPath.toLowerCase() === expectedPath;
  if (!matchesProject(value.web_url)
    || (value.http_url_to_repo != null && !matchesProject(value.http_url_to_repo))
    || (value.ssh_url_to_repo != null && parseGitLabSshProjectPath(isString(value.ssh_url_to_repo) ? value.ssh_url_to_repo : '')?.toLowerCase() !== expectedPath)) return null;
  const project: GitLabMappedProject = {
    ...identity,
    id: String(value.id),
    owner: segments.slice(0, -1).join('/'),
    name,
    url: value.web_url,
  };
  if (text(value.http_url_to_repo)) project.cloneUrl = value.http_url_to_repo;
  if (text(value.ssh_url_to_repo)) project.sshUrl = value.ssh_url_to_repo;
  if (text(value.default_branch)) project.defaultBranch = value.default_branch;
  if (remoteName !== undefined) project.remoteName = remoteName;
  return project;
}

function mapState(value: 'opened' | 'open' | 'locked' | 'merged' | 'closed' | undefined) {
  if (value === 'opened' || value === 'open' || value === 'locked') return 'open';
  if (value === 'merged') return 'merged';
  return value === 'closed' ? 'closed' : null;
}

export function mapGitLabMergeRequest<Project extends SourceControlProjectRef>(value: GitLabPayload | null | undefined, identity: GitLabIdentity, project: Project) {
  if (!isPayload(value) || !integer(value.iid) || !text(value.title) || !text(value.web_url)) return null;
  const rawState = value.state;
  const state = mapState(isMappedState(rawState) ? rawState : undefined);
  if (!state || !text(value.source_branch) || !text(value.target_branch)) return null;
  const request: GitLabMappedMergeRequest<Project> = {
    ...identity,
    id: `${project.id}#${value.iid}`,
    number: value.iid,
    project,
    title: value.title,
    url: value.web_url,
    state,
    draft: value.draft === true || value.work_in_progress === true,
    base: value.target_branch,
    head: value.source_branch,
  };
  if (isString(value.description)) request.body = value.description;
  if (text(value.sha)) request.headSha = value.sha;
  else if (hasHeadSha(value)) request.headSha = value.diff_refs.head_sha;
  const authorValue = value.author;
  const author = mapGitLabUser(hasPayloadFields(authorValue) ? authorValue : null, identity);
  if (author) request.author = author;
  if (text(value.created_at)) request.createdAt = value.created_at;
  if (text(value.updated_at)) request.updatedAt = value.updated_at;
  if (hasReference(value)) request.headLabel = value.references.full;
  const labels = value.labels;
  request.labels = mapLabels(Array.isArray(labels) ? labels : undefined);
  const rawMergeState = value.detailed_merge_status || value.merge_status;
  const mergeState = isString(rawMergeState) ? rawMergeState : '';
  if (mergeState) {
    request.mergeableState = mergeState;
    request.mergeable = ['mergeable', 'can_be_merged'].includes(mergeState);
  }
  return request;
}

function mapLabels(labels: unknown[] | undefined): GitLabMappedLabel[] {
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label) => {
    if (isString(label) && label) return [{ name: label }];
    if (!isPlainObject(label) || !text(label.name)) return [];
    const result: GitLabMappedLabel = { name: label.name };
    if (text(label.color)) result.color = label.color.replace(/^#/, '');
    return [result];
  });
}

export function mapGitLabIssue<Project extends SourceControlProjectRef>(value: GitLabPayload | null | undefined, identity: GitLabIdentity, project: Project) {
  if (!isPayload(value) || !integer(value.iid) || !text(value.title) || !text(value.web_url)) return null;
  if (value.issue_type === 'incident' || value.issue_type === 'test_case') return null;
  const rawState = value.state;
  const state = mapState(isMappedState(rawState) ? rawState : undefined);
  if (state !== 'open' && state !== 'closed') return null;
  const issue: GitLabMappedIssue<Project> = {
    ...identity,
    id: `${project.id}#${value.iid}`,
    number: value.iid,
    project,
    title: value.title,
    url: value.web_url,
    state,
  };
  if (isString(value.description)) issue.body = value.description;
  const authorValue = value.author;
  const author = mapGitLabUser(hasPayloadFields(authorValue) ? authorValue : null, identity);
  if (author) issue.author = author;
  if (Array.isArray(value.assignees)) issue.assignees = value.assignees.map((user) => mapGitLabUser(user, identity)).filter(Boolean);
  const labels = value.labels;
  issue.labels = mapLabels(Array.isArray(labels) ? labels : undefined);
  if (text(value.created_at)) issue.createdAt = value.created_at;
  if (text(value.updated_at)) issue.updatedAt = value.updated_at;
  return issue;
}

export function mapGitLabNote(value: GitLabPayload | null | undefined, identity: GitLabIdentity, fallbackUrl: JsonValue = '') {
  if (!isPayload(value) || !integer(value.id) || !isString(value.body) || value.system === true) return null;
  const note: GitLabMappedNote = { ...identity, id: String(value.id), url: fieldText(value, 'web_url') || fallbackUrl, body: value.body };
  const authorValue = value.author;
  const author = mapGitLabUser(hasPayloadFields(authorValue) ? authorValue : null, identity);
  if (author) note.author = author;
  if (text(value.created_at)) note.createdAt = value.created_at;
  if (text(value.updated_at)) note.updatedAt = value.updated_at;
  const thread = value.discussionThread;
  if (isPlainObject(thread) && text(thread.id)) {
    note.thread = { id: thread.id, resolved: thread.resolved === true, resolvable: thread.resolvable === true, first: thread.first === true };
    if (thread.canResolve === true || thread.canResolve === false) note.thread.canResolve = thread.canResolve;
    if (thread.canReply === true || thread.canReply === false) note.thread.canReply = thread.canReply;
  }
  const position = isPlainObject(value.position) ? value.position : null;
  if (position && text(position.new_path || position.old_path)) {
    note.path = position.new_path || position.old_path;
    if (integer(position.new_line)) note.line = position.new_line;
    else if (integer(position.old_line)) note.line = position.old_line;
  }
  return note;
}

const VERDICT_NOTES = new Map([
  ['approved this merge request', 'approved'],
  ['requested changes', 'changes_requested'],
]);

export function mapGitLabVerdictNote(value: GitLabPayload | null | undefined, identity: GitLabIdentity, fallbackUrl: JsonValue = '') {
  if (!isPayload(value) || value.system !== true || !isString(value.body)) return null;
  const state = VERDICT_NOTES.get(value.body.trim().toLowerCase());
  if (!state) return null;
  const verdict: GitLabMappedVerdict = { state, url: fieldText(value, 'web_url') || fallbackUrl, createdAt: text(value.created_at) ? value.created_at : null };
  const authorValue = value.author;
  const author = mapGitLabUser(hasPayloadFields(authorValue) ? authorValue : null, identity);
  if (author) verdict.author = author;
  return verdict;
}

export function mapGitLabCommit(value: GitLabPayload | null | undefined) {
  if (!isPayload(value) || !text(value.id)) return null;
  return {
    sha: value.id,
    headline: fieldText(value, 'title') || '',
    authorName: fieldText(value, 'author_name') || null,
    committedAt: fieldText(value, 'committed_date') || fieldText(value, 'created_at') || null,
    url: fieldText(value, 'web_url') || null,
  };
}

export function mapGitLabDiff(value: GitLabPayload | null | undefined) {
  if (!isPayload(value) || (!text(value.new_path) && !text(value.old_path))) return null;
  const file: GitLabMappedDiff = {
    path: value.new_path || value.old_path,
    status: value.new_file ? 'added' : value.deleted_file ? 'removed' : value.renamed_file ? 'renamed' : 'modified',
  };
  if (isString(value.diff)) {
    file.patch = value.diff;
    let additions = 0;
    let deletions = 0;
    for (const line of value.diff.split('\n')) {
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
    file.additions = additions;
    file.deletions = deletions;
  }
  return file;
}

const SUCCESS = new Set(['success', 'skipped']);
const FAILURE = new Set(['failed', 'canceled']);
const PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled']);

export function mapGitLabCI(pipeline: GitLabPayload | null | undefined, jobs: GitLabPayload[] | null | undefined, identity: GitLabIdentity) {
  if (!isPayload(pipeline) || !integer(pipeline.id)) return null;
  const list = Array.isArray(jobs) ? jobs.filter(isPlainObject) : [];
  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const job of list) {
    if (containsStatus(SUCCESS, job.status) || (job.allow_failure === true && containsStatus(FAILURE, job.status))) success += 1;
    else if (containsStatus(FAILURE, job.status)) failure += 1;
    else if (containsStatus(PENDING, job.status)) pending += 1;
  }
  const pipelineStatus = fieldText(pipeline, 'status');
  const state = failure > 0 || FAILURE.has(pipelineStatus)
    ? 'failure'
    : pending > 0 || PENDING.has(pipelineStatus)
      ? 'pending'
      : success > 0 || SUCCESS.has(pipelineStatus) ? 'success' : 'unknown';
  const summary: GitLabMappedCISummary = { state, total: list.length, success, failure, pending };
  if (text(pipeline.started_at)) summary.startedAt = pipeline.started_at;
  const runs = list.map((job) => {
    const run: GitLabMappedCIRun = {
      ...identity,
      id: String(job.id ?? `${pipeline.id}:${job.name ?? 'job'}`),
      name: fieldText(job, 'name') || 'CI job',
      status: fieldText(job, 'status') || undefined,
      conclusion: containsStatus(SUCCESS, job.status) ? 'success' : containsStatus(FAILURE, job.status) ? 'failure' : null,
    };
    if (text(job.web_url)) run.detailsUrl = job.web_url;
    if (text(job.started_at)) run.startedAt = job.started_at;
    if (text(job.finished_at)) run.completedAt = job.finished_at;
    return run;
  });
  return { summary, runs };
}
