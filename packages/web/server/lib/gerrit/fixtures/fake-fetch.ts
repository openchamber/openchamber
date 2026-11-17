import fixtures from './api.json' with { type: 'json' };

export type GerritFixtureJson = string | number | boolean | null | GerritFixtureJson[] | { [key: string]: GerritFixtureJson | undefined };

export interface GerritFixtureRequestInit {
  method?: string;
  headers?: HeadersInit;
  redirect?: RequestRedirect;
  body?: string | undefined;
  signal?: AbortSignal;
}

export interface GerritFixtureCall {
  method: string;
  url: URL;
  headers: HeadersInit;
  redirect: RequestRedirect | undefined;
  authenticated: boolean;
  body: GerritFixtureJson | undefined;
}

export type GerritFixtureAnswer = GerritFixtureJson | Response | undefined;
export type GerritFixtureRoute = GerritFixtureAnswer | ((call: GerritFixtureCall) => GerritFixtureAnswer | Promise<GerritFixtureAnswer>);
export type GerritFixtureRoutes = Record<string, GerritFixtureRoute>;

export interface GerritFixtureReplay {
  status: number;
  body: string;
  contentType?: string;
}

export const ORIGIN = 'https://gerrit.example.com';
export { fixtures };

const XSSI = ")]}'\n";
export const PS3 = fixtures.shas.ps3;
export const PS2 = fixtures.shas.ps2;
export const CHANGE = '/changes/platform%2Fapp~42';

const gerritJson = (body: GerritFixtureJson | undefined, status = 200) => new Response(`${XSSI}${JSON.stringify(body)}`, {
  status, headers: { 'content-type': 'application/json;charset=utf-8' },
});

export const gerritBase64 = (value: string) => new Response(value, {
  headers: { 'content-type': 'text/plain;charset=iso-8859-1', 'x-fyi-content-encoding': 'base64' },
});

export const replay = ({ status, body, contentType = 'text/plain;charset=utf-8' }: GerritFixtureReplay) => new Response(body, { status, headers: { 'content-type': contentType } });

export function fakeGerrit(routes: GerritFixtureRoutes = {}) {
  const calls: GerritFixtureCall[] = [];
  const fetch = async (input: string | URL, init: GerritFixtureRequestInit = {}) => {
    const url = new URL(String(input));
    const authenticated = url.pathname.startsWith('/a/');
    const call: GerritFixtureCall = {
      method: init.method ?? 'GET', url, headers: init.headers ?? {}, redirect: init.redirect, authenticated,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${authenticated ? url.pathname.slice(2) : url.pathname}`;
    if (!Object.hasOwn(routes, key)) return new Response(`Not found: ${key}`, { status: 404 });
    const route = routes[key];
    const value = route instanceof Function ? await route(call) : route;
    return value instanceof Response ? value : gerritJson(value);
  };
  return { fetch, calls };
}

export const resolvePlatformApp = async () => ({
  repos: [{ owner: 'platform', name: 'app', project: 'platform/app', repoPath: 'platform/app', url: `${ORIGIN}/admin/repos/platform/app`, remoteName: 'origin' }],
});

export function changeRoutes(extra: GerritFixtureRoutes = {}) {
  return {
    'GET /accounts/self': fixtures.accountSelf,
    'GET /config/server/version': fixtures.version,
    'GET /projects/platform%2Fapp/HEAD': fixtures.projectHead,
    [`GET ${CHANGE}`]: fixtures.change,
    [`GET ${CHANGE}/comments`]: fixtures.comments,
    [`GET ${CHANGE}/revisions/current/related`]: fixtures.related,
    [`GET ${CHANGE}/revisions/${PS3}/files/`]: fixtures.files,
    [`GET ${CHANGE}/revisions/${PS3}/patch`]: () => gerritBase64(fixtures.patch),
    ...extra,
  };
}
