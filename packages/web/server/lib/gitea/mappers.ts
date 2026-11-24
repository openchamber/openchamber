import { isPlainObject, isString } from '../shared/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';

export interface GiteaIdentity {
  provider: string;
  instance: string;
}

export interface GiteaProject extends GiteaIdentity {
  id: string;
  owner: string;
  name: string;
  url: string;
  cloneUrl?: string;
  sshUrl?: string;
  defaultBranch?: string;
  remoteName?: string;
}

export interface GiteaUser extends GiteaIdentity {
  id: string;
  username: string;
  avatarUrl?: string;
  name?: string;
  email?: string;
}

export type GiteaComment = GiteaIdentity & {
  id: string; url: string; body: string; canUpdate: boolean; canDelete: boolean;
  author?: GiteaUser; createdAt?: string; updatedAt?: string; path?: string; line?: number;
};

export type GiteaLabel = { name: string; color?: string };
type GiteaItem = GiteaIdentity & {
  id: string; number: number; project: GiteaProject; title: string; url: string;
  body?: string; author?: GiteaUser; labels: GiteaLabel[]; createdAt?: string; updatedAt?: string;
};
export type GiteaPull = GiteaItem & {
  state: 'open' | 'closed' | 'merged'; draft: boolean; base: string; head: string; headSha?: string;
  headLabel?: string; headProject?: GiteaProject; mergeable?: boolean; mergeableState?: 'clean' | 'dirty';
};
export type GiteaIssue = GiteaItem & { state: 'open' | 'closed'; assignees?: GiteaUser[] };
type GiteaRepoRef = { owner: string; repo: string };
export type GiteaCheckSummary = { state: 'failure' | 'pending' | 'success' | 'unknown'; total: number; success: number; failure: number; pending: number; startedAt?: string };
export type GiteaCheckRun = GiteaIdentity & {
  id: string; name: string; status: 'in_progress' | 'completed'; conclusion: 'success' | 'failure' | null;
  detailsUrl?: string; output?: { title: string }; startedAt?: string; completedAt?: string;
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject => isPlainObject(value);
const isJsonArray = (value: JsonValue | undefined): value is JsonValue[] => Array.isArray(value);
const field = (value: JsonValue | undefined, key: string) => isJsonObject(value) ? value[key] : undefined;
const nonEmptyText = (value: JsonValue | undefined): value is string => isString(value) && value !== '';
const text = (value: JsonValue | undefined) => (isString(value) ? value : '');
const nonNegativeInteger = (value: JsonValue | undefined): value is number =>
  Number.isInteger(value) && Number(value) >= 0;
const integer = (value: JsonValue | undefined) => (nonNegativeInteger(value) ? value : null);

const WIP_TITLE_PREFIX = /^\s*(?:wip:|\[wip\])\s*/i;
export const isDraftTitle = (title: string) => WIP_TITLE_PREFIX.test(title);
export const asDraftTitle = (title: string) => (isDraftTitle(title) ? title : `WIP: ${title}`);
export const asReadyTitle = (title: string) => title.replace(WIP_TITLE_PREFIX, '');

export function mapGiteaUser(value: JsonValue | undefined, identity: GiteaIdentity): GiteaUser | null {
  if (!isJsonObject(value) || !nonNegativeInteger(value.id) || !nonEmptyText(value.login)) return null;
  const user: GiteaUser = { ...identity, id: String(value.id), username: value.login };
  if (nonEmptyText(value.avatar_url)) user.avatarUrl = value.avatar_url;
  if (nonEmptyText(value.full_name)) user.name = value.full_name;
  if (nonEmptyText(value.email)) user.email = value.email;
  return user;
}

const pathOnInstance = (value: string, instance: string) => {
  try {
    const url = new URL(value);
    if (url.origin !== instance) return null;
    return decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
  } catch {
    return null;
  }
};

const absoluteHttpUrl = (value: string, instance: string) => {
  if (!value) return null;
  try {
    const url = new URL(value, instance);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

export function mapGiteaRepo(value: JsonValue | undefined, identity: GiteaIdentity, remoteName?: string): GiteaProject | null {
  if (!isJsonObject(value) || !nonNegativeInteger(value.id) || !nonEmptyText(value.name)
    || !isJsonObject(value.owner) || !nonEmptyText(value.owner.login) || !nonEmptyText(value.html_url)) return null;
  const owner = value.owner.login;
  const expected = `${owner}/${value.name}`.toLowerCase();
  if (pathOnInstance(value.html_url, identity.instance) !== expected) return null;
  if (value.clone_url != null && pathOnInstance(text(value.clone_url), identity.instance) !== expected) return null;
  const project: GiteaProject = { ...identity, id: String(value.id), owner, name: value.name, url: value.html_url };
  if (nonEmptyText(value.clone_url)) project.cloneUrl = value.clone_url;
  if (nonEmptyText(value.ssh_url)) project.sshUrl = value.ssh_url;
  if (nonEmptyText(value.default_branch)) project.defaultBranch = value.default_branch;
  if (remoteName !== undefined) project.remoteName = remoteName;
  return project;
}

function mapLabels(labels: JsonValue | undefined) {
  if (!isJsonArray(labels)) return [];
  return labels.flatMap((label) => {
    if (!isJsonObject(label) || !nonEmptyText(label.name)) return [];
    const result: GiteaLabel = { name: label.name };
    if (nonEmptyText(label.color)) result.color = label.color.replace(/^#/, '');
    return [result];
  });
}

const pullState = (value: JsonObject) => {
  if (value.merged === true) return 'merged';
  if (value.state === 'open') return 'open';
  return value.state === 'closed' ? 'closed' : null;
};

export const branchRepoId = (branch: JsonValue | undefined) =>
  integer(field(branch, 'repo_id')) ?? integer(field(field(branch, 'repo'), 'id'));

export function mapGiteaPull(value: JsonValue | undefined, identity: GiteaIdentity, project: GiteaProject): GiteaPull | null {
  if (!isJsonObject(value) || !nonNegativeInteger(value.number) || !nonEmptyText(value.title) || !nonEmptyText(value.html_url)) return null;
  const state = pullState(value);
  if (!state) return null;
  const head = field(value.head, 'ref');
  if (!nonEmptyText(head)) return null;
  const base = field(value.base, 'ref');
  if (!nonEmptyText(base)) return null;
  const request: Omit<GiteaPull, 'labels'> = {
    ...identity,
    id: `${project.id}#${value.number}`,
    number: value.number,
    project,
    title: value.title,
    url: value.html_url,
    state,
    draft: value.draft === true || isDraftTitle(value.title),
    base,
    head,
  };
  if (isString(value.body)) request.body = value.body;
  const sha = field(value.head, 'sha');
  if (nonEmptyText(sha)) request.headSha = sha;
  const author = mapGiteaUser(value.user, identity);
  if (author) request.author = author;
  if (nonEmptyText(value.created_at)) request.createdAt = value.created_at;
  if (nonEmptyText(value.updated_at)) request.updatedAt = value.updated_at;
  const login = field(field(field(value.head, 'repo'), 'owner'), 'login');
  if (nonEmptyText(login)) request.headLabel = `${login}:${head}`;
  const labeled = Object.assign(request, { labels: mapLabels(value.labels) });
  if (state === 'open' && (value.mergeable === true || value.mergeable === false)) {
    request.mergeable = value.mergeable;
    request.mergeableState = value.mergeable ? 'clean' : 'dirty';
  }
  return labeled;
}

export function mapGiteaIssue(value: JsonValue | undefined, identity: GiteaIdentity, project: GiteaProject): GiteaIssue | null {
  if (!isJsonObject(value) || !nonNegativeInteger(value.number) || !nonEmptyText(value.title) || !nonEmptyText(value.html_url)) return null;
  if (value.pull_request != null) return null;
  if (value.state !== 'open' && value.state !== 'closed') return null;
  const issue: Omit<GiteaIssue, 'labels'> = {
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
  // external: https://docs.gitea.com/api/ Gitea answers an issue without assignees as `null`.
  if (value.assignees === null) issue.assignees = [];
  if (isJsonArray(value.assignees)) issue.assignees = value.assignees.map((user) => mapGiteaUser(user, identity)).filter((user) => user !== null);
  const labeled = Object.assign(issue, { labels: mapLabels(value.labels) });
  if (nonEmptyText(value.created_at)) issue.createdAt = value.created_at;
  if (nonEmptyText(value.updated_at)) issue.updatedAt = value.updated_at;
  return labeled;
}

export function mapGiteaComment(value: JsonValue | undefined, identity: GiteaIdentity, fallbackUrl = '', viewer: string | null = null): GiteaComment | null {
  if (!isJsonObject(value) || !nonNegativeInteger(value.id) || !isString(value.body)) return null;
  const comment: Omit<GiteaComment, 'canUpdate' | 'canDelete'> = { ...identity, id: String(value.id), url: text(value.html_url) || fallbackUrl, body: value.body };
  const author = mapGiteaUser(value.user, identity);
  if (author) comment.author = author;
  const mine = isString(viewer) && viewer !== '' && field(value.user, 'login') === viewer;
  const editable = Object.assign(comment, { canUpdate: mine, canDelete: mine });
  if (nonEmptyText(value.created_at)) comment.createdAt = value.created_at;
  if (nonEmptyText(value.updated_at)) comment.updatedAt = value.updated_at;
  return editable;
}

export function mapGiteaReviewComment(value: JsonValue | undefined, identity: GiteaIdentity, fallbackUrl = '') {
  const comment = mapGiteaComment(value, identity, fallbackUrl);
  if (!comment || !isJsonObject(value) || !nonEmptyText(value.path)) return null;
  comment.path = value.path;
  const line = integer(value.position) || integer(value.original_position);
  if (line) comment.line = line;
  return comment;
}

export function mapGiteaReviewBody(value: JsonValue | undefined, identity: GiteaIdentity, fallbackUrl = ''): GiteaComment | null {
  if (!isJsonObject(value) || !nonNegativeInteger(value.id) || !isString(value.body) || !value.body.trim()) return null;
  const comment: GiteaComment = { ...identity, id: `review-${value.id}`, url: text(value.html_url) || fallbackUrl, body: value.body, canUpdate: false, canDelete: false };
  const author = mapGiteaUser(value.user, identity);
  if (author) comment.author = author;
  if (nonEmptyText(value.submitted_at)) comment.createdAt = value.submitted_at;
  if (nonEmptyText(value.updated_at)) comment.updatedAt = value.updated_at;
  return comment;
}

const VERDICTS = new Map<JsonValue | undefined, 'approved' | 'changes_requested'>([['APPROVED', 'approved'], ['REQUEST_CHANGES', 'changes_requested']]);
export type GiteaVerdict = { state: 'approved' | 'changes_requested'; url: string; createdAt: string | null; author?: GiteaUser };

export const SUBMITTED_REVIEW_STATES: Pick<ReadonlySet<JsonValue | undefined>, 'has'> = new Set(['APPROVED', 'REQUEST_CHANGES', 'COMMENT']);

const REVIEWER_STATES = new Map<JsonValue | undefined, GiteaReviewerState['state']>([
  ['APPROVED', 'approved'], ['REQUEST_CHANGES', 'changes_requested'], ['COMMENT', 'commented'],
]);

export type GiteaReviewerState = {
  user: GiteaUser;
  state: 'pending' | 'approved' | 'changes_requested' | 'commented' | 'dismissed';
};

export function mapGiteaReviewerStates(reviews: JsonValue[], requested: JsonValue | undefined, identity: GiteaIdentity): GiteaReviewerState[] {
  const states = new Map<string, GiteaReviewerState>();
  const ordered = [...reviews].sort((left, right) => text(field(left, 'submitted_at')).localeCompare(text(field(right, 'submitted_at'))));
  for (const review of ordered) {
    const user = mapGiteaUser(field(review, 'user'), identity);
    const state = field(review, 'dismissed') === true ? 'pending' : REVIEWER_STATES.get(field(review, 'state'));
    if (user && state) states.set(user.id, { user, state });
  }
  for (const user of Array.isArray(requested) ? requested : []) {
    const mapped = mapGiteaUser(user, identity);
    if (mapped && !states.has(mapped.id)) states.set(mapped.id, { user: mapped, state: 'pending' });
  }
  return [...states.values()];
}

export function mapGiteaVerdict(value: JsonValue | undefined, identity: GiteaIdentity, fallbackUrl = '') {
  if (!isJsonObject(value) || value.dismissed === true) return null;
  const state = VERDICTS.get(value.state);
  if (!state) return null;
  const verdict: GiteaVerdict = { state, url: text(value.html_url) || fallbackUrl, createdAt: text(value.submitted_at) || null };
  const author = mapGiteaUser(value.user, identity);
  if (author) verdict.author = author;
  return verdict;
}

export function mapGiteaCommit(value: JsonValue | undefined) {
  if (!isJsonObject(value) || !nonEmptyText(value.sha)) return null;
  const message = text(field(value.commit, 'message'));
  return {
    sha: value.sha,
    headline: message.split('\n')[0] || '',
    authorName: text(field(field(value.commit, 'author'), 'name')) || null,
    committedAt: text(field(field(value.commit, 'committer'), 'date')) || text(value.created) || null,
    url: text(value.html_url) || null,
  };
}

type GiteaFileStatus = 'added' | 'removed' | 'renamed' | 'modified';
export type GiteaChangedFile = { path: string; status: GiteaFileStatus; additions?: number; deletions?: number; changes?: number; patch?: string };
const FILE_STATUSES = new Map<JsonValue | undefined, GiteaFileStatus>([['added', 'added'], ['deleted', 'removed'], ['removed', 'removed'], ['renamed', 'renamed']]);

export function mapGiteaChangedFile(value: JsonValue | undefined): GiteaChangedFile | null {
  if (!isJsonObject(value) || !nonEmptyText(value.filename)) return null;
  const file: GiteaChangedFile = { path: value.filename, status: FILE_STATUSES.get(value.status) ?? 'modified' };
  const counts: Array<'additions' | 'deletions' | 'changes'> = ['additions', 'deletions', 'changes'];
  for (const key of counts) {
    const count = value[key];
    if (nonNegativeInteger(count)) file[key] = count;
  }
  return file;
}

export function splitUnifiedDiff(diff: JsonValue | undefined) {
  const parts = new Map<string, string>();
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
    else path = lines[0]?.match(/^diff --git a\/.+? b\/(.+)$/)?.[1] ?? '';
    if (path) parts.set(path.replace(/\t.*$/, ''), chunk.endsWith('\n') ? chunk : `${chunk}\n`);
  }
  return parts;
}

const SUCCESS = new Set<JsonValue | undefined>(['success', 'skipped']);
const FAILURE = new Set<JsonValue | undefined>(['failure', 'error', 'warning']);

export function mapGiteaCI(combined: JsonValue | undefined, identity: GiteaIdentity) {
  if (!isJsonObject(combined) || !isJsonArray(combined.statuses) || combined.statuses.length === 0) return null;
  const statuses = combined.statuses.filter(isJsonObject);
  let success = 0;
  let failure = 0;
  let pending = 0;
  for (const status of statuses) {
    if (FAILURE.has(status.status)) failure += 1;
    else if (status.status === 'pending') pending += 1;
    else if (SUCCESS.has(status.status)) success += 1;
  }
  const state: GiteaCheckSummary['state'] = failure > 0 ? 'failure' : pending > 0 ? 'pending' : success > 0 ? 'success' : 'unknown';
  const runs = statuses.map((status) => {
    const run: GiteaCheckRun = {
      ...identity,
      id: String(status.id ?? status.context ?? 'status'),
      name: text(status.context) || 'CI',
      status: status.status === 'pending' ? 'in_progress' : 'completed',
      conclusion: SUCCESS.has(status.status) ? 'success' : FAILURE.has(status.status) ? 'failure' : null,
    };
    const detailsUrl = absoluteHttpUrl(text(status.target_url), identity.instance);
    if (detailsUrl) run.detailsUrl = detailsUrl;
    if (nonEmptyText(status.description)) run.output = { title: status.description };
    if (nonEmptyText(status.created_at)) run.startedAt = status.created_at;
    if (status.status !== 'pending' && nonEmptyText(status.updated_at)) run.completedAt = status.updated_at;
    return run;
  });
  return { summary: { state, total: statuses.length, success, failure, pending }, runs };
}

export function liveChangeRequestSummary(ref: GiteaRepoRef, raw: JsonValue | undefined, ci: { summary: GiteaCheckSummary } | null) {
  if (!isJsonObject(raw) || !nonNegativeInteger(raw.number)) return null;
  const state = pullState(raw) ?? 'closed';
  const mergeableState = state === 'open' && raw.mergeable === false ? 'dirty' : state === 'open' && raw.mergeable === true ? 'clean' : null;
  const checks = state === 'open' && ci ? { ...ci.summary } : null;
  const summary: GiteaRepoRef & {
    number: number; state: typeof state; draft: boolean; title: string; mergeable: boolean | null;
    mergeableState: typeof mergeableState; checks: GiteaCheckSummary | null; headSha?: string; base?: string;
  } = {
    owner: ref.owner,
    repo: ref.repo,
    number: raw.number,
    state,
    draft: raw.draft === true || isDraftTitle(text(raw.title)),
    title: text(raw.title),
    mergeable: state === 'open' && (raw.mergeable === true || raw.mergeable === false) ? raw.mergeable : null,
    mergeableState,
    checks,
  };
  const sha = field(raw.head, 'sha');
  if (nonEmptyText(sha)) summary.headSha = sha;
  const base = field(raw.base, 'ref');
  if (nonEmptyText(base)) summary.base = base;
  if (summary.checks) delete summary.checks.startedAt;
  return summary;
}

export function liveIssueSummary(ref: GiteaRepoRef, raw: JsonValue | undefined) {
  if (!isJsonObject(raw) || !nonNegativeInteger(raw.number)) return null;
  return { owner: ref.owner, repo: ref.repo, number: raw.number, title: text(raw.title), state: raw.state === 'open' ? 'open' : 'completed' };
}
