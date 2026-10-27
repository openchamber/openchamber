import { createSessionDirectoryResolver } from './session-directory.js';

const headersOf = (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
  return Object.fromEntries(headers);
};

/**
 * `fetch` for the server process with the folder trust check in front of
 * every request to the running OpenCode. Server features call OpenCode with
 * folders the UI hands them (session titles, routing, dispatched sessions,
 * scheduled runs), each through its own client; checking here keeps all of
 * them, and any added later, from opening a folder the user has not trusted.
 * Requests anywhere else pass untouched. A refused request answers the same
 * 403 the proxy gives the UI.
 */
export const guardOpenCodeFetch = ({ fetchImpl, openCodeTrust, buildOpenCodeUrl, getOpenCodeAuthHeaders }) => {
  const resolveSessionDirectory = createSessionDirectoryResolver({ fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders });

  const openCodeOrigin = () => {
    try {
      return new URL(buildOpenCodeUrl('/', '')).origin;
    } catch {
      // OpenCode has no port yet; nothing can reach it.
      return null;
    }
  };

  return async (input, init) => {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return fetchImpl(input, init);
    }
    if (url.origin !== openCodeOrigin()) return fetchImpl(input, init);
    const refusal = await openCodeTrust.refusalFor({
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      path: `${url.pathname}${url.search}`,
      headers: headersOf(input, init),
      resolveSessionDirectory,
    });
    if (!refusal) return fetchImpl(input, init);
    return new Response(JSON.stringify(refusal.body), {
      status: refusal.status,
      headers: { 'content-type': 'application/json' },
    });
  };
};
