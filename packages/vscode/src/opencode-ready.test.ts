import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConnectionStatus, OpenCodeManager } from './opencode';
import { waitForApiUrl } from './opencode-ready';

type Listener = (status: ConnectionStatus, error?: string) => void;

const createManager = (initial: { status: ConnectionStatus; url: string | null }) => {
  let status = initial.status;
  let url = initial.url;
  const listeners = new Set<Listener>();

  const manager = {
    getStatus: () => status,
    getApiUrl: () => url,
    onStatusChange: (cb: Listener) => {
      listeners.add(cb);
      cb(status);
      return { dispose: () => listeners.delete(cb) };
    },
  } as unknown as OpenCodeManager;

  const transition = (next: ConnectionStatus, nextUrl: string | null) => {
    status = next;
    url = nextUrl;
    listeners.forEach((cb) => cb(status));
  };

  return { manager, transition };
};

describe('waitForApiUrl readiness gating', () => {
  test('returns immediately when already connected with a URL', async () => {
    const { manager } = createManager({ status: 'connected', url: 'http://127.0.0.1:3902' });
    assert.equal(await waitForApiUrl(manager, 1000), 'http://127.0.0.1:3902');
  });

  test('does not hand out the URL until status is connected (pre-ready spawn window)', async () => {
    // server.url is exposed while still connecting — must NOT be forwarded to.
    const { manager, transition } = createManager({ status: 'connecting', url: 'http://127.0.0.1:3902' });
    const pending = waitForApiUrl(manager, 1000);

    let resolved = false;
    void pending.then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(resolved, false);

    transition('connected', 'http://127.0.0.1:3902');
    assert.equal(await pending, 'http://127.0.0.1:3902');
  });

  test('holds during a restart and resolves once reconnected', async () => {
    const { manager, transition } = createManager({ status: 'disconnected', url: null });
    const pending = waitForApiUrl(manager, 1000);

    transition('connecting', null);
    await new Promise((r) => setTimeout(r, 5));
    transition('connected', 'http://127.0.0.1:4096');
    assert.equal(await pending, 'http://127.0.0.1:4096');
  });

  test('fails fast on error status instead of burning the timeout', async () => {
    const { manager, transition } = createManager({ status: 'connecting', url: null });
    const pending = waitForApiUrl(manager, 5000);
    transition('error', null);
    // Resolves well before the 5s timeout.
    assert.equal(await pending, null);
  });

  test('falls back to whatever URL exists after the timeout', async () => {
    const { manager } = createManager({ status: 'connecting', url: null });
    assert.equal(await waitForApiUrl(manager, 20), null);
  });
});
