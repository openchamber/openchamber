/**
 * GitHub payloads in, provider-neutral source-control DTOs out.
 *
 * Two halves: strict checks of what GitHub's REST API answered (a malformed
 * collection or record fails the read rather than becoming a partial or
 * empty success), and the mappers that turn checked payloads into the DTOs
 * every client parses for every provider (`Project`, `ChangeRequest`,
 * `Issue`, `IssueComment`, `CI`, ...). Each DTO carries the identity it was
 * read with, `{ provider: 'github', instance }`, where the instance is
 * github.com or the enterprise host.
 */

export const isPlainObject = (value) => Object.prototype.toString.call(value) === '[object Object]';
export const isProviderString = (value) => Object.prototype.toString.call(value) === '[object String]';

export function invalidProviderPayload(message) {
  return Object.assign(new Error(message), { code: 'MALFORMED_PROVIDER_RESPONSE' });
}

export function requireProviderArray(value, message) {
  if (!Array.isArray(value)) throw invalidProviderPayload(message);
  return value;
}

/** A repository network (`resolveRepoNetwork`) whose origin entry is the primary repository. */
export function requireGitHubRepoNetwork(value, primaryRepo) {
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

function requireGitHubUser(value, message) {
  if (value == null) return;
  if (!isPlainObject(value) || !Number.isSafeInteger(value.id) || !isProviderString(value.login) || !value.login.trim()) {
    throw invalidProviderPayload(message);
  }
}

function requireGitHubLabels(value, message) {
  if (value == null) return;
  for (const label of requireProviderArray(value, message)) {
    if (!isPlainObject(label) || !isProviderString(label.name) || !label.name.trim()) {
      throw invalidProviderPayload(message);
    }
  }
}

export function requireGitHubIssue(value, message) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.number) || value.number <= 0
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

export function requireGitHubComment(value, message) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.id)
    || !isProviderString(value.html_url) || !value.html_url.trim()
    || !isProviderString(value.body)) {
    throw invalidProviderPayload(message);
  }
  requireGitHubUser(value.user, message);
  return value;
}

/**
 * Whether a web or clone URL names `owner/repo`. `host`, when given, is the
 * instance the answer came from: a web URL of another host (a GitLab or
 * another GitHub's repository of the same name) is not this repository.
 */
export function matchesGitHubRepositoryUrl(value, owner, repo, host = '') {
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

export function requireGitHubPullRequest(value, message) {
  if (!isPlainObject(value)
    || !Number.isSafeInteger(value.number) || value.number <= 0
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

export function requireGitHubReviewComment(value) {
  const comment = requireGitHubComment(value, 'GitHub returned an invalid review comment');
  if (!isProviderString(comment.path) || !comment.path.trim()) {
    throw invalidProviderPayload('GitHub returned an invalid review comment');
  }
  return comment;
}

export function requireGitHubPullFile(value) {
  if (!isPlainObject(value)
    || !isProviderString(value.filename) || !value.filename.trim()
    || !isProviderString(value.status) || !value.status.trim()
    || !Number.isSafeInteger(value.additions) || value.additions < 0
    || !Number.isSafeInteger(value.deletions) || value.deletions < 0
    || !Number.isSafeInteger(value.changes) || value.changes < 0
    || (value.patch != null && !isProviderString(value.patch))) {
    throw invalidProviderPayload('GitHub returned an invalid pull request file');
  }
  return value;
}

export function requireGitHubCheckRuns(value) {
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

export function requireGitHubStatuses(value) {
  const statuses = requireProviderArray(value, 'GitHub returned invalid combined status');
  for (const status of statuses) {
    if (!isPlainObject(status) || !isProviderString(status.state) || !status.state.trim()) {
      throw invalidProviderPayload('GitHub returned an invalid combined status item');
    }
  }
  return statuses;
}

export function requireGitHubWorkflowJobs(value) {
  const jobs = requireProviderArray(value, 'GitHub returned invalid workflow jobs');
  for (const job of jobs) {
    if (!isPlainObject(job) || !Number.isSafeInteger(job.id)
      || !isProviderString(job.name) || !job.name.trim()) {
      throw invalidProviderPayload('GitHub returned an invalid workflow job');
    }
  }
  return jobs;
}

const text = (value) => (isProviderString(value) && value ? value : undefined);
const httpUrl = (value) => {
  if (!isProviderString(value) || !value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A user, from REST (`login`, `id`, `avatar_url`) or the account summary the
 * auth routes build (`login`, `id`, `avatarUrl`, `name`, `email`).
 */
export function mapUser(user, identity) {
  const result = { ...identity, id: String(user.id ?? user.login), username: user.login };
  const avatarUrl = httpUrl(user.avatarUrl ?? user.avatar_url);
  if (avatarUrl) result.avatarUrl = avatarUrl;
  if (text(user.name)) result.name = user.name;
  if (text(user.email)) result.email = user.email;
  return result;
}

const mapOptionalUser = (user, identity) => (isPlainObject(user) && isProviderString(user.login) && user.login
  ? mapUser(user, identity)
  : null);

/**
 * A repository as a project: `owner`/`repo` plus what the caller knows of it.
 * The web URL defaults to the instance's own page for it.
 */
export function mapProject(repo, identity) {
  const result = {
    ...identity,
    id: `${repo.owner}/${repo.repo}`,
    owner: repo.owner,
    name: repo.repo,
    url: httpUrl(repo.url) ?? `https://${identity.instance}/${repo.owner}/${repo.repo}`,
  };
  if (text(repo.cloneUrl)) result.cloneUrl = repo.cloneUrl;
  if (text(repo.sshUrl)) result.sshUrl = repo.sshUrl;
  if (text(repo.defaultBranch)) result.defaultBranch = repo.defaultBranch;
  if (repo.defaultBranchSha !== undefined) result.defaultBranchSha = text(repo.defaultBranchSha) ?? null;
  if (repo.remoteName !== undefined) result.remoteName = text(repo.remoteName) ?? null;
  return result;
}

const mapLabels = (labels) => (Array.isArray(labels) ? labels.flatMap((label) => {
  if (!isPlainObject(label) || !text(label.name)) return [];
  return [isProviderString(label.color) && label.color ? { name: label.name, color: label.color } : { name: label.name }];
}) : []);

/** A pull request from REST (`pulls.get`, `pulls.list`, `pulls.create`). */
export function mapChangeRequest(pr, project, identity) {
  const state = pr.merged === true || text(pr.merged_at) ? 'merged' : pr.state === 'closed' ? 'closed' : 'open';
  const result = {
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
  if (pr.mergeable !== undefined) result.mergeable = typeof pr.mergeable === 'boolean' ? pr.mergeable : null;
  if (pr.mergeable_state !== undefined) result.mergeableState = text(pr.mergeable_state) ?? null;
  if (Array.isArray(pr.labels)) result.labels = mapLabels(pr.labels);
  return result;
}

/** An issue from REST (`issues.get`, `issues.listForRepo`). */
export function mapIssue(issue, project, identity) {
  const result = {
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
    result.assignees = issue.assignees.flatMap((user) => {
      const mapped = mapOptionalUser(user, identity);
      return mapped ? [mapped] : [];
    });
  }
  if (text(issue.created_at)) result.createdAt = issue.created_at;
  if (text(issue.updated_at)) result.updatedAt = issue.updated_at;
  return result;
}

/** A conversation comment from REST (`issues.listComments`). */
export function mapComment(comment, identity) {
  const result = {
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

/** A line comment from REST (`pulls.listReviewComments`). */
export function mapReviewComment(comment, identity) {
  return {
    ...mapComment(comment, identity),
    path: comment.path,
    line: typeof comment.line === 'number' ? comment.line : null,
    position: typeof comment.position === 'number' ? comment.position : null,
  };
}

/** A changed file from REST (`pulls.listFiles`). */
export function mapFile(file) {
  const result = {
    path: file.filename,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    changes: file.changes,
  };
  if (text(file.patch)) result.patch = file.patch;
  return result;
}

/** A check run from REST, with the workflow job and annotations the detailed read joined to it. */
export function mapCheckRun(run, { job, annotations } = {}, identity) {
  const result = { ...identity, id: String(run.id), name: run.name, status: run.status };
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

/** The job a check run's details URL names, from `actions.listJobsForWorkflowRun`. */
export function mapWorkflowJob({ runId, jobId, job, detailsUrl }) {
  if (!job) {
    const result = { runId: String(runId), url: httpUrl(detailsUrl) };
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
      ? job.steps.filter((step) => text(step?.name)).map((step) => ({
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

/** Annotations of a failed check run, from `checks.listAnnotations`; ones without a message are dropped. */
export function mapAnnotations(annotations) {
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

/** A checks summary (`checks-summary.js`) and its runs as CI. */
export function mapCI(summary, runs) {
  if (!summary) return null;
  const result = {
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

/** A user for an auth answer, or an account's stored user. */
export function mapAccount(account, identity) {
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
  };
}
