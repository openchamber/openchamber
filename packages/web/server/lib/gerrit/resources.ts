import { documentDataUrl } from '../source-control/document-versions.js';
import { isPlainObject, isPresent, isString } from '../shared/guards.js';
import { mapLimited } from '../shared/map-limited.js';
import { joinProjectPath } from '../source-control/project-path.js';
import { readLocalRevision as readLocalRevisionDefault, readUpstreamBranch as readUpstreamBranchDefault } from './local-revision.js';
import {
  changePath, changeState, diffOfPatch, gerritTimestamp, liveChangeSummary, mapGerritChange, mapGerritFiles, mapGerritInlineComment,
  mapGerritMessage, mapGerritProject, mapGerritRelatedStack, mapGerritRevisions, mapGerritSubmitRequirements, mapGerritUser,
  mapGerritVoteLabels, splitUnifiedDiff,
} from './mappers.js';
import { resolveGerritProjectsFromDirectory } from './repo.js';
import type { BindingMutationTarget } from '../source-control/binding-service-contracts.js';
import type { GerritChange, GerritComment, GerritFile, GerritIdentity, GerritJson, GerritProject, GerritQuery, GerritRevision, GerritSubmitRequirement, GerritVoteLabel } from './contracts.js';
import type { ProviderReadContext } from '../source-control/provider-contract.js';
import type { SourceControlMutationTarget } from '@openchamber/sdk';
import type { reviewCommentPosition } from '../source-control/review-position.js';

type Input = GerritJson | undefined;
type JsonObject = { [key: string]: GerritJson };
type Query = GerritQuery;
export interface GerritResourceClient {
  get(path: string, query?: Query): Promise<GerritJson>;
  page(path: string, query: Query, options: { start: number; limit: number; changes?: boolean }): Promise<{ items: GerritJson[]; hasMore: boolean }>;
  base64(path: string, query?: Query): Promise<Buffer>;
  post(path: string, body: GerritJson): Promise<GerritJson>;
  put(path: string, body: GerritJson): Promise<GerritJson>;
  delete(path: string): Promise<GerritJson>;
}
export interface GerritResourceOptions {
  origin: string;
  client: GerritResourceClient;
  resolveProjects?: typeof resolveGerritProjectsFromDirectory;
  readLocalRevision?: typeof readLocalRevisionDefault;
  readUpstreamBranch?: typeof readUpstreamBranchDefault;
}
type ProjectSelector = { owner: string; name: string };
type Project = Awaited<ReturnType<typeof resolveGerritProjectsFromDirectory>>['repos'][number];
type ProviderTarget = { project: string; number: number };
type MutationCall = { providerTarget: ProviderTarget; expectedTarget: SourceControlMutationTarget };
type ReadOptions = {
  project?: ProjectSelector | undefined;
  remote?: string | undefined;
  revision?: string | null | undefined;
  linked?: boolean | undefined;
};
type Stack = ReturnType<typeof mapGerritRelatedStack>;
export interface GerritChangeContext {
  identity: GerritIdentity;
  project: GerritProject;
  changeRequest: GerritChange;
  issueComments: GerritComment[];
  reviewComments: GerritComment[];
  files: Array<GerritFile & { patch?: string }>;
  diff: string;
  ci: null;
  voteLabels: GerritVoteLabel[];
  submitRequirements: GerritSubmitRequirement[];
  revisions: GerritRevision[];
  stack?: Stack;
}
type FileComment = JsonObject & { file: string };
type DraftInput = {
  path: string;
  message: string;
  side?: 'PARENT';
  line?: number;
  range?: { start_line: number; start_character: number; end_line: number; end_character: number };
};
type ReviewInput = { labels: Record<string, number>; drafts: 'PUBLISH_ALL_REVISIONS'; message?: string };
const plainObject = (value: Input): value is JsonObject => isPlainObject(value);
const field = (value: Input, key: string): Input => plainObject(value) ? value[key] : undefined;
const stringValue = (value: Input): value is string => isString(value);
const isInteger = (value: Input): value is number => Number.isInteger(value);
const errorRecord = (error: unknown): error is Record<string, unknown> => error !== null
  && (typeof error === 'object' || typeof error === 'function');
const unauthorized = (error: unknown): error is object => errorRecord(error)
  && (error.status ?? (errorRecord(error.response) ? error.response.status : undefined)) === 401;

const LIST_PAGE = 20;
const STATUS_CANDIDATES = 10;
const BRANCH_PAGE = 500;
const COLLECTION_MAX_ITEMS = 2000;
const REVIEWER_SAMPLE = 25;
const LIVE_SUMMARY_CONCURRENCY = 4;
const MAX_FULL_FILE_BYTES = 5 * 1024 * 1024;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

const STATUS_OPTIONS = ['ALL_REVISIONS', 'LABELS', 'SUBMITTABLE', 'DETAILED_ACCOUNTS'];
const LIST_OPTIONS = ['CURRENT_REVISION', 'LABELS', 'SUBMITTABLE', 'DETAILED_ACCOUNTS'];
const CONTEXT_OPTIONS = ['ALL_REVISIONS', 'CURRENT_COMMIT', 'LABELS', 'DETAILED_LABELS', 'DETAILED_ACCOUNTS', 'MESSAGES', 'SUBMITTABLE', 'SUBMIT_REQUIREMENTS'];
const HEAD_OPTIONS = ['ALL_REVISIONS'];
const MUTATION_OPTIONS = ['CURRENT_REVISION', 'LABELS', 'DETAILED_ACCOUNTS'];
const MAGIC_REVIEW_PATHS = new Set(['/COMMIT_MSG', '/MERGE_LIST', '/PATCHSET_LEVEL']);
const CANDIDATE_OPTIONS = ['LABELS', 'DETAILED_ACCOUNTS'];
const LIVE_OPTIONS = ['CURRENT_REVISION', 'SUBMITTABLE'];

const LIST_STATES = { open: 'status:open', closed: 'status:closed', merged: 'status:merged', all: '' };
const LIST_PEOPLE = { any: '', created: 'owner:self', assigned: 'attention:self', reviewRequested: 'reviewer:self -owner:self' };
const listTerm = <Terms extends Readonly<Record<string, string>>>(terms: Terms, key: string) => (Object.hasOwn(terms, key) ? terms[key] : undefined);

const notFound = (message: string) => Object.assign(new Error(message), { status: 404 });
const malformed = (message: string) => new Error(message);
const mismatch = (key: string) => Object.assign(new Error(`Gerrit change ${key} changed`), {
  code: 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH', status: 409,
});
const notApplied = () => ({ state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } });
const enc = (value: string) => encodeURIComponent(value);

function requireMapped<Value>(value: Value | null, message: string): Value {
  if (!value) throw malformed(message);
  return value;
}

const searchTerm = (query: string | undefined) => {
  const value = isString(query) ? query?.trim() : '';
  if (!value) return '';
  if (/^\d+$/.test(value)) return `change:${value}`;
  const words = value.replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? `message:"${words}"` : '';
};

export function selectChangeForBranch(candidates: JsonObject[], { upstreamBranch, defaultBranch }: { upstreamBranch: string | null; defaultBranch: string | null }) {
  const newest = (list: JsonObject[]) => list.reduce<JsonObject | null>((best, raw) => (!best || String(raw.updated) > String(best.updated) ? raw : best), null);
  const open = candidates.filter((raw) => raw.status === 'NEW');
  return (upstreamBranch ? open.find((raw) => raw.branch === upstreamBranch) : null)
    ?? (defaultBranch ? open.find((raw) => raw.branch === defaultBranch) : null)
    ?? (open.length === 1 ? open[0] : null)
    ?? newest(open)
    ?? newest(candidates.filter((raw) => raw.status !== 'NEW'));
}

export function createGerritResourceService({
  origin,
  client,
  resolveProjects = resolveGerritProjectsFromDirectory,
  readLocalRevision = readLocalRevisionDefault,
  readUpstreamBranch = readUpstreamBranchDefault,
}: GerritResourceOptions) {
  const identity = { provider: 'gerrit', instance: origin };

  const primaryProject = async (directory: string, remote: string | undefined) => {
    const [primary] = (await resolveProjects(directory, origin, remote)).repos;
    if (!primary) throw malformed('No Gerrit project found for the repository remotes');
    return primary;
  };

  const boundProject = async (directory: string, selector: ProjectSelector | null | undefined, remote: string | undefined, { linked = false }: { linked?: boolean | undefined } = {}) => {
    const primary = await primaryProject(directory, remote);
    if (linked && selector) return { ...primary, project: joinProjectPath(selector.owner, selector.name), owner: selector.owner, name: selector.name };
    if (selector && joinProjectPath(selector.owner, selector.name) !== primary.project) throw notFound('Gerrit project is outside the bound project');
    return primary;
  };

  const readDefaultBranch = async (name: string) => {
    try {
      const head = await client.get(`/projects/${enc(name)}/HEAD`);
      return stringValue(head) && head.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : null;
    } catch (error) {
      if (unauthorized(error)) throw error;
      return null;
    }
  };

  const projectOf = (primary: Project, options: Parameters<typeof mapGerritProject>[2]) => requireMapped(mapGerritProject(primary.project, identity, options), 'Gerrit returned an invalid project');

  const readChange = async (name: string, number: number, options: string[]) => {
    const raw = await client.get(changePath(name, number), { o: options });
    if (!plainObject(raw) || raw._number !== number) throw malformed('Gerrit returned another change');
    if (raw.project !== name) throw notFound(`Gerrit change ${number} is not in ${name}`);
    return raw;
  };

  const requireChange = (raw: Input, project: GerritProject) => requireMapped(mapGerritChange(raw, identity, project), 'Gerrit returned an invalid change');

  const findChange = async (directory: string, number: number, selector: ProjectSelector | null | undefined, remote: string | undefined, options: string[], { linked }: { linked?: boolean | undefined } = {}) => {
    const primary = await boundProject(directory, selector, remote, { linked });
    const project = projectOf(primary, { remoteName: primary.remoteName });
    const raw = await readChange(primary.project, number, options);
    return { primary, project, raw, request: requireChange(raw, project) };
  };

  const revisionOf = (raw: JsonObject, revision: string | null | undefined) => {
    if (revision === undefined || revision === null || revision === '') {
      if (!COMMIT_SHA.test(String(raw.current_revision))) throw malformed('Gerrit returned a change without a current patchset');
      return raw.current_revision;
    }
    if (!plainObject(raw.revisions) || !Object.hasOwn(raw.revisions, revision)) {
      throw notFound(`Gerrit change ${raw._number} has no patchset ${revision}`);
    }
    return revision;
  };

  const readStack = async (name: string, number: number, base: string) => {
    try {
      return mapGerritRelatedStack(await client.get(`${changePath(name, number)}/revisions/current/related`), { origin, project: name, base });
    } catch (error) {
      if (unauthorized(error)) throw error;
      return undefined;
    }
  };

  const compactProject = (project: GerritProject) => ({ id: project.id, owner: project.owner, name: project.name });
  const mutationTarget = (context: Pick<ProviderReadContext, 'repositoryId' | 'bindingRevision' | 'primaryRemote'>, project: GerritProject, request: GerritChange) => {
    const target: SourceControlMutationTarget = {
      repositoryId: context.repositoryId,
      bindingRevision: context.bindingRevision,
      primaryRemote: context.primaryRemote,
      project: compactProject(project),
    };
    const keys: Array<'number' | 'head' | 'base' | 'headSha'> = ['number', 'head', 'base', 'headSha'];
    for (const key of keys) {
      if (request[key] !== undefined) Object.assign(target, { [key]: request[key] });
    }
    return target;
  };
  const requireExpected = (expected: BindingMutationTarget, actual: GerritChange) => {
    const keys: Array<'number' | 'head' | 'base' | 'headSha'> = ['number', 'head', 'base', 'headSha'];
    for (const key of keys) {
      if (expected[key] !== undefined && expected[key] !== actual[key]) throw mismatch(key);
    }
  };
  const readTarget = (providerTarget: ProviderTarget, options = MUTATION_OPTIONS) => readChange(providerTarget.project, providerTarget.number, options);
  const targetPath = (providerTarget: ProviderTarget) => changePath(providerTarget.project, providerTarget.number);
  const reviewerIds = (raw: Input) => {
    const reviewers = field(field(raw, 'reviewers'), 'REVIEWER');
    return (Array.isArray(reviewers) ? reviewers : [])
      .filter((account) => Number.isInteger(field(account, '_account_id'))).map((account) => String(field(account, '_account_id')));
  };
  const readDrafts = async (providerTarget: ProviderTarget) => {
    const drafts = await client.get(`${targetPath(providerTarget)}/drafts`);
    if (!plainObject(drafts)) throw malformed('Gerrit returned invalid draft comments');
    return drafts;
  };
  const hasDrafts = (drafts: JsonObject) => Object.values(drafts).some((comments) => Array.isArray(comments) && comments.length > 0);
  const requireDraft = async (providerTarget: ProviderTarget, commentId: string) => {
    const draft = Object.values(await readDrafts(providerTarget)).flat().find((comment): comment is JsonObject => field(comment, 'id') === commentId);
    if (!draft) throw Object.assign(new Error('Review comment is not a draft of yours on this change'), { code: 'SOURCE_CONTROL_MUTATION_TARGET_INVALID', status: 409 });
    return draft;
  };
  const reviewPerson = (account: Input) => {
    const user = mapGerritUser(account, identity);
    return user ? { login: user.username, avatarUrl: user.avatarUrl } : null;
  };
  const reviewCommentAt = (comment: FileComment) => {
    const startLine = field(comment.range, 'start_line');
    return {
      path: comment.file,
      side: comment.side === 'PARENT' ? 'old' : 'new',
      line: isInteger(comment.line) ? comment.line : null,
      startLine: isInteger(startLine) && startLine < Number(comment.line) ? startLine : null,
    };
  };
  const requireCurrent = (raw: JsonObject, headSha: string | undefined) => {
    if (raw.current_revision !== headSha) throw mismatch('headSha');
  };

  return {
    async changeRequestStatus(directory: string, branch: string, remote?: string) {
      const primary = await primaryProject(directory, remote);
      const defaultBranch = await readDefaultBranch(primary.project);
      const project = projectOf(primary, { defaultBranch, remoteName: primary.remoteName });
      const base = { identity, project, branch, resolvedRemoteName: primary.remoteName ?? null, defaultBranch };
      const local = await readLocalRevision(directory, branch);
      if (!local.changeId) return { ...base, changeRequest: null, localRevision: { sha: local.sha, changeId: null, uploadedAs: null } };
      const answer = await client.get('/changes/', { q: `change:${local.changeId} project:${primary.project}`, o: STATUS_OPTIONS, n: STATUS_CANDIDATES });
      if (!Array.isArray(answer)) throw malformed('Gerrit returned an invalid change list');
      const candidates = answer.filter((raw): raw is JsonObject => plainObject(raw) && raw.project === primary.project && raw.change_id === local.changeId);
      const upstreamBranch = await readUpstreamBranch(directory, branch, primary.remoteName).catch(() => null);
      const selected = selectChangeForBranch(candidates, { upstreamBranch, defaultBranch });
      if (!selected) return { ...base, changeRequest: null, localRevision: { sha: local.sha, changeId: local.changeId, uploadedAs: null } };
      const request = requireChange(selected, project);
      const uploaded = field(Object.entries(plainObject(selected.revisions) ? selected.revisions : {})
        .find(([sha]) => sha === local.sha)?.[1], '_number');
      const status: typeof base & { changeRequest: GerritChange; ci: null; canMerge: boolean; localRevision: { sha: string | null; changeId: string; uploadedAs: number | null }; stack?: Stack } = {
        ...base,
        changeRequest: request,
        ci: null,
        canMerge: request.state === 'open' && request.mergeable === true,
        localRevision: { sha: local.sha, changeId: local.changeId, uploadedAs: isInteger(uploaded) ? uploaded : null },
      };
      if (request.state === 'open') {
        const stack = await readStack(primary.project, request.number, request.base);
        if (stack !== undefined) status.stack = stack;
      }
      return status;
    },

    async listChangeRequests(directory: string, options: { page?: number | undefined; remote?: string | undefined; state?: string | undefined; people?: string | undefined; query?: string | undefined } = {}) {
      const page = options.page ?? 1;
      const primary = await primaryProject(directory, options.remote);
      const project = projectOf(primary, { remoteName: primary.remoteName });
      const q = [`project:${primary.project}`, listTerm(LIST_STATES, options.state ?? 'open') ?? LIST_STATES.open,
        listTerm(LIST_PEOPLE, options.people ?? 'any') ?? '', searchTerm(options.query)].filter(Boolean).join(' ');
      const result = await client.page('/changes/', { q, o: LIST_OPTIONS }, { start: (page - 1) * LIST_PAGE, limit: LIST_PAGE });
      return { items: result.items.map((raw) => requireChange(raw, project)), page, hasMore: result.hasMore };
    },

    async changeRequestContext(directory: string, number: number, options: ReadOptions & { includeDiff?: boolean | undefined; includeTimeline?: boolean | undefined } = {}) {
      const { primary, project, raw, request } = await findChange(directory, number, options.project, options.remote, CONTEXT_OPTIONS, { linked: options.linked });
      const sha = revisionOf(raw, options.revision);
      const path = changePath(primary.project, number);
      const [files, patch, inline, stack] = await Promise.all([
        options.includeDiff ? client.get(`${path}/revisions/${sha}/files/`) : Promise.resolve({}),
        options.includeDiff ? client.base64(`${path}/revisions/${sha}/patch`) : Promise.resolve(null),
        client.get(`${path}/comments`),
        request.state === 'open' ? readStack(primary.project, number, request.base) : Promise.resolve(null),
      ]);
      const diff = patch ? diffOfPatch(patch.toString('utf8')) : '';
      const patches = splitUnifiedDiff(diff);
      const changedFiles = requireMapped(mapGerritFiles(files), 'Gerrit returned an invalid file list').map((file) => {
        const filePatch = patches.get(file.path);
        return filePatch ? { ...file, patch: filePatch } : file;
      });
      const issueComments = (Array.isArray(raw.messages) ? raw.messages : []).map((message) => requireMapped(
        mapGerritMessage(message, identity, request.url), 'Gerrit returned an invalid change message',
      ));
      const reviewComments = Object.entries(plainObject(inline) ? inline : {}).flatMap(([filePath, comments]) => (
        Array.isArray(comments) ? comments : []
      ).flatMap((comment) => {
        const mapped = mapGerritInlineComment(filePath, comment, identity, request.url);
        return mapped ? [mapped] : [];
      }));
      const context: GerritChangeContext = {
        identity,
        project,
        changeRequest: request,
        issueComments,
        reviewComments,
        files: changedFiles,
        diff,
        ci: null,
        voteLabels: mapGerritVoteLabels(raw, identity),
        submitRequirements: mapGerritSubmitRequirements(raw),
        revisions: mapGerritRevisions(raw, identity),
      };
      if (stack !== undefined) context.stack = stack;
      if (!options.includeTimeline) return context;
      const commit = field(field(raw.revisions, String(raw.current_revision)), 'commit');
      const reviewers = field(raw.reviewers, 'REVIEWER');
      return {
        ...context,
        commits: plainObject(commit) ? [{
          sha: raw.current_revision,
          headline: stringValue(commit.subject) ? commit.subject : request.title,
          authorName: stringValue(field(commit.author, 'name')) ? field(commit.author, 'name') : null,
          committedAt: gerritTimestamp(field(commit.committer, 'date')),
          url: request.url,
        }] : [],
        commitsComplete: true,
        reviewers: (Array.isArray(reviewers) ? reviewers : []).flatMap((account) => {
          const mapped = mapGerritUser(account, identity);
          return mapped ? [mapped] : [];
        }),
      };
    },

    async projectUpstream(directory: string, remote?: string) {
      await primaryProject(directory, remote);
      return { identity, isFork: false, upstream: null };
    },

    async projectBranches(directory: string, selector?: ProjectSelector, remote?: string) {
      const primary = await boundProject(directory, selector, remote);
      const names: string[] = [];
      for (let start = 0; ; start += BRANCH_PAGE) {
        const result = await client.page(`/projects/${enc(primary.project)}/branches/`, {}, { start, limit: BRANCH_PAGE, changes: false });
        for (const branch of result.items) {
          const ref = field(branch, 'ref');
          if (!stringValue(ref)) throw malformed('Gerrit returned an invalid branch');
          if (ref.startsWith('refs/heads/')) names.push(ref.slice('refs/heads/'.length));
        }
        if (!result.hasMore) return names;
        if (start + BRANCH_PAGE >= COLLECTION_MAX_ITEMS) throw malformed('Gerrit project has more branches than OpenChamber reads');
      }
    },

    async listReviewerCandidates(directory: string, selector?: ProjectSelector, remote?: string) {
      const primary = await boundProject(directory, selector, remote);
      const changes = await client.get('/changes/', { q: `project:${primary.project}`, o: CANDIDATE_OPTIONS, n: REVIEWER_SAMPLE });
      if (!Array.isArray(changes)) throw malformed('Gerrit returned an invalid change list');
      const candidates = new Map<string, { id: string; login: string; avatarUrl?: string }>();
      for (const raw of changes) {
        const reviewers = field(field(raw, 'reviewers'), 'REVIEWER');
        for (const account of [field(raw, 'owner'), ...(Array.isArray(reviewers) ? reviewers : [])]) {
          const user = mapGerritUser(account, identity);
          if (!user || candidates.has(user.id)) continue;
          candidates.set(user.id, user.avatarUrl ? { id: user.id, login: user.username, avatarUrl: user.avatarUrl } : { id: user.id, login: user.username });
        }
      }
      return [...candidates.values()];
    },

    async changeRequestPatch(directory: string, number: number, { project, remote, revision, linked }: ReadOptions = {}) {
      const { primary, raw } = await findChange(directory, number, project, remote, HEAD_OPTIONS, { linked });
      const sha = revisionOf(raw, revision);
      const patch = await client.base64(`${changePath(primary.project, number)}/revisions/${sha}/patch`);
      return { patch: diffOfPatch(patch.toString('utf8')), meta: { owner: primary.owner, repo: primary.name, number } };
    },

    async changeRequestFileContents(directory: string, number: number, { project, remote, path, previousPath, status, revision, binary, linked }: ReadOptions & { path: string; previousPath?: string | undefined; status?: string | undefined; binary?: boolean | undefined }) {
      const { primary, raw } = await findChange(directory, number, project, remote, HEAD_OPTIONS, { linked });
      const sha = revisionOf(raw, revision);
      const readFile = async (filePath: string, parent: boolean) => {
        const content = await client.base64(`${changePath(primary.project, number)}/revisions/${sha}/files/${enc(filePath)}/content`, parent ? { parent: 1 } : undefined);
        if (binary) return documentDataUrl(content);
        if (content.length > MAX_FULL_FILE_BYTES) {
          throw Object.assign(new Error('This file is too large to show in full'), { status: 413, code: 'file-too-large' });
        }
        return content.toString('utf8');
      };
      const [original, modified] = await Promise.all([
        status === 'A' || path === '/COMMIT_MSG' ? '' : readFile(previousPath || path, true),
        status === 'D' ? '' : readFile(path, false),
      ]);
      return { original, modified };
    },

    async liveSummaries({ refs = [] }: { refs?: Array<{ owner: string; repo: string; number: number }> | undefined }) {
      const summaries = await mapLimited(refs, LIVE_SUMMARY_CONCURRENCY, async (ref) => {
        try {
          if (ref === undefined) return null;
          return liveChangeSummary(ref, await client.get(changePath(joinProjectPath(ref.owner, ref.repo), ref.number), { o: LIVE_OPTIONS }));
        } catch (error) {
          if (unauthorized(error)) throw error;
          return null;
        }
      });
      return { summaries: summaries.filter(isPresent), issueSummaries: [] };
    },

    async findChangeRequest(directory: string, number: number, selector: ProjectSelector | null | undefined, remote?: string) {
      const { project, raw, request } = await findChange(directory, number, selector, remote, HEAD_OPTIONS);
      return { project, raw, request };
    },


    async resolveChangeRequestMutation(context: Pick<ProviderReadContext, 'directory' | 'repositoryId' | 'bindingRevision' | 'primaryRemote'>, expected: BindingMutationTarget & { number: number }) {
      const { primary, project, request } = await findChange(context.directory, expected.number, expected.project, context.primaryRemote, MUTATION_OPTIONS);
      requireExpected(expected, request);
      return {
        providerTarget: { project: primary.project, number: request.number },
        target: mutationTarget(context, project, request),
      };
    },

    async submit({ providerTarget, expectedTarget }: MutationCall) {
      requireCurrent(await readTarget(providerTarget), expectedTarget.headSha);
      const raw = await client.post(`${targetPath(providerTarget)}/submit`, {});
      return { merged: field(raw, 'status') === 'MERGED' };
    },

    async ready({ providerTarget }: Pick<MutationCall, 'providerTarget'>) {
      const current = await readTarget(providerTarget);
      if (current.work_in_progress !== true) return { ready: true };
      await client.post(`${targetPath(providerTarget)}/ready`, {});
      return { ready: true };
    },

    async draft({ providerTarget }: Pick<MutationCall, 'providerTarget'>) {
      const current = await readTarget(providerTarget);
      if (current.work_in_progress === true) return { draft: true };
      await client.post(`${targetPath(providerTarget)}/wip`, {});
      return { draft: true };
    },

    async setState({ providerTarget, state }: Pick<MutationCall, 'providerTarget'> & { state: 'open' | 'closed' }) {
      const raw = await client.post(`${targetPath(providerTarget)}/${state === 'closed' ? 'abandon' : 'restore'}`, {});
      if (!plainObject(raw) || raw._number !== providerTarget.number || changeState(raw.status) !== state) {
        throw malformed('Gerrit returned an unexpected change state');
      }
      return { state };
    },

    async reconcileChangeRequestMutation(providerTarget: ProviderTarget, kind: string) {
      const raw = await readTarget(providerTarget);
      if (kind === 'change-request-merge') return raw.status === 'MERGED' ? { state: 'succeeded', result: { merged: true } } : notApplied();
      if (kind === 'change-request-ready') return raw.work_in_progress !== true ? { state: 'succeeded', result: { ready: true } } : notApplied();
      if (kind === 'change-request-draft') return raw.work_in_progress === true ? { state: 'succeeded', result: { draft: true } } : notApplied();
      return { state: 'outcome-unknown' };
    },

    async reconcileStateMutation(providerTarget: ProviderTarget, state: 'open' | 'closed') {
      const current = changeState((await readTarget(providerTarget)).status);
      if (current === state) return { state: 'succeeded', result: { state } };
      return current ? notApplied() : { state: 'outcome-unknown' };
    },

    async setReviewers({ providerTarget, reviewers }: Pick<MutationCall, 'providerTarget'> & { reviewers: string[] }) {
      const current = reviewerIds(await readTarget(providerTarget));
      const path = targetPath(providerTarget);
      for (const id of reviewers.filter((candidate) => !current.includes(candidate))) {
        const result = await client.post(`${path}/reviewers`, { reviewer: id });
        const error = field(result, 'error');
        if (stringValue(error) && error) throw Object.assign(new Error(error), { status: 400 });
      }
      for (const id of current.filter((candidate) => !reviewers.includes(candidate))) {
        await client.post(`${path}/reviewers/${enc(id)}/delete`, {});
      }
      return {};
    },

    async reconcileReviewers(providerTarget: ProviderTarget, names: string[]) {
      const current = reviewerIds(await readTarget(providerTarget));
      if (current.length !== names.length || !current.every((id) => names.includes(id))) return { state: 'outcome-unknown' };
      return { state: 'succeeded', result: {} };
    },

    async reviewState(directory: string, number: number, project?: ProjectSelector, remote?: string) {
      const { primary, raw } = await findChange(directory, number, project, remote, MUTATION_OPTIONS);
      const providerTarget = { project: primary.project, number };
      const path = targetPath(providerTarget);
      const [drafts, published, self] = await Promise.all([readDrafts(providerTarget), client.get(`${path}/comments`), client.get('/accounts/self')]);
      const currentPatchSet = field(field(raw.revisions, String(raw.current_revision)), '_number');
      const me = reviewPerson(self);
      const commentsOf = (map: Input) => Object.entries(plainObject(map) ? map : {}).flatMap(([file, comments]) => (
        MAGIC_REVIEW_PATHS.has(file) || !Array.isArray(comments) ? [] : comments.map((comment): FileComment => {
          const copy: JsonObject = Object.fromEntries(Object.entries(comment ?? {}));
          return { ...copy, file };
        })
      ));
      const draftComments = commentsOf(drafts);
      const threads = new Map<Input, { root: FileComment; comments: FileComment[] }>();
      const byId = new Map(commentsOf(published).map((comment) => [comment.id, comment]));
      const rootOf = (comment: FileComment) => {
        let current = comment;
        while (current.in_reply_to) {
          const parent = byId.get(current.in_reply_to);
          if (!parent) break;
          current = parent;
        }
        return current;
      };
      for (const comment of byId.values()) {
        const root = rootOf(comment);
        if (root.patch_set !== currentPatchSet) continue;
        let thread = threads.get(root.id);
        if (!thread) {
          thread = { root, comments: [] };
          threads.set(root.id, thread);
        }
        thread.comments.push(comment);
      }
      return {
        connected: true,
        viewerIsAuthor: field(raw.owner, '_account_id') === field(self, '_account_id'),
        headSha: raw.current_revision,
        draft: draftComments.length > 0 ? {
          id: String(number),
          body: '',
          comments: draftComments.map((comment) => ({
            ...(comment.patch_set === currentPatchSet ? reviewCommentAt(comment) : { ...reviewCommentAt(comment), line: null, startLine: null }),
            id: comment.id,
            body: comment.message,
            author: me,
          })),
        } : null,
        threads: [...threads.values()].map(({ root, comments }) => {
          const ordered = comments.sort((left, right) => String(left.updated).localeCompare(String(right.updated)));
          return {
            ...reviewCommentAt(root),
            id: root.id,
            resolved: ordered.at(-1)?.unresolved === false,
            canReply: false,
            canResolve: false,
            comments: ordered.map((comment) => ({
              id: comment.id,
              body: comment.message,
              createdAt: gerritTimestamp(comment.updated) ?? '',
              url: `${origin}/c/${primary.project}/+/${number}/comment/${comment.id}`,
              author: reviewPerson(comment.author),
            })),
          };
        }),
        truncated: false,
      };
    },

    async addReviewComment({ providerTarget, position, body, expectedTarget }: MutationCall & { position: ReturnType<typeof reviewCommentPosition>; body: string }) {
      requireCurrent(await readTarget(providerTarget), expectedTarget.headSha);
      const draft: DraftInput = { path: position.path, message: body };
      if (position.side === 'old') draft.side = 'PARENT';
      if (position.line !== undefined) {
        draft.line = position.line;
        if (position.startLine !== undefined) {
          draft.range = { start_line: position.startLine, start_character: 0, end_line: position.line + 1, end_character: 0 };
        }
      }
      const result = await client.put(`${targetPath(providerTarget)}/revisions/${expectedTarget.headSha}/drafts`, draft);
      if (!plainObject(result) || !isString(result.id)) throw malformed('Gerrit returned an invalid draft comment');
      return {};
    },

    async updateReviewComment({ providerTarget, commentId, body }: Pick<MutationCall, 'providerTarget'> & { commentId: string; body: string }) {
      const draft = await requireDraft(providerTarget, commentId);
      await client.put(`${targetPath(providerTarget)}/revisions/${draft.patch_set}/drafts/${encodeURIComponent(commentId)}`, { message: body });
      return {};
    },

    async deleteReviewComment({ providerTarget, commentId }: Pick<MutationCall, 'providerTarget'> & { commentId: string }) {
      const draft = await requireDraft(providerTarget, commentId);
      await client.delete(`${targetPath(providerTarget)}/revisions/${draft.patch_set}/drafts/${encodeURIComponent(commentId)}`);
      return {};
    },

    async discardReview({ providerTarget }: Pick<MutationCall, 'providerTarget'>) {
      for (const draft of Object.values(await readDrafts(providerTarget)).flat()) {
        if (draft === null) throw new TypeError("Cannot read properties of null (reading 'patch_set')");
        await client.delete(`${targetPath(providerTarget)}/revisions/${field(draft, 'patch_set')}/drafts/${encodeURIComponent(String(field(draft, 'id')))}`);
      }
      return {};
    },

    async comment({ providerTarget, body }: Pick<MutationCall, 'providerTarget'> & { body: string }) {
      const result = await client.post(`${targetPath(providerTarget)}/revisions/current/review`, { message: body });
      if (!isPlainObject(result)) throw malformed('Gerrit returned an invalid review result');
      return {};
    },

    async vote({ providerTarget, votes, body, expectedTarget }: MutationCall & { votes: Record<string, number>; body?: string | undefined }) {
      requireCurrent(await readTarget(providerTarget), expectedTarget.headSha);
      if (Object.keys(votes).length === 0 && body === undefined && !hasDrafts(await readDrafts(providerTarget))) {
        throw Object.assign(new Error('A review with no comments needs text'), { status: 422 });
      }
      const payload: ReviewInput = { labels: votes, drafts: 'PUBLISH_ALL_REVISIONS' };
      if (body !== undefined) payload.message = body;
      const result = await client.post(`${targetPath(providerTarget)}/revisions/${expectedTarget.headSha}/review`, payload);
      if (!plainObject(result)) throw malformed('Gerrit returned an invalid review result');
      if (stringValue(result.error) && result.error) throw Object.assign(new Error(result.error), { status: 400 });
      return { commented: body !== undefined };
    },
  };
}
