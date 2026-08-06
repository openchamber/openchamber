import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createJiraStatusUpdates, formatJiraSessionError } from './status-updates.js';

const connection = {
  deployment: 'cloud',
  baseUrl: 'https://acme.atlassian.net',
  email: 'dev@acme.example',
  apiToken: 'token',
};

const enabledConfig = {
  updates: { started: true, completed: true, failed: true, attention: true },
};

function createHub() {
  const subscribers = new Set();
  return {
    subscribeEvent: vi.fn((subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    }),
    emit: async (payload) => {
      for (const subscriber of Array.from(subscribers)) {
        await subscriber({ envelope: {}, payload });
      }
    },
    subscriberCount: () => subscribers.size,
  };
}

function setup({ config = enabledConfig, getConnection = () => connection } = {}) {
  const hub = createHub();
  const addComment = vi.fn(async () => ({}));
  const ensureEventStream = vi.fn();
  const updates = createJiraStatusUpdates({
    globalEventHub: hub,
    ensureEventStream,
    getConnection,
    getConfig: () => config,
    createClient: () => ({ addComment }),
  });
  return { hub, addComment, updates, ensureEventStream };
}

const watchArgs = {
  sessionId: 'ses_1',
  issueKey: 'ABC-1',
  sessionUrl: 'https://chamber.example/?session=ses_1',
  title: 'ABC-1: Fix it',
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createJiraStatusUpdates', () => {
  it('posts a completed comment on session.idle after the grace window and unwatches', async () => {
    const { hub, addComment, updates, ensureEventStream } = setup();
    expect(updates.watchSession(watchArgs)).toBe(true);
    expect(ensureEventStream).toHaveBeenCalled();

    // Idle inside the grace window is ignored (stray event before the run).
    await hub.emit({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(addComment).not.toHaveBeenCalled();
    expect(updates.watchedCount()).toBe(1);

    vi.advanceTimersByTime(6_000);
    await hub.emit({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(addComment).toHaveBeenCalledTimes(1);
    const [issueKey, text] = addComment.mock.calls[0];
    expect(issueKey).toBe('ABC-1');
    expect(text).toContain('completed');
    expect(text).toContain('https://chamber.example/?session=ses_1');
    expect(updates.watchedCount()).toBe(0);
    expect(hub.subscriberCount()).toBe(0);
  });

  it('posts a failure comment with the formatted error on session.error', async () => {
    const { hub, addComment, updates } = setup();
    updates.watchSession(watchArgs);
    await hub.emit({
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { data: { message: 'Provider exploded' } } },
    });
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment.mock.calls[0][1]).toContain('failed: Provider exploded');
    expect(updates.watchedCount()).toBe(0);
  });

  it('posts attention updates once per request id', async () => {
    const { hub, addComment, updates } = setup();
    updates.watchSession(watchArgs);
    await hub.emit({ type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'perm-1' } });
    await hub.emit({ type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'perm-1' } });
    await hub.emit({ type: 'question.asked', properties: { sessionID: 'ses_1', id: 'q-1' } });
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(addComment.mock.calls[0][1]).toContain('permission request');
    expect(addComment.mock.calls[1][1]).toContain('question');
    // Attention does not end the watch.
    expect(updates.watchedCount()).toBe(1);
  });

  it('ignores events for unwatched sessions', async () => {
    const { hub, addComment, updates } = setup();
    updates.watchSession(watchArgs);
    await hub.emit({ type: 'session.error', properties: { sessionID: 'ses_other', error: 'x' } });
    expect(addComment).not.toHaveBeenCalled();
    expect(updates.watchedCount()).toBe(1);
  });

  it('respects disabled update toggles', async () => {
    const { hub, addComment, updates } = setup({
      config: { updates: { started: true, completed: false, failed: false, attention: false } },
    });
    updates.watchSession(watchArgs);
    await hub.emit({ type: 'permission.asked', properties: { sessionID: 'ses_1', id: 'p1' } });
    vi.advanceTimersByTime(6_000);
    await hub.emit({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(addComment).not.toHaveBeenCalled();
    // Terminal events still end the watch even when posting is disabled.
    expect(updates.watchedCount()).toBe(0);
  });

  it('stops watching deleted sessions without posting', async () => {
    const { hub, addComment, updates } = setup();
    updates.watchSession(watchArgs);
    await hub.emit({ type: 'session.deleted', properties: { sessionID: 'ses_1' } });
    expect(addComment).not.toHaveBeenCalled();
    expect(updates.watchedCount()).toBe(0);
  });

  it('skips posting when Jira is no longer connected', async () => {
    const { hub, addComment, updates } = setup({ getConnection: () => null });
    updates.watchSession(watchArgs);
    vi.advanceTimersByTime(6_000);
    await hub.emit({ type: 'session.idle', properties: { sessionID: 'ses_1' } });
    expect(addComment).not.toHaveBeenCalled();
  });

  it('stop() clears all watchers and the subscription', () => {
    const { hub, updates } = setup();
    updates.watchSession(watchArgs);
    updates.stop();
    expect(updates.watchedCount()).toBe(0);
    expect(hub.subscriberCount()).toBe(0);
  });
});

describe('formatJiraSessionError', () => {
  it('extracts messages from common OpenCode error shapes', () => {
    expect(formatJiraSessionError('boom')).toBe('boom');
    expect(formatJiraSessionError({ message: 'direct' })).toBe('direct');
    expect(formatJiraSessionError({ data: { message: 'nested' } })).toBe('nested');
    expect(formatJiraSessionError(null)).toBe('OpenCode session error');
  });

  it('keeps only the first line and bounds the length', () => {
    expect(formatJiraSessionError({ message: 'line one\nstack trace' })).toBe('line one');
    expect(formatJiraSessionError({ message: 'z'.repeat(1_000) }).length).toBeLessThanOrEqual(401);
  });
});
