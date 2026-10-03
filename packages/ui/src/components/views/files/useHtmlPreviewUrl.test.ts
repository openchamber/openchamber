import { describe, expect, test } from 'bun:test';
import { createRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import type { runtimeFetch } from '@/lib/runtime-fetch';
import { htmlPreviewUrl, mintHtmlPreviewGrant } from './useHtmlPreviewUrl';

type FetchInit = Parameters<typeof runtimeFetch>[1];

describe('html preview url', () => {
  test('puts the grant in the path and no URL token in the query', () => {
    const previous = getRuntimeUrlResolver();
    setRuntimeUrlResolver(createRuntimeUrlResolver({ apiBaseUrl: 'http://127.0.0.1:3001' }));
    const url = htmlPreviewUrl('grant-1', '/Users/me/my site/index.html');
    setRuntimeUrlResolver(previous);
    expect(url).toBe('http://127.0.0.1:3001/api/fs/preview/grant-1/Users/me/my%20site/index.html');
    expect(url).not.toContain('oc_url_token');
  });

  test('mints a grant for the page with the project directory', async () => {
    const calls: Array<{ input: string; init: FetchInit }> = [];
    const fetcher: typeof runtimeFetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({ grant: 'grant-7', expiresAt: 1 }), { status: 200 });
    };
    const grant = await mintHtmlPreviewGrant(
      { path: '/repo/site/index.html', directory: '/repo', revision: '0' },
      new AbortController().signal,
      fetcher,
    );
    expect(grant).toBe('grant-7');
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe('/api/fs/preview');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.query).toEqual({ directory: '/repo' });
    expect(calls[0].init?.body).toBe(JSON.stringify({ path: '/repo/site/index.html' }));
  });

  test('fails instead of producing a URL when the server refuses', async () => {
    const fetcher: typeof runtimeFetch = async () => new Response('{}', { status: 403 });
    await expect(mintHtmlPreviewGrant(
      { path: '/repo/index.html', directory: '/repo', revision: '0' },
      new AbortController().signal,
      fetcher,
    )).rejects.toThrow('403');
  });
});
