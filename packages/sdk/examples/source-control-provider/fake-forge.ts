// A tiny in-memory forge that speaks the subset of Gitea's REST v1 the
// example service uses: one repository (`mona/teapot`), its pull requests,
// issues and comments, the files at a few commits (so a pull request has a
// diff and both sides of a changed file), plus a fork of it (`octo/teapot`) and an unrelated
// repository (`mona/kettle`) that answer only for themselves and their
// branches. Tests start it on a loopback port, point the example
// at it, and read the write log to prove a mutation reached the forge once.
// It is a test double for the contract, not a Gitea emulator.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_FORGE_OWNER = 'mona';
export const FAKE_FORGE_REPO = 'teapot';
export const FAKE_FORGE_USER = { id: 7, login: FAKE_FORGE_OWNER, full_name: 'Mona Teapot', email: 'mona@example.com' };
/** A fork of `mona/teapot` with one branch of its own, `fork-feature`. */
export const FAKE_FORGE_FORK = { owner: 'octo', name: 'teapot' };
/** A repository on the same forge that is not part of `mona/teapot`'s network. */
export const FAKE_FORGE_STRANGER = { owner: 'mona', name: 'kettle' };

type ForgeComment = { id: number; body: string; created_at: string };
type ForgeItem = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  comments: ForgeComment[];
  /** `headRepo` is the id of the repository the head branch lives in. */
  pull: null | { head: string; headRepo: number; base: string; sha: string; merged: boolean };
};

export type FakeForgeWrite = { method: string; path: string };

export type FakeForge = {
  /** `http://127.0.0.1:<port>`: the instance origin. */
  origin: string;
  /** Every POST, PUT, PATCH and DELETE the forge accepted, in order. */
  writes: FakeForgeWrite[];
  /** Answer 401 to every request made with this token. */
  refuseToken(token: string): void;
  /** Point a branch at a new commit, as a push would. */
  push(branch: string, sha: string): void;
  close(): Promise<void>;
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
/** Every branch here starts from `main`'s first commit, so that is every pull request's merge base. */
const MERGE_BASE = SHA_A;

type Tree = ReadonlyMap<string, string>;
/** The files at `main` (`SHA_A`). A commit without its own tree has these. */
const MAIN_TREE: Tree = new Map([['README.md', 'Steep for two minutes.\n'], ['kettle.txt', 'Whistle at 100°C.\n']]);
/** `feature` (`SHA_B`), the head of pull request #2: one file changed. */
const FEATURE_TREE: Tree = new Map([...MAIN_TREE, ['README.md', 'Steep for three minutes.\nThen pour.\n']]);

const linesOf = (content: string) => (content ? content.replace(/\n$/, '').split('\n') : []);

/**
 * One modified file's `diff --git` part, the whole file as one hunk: enough
 * for a reader that splits by file. Trees here only ever modify files.
 */
const fileDiff = (path: string, before: string, after: string): string => {
  const old = linesOf(before);
  const next = linesOf(after);
  return [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${old.length} +1,${next.length} @@`,
    ...old.map((line) => `-${line}`), ...next.map((line) => `+${line}`),
  ].join('\n') + '\n';
};

/** The files `head` changed from `base`, in path order. */
const changedPaths = (base: Tree, head: Tree) => [...head.keys()].sort().filter((path) => base.get(path) !== head.get(path));

type RequestBody = { [key: string]: string | number | boolean | null | undefined };

const readBody = async (request: http.IncomingMessage): Promise<RequestBody> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  const parsed: RequestBody = JSON.parse(text);
  return parsed;
};

const textOf = (value: RequestBody[string]): string => (String(value) === value ? value : '');

export const startFakeForge = async (): Promise<FakeForge> => {
  const refused = new Set<string>();
  const writes: FakeForgeWrite[] = [];
  const branches = new Map<string, string>([['main', SHA_A], ['feature', SHA_B], ['docs', 'c'.repeat(40)]]);
  const forkBranches = new Map<string, string>([['fork-feature', 'e'.repeat(40)]]);
  const trees = new Map<string, Tree>([[SHA_A, MAIN_TREE], [SHA_B, FEATURE_TREE]]);
  const treeAt = (sha: string) => trees.get(sha) ?? MAIN_TREE;
  const items: ForgeItem[] = [
    { number: 1, title: 'Kettle whistles too early', body: 'It whistles at 80°C.', state: 'open', comments: [], pull: null },
    { number: 2, title: 'Steep longer', body: 'Three minutes, not two.', state: 'open', comments: [], pull: { head: 'feature', headRepo: 1, base: 'main', sha: SHA_B, merged: false } },
  ];
  let commentId = 100;
  let origin = '';

  const user = { ...FAKE_FORGE_USER, login: FAKE_FORGE_OWNER, avatar_url: '' };
  type RepoJson = {
    id: number; name: string; full_name: string; owner: { id: number; login: string }; html_url: string; clone_url: string;
    default_branch: string; fork: boolean; parent: RepoJson | null;
  };
  const repoJson = (id: number, owner: string, name: string, parent: RepoJson | null = null): RepoJson => ({
    id,
    name,
    full_name: `${owner}/${name}`,
    owner: { id: owner === FAKE_FORGE_OWNER ? user.id : 8, login: owner },
    html_url: `${origin}/${owner}/${name}`,
    clone_url: `${origin}/${owner}/${name}.git`,
    default_branch: 'main',
    fork: parent !== null,
    parent,
  });
  const repo = () => repoJson(1, FAKE_FORGE_OWNER, FAKE_FORGE_REPO);
  const fork = () => repoJson(2, FAKE_FORGE_FORK.owner, FAKE_FORGE_FORK.name, repo());
  const stranger = () => repoJson(3, FAKE_FORGE_STRANGER.owner, FAKE_FORGE_STRANGER.name);
  const repoById = (id: number) => (id === 2 ? fork() : repo());
  const branchOf = (ref: string, sha: string, repoId = 1) => ({ label: ref, ref, sha, repo_id: repoId, repo: repoById(repoId) });
  const issueJson = (item: ForgeItem) => ({
    id: 1000 + item.number,
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    html_url: `${origin}/${FAKE_FORGE_OWNER}/${FAKE_FORGE_REPO}/${item.pull ? 'pulls' : 'issues'}/${item.number}`,
    user,
    labels: [],
    assignees: [],
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    pull_request: item.pull ? { merged: item.pull.merged } : null,
  });
  const pullJson = (item: ForgeItem) => {
    const pull = item.pull;
    if (!pull) return null;
    return {
      ...issueJson(item),
      draft: false,
      merged: pull.merged,
      mergeable: item.state === 'open' && !pull.merged,
      head: branchOf(pull.head, pull.sha, pull.headRepo),
      base: branchOf(pull.base, branches.get(pull.base) ?? SHA_A),
      merge_base: MERGE_BASE,
    };
  };
  const byNumber = (value: string | undefined) => items.find((item) => item.number === Number(value));
  const page = <T,>(list: T[], url: URL, response: http.ServerResponse) => {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit')) || 20));
    const index = Math.max(1, Number(url.searchParams.get('page')) || 1);
    response.setHeader('x-total-count', String(list.length));
    return list.slice((index - 1) * limit, index * limit);
  };
  const stateFilter = (url: URL) => (item: ForgeItem) => {
    const state = url.searchParams.get('state') ?? 'open';
    return state === 'all' || item.state === state;
  };

  type Answer = { status: number; body?: object | null; text?: string };
  const notFound: Answer = { status: 404, body: { message: 'The target couldn\'t be found.' } };

  const route = async (request: http.IncomingMessage, url: URL, response: http.ServerResponse): Promise<Answer> => {
    const method = request.method ?? 'GET';
    const path = url.pathname;
    if (method === 'GET' && path === '/api/v1/version') return { status: 200, body: { version: '1.22.0' } };
    const authorization = request.headers.authorization ?? '';
    const token = authorization.startsWith('token ') ? authorization.slice('token '.length) : '';
    if (!token || refused.has(token)) return { status: 401, body: { message: 'token is required' } };
    if (method === 'GET' && path === '/api/v1/user') return { status: 200, body: user };

    // The fork and the stranger answer only for themselves and their branches.
    for (const [other, answer, otherBranches] of [
      [FAKE_FORGE_FORK, fork, forkBranches],
      [FAKE_FORGE_STRANGER, stranger, new Map([['main', SHA_A]])],
    ] as const) {
      const otherPrefix = `/api/v1/repos/${other.owner}/${other.name}`;
      if (method !== 'GET' || (path !== otherPrefix && path !== `${otherPrefix}/branches`)) continue;
      if (path === otherPrefix) return { status: 200, body: answer() };
      return { status: 200, body: page([...otherBranches].map(([name, sha]) => ({ name, commit: { id: sha } })), url, response) };
    }
    const prefix = `/api/v1/repos/${FAKE_FORGE_OWNER}/${FAKE_FORGE_REPO}`;
    if (!path.startsWith(prefix)) return notFound;
    const rest = path.slice(prefix.length).split('/').filter(Boolean);
    const [collection, number, action] = rest;

    if (method === 'GET' && rest.length === 0) return { status: 200, body: repo() };
    if (method === 'GET' && collection === 'raw' && rest.length >= 2) {
      const content = treeAt(url.searchParams.get('ref') ?? SHA_A).get(rest.slice(1).map(decodeURIComponent).join('/'));
      return content === undefined ? notFound : { status: 200, text: content };
    }
    if (method === 'GET' && collection === 'branches' && rest.length === 1) {
      return { status: 200, body: page([...branches].map(([name, sha]) => ({ name, commit: { id: sha } })), url, response) };
    }
    if (collection === 'pulls') {
      if (method === 'GET' && rest.length === 1) {
        const list = items.filter((item) => item.pull && stateFilter(url)(item)).reverse();
        return { status: 200, body: page(list.map(pullJson), url, response) };
      }
      if (method === 'POST' && rest.length === 1) {
        const body = await readBody(request);
        // `owner:branch` names a branch of the fork; a bare name one of this repository.
        const [headOwner, forkHead] = textOf(body.head).split(':');
        const fromFork = forkHead !== undefined && headOwner === FAKE_FORGE_FORK.owner;
        const head = fromFork ? forkHead : textOf(body.head);
        const headRepo = fromFork ? 2 : 1;
        const base = textOf(body.base);
        const title = textOf(body.title);
        const headSha = (fromFork ? forkBranches : branches).get(head);
        if (!headSha || !branches.has(base) || !title) return { status: 422, body: { message: 'head, base and title are required' } };
        if (items.some((item) => item.pull?.head === head && item.pull.headRepo === headRepo && item.pull.base === base && item.state === 'open')) {
          return { status: 409, body: { message: 'pull request already exists for these targets' } };
        }
        const item: ForgeItem = {
          number: items.length + 1, title, body: textOf(body.body), state: 'open', comments: [],
          pull: { head, headRepo, base, sha: headSha, merged: false },
        };
        items.push(item);
        writes.push({ method, path });
        return { status: 201, body: pullJson(item) };
      }
      const diffOf = number?.endsWith('.diff') ? byNumber(number.slice(0, -'.diff'.length)) : undefined;
      if (method === 'GET' && rest.length === 2 && diffOf?.pull) {
        const base = treeAt(MERGE_BASE);
        const head = treeAt(diffOf.pull.sha);
        return { status: 200, text: changedPaths(base, head).map((path) => fileDiff(path, base.get(path) ?? '', head.get(path) ?? '')).join('') };
      }
      const item = byNumber(number);
      if (!item?.pull) return notFound;
      if (method === 'GET' && rest.length === 2) return { status: 200, body: pullJson(item) };
      if (method === 'GET' && action === 'files' && rest.length === 3) {
        const base = treeAt(MERGE_BASE);
        const head = treeAt(item.pull.sha);
        return { status: 200, body: page(changedPaths(base, head).map((path) => {
          const additions = linesOf(head.get(path) ?? '').length;
          const deletions = linesOf(base.get(path) ?? '').length;
          return { filename: path, status: 'changed', additions, deletions, changes: additions + deletions };
        }), url, response) };
      }
      if (method === 'PATCH' && rest.length === 2) {
        const body = await readBody(request);
        const title = textOf(body.title);
        if (!title) return { status: 422, body: { message: 'title is required' } };
        item.title = title;
        if (body.body !== undefined) item.body = textOf(body.body);
        writes.push({ method, path });
        return { status: 201, body: pullJson(item) };
      }
      if (method === 'POST' && action === 'merge' && rest.length === 3) {
        const body = await readBody(request);
        if (item.state !== 'open' || item.pull.merged) return { status: 405, body: { message: 'pull request is not open' } };
        if (body.head_commit_id && body.head_commit_id !== item.pull.sha) return { status: 409, body: { message: 'head moved' } };
        if (body.Do !== 'merge') return { status: 405, body: { message: 'merge style is not allowed' } };
        item.pull.merged = true;
        item.state = 'closed';
        writes.push({ method, path });
        return { status: 200, body: null };
      }
      return notFound;
    }
    if (collection === 'issues') {
      if (method === 'GET' && rest.length === 1) {
        const list = items.filter((item) => (url.searchParams.get('type') !== 'issues' || !item.pull) && stateFilter(url)(item)).reverse();
        return { status: 200, body: page(list.map(issueJson), url, response) };
      }
      const item = byNumber(number);
      if (!item) return notFound;
      if (method === 'GET' && rest.length === 2) return { status: 200, body: issueJson(item) };
      if (method === 'PATCH' && rest.length === 2) {
        const body = await readBody(request);
        if (body.state !== 'open' && body.state !== 'closed') return { status: 422, body: { message: 'state is open or closed' } };
        if (item.pull?.merged) return { status: 422, body: { message: 'a merged pull request cannot change state' } };
        item.state = body.state;
        writes.push({ method, path });
        return { status: 201, body: issueJson(item) };
      }
      if (action === 'comments' && rest.length === 3) {
        if (method === 'GET') {
          return { status: 200, body: item.comments.map((comment) => ({ ...comment, user, html_url: `${issueJson(item).html_url}#issuecomment-${comment.id}` })) };
        }
        if (method === 'POST') {
          const body = await readBody(request);
          const text = textOf(body.body);
          if (!text) return { status: 422, body: { message: 'body is required' } };
          commentId += 1;
          const comment = { id: commentId, body: text, created_at: '2026-10-03T10:00:00Z' };
          item.comments.push(comment);
          writes.push({ method, path });
          return { status: 201, body: { ...comment, user } };
        }
      }
    }
    return notFound;
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', origin);
    route(request, url, response).then((answer) => {
      response.statusCode = answer.status;
      if (answer.text !== undefined) {
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.end(answer.text);
        return;
      }
      if (answer.body === undefined || answer.body === null) {
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(answer.body));
    }, (error: Error) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ message: error.message }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  // A TCP listener's address is `{ port }`; a pipe's would be a string.
  const { port }: Partial<AddressInfo> = Object(server.address());
  if (!Number.isInteger(port)) throw new Error('The fake forge did not get a port');
  origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    writes,
    refuseToken: (token) => { refused.add(token); },
    push: (branch, sha) => {
      branches.set(branch, sha);
      for (const item of items) if (item.pull?.head === branch && item.pull.headRepo === 1 && item.state === 'open') item.pull.sha = sha;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};
