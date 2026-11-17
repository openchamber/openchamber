import fixtures from './api.json' with { type: 'json' };
import { isString } from '../../shared/guards.js';

export const ORIGIN = 'https://gitea.example.com';
export { fixtures };

export type FixtureJson = null | boolean | number | string | FixtureJson[] | { [key: string]: FixtureJson | undefined };

export interface FixtureCall {
  method: string;
  url: URL;
  headers: HeadersInit;
  redirect: RequestRedirect | undefined;
  body: FixtureJson | undefined;
}

export type FixtureBody = FixtureJson | Response | undefined;
export type FixtureRoute = FixtureBody | ((request: FixtureCall) => FixtureBody | Promise<FixtureBody>);
export interface FixtureRoutes {
  [key: string]: FixtureRoute;
}
export type FixtureRequestInit = Omit<RequestInit, 'body'> & { body?: string | undefined };

const clone = (value: FixtureJson | undefined): FixtureJson => JSON.parse(JSON.stringify(value));
const isFixtureText = (value: FixtureJson | undefined): value is string => isString(value);

export function fakeGitea(routes: FixtureRoutes = {}) {
  const calls: FixtureCall[] = [];
  const fetch = async (input: string | URL, init: FixtureRequestInit = {}) => {
    const url = new URL(String(input));
    const call: FixtureCall = {
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
    if (isFixtureText(value)) return new Response(value, { status: 200, headers: { 'content-type': 'text/plain' } });
    return Response.json(clone(value));
  };
  return { fetch, calls };
}

export const HEAD = fixtures.forkPull.head.sha;
export const MERGE_BASE = fixtures.forkPull.merge_base;

export function forkNetworkRoutes(extra: FixtureRoutes = {}): FixtureRoutes {
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

export const replay = ({ status, body }: { status: number; body: string }) => new Response(body, {
  status,
  headers: { 'content-type': body.startsWith('{') ? 'application/json' : 'text/plain' },
});
