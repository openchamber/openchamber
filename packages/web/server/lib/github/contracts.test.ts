import { describe, expect, expectTypeOf, it } from 'vitest';
import { summarizeCheckRuns } from './checks-summary.js';
import type { readPendingReview } from './review-draft.js';
import type { readGhCliLogins } from './gh-cli-logins.js';
import { requireGitHubCheckRuns, requireGitHubPullRequest } from './mappers.js';

describe('GitHub boundary contracts', () => {
  it('keeps unchecked provider fields unknown', () => {
    type PendingReview = NonNullable<Awaited<ReturnType<typeof readPendingReview>>>;
    type Login = Awaited<ReturnType<typeof readGhCliLogins>>[number];
    expectTypeOf<PendingReview['id']>().toEqualTypeOf<unknown>();
    expectTypeOf<PendingReview['commit']>().toEqualTypeOf<unknown>();
    expectTypeOf<Login['profile']>().toEqualTypeOf<unknown>();
  });

  it('does not treat an unchecked start time as a string', () => {
    const summary = summarizeCheckRuns([{ status: 'in_progress', started_at: 42 }]);
    expect(summary.pending).toBe(1);
    expect(summary).not.toHaveProperty('startedAt');
  });

  it('preserves fields a collection validator does not check', () => {
    const runs = requireGitHubCheckRuns([{ id: 1, name: 'build', status: 'in_progress', started_at: 42 }]);
    expectTypeOf(runs).items.toHaveProperty('started_at').toEqualTypeOf<number>();
    const pull = requireGitHubPullRequest({
      number: 7, title: 'Change', html_url: 'https://github.com/acme/app/pull/7', state: 'open',
      base: { ref: 'main' }, head: { ref: 'topic' }, mergeable: 'unchecked',
    }, 'invalid pull');
    expectTypeOf(pull.mergeable).toEqualTypeOf<string>();
  });
});
