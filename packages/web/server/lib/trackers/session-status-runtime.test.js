import { describe, expect, it, vi } from 'vitest';
import { createSessionStatusRuntime } from './session-status-runtime.js';

describe('session status event decoding', () => {
  it('keeps session-id precedence and falls back past malformed or blank fields', () => {
    const post = vi.fn(async () => ({ connected: false }));
    const runtime = createSessionStatusRuntime({ label: 'test', post });
    runtime.processPayload({
      type: 'session.status',
      properties: { info: { sessionID: ' first ', sessionId: 'second' }, sessionID: 'third', status: { type: ' idle ' } },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { info: { sessionID: 42, sessionId: ' ' }, sessionID: [], sessionId: ' alias ', status: null, session: 'last' },
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { info: { sessionID: false, type: ' idle ' }, session: ' fallback ' },
    });
    expect(post.mock.calls.map(([input]) => input)).toEqual([
      { kind: 'completed', sessionId: 'first' },
      { kind: 'completed', sessionId: 'fallback' },
    ]);
  });

  it('ignores malformed objects, boxed strings, aborted turns and inexact event types', () => {
    const post = vi.fn(async () => ({ connected: false }));
    const runtime = createSessionStatusRuntime({ label: 'test', post });
    for (const payload of [null, [], 42, { type: 'session.status', properties: [] }]) runtime.processPayload(payload);
    runtime.processPayload({ type: ' session.status ', properties: { sessionID: 's', status: { type: 'idle' } } });
    runtime.processPayload({ type: 'session.status', properties: { sessionID: Object('s'), status: { type: 'idle' } } });
    runtime.processPayload({ type: 'session.error', properties: { sessionID: 's', error: { name: ' MessageAbortedError ' } } });
    expect(post).not.toHaveBeenCalled();
    runtime.processPayload({ type: 'session.error', properties: { sessionID: 's', error: null } });
    expect(post).toHaveBeenCalledWith({ kind: 'failure', sessionId: 's' });
    runtime.stop();
    runtime.processPayload({ type: 'session.error', properties: { sessionID: 'other' } });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('warns about a failed post without retrying', async () => {
    const post = vi.fn(() => Promise.reject({ message: 'unavailable' }));
    const warn = vi.fn();
    const runtime = createSessionStatusRuntime({ label: 'test', post, warn });
    runtime.processPayload({ type: 'session.error', properties: { sessionID: 's' } });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith('[trackers] test: failed to post the session failure comment:', 'unavailable');
    expect(post).toHaveBeenCalledTimes(1);
  });
});
