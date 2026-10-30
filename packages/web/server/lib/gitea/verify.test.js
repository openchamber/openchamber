import { describe, expect, it } from 'vitest';
import { probeGiteaVersion } from './verify.js';
import { fakeGitea, ORIGIN } from './fixtures/fake-fetch.js';

describe('Gitea edition probe', () => {
  it('reads Forgejo from the suffix on `/version` without asking its namespace', async () => {
    const { fetch, calls } = fakeGitea({ 'GET /version': { version: '9.0.3+gitea-1.22.0' } });

    await expect(probeGiteaVersion({ origin: ORIGIN, fetch })).resolves.toEqual({
      version: '9.0.3+gitea-1.22.0', supported: true, edition: 'forgejo',
    });
    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/v1/version']);
  });

  it('asks the Forgejo namespace when `/version` names no edition', async () => {
    const { fetch, calls } = fakeGitea({
      'GET /version': { version: '16.0.6' },
      'GET /forgejo/version': { version: '16.0.6+gitea-1.22.0' },
    });

    await expect(probeGiteaVersion({ origin: ORIGIN, fetch })).resolves.toEqual({
      version: '16.0.6+gitea-1.22.0', supported: true, edition: 'forgejo',
    });
    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/v1/version', '/api/forgejo/v1/version']);
  });

  it('trusts the namespace itself as the edition, whatever its version says', async () => {
    const { fetch } = fakeGitea({
      'GET /version': { version: '16.0.6' },
      'GET /forgejo/version': { version: '16.0.6' },
    });

    await expect(probeGiteaVersion({ origin: ORIGIN, fetch })).resolves.toEqual({
      version: '16.0.6', supported: true, edition: 'forgejo',
    });
  });

  it('reads Gitea when it has no Forgejo namespace and no suffix', async () => {
    const { fetch } = fakeGitea({ 'GET /version': { version: '1.27.3' } });

    await expect(probeGiteaVersion({ origin: ORIGIN, fetch })).resolves.toEqual({
      version: '1.27.3', supported: true, edition: 'gitea',
    });
  });

  it('refuses a Gitea older than 1.21', async () => {
    const { fetch } = fakeGitea({ 'GET /version': { version: '1.20.6' } });

    await expect(probeGiteaVersion({ origin: ORIGIN, fetch })).resolves.toEqual({
      version: '1.20.6', supported: false, edition: 'gitea',
    });
  });

  it('reads a locked instance with the token, and keeps a Gitea without a namespace Gitea', async () => {
    const locked = (call) => (call.headers.authorization === 'token pat-1'
      ? { version: '1.27.3' }
      : new Response('{"message":"Only signed in user is allowed to call APIs."}', { status: 403 }));
    const { fetch, calls } = fakeGitea({
      'GET /version': locked,
      // A Gitea release has no Forgejo namespace: with the token it answers 404.
      'GET /forgejo/version': (call) => (call.headers.authorization === 'token pat-1'
        ? new Response('Not found.', { status: 404 })
        : new Response('{"message":"Only signed in user is allowed to call APIs."}', { status: 403 })),
    });

    await expect(probeGiteaVersion({ origin: ORIGIN, token: 'pat-1', fetch })).resolves.toEqual({
      version: '1.27.3', supported: true, edition: 'gitea',
    });
    expect(calls.map((call) => [call.url.pathname, call.headers.authorization])).toEqual([
      ['/api/v1/version', undefined],
      ['/api/v1/version', 'token pat-1'],
      ['/api/forgejo/v1/version', undefined],
      ['/api/forgejo/v1/version', 'token pat-1'],
    ]);
  });

  it.each([401, 403])('leaves a locked instance unknown after %s when no token is offered', async (status) => {
    const { fetch, calls } = fakeGitea({
      'GET /version': () => new Response('{"message":"Only signed in user is allowed to call APIs."}', { status }),
    });

    await expect(probeGiteaVersion({ origin: ORIGIN, fetch })).resolves.toEqual({
      version: null, supported: true, edition: null,
    });
    expect(calls.map((call) => call.url.pathname)).toEqual(['/api/v1/version']);
  });

  it('fails a `/version` that is not a version answer', async () => {
    const { fetch } = fakeGitea({ 'GET /version': { message: 'hello' } });

    await expect(probeGiteaVersion({ origin: ORIGIN, fetch })).rejects.toMatchObject({ kind: 'provider-error' });
  });

  it.each([
    ['JSON null', () => Response.json(null)],
    ['HTTP 204', () => new Response(null, { status: 204 })],
  ])('rejects %s from `/version` with or without a token', async (_label, response) => {
    for (const token of [null, 'pat-1']) {
      const { fetch } = fakeGitea({ 'GET /version': response });
      await expect(probeGiteaVersion({ origin: ORIGIN, token, fetch })).rejects.toMatchObject({ kind: 'provider-error' });
    }
  });
});
