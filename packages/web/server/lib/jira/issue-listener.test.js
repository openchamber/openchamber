import { describe, it, expect, vi } from 'vitest';
import { createJiraIssueListener } from './issue-listener.js';

const connection = {
  deployment: 'cloud',
  baseUrl: 'https://acme.atlassian.net',
  email: 'dev@acme.example',
  apiToken: 'token',
};

const baseConfig = {
  updates: { started: true, completed: true, failed: true, attention: true },
  issueListener: { enabled: true, triggerLabel: 'openchamber', removeTriggerLabel: true, intervalMs: 60_000 },
};

function setup({
  issues = [],
  config = baseConfig,
  getConnection = () => connection,
  startImpl,
  attempts = {},
} = {}) {
  const client = {
    searchIssues: vi.fn(async () => issues),
    removeLabel: vi.fn(async () => null),
    addComment: vi.fn(async () => ({})),
  };
  const sessionStarter = {
    startSessionFromIssue: startImpl || vi.fn(async () => ({ sessionId: 'ses_1' })),
  };
  const recordAttempt = vi.fn();
  const listener = createJiraIssueListener({
    sessionStarter,
    getConnection,
    getConfig: () => config,
    createClient: () => client,
    getAttempt: (key) => attempts[key] || null,
    recordAttempt,
  });
  return { listener, client, sessionStarter, recordAttempt };
}

const labeledIssue = (key, updated = new Date().toISOString()) => ({
  key,
  fields: { summary: 'S', project: { key: 'ABC' }, labels: ['openchamber'], updated },
});

describe('createJiraIssueListener', () => {
  it('does nothing when disabled or disconnected', async () => {
    const disabled = setup({ config: { ...baseConfig, issueListener: { ...baseConfig.issueListener, enabled: false } } });
    await disabled.listener.tick();
    expect(disabled.client.searchIssues).not.toHaveBeenCalled();

    const disconnected = setup({ getConnection: () => null });
    await disconnected.listener.tick();
    expect(disconnected.client.searchIssues).not.toHaveBeenCalled();
  });

  it('starts a session for a labeled issue, records the attempt, and removes the label', async () => {
    const { listener, client, sessionStarter, recordAttempt } = setup({ issues: [labeledIssue('ABC-1')] });
    await listener.tick();

    expect(client.searchIssues.mock.calls[0][0]).toContain('labels = "openchamber"');
    expect(sessionStarter.startSessionFromIssue).toHaveBeenCalledWith({ issueKey: 'ABC-1', source: 'listener' });
    expect(recordAttempt).toHaveBeenCalledWith('ABC-1', { outcome: 'started', sessionId: 'ses_1' });
    expect(client.removeLabel).toHaveBeenCalledWith('ABC-1', 'openchamber');
  });

  it('keeps the label when removal is disabled', async () => {
    const { listener, client } = setup({
      issues: [labeledIssue('ABC-1')],
      config: { ...baseConfig, issueListener: { ...baseConfig.issueListener, removeTriggerLabel: false } },
    });
    await listener.tick();
    expect(client.removeLabel).not.toHaveBeenCalled();
  });

  it('records failures before commenting so retries cannot loop', async () => {
    const calls = [];
    const startImpl = vi.fn(async () => {
      throw new Error('No OpenChamber project is mapped for Jira project ABC.');
    });
    const { listener, client, recordAttempt } = setup({ issues: [labeledIssue('ABC-2')], startImpl });
    recordAttempt.mockImplementation((key, attempt) => calls.push(['record', key, attempt.outcome]));
    client.addComment.mockImplementation(async (key) => calls.push(['comment', key]));

    await listener.tick();

    expect(calls[0]).toEqual(['record', 'ABC-2', 'failed']);
    expect(calls[1]).toEqual(['comment', 'ABC-2']);
    expect(client.addComment.mock.calls[0][1]).toContain('could not start a session');
    expect(client.removeLabel).not.toHaveBeenCalled();
  });

  it('skips failure comments when updates.failed is disabled', async () => {
    const startImpl = vi.fn(async () => {
      throw new Error('nope');
    });
    const { listener, client } = setup({
      issues: [labeledIssue('ABC-2')],
      startImpl,
      config: { ...baseConfig, updates: { ...baseConfig.updates, failed: false } },
    });
    await listener.tick();
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it('skips issues already handled and stale failures inside the grace window', async () => {
    const now = Date.now();
    const { listener, sessionStarter } = setup({
      issues: [
        labeledIssue('ABC-1', new Date(now).toISOString()),
        labeledIssue('ABC-2', new Date(now).toISOString()),
      ],
      attempts: {
        'ABC-1': { outcome: 'started', lastAttemptAt: now - 1_000, sessionId: 'ses_x', error: null },
        'ABC-2': { outcome: 'failed', lastAttemptAt: now - 1_000, sessionId: null, error: 'x' },
      },
    });
    await listener.tick();
    expect(sessionStarter.startSessionFromIssue).not.toHaveBeenCalled();
  });

  it('retries a failed issue once it changed after the grace window', async () => {
    const now = Date.now();
    const { listener, sessionStarter } = setup({
      issues: [labeledIssue('ABC-2', new Date(now).toISOString())],
      attempts: {
        'ABC-2': { outcome: 'failed', lastAttemptAt: now - 300_000, sessionId: null, error: 'x' },
      },
    });
    await listener.tick();
    expect(sessionStarter.startSessionFromIssue).toHaveBeenCalledTimes(1);
  });

  it('survives search failures and keeps polling', async () => {
    const { listener, client } = setup();
    client.searchIssues.mockRejectedValueOnce(new Error('rate limited'));
    await expect(listener.tick()).resolves.toBeUndefined();
  });

  it('start/stop control the schedule without leaking timers', () => {
    const timers = [];
    const { listener } = (() => {
      const client = { searchIssues: vi.fn(async () => []) };
      const listener = createJiraIssueListener({
        sessionStarter: { startSessionFromIssue: vi.fn() },
        getConnection: () => connection,
        getConfig: () => baseConfig,
        createClient: () => client,
        getAttempt: () => null,
        recordAttempt: vi.fn(),
        setTimeoutImpl: (fn, ms) => {
          const handle = { fn, ms, cleared: false, unref: () => {} };
          timers.push(handle);
          return handle;
        },
        clearTimeoutImpl: (handle) => {
          handle.cleared = true;
        },
      });
      return { listener };
    })();

    listener.start();
    expect(listener.isRunning()).toBe(true);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(60_000);

    listener.stop();
    expect(listener.isRunning()).toBe(false);
    expect(timers[0].cleared).toBe(true);
  });
});
