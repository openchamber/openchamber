import { afterEach, expect, it, vi } from 'vitest';
import { refreshGoogleAccessToken } from './oauth.js';

afterEach(() => vi.unstubAllGlobals());

it('serializes nullable refresh tokens with the existing URLSearchParams coercion', async () => {
  const sent: Array<string | null> = [];
  vi.stubGlobal('fetch', async (_input: RequestInfo | URL, options?: RequestInit) => {
    if (!(options?.body instanceof URLSearchParams)) throw new Error('Expected an OAuth form');
    sent.push(options.body.get('refresh_token'));
    return new Response('{"access_token":"access"}', { headers: { 'content-type': 'application/json' } });
  });
  expect(await refreshGoogleAccessToken(null, 'antigravity')).toEqual({ ok: true, accessToken: 'access' });
  expect(await refreshGoogleAccessToken('refresh', 'gemini')).toEqual({ ok: true, accessToken: 'access' });
  expect(sent).toEqual(['null', 'refresh']);
});
