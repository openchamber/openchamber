import { describe, expect, test } from 'bun:test';
import { dict } from '@/lib/i18n/messages/en';
import { changeRequestCopy, changeRequestCopyKeys } from './changeRequestCopy';
import { githubLikeDescriptor, gitlabLikeDescriptor } from './providers/descriptor.fixture';
import { changeRequestTermOfUrl, createRepositoryUrlMatcher } from './repositoryUrlMatcher';

describe('change request copy', () => {
  test('speaks of merge requests on GitLab and leaves every other host and message alone', () => {
    expect(dict[changeRequestCopy('gitView.pr.actions.createPr', 'mergeRequest')]).toBe('Create MR');
    expect(dict[changeRequestCopy('gitView.pr.history.merged', 'mergeRequest')]).toBe('MR !{number} was merged into {base}.');
    expect(changeRequestCopy('gitView.pr.actions.createPr', 'pullRequest')).toBe('gitView.pr.actions.createPr');
    expect(changeRequestCopy('gitView.pr.segment.checks', 'mergeRequest')).toBe('gitView.pr.segment.checks');
  });

  test('a pull request watch uses the term and the number prefix of its host', () => {
    expect(dict[changeRequestCopy('chat.prWatch.title', 'mergeRequest')]).toBe('Waiting on merge request !{number}');
    expect(dict[changeRequestCopy('chat.sessionNotice.pullRequest.title', 'mergeRequest')]).toBe('Merge request !{number}');
    expect(dict[changeRequestCopy('chat.sessionNotice.pullRequest.title', 'pullRequest')]).toBe('Pull request #{number}');
  });

  test('a link names the term of the provider it belongs to', () => {
    const urls = createRepositoryUrlMatcher([githubLikeDescriptor(), gitlabLikeDescriptor()], []);
    expect(changeRequestTermOfUrl('https://gitlab.com/acme/app/-/merge_requests/7', urls)).toBe('mergeRequest');
    expect(changeRequestTermOfUrl('https://github.com/acme/app/pull/7', urls)).toBe('pullRequest');
    expect(changeRequestTermOfUrl('https://example.com/acme/app/7', urls)).toBe('pullRequest');
  });

  test('speaks of changes on a review host', () => {
    expect(dict[changeRequestCopy('gitView.pr.history.merged', 'change')]).toBe('Change #{number} was submitted to {base}.');
    expect(changeRequestCopy('gitView.pr.segment.checks', 'change')).toBe('gitView.pr.segment.checks');
  });

  test('every term words every message another term words, with an existing message that keeps its values', () => {
    const terms = ['mergeRequest', 'change'] as const;
    const keys = new Set(terms.flatMap((term) => changeRequestCopyKeys(term)));
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const term of terms) {
      for (const key of keys) {
        const worded = changeRequestCopy(key, term);
        expect(`${term} ${key}: ${worded === key ? 'missing' : 'mapped'}`).toBe(`${term} ${key}: mapped`);
        expect(`${term} ${worded}: ${dict[worded] !== undefined}`).toBe(`${term} ${worded}: true`);
        // The component passes the pull-request message's values; the term's wording takes the same ones.
        expect(`${term} ${worded}: ${placeholders(dict[worded]).join(',')}`).toBe(`${term} ${worded}: ${placeholders(dict[key]).join(',')}`);
      }
    }
  });
});
