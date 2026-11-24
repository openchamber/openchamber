import { describe, expect, test } from 'bun:test';

import type { RepositoryIssueReference, RepositoryReferenceDetail } from '@/lib/api/types';

import { conversationActions } from './conversationActions';
import type { CachedValue } from './referenceCache';

const context = {
  provider: 'gitea', instance: 'https://gitea.example.com', directory: '/work/app', repositoryId: 'repo_one',
  accountId: 'gitea.example.com#7', bindingRevision: 1, primaryRemote: 'origin',
} as const;

const issue: RepositoryIssueReference = {
  kind: 'issue', provider: 'gitea', number: 1, title: 'Tidy the header', url: 'https://gitea.example.com/acme/app/issues/1',
  body: '', bodyTruncated: false, createdAt: null, updatedAt: null, author: { login: 'alice' },
  labels: [], commentCount: 0, sourceRepo: { owner: 'acme', repo: 'app', source: 'origin' }, state: 'open',
};

const detail = (value: Partial<RepositoryReferenceDetail> = {}): CachedValue<RepositoryReferenceDetail> => ({
  status: 'ready',
  value: { number: 1, comments: [], commentTotal: 0, pull: null, locked: true, viewerSubscribed: false, writeAccess: true, ...value },
});

// The Gitea family publishes `lock: false`: the per-instance capability alone
// decides, so only a positive answer draws the control.
const instanceLockFeatures = { lock: false, subscription: true };
// GitHub and GitLab publish a static `lock: true`; a 501 capability read is
// unknown and leaves the descriptor's answer standing.
const staticLockFeatures = { lock: true, subscription: true };

describe('conversation actions', () => {
  test('a pending, failed or unknown instance capability leaves the Gitea lock hidden', () => {
    expect(conversationActions(issue, detail(), context, null, instanceLockFeatures, null).showLock).toBe(false);
    expect(conversationActions(issue, detail(), context, null, instanceLockFeatures, undefined).showLock).toBe(false);
    expect(conversationActions(issue, detail(), context, null, instanceLockFeatures, false).showLock).toBe(false);
  });

  test('a positive instance capability draws the Gitea lock', () => {
    expect(conversationActions(issue, detail(), context, null, instanceLockFeatures, true))
      .toMatchObject({ showLock: true, locked: true });
  });

  test('a static lock capability stands without an instance answer, and is still hidden where the instance says no', () => {
    expect(conversationActions(issue, detail(), context, null, staticLockFeatures, undefined).showLock).toBe(true);
    expect(conversationActions(issue, detail(), context, null, staticLockFeatures, null).showLock).toBe(true);
    expect(conversationActions(issue, detail(), context, null, staticLockFeatures, false).showLock).toBe(false);
  });

  test('the lock needs a known state and an account that may write', () => {
    expect(conversationActions(issue, detail({ locked: undefined }), context, null, instanceLockFeatures, true).showLock).toBe(false);
    expect(conversationActions(issue, detail({ writeAccess: false }), context, null, instanceLockFeatures, true).showLock).toBe(false);
    expect(conversationActions({ ...issue, linked: true }, detail(), context, null, instanceLockFeatures, true).showLock).toBe(false);
  });

  test('follow ignores write access and is withheld only when the scopes are known to lack notifications', () => {
    expect(conversationActions(issue, detail({ writeAccess: false }), context, null, instanceLockFeatures).showSubscription).toBe(true);
    expect(conversationActions(issue, detail(), context, ['repo', 'notifications'], instanceLockFeatures).showSubscription).toBe(true);
    expect(conversationActions(issue, detail(), context, ['repo'], instanceLockFeatures).showSubscription).toBe(false);
    expect(conversationActions(issue, detail({ viewerSubscribed: undefined }), context, null, instanceLockFeatures).showSubscription).toBe(false);
  });
});
