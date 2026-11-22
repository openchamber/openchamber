import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearGitHubMetaCache, fetchGitHubRepoMetas, getGitHubMetaCacheSize, pruneExpiredGitHubMeta } from './github-meta.js';

const originalFetch = globalThis.fetch;

let tempDataDir;

beforeEach(() => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-meta-test-'));
  process.env.OPENCHAMBER_DATA_DIR = tempDataDir;
});

afterEach(() => {
  delete process.env.OPENCHAMBER_DATA_DIR;
  globalThis.fetch = originalFetch;
  clearGitHubMetaCache();
  vi.restoreAllMocks();
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

describe('fetchGitHubRepoMetas', () => {
  it('returns stars and pushed_at from the GitHub API', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ stargazers_count: 42, pushed_at: '2026-08-01T00:00:00Z' }),
      { status: 200 },
    ));
    globalThis.fetch = fetchMock;

    const metas = await fetchGitHubRepoMetas(['anthropics/skills']);

    expect(metas).toEqual({
      'anthropics/skills': { stars: 42, repoUpdatedAt: '2026-08-01T00:00:00Z' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves an over-cap response to null and failure-caches it', async () => {
    // Valid JSON padded past the 1 MiB cap: the bounded reader must reject
    // it during streaming, not buffer and parse it whole.
    const body = JSON.stringify({
      stargazers_count: 42,
      pushed_at: '2026-01-01T00:00:00Z',
      padding: 'x'.repeat(1024 * 1024),
    });
    const fetchMock = vi.fn(async () => new Response(body, { status: 200 }));
    globalThis.fetch = fetchMock;

    const metas = await fetchGitHubRepoMetas(['anthropics/skills']);
    expect(metas).toEqual({ 'anthropics/skills': null });

    // The failure entry is cached, so a second lookup does not refetch and
    // serves the null-meta failure value.
    const second = await fetchGitHubRepoMetas(['anthropics/skills']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ 'anthropics/skills': { stars: null, repoUpdatedAt: null } });
  });

  it('resolves failed lookups to null without throwing', async () => {
    globalThis.fetch = vi.fn(async () => new Response('rate limited', { status: 403 }));

    const metas = await fetchGitHubRepoMetas(['anthropics/skills']);

    expect(metas).toEqual({ 'anthropics/skills': null });
  });

  it('caches failed lookups briefly to avoid repeat hits', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 403 }));
    globalThis.fetch = fetchMock;

    await fetchGitHubRepoMetas(['anthropics/skills']);
    const second = await fetchGitHubRepoMetas(['anthropics/skills']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual({ 'anthropics/skills': { stars: null, repoUpdatedAt: null } });
  });

  it('deduplicates repositories', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ stargazers_count: 1, pushed_at: null }),
      { status: 200 },
    ));
    globalThis.fetch = fetchMock;

    const metas = await fetchGitHubRepoMetas(['a/b', 'a/b', null]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metas['a/b']).toEqual({ stars: 1, repoUpdatedAt: null });
  });

  it('serves live entries from memory without refetching', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ stargazers_count: 7, pushed_at: '2026-08-01T00:00:00Z' }),
      { status: 200 },
    ));
    globalThis.fetch = fetchMock;

    await fetchGitHubRepoMetas(['a/b']);
    const second = await fetchGitHubRepoMetas(['a/b']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second['a/b']).toEqual({ stars: 7, repoUpdatedAt: '2026-08-01T00:00:00Z' });
  });
});

describe('github-meta eviction', () => {
  it('sweeps expired entries without re-reading the same repo', async () => {
    const start = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      globalThis.fetch = vi.fn(async () => new Response(
        JSON.stringify({ stargazers_count: 1, pushed_at: null }),
        { status: 200 },
      ));

      await fetchGitHubRepoMetas(['a/b']);
      expect(getGitHubMetaCacheSize()).toBe(1);

      // Move past the 3-hour success TTL, then touch a different repo so the
      // sweep runs without anyone re-reading 'a/b'.
      nowSpy.mockReturnValue(start + 3 * 60 * 60 * 1000 + 1);
      await fetchGitHubRepoMetas(['c/d']);

      expect(getGitHubMetaCacheSize()).toBe(1);
      expect(pruneExpiredGitHubMeta()).toBe(1);
    } finally {
      nowSpy.mockRestore();
    }

    // After expiry, the stale repo misses the cache and refetches.
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ stargazers_count: 2, pushed_at: null }),
      { status: 200 },
    ));
    globalThis.fetch = fetchMock;
    const metas = await fetchGitHubRepoMetas(['a/b']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(metas['a/b']).toEqual({ stars: 2, repoUpdatedAt: null });
  });
});
