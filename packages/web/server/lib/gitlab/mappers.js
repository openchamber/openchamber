import { isPlainObject, isString } from './validation.js';
import { parseGitLabRemoteUrl } from './repo.js';

const text = (value) => isString(value) ? value : '';
const integer = (value) => Number.isInteger(value) && value >= 0 ? value : null;

function mapGitLabUser(value, identity) {
  if (!isPlainObject(value) || integer(value.id) === null || !text(value.username)) return null;
  const user = { ...identity, id: String(value.id), username: value.username };
  if (text(value.avatar_url)) user.avatarUrl = value.avatar_url;
  if (text(value.name)) user.name = value.name;
  if (text(value.public_email || value.email)) user.email = value.public_email || value.email;
  return user;
}

export function mapGitLabProject(value, identity, remoteName) {
  if (!isPlainObject(value) || integer(value.id) === null || !text(value.path_with_namespace) || !text(value.web_url)) return null;
  const segments = value.path_with_namespace.split('/').filter(Boolean);
  if (segments.length < 2) return null;
  const expectedPath = segments.join('/').toLowerCase();
  const matchesProject = (url) => parseGitLabRemoteUrl(url, identity.instance)?.projectPath.toLowerCase() === expectedPath;
  if (!matchesProject(value.web_url)
    || (value.http_url_to_repo != null && !matchesProject(value.http_url_to_repo))
    || (value.ssh_url_to_repo != null && !matchesProject(value.ssh_url_to_repo))) return null;
  const project = {
    ...identity,
    id: String(value.id),
    owner: segments.slice(0, -1).join('/'),
    name: segments.at(-1),
    url: value.web_url,
  };
  if (text(value.http_url_to_repo)) project.cloneUrl = value.http_url_to_repo;
  if (text(value.ssh_url_to_repo)) project.sshUrl = value.ssh_url_to_repo;
  if (text(value.default_branch)) project.defaultBranch = value.default_branch;
  if (remoteName !== undefined) project.remoteName = remoteName;
  return project;
}

function mapState(value) {
  if (value === 'opened' || value === 'open' || value === 'locked') return 'open';
  if (value === 'merged') return 'merged';
  return value === 'closed' ? 'closed' : null;
}

export function mapGitLabMergeRequest(value, identity, project) {
  if (!isPlainObject(value) || integer(value.iid) === null || !text(value.title) || !text(value.web_url)) return null;
  const state = mapState(value.state);
  if (!state || !text(value.source_branch) || !text(value.target_branch)) return null;
  const request = {
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
  else if (text(value.diff_refs?.head_sha)) request.headSha = value.diff_refs.head_sha;
  const author = mapGitLabUser(value.author, identity);
  if (author) request.author = author;
  if (text(value.created_at)) request.createdAt = value.created_at;
  if (text(value.updated_at)) request.updatedAt = value.updated_at;
  if (text(value.references?.full)) request.headLabel = value.references.full;
  const mergeState = text(value.detailed_merge_status || value.merge_status);
  if (mergeState) {
    request.mergeableState = mergeState;
    request.mergeable = ['mergeable', 'can_be_merged'].includes(mergeState);
  }
  return request;
}

function mapLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label) => {
    if (isString(label) && label) return [{ name: label }];
    if (!isPlainObject(label) || !text(label.name)) return [];
    const result = { name: label.name };
    if (text(label.color)) result.color = label.color.replace(/^#/, '');
    return [result];
  });
}

export function mapGitLabIssue(value, identity, project) {
  if (!isPlainObject(value) || integer(value.iid) === null || !text(value.title) || !text(value.web_url)) return null;
  if (value.issue_type === 'incident' || value.issue_type === 'test_case') return null;
  const state = mapState(value.state);
  if (state !== 'open' && state !== 'closed') return null;
  const issue = {
    ...identity,
    id: `${project.id}#${value.iid}`,
    number: value.iid,
    project,
    title: value.title,
    url: value.web_url,
    state,
  };
  if (isString(value.description)) issue.body = value.description;
  const author = mapGitLabUser(value.author, identity);
  if (author) issue.author = author;
  if (Array.isArray(value.assignees)) issue.assignees = value.assignees.map((user) => mapGitLabUser(user, identity)).filter(Boolean);
  issue.labels = mapLabels(value.labels);
  if (text(value.created_at)) issue.createdAt = value.created_at;
  if (text(value.updated_at)) issue.updatedAt = value.updated_at;
  return issue;
}

export function mapGitLabNote(value, identity, fallbackUrl = '') {
  if (!isPlainObject(value) || integer(value.id) === null || !isString(value.body) || value.system === true) return null;
  const note = { ...identity, id: String(value.id), url: text(value.web_url) || fallbackUrl, body: value.body };
  const author = mapGitLabUser(value.author, identity);
  if (author) note.author = author;
  if (text(value.created_at)) note.createdAt = value.created_at;
  if (text(value.updated_at)) note.updatedAt = value.updated_at;
  const position = isPlainObject(value.position) ? value.position : null;
  if (position && text(position.new_path || position.old_path)) {
    note.path = position.new_path || position.old_path;
    if (integer(position.new_line) !== null) note.line = position.new_line;
    else if (integer(position.old_line) !== null) note.line = position.old_line;
  }
  return note;
}

export function mapGitLabDiff(value) {
  if (!isPlainObject(value) || (!text(value.new_path) && !text(value.old_path))) return null;
  const file = {
    path: value.new_path || value.old_path,
    status: value.new_file ? 'added' : value.deleted_file ? 'removed' : value.renamed_file ? 'renamed' : 'modified',
  };
  if (isString(value.diff)) file.patch = value.diff;
  return file;
}

const SUCCESS = new Set(['success', 'skipped']);
const FAILURE = new Set(['failed', 'canceled']);
const PENDING = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running', 'manual', 'scheduled']);

export function mapGitLabCI(pipeline, jobs, identity) {
  if (!isPlainObject(pipeline) || integer(pipeline.id) === null) return null;
  const list = Array.isArray(jobs) ? jobs.filter(isPlainObject) : [];
  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const job of list) {
    if (SUCCESS.has(job.status)) success += 1;
    else if (FAILURE.has(job.status)) failure += 1;
    else if (PENDING.has(job.status)) pending += 1;
  }
  const pipelineStatus = text(pipeline.status);
  const state = failure > 0 || FAILURE.has(pipelineStatus)
    ? 'failure'
    : pending > 0 || PENDING.has(pipelineStatus)
      ? 'pending'
      : success > 0 || SUCCESS.has(pipelineStatus) ? 'success' : 'unknown';
  const summary = { state, total: list.length, success, failure, pending };
  if (text(pipeline.started_at)) summary.startedAt = pipeline.started_at;
  const runs = list.map((job) => {
    const run = {
      ...identity,
      id: String(job.id ?? `${pipeline.id}:${job.name ?? 'job'}`),
      name: text(job.name) || 'CI job',
      status: text(job.status) || undefined,
      conclusion: SUCCESS.has(job.status) ? 'success' : FAILURE.has(job.status) ? 'failure' : null,
    };
    if (text(job.web_url)) run.detailsUrl = job.web_url;
    if (text(job.started_at)) run.startedAt = job.started_at;
    if (text(job.finished_at)) run.completedAt = job.finished_at;
    return run;
  });
  return { summary, runs };
}
