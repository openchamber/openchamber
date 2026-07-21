import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as npm from './npm-registry.js';

const originalFetch = globalThis.fetch;
const originalDateNow = Date.now;

let fetchMock;

function jsonResponse(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }));
}

describe('npm registry client', () => {
  beforeEach(() => {
    npm.clearCache();
    Date.now = originalDateNow;
    fetchMock = mock(() => jsonResponse({}));
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    npm.clearCache();
    globalThis.fetch = originalFetch;
    Date.now = originalDateNow;
  });

  test('200 success returns latest versions and dist tags', async () => {
    fetchMock.mockImplementation(() => jsonResponse({
      'dist-tags': { latest: '1.2.0' },
      versions: { '1.0.0': {}, '1.2.0': {} },
    }));

    const result = await npm.lookupNpmPackage('foo');

    expect(result).toEqual({
      ok: true,
      latest: '1.2.0',
      versions: ['1.0.0', '1.2.0'],
      distTags: { latest: '1.2.0' },
    });
  });

  test('200 success handles missing dist-tags and versions', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}));

    const result = await npm.lookupNpmPackage('foo');

    expect(result).toEqual({ ok: true, latest: null, versions: [], distTags: {} });
  });

  test('404 returns package not found', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}, 404));

    const result = await npm.lookupNpmPackage('missing');

    expect(result).toEqual({ ok: false, status: 404, error: 'Package not found' });
  });

  test('500 returns registry error', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}, 500));

    const result = await npm.lookupNpmPackage('foo');

    expect(result).toEqual({ ok: false, status: 500, error: 'Registry returned 500' });
  });

  test('network error returns network status', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('socket closed')));

    const result = await npm.lookupNpmPackage('foo');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('network');
    expect(result.error).toBe('socket closed');
  });

  test('timeout plumbs AbortSignal to fetch', async () => {
    fetchMock.mockImplementation((_url, init) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
    });

    const result = await npm.lookupNpmPackage('foo');

    expect(result.ok).toBe(false);
    expect(result.status).toBe('network');
    expect(result.error).toContain('aborted');
  });

  test('cache hit reuses definitive success', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } }));

    const first = await npm.getNpmInfo('foo');
    const second = await npm.getNpmInfo('foo');

    expect(first).toEqual(second);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('cache miss after ttl fetches again', async () => {
    let now = 1_000;
    Date.now = mock(() => now);
    fetchMock.mockImplementation(() => jsonResponse({ versions: {} }));

    await npm.getNpmInfo('foo');
    now += 3_600_001;
    await npm.getNpmInfo('foo');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('forceRefresh bypasses cache', async () => {
    fetchMock.mockImplementation(() => jsonResponse({ versions: {} }));

    await npm.getNpmInfo('foo');
    await npm.getNpmInfo('foo', { forceRefresh: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('in-flight requests dedup by package name', async () => {
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    fetchMock.mockImplementation(async () => {
      await wait;
      return new Response(JSON.stringify({ versions: { '1.0.0': {} } }), { status: 200 });
    });

    const requests = Promise.all([
      npm.getNpmInfo('foo'),
      npm.getNpmInfo('foo'),
      npm.getNpmInfo('foo'),
    ]);
    release();
    const results = await requests;

    expect(results.every((result) => result.ok)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('network failure is not cached', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new Error('down')))
      .mockImplementationOnce(() => jsonResponse({ versions: {} }));

    const first = await npm.getNpmInfo('foo');
    const second = await npm.getNpmInfo('foo');

    expect(first.status).toBe('network');
    expect(second.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('404 is cached', async () => {
    fetchMock.mockImplementation(() => jsonResponse({}, 404));

    await npm.getNpmInfo('missing');
    await npm.getNpmInfo('missing');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('scoped names encode slash in registry url', async () => {
    await npm.getNpmInfo('@scope/pkg');

    expect(fetchMock.mock.calls[0][0]).toBe('https://registry.npmjs.org/@scope%2Fpkg');
  });

  test('configured registry base is used and trailing-slash trimmed', async () => {
    const previous = process.env.NPM_CONFIG_REGISTRY;
    process.env.NPM_CONFIG_REGISTRY = 'https://mirror.example.com/npm/';
    try {
      await npm.getNpmInfo('@scope/pkg');

      expect(fetchMock.mock.calls[0][0]).toBe('https://mirror.example.com/npm/@scope%2Fpkg');
    } finally {
      if (previous === undefined) delete process.env.NPM_CONFIG_REGISTRY;
      else process.env.NPM_CONFIG_REGISTRY = previous;
    }
  });

  test('user-agent header is present', async () => {
    await npm.getNpmInfo('foo');

    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toMatch(/^openchamber-server\//);
  });
});
