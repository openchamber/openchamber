import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invalidateRepoPullsCache, resolveGitHubPrStatus } from './pr-status.js';

const host = 'company.ghe.com';
const repo = (owner) => ({ owner, repo: 'app', host, url: `https://${host}/${owner}/app` });
let directory;
const git = (...args) => execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' });
const pull = (number, owner, name = 'app') => ({
  number, state: 'open', head: { ref: 'feature', repo: { owner: { login: owner }, name } },
});
const searchItem = (owner, number) => ({ number, repository_url: `https://api.${host}/repos/${owner}/app` });

const octokit = (items, pulls, identity) => {
  const get = vi.fn(async ({ owner, repo: name, pull_number }) => ({ data: pulls[`${owner}/${name}#${pull_number}`] }));
  const search = vi.fn(async () => ({ data: { items: items() } }));
  return {
    openChamberCacheIdentity: identity,
    rest: {
      repos: { get: async () => ({ data: { default_branch: 'main' } }) },
      pulls: {
        list: async ({ head }) => ({ data: head ? [] : Array.from({ length: 100 }, () => ({ head: { ref: 'other' } })) }),
        get,
      },
      search: { issuesAndPullRequests: search },
    },
  };
};
const resolve = (client, overrides = {}) => resolveGitHubPrStatus({
  octokit: client, directory, branch: 'feature', remoteName: 'origin', requestHost: host, force: true, ...overrides,
});

describe('GitHub PR search fallback', () => {
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-pr-fallback-'));
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')) vi.stubEnv(key, undefined);
    }
    const globalConfig = path.join(directory, 'gitconfig');
    await fs.writeFile(globalConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GH_HOST', host);
    git('init', '-q', '-b', 'feature');
    git('remote', 'add', 'origin', repo('team').url);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('ignores a same-named unrelated target, a different source and an unavailable source', async () => {
    const client = octokit(
      () => [searchItem('other-team', 8), searchItem('team', 9), searchItem('team', 11), searchItem('team', 10)],
      { 'other-team/app#8': pull(8, 'team'), 'team/app#9': pull(9, 'team', 'other'),
        'team/app#11': { number: 11, head: { ref: 'feature', label: 'team:feature', repo: null } }, 'team/app#10': pull(10, 'team') },
      'fallback-bound-repositories',
    );
    const result = await resolve(client);
    expect(result.pr?.number).toBe(10);
    expect(client.rest.pulls.get.mock.calls.map(([input]) => `${input.owner}/${input.repo}#${input.pull_number}`))
      .toEqual(['team/app#9', 'team/app#11', 'team/app#10']);
  });

  it('a search miss does not hide a same-named repository under another owner', async () => {
    let items = [];
    const client = octokit(() => items, { 'team-b/app#11': pull(11, 'team-b') }, 'fallback-miss-scope');
    git('remote', 'set-url', 'origin', repo('team-a').url);
    expect((await resolve(client)).pr).toBeNull();
    git('remote', 'set-url', 'origin', repo('team-b').url);
    items = [searchItem('team-b', 11)];
    expect((await resolve(client)).pr?.number).toBe(11);
    expect(client.rest.search.issuesAndPullRequests).toHaveBeenCalledTimes(2);
  });

  it('finds a contributor fork head only when it is the selected source', async () => {
    git('remote', 'add', 'fork', repo('alice').url);
    const client = octokit(
      () => [searchItem('team', 12), searchItem('team', 13)],
      { 'team/app#12': pull(12, 'other'), 'team/app#13': pull(13, 'alice') },
      'fallback-fork-source',
    );
    expect((await resolve(client, { sourceRemoteName: 'fork' })).pr?.number).toBe(13);
  });

  it('a miss from one source does not hide a different source on the same target', async () => {
    git('remote', 'add', 'fork', repo('alice').url);
    let items = [];
    const client = octokit(() => items, { 'team/app#14': pull(14, 'alice') }, 'fallback-miss-source');
    expect((await resolve(client, { sourceRemoteName: 'origin' })).pr).toBeNull();
    items = [searchItem('team', 14)];
    expect((await resolve(client, { sourceRemoteName: 'fork' })).pr?.number).toBe(14);
    expect(client.rest.search.issuesAndPullRequests).toHaveBeenCalledTimes(2);
  });

  it('invalidating a repository clears its remembered search miss', async () => {
    let items = [];
    const client = octokit(() => items, { 'team/app#15': pull(15, 'team') }, 'fallback-miss-invalidated');
    expect((await resolve(client)).pr).toBeNull();
    items = [searchItem('team', 15)];
    expect((await resolve(client)).pr).toBeNull();
    invalidateRepoPullsCache('team', 'app', client);
    expect((await resolve(client)).pr?.number).toBe(15);
    expect(client.rest.search.issuesAndPullRequests).toHaveBeenCalledTimes(2);
  });
});
