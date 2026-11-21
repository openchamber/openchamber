import { isPlainObject, isString } from '../shared/guards.js';
import { splitProjectPath } from '../source-control/project-path.js';
import type { GerritJson } from './contracts.js';
import type {
  GerritChange, GerritChangeState, GerritComment, GerritFile, GerritIdentity, GerritLiveSummary,
  GerritProject, GerritRevision, GerritReviewerState, GerritSubmitRequirement, GerritUser, GerritVoteLabel,
} from './contracts.js';

type Input = GerritJson | undefined;
type JsonObject = { [key: string]: GerritJson };
const plainObject = (value: Input): value is JsonObject => isPlainObject(value);
const field = (value: Input, key: string): Input => plainObject(value) ? value[key] : undefined;
const stringValue = (value: Input): value is string => isString(value);
const isInteger = (value: Input): value is number => Number.isInteger(value);

const text = (value: Input) => (stringValue(value) ? value : '');
const integer = (value: Input) => (isInteger(value) && value >= 0 ? value : null);
const COMMIT_SHA = /^[0-9a-f]{40}$/;

export function gerritTimestamp(value: Input) {
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?$/);
  if (!match) return null;
  return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}Z`;
}

export const patchsetRef = (number: number, patchset: number) => `refs/changes/${String(number % 100).padStart(2, '0')}/${number}/${patchset}`;

export const changePath = (project: string, number: number) => `/changes/${encodeURIComponent(project)}~${number}`;

const changeUrl = (origin: string, project: string, number: number) => `${origin}/c/${project}/+/${number}`;

export function mapGerritUser(value: Input, identity: GerritIdentity) {
  if (!plainObject(value) || integer(value._account_id) === null) return null;
  const user: GerritUser = { ...identity, id: String(value._account_id), username: text(value.username) || text(value.name) || String(value._account_id) };
  const avatar = Array.isArray(value.avatars) ? value.avatars.find((entry): entry is GerritJson & { url: string } => Boolean(text(field(entry, 'url')))) : null;
  if (avatar) user.avatarUrl = avatar.url;
  if (stringValue(value.name) && value.name) user.name = value.name;
  if (stringValue(value.email) && value.email) user.email = value.email;
  return user;
}

export function mapGerritProject(name: string, identity: GerritIdentity, { defaultBranch, remoteName }: {
  defaultBranch?: string | null; remoteName?: string;
} = {}) {
  if (!text(name) || name.startsWith('/') || name.endsWith('/')) return null;
  const project: GerritProject = {
    ...identity,
    id: name,
    ...splitProjectPath(name),
    url: `${identity.instance}/admin/repos/${name}`,
    cloneUrl: `${identity.instance}/a/${name}`,
  };
  if (defaultBranch) project.defaultBranch = defaultBranch;
  if (remoteName !== undefined) project.remoteName = remoteName;
  return project;
}

const STATES = new Map<string, GerritChangeState>([['NEW', 'open'], ['MERGED', 'merged'], ['ABANDONED', 'closed']]);
export const changeState = (status: Input) => STATES.get(text(status)) ?? null;

const currentRevision = (raw: JsonObject, changeNumber: number) => {
  const sha = text(raw.current_revision);
  const revision = sha && plainObject(raw.revisions) ? raw.revisions[sha] : null;
  const number = integer(field(revision, '_number')) ?? integer(raw.current_revision_number);
  return { sha: COMMIT_SHA.test(sha) ? sha : null, number, ref: text(field(revision, 'ref')) || (number ? patchsetRef(changeNumber, number) : '') };
};

const descriptionOf = (raw: JsonObject, sha: string) => {
  const message = text(field(field(field(raw.revisions, sha), 'commit'), 'message'));
  if (!message) return undefined;
  return message.split('\n').slice(1).join('\n').trim();
};

export function mapGerritChange(raw: Input, identity: GerritIdentity, project: GerritProject) {
  if (!plainObject(raw) || !stringValue(raw.subject) || !raw.subject || !stringValue(raw.branch) || !raw.branch) return null;
  const number = integer(raw._number);
  if (number === null) return null;
  const state = changeState(raw.status);
  if (!state || raw.project !== project.id) return null;
  const revision = currentRevision(raw, number);
  const request: GerritChange = {
    ...identity,
    id: `${project.id}#${raw._number}`,
    number,
    project,
    title: raw.subject,
    url: changeUrl(identity.instance, project.id, number),
    state,
    draft: raw.work_in_progress === true,
    base: raw.branch,
    head: revision.ref || patchsetRef(number, 1),
    labels: (Array.isArray(raw.hashtags) ? raw.hashtags : []).filter((tag): tag is string => Boolean(text(tag))).map((name) => ({ name })),
  };
  const body = revision.sha ? descriptionOf(raw, revision.sha) : undefined;
  if (body !== undefined) request.body = body;
  if (revision.sha) request.headSha = revision.sha;
  if (revision.number) {
    request.revisionNumber = revision.number;
    request.headLabel = `Patchset ${revision.number}`;
  }
  const author = mapGerritUser(raw.owner, identity);
  if (author) request.author = author;
  const created = gerritTimestamp(raw.created);
  const updated = gerritTimestamp(raw.updated);
  if (created) request.createdAt = created;
  if (updated) request.updatedAt = updated;
  if (raw.is_private === true) request.private = true;
  if (stringValue(raw.topic) && raw.topic) request.topic = raw.topic;
  if (state === 'open' && (raw.submittable === true || raw.submittable === false)) {
    request.mergeable = raw.submittable;
    request.mergeableState = raw.submittable ? 'clean' : 'blocked';
  }
  return request;
}

const voteValue = (key: Input) => {
  const match = text(key).trim().match(/^([+-]?)(\d{1,2})$/);
  if (!match) return null;
  return Number(match[2]) * (match[1] === '-' ? -1 : 1);
};

const LABEL_STATUSES: Array<[string, GerritVoteLabel['status']]> = [['rejected', 'rejected'], ['approved', 'approved'], ['disliked', 'disliked'], ['recommended', 'recommended']];

export function mapGerritReviewerStates(raw: Input, identity: GerritIdentity): GerritReviewerState[] | undefined {
  const label = field(field(raw, 'labels'), 'Code-Review');
  if (!plainObject(label)) return undefined;
  const pendingRaw = field(raw, 'pending_reviewers');
  const pending = Array.isArray(pendingRaw) ? pendingRaw : field(pendingRaw, 'REVIEWER');
  const ownerId = mapGerritUser(field(raw, 'owner'), identity)?.id;
  const scale = plainObject(label.values) ? Object.keys(label.values).map(voteValue).filter((value): value is number => value !== null && value > 0) : [];
  const top = scale.length > 0 ? Math.max(...scale) : 2;
  const states = new Map<string, GerritReviewerState>();
  const votes = field(label, 'all');
  for (const approval of Array.isArray(votes) ? votes : []) {
    const user = mapGerritUser(approval, identity);
    const value = field(approval, 'value');
    let state: GerritReviewerState['state'] | undefined;
    if (value === undefined || value === 0) state = 'pending';
    else if (isInteger(value)) state = value >= top ? 'approved' : value > 0 ? 'commented' : 'changes_requested';
    if (user && state && user.id !== ownerId) states.set(user.id, { user, state });
  }
  const roster = field(field(raw, 'reviewers'), 'REVIEWER');
  for (const account of [...(Array.isArray(pending) ? pending : []), ...(Array.isArray(roster) ? roster : [])]) {
    const user = mapGerritUser(account, identity);
    if (user && user.id !== ownerId && !states.has(user.id)) states.set(user.id, { user, state: 'pending' });
  }
  return [...states.values()];
}

export function mapGerritVoteLabels(raw: Input, identity: GerritIdentity): GerritVoteLabel[] {
  const labels = field(raw, 'labels');
  if (!plainObject(labels)) return [];
  const permittedLabels = field(raw, 'permitted_labels');
  const permitted = plainObject(permittedLabels) ? permittedLabels : {};
  return Object.entries(labels).flatMap(([name, label]) => {
    if (!plainObject(label)) return [];
    const values = Object.entries(plainObject(label.values) ? label.values : {}).flatMap(([key, description]) => {
      const value = voteValue(key);
      return value === null ? [] : [{ value, description: text(description) }];
    }).sort((a, b) => a.value - b.value);
    const permittedValues = permitted[name];
    const allowed = (Array.isArray(permittedValues) ? permittedValues : []).map(voteValue).filter((value) => value !== null).sort((a, b) => a - b);
    const votes = (Array.isArray(label.all) ? label.all : []).flatMap((approval) => {
      const value = field(approval, 'value');
      if (!isInteger(value) || value === 0) return [];
      const user = mapGerritUser(approval, identity);
      return user ? [{ user, value }] : [];
    });
    const status = LABEL_STATUSES.find(([key]) => isPlainObject(label[key]))?.[1] ?? 'neutral';
    return [{
      name,
      values,
      defaultValue: isInteger(label.default_value) ? label.default_value : 0,
      permitted: allowed,
      blocking: label.blocking === true,
      status,
      votes,
    }];
  });
}

const REQUIREMENT_STATUSES = new Map<string, GerritSubmitRequirement['status']>([
  ['SATISFIED', 'satisfied'], ['UNSATISFIED', 'unsatisfied'], ['OVERRIDDEN', 'overridden'],
  ['NOT_APPLICABLE', 'not-applicable'], ['ERROR', 'error'], ['FORCED', 'forced'], ['TIMEOUT', 'error'],
]);

export function mapGerritSubmitRequirements(raw: Input): GerritSubmitRequirement[] {
  const requirements = field(raw, 'submit_requirements');
  if (!Array.isArray(requirements)) return [];
  return requirements.flatMap((requirement) => {
    const status = REQUIREMENT_STATUSES.get(text(field(requirement, 'status')));
    const name = field(requirement, 'name');
    if (!stringValue(name) || !name || !status) return [];
    const result: GerritSubmitRequirement = { name, status };
    const description = field(requirement, 'description');
    if (stringValue(description) && description) result.description = description;
    return [result];
  });
}

const REVISION_KINDS = new Map<string, NonNullable<GerritRevision['kind']>>([
  ['REWORK', 'rework'], ['TRIVIAL_REBASE', 'trivial-rebase'], ['TRIVIAL_REBASE_WITH_MESSAGE_UPDATE', 'trivial-rebase'],
  ['MERGE_FIRST_PARENT_UPDATE', 'merge-first-parent-update'], ['NO_CODE_CHANGE', 'no-code-change'], ['NO_CHANGE', 'no-change'],
]);

export function mapGerritRevisions(raw: Input, identity: GerritIdentity): GerritRevision[] {
  const revisions = field(raw, 'revisions');
  if (!plainObject(revisions)) return [];
  return Object.entries(revisions).flatMap(([sha, revision]) => {
    const number = integer(field(revision, '_number'));
    if (!COMMIT_SHA.test(sha) || number === null || number === 0) return [];
    const changeNumber = field(raw, '_number');
    const result: GerritRevision = { number, sha, createdAt: gerritTimestamp(field(revision, 'created')), ref: text(field(revision, 'ref')) || `refs/changes/${String(Number(changeNumber) % 100).padStart(2, '0')}/${changeNumber}/${number}` };
    const uploader = mapGerritUser(field(revision, 'uploader'), identity);
    if (uploader) result.uploader = uploader;
    const kind = REVISION_KINDS.get(text(field(revision, 'kind')));
    if (kind) result.kind = kind;
    return [result];
  }).sort((a, b) => a.number - b.number);
}

export function mapGerritMessage(value: Input, identity: GerritIdentity, url: string) {
  if (!plainObject(value) || !stringValue(value.id) || !value.id || !stringValue(value.message)) return null;
  const comment: GerritComment = { ...identity, id: value.id, url, body: value.message, canUpdate: false, canDelete: false };
  const author = mapGerritUser(value.author, identity);
  if (author) comment.author = author;
  const date = gerritTimestamp(value.date);
  if (date) comment.createdAt = date;
  const revision = integer(value._revision_number);
  if (revision) comment.revision = revision;
  return comment;
}

export function mapGerritInlineComment(path: string, value: Input, identity: GerritIdentity, url: string) {
  if (!text(path) || !plainObject(value) || !stringValue(value.id) || !value.id || !stringValue(value.message)) return null;
  const comment: GerritComment = { ...identity, id: value.id, url, body: value.message, path, canUpdate: false, canDelete: false };
  const line = integer(value.line);
  if (line) comment.line = line;
  const author = mapGerritUser(value.author, identity);
  if (author) comment.author = author;
  const updated = gerritTimestamp(value.updated);
  if (updated) comment.createdAt = updated;
  const revision = integer(value.patch_set);
  if (revision) comment.revision = revision;
  return comment;
}

const MAGIC_PATHS = new Set(['/COMMIT_MSG', '/MERGE_LIST', '/PATCHSET_LEVEL']);

const FILE_STATUSES = new Map<string, GerritFile['status']>([['A', 'added'], ['D', 'removed'], ['R', 'renamed'], ['C', 'added'], ['W', 'modified']]);

export function mapGerritFiles(files: Input) {
  if (!plainObject(files)) return null;
  return Object.entries(files).flatMap(([path, info]) => {
    if (MAGIC_PATHS.has(path) || !plainObject(info)) return [];
    const file: Omit<GerritFile, 'additions' | 'deletions' | 'changes'> = { path, status: FILE_STATUSES.get(text(info.status)) ?? 'modified' };
    if (stringValue(info.old_path) && info.old_path) file.previousPath = info.old_path;
    const additions = integer(info.lines_inserted) ?? 0;
    const deletions = integer(info.lines_deleted) ?? 0;
    return [Object.assign(file, { additions, deletions, changes: additions + deletions })];
  });
}

export function diffOfPatch(patch: string) {
  const start = patch.search(/^diff --git /m);
  if (start < 0) return '';
  return patch.slice(start).replace(/\n-- \n[^\n]*\n*$/, '\n');
}

export function splitUnifiedDiff(diff: string) {
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

export function mapGerritRelatedStack(related: Input, { origin, project, base }: { origin: string; project: string; base: string }) {
  const candidates = field(related, 'changes');
  const changes = Array.isArray(candidates) ? candidates : [];
  const layers = changes.flatMap((entry) => {
    const number = integer(field(entry, '_change_number'));
    const patchset = integer(field(entry, '_current_revision_number')) ?? integer(field(entry, '_revision_number'));
    const state = changeState(field(entry, 'status'));
    const entryProject = field(entry, 'project');
    if (!number || !patchset || !state || (entryProject !== undefined && entryProject !== project)) return [];
    return [{
      number,
      title: text(field(field(entry, 'commit'), 'subject')),
      url: changeUrl(origin, project, number),
      state,
      draft: false,
      head: patchsetRef(number, patchset),
    }];
  }).reverse();
  return layers.length > 1 ? { number: null, base, layers } : null;
}

export function liveChangeSummary(ref: { owner: string; repo: string }, raw: Input) {
  if (!plainObject(raw)) return null;
  const number = integer(raw._number);
  if (number === null) return null;
  const state = changeState(raw.status) ?? 'closed';
  const open = state === 'open';
  const summary: GerritLiveSummary = {
    owner: ref.owner,
    repo: ref.repo,
    number,
    state,
    draft: raw.work_in_progress === true,
    title: text(raw.subject),
    mergeable: open && (raw.submittable === true || raw.submittable === false) ? raw.submittable : null,
    mergeableState: open && raw.submittable === true ? 'clean' : open && raw.submittable === false ? 'blocked' : null,
    checks: null,
  };
  if (stringValue(raw.current_revision) && COMMIT_SHA.test(raw.current_revision)) summary.headSha = raw.current_revision;
  if (stringValue(raw.branch) && raw.branch) summary.base = raw.branch;
  return summary;
}
