import { describe, expect, mock, test } from 'bun:test';
import { vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'bun:test';

// A checkout with two remotes that resolve to the same owner/repo but on
// different hosts — a contributor fork networked with a github.com checkout
// while the request itself goes to an enterprise instance (or vice versa).
// resolveGitHubPrStatus is scoped to one host (the octokit's), so the other
// host's same-named repo must never be touched: no metadata fetch, no PR list.

const reposGet = mock(async () => ({
  data: { id: 1, full_name: 'acme/app', default_branch: 'main', owner: { login: 'acme' }, name: 'app', html_url: 'https://github.com/acme/app' },
}));
const pullsList = mock(async () => ({ data: [] }));

// Mocks use `vi.mock` (not the bun:test shim's `mock.module`): vitest only
// hoists mocks it recognizes as `vi.mock(...)`, and a `mock.module` on a
// relative path runs the real module under vitest. These factories are
// self-contained so vitest's factory hoisting is safe.
vi.mock('../git/index.js', () => ({
  getRemotes: async () => [{ name: 'origin' }, { name: 'upstream' }],
  getTrackingBranch: async () => null,
}));

vi.mock('./repo/index.js', () => ({
  resolveGitHubRepoFromDirectory: async (_directory, remoteName) => {
    if (remoteName === 'origin') {
      return { repo: { owner: 'acme', repo: 'app', host: 'github.com', url: 'https://github.com/acme/app' } };
    }
    if (remoteName === 'upstream') {
      return { repo: { owner: 'acme', repo: 'app', host: 'github.example.com', url: 'https://github.example.com/acme/app' } };
    }
    return null;
  },
}));

vi.mock('./rate-limit.js', () => ({
  noteIfGitHubRateLimit: () => {},
}));

const { resolveGitHubPrStatus } = await import('./pr-status.js');

describe('resolveGitHubPrStatus host scoping', () => {
  let tempDir;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-pr-host-'));
    reposGet.mockClear();
    pullsList.mockClear();
  });
  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('only queries the request host: the same-named other-host remote is never fetched', async () => {
    const result = await resolveGitHubPrStatus({
      octokit: {
        rest: {
          repos: { get: reposGet },
          pulls: { list: pullsList },
          search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
        },
      },
      directory: tempDir,
      branch: 'feature',
      remoteName: 'origin',
    });

    // The ranked-first remote is 'origin' (github.com), so the request is
    // scoped to github.com. The upstream remote resolves to the same
    // owner/repo on github.example.com and must be filtered out — if it were
    // expanded, its metadata fetch would be a third repos.get call.
    expect(result.repo).toEqual(expect.objectContaining({ owner: 'acme', repo: 'app', host: 'github.com' }));
    expect(result.resolvedRemoteName).toBe('origin');
    // A single metadata fetch for the request host (the default branch is
    // served from that cached metadata). A second same-named repo on another
    // host is never touched.
    expect(reposGet.mock.calls).toHaveLength(1);
  });

  test('scopes to the enterprise host when the request names the enterprise remote', async () => {
    const result = await resolveGitHubPrStatus({
      octokit: {
        rest: {
          repos: { get: reposGet },
          pulls: { list: pullsList },
          search: { issuesAndPullRequests: async () => ({ data: { items: [] } }) },
        },
      },
      directory: tempDir,
      branch: 'feature',
      remoteName: 'upstream',
    });

    expect(result.repo).toEqual(expect.objectContaining({ owner: 'acme', repo: 'app', host: 'github.example.com' }));
    expect(result.resolvedRemoteName).toBe('upstream');
    // github.com acme/app must not be re-fetched under the GHE request.
    expect(reposGet.mock.calls).toHaveLength(1);
  });
});
