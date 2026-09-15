import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const createApp = (libraries) => {
  const app = express();
  registerGitHubRoutes(app, {
    getGitHubLibraries: async () => libraries,
  });
  return app;
};

const createOctokit = () => ({
  rest: {
    repos: {
      getCommit: vi.fn(),
    },
  },
});

const createGitHubLibraries = (overrides = {}) => ({
  clearGitHubAuth: vi.fn(),
  getOctokitOrNull: vi.fn(() => null),
  resolveGitHubRepoFromDirectory: vi.fn(),
  ...overrides,
});

const { registerGitHubRoutes } = await import('./routes.js');

describe('GET /api/github/commit/details', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('requires a directory', async () => {
    const libraries = createGitHubLibraries();

    const response = await request(createApp(libraries))
      .get('/api/github/commit/details')
      .query({ hash: 'abc1234' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'directory is required' });
  });

  it('rejects hashes outside the accepted git sha range', async () => {
    const libraries = createGitHubLibraries();

    const response = await request(createApp(libraries))
      .get('/api/github/commit/details')
      .query({ directory: '/repo', hash: 'not-a-sha' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'hash must be 7 to 64 hexadecimal characters' });
  });

  it('returns disconnected when no GitHub client is available', async () => {
    const libraries = createGitHubLibraries();

    const response = await request(createApp(libraries))
      .get('/api/github/commit/details')
      .query({ directory: '/repo', hash: 'abc1234' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
  });

  it('returns a connected null result for non-GitHub remotes', async () => {
    const octokit = createOctokit();
    const libraries = createGitHubLibraries({
      getOctokitOrNull: vi.fn(() => octokit),
      resolveGitHubRepoFromDirectory: vi.fn().mockResolvedValue({ repo: null }),
    });

    const response = await request(createApp(libraries))
      .get('/api/github/commit/details')
      .query({ directory: '/repo', hash: 'abc1234', remote: 'sourcehut' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: true, url: null, author: null });
    expect(octokit.rest.repos.getCommit).not.toHaveBeenCalled();
  });

  it('maps commit author details from the GitHub commit payload', async () => {
    const octokit = createOctokit();
    const libraries = createGitHubLibraries({
      getOctokitOrNull: vi.fn(() => octokit),
      resolveGitHubRepoFromDirectory: vi.fn().mockResolvedValue({
        repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
      }),
    });
    octokit.rest.repos.getCommit.mockResolvedValue({
      data: {
        html_url: 'https://github.com/acme/app/commit/abc1234',
        author: {
          login: 'octocat',
          id: 1,
          avatar_url: 'https://avatars.githubusercontent.com/u/1',
        },
        commit: {
          author: {
            name: 'Mona Lisa Octocat',
            email: 'mona@example.com',
          },
        },
      },
    });

    const response = await request(createApp(libraries))
      .get('/api/github/commit/details')
      .query({ directory: '/repo', hash: 'abc1234', remote: 'origin' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      connected: true,
      url: 'https://github.com/acme/app/commit/abc1234',
      author: {
        login: 'octocat',
        id: 1,
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
        name: 'Mona Lisa Octocat',
        email: 'mona@example.com',
      },
    });
    expect(octokit.rest.repos.getCommit).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'app',
      ref: 'abc1234',
    });
  });

  it('preserves a null GitHub author when the commit is not linked to an account', async () => {
    const octokit = createOctokit();
    const libraries = createGitHubLibraries({
      getOctokitOrNull: vi.fn(() => octokit),
      resolveGitHubRepoFromDirectory: vi.fn().mockResolvedValue({
        repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
      }),
    });
    octokit.rest.repos.getCommit.mockResolvedValue({
      data: {
        html_url: 'https://github.com/acme/app/commit/abc1234',
        author: null,
        commit: {
          author: {
            name: 'Someone Else',
            email: 'someone@example.com',
          },
        },
      },
    });

    const response = await request(createApp(libraries))
      .get('/api/github/commit/details')
      .query({ directory: '/repo', hash: 'abc1234' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      connected: true,
      url: 'https://github.com/acme/app/commit/abc1234',
      author: null,
    });
  });

  it.each([401, 403])('clears auth and returns disconnected on invalid auth status %s', async (status) => {
    const octokit = createOctokit();
    const libraries = createGitHubLibraries({
      clearGitHubAuth: vi.fn(),
      getOctokitOrNull: vi.fn(() => octokit),
      resolveGitHubRepoFromDirectory: vi.fn().mockResolvedValue({
        repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
      }),
    });
    octokit.rest.repos.getCommit.mockRejectedValue({ status, message: 'invalid token' });

    const response = await request(createApp(libraries))
      .get('/api/github/commit/details')
      .query({ directory: '/repo', hash: 'abc1234' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: false });
    expect(libraries.clearGitHubAuth).toHaveBeenCalledTimes(1);
  });

  it('returns a connected null result on 404 without clearing auth', async () => {
    const octokit = createOctokit();
    const libraries = createGitHubLibraries({
      clearGitHubAuth: vi.fn(),
      getOctokitOrNull: vi.fn(() => octokit),
      resolveGitHubRepoFromDirectory: vi.fn().mockResolvedValue({
        repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
      }),
    });
    octokit.rest.repos.getCommit.mockRejectedValue({ status: 404, message: 'not found' });

    const response = await request(createApp(libraries))
      .get('/api/github/commit/details')
      .query({ directory: '/repo', hash: 'abc1234' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ connected: true, url: null, author: null });
    expect(libraries.clearGitHubAuth).not.toHaveBeenCalled();
  });
});
