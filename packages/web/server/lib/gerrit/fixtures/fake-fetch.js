import fixtures from './api.json' with { type: 'json' };

export const ORIGIN = 'https://gerrit.example.com';
export { fixtures };

const XSSI = ")]}'\n";
export const PS3 = fixtures.shas.ps3;
export const PS2 = fixtures.shas.ps2;
export const CHANGE = '/changes/platform%2Fapp~42';

const gerritJson = (body, status = 200) => new Response(`${XSSI}${JSON.stringify(body)}`, {
  status, headers: { 'content-type': 'application/json;charset=utf-8' },
});

export const gerritBase64 = (value) => new Response(value, {
  headers: { 'content-type': 'text/plain;charset=iso-8859-1', 'x-fyi-content-encoding': 'base64' },
});

export const replay = ({ status, body, contentType = 'text/plain;charset=utf-8' }) => new Response(body, { status, headers: { 'content-type': contentType } });

export function fakeGerrit(routes = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const authenticated = url.pathname.startsWith('/a/');
    const call = {
      method: init.method ?? 'GET', url, headers: init.headers ?? {}, redirect: init.redirect, authenticated,
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const key = `${call.method} ${authenticated ? url.pathname.slice(2) : url.pathname}`;
    if (!Object.hasOwn(routes, key)) return new Response(`Not found: ${key}`, { status: 404 });
    const value = routes[key] instanceof Function ? await routes[key](call) : routes[key];
    return value instanceof Response ? value : gerritJson(value);
  };
  return { fetch, calls };
}

export const resolvePlatformApp = async () => ({
  repos: [{ owner: 'platform', name: 'app', project: 'platform/app', repoPath: 'platform/app', url: `${ORIGIN}/admin/repos/platform/app`, remoteName: 'origin' }],
});

export function changeRoutes(extra = {}) {
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
