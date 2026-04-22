import { describe, it, expect } from 'vitest';
import { computeIsStale, formatInboxItemFromNotification, formatInboxItemFromPR } from '../inbox.js';

describe('computeIsStale', () => {
  it('returns true if updated > 7 days ago', () => {
    const pr = { updated_at: '2023-01-01T00:00:00Z' };
    const now = new Date('2023-01-09T00:00:00Z').getTime();
    expect(computeIsStale(pr, now)).toBe(true);
  });

  it('returns false if updated < 7 days ago', () => {
    const pr = { updated_at: '2023-01-01T00:00:00Z' };
    const now = new Date('2023-01-05T00:00:00Z').getTime();
    expect(computeIsStale(pr, now)).toBe(false);
  });
});

describe('formatInboxItemFromNotification', () => {
  it('formats correctly', () => {
    const notif = {
      id: '123',
      subject: { type: 'PullRequest', title: 'Fix bug', url: 'https://api.github.com/repos/foo/bar/pulls/1' },
      repository: { full_name: 'foo/bar' },
      updated_at: '2023-01-01T00:00:00Z',
      reason: 'mention',
    };
    const result = formatInboxItemFromNotification(notif);
    expect(result.id).toBe('notif-123');
    expect(result.type).toBe('PullRequest');
    expect(result.title).toBe('Fix bug');
    expect(result.repoFullName).toBe('foo/bar');
  });
});

describe('formatInboxItemFromPR', () => {
  it('formats correctly', () => {
    const pr = {
      id: 456,
      title: 'Update docs',
      repository_url: 'https://api.github.com/repos/foo/bar',
      html_url: 'https://github.com/foo/bar/pull/2',
      updated_at: '2023-01-01T00:00:00Z',
      number: 2,
    };
    const result = formatInboxItemFromPR(pr, 'stale');
    expect(result.id).toBe('pr-456-stale');
    expect(result.reason).toBe('stale');
    expect(result.repoFullName).toBe('foo/bar');
  });
});
