import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalSessionStatusRuntime } from './status-runtime.js';

// The payloads are the same OpenCode events the Linear runtime's fixtures use
// (`../linear/status-runtime.test.js`): both trackers' runtimes sit behind the
// same event hub and must read them identically.

afterEach(() => {
  vi.restoreAllMocks();
});

const recordingPost = () => vi.fn(async () => ({ connected: true, posted: true }));

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('local session status runtime', () => {
  it('posts failure on session.error and skips a user abort', async () => {
    const post = recordingPost();
    const runtime = createLocalSessionStatusRuntime({ post });

    runtime.processPayload({
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { name: 'MessageAbortedError', message: 'stopped' } },
    });
    await settle();
    expect(post).not.toHaveBeenCalled();

    runtime.processPayload({
      type: 'session.error',
      properties: { sessionID: 'ses_1', error: { name: 'ProviderError', message: 'boom' } },
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith({ kind: 'failure', sessionId: 'ses_1' });
    runtime.stop();
  });

  it('posts completed on idle and nothing on other status types', async () => {
    const post = recordingPost();
    const runtime = createLocalSessionStatusRuntime({ post });

    runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } });
    await settle();
    expect(post).not.toHaveBeenCalled();

    // The session id can also sit in `info`, as OpenCode sometimes sends it.
    runtime.processPayload({ type: 'session.status', properties: { info: { sessionID: 'ses_1' }, status: { type: 'idle' } } });
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith({ kind: 'completed', sessionId: 'ses_1' });
    runtime.stop();
  });

  it('ignores unrelated events and payloads without a usable session id', async () => {
    const post = recordingPost();
    const runtime = createLocalSessionStatusRuntime({ post });

    runtime.processPayload({ type: 'message.updated', properties: { sessionID: 'ses_1' } });
    runtime.processPayload({ type: 'session.status', properties: { status: { type: 'idle' } } });
    runtime.processPayload({ type: 'session.status', properties: { info: { sessionID: '   ' }, status: { type: 'idle' } } });
    await settle();
    expect(post).not.toHaveBeenCalled();
    runtime.stop();
  });

  it('stops processing and tolerates stop being called twice', async () => {
    const post = recordingPost();
    const runtime = createLocalSessionStatusRuntime({ post });

    runtime.stop();
    runtime.stop();
    runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
    await settle();
    expect(post).not.toHaveBeenCalled();
  });

  it('warns instead of throwing when the post fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const post = vi.fn(async () => {
      throw new Error('disk full');
    });
    const runtime = createLocalSessionStatusRuntime({ post });

    runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    runtime.stop();
  });
});
