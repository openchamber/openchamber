import fixtures from './api.json' with { type: 'json' };
import { isString } from '../../shared/guards.js';

export const ORIGIN = 'https://gitea.example.com';
export { fixtures };

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * A fetch double for Gitea's API keyed by `METHOD /path` (the path after
 * `/api/v1`, without the query). A route's value is a response body, a
 * `Response`, or a function `(request) => body | Response`. Every call is
 * recorded with its method, URL, headers, body and redirect mode.
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
    const key = `${call.method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
    if (!Object.hasOwn(routes, key)) return new Response(JSON.stringify({ message: `no fixture for ${key}` }), { status: 404 });
    const value = routes[key] instanceof Function ? await routes[key](call) : routes[key];
    if (value instanceof Response) return value;
    if (isString(value)) return new Response(value, { status: 200, headers: { 'content-type': 'text/plain' } });
    return Response.json(clone(value));
  };
  return { fetch, calls };
}

/** The usual network: alice/app (remote `origin`) forked from team/app, with pull request #5. */
export function forkNetworkRoutes(extra = {}) {
  return {
    'GET /user': fixtures.user,
    'GET /version': fixtures.version,
    'GET /repos/alice/app': fixtures.forkRepo,
    'GET /repositories/10': fixtures.upstreamRepo,
    'GET /repos/team/app': fixtures.upstreamRepo,
    'GET /repos/team/app/pulls/5': fixtures.forkPull,
    'GET /repos/team/app/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/status': fixtures.combinedStatus,
    ...extra,
  };
}

export const resolveForkRemote = async () => ({ repos: [{ owner: 'alice', name: 'app', repoPath: 'alice/app', url: `${ORIGIN}/alice/app`, remoteName: 'origin' }] });
