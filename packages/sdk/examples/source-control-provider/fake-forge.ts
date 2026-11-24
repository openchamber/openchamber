import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const FAKE_FORGE_OWNER = 'mona';
export const FAKE_FORGE_REPO = 'teapot';
export const FAKE_FORGE_USER = { id: 7, login: FAKE_FORGE_OWNER, full_name: 'Mona Teapot', email: 'mona@example.com' };
export const FAKE_FORGE_FORK = { owner: 'octo', name: 'teapot' };
export const FAKE_FORGE_STRANGER = { owner: 'mona', name: 'kettle' };

type ForgeComment = { id: number; body: string; created_at: string };
type ForgePerson = { id: number; login: string; full_name?: string; email?: string; avatar_url?: string };
type ForgeReview = { user: ForgePerson; state: string; stale?: boolean; dismissed?: boolean };
type ForgeItem = {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  comments: ForgeComment[];
  pull: null | { head: string; headRepo: number; base: string; sha: string; merged: boolean; requestedReviewers?: ForgePerson[]; reviews?: ForgeReview[] };
};

type ForgeTimelineUser = { id: number; login: string; avatar_url?: string };
type ForgeTimelineTarget = {
  number?: number;
  html_url?: string;
  title?: string;
  pull_request?: object | null;
  repository?: { full_name?: string };
};
type ForgeTimelineEvent = {
  type?: string;
  created_at?: string;
  user?: ForgeTimelineUser;
  ref_issue?: ForgeTimelineTarget;
  ref_comment?: { created_at?: string; user?: ForgeTimelineUser };
};

export type FakeForgeWrite = { method: string; path: string };

export type FakeForge = {
  origin: string;
  writes: FakeForgeWrite[];
  refuseToken(token: string): void;
  push(branch: string, sha: string): void;
  close(): Promise<void>;
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const MERGE_BASE = SHA_A;

type Tree = ReadonlyMap<string, string>;
const MAIN_TREE: Tree = new Map([['README.md', 'Steep for two minutes.\n'], ['kettle.txt', 'Whistle at 100°C.\n']]);
const FEATURE_TREE: Tree = new Map([...MAIN_TREE, ['README.md', 'Steep for three minutes.\nThen pour.\n']]);

const linesOf = (content: string) => (content ? content.replace(/\n$/, '').split('\n') : []);

const fileDiff = (path: string, before: string, after: string): string => {
  const old = linesOf(before);
  const next = linesOf(after);
  return [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -1,${old.length} +1,${next.length} @@`,
    ...old.map((line) => `-${line}`), ...next.map((line) => `+${line}`),
  ].join('\n') + '\n';
};

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
    {
      number: 2, title: 'Steep longer', body: 'Three minutes, not two.', state: 'open', comments: [],
      pull: {
        head: 'feature', headRepo: 1, base: 'main', sha: SHA_B, merged: false,
        requestedReviewers: [{ id: 11, login: 'cid' }],
        reviews: [
          { user: { id: 9, login: 'ann' }, state: 'APPROVED' },
          { user: { id: 10, login: 'bob' }, state: 'REQUEST_CHANGES', stale: true },
          { user: { id: 12, login: 'dee' }, state: 'APPROVED' },
          ...Array.from({ length: 50 }, () => ({ user: { id: 11, login: 'cid' }, state: 'REQUEST_REVIEW' })),
          { user: { id: 12, login: 'dee' }, state: 'APPROVED', dismissed: true },
          { user: { id: 9, login: 'ann' }, state: 'PENDING' },
        ],
      },
    },
  ];
  let commentId = 100;
  let origin = '';

  const user = { ...FAKE_FORGE_USER, login: FAKE_FORGE_OWNER, avatar_url: '' };
  const octo = { ...FAKE_FORGE_USER, id: 9, login: 'octo', avatar_url: 'https://avatars.example.com/octo.png' };
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
  const commentJson = (item: ForgeItem, comment: ForgeComment) => {
    const itemUrl = issueJson(item).html_url;
    return {
      ...comment, user, html_url: `${itemUrl}#issuecomment-${comment.id}`,
      issue_url: item.pull ? '' : itemUrl, pull_request_url: item.pull ? itemUrl : '',
    };
  };
  const timelineJson = (item: ForgeItem): ForgeTimelineEvent[] => {
    const target = (number: number) => {
      const linked = items.find((entry) => entry.number === number) ?? item;
      return {
        number,
        html_url: issueJson(linked).html_url,
        title: linked.title,
        repository: { full_name: `${FAKE_FORGE_OWNER}/${FAKE_FORGE_REPO}` },
      };
    };
    if (item.number === 1) {
      const pull = target(2);
      return [
        { type: 'pull_ref', created_at: '2026-10-04T10:00:00Z', user, ref_issue: pull },
        { type: 'comment_ref', created_at: '2026-10-05T10:00:00Z', user, ref_issue: pull, ref_comment: { created_at: '2026-10-03T10:00:00Z', user: octo } },
        { type: 'issue_ref', created_at: '2026-10-06T10:00:00Z', user, ref_issue: pull },
        { type: 'issue_ref', created_at: '2026-10-07T10:00:00Z', user, ref_issue: { html_url: `${origin}/${FAKE_FORGE_OWNER}/${FAKE_FORGE_REPO}/issues/9` } },
        { type: 'issue_ref', created_at: '2026-10-08T10:00:00Z', user, ref_issue: { number: 9 } },
        { type: 'close', created_at: '2026-10-09T10:00:00Z' },
      ];
    }
    return [
      { type: 'issue_ref', created_at: '2026-10-06T10:00:00Z', user, ref_issue: target(1) },
      {
        type: 'issue_ref', created_at: '2026-10-02T10:00:00Z', user,
        ref_issue: {
          number: 5, title: 'Steam wand', html_url: `${origin}/${FAKE_FORGE_STRANGER.owner}/${FAKE_FORGE_STRANGER.name}/issues/5`,
          repository: { full_name: `${FAKE_FORGE_STRANGER.owner}/${FAKE_FORGE_STRANGER.name}` },
        },
      },
    ];
  };
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
      requested_reviewers: pull.requestedReviewers ?? [],
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
      if (method === 'GET' && action === 'reviews' && rest.length === 3) return { status: 200, body: page(item.pull.reviews ?? [], url, response) };
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
      if (number === 'comments' && rest.length === 3) {
        const owner = items.find((entry) => entry.comments.some((comment) => String(comment.id) === action));
        const index = owner ? owner.comments.findIndex((comment) => String(comment.id) === action) : -1;
        if (!owner || index < 0) return notFound;
        if (method === 'GET') return { status: 200, body: commentJson(owner, owner.comments[index]) };
        if (method === 'PATCH') {
          const text = textOf((await readBody(request)).body);
          if (!text) return { status: 422, body: { message: 'body is required' } };
          owner.comments[index].body = text;
          writes.push({ method, path });
          return { status: 200, body: commentJson(owner, owner.comments[index]) };
        }
        if (method === 'DELETE') {
          owner.comments.splice(index, 1);
          writes.push({ method, path });
          return { status: 204, body: null };
        }
        return notFound;
      }
      const item = byNumber(number);
      if (!item) return notFound;
      if (method === 'GET' && rest.length === 2) return { status: 200, body: issueJson(item) };
      if (method === 'GET' && action === 'timeline' && rest.length === 3) {
        return { status: 200, body: page(timelineJson(item), url, response) };
      }
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
          return { status: 200, body: item.comments.map((comment) => commentJson(item, comment)) };
        }
        if (method === 'POST') {
          const body = await readBody(request);
          const text = textOf(body.body);
          if (!text) return { status: 422, body: { message: 'body is required' } };
          commentId += 1;
          const comment = { id: commentId, body: text, created_at: '2026-10-03T10:00:00Z' };
          item.comments.push(comment);
          writes.push({ method, path });
          return { status: 201, body: commentJson(item, comment) };
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
    }, () => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ message: 'The fake forge could not handle this request.' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
