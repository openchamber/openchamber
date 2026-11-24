import { createSessionDirectoryResolver } from './session-directory.js';
import type { OpenCodeTrust, OpenCodeTrustJsonBody, SessionDirectoryOptions } from './contracts.js';

const headersOf = (input: RequestInfo | URL, init?: Pick<RequestInit, 'headers'>) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [name, value] of new Headers(init?.headers)) headers.set(name, value);
  return Object.fromEntries(headers);
};

const jsonBodyOf = async (input: RequestInfo | URL, init?: { body?: BodyInit | null | undefined }): Promise<OpenCodeTrustJsonBody | undefined> => {
  if (init?.body !== undefined && init?.body !== null) {
    if (init.body instanceof ReadableStream) throw new Error('Cannot read a streamed body');
    return JSON.parse(await new Response(init.body).text());
  }
  if (input instanceof Request) return JSON.parse(await input.clone().text());
  return undefined;
};

export const guardOpenCodeFetch = ({ fetchImpl, openCodeTrust, buildOpenCodeUrl, getOpenCodeAuthHeaders }: SessionDirectoryOptions & { openCodeTrust: OpenCodeTrust }): typeof fetch => {
  const resolveSessionDirectory = createSessionDirectoryResolver({ fetchImpl, buildOpenCodeUrl, getOpenCodeAuthHeaders });

  const openCodeOrigin = () => {
    try {
      return new URL(buildOpenCodeUrl('/', '')).origin;
    } catch {
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
      readBody: () => jsonBodyOf(input, init),
    });
    if (!refusal) return fetchImpl(input, init);
    return new Response(JSON.stringify(refusal.body), {
      status: refusal.status,
      headers: { 'content-type': 'application/json' },
    });
  };
};
