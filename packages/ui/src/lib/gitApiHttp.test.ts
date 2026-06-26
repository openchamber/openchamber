import { describe, expect, test } from 'bun:test';
import { getGitStatus, gitFetch, stageGitFile, stageGitFiles, unstageGitFile, unstageGitFiles } from './gitApiHttp';

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

const previousFetch = globalThis.fetch;
const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

const installFetchMock = () => {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input, init) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
};

const installWindowMock = () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: { origin: 'http://localhost:3000' },
    },
  });
};

const restoreMocks = () => {
  globalThis.fetch = previousFetch;
  if (previousWindowDescriptor) {
    Object.defineProperty(globalThis, 'window', previousWindowDescriptor);
  } else {
    delete (globalThis as { window?: Window }).window;
  }
};

const captureError = async (callback: () => Promise<void>): Promise<unknown> => {
  try {
    await callback();
    return null;
  } catch (error) {
    return error;
  }
};

describe('gitApiHttp index mutations', () => {
  test('sends bulk stage payloads as paths', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await stageGitFiles('/repo', ['a.ts', 'b.ts']);

      expect(calls).toHaveLength(1);
      expect(String(calls[0].input)).toBe('/api/git/stage?directory=%2Frepo');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts', 'b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('sends bulk unstage payloads as paths', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await unstageGitFiles('/repo', ['a.ts', 'b.ts']);

      expect(calls).toHaveLength(1);
      expect(String(calls[0].input)).toBe('/api/git/unstage?directory=%2Frepo');
      expect(calls[0].init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts', 'b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('single-file helpers use the bulk paths payload shape', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      await stageGitFile('/repo', 'a.ts');
      await unstageGitFile('/repo', 'b.ts');

      expect(JSON.parse(String(calls[0].init?.body))).toEqual({ paths: ['a.ts'] });
      expect(JSON.parse(String(calls[1].init?.body))).toEqual({ paths: ['b.ts'] });
    } finally {
      restoreMocks();
    }
  });

  test('rejects empty bulk path lists before fetching', async () => {
    installWindowMock();
    const calls = installFetchMock();
    try {
      const stageError = await captureError(() => stageGitFiles('/repo', [' ', '']));
      const unstageError = await captureError(() => unstageGitFiles('/repo', []));

      expect(stageError).toBeInstanceOf(Error);
      expect((stageError as Error).message).toBe('path is required to stage git changes');
      expect(unstageError).toBeInstanceOf(Error);
      expect((unstageError as Error).message).toBe('path is required to unstage git changes');
      expect(calls).toHaveLength(0);
    } finally {
      restoreMocks();
    }
  });
});

describe('gitApiHttp status cache', () => {
  test('invalidates cached status after fetch', async () => {
    installWindowMock();
    const calls: FetchCall[] = [];
    let statusRequestCount = 0;
    globalThis.fetch = (async (input, init) => {
      calls.push({ input, init });
      const url = String(input);
      if (url.startsWith('/api/git/status')) {
        statusRequestCount += 1;
        return new Response(JSON.stringify({
          current: 'main',
          tracking: 'origin/main',
          ahead: 0,
          behind: statusRequestCount === 1 ? 0 : 2,
          files: [],
          isClean: true,
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const directory = '/repo-cache-fetch';
      const first = await getGitStatus(directory);
      const cached = await getGitStatus(directory);
      await gitFetch(directory, { remote: 'origin' });
      const afterFetch = await getGitStatus(directory);

      expect(first.behind).toBe(0);
      expect(cached.behind).toBe(0);
      expect(afterFetch.behind).toBe(2);
      expect(statusRequestCount).toBe(2);
      expect(calls.map((call) => String(call.input))).toEqual([
        '/api/git/status?directory=%2Frepo-cache-fetch',
        '/api/git/fetch?directory=%2Frepo-cache-fetch',
        '/api/git/status?directory=%2Frepo-cache-fetch',
      ]);
    } finally {
      restoreMocks();
    }
  });
});
