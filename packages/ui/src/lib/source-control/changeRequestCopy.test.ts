import { describe, expect, test } from 'bun:test';
import { dict } from '@/lib/i18n/messages/en';
import { changeRequestCopy } from './changeRequestCopy';

describe('change request copy', () => {
  test('speaks of merge requests on GitLab and leaves every other host and message alone', () => {
    expect(dict[changeRequestCopy('gitView.pr.actions.createPr', 'gitlab')]).toBe('Create MR');
    expect(dict[changeRequestCopy('gitView.pr.history.merged', 'gitlab')]).toBe('MR !{number} was merged into {base}.');
    expect(changeRequestCopy('gitView.pr.actions.createPr', 'github')).toBe('gitView.pr.actions.createPr');
    expect(changeRequestCopy('gitView.pr.actions.createPr', null)).toBe('gitView.pr.actions.createPr');
    expect(changeRequestCopy('gitView.pr.segment.checks', 'gitlab')).toBe('gitView.pr.segment.checks');
  });
});
