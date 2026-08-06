import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.OPENCHAMBER_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), `openchamber-jira-links-${crypto.randomBytes(4).toString('hex')}-`),
);

const {
  recordJiraSessionLink,
  listJiraSessionLinks,
  findJiraLinksByIssueKey,
  findJiraLinkBySessionId,
  recordJiraListenerAttempt,
  getJiraListenerAttempt,
  shouldRetryJiraIssue,
  JIRA_LINKS_FILE,
} = await import('./links.js');

const reset = () => {
  if (fs.existsSync(JIRA_LINKS_FILE)) fs.unlinkSync(JIRA_LINKS_FILE);
};

describe('Jira session links', () => {
  beforeEach(reset);

  it('records and finds links by issue and session', () => {
    recordJiraSessionLink({
      issueKey: 'ABC-1',
      issueUrl: 'https://acme.atlassian.net/browse/ABC-1',
      issueSummary: 'First',
      sessionId: 'ses_1',
      directory: '/repo',
      source: 'api',
    });
    recordJiraSessionLink({ issueKey: 'ABC-1', sessionId: 'ses_2', source: 'listener' });

    expect(listJiraSessionLinks()).toHaveLength(2);
    expect(findJiraLinksByIssueKey('ABC-1')).toHaveLength(2);
    expect(findJiraLinkBySessionId('ses_1')).toMatchObject({ issueKey: 'ABC-1', directory: '/repo' });
    expect(findJiraLinkBySessionId('missing')).toBeNull();
  });

  it('rejects links without an issue key or session id', () => {
    expect(() => recordJiraSessionLink({ issueKey: 'ABC-1' })).toThrow(/Invalid Jira session link/);
    expect(() => recordJiraSessionLink({ sessionId: 'ses_1' })).toThrow(/Invalid Jira session link/);
  });

  it('treats malformed stored data as empty instead of failing', () => {
    fs.writeFileSync(JIRA_LINKS_FILE, 'nope{', 'utf8');
    expect(listJiraSessionLinks()).toEqual([]);
  });
});

describe('Jira listener attempts', () => {
  beforeEach(reset);

  it('records and reads attempts', () => {
    recordJiraListenerAttempt('ABC-1', { outcome: 'started', sessionId: 'ses_1' });
    expect(getJiraListenerAttempt('ABC-1')).toMatchObject({ outcome: 'started', sessionId: 'ses_1' });
    expect(getJiraListenerAttempt('ABC-2')).toBeNull();
  });

  it('never retries started issues', () => {
    const attempt = recordJiraListenerAttempt('ABC-1', { outcome: 'started', sessionId: 'ses_1' });
    expect(shouldRetryJiraIssue(attempt, Date.now() + 10_000_000)).toBe(false);
  });

  it('retries failed issues only after the issue changes past the grace window', () => {
    const attempt = recordJiraListenerAttempt('ABC-1', { outcome: 'failed', error: 'no mapping' });
    expect(shouldRetryJiraIssue(attempt, attempt.lastAttemptAt + 1_000)).toBe(false);
    expect(shouldRetryJiraIssue(attempt, attempt.lastAttemptAt + 120_000)).toBe(true);
    expect(shouldRetryJiraIssue(attempt, null)).toBe(false);
  });

  it('always tries issues with no recorded attempt', () => {
    expect(shouldRetryJiraIssue(null, null)).toBe(true);
  });
});
