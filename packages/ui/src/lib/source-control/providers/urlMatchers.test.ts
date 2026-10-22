import { describe, expect, test } from 'bun:test';

import { parseRepositoryItemUrl } from './urlMatchers';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from './descriptor.fixture';

const github = githubLikeDescriptor();
const gitlab = gitlabLikeDescriptor();
const acme = acmeDescriptor();
const registry = [github, gitlab, acme];

describe('parseRepositoryItemUrl', () => {
  test('reads github.com issues and pull requests, with anything after the number', () => {
    expect(parseRepositoryItemUrl('https://github.com/acme/app/pull/12/files', registry, [])).toEqual({
      provider: 'github', instance: 'github.com', owner: 'acme', repo: 'app', number: 12, kind: 'pull',
    });
    expect(parseRepositoryItemUrl('https://GitHub.com/acme/app/issues/7#issuecomment-1', registry, [])).toMatchObject({
      provider: 'github', instance: 'github.com', kind: 'issue', number: 7,
    });
  });

  test('reads www. in front of a default instance as that instance', () => {
    expect(parseRepositoryItemUrl('https://www.github.com/acme/app/pull/12', registry, [])).toMatchObject({ provider: 'github', instance: 'github.com' });
    expect(parseRepositoryItemUrl('https://www.gitlab.com/g/p/-/issues/3', registry, [])).toMatchObject({ provider: 'gitlab', instance: 'https://gitlab.com' });
    expect(parseRepositoryItemUrl('https://www.forge.example.com/org/tool/pulls/1', registry, [])).toMatchObject({ provider: 'acme', instance: 'https://www.forge.example.com' });
  });

  test('reads a GitHub Enterprise host as its own instance', () => {
    expect(parseRepositoryItemUrl('https://ghe.example.com/team/svc/pull/3', registry, [{ provider: 'github', instance: 'ghe.example.com' }]))
      .toEqual({ provider: 'github', instance: 'ghe.example.com', owner: 'team', repo: 'svc', number: 3, kind: 'pull' });
  });

  test('reads nested GitLab namespaces, merge requests and work items', () => {
    expect(parseRepositoryItemUrl('https://gitlab.com/group/sub/project/-/merge_requests/5/diffs', registry, [])).toEqual({
      provider: 'gitlab', instance: 'https://gitlab.com', owner: 'group/sub', repo: 'project', number: 5, kind: 'pull',
    });
    expect(parseRepositoryItemUrl('https://gitlab.example.com:8443/g/p/-/work_items/9', registry, [])).toMatchObject({
      provider: 'gitlab', instance: 'https://gitlab.example.com:8443', owner: 'g', repo: 'p', number: 9, kind: 'issue',
    });
  });

  test('reads a provider the UI has no code for from its own patterns', () => {
    expect(parseRepositoryItemUrl('https://forge.example.com/org/tool/pulls/41', registry, [])).toEqual({
      provider: 'acme', instance: 'https://forge.example.com', owner: 'org', repo: 'tool', number: 41, kind: 'pull',
    });
  });

  test('prefers the provider whose instance the host is known to be', () => {
    const link = 'https://forge.example.com/org/tool/issues/2';
    // Both GitHub's and Acme's issue patterns match; with no known instance the first by order wins.
    expect(parseRepositoryItemUrl(link, registry, [])?.provider).toBe('github');
    expect(parseRepositoryItemUrl(link, registry, [{ provider: 'acme', instance: 'https://forge.example.com' }])).toMatchObject({
      provider: 'acme', instance: 'https://forge.example.com', kind: 'issue', number: 2,
    });
    // A default instance counts as known without a connected account.
    expect(parseRepositoryItemUrl('https://github.com/a/b/issues/1', [acme, github], [])?.provider).toBe('github');
  });

  test('reads nothing from links that name no item, and ignores invalid patterns', () => {
    expect(parseRepositoryItemUrl('https://github.com/acme/app', registry, [])).toBeNull();
    expect(parseRepositoryItemUrl('not a url', registry, [])).toBeNull();
    expect(parseRepositoryItemUrl('ftp://github.com/acme/app/pull/1', registry, [])).toBeNull();
    const broken = acmeDescriptor({ id: 'broken', urls: { changeRequest: ['/{owner}/{project}/pull/{number}', '/{repo}/{number}'], issue: [] } });
    expect(parseRepositoryItemUrl('https://x.example/a/b/pull/1', [broken], [])).toBeNull();
  });
});
