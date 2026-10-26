import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearGitHubMetaCache, fetchGitHubRepoMetas } from './github-meta.js';

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
});
