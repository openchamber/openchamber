import { isPlainObject, isString } from '../shared/guards.js';

/**
 * Gitea answers as the neutral source-control DTOs GitLab's module emits
 * (`packages/ui/src/lib/source-control/types.ts`). A project's id is the
 * repository's numeric id as a string; a change request's id is
 * `<repository id>#<number>`.
 */

const text = (value) => (isString(value) ? value : '');
const integer = (value) => (Number.isInteger(value) && value >= 0 ? value : null);

// Gitea's default draft prefixes (`[repository.pull-request] WORK_IN_PROGRESS_PREFIXES`).
const WIP_TITLE_PREFIX = /^\s*(?:wip:|\[wip\])\s*/i;
export const isDraftTitle = (title) => WIP_TITLE_PREFIX.test(title);
export const asDraftTitle = (title) => (isDraftTitle(title) ? title : `WIP: ${title}`);
export const asReadyTitle = (title) => title.replace(WIP_TITLE_PREFIX, '');

export function mapGiteaUser(value, identity) {
  if (!isPlainObject(value) || integer(value.id) === null || !text(value.login)) return null;
  const user = { ...identity, id: String(value.id), username: value.login };
  if (text(value.avatar_url)) user.avatarUrl = value.avatar_url;
  if (text(value.full_name)) user.name = value.full_name;
  if (text(value.email)) user.email = value.email;
  return user;
}

/** The `owner/name` of a web URL on the instance, lowercased; null elsewhere. */
const pathOnInstance = (value, instance) => {
  try {
    const url = new URL(value);
    if (url.origin !== instance) return null;
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
  } catch {
    return null;
  }
};

/**
 * A repository, only when its web and clone addresses are on the instance
 * and name the repository it says it is.
 */
export function mapGiteaRepo(value, identity, remoteName) {
  if (!isPlainObject(value) || integer(value.id) === null || !text(value.name)
    || !isPlainObject(value.owner) || !text(value.owner.login) || !text(value.html_url)) return null;
  const owner = value.owner.login;
  const expected = `${owner}/${value.name}`.toLowerCase();
  if (pathOnInstance(value.html_url, identity.instance) !== expected) return null;
  if (value.clone_url != null && pathOnInstance(text(value.clone_url), identity.instance) !== expected) return null;
  const project = { ...identity, id: String(value.id), owner, name: value.name, url: value.html_url };
  if (text(value.clone_url)) project.cloneUrl = value.clone_url;
  if (text(value.ssh_url)) project.sshUrl = value.ssh_url;
  if (text(value.default_branch)) project.defaultBranch = value.default_branch;
  if (remoteName !== undefined) project.remoteName = remoteName;
  return project;
}

function mapLabels(labels) {
  if (!Array.isArray(labels)) return [];
  return labels.flatMap((label) => {
    if (!isPlainObject(label) || !text(label.name)) return [];
    const result = { name: label.name };
    if (text(label.color)) result.color = label.color.replace(/^#/, '');
    return [result];
  });
}

const pullState = (value) => {
  if (value.merged === true) return 'merged';
  if (value.state === 'open') return 'open';
  return value.state === 'closed' ? 'closed' : null;
};

/** The id of the repository a pull request branch lives in, or null (a deleted fork). */
export const branchRepoId = (branch) => integer(branch?.repo_id) ?? integer(branch?.repo?.id);

export function mapGiteaPull(value, identity, project) {
  if (!isPlainObject(value) || integer(value.number) === null || !text(value.title) || !text(value.html_url)) return null;
  const state = pullState(value);
  if (!state || !text(value.head?.ref) || !text(value.base?.ref)) return null;
  const request = {
    ...identity,
    id: `${project.id}#${value.number}`,
    number: value.number,
    project,
    title: value.title,
    url: value.html_url,
    state,
    draft: value.draft === true || isDraftTitle(value.title),
    base: value.base.ref,
    head: value.head.ref,
  };
  if (isString(value.body)) request.body = value.body;
  if (text(value.head.sha)) request.headSha = value.head.sha;
  const author = mapGiteaUser(value.user, identity);
  if (author) request.author = author;
  if (text(value.created_at)) request.createdAt = value.created_at;
  if (text(value.updated_at)) request.updatedAt = value.updated_at;
  if (text(value.head.label)) request.headLabel = value.head.label;
  request.labels = mapLabels(value.labels);
  if (state === 'open' && (value.mergeable === true || value.mergeable === false)) {
    request.mergeable = value.mergeable;
    request.mergeableState = value.mergeable ? 'clean' : 'dirty';
  }
  return request;
}

export function mapGiteaIssue(value, identity, project) {
  if (!isPlainObject(value) || integer(value.number) === null || !text(value.title) || !text(value.html_url)) return null;
  if (value.pull_request != null) return null;
  if (value.state !== 'open' && value.state !== 'closed') return null;
  const issue = {
    ...identity,
    id: `${project.id}#${value.number}`,
    number: value.number,
    project,
    title: value.title,
    url: value.html_url,
    state: value.state,
  };
  if (isString(value.body)) issue.body = value.body;
  const author = mapGiteaUser(value.user, identity);
  if (author) issue.author = author;
  if (Array.isArray(value.assignees)) issue.assignees = value.assignees.map((user) => mapGiteaUser(user, identity)).filter(Boolean);
  issue.labels = mapLabels(value.labels);
  if (text(value.created_at)) issue.createdAt = value.created_at;
  if (text(value.updated_at)) issue.updatedAt = value.updated_at;
  return issue;
}

export function mapGiteaComment(value, identity, fallbackUrl = '') {
  if (!isPlainObject(value) || integer(value.id) === null || !isString(value.body)) return null;
  const comment = { ...identity, id: String(value.id), url: text(value.html_url) || fallbackUrl, body: value.body };
  const author = mapGiteaUser(value.user, identity);
  if (author) comment.author = author;
  if (text(value.created_at)) comment.createdAt = value.created_at;
  if (text(value.updated_at)) comment.updatedAt = value.updated_at;
  return comment;
}

/** A comment on a diff line, from a review. */
export function mapGiteaReviewComment(value, identity, fallbackUrl = '') {
  const comment = mapGiteaComment(value, identity, fallbackUrl);
  if (!comment || !text(value.path)) return null;
  comment.path = value.path;
  // `position` is the line in the new file, `original_position` in the old one.
  const line = integer(value.position) || integer(value.original_position);
  if (line) comment.line = line;
  return comment;
}

/** A review whose text is a comment on the pull request; null for one without text. */
export function mapGiteaReviewBody(value, identity, fallbackUrl = '') {
  if (!isPlainObject(value) || integer(value.id) === null || !text(value.body).trim()) return null;
  const comment = { ...identity, id: `review-${value.id}`, url: text(value.html_url) || fallbackUrl, body: value.body };
  const author = mapGiteaUser(value.user, identity);
  if (author) comment.author = author;
  if (text(value.submitted_at)) comment.createdAt = value.submitted_at;
  if (text(value.updated_at)) comment.updatedAt = value.updated_at;
  return comment;
}

const VERDICTS = new Map([['APPROVED', 'approved'], ['REQUEST_CHANGES', 'changes_requested']]);

/** An approval or a request for changes still in force; null for anything else. */
export function mapGiteaVerdict(value, identity, fallbackUrl = '') {
  if (!isPlainObject(value) || value.dismissed === true) return null;
  const state = VERDICTS.get(value.state);
  if (!state) return null;
  const verdict = { state, url: text(value.html_url) || fallbackUrl, createdAt: text(value.submitted_at) || null };
  const author = mapGiteaUser(value.user, identity);
  if (author) verdict.author = author;
  return verdict;
}

export function mapGiteaCommit(value) {
  if (!isPlainObject(value) || !text(value.sha)) return null;
  const message = text(value.commit?.message);
  return {
    sha: value.sha,
    headline: message.split('\n')[0] || '',
    authorName: text(value.commit?.author?.name) || null,
    committedAt: text(value.commit?.committer?.date) || text(value.created) || null,
    url: text(value.html_url) || null,
  };
}

const FILE_STATUSES = new Map([['added', 'added'], ['deleted', 'removed'], ['removed', 'removed'], ['renamed', 'renamed']]);

export function mapGiteaChangedFile(value) {
  if (!isPlainObject(value) || !text(value.filename)) return null;
  const file = { path: value.filename, status: FILE_STATUSES.get(value.status) ?? 'modified' };
  for (const key of ['additions', 'deletions', 'changes']) {
    if (integer(value[key]) !== null) file[key] = value[key];
  }
  return file;
}

/**
 * A unified diff split per file, keyed by the file's new path (its old path
 * for a deletion), each part keeping its own `diff --git` header.
 */
export function splitUnifiedDiff(diff) {
  const parts = new Map();
  if (!isString(diff) || !diff) return parts;
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith('diff --git '));
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const plus = lines.find((line) => line.startsWith('+++ '));
    const minus = lines.find((line) => line.startsWith('--- '));
    const renamed = lines.find((line) => line.startsWith('rename to '));
    let path = '';
    if (plus && plus !== '+++ /dev/null') path = plus.slice(4).replace(/^b\//, '');
    else if (renamed) path = renamed.slice('rename to '.length);
    else if (minus && minus !== '--- /dev/null') path = minus.slice(4).replace(/^a\//, '');
    else path = lines[0].match(/^diff --git a\/.+? b\/(.+)$/)?.[1] ?? '';
    if (path) parts.set(path.replace(/\t.*$/, ''), chunk.endsWith('\n') ? chunk : `${chunk}\n`);
  }
  return parts;
}

const SUCCESS = new Set(['success', 'skipped', 'warning']);
const FAILURE = new Set(['failure', 'error']);

/**
 * A commit's combined status as CI: Gitea Actions and external CI both
 * report as commit statuses. `warning` does not fail the summary, matching
 * how Gitea itself lets a pull request merge on it. Null when nothing reported.
 */
export function mapGiteaCI(combined, identity) {
  if (!isPlainObject(combined) || !Array.isArray(combined.statuses) || combined.statuses.length === 0) return null;
  const statuses = combined.statuses.filter(isPlainObject);
  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const status of statuses) {
    if (FAILURE.has(status.status)) failure += 1;
    else if (status.status === 'pending') pending += 1;
    else if (SUCCESS.has(status.status)) success += 1;
  }
  const state = failure > 0 ? 'failure' : pending > 0 ? 'pending' : success > 0 ? 'success' : 'unknown';
  const runs = statuses.map((status) => {
    const run = {
      ...identity,
      id: String(status.id ?? status.context ?? 'status'),
      name: text(status.context) || 'CI',
      status: status.status === 'pending' ? 'in_progress' : 'completed',
      conclusion: SUCCESS.has(status.status) ? 'success' : FAILURE.has(status.status) ? 'failure' : null,
    };
    if (text(status.target_url)) run.detailsUrl = status.target_url;
    if (text(status.description)) run.output = { title: status.description };
    if (text(status.created_at)) run.startedAt = status.created_at;
    if (status.status !== 'pending' && text(status.updated_at)) run.completedAt = status.updated_at;
    return run;
  });
  return { summary: { state, total: statuses.length, success, failure, pending }, runs };
}

/**
 * A pull request's live state in the shape GitHub's and GitLab's summaries
 * use, so one badge rule colours all of them.
 */
export function liveChangeRequestSummary(ref, raw, ci) {
  if (!isPlainObject(raw) || integer(raw.number) === null) return null;
  const state = pullState(raw) ?? 'closed';
  const summary = {
    owner: ref.owner,
    repo: ref.repo,
    number: raw.number,
    state,
    draft: raw.draft === true || isDraftTitle(text(raw.title)),
    title: text(raw.title),
    mergeable: state === 'open' && (raw.mergeable === true || raw.mergeable === false) ? raw.mergeable : null,
    mergeableState: state === 'open' && raw.mergeable === false ? 'dirty' : state === 'open' && raw.mergeable === true ? 'clean' : null,
    checks: state === 'open' && ci ? { ...ci.summary } : null,
  };
  if (text(raw.head?.sha)) summary.headSha = raw.head.sha;
  if (text(raw.base?.ref)) summary.base = raw.base.ref;
  if (summary.checks) delete summary.checks.startedAt;
  return summary;
}

export function liveIssueSummary(ref, raw) {
  if (!isPlainObject(raw) || integer(raw.number) === null) return null;
  // Gitea closes an issue without saying whether it was done or dropped.
  return { owner: ref.owner, repo: ref.repo, number: raw.number, title: text(raw.title), state: raw.state === 'open' ? 'open' : 'completed' };
}
