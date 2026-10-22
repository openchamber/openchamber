import { describe, expect, test } from 'bun:test';

import { getRepositoryThreadRef } from '@/lib/linkedIssues';
import { trackedItemKey } from '@/lib/trackedItems/model';
import { joinProjectPath, splitProjectPath } from './projectPath';
import { changeHostDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from './providers/descriptor.fixture';
import { sourceControlProviderListSchema } from './providers/descriptor';
import { parseRepositoryItemUrl } from './providers/urlMatchers';
import { repositoryLinkFromRemotes } from './repositoryUrl';
import { createRepositoryUrlMatcher } from './repositoryUrlMatcher';

const github = githubLikeDescriptor();
const gitlab = gitlabLikeDescriptor();
const review = changeHostDescriptor();
const registry = [github, gitlab, review];
const reviewInstance = { provider: 'review-host', instance: 'https://review.example.com' };

describe('project paths', () => {
  test('split on the last slash and join back, a top-level project with the empty owner', () => {
    for (const path of ['tools', 'platform/build', 'a/b/c']) {
      const { owner, repo } = splitProjectPath(path);
      expect(joinProjectPath(owner, repo)).toBe(path);
    }
    expect(splitProjectPath('tools')).toEqual({ owner: '', repo: 'tools' });
    expect(splitProjectPath('a/b/c')).toEqual({ owner: 'a/b', repo: 'c' });
    expect(joinProjectPath('acme', 'app')).toBe('acme/app');
  });

  test('a {project+} pattern reads the whole project path, top level or nested', () => {
    expect(parseRepositoryItemUrl('https://review.example.com/c/tools/+/42', registry, [reviewInstance])).toEqual({
      provider: 'review-host', instance: 'https://review.example.com', owner: '', repo: 'tools', number: 42, kind: 'pull',
    });
    expect(parseRepositoryItemUrl('https://review.example.com/c/platform/build/+/42/3', registry, [reviewInstance]))
      .toMatchObject({ owner: 'platform', repo: 'build', number: 42 });
  });

  test('the descriptor keeps pathStyle where published and leaves it out elsewhere', () => {
    const [parsedReview, parsedGitlab] = sourceControlProviderListSchema.parse([review, gitlab]).sort((a, b) => b.order - a.order);
    expect(parsedReview?.repository.pathStyle).toBe('path');
    expect(parsedGitlab?.repository.pathStyle).toBeUndefined();
    const [unknownValue] = sourceControlProviderListSchema.parse([{ ...gitlab, repository: { nestedNamespaces: true, pathStyle: 'tree' } }]);
    expect(unknownValue?.repository.pathStyle).toBeUndefined();
  });

  test('a top-level project links only on a path-style provider', () => {
    const remotes = (url: string) => [{ name: 'origin', fetchUrl: url, pushUrl: url }];
    expect(repositoryLinkFromRemotes(remotes('https://review.example.com/tools.git'), [reviewInstance], registry))
      .toEqual({ provider: 'review-host', url: 'https://review.example.com/tools' });
    expect(repositoryLinkFromRemotes(remotes('https://gitlab.com/tools.git'), [], registry)).toBeNull();
  });

  test('thread keys read exactly as before for owner/name projects, and by the path for a top-level one', () => {
    const matcher = createRepositoryUrlMatcher(registry, [reviewInstance]);
    const entry = (url: string, number: number) => ({ kind: 'pull' as const, id: url, url, number, title: 't', linkedAt: 0 });
    expect(getRepositoryThreadRef(entry('https://github.com/Acme/App/pull/12', 12), matcher)?.key).toBe('github|github.com|acme/app|pull#12');
    expect(getRepositoryThreadRef(entry('https://gitlab.com/g/s/p/-/merge_requests/3', 3), matcher)?.key).toBe('gitlab|https://gitlab.com|g/s/p|pull#3');
    expect(getRepositoryThreadRef(entry('https://review.example.com/c/tools/+/42', 42), matcher)?.key).toBe('review-host|https://review.example.com|tools|pull#42');

    expect(trackedItemKey({ provider: 'github', instance: 'github.com', kind: 'pull', owner: 'Acme', repo: 'App', number: 12 })).toBe('github|github.com|pull|acme/app#12');
    expect(trackedItemKey({ provider: 'review-host', instance: 'https://review.example.com', kind: 'pull', owner: '', repo: 'tools', number: 42 }))
      .toBe('review-host|https://review.example.com|pull|tools#42');
  });
});
