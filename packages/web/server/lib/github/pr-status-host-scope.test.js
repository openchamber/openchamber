import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A checkout with two remotes that resolve to the same owner/repo but on
// different hosts — a contributor fork networked with a github.com checkout
// while the request itself goes to an enterprise instance (or vice versa).
// resolveGitHubPrStatus is scoped to one host (the octokit's), so the other
// host's same-named repo must never be touched: no metadata fetch, no PR list.
// github.example.com is trusted the way a stored gh login trusts a host: a
// GH_CONFIG_DIR hosts.yml in this test's own config dir.

const reposGet = mock(async () => ({
  data: { id: 1, full_name: 'acme/app', default_branch: 'main', owner: { login: 'acme' }, name: 'app', html_url: 'https://github.com/acme/app' },
}));
const pullsList = mock(async () => ({ data: [] }));

const git = (directory, ...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' });

const { resolveGitHubPrStatus } = await import('./pr-status.js');

describe('resolveGitHubPrStatus host scoping', () => {
  let tempDir;
  let ghConfigDir;
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-pr-host-'));
    ghConfigDir = mkdtempSync(join(tmpdir(), 'oc-pr-host-config-'));
    writeFileSync(join(ghConfigDir, 'hosts.yml'), 'github.example.com:\n  user: ghe-user\n  oauth_token: gho_ghe\n');
    process.env.GH_CONFIG_DIR = ghConfigDir;
    git(tempDir, 'init');
    git(tempDir, 'remote', 'add', 'origin', 'https://github.com/acme/app');
    git(tempDir, 'remote', 'add', 'upstream', 'https://github.example.com/acme/app');
    reposGet.mockClear();
    pullsList.mockClear();
  });
  afterEach(() => {
    delete process.env.GH_CONFIG_DIR;
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(ghConfigDir, { recursive: true, force: true });
  });

  const resolveWith = (overrides = {}) => resolveGitHubPrStatus({
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
    ...overrides,
  });

  test('only queries the request host: the same-named other-host remote is never fetched', async () => {
    const result = await resolveWith({ requestHost: 'github.com' });

    // The route pinned the octokit to github.com, so the request is scoped to
    // github.com. The upstream remote resolves to the same owner/repo on
    // github.example.com and must be filtered out — if it were expanded, its
    // metadata fetch would be a third repos.get call.
    expect(result.repo).toEqual(expect.objectContaining({ owner: 'acme', repo: 'app', host: 'github.com' }));
    expect(result.resolvedRemoteName).toBe('origin');
    // A single metadata fetch for the request host (the default branch is
    // served from that cached metadata). A second same-named repo on another
    // host never shares cached state.
    expect(reposGet.mock.calls).toHaveLength(1);
  });

  test('scopes to the enterprise host when the request names the enterprise remote', async () => {
    const result = await resolveWith({ remoteName: 'upstream', requestHost: 'github.example.com' });

    expect(result.repo).toEqual(expect.objectContaining({ owner: 'acme', repo: 'app', host: 'github.example.com' }));
    expect(result.resolvedRemoteName).toBe('upstream');
    // github.com acme/app must not be re-fetched under the GHE request.
    expect(reposGet.mock.calls).toHaveLength(1);
  });

  test('uses the route-passed request host when the explicit remote does not resolve', async () => {
    // The explicit remote fails to resolve (the route got repo: null for it —
    // a host it never authenticated with), leaving only a lower-ranked remote
    // that resolves on a different host. The route passes the host it pinned
    // the octokit to (github.com), so the other-host target is filtered out
    // and the resolver fails safe to repo: null instead of querying the wrong
    // host through the wrong octokit.
    git(tempDir, 'remote', 'remove', 'origin');

    const result = await resolveWith({ requestHost: 'github.com' });

    expect(result.repo).toBeNull();
    // The github.example.com target was the only resolvable one, and it is the
    // wrong host for this octokit, so no GitHub call happens.
    expect(reposGet).not.toHaveBeenCalled();
  });
});
