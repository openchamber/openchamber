import { describe, expect, test } from 'bun:test';

import { githubLikeDescriptor, gitlabLikeDescriptor } from './providers/descriptor.fixture';
import {
  commitShaOfUrl,
  repositoryCommitLink,
  repositoryItemLink,
  repositoryUserLink,
  type RepositoryLinkContext,
} from './repositoryLinks';

const github: RepositoryLinkContext = { descriptor: githubLikeDescriptor(), origin: 'https://github.com', owner: 'acme', repo: 'app' };
const gitlab: RepositoryLinkContext = { descriptor: gitlabLikeDescriptor(), origin: 'https://gitlab.example.com', owner: 'group/sub', repo: 'app' };

describe('repository links', () => {
  test('build item, commit and user pages from the provider patterns', () => {
    expect(repositoryItemLink(github, 'issue', 12)).toBe('https://github.com/acme/app/issues/12');
    expect(repositoryItemLink(github, 'issue', 3, { owner: 'other', repo: 'lib' })).toBe('https://github.com/other/lib/issues/3');
    expect(repositoryItemLink(gitlab, 'pull', 7)).toBe('https://gitlab.example.com/group/sub/app/-/merge_requests/7');
    expect(repositoryCommitLink(gitlab, 'abc1234')).toBe('https://gitlab.example.com/group/sub/app/-/commit/abc1234');
    expect(repositoryUserLink(github, 'octo-cat')).toBe('https://github.com/octo-cat');
  });

  test('a provider without commit or user patterns gets no such links', () => {
    const bare = { ...github, descriptor: { ...github.descriptor, urls: { ...github.descriptor.urls, commit: [], user: [] } } };
    expect(repositoryCommitLink(bare, 'abc1234')).toBeNull();
    expect(repositoryUserLink(bare, 'someone')).toBeNull();
  });

  test('reads the commit a commit page names, and nothing from other pages', () => {
    const descriptors = [githubLikeDescriptor(), gitlabLikeDescriptor()];
    expect(commitShaOfUrl('https://github.com/acme/app/commit/ABC1234def', descriptors)).toBe('abc1234def');
    expect(commitShaOfUrl('https://gitlab.example.com/group/sub/app/-/commit/0123abc/diffs', descriptors)).toBe('0123abc');
    expect(commitShaOfUrl('https://github.com/acme/app/pull/12', descriptors)).toBeNull();
    expect(commitShaOfUrl('https://github.com/acme/app/commit/main', descriptors)).toBeNull();
    expect(commitShaOfUrl('not a url', descriptors)).toBeNull();
  });
});
