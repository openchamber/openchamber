import { isPlainObject, isString } from '../shared/guards.js';
import { splitProjectPath } from '../source-control/project-path.js';

/**
 * Gerrit answers as the neutral source-control DTOs the other providers emit
 * (`packages/ui/src/lib/source-control/types.ts`), plus the change-review
 * fields only a votes host fills: `voteLabels`, `submitRequirements`,
 * `revisions`. A project's id is its full Gerrit name; a change request's id
 * is `<project>#<number>`. REST paths name a change `<project>~<number>`,
 * built from `project` and `_number`: ChangeInfo's own `id` changed shape
 * between releases (3.8 answers the `project~branch~Change-Id` triplet, 3.10
 * `project~number` with a separate `triplet_id`), so it is never read.
 */

const text = (value) => (isString(value) ? value : '');
const integer = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Gerrit's `2013-02-01 09:59:32.126000000` (UTC) as ISO 8601; null when it is not one. */
export function gerritTimestamp(value) {
  const match = text(value).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?$/);
  if (!match) return null;
  return `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0').slice(0, 3)}Z`;
}

/** The ref a patchset is fetched from: `refs/changes/<last two digits>/<change>/<patchset>`. */
export const patchsetRef = (number, patchset) => `refs/changes/${String(number % 100).padStart(2, '0')}/${number}/${patchset}`;

/** Gerrit's change id in a REST path, `project~number`, the project's slashes encoded. */
export const changePath = (project, number) => `/changes/${encodeURIComponent(project)}~${number}`;

const changeUrl = (origin, project, number) => `${origin}/c/${project}/+/${number}`;

export function mapGerritUser(value, identity) {
  if (!isPlainObject(value) || integer(value._account_id) === null) return null;
  const user = { ...identity, id: String(value._account_id), username: text(value.username) || text(value.name) || String(value._account_id) };
  const avatar = Array.isArray(value.avatars) ? value.avatars.find((entry) => text(entry?.url)) : null;
  if (avatar) user.avatarUrl = avatar.url;
  if (text(value.name)) user.name = value.name;
  if (text(value.email)) user.email = value.email;
  return user;
}

/** A project by its full name; `owner` is everything before the last slash, '' for a top-level project. */
export function mapGerritProject(name, identity, { defaultBranch, remoteName } = {}) {
  if (!text(name) || name.startsWith('/') || name.endsWith('/')) return null;
  const project = {
    ...identity,
    id: name,
    ...splitProjectPath(name),
    url: `${identity.instance}/admin/repos/${name}`,
    // Gerrit serves authenticated Git over HTTP under `/a/`.
    cloneUrl: `${identity.instance}/a/${name}`,
  };
  if (defaultBranch) project.defaultBranch = defaultBranch;
  if (remoteName !== undefined) project.remoteName = remoteName;
  return project;
}

const STATES = new Map([['NEW', 'open'], ['MERGED', 'merged'], ['ABANDONED', 'closed']]);
export const changeState = (status) => STATES.get(status) ?? null;

/** The current revision's number and ref, from `revisions` when it was read. */
const currentRevision = (raw) => {
  const sha = text(raw.current_revision);
  const revision = sha && isPlainObject(raw.revisions) ? raw.revisions[sha] : null;
  const number = integer(revision?._number) ?? integer(raw.current_revision_number);
  return { sha: COMMIT_SHA.test(sha) ? sha : null, number, ref: text(revision?.ref) || (number ? patchsetRef(raw._number, number) : '') };
};

/** The commit message below its subject line, when the current revision's commit was read. */
const descriptionOf = (raw, sha) => {
  const message = text(raw.revisions?.[sha]?.commit?.message);
  if (!message) return undefined;
  return message.split('\n').slice(1).join('\n').trim();
};

export function mapGerritChange(raw, identity, project) {
  if (!isPlainObject(raw) || integer(raw._number) === null || !text(raw.subject) || !text(raw.branch)) return null;
  const state = changeState(raw.status);
  if (!state || raw.project !== project.id) return null;
  const revision = currentRevision(raw);
  const request = {
    ...identity,
    id: `${project.id}#${raw._number}`,
    number: raw._number,
    project,
    title: raw.subject,
    url: changeUrl(identity.instance, project.id, raw._number),
    state,
    draft: raw.work_in_progress === true,
    base: raw.branch,
    // The head is the current patchset's ref, not a branch.
    head: revision.ref || patchsetRef(raw._number, 1),
    labels: (Array.isArray(raw.hashtags) ? raw.hashtags : []).filter((tag) => text(tag)).map((name) => ({ name })),
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
  if (text(raw.topic)) request.topic = raw.topic;
  // Mergeable means submittable: every submit requirement is met.
  if (state === 'open' && (raw.submittable === true || raw.submittable === false)) {
    request.mergeable = raw.submittable;
    request.mergeableState = raw.submittable ? 'clean' : 'blocked';
  }
  return request;
}

/** `"+2"`, `" 0"`, `"-1"` as integers; null for anything else. */
const voteValue = (key) => {
  const match = text(key).trim().match(/^([+-]?)(\d{1,2})$/);
  if (!match) return null;
  return Number(match[2]) * (match[1] === '-' ? -1 : 1);
};

const LABEL_STATUSES = [['rejected', 'rejected'], ['approved', 'approved'], ['disliked', 'disliked'], ['recommended', 'recommended']];

/**
 * The labels of a change read with `DETAILED_LABELS`: their values, what the
 * caller may vote (`permitted_labels`), and every non-zero vote. A zero in
 * `all` only says that person may vote, so it is not a vote.
 */
export function mapGerritVoteLabels(raw, identity) {
  if (!isPlainObject(raw?.labels)) return [];
  const permitted = isPlainObject(raw.permitted_labels) ? raw.permitted_labels : {};
  return Object.entries(raw.labels).flatMap(([name, label]) => {
    if (!isPlainObject(label)) return [];
    const values = Object.entries(isPlainObject(label.values) ? label.values : {}).flatMap(([key, description]) => {
      const value = voteValue(key);
      return value === null ? [] : [{ value, description: text(description) }];
    }).sort((a, b) => a.value - b.value);
    const allowed = (Array.isArray(permitted[name]) ? permitted[name] : []).map(voteValue).filter((value) => value !== null).sort((a, b) => a - b);
    const votes = (Array.isArray(label.all) ? label.all : []).flatMap((approval) => {
      if (!Number.isInteger(approval?.value) || approval.value === 0) return [];
      const user = mapGerritUser(approval, identity);
      return user ? [{ user, value: approval.value }] : [];
    });
    const status = LABEL_STATUSES.find(([key]) => isPlainObject(label[key]))?.[1] ?? 'neutral';
    return [{
      name,
      values,
      defaultValue: Number.isInteger(label.default_value) ? label.default_value : 0,
      permitted: allowed,
      blocking: label.blocking === true,
      status,
      votes,
    }];
  });
}

const REQUIREMENT_STATUSES = new Map([
  ['SATISFIED', 'satisfied'], ['UNSATISFIED', 'unsatisfied'], ['OVERRIDDEN', 'overridden'],
  ['NOT_APPLICABLE', 'not-applicable'], ['ERROR', 'error'], ['FORCED', 'forced'], ['TIMEOUT', 'error'],
]);

export function mapGerritSubmitRequirements(raw) {
  if (!Array.isArray(raw?.submit_requirements)) return [];
  return raw.submit_requirements.flatMap((requirement) => {
    const status = REQUIREMENT_STATUSES.get(requirement?.status);
    if (!text(requirement?.name) || !status) return [];
    const result = { name: requirement.name, status };
    if (text(requirement.description)) result.description = requirement.description;
    return [result];
  });
}

const REVISION_KINDS = new Map([
  ['REWORK', 'rework'], ['TRIVIAL_REBASE', 'trivial-rebase'], ['TRIVIAL_REBASE_WITH_MESSAGE_UPDATE', 'trivial-rebase'],
  ['MERGE_FIRST_PARENT_UPDATE', 'merge-first-parent-update'], ['NO_CODE_CHANGE', 'no-code-change'], ['NO_CHANGE', 'no-change'],
]);

/** Patchsets oldest first; a change edit (`_number: "edit"`) is not one. */
export function mapGerritRevisions(raw, identity) {
  if (!isPlainObject(raw?.revisions)) return [];
  return Object.entries(raw.revisions).flatMap(([sha, revision]) => {
    if (!COMMIT_SHA.test(sha) || integer(revision?._number) === null || revision._number === 0) return [];
    const result = { number: revision._number, sha, createdAt: gerritTimestamp(revision.created), ref: text(revision.ref) || patchsetRef(raw._number, revision._number) };
    const uploader = mapGerritUser(revision.uploader, identity);
    if (uploader) result.uploader = uploader;
    const kind = REVISION_KINDS.get(revision.kind);
    if (kind) result.kind = kind;
    return [result];
  }).sort((a, b) => a.number - b.number);
}

/** A change message ("Patch Set 3: Code-Review+2") as a comment on the timeline. */
export function mapGerritMessage(value, identity, url) {
  if (!isPlainObject(value) || !text(value.id) || !isString(value.message)) return null;
  const comment = { ...identity, id: value.id, url, body: value.message };
  const author = mapGerritUser(value.author, identity);
  if (author) comment.author = author;
  const date = gerritTimestamp(value.date);
  if (date) comment.createdAt = date;
  if (integer(value._revision_number)) comment.revision = value._revision_number;
  return comment;
}

/** A published inline comment (`/changes/{id}/comments` is keyed by path). */
export function mapGerritInlineComment(path, value, identity, url) {
  if (!text(path) || !isPlainObject(value) || !text(value.id) || !isString(value.message)) return null;
  const comment = { ...identity, id: value.id, url, body: value.message, path };
  if (integer(value.line)) comment.line = value.line;
  const author = mapGerritUser(value.author, identity);
  if (author) comment.author = author;
  const updated = gerritTimestamp(value.updated);
  if (updated) comment.createdAt = updated;
  if (integer(value.patch_set)) comment.revision = value.patch_set;
  return comment;
}

/** Gerrit's paths that are not files of the repository. */
const MAGIC_PATHS = new Set(['/COMMIT_MSG', '/MERGE_LIST', '/PATCHSET_LEVEL']);

const FILE_STATUSES = new Map([['A', 'added'], ['D', 'removed'], ['R', 'renamed'], ['C', 'added'], ['W', 'modified']]);

/** A revision's `FileInfo` map, without the magic paths; a missing status is a modification. */
export function mapGerritFiles(files) {
  if (!isPlainObject(files)) return null;
  return Object.entries(files).flatMap(([path, info]) => {
    if (MAGIC_PATHS.has(path) || !isPlainObject(info)) return [];
    const file = { path, status: FILE_STATUSES.get(info.status) ?? 'modified' };
    if (text(info.old_path)) file.previousPath = info.old_path;
    const additions = integer(info.lines_inserted) ?? 0;
    const deletions = integer(info.lines_deleted) ?? 0;
    Object.assign(file, { additions, deletions, changes: additions + deletions });
    return [file];
  });
}

/**
 * The diff part of a `git format-patch` mail (`/revisions/{rev}/patch`):
 * the mail headers and message before the first `diff --git` and the
 * signature after the last hunk are dropped.
 */
export function diffOfPatch(patch) {
  const start = patch.search(/^diff --git /m);
  if (start < 0) return '';
  return patch.slice(start).replace(/\n-- \n[^\n]*\n*$/, '\n');
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

/**
 * A relation chain as a stack, bottom first. `/related` lists the chain in
 * Git commit order, newest first, so it is reversed; entries that are only
 * commits (no change number) and changes of other projects are left out.
 * Null when the change has no relatives.
 */
export function mapGerritRelatedStack(related, { origin, project, base }) {
  const changes = Array.isArray(related?.changes) ? related.changes : [];
  const layers = changes.flatMap((entry) => {
    const number = integer(entry?._change_number);
    const patchset = integer(entry?._current_revision_number) ?? integer(entry?._revision_number);
    const state = changeState(entry?.status);
    if (!number || !patchset || !state || (entry.project !== undefined && entry.project !== project)) return [];
    return [{
      number,
      title: text(entry.commit?.subject),
      url: changeUrl(origin, project, number),
      state,
      // `/related` does not say whether a relative is work in progress.
      draft: false,
      head: patchsetRef(number, patchset),
    }];
  }).reverse();
  return layers.length > 1 ? { number: null, base, layers } : null;
}

/** A change's live state in the shape the other providers' summaries use. */
export function liveChangeSummary(ref, raw) {
  if (!isPlainObject(raw) || integer(raw._number) === null) return null;
  const state = changeState(raw.status) ?? 'closed';
  const open = state === 'open';
  const summary = {
    owner: ref.owner,
    repo: ref.repo,
    number: raw._number,
    state,
    draft: raw.work_in_progress === true,
    title: text(raw.subject),
    mergeable: open && (raw.submittable === true || raw.submittable === false) ? raw.submittable : null,
    mergeableState: open && raw.submittable === true ? 'clean' : open && raw.submittable === false ? 'blocked' : null,
    checks: null,
  };
  if (COMMIT_SHA.test(text(raw.current_revision))) summary.headSha = raw.current_revision;
  if (text(raw.branch)) summary.base = raw.branch;
  return summary;
}
