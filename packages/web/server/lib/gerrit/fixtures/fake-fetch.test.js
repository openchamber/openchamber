import { describe, expect, it } from 'vitest';
import { CHANGE, changeRoutes, fakeGerrit, fixtures, gerritBase64, ORIGIN, PS3, replay, resolvePlatformApp } from './fake-fetch.js';

describe('Gerrit fixture fetch', () => {
  it('records authenticated requests and parses their JSON body', async () => {
    const headers = { authorization: 'Basic fixture' };
    const { fetch, calls } = fakeGerrit({ 'POST /changes/42/review': { labels: {} } });
    const response = await fetch(`${ORIGIN}/a/changes/42/review`, {
      method: 'POST', headers, redirect: 'manual', body: '{"labels":{"Code-Review":2}}',
    });
    expect(calls).toEqual([{
      method: 'POST', url: new URL(`${ORIGIN}/a/changes/42/review`), headers, redirect: 'manual',
      authenticated: true, body: { labels: { 'Code-Review': 2 } },
    }]);
    expect(calls[0].headers).toBe(headers);
    expect(await response.text()).toBe(')]}\'\n{"labels":{}}');
    expect(response.headers.get('content-type')).toBe('application/json;charset=utf-8');
  });

  it('keeps default request fields and reports missing or inherited routes', async () => {
    const { fetch, calls } = fakeGerrit();
    const response = await fetch(`${ORIGIN}/config/server/version`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('Not found: GET /config/server/version');
    expect(calls[0]).toMatchObject({ method: 'GET', headers: {}, redirect: undefined, authenticated: false, body: undefined });
    const inherited = fakeGerrit(Object.create({ 'GET /config/server/version': fixtures.version }));
    expect((await inherited.fetch(`${ORIGIN}/config/server/version`)).status).toBe(404);
  });

  it('awaits route handlers and passes their Response through unchanged', async () => {
    const response = new Response('refused', { status: 403 });
    const { fetch, calls } = fakeGerrit({
      'GET /accounts/self': async (call) => {
        expect(call.authenticated).toBe(true);
        return response;
      },
    });
    expect(await fetch(`${ORIGIN}/a/accounts/self`)).toBe(response);
    expect(calls).toHaveLength(1);
  });

  it('keeps parse failures and records no call for malformed request JSON', async () => {
    const { fetch, calls } = fakeGerrit();
    await expect(fetch(`${ORIGIN}/changes/42`, { body: '{' })).rejects.toThrow(SyntaxError);
    expect(calls).toEqual([]);
  });

  it('replays recorded refusals and base64 responses with their headers', async () => {
    const refusal = replay(fixtures.errors.reviewerRefused);
    expect(refusal.status).toBe(fixtures.errors.reviewerRefused.status);
    expect(refusal.headers.get('content-type')).toBe(fixtures.errors.reviewerRefused.contentType);
    expect(await refusal.text()).toBe(fixtures.errors.reviewerRefused.body);
    const plain = replay({ status: 409, body: 'blocked' });
    expect(plain.headers.get('content-type')).toBe('text/plain;charset=utf-8');
    const encoded = gerritBase64(fixtures.patch);
    expect(encoded.headers.get('content-type')).toBe('text/plain;charset=iso-8859-1');
    expect(encoded.headers.get('x-fyi-content-encoding')).toBe('base64');
    expect(await encoded.text()).toBe(fixtures.patch);
  });

  it('provides the recorded change routes with caller overrides and project resolution', async () => {
    const { fetch } = fakeGerrit(changeRoutes({ 'GET /accounts/self': null }));
    expect(await (await fetch(`${ORIGIN}/a/accounts/self`)).text()).toBe(')]}\'\nnull');
    expect(await (await fetch(`${ORIGIN}/a${CHANGE}`)).text()).toBe(`)]}'\n${JSON.stringify(fixtures.change)}`);
    expect(await (await fetch(`${ORIGIN}/a${CHANGE}/revisions/${PS3}/patch`)).text()).toBe(fixtures.patch);
    expect(await resolvePlatformApp()).toEqual({
      repos: [{ owner: 'platform', name: 'app', project: 'platform/app', repoPath: 'platform/app', url: `${ORIGIN}/admin/repos/platform/app`, remoteName: 'origin' }],
    });
  });
});
