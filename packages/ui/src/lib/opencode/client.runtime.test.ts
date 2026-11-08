import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from './client';
import { switchRuntimeEndpoint } from '../runtime-switch';

describe('provider catalog instance ownership', () => {
  let restore = () => {};
  afterEach(() => restore());

  for (const roundTrip of [true, false]) test(roundTrip
    ? 'a fresh read waiting behind an older read cannot start after an instance round trip'
    : 'a fresh read waiting behind an older read survives a same-instance transport change', async () => {
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const requests: string[] = [];
    const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/auth/url-token') return new Response(null, { status: 404 });
      requests.push(url.pathname);
      await held;
      return Response.json({ location: {}, data: url.pathname.endsWith('/default') ? null : [] });
    });
    restore = () => transport.mockRestore();
    switchRuntimeEndpoint({ apiBaseUrl: 'http://catalog-a.test', runtimeKey: 'catalog-a' });
    opencodeClient.reconnectToRuntimeBaseUrl();
    const first = opencodeClient.getProvidersForConfig('/catalog-old');
    const fresh = opencodeClient.getProvidersForConfig('/catalog-old', { fresh: true });
    const outcome = fresh.then(() => 'completed', () => 'retired');
    switchRuntimeEndpoint({ apiBaseUrl: 'http://catalog-b.test', runtimeKey: roundTrip ? 'catalog-b' : 'catalog-a' });
    opencodeClient.reconnectToRuntimeBaseUrl();
    switchRuntimeEndpoint({ apiBaseUrl: 'http://catalog-a.test', runtimeKey: 'catalog-a' });
    opencodeClient.reconnectToRuntimeBaseUrl();
    release();
    await first;
    expect(await outcome).toBe(roundTrip ? 'retired' : 'completed');
    const catalogRequests = ['/api/model', '/api/model/default', '/api/provider'];
    expect(requests).toEqual(roundTrip ? catalogRequests : [...catalogRequests, ...catalogRequests]);
  });
});
