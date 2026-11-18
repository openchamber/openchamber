import { describe, expect, expectTypeOf, it } from 'vitest';
import { summarizeCheckRuns } from './checks-summary.js';
import type { readPendingReview } from './review-draft.js';
import type { readGhCliLogins } from './gh-cli-logins.js';

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
});
