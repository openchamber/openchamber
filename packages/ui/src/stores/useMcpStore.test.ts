import { beforeEach, describe, expect, mock, test } from 'bun:test';

let statusImpl: (
  _params?: unknown,
  options?: { signal?: AbortSignal },
) => Promise<unknown> = async () => ({});

const fakeApi = {
  mcp: {
    status: (_params?: unknown, options?: { signal?: AbortSignal }) => statusImpl(_params, options),
  },
};

mock.module('@/lib/opencode/client', () => ({
  opencodeClient: {
    getApiClient: () => fakeApi,
    getScopedApiClient: () => fakeApi,
  },
}));

mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: {
    getState: () => ({ currentDirectory: '/test/dir' }),
  },
}));

const { useMcpStore } = await import('./useMcpStore');

describe('useMcpStore.refresh — timeout safety', () => {
  const KEY = '/test/dir';

  beforeEach(() => {
    useMcpStore.setState({
      byDirectory: {},
      diagnosticsByDirectory: {},
      loadingKeys: {},
      lastErrorKeys: {},
    });
    statusImpl = async () => ({});
  });

  test('when status() hangs and AbortSignal provided, refresh() settles within bounded time and sets error state', async () => {
    // Simulate a hung OpenCode server: a promise that only settles when the
    // AbortSignal fires. The fix passes this signal via the SDK options param.
    statusImpl = (_params, options) =>
      new Promise<never>((_resolve, reject) => {
        if (options?.signal) {
          const onAbort = () => {
            options.signal!.removeEventListener('abort', onAbort);
            reject(new DOMException('Aborted', 'AbortError'));
          };
          if (options.signal.aborted) {
            reject(new DOMException('Aborted', 'AbortError'));
          } else {
            options.signal.addEventListener('abort', onAbort);
          }
        }
        // No signal: never settle (unfixed code — test timeout fires).
      });

    const raceTimeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('refresh() did not settle — no timeout in implementation')),
        300,
      ),
    );

    // timeoutMs=100 makes the fix fire the AbortController at 100ms. The mock
    // rejects via the abort listener. Without the fix, raceTimeout wins.
    await Promise.race([
      useMcpStore.getState().refresh({ directory: KEY, silent: false, timeoutMs: 100 }),
      raceTimeout,
    ]);

    const state = useMcpStore.getState();
    expect(state.lastErrorKeys[KEY]).toBeTruthy();
    expect(state.loadingKeys[KEY]).toBe(false);
  });

  test('successful status() populates byDirectory and clears any prior error', async () => {
    statusImpl = async () => ({
      data: {
        'test-server': { status: 'connected' },
      },
    });

    await useMcpStore.getState().refresh({ directory: KEY, silent: false });

    const state = useMcpStore.getState();
    expect(state.byDirectory[KEY]).toEqual({
      'test-server': { status: 'connected' },
    });
    expect(state.lastErrorKeys[KEY]).toBeNull();
    expect(state.loadingKeys[KEY]).toBe(false);
  });

  test('immediate throw from status() sets lastErrorKeys and clears loadingKeys', async () => {
    statusImpl = async () => {
      throw new Error('connection refused');
    };

    await useMcpStore.getState().refresh({ directory: KEY, silent: false });

    const state = useMcpStore.getState();
    expect(state.lastErrorKeys[KEY]).toBe('connection refused');
    expect(state.loadingKeys[KEY]).toBe(false);
  });
});
