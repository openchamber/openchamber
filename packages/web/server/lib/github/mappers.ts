
import type { RestEndpointMethodTypes } from '@octokit/rest';
import type { NetworkRepository } from './repo/fork-detection.js';
import type { ChecksSummary } from './checks-summary.js';
import { hasProperty } from './contracts.js';
import type { GitHubEnvelope } from './contracts.js';

type Rest = RestEndpointMethodTypes;
type Pull = Rest['pulls']['get']['response']['data'];
type Issue = Rest['issues']['get']['response']['data'];
type Comment = Rest['issues']['getComment']['response']['data'];
type ReviewComment = Rest['pulls']['getReviewComment']['response']['data'];
type PullFile = Rest['pulls']['listFiles']['response']['data'][number];
type Run = Rest['checks']['listForRef']['response']['data']['check_runs'][number];
type Job = Rest['actions']['listJobsForWorkflowRun']['response']['data']['jobs'][number];
type Annotation = Rest['checks']['listAnnotations']['response']['data'][number];
interface Identity { provider: string; instance: string }
interface UserInput {
  id?: number | string; login: string; avatarUrl?: unknown; avatar_url?: unknown; name?: unknown; email?: unknown;
}
interface User extends Identity { id: string; username: string; avatarUrl?: string; name?: string; email?: string }
interface ProjectInput {
  owner: string; repo: string; url?: unknown; cloneUrl?: unknown; sshUrl?: unknown; defaultBranch?: unknown;
  defaultBranchSha?: unknown; remoteName?: unknown;
}
export interface Project extends Identity {
  id: string; owner: string; name: string; url: string;
  cloneUrl?: string; sshUrl?: string; defaultBranch?: string; defaultBranchSha?: string | null; remoteName?: string | null;
}
interface Label { name: string; color?: string }
export interface ChangeRequest extends Identity {
  id: string; number: number; project: Project; title: string; url: string; state: string; draft: boolean;
  base: string | undefined; head: string | undefined; body: string; headSha?: string; author?: User;
  createdAt?: string; updatedAt?: string; headLabel?: string; headProject?: Project | null;
  mergeable?: boolean | null; mergeableState?: string | null; labels?: Label[];
}
export interface IssueDTO extends Identity {
  id: string; number: number; project: Project; title: string; url: string; state: string; body: string; author: User | null;
  labels: Label[]; assignees?: User[]; createdAt?: string; updatedAt?: string;
}
export interface CommentDTO extends Identity {
  id: string; url: string; body: string; author: User | null; createdAt?: string; updatedAt?: string;
}
interface FileDTO { path: string; status: string; additions: number; deletions: number; changes: number; patch?: string }
interface WorkflowJob {
  runId: string; jobId?: string; url: string | undefined; name?: string; workflowName?: string | undefined;
  conclusion?: string | null; steps?: {
    name: string; status: string | undefined; conclusion: string | null; number: number | undefined;
    startedAt: string | undefined; completedAt: string | undefined;
  }[] | undefined;
}
interface CheckRunDTO extends Identity {
  id: string; name: string; status: string; startedAt?: string; completedAt?: string; conclusion?: string | null; detailsUrl?: string;
  application?: { name: string | undefined; slug: string | undefined };
  output?: { title: string | undefined; summary: string | undefined; text: string | undefined };
  job?: WorkflowJob; annotations?: ReturnType<typeof mapAnnotations>;
}
export interface CI {
  summary: Pick<ChecksSummary, 'state' | 'total' | 'success' | 'failure' | 'pending'> & Partial<Pick<ChecksSummary, 'inProgress' | 'queued' | 'startedAt'>>;
  runs?: CheckRunDTO[];
}
interface AccountInput {
  id: string; credentialId?: string; credentialRevision?: number; providerUserId?: string; providerUserStatus?: string;
  user?: UserInput; scope?: string; current?: boolean; source?: string; status?: string; usable?: boolean;
}
interface PullInput {
  number?: unknown; title?: unknown; html_url?: unknown; state?: unknown; user?: unknown;
  base?: { ref?: unknown } | null;
  head?: { ref?: unknown; repo?: {
    owner?: { login?: unknown } | null; name?: unknown; html_url?: unknown; clone_url?: unknown; ssh_url?: unknown;
  } | null } | null;
}
interface IssueInput {
  number?: unknown; title?: unknown; html_url?: unknown; state?: unknown; user?: unknown; labels?: unknown; assignees?: unknown;
}
interface CommentInput { id?: unknown; html_url?: unknown; body?: unknown; user?: unknown }
interface FileInput { filename?: unknown; status?: unknown; additions?: unknown; deletions?: unknown; changes?: unknown; patch?: unknown }
interface RunInput { id?: unknown; name?: unknown; status?: unknown }
interface StatusInput { state?: unknown }
interface JobInput { id?: unknown; name?: unknown }

export const isPlainObject = <T>(value: T): value is NonNullable<T> & object => Object.prototype.toString.call(value) === '[object Object]';
export const isProviderString = (value: unknown): value is string => Object.prototype.toString.call(value) === '[object String]';
const isProviderBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isProviderNumber = (value: unknown): value is number => typeof value === 'number';
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

export function invalidProviderPayload(message: string) {
  return Object.assign(new Error(message), { code: 'MALFORMED_PROVIDER_RESPONSE' });
}

export function requireProviderArray<T>(value: T[], message: string): T[];
export function requireProviderArray(value: GitHubEnvelope['data'], message: string): unknown[];
export function requireProviderArray(value: GitHubEnvelope['data'], message: string): unknown[] {
  if (!Array.isArray(value)) throw invalidProviderPayload(message);
  return value;
}

export function requireGitHubRepoNetwork(value: NetworkRepository[] | null, primaryRepo?: { owner: string; repo: string }) {
  if (value === null) return value;
  const network = requireProviderArray(value, 'GitHub returned invalid fork metadata');
  if (network.length === 0) throw invalidProviderPayload('GitHub returned invalid fork metadata');
  for (const repo of network) {
    if (!isPlainObject(repo)
      || !isProviderString(repo.owner) || !repo.owner.trim()
      || !isProviderString(repo.repo) || !repo.repo.trim()
      || (repo.source !== 'origin' && repo.source !== 'upstream')) {
      throw invalidProviderPayload('GitHub returned invalid fork metadata');
    }
  }
  if (primaryRepo && !network.some((repo) => repo.source === 'origin'
    && repo.owner === primaryRepo.owner && repo.repo === primaryRepo.repo)) {
    throw invalidProviderPayload('GitHub returned invalid fork metadata');
  }
  return network;
}

function requireGitHubUser(value: GitHubEnvelope['data'], message: string) {
  if (value == null) return;
  if (!isPlainObject(value) || !hasProperty(value, 'id') || !Number.isSafeInteger(value.id)
    || !hasProperty(value, 'login') || !isProviderString(value.login) || !value.login.trim()) {
    throw invalidProviderPayload(message);
  }
}

function requireGitHubLabels(value: GitHubEnvelope['data'], message: string) {
  if (value == null) return;
  for (const label of requireProviderArray(value, message)) {
    if (!isPlainObject(label) || !hasProperty(label, 'name') || !isProviderString(label.name) || !label.name.trim()) {
      throw invalidProviderPayload(message);
    }
  }
}

export function requireGitHubIssue<Value extends IssueInput>(value: Value, message: string) {
  if (!isPlainObject(value)
    || !isSafeInteger(value.number) || value.number <= 0
    || !isProviderString(value.title)
    || !isProviderString(value.html_url) || !value.html_url.trim()
    || (value.state !== 'open' && value.state !== 'closed')) {
    throw invalidProviderPayload(message);
  }
  requireGitHubUser(value.user, message);
  requireGitHubLabels(value.labels, message);
  if (value.assignees != null) {
    for (const assignee of requireProviderArray(value.assignees, message)) requireGitHubUser(assignee, message);
  }
  return value;
}

export function requireGitHubComment<Value extends CommentInput>(value: Value, message: string) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.id)
    || !isProviderString(value.html_url) || !value.html_url.trim()
    || !isProviderString(value.body)) {
    throw invalidProviderPayload(message);
  }
  requireGitHubUser(value.user, message);
  return value;
}

export function matchesGitHubRepositoryUrl(value: GitHubEnvelope['data'], owner: string, repo: string, host = '') {
  if (!isProviderString(value) || !value.trim()) return false;
  const expectedPath = `${owner}/${repo}`.toLowerCase();
  const raw = value.trim();
  const scpMatch = raw.match(/^git@([^/\s:]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (scpMatch) return `${scpMatch[2]}/${scpMatch[3]}`.toLowerCase() === expectedPath;

  try {
    const url = new URL(raw);
    if (!['https:', 'ssh:'].includes(url.protocol)
      || url.password || url.search || url.hash
      || (url.protocol === 'https:' && url.username)
      || (url.protocol === 'ssh:' && url.username !== 'git')) {
      return false;
    }
    if (host && url.protocol === 'https:' && url.hostname.toLowerCase() !== host) return false;
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    return path.toLowerCase() === expectedPath;
  } catch {
    return false;
  }
}

export function requireGitHubPullRequest<Value extends PullInput>(value: Value, message: string) {
  if (!isPlainObject(value)
    || !isSafeInteger(value.number) || value.number <= 0
    || !isProviderString(value.title)
    || !isProviderString(value.html_url) || !value.html_url.trim()
    || (value.state !== 'open' && value.state !== 'closed')
    || !isPlainObject(value.base) || !isProviderString(value.base.ref) || !value.base.ref.trim()
    || !isPlainObject(value.head) || !isProviderString(value.head.ref) || !value.head.ref.trim()) {
    throw invalidProviderPayload(message);
  }
  requireGitHubUser(value.user, message);
  if (value.head.repo != null) {
    const repo = value.head.repo;
    if (!isPlainObject(repo)
      || !isPlainObject(repo.owner) || !isProviderString(repo.owner.login) || !repo.owner.login.trim()
      || !isProviderString(repo.name) || !repo.name.trim()
      || !matchesGitHubRepositoryUrl(repo.html_url, repo.owner.login, repo.name)
      || (repo.clone_url != null && !matchesGitHubRepositoryUrl(repo.clone_url, repo.owner.login, repo.name))
      || (repo.ssh_url != null && !matchesGitHubRepositoryUrl(repo.ssh_url, repo.owner.login, repo.name))) {
      throw invalidProviderPayload(message);
    }
  }
  return value;
}

export function requireGitHubReviewComment(value: ReviewComment) {
  const comment = requireGitHubComment(value, 'GitHub returned an invalid review comment');
  if (!isProviderString(comment.path) || !comment.path.trim()) {
    throw invalidProviderPayload('GitHub returned an invalid review comment');
  }
  return comment;
}

export function requireGitHubPullFile<Value extends FileInput>(value: Value) {
  if (!isPlainObject(value)
    || !isProviderString(value.filename) || !value.filename.trim()
    || !isProviderString(value.status) || !value.status.trim()
    || !isSafeInteger(value.additions) || value.additions < 0
    || !isSafeInteger(value.deletions) || value.deletions < 0
    || !isSafeInteger(value.changes) || value.changes < 0
    || (value.patch != null && !isProviderString(value.patch))) {
    throw invalidProviderPayload('GitHub returned an invalid pull request file');
  }
  return value;
}

export function requireGitHubCheckRuns<Value extends RunInput>(value: Value[]) {
  const runs = requireProviderArray(value, 'GitHub returned invalid check runs');
  for (const run of runs) {
    if (!isPlainObject(run) || !Number.isSafeInteger(run.id)
      || !isProviderString(run.name) || !run.name.trim()
      || !isProviderString(run.status) || !run.status.trim()) {
      throw invalidProviderPayload('GitHub returned an invalid check run');
    }
  }
  return runs;
}

export function requireGitHubStatuses<Value extends StatusInput>(value: Value[]) {
  const statuses = requireProviderArray(value, 'GitHub returned invalid combined status');
  for (const status of statuses) {
    if (!isPlainObject(status) || !isProviderString(status.state) || !status.state.trim()) {
      throw invalidProviderPayload('GitHub returned an invalid combined status item');
    }
  }
  return statuses;
}

export function requireGitHubWorkflowJobs<Value extends JobInput>(value: Value[]) {
  const jobs = requireProviderArray(value, 'GitHub returned invalid workflow jobs');
  for (const job of jobs) {
    if (!isPlainObject(job) || !Number.isSafeInteger(job.id)
      || !isProviderString(job.name) || !job.name.trim()) {
      throw invalidProviderPayload('GitHub returned an invalid workflow job');
    }
  }
  return jobs;
}

const text = (value: UserInput['name']) => (isProviderString(value) && value ? value : undefined);
const httpUrl = (value: UserInput['avatarUrl']) => {
  if (!isProviderString(value) || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
};

export function mapUser(user: UserInput, identity: Identity) {
  const result: User = { ...identity, id: String(user.id ?? user.login), username: user.login };
  const avatarUrl = httpUrl(user.avatarUrl ?? user.avatar_url);
  if (avatarUrl) result.avatarUrl = avatarUrl;
  if (isProviderString(user.name) && text(user.name)) result.name = user.name;
  if (isProviderString(user.email) && text(user.email)) result.email = user.email;
  return result;
}

const mapOptionalUser = (user: UserInput | null | undefined, identity: Identity) => (isPlainObject(user) && isProviderString(user.login) && user.login
  ? mapUser(user, identity)
  : null);

export function mapProject(repo: ProjectInput, identity: Identity) {
  const result: Project = {
    ...identity,
    id: `${repo.owner}/${repo.repo}`,
    owner: repo.owner,
    name: repo.repo,
    url: httpUrl(repo.url) ?? `https://${identity.instance}/${repo.owner}/${repo.repo}`,
  };
  if (isProviderString(repo.cloneUrl) && text(repo.cloneUrl)) result.cloneUrl = repo.cloneUrl;
  if (isProviderString(repo.sshUrl) && text(repo.sshUrl)) result.sshUrl = repo.sshUrl;
  if (isProviderString(repo.defaultBranch) && text(repo.defaultBranch)) result.defaultBranch = repo.defaultBranch;
  if (repo.defaultBranchSha !== undefined) result.defaultBranchSha = text(repo.defaultBranchSha) ?? null;
  if (repo.remoteName !== undefined) result.remoteName = text(repo.remoteName) ?? null;
  return result;
}

const mapLabels = (labels: Issue['labels']) => (Array.isArray(labels) ? labels.flatMap((label) => {
  if (!isPlainObject(label) || !text(label.name)) return [];
  return [isProviderString(label.color) && label.color ? { name: label.name, color: label.color } : { name: label.name }];
}) : []);

export function mapChangeRequest(pr: Pull, project: Project, identity: Identity) {
  const state = pr.merged === true || text(pr.merged_at) ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  const result: ChangeRequest = {
    ...identity,
    id: `${project.id}#${pr.number}`,
    number: pr.number,
    project,
    title: pr.title,
    url: pr.html_url,
    state,
    draft: Boolean(pr.draft),
    base: pr.base?.ref,
    head: pr.head?.ref,
    body: isProviderString(pr.body) ? pr.body : '',
  };
  if (text(pr.head?.sha)) result.headSha = pr.head.sha;
  const author = mapOptionalUser(pr.user, identity);
  if (author) result.author = author;
  if (text(pr.created_at)) result.createdAt = pr.created_at;
  if (text(pr.updated_at)) result.updatedAt = pr.updated_at;
  if (text(pr.head?.label)) result.headLabel = pr.head.label;
  const headRepo = pr.head?.repo;
  if (headRepo !== undefined) {
    result.headProject = isPlainObject(headRepo) && text(headRepo.owner?.login) && text(headRepo.name) && httpUrl(headRepo.html_url)
      ? mapProject({
        owner: headRepo.owner.login, repo: headRepo.name, url: headRepo.html_url,
        cloneUrl: headRepo.clone_url, sshUrl: headRepo.ssh_url,
      }, identity)
      : null;
  }
  if (pr.mergeable !== undefined) result.mergeable = isProviderBoolean(pr.mergeable) ? pr.mergeable : null;
  if (pr.mergeable_state !== undefined) result.mergeableState = text(pr.mergeable_state) ?? null;
  if (Array.isArray(pr.labels)) result.labels = mapLabels(pr.labels);
  return result;
}

export function mapIssue(issue: Issue, project: Project, identity: Identity) {
  const result: IssueDTO = {
    ...identity,
    id: `${project.id}#${issue.number}`,
    number: issue.number,
    project,
    title: issue.title,
    url: issue.html_url,
    state: issue.state === 'closed' ? 'closed' : 'open',
    body: isProviderString(issue.body) ? issue.body : '',
    author: mapOptionalUser(issue.user, identity),
    labels: mapLabels(issue.labels),
  };
  if (Array.isArray(issue.assignees)) {
    result.assignees = issue.assignees.flatMap((user: NonNullable<Issue['assignees']>[number]) => {
      const mapped = mapOptionalUser(user, identity);
      return mapped ? [mapped] : [];
    });
  }
  if (text(issue.created_at)) result.createdAt = issue.created_at;
  if (text(issue.updated_at)) result.updatedAt = issue.updated_at;
  return result;
}

export function mapComment(comment: Comment, identity: Identity) {
  const result: CommentDTO = {
    ...identity,
    id: String(comment.id),
    url: comment.html_url,
    body: isProviderString(comment.body) ? comment.body : '',
    author: mapOptionalUser(comment.user, identity),
  };
  if (text(comment.created_at)) result.createdAt = comment.created_at;
  if (text(comment.updated_at)) result.updatedAt = comment.updated_at;
  return result;
}

export function mapReviewComment(comment: ReviewComment, identity: Identity) {
  return {
    ...mapComment(comment, identity),
    path: comment.path,
    line: isProviderNumber(comment.line) ? comment.line : null,
    position: isProviderNumber(comment.position) ? comment.position : null,
  };
}

export function mapFile(file: PullFile) {
  const result: FileDTO = {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  };
  if (text(file.patch)) result.patch = file.patch;
  return result;
}

export function mapCheckRun(run: Run, { job, annotations }: { job?: WorkflowJob; annotations?: ReturnType<typeof mapAnnotations> } = {}, identity: Identity) {
  const result: CheckRunDTO = { ...identity, id: String(run.id), name: run.name, status: run.status };
  if (text(run.started_at)) result.startedAt = run.started_at;
  if (text(run.completed_at)) result.completedAt = run.completed_at;
  if (run.conclusion !== undefined) result.conclusion = text(run.conclusion) ?? null;
  const detailsUrl = httpUrl(run.details_url);
  if (detailsUrl) result.detailsUrl = detailsUrl;
  if (isPlainObject(run.app)) result.application = { name: text(run.app.name), slug: text(run.app.slug) };
  if (isPlainObject(run.output)) {
    result.output = { title: text(run.output.title), summary: text(run.output.summary), text: text(run.output.text) };
  }
  if (job) result.job = job;
  if (annotations) result.annotations = annotations;
  return result;
}

export function mapWorkflowJob({ runId, jobId, job, detailsUrl }: { runId: number; jobId: number | null; job: Job | null; detailsUrl: string | null }): WorkflowJob {
  if (!job) {
    const result: WorkflowJob = { runId: String(runId), url: httpUrl(detailsUrl) };
    if (jobId) result.jobId = String(jobId);
    return result;
  }
  return {
    runId: String(runId),
    jobId: String(job.id),
    url: httpUrl(job.html_url),
    name: job.name,
    workflowName: text(job.workflow_name),
    conclusion: text(job.conclusion) ?? null,
    steps: Array.isArray(job.steps)
      ? job.steps.filter((step: NonNullable<Job['steps']>[number]) => text(step?.name)).map((step: NonNullable<Job['steps']>[number]) => ({
        name: step.name,
        status: text(step.status),
        conclusion: text(step.conclusion) ?? null,
        number: Number.isSafeInteger(step.number) && step.number >= 0 ? step.number : undefined,
        startedAt: text(step.started_at),
        completedAt: text(step.completed_at),
      }))
      : undefined,
  };
}

export function mapAnnotations(annotations: Annotation[]) {
  return annotations.flatMap((annotation) => (text(annotation?.message) ? [{
    path: text(annotation.path),
    startLine: Number.isSafeInteger(annotation.start_line) ? annotation.start_line : undefined,
    endLine: Number.isSafeInteger(annotation.end_line) ? annotation.end_line : undefined,
    level: text(annotation.annotation_level),
    message: annotation.message,
    title: text(annotation.title),
    rawDetails: text(annotation.raw_details),
  }] : []));
}

export function mapCI(summary: CI['summary'] | null, runs?: CheckRunDTO[]) {
  if (!summary) return null;
  const result: CI = {
    summary: {
      state: summary.state,
      total: summary.total,
      success: summary.success,
      failure: summary.failure,
      pending: summary.pending,
    },
  };
  if (summary.inProgress !== undefined) result.summary.inProgress = summary.inProgress;
  if (summary.queued !== undefined) result.summary.queued = summary.queued;
  if (summary.startedAt) result.summary.startedAt = summary.startedAt;
  if (runs) result.runs = runs;
  return result;
}

export function mapAccount(account: AccountInput, identity: Identity) {
  return {
    id: account.id,
    credentialId: account.credentialId ?? account.id,
    credentialRevision: account.credentialRevision,
    providerUserId: account.providerUserId,
    providerUserStatus: account.providerUserStatus === 'unavailable' ? 'unavailable' : 'available',
    user: mapUser(account.user ?? { login: String(account.id) }, identity),
    scope: account.scope,
    current: Boolean(account.current),
    source: account.source === 'gh-cli' || account.source === 'cli' ? 'cli' : account.source === 'pat' ? 'pat' : 'oauth',
    status: account.status === 'invalid' ? 'invalid' : 'valid',
    usable: account.usable !== false,
  };
}
