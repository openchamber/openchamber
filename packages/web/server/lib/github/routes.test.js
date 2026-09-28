import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { registerGitHubRoutes } from './routes.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-github-pulls-'));
const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
const repository = path.join(testDir, 'project');
const issue = (number) => ({ number, repository_url: 'https://api.github.com/repos/example/project' });
const pull = (number) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/example/project/pull/${number}`,
  state: 'open',
  base: { ref: 'main' },
  head: { ref: `branch-${number}`, sha: `sha-${number}` },
});

const response = (data, status = 200) => Response.json(data, { status });

describe('GET /api/github/pulls/list free-text search', () => {
  let app;

  beforeAll(async () => {
    process.env.OPENCHAMBER_DATA_DIR = testDir;
    fs.mkdirSync(repository);
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['-C', repository, 'remote', 'add', 'origin', 'https://github.com/example/project.git']);
    const { setGitHubAuth, setGhCliDisabled } = await import('./auth.js');
    setGhCliDisabled(true);
    setGitHubAuth({ accessToken: 'fake-test-token', accountId: 'test' });
    app = express();
    registerGitHubRoutes(app);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  const search = () => request(app).get('/api/github/pulls/list').query({ directory: repository, query: 'fix' });

  const serveGitHub = ({ numbers = [1, 2], failPulls = [], failSearch = false, networkFailure = false } = {}) => {
    const fetch = vi.fn(async (url) => {
      const endpoint = new URL(url);
      if (endpoint.pathname === '/repos/example/project') return response({ full_name: 'example/project' });
      if (endpoint.pathname === '/search/issues') {
        if (failSearch) return response({ message: 'GitHub search unavailable' }, 503);
        return response({ total_count: numbers.length, items: numbers.map(issue) });
      }
      const pullNumber = Number(endpoint.pathname.match(/^\/repos\/example\/project\/pulls\/(\d+)$/)?.[1]);
      if (pullNumber) {
        if (networkFailure && failPulls.includes(pullNumber)) throw new Error('Network unavailable');
        if (failPulls.includes(pullNumber)) return response({ message: 'GitHub enrichment unavailable' }, 503);
        return response(pull(pullNumber));
      }
      throw new Error(`Unexpected GitHub request: ${endpoint.pathname}`);
    });
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };

  it('returns all complete PR summaries in search order', async () => {
    serveGitHub();
    const result = await search().expect(200);
    expect(result.body.prs.map((pr) => ({ number: pr.number, base: pr.base, head: pr.head }))).toEqual([
      { number: 1, base: 'main', head: 'branch-1' },
      { number: 2, base: 'main', head: 'branch-2' },
    ]);
    expect(result.body.hasMore).toBe(false);
  });

  it('rejects the page rather than dropping one failed enrichment', async () => {
    const fetch = serveGitHub({ failPulls: [2] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await search().expect(500);
    expect(result.body).toEqual({ error: 'GitHub enrichment unavailable' });
    expect(result.body).not.toHaveProperty('prs');
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/pulls/1'))).toBe(true);
  });

  it('rejects when every enrichment fails instead of returning an empty success', async () => {
    serveGitHub({ failPulls: [1, 2] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await search().expect(500);
    expect(result.body).toEqual({ error: 'GitHub enrichment unavailable' });
  });

  it('propagates a failed network request without returning a partial page', async () => {
    serveGitHub({ failPulls: [2], networkFailure: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await search().expect(500)).body).toEqual({ error: 'Network unavailable' });
  });

  it('still returns a genuinely empty search and propagates search-level errors', async () => {
    serveGitHub({ numbers: [] });
    expect((await search().expect(200)).body.prs).toEqual([]);
    serveGitHub({ failSearch: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await search().expect(500)).body.error).toBe('GitHub search unavailable');
  });
});
