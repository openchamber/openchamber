import { describe, expect, test } from 'bun:test';
import { dict } from '@/lib/i18n/messages/en';
import { changeRequestCopy } from './changeRequestCopy';

describe('change request copy', () => {
  test('speaks of merge requests on GitLab and leaves every other host and message alone', () => {
    expect(dict[changeRequestCopy('gitView.pr.actions.createPr', 'mergeRequest')]).toBe('Create MR');
    expect(dict[changeRequestCopy('gitView.pr.history.merged', 'mergeRequest')]).toBe('MR !{number} was merged into {base}.');
    expect(changeRequestCopy('gitView.pr.actions.createPr', 'pullRequest')).toBe('gitView.pr.actions.createPr');
    expect(changeRequestCopy('gitView.pr.segment.checks', 'mergeRequest')).toBe('gitView.pr.segment.checks');
  });
});
