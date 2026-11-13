import { describe, expect, test } from 'bun:test';

import { changeRequestCopy } from '../changeRequestCopy';
import { formatChangeRequestLabel, formatChangeRequestReference } from './terminology';
import { acmeDescriptor, githubLikeDescriptor, gitlabLikeDescriptor } from './descriptor.fixture';

describe('source-control terminology', () => {
  test('labels a change request with its abbreviation only where issues share its prefix', () => {
    expect(formatChangeRequestLabel(githubLikeDescriptor(), 12)).toBe('PR #12');
    expect(formatChangeRequestLabel(gitlabLikeDescriptor(), 12)).toBe('!12');
    expect(formatChangeRequestReference(githubLikeDescriptor(), 12)).toBe('#12');
    expect(formatChangeRequestReference(gitlabLikeDescriptor(), 12)).toBe('!12');
    expect(formatChangeRequestLabel(acmeDescriptor(), 3)).toBe('PR #3');
  });

  test('chooses change-request copy by term', () => {
    expect(changeRequestCopy('gitView.pr.actions.createPr', 'mergeRequest')).toBe('gitView.mr.actions.createMr');
    expect(changeRequestCopy('gitView.pr.actions.createPr', 'pullRequest')).toBe('gitView.pr.actions.createPr');
    // A key without merge-request wording is itself for both terms.
    expect(changeRequestCopy('gitView.header.openRepository', 'mergeRequest')).toBe('gitView.header.openRepository');
  });
});
