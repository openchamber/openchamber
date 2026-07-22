import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2';

import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { getRuntimeBearerTokenSync, getRuntimeExtraHeadersSync } from '@/lib/runtime-auth';
import { sanitizeHeadersForBrowser } from '@/lib/runtime-fetch';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';

export type SideChatRuntimeOperation = {
  runtimeKey: string;
  fetch: (path: string, init?: RequestInit & { query?: Record<string, string> }) => Promise<Response>;
  client: OpencodeClient;
  isCurrent: () => boolean;
};

export const captureSideChatRuntimeOperation = (): SideChatRuntimeOperation => {
  const runtimeKey = getRuntimeKey();
  const baseUrl = getRuntimeApiBaseUrl().replace(/\/+$/, '');
  const relay = getActiveRelayTunnel();
  const bearerToken = getRuntimeBearerTokenSync();
  const extraHeaders = { ...getRuntimeExtraHeadersSync() };

  const capturedFetch = async (input: string | URL | Request, init: RequestInit & { query?: Record<string, string> } = {}) => {
    const { query, ...requestInit } = init;
    const fallbackOrigin = typeof window === 'undefined' ? 'http://openchamber.local' : window.location.origin;
    const raw = input instanceof Request ? input.url : input.toString();
    const url = new URL(raw, `${baseUrl || fallbackOrigin}/`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const headers = new Headers(sanitizeHeadersForBrowser(requestInit.headers) ?? requestInit.headers);
    new Headers(sanitizeHeadersForBrowser(extraHeaders) ?? extraHeaders)
      .forEach((value, key) => { if (!headers.has(key)) headers.set(key, value); });
    if (bearerToken && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${bearerToken}`);
    if (relay) return relay.fetch(input instanceof Request ? input : `${url.pathname}${url.search}`, { ...requestInit, headers });
    return fetch(input instanceof Request ? new Request(url, input) : url, { ...requestInit, headers, credentials: 'include' });
  };
  const client = createOpencodeClient({
    baseUrl: `${baseUrl}/api`,
    fetch: capturedFetch,
  });
  return { runtimeKey, fetch: capturedFetch, client, isCurrent: () => getRuntimeKey() === runtimeKey };
};
