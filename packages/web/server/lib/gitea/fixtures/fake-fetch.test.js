import { describe, expect, it } from 'vitest';
import { fakeGitea, fixtures, forkNetworkRoutes, ORIGIN, replay, resolveForkRemote } from './fake-fetch.js';

describe('Gitea fixture fetch', () => {
  it('records defaults and answers an unmapped route with 404', async () => {
    const { fetch, calls } = fakeGitea();
    const response = await fetch(`${ORIGIN}/api/v1/missing?limit=2`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: 'no fixture for GET /missing' });
    expect(calls).toEqual([{
      method: 'GET', url: new URL(`${ORIGIN}/api/v1/missing?limit=2`),
      headers: {}, redirect: undefined, body: undefined,
    }]);
  });

  it('records JSON writes and awaits route handlers', async () => {
    const headers = { authorization: 'token fixture' };
    const { fetch, calls } = fakeGitea({
      'POST /issues': async (call) => ({ received: call.body }),
    });
    const response = await fetch(`${ORIGIN}/api/v1/issues`, {
      method: 'POST', headers, redirect: 'manual', body: '{"title":"New issue"}',
    });

    expect(await response.json()).toEqual({ received: { title: 'New issue' } });
    expect(calls[0]).toMatchObject({ method: 'POST', headers, redirect: 'manual', body: { title: 'New issue' } });
    expect(calls[0].headers).toBe(headers);
  });

  it('keeps Forgejo namespaces and ignores the query when matching routes', async () => {
    const { fetch } = fakeGitea({ 'GET /forgejo/version': { version: '16.0.6' } });
    expect(await (await fetch(`${ORIGIN}/api/forgejo/v1/version?extra=1`)).json()).toEqual({ version: '16.0.6' });
  });

  it('returns responses unchanged, text as text and JSON as a copy', async () => {
    const refusal = new Response('denied', { status: 403 });
    const payload = { items: [{ id: 1 }] };
    const { fetch } = fakeGitea({
      'GET /refusal': refusal, 'GET /text': 'patch', 'GET /boxed': Object('boxed'), 'GET /json': payload,
    });

    expect(await fetch(`${ORIGIN}/api/v1/refusal`)).toBe(refusal);
    const text = await fetch(`${ORIGIN}/api/v1/text`);
    expect(text.headers.get('content-type')).toBe('text/plain');
    expect(await text.text()).toBe('patch');
    const boxed = await fetch(`${ORIGIN}/api/v1/boxed`);
    expect(boxed.headers.get('content-type')).toBe('text/plain');
    expect(await boxed.text()).toBe('boxed');
    const json = await (await fetch(`${ORIGIN}/api/v1/json`)).json();
    json.items[0].id = 2;
    expect(payload.items[0].id).toBe(1);
  });

  it('preserves failures for malformed request JSON and undefined response bodies', async () => {
    const { fetch, calls } = fakeGitea({ 'GET /undefined': undefined });
    await expect(fetch(`${ORIGIN}/api/v1/issues`, { body: '{' })).rejects.toBeInstanceOf(SyntaxError);
    expect(calls).toEqual([]);
    await expect(fetch(`${ORIGIN}/api/v1/undefined`)).rejects.toBeInstanceOf(SyntaxError);
    expect(calls).toHaveLength(1);
  });

  it('allows network overrides and replays recorded refusals', async () => {
    const routes = forkNetworkRoutes({ 'GET /user': { login: 'override' } });
    expect(routes['GET /user']).toEqual({ login: 'override' });
    expect(routes['GET /repos/bob/app']).toBe(fixtures.forkRepo);
    expect(await resolveForkRemote()).toEqual({
      repos: [{ owner: 'bob', name: 'app', repoPath: 'bob/app', url: `${ORIGIN}/bob/app`, remoteName: 'origin' }],
    });
    for (const body of ['{"message":"denied"}', 'Not found']) {
      const response = replay({ status: 404, body });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe(body.startsWith('{') ? 'application/json' : 'text/plain');
      expect(await response.text()).toBe(body);
    }
  });
});
