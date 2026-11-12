import { describe, expect, it, vi } from 'vitest';
import { classifyGerritFailure, createGerritClient } from './client.js';
import { fakeGerrit, fixtures, gerritBase64, ORIGIN, replay } from './fixtures/fake-fetch.js';

const noDelay = async () => {};
const basic = (login, password) => `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

describe('Gerrit client', () => {
  it('sends Basic credentials to the /a/ API only, never following redirects', async () => {
    const { fetch, calls } = fakeGerrit({ 'GET /accounts/self': fixtures.accountSelf });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'http-pw', fetch });

    await expect(client.get('/accounts/self')).resolves.toMatchObject({ _account_id: 1000096, username: 'alice' });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.href).toBe(`${ORIGIN}/a/accounts/self`);
    expect(calls[0].headers.authorization).toBe(basic('alice', 'http-pw'));
    expect(calls[0].redirect).toBe('manual');
  });

  it('reads anonymously without the /a/ prefix or any credentials', async () => {
    const { fetch, calls } = fakeGerrit({ 'GET /config/server/version': fixtures.version });
    const client = createGerritClient({ origin: ORIGIN, fetch });

    await expect(client.get('/config/server/version')).resolves.toBe('3.10.9');
    expect(calls[0].url.pathname).toBe('/config/server/version');
    expect(calls[0].headers.authorization).toBeUndefined();
    await expect(client.get('/a/accounts/self')).rejects.toThrow('leaves the instance API');
  });

  it('strips the XSSI line before parsing', async () => {
    const { fetch } = fakeGerrit({ 'GET /changes/': [{ _number: 1 }] });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch });
    await expect(client.get('/changes/')).resolves.toEqual([{ _number: 1 }]);
  });

  it('repeats an array query parameter', async () => {
    const { fetch, calls } = fakeGerrit({ 'GET /changes/': [] });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch });
    await client.get('/changes/', { q: 'project:platform/app', o: ['LABELS', 'MESSAGES'] });
    expect(calls[0].url.searchParams.getAll('o')).toEqual(['LABELS', 'MESSAGES']);
    expect(calls[0].url.searchParams.get('q')).toBe('project:platform/app');
  });

  it('decodes a base64 text answer', async () => {
    const { fetch } = fakeGerrit({ 'GET /changes/x~1/revisions/current/patch': () => gerritBase64(fixtures.patch) });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch });
    const patch = await client.base64('/changes/x~1/revisions/current/patch');
    expect(patch.toString('utf8')).toContain('diff --git a/src/login.js b/src/login.js');
  });

  it('refuses a redirect instead of sending the credentials on to its target', async () => {
    const { fetch, calls } = fakeGerrit({
      'GET /accounts/self': new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/collect' } }),
    });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch, delay: noDelay });

    await expect(client.get('/accounts/self')).rejects.toThrow('redirect');
    expect(calls).toHaveLength(1);
  });

  it('refuses a path that would leave the instance API before sending anything', async () => {
    const { fetch, calls } = fakeGerrit();
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch });

    await expect(client.get('../../plugins/x')).rejects.toThrow('leaves the instance API');
    await expect(client.get('changes/%2e%2e/%2e%2e/login')).rejects.toThrow('leaves the instance API');
    expect(calls).toHaveLength(0);
  });

  it('turns a plain-text refusal into its status and message', async () => {
    const { fetch } = fakeGerrit({ 'POST /changes/x~1/submit': () => replay(fixtures.errors.submitBlocked) });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch });

    const error = await client.post('/changes/x~1/submit').catch((failure) => failure);
    expect(error).toMatchObject({ status: 409, message: fixtures.errors.submitBlocked.body.trim(), kind: 'provider-error' });
  });

  it('takes the message of a JSON refusal from its error field', async () => {
    // 3.10 refuses an unknown reviewer with a 400 ReviewerResult; 3.8 answers the same with a 200.
    const { fetch } = fakeGerrit({ 'POST /changes/x~1/reviewers': () => replay(fixtures.errors.reviewerRefused) });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch });

    const error = await client.post('/changes/x~1/reviewers', { reviewer: '999' }).catch((failure) => failure);
    expect(error).toMatchObject({ status: 400, message: fixtures.reviewerRefused.error, kind: 'provider-error' });
  });

  it('retries a read after 502 and 429, but sends a write once', async () => {
    let reads = 0;
    const { fetch, calls } = fakeGerrit({
      'GET /accounts/self': () => {
        reads += 1;
        if (reads === 1) return new Response('bad gateway', { status: 502 });
        if (reads === 2) return new Response('slow down', { status: 429 });
        return fixtures.accountSelf;
      },
      'POST /changes/x~1/submit': new Response('bad gateway', { status: 502 }),
    });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch, delay: noDelay });

    await expect(client.get('/accounts/self')).resolves.toMatchObject({ username: 'alice' });
    await expect(client.post('/changes/x~1/submit')).rejects.toMatchObject({ status: 502 });
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  it('names a refused password and does not retry it', async () => {
    const { fetch, calls } = fakeGerrit({ 'GET /accounts/self': () => replay(fixtures.errors.unauthorized) });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'bad', fetch, delay: noDelay });

    const error = await client.get('/accounts/self').catch((failure) => failure);
    expect(error).toMatchObject({ status: 401, kind: 'invalid-token', message: 'Unauthorized' });
    expect(classifyGerritFailure(error)).toBe('invalid-token');
    expect(calls).toHaveLength(1);
  });

  it('pages changes by _more_changes and other lists by a full page', async () => {
    const { fetch, calls } = fakeGerrit({
      'GET /changes/': (call) => (call.url.searchParams.get('S') ? [{ _number: 3 }] : [{ _number: 1 }, { _number: 2, _more_changes: true }]),
      'GET /projects/p%2Fq/branches/': [{ ref: 'refs/heads/a' }, { ref: 'refs/heads/b' }],
    });
    const client = createGerritClient({ origin: ORIGIN, login: 'alice', password: 'pw', fetch });

    await expect(client.page('/changes/', { q: 'x' }, { limit: 2 })).resolves.toMatchObject({ hasMore: true });
    await expect(client.page('/changes/', { q: 'x' }, { start: 2, limit: 2 })).resolves.toMatchObject({ hasMore: false });
    expect(calls[1].url.searchParams.get('S')).toBe('2');
    expect(calls[1].url.searchParams.get('n')).toBe('2');
    await expect(client.page('/projects/p%2Fq/branches/', {}, { limit: 2, changes: false })).resolves.toMatchObject({ hasMore: true });
  });

  it('classifies network failures as unreachable', () => {
    expect(classifyGerritFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))).toBe('unreachable');
    expect(classifyGerritFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe('unreachable');
    expect(classifyGerritFailure(new Error('other'))).toBe('provider-error');
  });

  it('refuses an origin that is not normalized', () => {
    expect(() => createGerritClient({ origin: `${ORIGIN}/r`, fetch: vi.fn() })).toThrow('normalized instance origin');
  });
});
