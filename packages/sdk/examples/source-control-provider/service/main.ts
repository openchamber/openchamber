// A Git host for OpenChamber, written against a subset of Gitea's REST v1.
// OpenChamber keeps the accounts, tokens, bindings and mutation records; this
// service only turns each forwarded call into forge requests and the forge's
// answers into OpenChamber's DTOs. It never sees a token: every forge request
// goes through OpenChamber's outbound proxy with the call's handle, and
// OpenChamber adds the token and keeps the request on the instance.
import { execFile } from 'node:child_process';
import http from 'node:http';

import {
  SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX,
  SOURCE_CONTROL_PROVIDER_PATH,
  SourceControlForgeError,
  createSourceControlForge,
  readSourceControlProviderRequest,
  type SourceControlJson,
  type SourceControlJsonObject,
  type SourceControlMutationResolution,
  type SourceControlMutationResult,
  type SourceControlMutationTarget,
  type SourceControlOutboundMethod,
  type SourceControlOutboundResponse,
  type SourceControlForgeUser,
  type SourceControlProbeData,
  type SourceControlProjectRef,
  type SourceControlProviderError,
  type SourceControlProviderMethod,
  type SourceControlProviderRequest,
  type SourceControlProviderResult,
  type SourceControlProviderSession,
  type SourceControlReconcileData,
} from '@openchamber/sdk';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !serviceToken) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}
const forge = createSourceControlForge({ env: process.env });

const PAGE_SIZE = 20;
const SCAN_SIZE = 50;
/** How many pages of open pull requests a branch's status looks through. */
const STATUS_SCAN_PAGES = 5;

// The parts of Gitea's JSON this service reads.
type GiteaUser = { id: number; login: string; full_name?: string; email?: string; avatar_url?: string };
type GiteaRepo = {
  id: number; name: string; owner: { login: string }; html_url: string; clone_url?: string; default_branch?: string;
  fork?: boolean; parent?: GiteaRepo | null;
};
type GiteaBranchRef = { ref: string; sha: string; repo_id?: number; repo?: GiteaRepo };
type GiteaIssue = {
  number: number; title: string; body?: string; state: 'open' | 'closed'; html_url: string; user?: GiteaUser;
  created_at?: string; updated_at?: string; pull_request?: object | null;
};
type GiteaPull = GiteaIssue & {
  draft?: boolean; merged?: boolean; mergeable?: boolean; head: GiteaBranchRef; base: GiteaBranchRef;
  /** The commit the pull request's diff is taken against. */
  merge_base?: string;
};
type GiteaChangedFile = { filename: string; status?: string; additions?: number; deletions?: number; changes?: number };
type GiteaComment = { id: number; body: string; html_url?: string; user?: GiteaUser; created_at?: string; updated_at?: string };
type GiteaBranch = { name: string };
type GiteaVersion = { version: string };

/** A failed call, answered as `{ ok: false, error }`. */
class CallError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Call = { session: SourceControlProviderSession; identity: { provider: string; instance: string } };


/** A forge 4xx or 5xx as a `CallError` with that status and the forge's own message when it gave one. */
const forgeFailure = (response: SourceControlOutboundResponse): CallError => {
  let message = `The forge answered ${response.status}`;
  try {
    const parsed: { message?: string } = JSON.parse(response.body);
    if (parsed.message) message = parsed.message;
  } catch {
    // The status says enough.
  }
  return new CallError(message, response.status);
};

/** One forge request through OpenChamber's proxy. A forge 4xx or 5xx becomes a `CallError` with that status. */
const api = async <T,>(
  call: Call,
  method: SourceControlOutboundMethod,
  path: string,
  options: { query?: Record<string, string>; body?: SourceControlJsonObject } = {},
): Promise<{ data: T; total: number | null }> => {
  const response = await forge.request(call.session.handle, {
    method,
    path: `/api/v1${path}`,
    query: options.query,
    headers: options.body ? { accept: 'application/json', 'content-type': 'application/json' } : { accept: 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status >= 400) throw forgeFailure(response);
  const total = response.headers['x-total-count'];
  const data: T = response.body ? JSON.parse(response.body) : null;
  return { data, total: total === undefined ? null : Number(total) };
};

/** A plain-text GET (a diff, a raw file), answered as the forge sent it. */
const apiText = async (call: Call, path: string, query?: Record<string, string>): Promise<string> => {
  const response = await forge.request(call.session.handle, { method: 'GET', path: `/api/v1${path}`, query, headers: { accept: 'text/plain' } });
  if (response.status >= 400) throw forgeFailure(response);
  return response.body;
};

const seg = encodeURIComponent;
const repoPath = (repo: { owner: string; name: string }) => `/repos/${seg(repo.owner)}/${seg(repo.name)}`;

// ---------------------------------------------------------------------------
// Which repository a working directory's remote names on the instance.

const remoteUrl = (directory: string, remote: string): Promise<string> => new Promise((resolve, reject) => {
  execFile('git', ['-C', directory, 'remote', 'get-url', '--', remote], { timeout: 5_000 }, (error, stdout) => {
    if (error) reject(new CallError(`The remote "${remote}" could not be read`, 404, 'REMOTE_NOT_FOUND'));
    else resolve(stdout.trim());
  });
});

/** `owner/name` of a remote URL on the instance (HTTPS, loopback HTTP, or SSH on the same host), or null. */
const repositoryOfRemote = (raw: string, instance: string): { owner: string; name: string } | null => {
  const origin = new URL(instance);
  let host: string;
  let path: string;
  const scp = raw.includes('://') ? null : raw.match(/^(?:[^@\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (scp) {
    host = scp[1].toLowerCase();
    path = scp[2];
    if (host !== origin.hostname.toLowerCase()) return null;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return null;
    }
    const web = url.protocol === 'https:' || url.protocol === 'http:';
    if (web && url.host.toLowerCase() !== origin.host.toLowerCase()) return null;
    if (!web && url.hostname.toLowerCase() !== origin.hostname.toLowerCase()) return null;
    path = decodeURIComponent(url.pathname);
  }
  const segments = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) return null;
  return { owner: segments[0], name: segments[1] };
};

type Identity = { provider: string; instance: string };
type Project = Identity & {
  id: string; owner: string; name: string; url: string;
  cloneUrl?: string; defaultBranch?: string; remoteName?: string | null;
};
type User = Identity & { id: string; username: string; name?: string; avatarUrl?: string };
type Dated = { createdAt?: string; updatedAt?: string };
type Issue = Identity & Dated & {
  id: string; number: number; project: Project; title: string; body?: string; url: string;
  state: 'open' | 'closed'; author: User | null; labels: [];
};
type ChangeRequest = Identity & Dated & {
  id: string; number: number; project: Project; title: string; body?: string; url: string;
  state: 'open' | 'closed' | 'merged'; draft: boolean; base: string; head: string; headSha: string;
  author: User | null; labels: []; mergeable?: boolean; mergeableState?: 'clean' | 'dirty';
};
type Comment = Identity & Dated & { id: string; url: string; body: string; author: User | null };
type ChangedFile = {
  path: string; status: 'added' | 'removed' | 'renamed' | 'modified';
  additions?: number; deletions?: number; changes?: number; patch?: string;
};
type ChangeRequestStatus = {
  identity: Identity; project: Project; branch: string; changeRequest: ChangeRequest | null; ci: null;
  canMerge?: boolean; resolvedRemoteName: string | null; defaultBranch: string | null;
};

const mapProject = (call: Call, raw: GiteaRepo, remoteName?: string): Project => {
  const project: Project = { ...call.identity, id: String(raw.id), owner: raw.owner.login, name: raw.name, url: raw.html_url };
  if (raw.clone_url) project.cloneUrl = raw.clone_url;
  if (raw.default_branch) project.defaultBranch = raw.default_branch;
  if (remoteName !== undefined) project.remoteName = remoteName;
  return project;
};

const compact = (project: Project): SourceControlProjectRef => ({ id: project.id, owner: project.owner, name: project.name });

/** The repository `remote` of `directory` names, or the one `selector` names. */
const resolveRepo = async (
  call: Call,
  directory: string,
  remote: string,
  selector?: { owner: string; name: string },
): Promise<{ raw: GiteaRepo; project: Project }> => {
  const named = selector ?? repositoryOfRemote(await remoteUrl(directory, remote), call.session.instance);
  if (!named) throw new CallError(`The remote "${remote}" is not a repository on ${call.session.instance}`, 404, 'REMOTE_NOT_ON_INSTANCE');
  const { data } = await api<GiteaRepo>(call, 'GET', repoPath(named));
  return { raw: data, project: mapProject(call, data, selector ? undefined : remote) };
};

// ---------------------------------------------------------------------------
// Gitea JSON to OpenChamber DTOs (`packages/ui/src/lib/source-control/types.ts`).

const WIP = /^\s*(?:wip:|\[wip\])\s*/i;

const mapUser = (call: Call, raw: GiteaUser | undefined): User | null => {
  if (!raw) return null;
  const user: User = { ...call.identity, id: String(raw.id), username: raw.login };
  if (raw.full_name) user.name = raw.full_name;
  if (raw.avatar_url) user.avatarUrl = raw.avatar_url;
  return user;
};

const stamp = (target: Dated, raw: { created_at?: string; updated_at?: string }): void => {
  if (raw.created_at) target.createdAt = raw.created_at;
  if (raw.updated_at) target.updatedAt = raw.updated_at;
};

const pullState = (raw: GiteaPull): 'open' | 'closed' | 'merged' => (raw.merged ? 'merged' : raw.state);

const mapPull = (call: Call, raw: GiteaPull, project: Project): ChangeRequest => {
  const request: ChangeRequest = {
    ...call.identity,
    id: `${project.id}#${raw.number}`,
    number: raw.number,
    project,
    title: raw.title,
    url: raw.html_url,
    state: pullState(raw),
    draft: raw.draft === true || WIP.test(raw.title),
    base: raw.base.ref,
    head: raw.head.ref,
    headSha: raw.head.sha,
    author: mapUser(call, raw.user),
    labels: [],
  };
  if (raw.body !== undefined) request.body = raw.body;
  stamp(request, raw);
  if (request.state === 'open' && raw.mergeable !== undefined) {
    request.mergeable = raw.mergeable;
    request.mergeableState = raw.mergeable ? 'clean' : 'dirty';
  }
  return request;
};

const mapIssue = (call: Call, raw: GiteaIssue, project: Project): Issue => {
  const issue: Issue = {
    ...call.identity,
    id: `${project.id}#${raw.number}`,
    number: raw.number,
    project,
    title: raw.title,
    url: raw.html_url,
    state: raw.state,
    author: mapUser(call, raw.user),
    labels: [],
  };
  if (raw.body !== undefined) issue.body = raw.body;
  stamp(issue, raw);
  return issue;
};

const mapComment = (call: Call, raw: GiteaComment, fallbackUrl: string): Comment => {
  const comment: Comment = {
    ...call.identity, id: String(raw.id), url: raw.html_url ?? fallbackUrl, body: raw.body, author: mapUser(call, raw.user),
  };
  stamp(comment, raw);
  return comment;
};

const FILE_STATUSES = new Map<string, ChangedFile['status']>([['added', 'added'], ['deleted', 'removed'], ['removed', 'removed'], ['renamed', 'renamed']]);

const mapChangedFile = (raw: GiteaChangedFile): ChangedFile => {
  const file: ChangedFile = { path: raw.filename, status: FILE_STATUSES.get(raw.status ?? '') ?? 'modified' };
  if (raw.additions !== undefined) file.additions = raw.additions;
  if (raw.deletions !== undefined) file.deletions = raw.deletions;
  if (raw.changes !== undefined) file.changes = raw.changes;
  return file;
};

/**
 * A unified diff split per file, keyed by the file's new path (its old path
 * for a deletion), each part keeping its own `diff --git` header: the same
 * split OpenChamber's built-in Gitea host makes.
 */
const splitUnifiedDiff = (diff: string): Map<string, string> => {
  const parts = new Map<string, string>();
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
};

const listState = (state: string): string => {
  if (state === 'closed' || state === 'merged') return 'closed';
  return state === 'all' ? 'all' : 'open';
};
const pageQuery = (page: number, state: string) => ({ state: listState(state), page: String(page), limit: String(PAGE_SIZE) });
const hasMore = (page: number, count: number, total: number | null) => (total === null ? count === PAGE_SIZE : page * PAGE_SIZE < total);

// ---------------------------------------------------------------------------
// The forwarded methods. Each `input` is what OpenChamber validated and sent.

type Input = SourceControlJsonObject;
const text = (input: Input, key: string): string => {
  const value = input[key];
  return String(value) === value ? value : '';
};
const integer = (input: Input, key: string): number => {
  const value = input[key];
  return Number.isSafeInteger(value) ? Number(value) : 0;
};
const selectorOf = (input: Input, key: string): { owner: string; name: string } | undefined => {
  const value = input[key];
  if (Object(value) !== value || Array.isArray(value) || value === null) return undefined;
  const object: Input = Object(value);
  const owner = text(object, 'owner');
  const name = text(object, 'name') || text(object, 'repo');
  return owner && name ? { owner, name } : undefined;
};
const objectOf = (input: Input, key: string): Input => {
  const value = input[key];
  return Object(value) === value && !Array.isArray(value) && value !== null ? Object(value) : {};
};

const readPull = async (call: Call, repo: { owner: string; name: string }, number: number) => (
  (await api<GiteaPull>(call, 'GET', `${repoPath(repo)}/pulls/${number}`)).data
);

/**
 * The repository a patch or file read targets: the bound remote's, or
 * `sourceRepo` when it names that repository or the one it was forked from.
 * Anything else is outside the bound network and is refused.
 */
const changeRequestRepo = async (call: Call, input: Input): Promise<Project> => {
  const { raw, project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'));
  const source = objectOf(input, 'sourceRepo');
  const owner = text(source, 'owner').toLowerCase();
  const name = text(source, 'repo').toLowerCase();
  const names = (repo: GiteaRepo) => repo.owner.login.toLowerCase() === owner && repo.name.toLowerCase() === name;
  if (!owner || !name || names(raw)) return project;
  if (raw.fork && raw.parent && names(raw.parent)) return mapProject(call, raw.parent);
  throw new CallError(`${owner}/${name} is not in this project's repository network`, 404, 'NOT_IN_NETWORK');
};

/** `/raw/{path}` with each segment encoded; a path that could climb out of the repository is refused. */
const rawPath = (repo: { owner: string; name: string }, filePath: string): string => {
  const segments = filePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw new CallError(`"${filePath}" is not a file path`, 400);
  return `${repoPath(repo)}/raw/${segments.map(seg).join('/')}`;
};

/** How many pages of changed files a pull request's context reads before it says the list is too long. */
const FILE_SCAN_PAGES = 10;

/** Every changed file of a pull request; a list longer than the scan fails rather than answering part of it. */
const readChangedFiles = async (call: Call, repo: string, number: number): Promise<GiteaChangedFile[]> => {
  const files: GiteaChangedFile[] = [];
  for (let page = 1; page <= FILE_SCAN_PAGES; page += 1) {
    const { data, total } = await api<GiteaChangedFile[]>(call, 'GET', `${repo}/pulls/${number}/files`, {
      query: { page: String(page), limit: String(SCAN_SIZE) },
    });
    files.push(...data);
    if (data.length < SCAN_SIZE || (total !== null && files.length >= total)) return files;
  }
  throw new CallError(`The pull request changes more files than this Git host reads (${FILE_SCAN_PAGES * SCAN_SIZE})`, 502, 'SCAN_LIMIT');
};

const COMMIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

const branchRepoId = (ref: GiteaBranchRef): number | undefined => ref.repo_id ?? ref.repo?.id;

/**
 * The pull request of `branch` in `repo`: an open one, else the newest of the
 * recently closed ones, so a merged branch shows its history instead of
 * offering to open a pull request again.
 */
const findBranchPull = async (call: Call, repo: GiteaRepo, branch: string): Promise<GiteaPull | null> => {
  const matches = (pull: GiteaPull) => pull.head.ref === branch && branchRepoId(pull.head) === repo.id;
  const pulls = `${repoPath({ owner: repo.owner.login, name: repo.name })}/pulls`;
  for (let page = 1; page <= STATUS_SCAN_PAGES; page += 1) {
    const { data, total } = await api<GiteaPull[]>(call, 'GET', pulls, {
      query: { state: 'open', sort: 'recentupdate', page: String(page), limit: String(SCAN_SIZE) },
    });
    const open = data.find(matches);
    if (open) return open;
    if (total === null ? data.length === SCAN_SIZE : page * SCAN_SIZE < total) continue;
    const { data: closed } = await api<GiteaPull[]>(call, 'GET', pulls, {
      query: { state: 'closed', sort: 'recentupdate', page: '1', limit: String(SCAN_SIZE) },
    });
    return closed.filter(matches).reduce<GiteaPull | null>((newest, pull) => (!newest || pull.number > newest.number ? pull : newest), null);
  }
  // Answering "no pull request" here could be wrong, so say the scan stopped.
  throw new CallError(`The repository has more open pull requests than this Git host scans (${STATUS_SCAN_PAGES * SCAN_SIZE})`, 502, 'SCAN_LIMIT');
};

type Handler = (call: Call, input: Input, request: SourceControlProviderRequest) => Promise<SourceControlJson>;

const unsupported: Handler = async (_call, _input, request) => {
  throw new CallError(`${request.method} is not something this Git host offers`, 501, 'UNSUPPORTED');
};

const handlers = {
  'auth.verify': async (call) => {
    const { data } = await api<GiteaUser>(call, 'GET', '/user');
    const user: SourceControlForgeUser = { id: data.id, login: data.login };
    if (data.full_name) user.name = data.full_name;
    if (data.email) user.email = data.email;
    if (data.avatar_url) user.avatarUrl = data.avatar_url;
    return { user };
  },

  'auth.probe': async (call): Promise<SourceControlProbeData> => {
    try {
      const { data } = await api<GiteaVersion>(call, 'GET', '/version');
      return { supported: true, version: data.version };
    } catch (error) {
      if (error instanceof CallError && error.status === 404) return { supported: false, message: 'This server does not answer /api/v1/version.' };
      throw error;
    }
  },

  changeRequestStatus: async (call, input) => {
    const { raw, project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'));
    const branch = text(input, 'branch');
    const found = await findBranchPull(call, raw, branch);
    const status: ChangeRequestStatus = {
      identity: call.identity,
      project,
      branch,
      changeRequest: found ? mapPull(call, found, project) : null,
      ci: null,
      resolvedRemoteName: text(input, 'remote') || null,
      defaultBranch: raw.default_branch ?? null,
    };
    if (found) status.canMerge = pullState(found) === 'open' && found.mergeable === true;
    return status;
  },

  listChangeRequests: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'));
    const page = integer(input, 'page') || 1;
    const state = text(input, 'state');
    const { data, total } = await api<GiteaPull[]>(call, 'GET', `${repoPath(project)}/pulls`, { query: pageQuery(page, state) });
    const items = data.filter((pull) => state !== 'merged' || pull.merged).map((pull) => mapPull(call, pull, project));
    return { items, page, hasMore: hasMore(page, data.length, total) };
  },

  changeRequestContext: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'), selectorOf(input, 'project'));
    const number = integer(input, 'number');
    const repo = repoPath(project);
    const includeDiff = input.includeDiff === true;
    const [raw, { data: comments }, diff, changed] = await Promise.all([
      readPull(call, project, number),
      api<GiteaComment[]>(call, 'GET', `${repo}/issues/${number}/comments`),
      includeDiff ? apiText(call, `${repo}/pulls/${number}.diff`) : Promise.resolve(''),
      includeDiff ? readChangedFiles(call, repo, number) : Promise.resolve([]),
    ]);
    const pull = mapPull(call, raw, project);
    const patches = splitUnifiedDiff(diff);
    const files = changed.map((file) => {
      const mapped = mapChangedFile(file);
      const patch = patches.get(mapped.path);
      if (patch) mapped.patch = patch;
      return mapped;
    });
    return {
      identity: call.identity,
      project,
      changeRequest: pull,
      issueComments: comments.map((comment) => mapComment(call, comment, pull.url)),
      reviewComments: [],
      files,
      diff,
      ci: null,
    };
  },

  listIssues: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'));
    const page = integer(input, 'page') || 1;
    const { data, total } = await api<GiteaIssue[]>(call, 'GET', `${repoPath(project)}/issues`, {
      query: { ...pageQuery(page, text(input, 'state')), type: 'issues' },
    });
    const items = data.filter((issue) => !issue.pull_request).map((issue) => mapIssue(call, issue, project));
    return { items, page, hasMore: hasMore(page, data.length, total) };
  },

  getIssue: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'), selectorOf(input, 'project'));
    const { data } = await api<GiteaIssue>(call, 'GET', `${repoPath(project)}/issues/${integer(input, 'number')}`);
    if (data.pull_request) throw new CallError(`#${data.number} is a pull request`, 404);
    return mapIssue(call, data, project);
  },

  issueComments: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'), selectorOf(input, 'project'));
    const number = integer(input, 'number');
    const { data: issue } = await api<GiteaIssue>(call, 'GET', `${repoPath(project)}/issues/${number}`);
    const { data } = await api<GiteaComment[]>(call, 'GET', `${repoPath(project)}/issues/${number}/comments`);
    return data.map((comment) => mapComment(call, comment, issue.html_url));
  },

  projectUpstream: async (call, input) => {
    const { raw } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'));
    const parent = raw.fork && raw.parent ? mapProject(call, raw.parent) : null;
    return { identity: call.identity, isFork: Boolean(parent), upstream: parent };
  },

  projectBranches: async (call, input) => {
    const selector = selectorOf(input, 'project');
    if (!selector) throw new CallError('project is required', 400);
    const { data } = await api<GiteaBranch[]>(call, 'GET', `${repoPath(selector)}/branches`, { query: { limit: String(SCAN_SIZE) } });
    return data.map((branch) => branch.name);
  },

  // Off in the manifest's capabilities, so OpenChamber never routes them here.
  listLabels: unsupported,
  listReviewerCandidates: unsupported,

  /** The pull request's changes as one unified diff, for the comparison view and walkthroughs. */
  readChangeRequestPatch: async (call, input) => {
    const project = await changeRequestRepo(call, input);
    const number = integer(input, 'number');
    const patch = await apiText(call, `${repoPath(project)}/pulls/${number}.diff`);
    return { patch, meta: { owner: project.owner, repo: project.name, number } };
  },

  /**
   * Both sides of one file: the merge base the diff was taken against and
   * the head commit. Gitea keeps a fork pull request's head in the target
   * repository too, so both reads go there.
   */
  readChangeRequestFile: async (call, input) => {
    const project = await changeRequestRepo(call, input);
    const pull = await readPull(call, project, integer(input, 'number'));
    const baseSha = pull.merge_base ?? '';
    const headSha = pull.head.sha;
    if (!COMMIT_SHA.test(baseSha) || !COMMIT_SHA.test(headSha)) throw new CallError('The forge returned invalid pull request refs', 502);
    const path = text(input, 'path');
    const status = text(input, 'status');
    const [original, modified] = await Promise.all([
      status === 'A' ? '' : apiText(call, rawPath(project, text(input, 'previousPath') || path), { ref: baseSha }),
      status === 'D' ? '' : apiText(call, rawPath(project, path), { ref: headSha }),
    ]);
    return { original, modified };
  },

  /** Pull requests and issues the user tracks. One the forge cannot answer is left out (unknown, not closed); a 401 fails the batch. */
  liveSummaries: async (call, input) => {
    const refsOf = (key: string) => {
      const value = input[key];
      return (Array.isArray(value) ? value : []).flatMap((ref) => {
        if (Object(ref) !== ref || Array.isArray(ref) || ref === null) return [];
        const object: Input = Object(ref);
        const owner = text(object, 'owner');
        const repo = text(object, 'repo');
        const number = integer(object, 'number');
        return owner && repo && number ? [{ owner, repo, number }] : [];
      });
    };
    const skipUnknown = async <T,>(task: () => Promise<T>): Promise<T | null> => {
      try {
        return await task();
      } catch (error) {
        if (error instanceof CallError && error.status === 401) throw error;
        return null;
      }
    };
    const summaries = await Promise.all(refsOf('refs').map((ref) => skipUnknown(async () => {
      const pull = await readPull(call, { owner: ref.owner, name: ref.repo }, ref.number);
      const state = pullState(pull);
      return {
        owner: ref.owner, repo: ref.repo, number: pull.number, state,
        draft: pull.draft === true || WIP.test(pull.title), title: pull.title,
        mergeable: state === 'open' && pull.mergeable !== undefined ? pull.mergeable : null,
        mergeableState: state === 'open' && pull.mergeable !== undefined ? (pull.mergeable ? 'clean' : 'dirty') : null,
        checks: null,
        headSha: pull.head.sha,
        base: pull.base.ref,
      };
    })));
    const issueSummaries = await Promise.all(refsOf('issueRefs').map((ref) => skipUnknown(async () => {
      const { data } = await api<GiteaIssue>(call, 'GET', `${repoPath({ owner: ref.owner, name: ref.repo })}/issues/${ref.number}`);
      return { owner: ref.owner, repo: ref.repo, number: data.number, title: data.title, state: data.state === 'open' ? 'open' : 'completed' };
    })));
    return { summaries: summaries.filter((item) => item !== null), issueSummaries: issueSummaries.filter((item) => item !== null) };
  },

  readChangeRequestHead: async (call, input) => {
    const { project } = await resolveRepo(call, text(input, 'directory'), text(input, 'remote'));
    const pull = await readPull(call, project, integer(input, 'number'));
    return { project: compact(project), headSha: pull.head.sha.toLowerCase(), headBranch: pull.head.ref, headOwner: pull.head.repo?.owner.login ?? project.owner };
  },

  /** Where the head of a pull request lives, for a worktree made from it; OpenChamber re-checks the endpoint and sha. */
  resolveChangeRequestSource: async (call, input) => {
    const target = selectorOf(input, 'project');
    if (!target) throw new CallError('project is required', 400);
    const pull = await readPull(call, target, integer(input, 'number'));
    const expected = text(input, 'expectedHeadSha').toLowerCase();
    if (pull.head.sha.toLowerCase() !== expected) throw new CallError('The pull request head changed', 409, 'SOURCE_CONTROL_CHANGE_REQUEST_STALE');
    const targetProject = mapProject(call, pull.base.repo ?? (await api<GiteaRepo>(call, 'GET', repoPath(target))).data);
    const headProject = pull.head.repo ? mapProject(call, pull.head.repo) : targetProject;
    return {
      sourceProject: compact(headProject),
      targetProject: compact(targetProject),
      classification: headProject.id === targetProject.id ? 'same-repository' : 'contributor-fork',
      headSha: expected,
      headRef: `refs/heads/${pull.head.ref}`,
      endpoint: headProject.cloneUrl ?? `${headProject.url}.git`,
    };
  },

  'mutation.resolveTarget': async (call, input) => resolveTarget(call, input),
  'mutation.perform': async (call, input) => perform(call, input),
  'mutation.reconcile': async (call, input) => reconcile(call, input),
} satisfies Record<SourceControlProviderMethod, Handler>;

// ---------------------------------------------------------------------------
// Mutations. OpenChamber owns the kind, the normalized input, the digest and
// the idempotency record; the service resolves what to write to, writes once,
// and after a restart says whether an earlier write landed.

/**
 * What a write acts on. `sourceRepoId` and `sourceOwner` are set for a create:
 * the repository the head branch lives in, the target itself or a fork of it.
 */
type ProviderTarget = { repoId: number; owner: string; name: string; number?: number; sourceRepoId?: number; sourceOwner?: string };

const TARGET_KEYS = ['number', 'head', 'base', 'headSha'] as const;

const mutationTarget = (
  context: Input,
  project: Project,
  fields: Partial<Pick<SourceControlMutationTarget, (typeof TARGET_KEYS)[number]>>,
): SourceControlMutationTarget => {
  const target: SourceControlMutationTarget = {
    repositoryId: text(context, 'repositoryId'),
    bindingRevision: integer(context, 'bindingRevision'),
    primaryRemote: text(context, 'primaryRemote'),
    project: compact(project),
  };
  for (const key of TARGET_KEYS) {
    const value = fields[key];
    if (value === undefined) continue;
    if (key === 'number') target.number = Number(value);
    else target[key] = String(value);
  }
  return target;
};

const asJson = (resolution: SourceControlMutationResolution): SourceControlJsonObject => ({
  providerTarget: resolution.providerTarget,
  // The target is plain JSON by construction.
  target: { ...resolution.target, project: { ...resolution.target.project } },
});

/**
 * The repository a new pull request's head branch lives in. The pull request
 * always opens on the primary remote's repository; the head may come from
 * another remote only when that remote is a fork of it on this forge.
 */
const resolveHeadSource = async (call: Call, directory: string, primaryRemote: string, target: GiteaRepo, normalized: Input): Promise<GiteaRepo> => {
  const remote = text(normalized, 'remote');
  if (remote && remote !== primaryRemote) {
    throw new CallError(`Pull requests open on the bound remote "${primaryRemote}", not "${remote}"`, 409, 'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH');
  }
  const headRemote = text(normalized, 'headRemote');
  if (!headRemote || headRemote === primaryRemote) return target;
  const { raw: head } = await resolveRepo(call, directory, headRemote);
  if (head.id !== target.id && head.parent?.id !== target.id) {
    throw new CallError(
      `The remote "${headRemote}" is neither ${target.owner.login}/${target.name} nor a fork of it on this forge`,
      409,
      'SOURCE_CONTROL_MUTATION_REMOTE_MISMATCH',
    );
  }
  return head;
};

const resolveTarget = async (call: Call, input: Input): Promise<SourceControlJson> => {
  const context = objectOf(input, 'context');
  const expected = objectOf(context, 'target');
  const kind = text(input, 'kind');
  const replayOf = objectOf(input, 'replayOf');
  const primaryRemote = text(context, 'primaryRemote');
  const { raw, project } = await resolveRepo(call, text(context, 'directory'), primaryRemote);
  const providerTarget: ProviderTarget = { repoId: raw.id, owner: project.owner, name: project.name };
  if (kind === 'change-request-create') {
    const source = await resolveHeadSource(call, text(context, 'directory'), primaryRemote, raw, objectOf(input, 'input'));
    return asJson({
      providerTarget: { ...providerTarget, sourceRepoId: source.id, sourceOwner: source.owner.login },
      target: mutationTarget(context, project, { head: text(expected, 'head'), base: text(expected, 'base') }),
    });
  }
  // A replay acts on exactly what the first attempt resolved.
  const replayTarget = objectOf(replayOf, 'target');
  const number = integer(replayTarget, 'number') || integer(expected, 'number');
  if (!number) throw new CallError('target number is required', 400, 'INVALID_SOURCE_CONTROL_MUTATION_CONTEXT');
  if (Object.keys(replayTarget).length > 0) {
    return { providerTarget: { ...providerTarget, number }, target: replayTarget };
  }
  if (kind.startsWith('issue-')) {
    const { data } = await api<GiteaIssue>(call, 'GET', `${repoPath(project)}/issues/${number}`);
    return asJson({ providerTarget: { ...providerTarget, number }, target: mutationTarget(context, project, { number: data.number }) });
  }
  const pull = await readPull(call, project, number);
  for (const [key, actual] of [['head', pull.head.ref], ['base', pull.base.ref], ['headSha', pull.head.sha]] as const) {
    const wanted = text(expected, key);
    if (wanted && wanted !== actual) throw new CallError(`The pull request ${key} changed`, 409, 'SOURCE_CONTROL_MUTATION_TARGET_MISMATCH');
  }
  return asJson({
    providerTarget: { ...providerTarget, number },
    target: mutationTarget(context, project, { number, head: pull.head.ref, base: pull.base.ref, headSha: pull.head.sha }),
  });
};

type Resolved = { providerTarget: ProviderTarget; target: Input };

const readResolved = (input: Input): Resolved => {
  const resolved = objectOf(input, 'resolved');
  const providerTarget = objectOf(resolved, 'providerTarget');
  return {
    providerTarget: {
      repoId: integer(providerTarget, 'repoId'),
      owner: text(providerTarget, 'owner'),
      name: text(providerTarget, 'name'),
      number: integer(providerTarget, 'number') || undefined,
      sourceRepoId: integer(providerTarget, 'sourceRepoId') || undefined,
      sourceOwner: text(providerTarget, 'sourceOwner') || undefined,
    },
    target: objectOf(resolved, 'target'),
  };
};

const perform = async (call: Call, input: Input): Promise<SourceControlMutationResult> => {
  const kind = text(input, 'kind');
  const normalized = objectOf(input, 'input');
  const { providerTarget, target } = readResolved(input);
  const repo = repoPath(providerTarget);
  switch (kind) {
    case 'change-request-create': {
      // A branch of a fork is named `owner:branch`; Gitea would read a bare name as the target's own branch.
      const sourceRepoId = providerTarget.sourceRepoId ?? providerTarget.repoId;
      const fork = sourceRepoId !== providerTarget.repoId;
      const head = text(target, 'head');
      const payload: SourceControlJsonObject = {
        head: fork ? `${providerTarget.sourceOwner}:${head}` : head, base: text(target, 'base'), title: text(normalized, 'title'),
      };
      const body = text(normalized, 'body');
      if (body) payload.body = body;
      const { data } = await api<GiteaPull>(call, 'POST', `${repo}/pulls`, { body: payload });
      if (branchRepoId(data.base) !== providerTarget.repoId || branchRepoId(data.head) !== sourceRepoId) {
        throw new CallError('The forge opened the pull request somewhere other than asked', 502);
      }
      return { number: data.number };
    }
    case 'change-request-update': {
      const payload: SourceControlJsonObject = { title: text(normalized, 'title') };
      if (Object.hasOwn(normalized, 'body')) payload.body = text(normalized, 'body');
      await api(call, 'PATCH', `${repo}/pulls/${providerTarget.number}`, { body: payload });
      return {};
    }
    case 'change-request-merge': {
      // `head_commit_id` makes the forge refuse once the branch moved past the head the user saw.
      const payload: SourceControlJsonObject = { Do: text(normalized, 'method') || 'merge' };
      const headSha = text(target, 'headSha');
      if (headSha) payload.head_commit_id = headSha;
      await api(call, 'POST', `${repo}/pulls/${providerTarget.number}/merge`, { body: payload });
      const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
      return { merged: pull.merged === true };
    }
    case 'change-request-comment':
    case 'issue-comment':
      await api(call, 'POST', `${repo}/issues/${providerTarget.number}/comments`, { body: { body: text(normalized, 'body') } });
      return {};
    case 'change-request-state':
    case 'issue-state': {
      const state = text(normalized, 'state');
      const { data } = await api<GiteaIssue>(call, 'PATCH', `${repo}/issues/${providerTarget.number}`, { body: { state } });
      if (data.state !== state) throw new CallError('The forge did not change the state', 502);
      return { state };
    }
    default:
      throw new CallError(`${kind} is not something this Git host offers`, 501, 'UNSUPPORTED');
  }
};

const NOT_APPLIED: SourceControlReconcileData = { state: 'failed', result: { failureStatus: 409, failureCode: 'SOURCE_CONTROL_MUTATION_NOT_APPLIED' } };

/** After a restart: did the write OpenChamber recorded as running land? Only a certain answer is `succeeded` or `failed`. */
const reconcile = async (call: Call, input: Input): Promise<SourceControlReconcileData> => {
  const kind = text(input, 'kind');
  const normalized = objectOf(input, 'input');
  const { providerTarget, target } = readResolved(input);
  const repo = repoPath(providerTarget);
  switch (kind) {
    case 'change-request-create': {
      const sourceRepoId = providerTarget.sourceRepoId ?? providerTarget.repoId;
      const { data } = await api<GiteaPull[]>(call, 'GET', `${repo}/pulls`, { query: { state: 'all', sort: 'recentupdate', limit: String(SCAN_SIZE) } });
      const matches = data.filter((pull) => pull.head.ref === text(target, 'head') && pull.base.ref === text(target, 'base')
        && branchRepoId(pull.head) === sourceRepoId && branchRepoId(pull.base) === providerTarget.repoId);
      return matches.length === 1 ? { state: 'succeeded', result: { number: matches[0].number } } : { state: 'outcome-unknown' };
    }
    case 'change-request-update': {
      // The forge shows the edit, or it shows something else: an edit of its own since, or the write never landed.
      const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
      const landed = pull.title === text(normalized, 'title') && (!Object.hasOwn(normalized, 'body') || (pull.body ?? '') === text(normalized, 'body'));
      return landed ? { state: 'succeeded', result: {} } : { state: 'outcome-unknown' };
    }
    case 'change-request-merge': {
      const pull = await readPull(call, providerTarget, providerTarget.number ?? 0);
      return pull.merged ? { state: 'succeeded', result: { merged: true } } : NOT_APPLIED;
    }
    case 'change-request-state':
    case 'issue-state': {
      const { data } = await api<GiteaIssue>(call, 'GET', `${repo}/issues/${providerTarget.number}`);
      return data.state === text(normalized, 'state') ? { state: 'succeeded', result: { state: data.state } } : NOT_APPLIED;
    }
    // A comment leaves nothing that tells a lost write from one never sent.
    default:
      return { state: 'outcome-unknown' };
  }
};

// ---------------------------------------------------------------------------
// The loopback server OpenChamber talks to.

const failureOf = (error: Error): SourceControlProviderError => {
  const message = error.message.slice(0, SOURCE_CONTROL_PROVIDER_ERROR_MESSAGE_MAX) || 'Unexpected failure';
  if (error instanceof SourceControlForgeError) return { message, status: 502, code: 'FORGE_UNREACHABLE' };
  if (!(error instanceof CallError)) return { message, status: 500 };
  const failure: SourceControlProviderError = { message, status: error.status };
  if (error.code) failure.code = error.code;
  return failure;
};

const answer = async (request: SourceControlProviderRequest): Promise<SourceControlProviderResult> => {
  if (!request.session) return { ok: false, error: { message: 'Every call to this Git host needs a session', status: 400 } };
  const call: Call = { session: request.session, identity: { provider: request.provider, instance: request.session.instance } };
  try {
    return { ok: true, data: await handlers[request.method](call, request.input, request) };
  } catch (error) {
    return { ok: false, error: failureOf(error instanceof Error ? error : new Error(String(error))) };
  }
};

const send = (response: http.ServerResponse, status: number, body: SourceControlProviderResult | { error: string } | { ok: true }) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

const server = http.createServer((request, response) => {
  if (request.headers.authorization !== `Bearer ${serviceToken}`) {
    send(response, 401, { error: 'unauthorized' });
    return;
  }
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (request.method === 'GET' && path === '/health') {
    send(response, 200, { ok: true });
    return;
  }
  if (request.method !== 'POST' || path !== SOURCE_CONTROL_PROVIDER_PATH) {
    send(response, 404, { error: 'not found' });
    return;
  }
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const call = readSourceControlProviderRequest(Buffer.concat(chunks).toString('utf8'));
    if (!call) {
      send(response, 400, { error: 'not a source-control call' });
      return;
    }
    answer(call).then((result) => send(response, 200, result), () => send(response, 500, { error: 'unexpected failure' }));
  });
});

server.listen(port, '127.0.0.1');
