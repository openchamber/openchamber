import { describe, expect, test } from 'bun:test';
import type { GitHubChecksSummary } from '@/lib/api/types';

import { getPullRequestChecksText, getWorkStatusChecksPresentation } from './checksSummaryPresentation';

const unknownChecks: GitHubChecksSummary = {
  state: 'unknown',
  total: 100,
  success: 100,
  failure: 0,
  pending: 0,
};

describe('checks summary presentation', () => {
  test('unknown incomplete summaries never render a work-status passed count', () => {
    expect(getWorkStatusChecksPresentation(unknownChecks)).toBeNull();
  });

  test('unknown summaries render their state in the pull request header, not a partial count', () => {
    expect(getPullRequestChecksText(unknownChecks, 'checks')).toBe('unknown checks');
  });

  test('known successful summaries retain their passed count', () => {
    const checks: GitHubChecksSummary = { ...unknownChecks, state: 'success', total: 3, success: 3 };
    const presentation = getWorkStatusChecksPresentation(checks);
    expect(presentation).not.toBeNull();
    expect(presentation?.passed).toBe(3);
    expect(getPullRequestChecksText(checks, 'checks')).toBe('3/3 checks');
  });
});
