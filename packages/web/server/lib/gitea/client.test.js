import { describe, expect, it, vi } from 'vitest';
import { classifyGiteaFailure, createGiteaClient } from './client.js';
import { fakeGitea, ORIGIN } from './fixtures/fake-fetch.js';

const noDelay = async () => {};

describe('Gitea client', () => {
  it('sends the token as a token header to the instance API only, never following redirects', async () => {
    const { fetch, calls } = fakeGitea({ 'GET /user': { id: 1, login: 'alice' } });
    const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch });

    await client.get('/user');

    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin).toBe(ORIGIN);
    expect(calls[0].url.pathname).toBe('/api/v1/user');
    expect(calls[0].headers.authorization).toBe('token pat-1');
    expect(calls[0].redirect).toBe('manual');
  });

  it('refuses a redirect instead of sending the token on to its target', async () => {
    const { fetch, calls } = fakeGitea({
      'GET /user': new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/collect' } }),
    });
    const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch, delay: noDelay });

    await expect(client.get('/user')).rejects.toThrow('redirect');
    expect(calls).toHaveLength(1);
    expect(calls.every((call) => call.url.origin === ORIGIN)).toBe(true);
  });

  it('refuses a path that would leave the instance API before sending anything', async () => {
    const { fetch, calls } = fakeGitea();
    const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch });

    await expect(client.get('../../user/settings')).rejects.toThrow('leaves the instance API');
    await expect(client.get('repos/%2e%2e/%2e%2e/%2e%2e/admin')).rejects.toThrow('leaves the instance API');
    expect(calls).toHaveLength(0);
    // A protocol-relative path stays a path under the API.
    await client.get('//elsewhere.example.com/collect').catch(() => {});
    expect(calls[0].url.href).toBe(`${ORIGIN}/api/v1/elsewhere.example.com/collect`);
  });

  it('retries a read after 502 and 429, but sends a write once', async () => {
    let reads = 0;
    const { fetch, calls } = fakeGitea({
      'GET /user': () => {
        reads += 1;
        if (reads === 1) return new Response('bad gateway', { status: 502 });
        if (reads === 2) return new Response('slow down', { status: 429 });
        return { id: 1, login: 'alice' };
      },
      'POST /repos/team/app/pulls': new Response('bad gateway', { status: 502 }),
    });
    const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch, delay: noDelay });

    await expect(client.get('/user')).resolves.toMatchObject({ login: 'alice' });
    await expect(client.post('/repos/team/app/pulls', { title: 'x' })).rejects.toMatchObject({ status: 502 });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('does not retry a read on other failures and names a refused token', async () => {
    const { fetch, calls } = fakeGitea({ 'GET /user': new Response(JSON.stringify({ message: 'token is required' }), { status: 401 }) });
    const client = createGiteaClient({ origin: ORIGIN, token: 'bad', fetch, delay: noDelay });

    const error = await client.get('/user').catch((failure) => failure);
    expect(error).toMatchObject({ status: 401, kind: 'invalid-token', message: 'token is required' });
    expect(classifyGiteaFailure(error)).toBe('invalid-token');
    expect(calls).toHaveLength(1);
  });

  it('pages by the Link header, else by the total count', async () => {
    const { fetch } = fakeGitea({
      'GET /repos/team/app/branches': (call) => new Response(JSON.stringify([{ name: `b${call.url.searchParams.get('page')}` }]), {
        headers: call.url.searchParams.get('page') === '1'
          ? { link: `<${ORIGIN}/api/v1/repos/team/app/branches?page=2>; rel="next"` }
          : {},
      }),
      'GET /repos/team/app/labels': new Response(JSON.stringify([{ name: 'a' }]), { headers: { 'x-total-count': '3' } }),
    });
    const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch });

    await expect(client.collection('/repos/team/app/branches')).resolves.toEqual([{ name: 'b1' }, { name: 'b2' }]);
    await expect(client.page('/repos/team/app/labels', {}, { page: 1, limit: 1 })).resolves.toMatchObject({ hasMore: true, total: 3 });
  });

  it('fails a collection past its bound instead of returning part of it', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ name: 'x' }]), { headers: { link: '<x>; rel="next"' } }));
    const client = createGiteaClient({ origin: ORIGIN, token: 'pat-1', fetch });

    await expect(client.collection('/repos/team/app/branches', {}, { limit: 1, maxItems: 3, message: 'too many' })).rejects.toThrow('too many');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('classifies network failures as unreachable', () => {
    expect(classifyGiteaFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('unreachable');
    expect(classifyGiteaFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('unreachable');
  });
});
