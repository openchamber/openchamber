import fixtures from './api.json' with { type: 'json' };
import { isString } from '../../shared/guards.js';

export const ORIGIN = 'https://gitea.example.com';
export { fixtures };

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A fetch double for Gitea's API keyed by `METHOD /path` (the path after
 * `/api/v1`, without the query; a Forgejo namespace path keeps its namespace,
 * so `/api/forgejo/v1/version` is `GET /forgejo/version`). A route's value is
 * a response body, a `Response`, or a function `(request) => body | Response`.
 * Every call is recorded with its method, URL, headers, body and redirect mode.
 */
export function fakeGitea(routes = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = {
      method: init.method ?? 'GET', url, headers: init.headers ?? {}, redirect: init.redirect,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const path = url.pathname.startsWith('/api/forgejo/v1/')
      ? `/forgejo${url.pathname.slice('/api/forgejo/v1'.length)}`
      : url.pathname.replace(/^\/api\/v1/, '');
    const key = `${call.method} ${path}`;
    if (!Object.hasOwn(routes, key)) return new Response(JSON.stringify({ message: `no fixture for ${key}` }), { status: 404 });
    const value = routes[key] instanceof Function ? await routes[key](call) : routes[key];
    if (value instanceof Response) return value;
    if (isString(value)) return new Response(value, { status: 200, headers: { 'content-type': 'text/plain' } });
    return Response.json(clone(value));
  };
  return { fetch, calls };
}

export const HEAD = fixtures.forkPull.head.sha;
export const MERGE_BASE = fixtures.forkPull.merge_base;

/** The recorded network: bob/app (remote `origin`) forked from alice/app, with pull request #1 from bob:feature. */
export function forkNetworkRoutes(extra = {}) {
  return {
    'GET /user': fixtures.user,
    'GET /version': fixtures.version,
    'GET /repos/bob/app': fixtures.forkRepo,
    'GET /repositories/1': fixtures.upstreamRepo,
    'GET /repos/alice/app': fixtures.upstreamRepo,
    'GET /repos/alice/app/pulls/1': fixtures.forkPull,
    [`GET /repos/alice/app/commits/${HEAD}/status`]: fixtures.combinedStatus,
    ...extra,
  };
}

export const resolveForkRemote = async () => ({ repos: [{ owner: 'bob', name: 'app', repoPath: 'bob/app', url: `${ORIGIN}/bob/app`, remoteName: 'origin' }] });

/** A recorded refusal (`fixtures.errors.*`) as the response Gitea sent. */
export const replay = ({ status, body }) => new Response(body, {
  status,
  headers: { 'content-type': body.startsWith('{') ? 'application/json' : 'text/plain' },
});
