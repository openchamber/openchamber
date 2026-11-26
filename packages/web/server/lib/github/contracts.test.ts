import { describe, expect, expectTypeOf, it } from 'vitest';
import { summarizeChecks } from './checks-summary.js';
import type { readPendingReview } from './review-draft.js';
import type { readGhCliLogins } from './gh-cli-logins.js';
import { requireGitHubCheckRuns, requireGitHubPullRequest } from './mappers.js';
import type { readGitHubChangeRequestPatch, readGitHubChangeRequestFile } from './change-request-patch.js';
import type { createMergeFollowRuntime, mergeFollowEvents } from './merge-follow.js';
import type { MutationRecord } from '../source-control/mutation-storage.js';

describe('GitHub boundary contracts', () => {
  it('keeps merge snapshot fields optional and replay records general', () => {
    type Snapshot = Parameters<typeof mergeFollowEvents>[0];
    type Follow = ReturnType<typeof createMergeFollowRuntime>;
    type Success = Parameters<Follow['onMutationSucceeded']>[0];
    type Replay = Extract<Success, { replayed: true }>;
    expectTypeOf<Snapshot['headSha']>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Snapshot['checks']>().toEqualTypeOf<{ state: string } | null | undefined>();
    expectTypeOf<Replay['record']>().toEqualTypeOf<MutationRecord>();
  });

  it('exposes only asserted patch and file text', () => {
    type Patch = Awaited<ReturnType<typeof readGitHubChangeRequestPatch>>;
    type File = Awaited<ReturnType<typeof readGitHubChangeRequestFile>>;
    expectTypeOf<Patch['patch']>().toEqualTypeOf<string>();
    expectTypeOf<File>().toEqualTypeOf<{ original: string; modified: string }>();
  });

  it('keeps unchecked provider fields unknown', () => {
    type PendingReview = NonNullable<Awaited<ReturnType<typeof readPendingReview>>>;
    type Login = Awaited<ReturnType<typeof readGhCliLogins>>[number];
    expectTypeOf<PendingReview['id']>().toEqualTypeOf<unknown>();
    expectTypeOf<PendingReview['commit']>().toEqualTypeOf<unknown>();
    expectTypeOf<Login['profile']>().toEqualTypeOf<unknown>();
  });

  it('does not treat an unchecked start time as a string', () => {
    const summary = summarizeChecks([{ status: 'in_progress', started_at: 42 }], []);
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
